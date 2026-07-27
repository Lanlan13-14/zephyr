// Package provider defines the multi-vendor LLM provider surface.
package provider

import (
	"context"
	"encoding/json"
	"strings"
)

// Kind identifies a wire protocol family.
type Kind string

const (
	KindOpenAI     Kind = "openai"
	KindOpenAIComp Kind = "openai-compatible"
	KindAnthropic  Kind = "anthropic"
	KindGemini     Kind = "gemini"
	KindOllama     Kind = "ollama"
)

// Config is a resolved provider instance (secrets already filled by control plane).
type Config struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Kind         Kind              `json:"kind"`
	BaseURL      string            `json:"baseUrl"`
	APIKey       string            `json:"apiKey"`
	DefaultModel string            `json:"defaultModel"`
	Models       []string          `json:"models,omitempty"`
	APIMode      string            `json:"apiMode,omitempty"` // auto|chat|responses
	Organization string            `json:"organization,omitempty"`
	ExtraHeaders map[string]string `json:"extraHeaders,omitempty"`
	Options      map[string]any    `json:"options,omitempty"`
	TimeoutMs    int               `json:"timeoutMs,omitempty"`
	Retries      int               `json:"retries,omitempty"`
}

// Role for chat messages.
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ContentPart is multimodal content. Text is the common case.
type ContentPart struct {
	Type     string `json:"type"` // text | image_url
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
	MIMEType string `json:"mimeType,omitempty"`
}

// DecodeDataURL returns the media type and raw base64 payload without decoding
// image bytes. Provider wire adapters can embed the payload directly.
func DecodeDataURL(value string) (mimeType, data string, ok bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", false
	}
	header, payload, found := strings.Cut(strings.TrimPrefix(value, "data:"), ",")
	if !found || !strings.HasSuffix(strings.ToLower(header), ";base64") || payload == "" {
		return "", "", false
	}
	mimeType = strings.TrimSuffix(header, ";base64")
	if mimeType != "image/png" && mimeType != "image/jpeg" && mimeType != "image/webp" {
		return "", "", false
	}
	return mimeType, payload, true
}

// ToolCall is a completed function call from the model.
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// Message is the provider-neutral transcript unit.
type Message struct {
	Role       Role          `json:"role"`
	Content    string        `json:"content,omitempty"`
	Parts      []ContentPart `json:"parts,omitempty"`
	ToolCalls  []ToolCall    `json:"toolCalls,omitempty"`
	ToolCallID string        `json:"toolCallId,omitempty"`
	Name       string        `json:"name,omitempty"`
	ResponseID string        `json:"responseId,omitempty"`
}

// ToolSchema is exposed to the model.
type ToolSchema struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// Request is one model invocation.
type Request struct {
	Model    string         `json:"model"`
	Messages []Message      `json:"messages"`
	Tools    []ToolSchema   `json:"tools,omitempty"`
	Options  map[string]any `json:"options,omitempty"`
	Stream   bool           `json:"stream"`
}

// Chunk is a streaming unit. Providers must only emit complete ToolCalls.
type Chunk struct {
	Type       string     // text | reasoning | tool_calls | usage | error | done
	Text       string     `json:"text,omitempty"`
	ToolCalls  []ToolCall `json:"toolCalls,omitempty"`
	ResponseID string     `json:"responseId,omitempty"`
	Usage      *Usage     `json:"usage,omitempty"`
	Err        error      `json:"-"`
	ErrorMsg   string     `json:"error,omitempty"`
}

type Usage struct {
	InputTokens  int `json:"inputTokens,omitempty"`
	OutputTokens int `json:"outputTokens,omitempty"`
	TotalTokens  int `json:"totalTokens,omitempty"`
}

// Provider streams or completes chat.
type Provider interface {
	Name() string
	Kind() Kind
	// Stream yields chunks until done/error. Channel is closed when finished.
	Stream(ctx context.Context, req Request) (<-chan Chunk, error)
	// Complete is a convenience non-stream path.
	Complete(ctx context.Context, req Request) (Message, Usage, error)
}

// Factory builds a Provider from config.
type Factory func(cfg Config) (Provider, error)
