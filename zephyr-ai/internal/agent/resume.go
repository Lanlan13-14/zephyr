package agent

import (
	"encoding/json"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

// PauseKind identifies why a run is waiting.
type PauseKind string

const (
	PausePermission PauseKind = "permission"
	PauseCapture    PauseKind = "capture"
)

// CompletedTool is a tool in the current batch that already finished before pause.
type CompletedTool struct {
	CallID string          `json:"callId"`
	Name   string          `json:"name"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
	MS     int64           `json:"ms,omitempty"`
}

// ResumeState is durable mid-run pause state. Stored as JSON on the run row.
// On approve/capture, the server rebuilds tools/provider and continues WITHOUT
// injecting a fake user turn.
type ResumeState struct {
	Kind PauseKind `json:"kind"`

	// Tool step that was interrupted.
	PendingCalls []provider.ToolCall `json:"pendingCalls"`
	// Index into PendingCalls of the call waiting for permission/capture.
	WaitingIndex int `json:"waitingIndex"`
	// Already-finished tools in this batch (must not re-execute on resume).
	Completed []CompletedTool `json:"completed,omitempty"`

	// Permission ask payload (for UI reattach).
	Ask *event.PermissionAsk `json:"ask,omitempty"`
	// Capture payload.
	Capture *event.ClientCapture `json:"capture,omitempty"`

	// Snapshot of loop knobs (provider secret is NOT stored; Node re-injects).
	Model        string         `json:"model"`
	SystemPrompt string         `json:"systemPrompt"`
	Options      map[string]any `json:"options,omitempty"`
	MaxSteps     int            `json:"maxSteps"`
	StepsDone    int            `json:"stepsDone"`
	// Provider skeleton without key — Node fills apiKey on resume.
	Provider provider.Config `json:"provider"`
	// Permission policy snapshot.
	PermissionMode     string   `json:"permissionMode,omitempty"`
	Deny               []string `json:"deny,omitempty"`
	Allow              []string `json:"allow,omitempty"`
	AskRules           []string `json:"askRules,omitempty"`
	AutoConfirm        bool     `json:"autoConfirm,omitempty"`
	AutoConfirmDelayMS int      `json:"autoConfirmDelayMs,omitempty"`
	// MCP servers to re-attach.
	MCPServers          json.RawMessage `json:"mcpServers,omitempty"`
	Context             json.RawMessage `json:"context,omitempty"`
	ContextWindowTokens int             `json:"contextWindowTokens,omitempty"`
	OutputReserveTokens int             `json:"outputReserveTokens,omitempty"`

	// Metrics so far.
	Metrics Metrics `json:"metrics"`
}

func (s *ResumeState) WaitingCall() (provider.ToolCall, bool) {
	if s == nil || s.WaitingIndex < 0 || s.WaitingIndex >= len(s.PendingCalls) {
		return provider.ToolCall{}, false
	}
	return s.PendingCalls[s.WaitingIndex], true
}
