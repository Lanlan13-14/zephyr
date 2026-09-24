// Package streamnorm converts provider Chunks into Contract v2 normalized
// stream events (stream-event.schema.json). Every wire adapter keeps emitting
// its native chunks; this is the single funnel into the canonical frame
// sequence start/text_*/reasoning_*/tool_call_*/usage/done/error so Node,
// Android, iOS and desktop observe identical runs.
package streamnorm

import (
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

// Stop reasons per the contract: stop, length, tool_use, content_filter, cancelled, error.
const (
	StopStop          = "stop"
	StopLength        = "length"
	StopToolUse       = "tool_use"
	StopContentFilter = "content_filter"
	StopCancelled     = "cancelled"
	StopError         = "error"
)

// Event is one normalized frame.
type Event struct {
	SchemaVersion     int             `json:"schemaVersion"`
	Type              string          `json:"type"`
	RunID             string          `json:"runId"`
	Sequence          int             `json:"sequence"`
	ModelID           string          `json:"modelId,omitempty"`
	ProviderAccountID string          `json:"providerAccountId,omitempty"`
	Text              string          `json:"text,omitempty"`
	ToolCallID        string          `json:"toolCallId,omitempty"`
	ToolName          string          `json:"toolName,omitempty"`
	ArgumentsDelta    string          `json:"argumentsDelta,omitempty"`
	Usage             *provider.Usage `json:"usage,omitempty"`
	StopReason        string          `json:"stopReason,omitempty"`
	ErrorCode         string          `json:"errorCode,omitempty"`
}

// Normalizer accumulates one provider stream into frames with a monotonic sequence.
type Normalizer struct {
	RunID             string
	ModelID           string
	ProviderAccountID string
	seq               int
	textOpen          bool
	reasoningOpen     bool
	toolIDs           map[string]bool
	done              bool
}

// New starts a normalizer for one run.
func New(runID, modelID, providerAccountID string) *Normalizer {
	return &Normalizer{RunID: runID, ModelID: modelID, ProviderAccountID: providerAccountID, toolIDs: map[string]bool{}}
}

func (n *Normalizer) next(t string) Event {
	e := Event{SchemaVersion: 2, Type: t, RunID: n.RunID, Sequence: n.seq}
	n.seq++
	return e
}

// Start emits the mandatory opening frame.
func (n *Normalizer) Start() Event {
	e := n.next("start")
	e.ModelID = n.ModelID
	e.ProviderAccountID = n.ProviderAccountID
	return e
}

// Push converts one provider chunk into zero or more frames. done/error chunks
// close any open text/reasoning/tool spans before the terminal frame.
func (n *Normalizer) Push(c provider.Chunk) []Event {
	var out []Event
	emit := func(e Event) { out = append(out, e) }
	switch c.Type {
	case "text":
		if !n.textOpen {
			n.textOpen = true
			emit(n.next("text_start"))
		}
		if c.Text != "" {
			e := n.next("text_delta")
			e.Text = c.Text
			emit(e)
		}
	case "reasoning":
		if !n.reasoningOpen {
			n.reasoningOpen = true
			emit(n.next("reasoning_start"))
		}
		if c.Text != "" {
			e := n.next("reasoning_delta")
			e.Text = c.Text
			emit(e)
		}
	case "tool_calls":
		for _, tc := range c.ToolCalls {
			if !n.toolIDs[tc.ID] {
				n.toolIDs[tc.ID] = true
				e := n.next("tool_call_start")
				e.ToolCallID = tc.ID
				e.ToolName = tc.Name
				emit(e)
			}
			if len(tc.Arguments) > 0 {
				e := n.next("tool_call_delta")
				e.ToolCallID = tc.ID
				e.ArgumentsDelta = string(tc.Arguments)
				emit(e)
			}
		}
	case "usage":
		if c.Usage != nil {
			e := n.next("usage")
			e.Usage = c.Usage
			emit(e)
		}
	case "error":
		n.closeSpans(&out)
		e := n.next("error")
		if c.ErrorMsg != "" {
			e.ErrorCode = "ai_upstream_unavailable"
		} else {
			e.ErrorCode = "ai_upstream_unavailable"
		}
		emit(e)
		n.done = true
	case "done":
		n.closeSpans(&out)
		e := n.next("done")
		e.StopReason = StopStop
		emit(e)
		n.done = true
	}
	return out
}

// CloseTool finalizes one tool call span after full arguments validated.
// It also removes the call from the open set so Finish does not emit a
// duplicate tool_call_end: every span closes exactly once.
func (n *Normalizer) CloseTool(toolCallID string) Event {
	delete(n.toolIDs, toolCallID)
	e := n.next("tool_call_end")
	e.ToolCallID = toolCallID
	return e
}

// Finish closes any open spans and emits done with the given stop reason.
// No-op after a terminal frame: sequences must stay append-only.
func (n *Normalizer) Finish(stopReason string) []Event {
	if n.done {
		return nil
	}
	var out []Event
	n.closeSpans(&out)
	e := n.next("done")
	e.StopReason = stopReason
	out = append(out, e)
	n.done = true
	return out
}

// Fail closes spans and emits a classified error frame.
func (n *Normalizer) Fail(code string) []Event {
	if n.done {
		return nil
	}
	var out []Event
	n.closeSpans(&out)
	e := n.next("error")
	e.ErrorCode = code
	out = append(out, e)
	n.done = true
	return out
}

func (n *Normalizer) closeSpans(out *[]Event) {
	if n.textOpen {
		*out = append(*out, n.next("text_end"))
		n.textOpen = false
	}
	if n.reasoningOpen {
		*out = append(*out, n.next("reasoning_end"))
		n.reasoningOpen = false
	}
	for id := range n.toolIDs {
		delete(n.toolIDs, id)
		e := n.next("tool_call_end")
		e.ToolCallID = id
		*out = append(*out, e)
	}
}
