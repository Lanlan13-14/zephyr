// Package mcp implements an MCP (Model Context Protocol) client.
//
// Transports:
//   - stdio: subprocess, one JSON-RPC message per line
//   - http:  streamable HTTP (POST, optional SSE response)
//
// Tools are adapted into tool.Tool with names mcp__<server>__<tool>.
// Remote tools default to ReadOnly=false unless annotations.readOnlyHint.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

type TransportKind string

const (
	TransportStdio TransportKind = "stdio"
	TransportHTTP  TransportKind = "http"
)

// ServerConfig is durable MCP server configuration.
type ServerConfig struct {
	Name               string            `json:"name"`
	Type               TransportKind     `json:"type"` // stdio|http
	Command            string            `json:"command,omitempty"`
	Args               []string          `json:"args,omitempty"`
	Env                map[string]string `json:"env,omitempty"`
	URL                string            `json:"url,omitempty"`
	Headers            map[string]string `json:"headers,omitempty"`
	CallTimeoutSeconds int               `json:"callTimeoutSeconds,omitempty"`
	// TrustedReadOnlyTools: raw MCP tool names treated as read-only.
	TrustedReadOnlyTools []string `json:"trustedReadOnlyTools,omitempty"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Client is one connected MCP server.
type Client struct {
	cfg     ServerConfig
	kind    TransportKind
	timeout time.Duration

	mu      sync.Mutex
	idGen   atomic.Int64
	pending map[int64]chan rpcResponse

	// stdio
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner
	cancel context.CancelFunc

	// http
	httpClient *http.Client
	sessionID  string

	closed atomic.Bool
}

func Connect(ctx context.Context, cfg ServerConfig) (*Client, error) {
	if strings.TrimSpace(cfg.Name) == "" {
		return nil, fmt.Errorf("mcp: empty server name")
	}
	kind := cfg.Type
	if kind == "" {
		if cfg.URL != "" {
			kind = TransportHTTP
		} else {
			kind = TransportStdio
		}
	}
	to := time.Duration(cfg.CallTimeoutSeconds) * time.Second
	if to <= 0 {
		to = 300 * time.Second
	}
	c := &Client{
		cfg:     cfg,
		kind:    kind,
		timeout: to,
		pending: make(map[int64]chan rpcResponse),
	}
	switch kind {
	case TransportStdio:
		if err := c.startStdio(ctx); err != nil {
			return nil, err
		}
	case TransportHTTP:
		c.httpClient = &http.Client{Timeout: to}
	default:
		return nil, fmt.Errorf("mcp: unsupported transport %q", kind)
	}
	// initialize handshake
	initRes, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "zephyr-ai", "version": "1"},
	})
	if err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("mcp initialize: %w", err)
	}
	_ = initRes
	if err := c.notify(ctx, "notifications/initialized", map[string]any{}); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) startStdio(ctx context.Context) error {
	if c.cfg.Command == "" {
		return fmt.Errorf("mcp stdio: empty command")
	}
	ctx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	cmd := exec.CommandContext(ctx, c.cfg.Command, c.cfg.Args...)
	env := os.Environ()
	for k, v := range c.cfg.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		cancel()
		return err
	}
	c.cmd = cmd
	c.stdin = stdin
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	c.stdout = sc
	go c.readStdioLoop()
	return nil
}

func (c *Client) readStdioLoop() {
	for c.stdout.Scan() {
		line := c.stdout.Bytes()
		var resp rpcResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[resp.ID]
		if ok {
			delete(c.pending, resp.ID)
		}
		c.mu.Unlock()
		if ok {
			ch <- resp
		}
	}
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("mcp: closed")
	}
	id := c.idGen.Add(1)
	req := rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	switch c.kind {
	case TransportStdio:
		ch := make(chan rpcResponse, 1)
		c.mu.Lock()
		c.pending[id] = ch
		c.mu.Unlock()
		b, err := json.Marshal(req)
		if err != nil {
			return nil, err
		}
		b = append(b, '\n')
		c.mu.Lock()
		_, err = c.stdin.Write(b)
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		select {
		case <-ctx.Done():
			c.mu.Lock()
			delete(c.pending, id)
			c.mu.Unlock()
			return nil, ctx.Err()
		case resp := <-ch:
			if resp.Error != nil {
				return nil, fmt.Errorf("mcp %s: %s", method, resp.Error.Message)
			}
			return resp.Result, nil
		}
	case TransportHTTP:
		return c.callHTTP(ctx, req)
	default:
		return nil, fmt.Errorf("mcp: bad transport")
	}
}

func (c *Client) notify(ctx context.Context, method string, params any) error {
	req := rpcRequest{JSONRPC: "2.0", Method: method, Params: params}
	switch c.kind {
	case TransportStdio:
		b, err := json.Marshal(req)
		if err != nil {
			return err
		}
		b = append(b, '\n')
		c.mu.Lock()
		_, err = c.stdin.Write(b)
		c.mu.Unlock()
		return err
	case TransportHTTP:
		_, err := c.callHTTP(ctx, req)
		return err
	default:
		return fmt.Errorf("mcp: bad transport")
	}
}

func (c *Client) callHTTP(ctx context.Context, req rpcRequest) (json.RawMessage, error) {
	b, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.URL, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range c.cfg.Headers {
		httpReq.Header.Set(k, v)
	}
	if c.sessionID != "" {
		httpReq.Header.Set("Mcp-Session-Id", c.sessionID)
	}
	res, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if sid := res.Header.Get("Mcp-Session-Id"); sid != "" {
		c.sessionID = sid
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("mcp http %s: %s", res.Status, strings.TrimSpace(string(body)))
	}
	// SSE: take last data: JSON line with result
	ct := res.Header.Get("Content-Type")
	if strings.Contains(ct, "text/event-stream") {
		var last json.RawMessage
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			var resp rpcResponse
			if err := json.Unmarshal([]byte(payload), &resp); err == nil {
				if resp.Error != nil {
					return nil, fmt.Errorf("mcp: %s", resp.Error.Message)
				}
				if len(resp.Result) > 0 {
					last = resp.Result
				}
			}
		}
		if last == nil {
			return nil, fmt.Errorf("mcp http sse: empty result")
		}
		return last, nil
	}
	// notifications may have empty body
	if len(bytes.TrimSpace(body)) == 0 {
		return json.RawMessage(`{}`), nil
	}
	var resp rpcResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("mcp: %s", resp.Error.Message)
	}
	return resp.Result, nil
}

type toolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations struct {
		ReadOnlyHint bool `json:"readOnlyHint"`
	} `json:"annotations"`
}

// ListTools returns remote tools.
func (c *Client) ListTools(ctx context.Context) ([]toolInfo, error) {
	raw, err := c.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var res struct {
		Tools []toolInfo `json:"tools"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

// CallTool invokes tools/call.
func (c *Client) CallTool(ctx context.Context, name string, args json.RawMessage) (any, error) {
	var arguments any
	if len(args) > 0 {
		_ = json.Unmarshal(args, &arguments)
	} else {
		arguments = map[string]any{}
	}
	raw, err := c.call(ctx, "tools/call", map[string]any{
		"name":      name,
		"arguments": arguments,
	})
	if err != nil {
		return nil, err
	}
	var res any
	if err := json.Unmarshal(raw, &res); err != nil {
		return string(raw), nil
	}
	return res, nil
}

func (c *Client) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	if c.cancel != nil {
		c.cancel()
	}
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
		_, _ = c.cmd.Process.Wait()
	}
	return nil
}

// RegisterTools adapts remote tools into reg with mcp__ prefix.
func (c *Client) RegisterTools(ctx context.Context, reg *tool.Registry) error {
	tools, err := c.ListTools(ctx)
	if err != nil {
		return err
	}
	trusted := map[string]bool{}
	for _, n := range c.cfg.TrustedReadOnlyTools {
		trusted[n] = true
	}
	server := sanitizeName(c.cfg.Name)
	for _, t := range tools {
		t := t
		name := fmt.Sprintf("mcp__%s__%s", server, sanitizeName(t.Name))
		schema := t.InputSchema
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		readOnly := t.Annotations.ReadOnlyHint || trusted[t.Name]
		ft := &tool.FuncTool{
			ToolName:        name,
			ToolDescription: t.Description,
			ToolSchema:      schema,
			IsReadOnly:      readOnly,
			ToolRisk:        tool.RiskHigh,
			IsParallelSafe:  readOnly,
			Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
				return c.CallTool(ctx, t.Name, args)
			},
		}
		if readOnly {
			ft.ToolRisk = tool.RiskLow
		}
		if err := reg.Register(ft); err != nil {
			return err
		}
	}
	return nil
}

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, " ", "_")
	s = strings.ReplaceAll(s, "/", "_")
	return s
}

// Manager holds multiple MCP clients for a process.
type Manager struct {
	mu      sync.Mutex
	clients map[string]*Client
}

func NewManager() *Manager {
	return &Manager{clients: make(map[string]*Client)}
}

func (m *Manager) Connect(ctx context.Context, cfg ServerConfig) (*Client, error) {
	c, err := Connect(ctx, cfg)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if old, ok := m.clients[cfg.Name]; ok {
		_ = old.Close()
	}
	m.clients[cfg.Name] = c
	m.mu.Unlock()
	return c, nil
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.clients {
		_ = c.Close()
	}
	m.clients = map[string]*Client{}
}

func (m *Manager) RegisterAll(ctx context.Context, reg *tool.Registry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.clients {
		if err := c.RegisterTools(ctx, reg); err != nil {
			return err
		}
	}
	return nil
}
