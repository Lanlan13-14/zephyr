package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func init() {
	provider.Register(provider.KindGemini, func(cfg provider.Config) (provider.Provider, error) {
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
func (c *Client) Kind() provider.Kind { return provider.KindGemini }

func (c *Client) Complete(ctx context.Context, req provider.Request) (provider.Message, provider.Usage, error) {
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
		base = "https://generativelanguage.googleapis.com/v1beta"
	}
	var system string
	contents := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		if m.Role == provider.RoleSystem {
			if system != "" {
				system += "\n\n"
			}
			system += m.Content
			continue
		}
		if m.Role == provider.RoleTool {
			contents = append(contents, map[string]any{
				"role": "user",
				"parts": []map[string]any{{
					"functionResponse": map[string]any{
						"name": m.Name,
						"response": map[string]any{
							"content": m.Content,
						},
					},
				}},
			})
			continue
		}
		if m.Role == provider.RoleAssistant && len(m.ToolCalls) > 0 {
			parts := make([]map[string]any, 0)
			if m.Content != "" {
				parts = append(parts, map[string]any{"text": m.Content})
			}
			for _, tc := range m.ToolCalls {
				var args any
				_ = json.Unmarshal(tc.Arguments, &args)
				if args == nil {
					args = map[string]any{}
				}
				parts = append(parts, map[string]any{
					"functionCall": map[string]any{"name": tc.Name, "args": args},
				})
			}
			contents = append(contents, map[string]any{"role": "model", "parts": parts})
			continue
		}
		role := "user"
		if m.Role == provider.RoleAssistant {
			role = "model"
		}
		parts := make([]map[string]any, 0, len(m.Parts))
		if len(m.Parts) > 0 {
			for _, part := range m.Parts {
				switch part.Type {
				case "text":
					if part.Text != "" {
						parts = append(parts, map[string]any{"text": part.Text})
					}
				case "image_url":
					mimeType, data, ok := provider.DecodeDataURL(part.ImageURL)
					if ok {
						parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": mimeType, "data": data}})
					}
				}
			}
		} else {
			parts = append(parts, map[string]any{"text": m.Content})
		}
		contents = append(contents, map[string]any{"role": role, "parts": parts})
	}
	if len(contents) == 0 {
		contents = []map[string]any{{"role": "user", "parts": []map[string]any{{"text": "你好"}}}}
	}

	body := map[string]any{"contents": contents}
	if system != "" {
		body["systemInstruction"] = map[string]any{"parts": []map[string]any{{"text": system}}}
	}
	gen := map[string]any{}
	if req.Options != nil {
		if v, ok := req.Options["temperature"]; ok {
			gen["temperature"] = v
		}
		if v, ok := req.Options["top_p"]; ok {
			gen["topP"] = v
		}
		if v, ok := req.Options["max_tokens"]; ok {
			gen["maxOutputTokens"] = v
		} else if v, ok := req.Options["max_output_tokens"]; ok {
			gen["maxOutputTokens"] = v
		}
	}
	if len(gen) > 0 {
		body["generationConfig"] = gen
	}
	if len(req.Tools) > 0 {
		decls := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			params := t.Parameters
			if len(params) == 0 {
				params = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			var schema any
			_ = json.Unmarshal(params, &schema)
			decls = append(decls, map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  schema,
			})
		}
		body["tools"] = []map[string]any{{"functionDeclarations": decls}}
		body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "AUTO"}}
	}

	model := req.Model
	if !strings.HasPrefix(model, "models/") {
		model = "models/" + url.PathEscape(model)
	}
	u := fmt.Sprintf("%s/%s:generateContent", base, model)
	if c.cfg.APIKey != "" {
		u += "?key=" + url.QueryEscape(c.cfg.APIKey)
	}
	raw, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
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
			msg := fmt.Sprintf("gemini %s: %s", res.Status, strings.TrimSpace(string(b)))
			out <- provider.Chunk{Type: "error", ErrorMsg: msg, Err: fmt.Errorf("%s", msg)}
			return
		}
		var data struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text         string `json:"text"`
						FunctionCall *struct {
							Name string          `json:"name"`
							Args json.RawMessage `json:"args"`
						} `json:"functionCall"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
			UsageMetadata *struct {
				PromptTokenCount     int `json:"promptTokenCount"`
				CandidatesTokenCount int `json:"candidatesTokenCount"`
				TotalTokenCount      int `json:"totalTokenCount"`
			} `json:"usageMetadata"`
		}
		if err := json.Unmarshal(b, &data); err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		var texts []string
		var calls []provider.ToolCall
		for _, cand := range data.Candidates {
			for i, p := range cand.Content.Parts {
				if p.Text != "" {
					texts = append(texts, p.Text)
				}
				if p.FunctionCall != nil && p.FunctionCall.Name != "" {
					args := p.FunctionCall.Args
					if len(args) == 0 {
						args = json.RawMessage(`{}`)
					}
					calls = append(calls, provider.ToolCall{
						ID:        fmt.Sprintf("gemini_fc_%d", i),
						Name:      p.FunctionCall.Name,
						Arguments: args,
					})
				}
			}
		}
		if s := strings.Join(texts, "\n"); s != "" {
			out <- provider.Chunk{Type: "text", Text: s}
		}
		if len(calls) > 0 {
			out <- provider.Chunk{Type: "tool_calls", ToolCalls: calls}
		}
		if data.UsageMetadata != nil {
			out <- provider.Chunk{Type: "usage", Usage: &provider.Usage{
				InputTokens:  data.UsageMetadata.PromptTokenCount,
				OutputTokens: data.UsageMetadata.CandidatesTokenCount,
				TotalTokens:  data.UsageMetadata.TotalTokenCount,
			}}
		}
		out <- provider.Chunk{Type: "done"}
	}()
	return out, nil
}
