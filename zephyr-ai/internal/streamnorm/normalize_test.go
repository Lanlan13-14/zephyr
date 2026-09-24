package streamnorm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestFrameSequenceAndMonotonicSeq(t *testing.T) {
	n := New("run-1", "gpt-5", "openai-main")
	events := []Event{n.Start()}
	events = append(events, n.Push(provider.Chunk{Type: "text", Text: "hi"})...)
	events = append(events, n.Push(provider.Chunk{Type: "reasoning", Text: "why"})...)
	events = append(events, n.Push(provider.Chunk{
		Type:      "tool_calls",
		ToolCalls: []provider.ToolCall{{ID: "call-1", Name: "cell_exec_v1", Arguments: json.RawMessage(`{"cmd":"ls"}`)}},
	})...)
	events = append(events, n.CloseTool("call-1"))
	events = append(events, n.Push(provider.Chunk{Type: "usage", Usage: &provider.Usage{InputTokens: 10, OutputTokens: 5}})...)
	events = append(events, n.Finish(StopToolUse)...)

	want := []string{"start", "text_start", "text_delta", "reasoning_start", "reasoning_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "usage", "text_end", "reasoning_end", "done"}
	if len(events) != len(want) {
		t.Fatalf("got %d events: %+v", len(events), events)
	}
	for i, e := range events {
		if e.Type != want[i] {
			t.Fatalf("event %d = %s want %s", i, e.Type, want[i])
		}
		if e.Sequence != i {
			t.Fatalf("event %d seq=%d", i, e.Sequence)
		}
		if e.SchemaVersion != 2 || e.RunID != "run-1" {
			t.Fatalf("event %d envelope broken: %+v", i, e)
		}
	}
	if events[0].ModelID != "gpt-5" || events[0].ProviderAccountID != "openai-main" {
		t.Fatalf("start frame missing ids: %+v", events[0])
	}
	if events[len(events)-1].StopReason != StopToolUse {
		t.Fatalf("stop=%q", events[len(events)-1].StopReason)
	}
	// Terminal frames are append-only: a second finish emits nothing.
	if extra := n.Finish(StopStop); len(extra) != 0 {
		t.Fatalf("double finish emitted %d frames", len(extra))
	}
}

func TestErrorClosesSpans(t *testing.T) {
	n := New("run-2", "m", "p")
	events := []Event{n.Start()}
	events = append(events, n.Push(provider.Chunk{Type: "text", Text: "partial"})...)
	events = append(events, n.Fail("ai_dns_failed")...)
	last := events[len(events)-1]
	if last.Type != "error" || last.ErrorCode != "ai_dns_failed" {
		t.Fatalf("last=%+v", last)
	}
	// text_end must precede the error frame.
	if events[len(events)-2].Type != "text_end" {
		t.Fatalf("spans not closed: %+v", events[len(events)-2])
	}
}

func TestFramesValidateAgainstContractSchema(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "ai", "v2", "stream-event.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	// Structural check without a full JSON-schema engine: every frame the
	// normalizer emits must carry the envelope fields the contract requires.
	n := New("run-3", "m", "p")
	frames := append([]Event{n.Start()}, n.Finish(StopStop)...)
	required := schema["required"].([]any)
	for _, f := range frames {
		b, _ := json.Marshal(f)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		for _, key := range required {
			if _, ok := m[key.(string)]; !ok {
				t.Fatalf("frame %s missing %s", f.Type, key)
			}
		}
	}
}
