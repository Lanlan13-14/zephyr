package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/permission"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/streamnorm"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

// Regression for the swallowed post-tool answer: the provider "done" chunk
// closes only one step's stream, but normPush used to feed it to the
// Normalizer, which emitted a terminal done frame after step 1 and then
// dropped every frame of step 2 (n.done=true). The Node history monitor
// observed an early done and finalized the run with step 1's partial text.
func TestFramesNotFinalizedAfterIntermediateToolStep(t *testing.T) {
	dir := t.TempDir()
	st, err := session.Open(filepath.Join(dir, "frames.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sess, err := st.CreateSession("u", "t", nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := st.CreateRun(sess.ID, "u", "mock", "m")
	if err != nil {
		t.Fatal(err)
	}

	reg := tool.NewRegistry()
	_ = reg.Register(&tool.FuncTool{
		ToolName: "cell_exec_v1", ToolDescription: "exec",
		ToolSchema: json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}`),
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			return map[string]any{"ok": true, "stdout": "hi"}, nil
		},
	})

	mp := &mockProvider{rounds: []provider.Message{
		{Role: provider.RoleAssistant, Content: "让我看看。",
			ToolCalls: []provider.ToolCall{{ID: "c1", Name: "cell_exec_v1", Arguments: json.RawMessage(`{"command":"echo"}`)}}},
		{Role: provider.RoleAssistant, Content: "工具执行完成，这是最终回复。"},
	}}
	em := &collectEmitter{}
	r := NewRunner()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = r.Run(ctx, Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u",
		Provider: mp, Model: "m", Tools: reg,
		Permission:    permission.NewEngine(permission.Policy{Mode: permission.ModeYolo}),
		Store:         st,
		Emitter:       em,
		SystemPrompt:  "sys",
		ExtraMessages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}},
		MaxSteps:      8,
		SkipCompact:   true,
		FrameStore:    st,
	})
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}

	frames, err := st.ListFrames(run.ID, -1)
	if err != nil {
		t.Fatalf("list frames: %v", err)
	}
	doneCount := 0
	sawFinalText := false
	var lastDone streamnorm.StoredFrame
	for _, f := range frames {
		switch f.Type {
		case "done":
			doneCount++
			lastDone = f
		case "text_delta":
			var fe streamnorm.Event
			if json.Unmarshal(f.Frame, &fe) == nil && strings.Contains(fe.Text, "这是最终回复") {
				sawFinalText = true
			}
		}
	}
	if doneCount != 1 {
		t.Fatalf("expected exactly 1 done frame, got %d (early finalization bug)", doneCount)
	}
	if !sawFinalText {
		t.Fatalf("step 2 text frame missing — post-tool answer was swallowed")
	}
	if lastDone.Seq > 0 && doneCount == 1 {
		// done must be the last frame of the run
		if lastDone.Seq != frames[len(frames)-1].Seq {
			t.Fatalf("done frame is not terminal: seq=%d, last=%d", lastDone.Seq, frames[len(frames)-1].Seq)
		}
	}
	// Legacy event stream must also carry the final text.
	var sawFinalDelta bool
	for _, e := range em.evs {
		if e.Type != event.TypeTextDelta {
			continue
		}
		var d event.TextDelta
		if json.Unmarshal(e.Data, &d) == nil && strings.Contains(d.Text, "这是最终回复") {
			sawFinalDelta = true
		}
	}
	if !sawFinalDelta {
		t.Fatalf("legacy events missing final text delta")
	}
}