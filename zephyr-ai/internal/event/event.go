// Package event defines the AI runtime wire events.
//
// Contract rules (do not break without a version bump):
//   - Events are JSON objects with type + runId + seq + ts.
//   - seq is strictly monotonic per run, starting at 1.
//   - Clients must tolerate unknown event types.
//   - Terminal events: run.completed | run.failed | run.aborted
package event

import (
	"encoding/json"
	"time"
)

const ProtocolVersion = 1

type Type string

const (
	TypeRunStarted       Type = "run.started"
	TypeTextDelta        Type = "text.delta"
	TypeReasoningDelta   Type = "reasoning.delta"
	TypeToolPending      Type = "tool.pending"
	TypeToolStart        Type = "tool.start"
	TypeToolResult       Type = "tool.result"
	TypeToolError        Type = "tool.error"
	TypePermissionAsk    Type = "permission.ask"
	TypeClientCapture    Type = "client.capture"
	TypeStepCompacted    Type = "step.compacted"
	TypeMessageCompleted Type = "message.completed"
	TypeRunCompleted     Type = "run.completed"
	TypeRunFailed        Type = "run.failed"
	TypeRunAborted       Type = "run.aborted"
	TypeHeartbeat        Type = "heartbeat"
)

// Event is the SSE/WS envelope. Data holds the type-specific payload.
type Event struct {
	Type    Type            `json:"type"`
	RunID   string          `json:"runId"`
	Seq     int64           `json:"seq"`
	TS      int64           `json:"ts"`
	Version int             `json:"v"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func New(runID string, seq int64, t Type, data any) Event {
	var raw json.RawMessage
	if data != nil {
		b, err := json.Marshal(data)
		if err == nil {
			raw = b
		}
	}
	return Event{
		Type:    t,
		RunID:   runID,
		Seq:     seq,
		TS:      time.Now().UnixMilli(),
		Version: ProtocolVersion,
		Data:    raw,
	}
}

type RunStarted struct {
	SessionID  string `json:"sessionId"`
	ProviderID string `json:"providerId,omitempty"`
	Model      string `json:"model,omitempty"`
	Mode       string `json:"mode,omitempty"`
}

type TextDelta struct {
	Text string `json:"text"`
}

type ReasoningDelta struct {
	Text string `json:"text"`
}

type ToolPending struct {
	CallID string `json:"callId"`
	Name   string `json:"name"`
	Args   any    `json:"args,omitempty"`
}

type ToolStart struct {
	CallID string `json:"callId"`
	Name   string `json:"name"`
	Args   any    `json:"args,omitempty"`
}

type ToolResult struct {
	CallID     string `json:"callId"`
	Name       string `json:"name"`
	Result     any    `json:"result,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Status     string `json:"status"` // success | error
}

type PermissionAsk struct {
	AskID   string `json:"askId"`
	CallID  string `json:"callId"`
	Name    string `json:"name"`
	Args    any    `json:"args,omitempty"`
	Summary string `json:"summary,omitempty"`
	Risk    string `json:"risk,omitempty"`
}

type ClientCapture struct {
	CallID   string `json:"callId"`
	Name     string `json:"name"`
	Args     any    `json:"args,omitempty"`
	TabID    string `json:"tabId,omitempty"`
	MaxWidth int    `json:"maxWidth,omitempty"`
}

type MessageCompleted struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type RunTerminal struct {
	Reason  string `json:"reason,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
	Metrics any    `json:"metrics,omitempty"`
}

type Compacted struct {
	OriginalCount  int `json:"originalCount"`
	CompactedCount int `json:"compactedCount"`
	TotalChars     int `json:"totalChars"`
}
