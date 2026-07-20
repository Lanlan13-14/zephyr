// Package platform bridges Zephyr platform capabilities that must stay in Node
// (SSH exec via existing pools, SQLite notes ACL, browser CDP, UI actions).
//
// Protocol version is strict. Node implements POST /internal/ai-host/v1/call
// with admin token. Go never holds connection secrets; Node resolves ACL.
package platform

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

const ProtocolVersion = 1

// Host is the Node-side tool executor.
type Host struct {
	BaseURL    string
	AdminToken string
	HTTP       *http.Client
}

func NewHost(baseURL, adminToken string) *Host {
	h := &Host{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		AdminToken: adminToken,
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// Platform host is always Node on loopback inside the same trust boundary.
	// Allow self-signed HTTPS when URL is localhost/127.0.0.1.
	if strings.HasPrefix(h.BaseURL, "https://127.0.0.1") ||
		strings.HasPrefix(h.BaseURL, "https://localhost") ||
		strings.HasPrefix(h.BaseURL, "https://[::1]") {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // loopback only
	}
	h.HTTP = &http.Client{Timeout: 180 * time.Second, Transport: tr}
	return h
}

type CallRequest struct {
	V         int             `json:"v"`
	Tool      string          `json:"tool"`
	Args      json.RawMessage `json:"args"`
	UserID    string          `json:"userId"`
	SessionID string          `json:"sessionId,omitempty"`
	RunID     string          `json:"runId,omitempty"`
	Context   json.RawMessage `json:"context,omitempty"`
	Confirmed bool            `json:"confirmed,omitempty"`
}

type CallResponse struct {
	OK      bool            `json:"ok"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Code    string          `json:"code,omitempty"`
}

func (h *Host) Call(ctx context.Context, req CallRequest) (any, error) {
	if h == nil || h.BaseURL == "" {
		return nil, fmt.Errorf("platform host not configured")
	}
	req.V = ProtocolVersion
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/internal/ai-host/v1/call", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-ai-host-admin", h.AdminToken)
	res, err := h.HTTP.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode == 401 || res.StatusCode == 403 {
		return nil, fmt.Errorf("platform host unauthorized: %s", res.Status)
	}
	var cr CallResponse
	if err := json.Unmarshal(b, &cr); err != nil {
		return nil, fmt.Errorf("platform host bad json: %w (%s)", err, strings.TrimSpace(string(b)))
	}
	if res.StatusCode >= 300 || !cr.OK {
		msg := cr.Error
		if msg == "" {
			msg = strings.TrimSpace(string(b))
		}
		return nil, fmt.Errorf("%s", msg)
	}
	if len(cr.Result) == 0 {
		return map[string]any{"ok": true}, nil
	}
	var out any
	if err := json.Unmarshal(cr.Result, &out); err != nil {
		return string(cr.Result), nil
	}
	return out, nil
}

// ToolDef describes a platform tool the host advertises.
type ToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	ReadOnly    bool            `json:"readOnly"`
	Risk        string          `json:"risk"`
	ParallelSafe bool           `json:"parallelSafe"`
}

// ListTools fetches tool catalog from Node (optional; can use static catalog).
func (h *Host) ListTools(ctx context.Context) ([]ToolDef, error) {
	if h == nil || h.BaseURL == "" {
		return nil, fmt.Errorf("platform host not configured")
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/internal/ai-host/v1/tools", nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("x-ai-host-admin", h.AdminToken)
	res, err := h.HTTP.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("list tools: %s %s", res.Status, strings.TrimSpace(string(b)))
	}
	var out struct {
		Tools []ToolDef `json:"tools"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out.Tools, nil
}

// RegisterFromHost pulls catalog and registers proxy tools.
func RegisterFromHost(ctx context.Context, reg *tool.Registry, h *Host, userID, sessionID, runID string, contextJSON json.RawMessage) error {
	defs, err := h.ListTools(ctx)
	if err != nil {
		return err
	}
	for _, d := range defs {
		d := d
		risk := tool.RiskHigh
		switch d.Risk {
		case "low":
			risk = tool.RiskLow
		case "destructive":
			risk = tool.RiskDestructive
		}
		schema := d.Parameters
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		ft := &tool.FuncTool{
			ToolName:        d.Name,
			ToolDescription: d.Description,
			ToolSchema:      schema,
			IsReadOnly:      d.ReadOnly,
			ToolRisk:        risk,
			IsParallelSafe:  d.ParallelSafe && d.ReadOnly,
			Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
				return h.Call(ctx, CallRequest{
					Tool:      d.Name,
					Args:      args,
					UserID:    userID,
					SessionID: sessionID,
					RunID:     runID,
					Context:   contextJSON,
				})
			},
		}
		if err := reg.Register(ft); err != nil {
			// allow overwrite? no — catalog must be unique
			return err
		}
	}
	return nil
}
