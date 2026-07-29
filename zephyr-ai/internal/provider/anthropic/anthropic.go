package anthropic

import (
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
	provider.Register(provider.KindAnthropic, func(cfg provider.Config) (provider.Provider, error) {
		return New(cfg), nil
	})
}

type Client struct {
	cfg    provider.Config
	client *http.Client
}

func New(cfg provider.Config) *Client {
	to := time.Duration(cfg.TimeoutMs) * time.Millisecond
	if to <= 0 {
		to = 120 * time.Second
	}
	return &Client{cfg: cfg, client: &http.Client{Timeout: to}}
}

func (c *Client) Name() string        { return c.cfg.Name }
func (c *Client) Kind() provider.Kind { return provider.KindAnthropic }

func (c *Client) Complete(ctx context.Context, req provider.Request) (provider.Message, provider.Usage, error) {
	req.Stream = false
	ch, err := c.Stream(ctx, req)
	if err != nil {
		return provider.Message{}, provider.Usage{}, err
	}
	var text strings.Builder
	var calls []provider.ToolCall
	var usage provider.Usage
	for chunk := range ch {
		if chunk.Err != nil {
			return provider.Message{}, usage, chunk.Err
		}
		if chunk.ErrorMsg != "" {
			return provider.Message{}, usage, fmt.Errorf("%s", chunk.ErrorMsg)
		}
		if chunk.Type == "text" {
			text.WriteString(chunk.Text)
		}
		if chunk.Type == "tool_calls" {
			calls = append(calls, chunk.ToolCalls...)
		}
		if chunk.Usage != nil {
			usage = *chunk.Usage
		}
	}
	return provider.Message{Role: provider.RoleAssistant, Content: text.String(), ToolCalls: calls}, usage, nil
}

func (c *Client) Stream(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.anthropic.com/v1"
	}
	var system string
	msgs := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		if m.Role == provider.RoleSystem {
			if system != "" {
				system += "\n\n"
			}
			system += m.Content
			continue
		}
		if m.Role == provider.RoleTool {
			msgs = append(msgs, map[string]any{
				"role": "user",
				"content": []map[string]any{{
					"type":        "tool_result",
					"tool_use_id": m.ToolCallID,
					"content":     m.Content,
				}},
			})
			continue
		}
		if m.Role == provider.RoleAssistant && len(m.ToolCalls) > 0 {
			content := make([]map[string]any, 0)
			if m.Content != "" {
				content = append(content, map[string]any{"type": "text", "text": m.Content})
			}
			for _, tc := range m.ToolCalls {
				var input any
				_ = json.Unmarshal(tc.Arguments, &input)
				if input == nil {
					input = map[string]any{}
				}
				content = append(content, map[string]any{
					"type":  "tool_use",
					"id":    tc.ID,
					"name":  tc.Name,
					"input": input,
				})
			}
			msgs = append(msgs, map[string]any{"role": "assistant", "content": content})
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
						content = append(content, map[string]any{"type": "text", "text": part.Text})
					}
				case "image_url":
					mimeType, data, ok := provider.DecodeDataURL(part.ImageURL)
					if !ok {
						return nil, fmt.Errorf("vision_payload_invalid: anthropic image part is not a supported data URL")
					}
					content = append(content, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mimeType, "data": data}})
				}
			}
			msgs = append(msgs, map[string]any{"role": role, "content": content})
		} else {
			msgs = append(msgs, map[string]any{"role": role, "content": m.Content})
		}
	}
	if len(msgs) == 0 {
		msgs = []map[string]any{{"role": "user", "content": "你好"}}
	}

	maxTokens := 4096
	if req.Options != nil {
		if v, ok := req.Options["max_tokens"].(float64); ok {
			maxTokens = int(v)
		} else if v, ok := req.Options["max_tokens"].(int); ok {
			maxTokens = v
		} else if v, ok := req.Options["max_output_tokens"].(float64); ok {
			maxTokens = int(v)
		}
	}
	payload := map[string]any{
		"model":      req.Model,
		"messages":   msgs,
		"max_tokens": maxTokens,
	}
	if system != "" {
		payload["system"] = system
	}
	if req.Options != nil {
		if v, ok := req.Options["temperature"]; ok {
			payload["temperature"] = v
		}
		if v, ok := req.Options["top_p"]; ok {
			payload["top_p"] = v
		}
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			params := t.Parameters
			if len(params) == 0 {
				params = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			tools = append(tools, map[string]any{
				"name":         t.Name,
				"description":  t.Description,
				"input_schema": params,
			})
		}
		payload["tools"] = tools
	}

	body, _ := json.Marshal(payload)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	if c.cfg.APIKey != "" {
		httpReq.Header.Set("x-api-key", c.cfg.APIKey)
	}
	for k, v := range c.cfg.ExtraHeaders {
		httpReq.Header.Set(k, v)
	}

	out := make(chan provider.Chunk, 8)
	go func() {
		defer close(out)
		res, err := c.client.Do(httpReq)
		if err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		if res.StatusCode >= 300 {
			msg := fmt.Sprintf("anthropic %s: %s", res.Status, strings.TrimSpace(string(b)))
			out <- provider.Chunk{Type: "error", ErrorMsg: msg, Err: fmt.Errorf("%s", msg)}
			return
		}
		var data struct {
			Content []struct {
				Type  string          `json:"type"`
				Text  string          `json:"text"`
				ID    string          `json:"id"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
			Usage *struct {
				InputTokens              int `json:"input_tokens"`
				OutputTokens             int `json:"output_tokens"`
				CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
				CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(b, &data); err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		var textParts []string
		var calls []provider.ToolCall
		for _, block := range data.Content {
			switch block.Type {
			case "text":
				textParts = append(textParts, block.Text)
			case "tool_use":
				args := block.Input
				if len(args) == 0 {
					args = json.RawMessage(`{}`)
				}
				calls = append(calls, provider.ToolCall{ID: block.ID, Name: block.Name, Arguments: args})
			}
		}
		if s := strings.Join(textParts, "\n"); s != "" {
			out <- provider.Chunk{Type: "text", Text: s}
		}
		if len(calls) > 0 {
			out <- provider.Chunk{Type: "tool_calls", ToolCalls: calls}
		}
		if data.Usage != nil {
			out <- provider.Chunk{Type: "usage", Usage: &provider.Usage{
				InputTokens:         data.Usage.InputTokens,
				OutputTokens:        data.Usage.OutputTokens,
				TotalTokens:         data.Usage.InputTokens + data.Usage.OutputTokens,
				CacheCreationTokens: data.Usage.CacheCreationInputTokens,
				CacheReadTokens:     data.Usage.CacheReadInputTokens,
				// Match OpenMinis: Anthropic input_tokens already represents the
				// current context window for the call.
				LatestContextTokens: data.Usage.InputTokens,
			}}
		}
		out <- provider.Chunk{Type: "done"}
	}()
	return out, nil
}
