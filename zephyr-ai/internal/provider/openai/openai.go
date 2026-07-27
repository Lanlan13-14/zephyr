// Package openai implements OpenAI chat/completions and responses APIs,
// and is also used for openai-compatible and ollama endpoints.
package openai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func init() {
	f := func(cfg provider.Config) (provider.Provider, error) {
		return New(cfg), nil
	}
	provider.Register(provider.KindOpenAI, f)
	provider.Register(provider.KindOpenAIComp, f)
	provider.Register(provider.KindOllama, f)
}

type Client struct {
	cfg    provider.Config
	client *http.Client
}

func New(cfg provider.Config) *Client {
	timeout := time.Duration(cfg.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	return &Client{
		cfg: cfg,
		client: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *Client) Name() string        { return c.cfg.Name }
func (c *Client) Kind() provider.Kind { return provider.NormalizeKind(c.cfg.Kind) }

func (c *Client) apiMode() string {
	m := strings.ToLower(strings.TrimSpace(c.cfg.APIMode))
	if m == "chat" || m == "responses" {
		return m
	}
	return "chat"
}

func joinURL(base, suffix string) string {
	b := strings.TrimRight(base, "/")
	if b == "" {
		b = "https://api.openai.com/v1"
	}
	if strings.HasSuffix(b, suffix) {
		return b
	}
	// If base already ends with /v1, just append path
	s := suffix
	if !strings.HasPrefix(s, "/") {
		s = "/" + s
	}
	return b + s
}

func (c *Client) headers() http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		h.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	if c.cfg.Organization != "" {
		h.Set("OpenAI-Organization", c.cfg.Organization)
	}
	for k, v := range c.cfg.ExtraHeaders {
		if k != "" && v != "" {
			h.Set(k, v)
		}
	}
	return h
}

type chatMessage struct {
	Role       string         `json:"role"`
	Content    any            `json:"content,omitempty"`
	ToolCalls  []chatToolCall `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	Name       string         `json:"name,omitempty"`
}

type chatToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

func toChatMessages(msgs []provider.Message) []chatMessage {
	out := make([]chatMessage, 0, len(msgs))
	for _, m := range msgs {
		cm := chatMessage{Role: string(m.Role), Name: m.Name, ToolCallID: m.ToolCallID}
		if len(m.Parts) > 0 {
			parts := make([]map[string]any, 0, len(m.Parts))
			for _, p := range m.Parts {
				if p.Type == "image_url" && p.ImageURL != "" {
					parts = append(parts, map[string]any{
						"type":      "image_url",
						"image_url": map[string]any{"url": p.ImageURL},
					})
					continue
				}
				parts = append(parts, map[string]any{"type": "text", "text": p.Text})
			}
			cm.Content = parts
		} else {
			cm.Content = m.Content
		}
		if len(m.ToolCalls) > 0 {
			cm.ToolCalls = make([]chatToolCall, 0, len(m.ToolCalls))
			for _, tc := range m.ToolCalls {
				item := chatToolCall{ID: tc.ID, Type: "function"}
				item.Function.Name = tc.Name
				item.Function.Arguments = string(tc.Arguments)
				if item.Function.Arguments == "" {
					item.Function.Arguments = "{}"
				}
				cm.ToolCalls = append(cm.ToolCalls, item)
			}
		}
		out = append(out, cm)
	}
	return out
}

func toChatTools(tools []provider.ToolSchema) []chatTool {
	out := make([]chatTool, 0, len(tools))
	for _, t := range tools {
		item := chatTool{Type: "function"}
		item.Function.Name = t.Name
		item.Function.Description = t.Description
		params := t.Parameters
		if len(params) == 0 {
			params = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		item.Function.Parameters = params
		out = append(out, item)
	}
	return out
}

func applyOptions(payload map[string]any, opts map[string]any) {
	if opts == nil {
		return
	}
	// Pass through known sampling keys; ignore unknowns silently for compat.
	for _, k := range []string{
		"temperature", "top_p", "max_tokens", "max_completion_tokens",
		"presence_penalty", "frequency_penalty", "reasoning_effort",
		"response_format", "seed", "stop", "n",
	} {
		if v, ok := opts[k]; ok && v != nil {
			payload[k] = v
		}
	}
	// max_output_tokens → max_tokens alias
	if _, ok := payload["max_tokens"]; !ok {
		if v, ok := opts["max_output_tokens"]; ok {
			payload["max_tokens"] = v
		}
	}
}

func (c *Client) Complete(ctx context.Context, req provider.Request) (provider.Message, provider.Usage, error) {
	req.Stream = false
	ch, err := c.Stream(ctx, req)
	if err != nil {
		return provider.Message{}, provider.Usage{}, err
	}
	var (
		text      strings.Builder
		toolCalls []provider.ToolCall
		usage     provider.Usage
		respID    string
	)
	for chunk := range ch {
		if chunk.Err != nil {
			return provider.Message{}, usage, chunk.Err
		}
		if chunk.ErrorMsg != "" {
			return provider.Message{}, usage, fmt.Errorf("%s", chunk.ErrorMsg)
		}
		switch chunk.Type {
		case "text":
			text.WriteString(chunk.Text)
		case "tool_calls":
			toolCalls = append(toolCalls, chunk.ToolCalls...)
		case "usage":
			if chunk.Usage != nil {
				usage = *chunk.Usage
			}
		}
		if chunk.ResponseID != "" {
			respID = chunk.ResponseID
		}
	}
	return provider.Message{
		Role:       provider.RoleAssistant,
		Content:    text.String(),
		ToolCalls:  toolCalls,
		ResponseID: respID,
	}, usage, nil
}

func (c *Client) Stream(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	if c.apiMode() == "responses" {
		return c.streamResponses(ctx, req)
	}
	return c.streamChat(ctx, req)
}

func (c *Client) streamChat(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	payload := map[string]any{
		"model":    req.Model,
		"messages": toChatMessages(req.Messages),
		"stream":   req.Stream,
	}
	applyOptions(payload, req.Options)
	if len(req.Tools) > 0 {
		payload["tools"] = toChatTools(req.Tools)
		payload["tool_choice"] = "auto"
	}
	if req.Stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := joinURL(c.cfg.BaseURL, "/chat/completions")
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header = c.headers()

	out := make(chan provider.Chunk, 16)
	go func() {
		defer close(out)
		res, err := c.client.Do(httpReq)
		if err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
			msg := fmt.Sprintf("openai chat %s: %s", res.Status, strings.TrimSpace(string(b)))
			out <- provider.Chunk{Type: "error", ErrorMsg: msg, Err: fmt.Errorf("%s", msg)}
			return
		}
		if req.Stream {
			c.readChatSSE(res.Body, out)
			return
		}
		c.readChatJSON(res.Body, out)
	}()
	return out, nil
}

func (c *Client) readChatJSON(r io.Reader, out chan<- provider.Chunk) {
	var data struct {
		ID      string `json:"id"`
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(r).Decode(&data); err != nil {
		out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
		return
	}
	if len(data.Choices) == 0 {
		out <- provider.Chunk{Type: "error", ErrorMsg: "empty choices", Err: fmt.Errorf("empty choices")}
		return
	}
	msg := data.Choices[0].Message
	if msg.Content != "" {
		out <- provider.Chunk{Type: "text", Text: msg.Content, ResponseID: data.ID}
	}
	if len(msg.ToolCalls) > 0 {
		calls := make([]provider.ToolCall, 0, len(msg.ToolCalls))
		for _, tc := range msg.ToolCalls {
			calls = append(calls, provider.ToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: json.RawMessage(tc.Function.Arguments),
			})
		}
		out <- provider.Chunk{Type: "tool_calls", ToolCalls: calls, ResponseID: data.ID}
	}
	if data.Usage != nil {
		out <- provider.Chunk{Type: "usage", Usage: &provider.Usage{
			InputTokens:  data.Usage.PromptTokens,
			OutputTokens: data.Usage.CompletionTokens,
			TotalTokens:  data.Usage.TotalTokens,
		}}
	}
	out <- provider.Chunk{Type: "done", ResponseID: data.ID}
}

func (c *Client) readChatSSE(r io.Reader, out chan<- provider.Chunk) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	// Accumulate streamed tool call deltas by index.
	type acc struct {
		id, name string
		args     strings.Builder
	}
	byIdx := map[int]*acc{}
	var respID string
	var usage *provider.Usage

	emitTools := func() {
		if len(byIdx) == 0 {
			return
		}
		// stable order by index
		max := -1
		for i := range byIdx {
			if i > max {
				max = i
			}
		}
		calls := make([]provider.ToolCall, 0, len(byIdx))
		for i := 0; i <= max; i++ {
			a, ok := byIdx[i]
			if !ok || a.name == "" {
				continue
			}
			args := a.args.String()
			if args == "" {
				args = "{}"
			}
			calls = append(calls, provider.ToolCall{
				ID:        a.id,
				Name:      a.name,
				Arguments: json.RawMessage(args),
			})
		}
		if len(calls) > 0 {
			out <- provider.Chunk{Type: "tool_calls", ToolCalls: calls, ResponseID: respID}
		}
	}

	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			emitTools()
			if usage != nil {
				out <- provider.Chunk{Type: "usage", Usage: usage, ResponseID: respID}
			}
			out <- provider.Chunk{Type: "done", ResponseID: respID}
			return
		}
		var data struct {
			ID      string `json:"id"`
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &data); err != nil {
			continue
		}
		if data.ID != "" {
			respID = data.ID
		}
		if data.Usage != nil {
			usage = &provider.Usage{
				InputTokens:  data.Usage.PromptTokens,
				OutputTokens: data.Usage.CompletionTokens,
				TotalTokens:  data.Usage.TotalTokens,
			}
		}
		if len(data.Choices) == 0 {
			continue
		}
		d := data.Choices[0].Delta
		if d.Content != "" {
			out <- provider.Chunk{Type: "text", Text: d.Content, ResponseID: respID}
		}
		for _, tc := range d.ToolCalls {
			a, ok := byIdx[tc.Index]
			if !ok {
				a = &acc{}
				byIdx[tc.Index] = a
			}
			if tc.ID != "" {
				a.id = tc.ID
			}
			if tc.Function.Name != "" {
				a.name += tc.Function.Name
			}
			if tc.Function.Arguments != "" {
				a.args.WriteString(tc.Function.Arguments)
			}
		}
	}
	if err := sc.Err(); err != nil {
		out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
		return
	}
	emitTools()
	out <- provider.Chunk{Type: "done", ResponseID: respID}
}

// streamResponses implements the OpenAI Responses API (non-stream first; stream optional).
func (c *Client) streamResponses(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	// Build input from messages (skip system → instructions)
	var instructions string
	input := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		if m.Role == provider.RoleSystem {
			if instructions != "" {
				instructions += "\n\n"
			}
			instructions += m.Content
			continue
		}
		if m.Role == provider.RoleTool {
			input = append(input, map[string]any{
				"type":    "function_call_output",
				"call_id": m.ToolCallID,
				"output":  m.Content,
			})
			continue
		}
		if m.Role == provider.RoleAssistant && len(m.ToolCalls) > 0 {
			if m.Content != "" {
				input = append(input, map[string]any{"role": "assistant", "content": m.Content})
			}
			for _, tc := range m.ToolCalls {
				input = append(input, map[string]any{
					"type":      "function_call",
					"call_id":   tc.ID,
					"name":      tc.Name,
					"arguments": string(tc.Arguments),
				})
			}
			continue
		}
		role := "user"
		if m.Role == provider.RoleAssistant {
			role = "assistant"
		}
		if len(m.Parts) > 0 {
			content := make([]map[string]any, 0, len(m.Parts))
			for _, part := range m.Parts {
				switch part.Type {
				case "text":
					if part.Text != "" {
						content = append(content, map[string]any{"type": "input_text", "text": part.Text})
					}
				case "image_url":
					if part.ImageURL != "" {
						content = append(content, map[string]any{"type": "input_image", "image_url": part.ImageURL})
					}
				}
			}
			input = append(input, map[string]any{"role": role, "content": content})
		} else {
			input = append(input, map[string]any{"role": role, "content": m.Content})
		}
	}

	payload := map[string]any{
		"model": req.Model,
		"input": input,
	}
	if instructions != "" {
		payload["instructions"] = instructions
	}
	applyOptions(payload, req.Options)
	// responses uses max_output_tokens
	if v, ok := payload["max_tokens"]; ok {
		payload["max_output_tokens"] = v
		delete(payload, "max_tokens")
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			params := t.Parameters
			if len(params) == 0 {
				params = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			tools = append(tools, map[string]any{
				"type":        "function",
				"name":        t.Name,
				"description": t.Description,
				"parameters":  params,
			})
		}
		payload["tools"] = tools
		payload["tool_choice"] = "auto"
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := joinURL(c.cfg.BaseURL, "/responses")
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header = c.headers()

	out := make(chan provider.Chunk, 16)
	go func() {
		defer close(out)
		res, err := c.client.Do(httpReq)
		if err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		defer res.Body.Close()
		b, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		if err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		if res.StatusCode >= 300 {
			msg := fmt.Sprintf("openai responses %s: %s", res.Status, strings.TrimSpace(string(b)))
			out <- provider.Chunk{Type: "error", ErrorMsg: msg, Err: fmt.Errorf("%s", msg)}
			return
		}
		var data struct {
			ID     string `json:"id"`
			Output []struct {
				Type      string `json:"type"`
				Name      string `json:"name"`
				CallID    string `json:"call_id"`
				ID        string `json:"id"`
				Arguments string `json:"arguments"`
				Content   []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"output"`
			OutputText string `json:"output_text"`
			Usage      *struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
				TotalTokens  int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(b, &data); err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		text := data.OutputText
		if text == "" {
			var parts []string
			for _, item := range data.Output {
				for _, c := range item.Content {
					if c.Text != "" {
						parts = append(parts, c.Text)
					}
				}
			}
			text = strings.Join(parts, "\n")
		}
		if text != "" {
			out <- provider.Chunk{Type: "text", Text: text, ResponseID: data.ID}
		}
		var calls []provider.ToolCall
		for _, item := range data.Output {
			if item.Type == "function_call" && item.Name != "" {
				id := item.CallID
				if id == "" {
					id = item.ID
				}
				args := item.Arguments
				if args == "" {
					args = "{}"
				}
				calls = append(calls, provider.ToolCall{
					ID:        id,
					Name:      item.Name,
					Arguments: json.RawMessage(args),
				})
			}
		}
		if len(calls) > 0 {
			out <- provider.Chunk{Type: "tool_calls", ToolCalls: calls, ResponseID: data.ID}
		}
		if data.Usage != nil {
			out <- provider.Chunk{Type: "usage", Usage: &provider.Usage{
				InputTokens:  data.Usage.InputTokens,
				OutputTokens: data.Usage.OutputTokens,
				TotalTokens:  data.Usage.TotalTokens,
			}}
		}
		out <- provider.Chunk{Type: "done", ResponseID: data.ID}
	}()
	return out, nil
}
