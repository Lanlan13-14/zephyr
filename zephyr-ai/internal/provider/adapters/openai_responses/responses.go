package openai_responses

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/adapters"
)

func init() {
	provider.RegisterAdapter(provider.APIOpenAIResponses, func(cfg provider.Config) (provider.Provider, error) {
		return New(cfg), nil
	})
}

// Client speaks exactly one wire protocol: OpenAI Responses.
type Client struct {
	adapters.Base
}

func New(cfg provider.Config) *Client { return &Client{Base: adapters.NewBase(cfg)} }

func (c *Client) Name() string        { return c.Cfg.Name }
func (c *Client) Kind() provider.Kind { return c.Cfg.Kind }

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
	adapters.ApplyOptions(payload, req.Options, "responses")
	// max_tokens is not valid on Responses (applyOptions already mapped it to
	// max_output_tokens); drop any stray alias that slipped through.
	delete(payload, "max_tokens")
	delete(payload, "max_completion_tokens")
	delete(payload, "presence_penalty")
	delete(payload, "frequency_penalty")
	delete(payload, "response_format")
	delete(payload, "stop")
	delete(payload, "n")
	if r, ok := payload["reasoning_effort"]; ok {
		delete(payload, "reasoning_effort")
		if effort, ok := r.(string); ok && effort != "" {
			existing, _ := payload["reasoning"].(map[string]any)
			if existing == nil {
				existing = map[string]any{}
			}
			if _, set := existing["effort"]; !set {
				existing["effort"] = effort
			}
			payload["reasoning"] = existing
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
				"type":        "function",
				"name":        t.Name,
				"description": t.Description,
				"parameters":  params,
			})
		}
		payload["tools"] = tools
		payload["tool_choice"] = "auto"
	}

	url := adapters.JoinURL(c.Cfg.BaseURL, "/responses")

	out := make(chan provider.Chunk, 16)
	go func() {
		defer close(out)
		res, err := c.postWithReasoningFallback(ctx, url, "openai responses", payload)
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
				InputTokens        int `json:"input_tokens"`
				OutputTokens       int `json:"output_tokens"`
				TotalTokens        int `json:"total_tokens"`
				InputTokensDetails *struct {
					CachedTokens int `json:"cached_tokens"`
				} `json:"input_tokens_details"`
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
			cached := 0
			if data.Usage.InputTokensDetails != nil {
				cached = data.Usage.InputTokensDetails.CachedTokens
			}
			fresh := data.Usage.InputTokens
			if cached > 0 && cached <= fresh {
				fresh -= cached
			}
			out <- provider.Chunk{Type: "usage", Usage: &provider.Usage{
				InputTokens:         fresh,
				OutputTokens:        data.Usage.OutputTokens,
				TotalTokens:         data.Usage.TotalTokens,
				CacheReadTokens:     cached,
				LatestContextTokens: data.Usage.InputTokens,
			}}
		}
		out <- provider.Chunk{Type: "done", ResponseID: data.ID}
	}()
	return out, nil
}
func normalizeEffort(value any) string {
	v := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	switch v {
	case "ultra":
		return "max"
	case "max", "xhigh", "high", "medium", "low", "minimal", "none":
		return v
	default:
		return ""
	}
}
func nextEffortFallback(level string) string {
	switch normalizeEffort(level) {
	case "max":
		return "xhigh"
	case "xhigh":
		return "high"
	case "high":
		return "medium"
	case "medium":
		return "low"
	case "low":
		return "minimal"
	default:
		return ""
	}
}
func rejectedEffort(message string) string {
	text := strings.ToLower(message)
	if !strings.Contains(text, "reason") && !strings.Contains(text, "thinking") && !strings.Contains(text, "effort") {
		return ""
	}
	for _, level := range []string{"minimal", "medium", "xhigh", "none", "high", "low", "max"} {
		if strings.Contains(text, level) && (strings.Contains(text, "invalid") || strings.Contains(text, "unsupported") || strings.Contains(text, "not supported") || strings.Contains(text, "unknown")) {
			return level
		}
	}
	return ""
}
func downgradeReasoningPayload(payload map[string]any, rejected string) bool {
	rejected = normalizeEffort(rejected)
	if rejected == "" {
		return false
	}
	next := nextEffortFallback(rejected)
	changed := false
	if current := normalizeEffort(payload["reasoning_effort"]); current == rejected {
		if next == "" {
			delete(payload, "reasoning_effort")
		} else {
			payload["reasoning_effort"] = next
		}
		changed = true
	}
	if reasoning, ok := payload["reasoning"].(map[string]any); ok {
		if current := normalizeEffort(reasoning["effort"]); current == rejected {
			if next == "" {
				delete(payload, "reasoning")
			} else {
				reasoning["effort"] = next
				payload["reasoning"] = reasoning
			}
			changed = true
		}
	}
	return changed
}
func (c *Client) postWithReasoningFallback(ctx context.Context, url, label string, payload map[string]any) (*http.Response, error) {
	for attempt := 0; attempt < 7; attempt++ {
		body, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		httpReq.Header = adapters.Headers(c.Cfg)
		res, err := c.Do(httpReq)
		if err != nil {
			return nil, err
		}
		if res.StatusCode < 300 {
			return res, nil
		}
		b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		res.Body.Close()
		message := fmt.Sprintf("%s %s: %s", label, res.Status, strings.TrimSpace(string(b)))
		if rejected := rejectedEffort(message); rejected != "" && downgradeReasoningPayload(payload, rejected) {
			continue
		}
		return nil, fmt.Errorf("%s", message)
	}
	return nil, fmt.Errorf("%s reasoning fallback exhausted", label)
}
func (c *Client) Stream(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	return c.streamResponses(ctx, req)
}

