package openai_chat

import (
	"bufio"
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
	provider.RegisterAdapter(provider.APIOpenAIChat, func(cfg provider.Config) (provider.Provider, error) {
		return New(cfg), nil
	})
}

// Client speaks exactly one wire protocol: OpenAI Chat Completions.
type Client struct {
	adapters.Base
}

func New(cfg provider.Config) *Client { return &Client{Base: adapters.NewBase(cfg)} }

func (c *Client) Name() string        { return c.Cfg.Name }
func (c *Client) Kind() provider.Kind { return c.Cfg.Kind }

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
		cm := chatMessage{Role: string(m.Role), ToolCallID: m.ToolCallID}
		// OpenAI message.name is restricted to [A-Za-z0-9_-]+. Internal
		// markers such as zephyr.visual_observation deliberately contain dots;
		// keep them runtime-only instead of sending an invalid provider field.
		if m.Name != "" && !strings.ContainsAny(m.Name, ". ") {
			cm.Name = m.Name
		}
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
func (c *Client) streamChat(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	payload := map[string]any{
		"model":    req.Model,
		"messages": toChatMessages(req.Messages),
		"stream":   req.Stream,
	}
	adapters.ApplyOptions(payload, req.Options, "chat")
	if len(req.Tools) > 0 {
		payload["tools"] = toChatTools(req.Tools)
		payload["tool_choice"] = "auto"
	}
	if req.Stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}

	url := adapters.JoinURL(c.Cfg.BaseURL, "/chat/completions")

	out := make(chan provider.Chunk, 16)
	go func() {
		defer close(out)
		res, err := c.postWithReasoningFallback(ctx, url, "openai chat", payload)
		if err != nil {
			out <- provider.Chunk{Type: "error", Err: err, ErrorMsg: err.Error()}
			return
		}
		defer res.Body.Close()
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
			PromptTokens        int `json:"prompt_tokens"`
			CompletionTokens    int `json:"completion_tokens"`
			TotalTokens         int `json:"total_tokens"`
			PromptTokensDetails *struct {
				CachedTokens    int `json:"cached_tokens"`
				CacheHitTokens  int `json:"cache_hit_tokens"`
				CacheMissTokens int `json:"cache_miss_tokens"`
			} `json:"prompt_tokens_details"`
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
		cached := 0
		if data.Usage.PromptTokensDetails != nil {
			cached = data.Usage.PromptTokensDetails.CachedTokens
			if data.Usage.PromptTokensDetails.CacheHitTokens > cached {
				cached = data.Usage.PromptTokensDetails.CacheHitTokens
			}
		}
		fresh := data.Usage.PromptTokens
		if cached > 0 && cached <= fresh {
			fresh -= cached
		}
		out <- provider.Chunk{Type: "usage", Usage: &provider.Usage{
			InputTokens:         fresh,
			OutputTokens:        data.Usage.CompletionTokens,
			TotalTokens:         data.Usage.TotalTokens,
			CacheReadTokens:     cached,
			LatestContextTokens: data.Usage.PromptTokens,
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
				PromptTokens        int `json:"prompt_tokens"`
				CompletionTokens    int `json:"completion_tokens"`
				TotalTokens         int `json:"total_tokens"`
				PromptTokensDetails *struct {
					CachedTokens    int `json:"cached_tokens"`
					CacheHitTokens  int `json:"cache_hit_tokens"`
					CacheMissTokens int `json:"cache_miss_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(payload), &data); err != nil {
			continue
		}
		if data.ID != "" {
			respID = data.ID
		}
		if data.Usage != nil {
			cached := 0
			if data.Usage.PromptTokensDetails != nil {
				cached = data.Usage.PromptTokensDetails.CachedTokens
				if data.Usage.PromptTokensDetails.CacheHitTokens > cached {
					cached = data.Usage.PromptTokensDetails.CacheHitTokens
				}
			}
			fresh := data.Usage.PromptTokens
			if cached > 0 && cached <= fresh {
				fresh -= cached
			}
			usage = &provider.Usage{
				InputTokens:         fresh,
				OutputTokens:        data.Usage.CompletionTokens,
				TotalTokens:         data.Usage.TotalTokens,
				CacheReadTokens:     cached,
				LatestContextTokens: data.Usage.PromptTokens,
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
func (c *Client) Stream(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	return c.streamChat(ctx, req)
}
