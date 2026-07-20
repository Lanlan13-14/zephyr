package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/permission"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

type mockProvider struct {
	rounds []provider.Message
	i      int
}

func (m *mockProvider) Name() string        { return "mock" }
func (m *mockProvider) Kind() provider.Kind { return provider.KindOpenAIComp }
func (m *mockProvider) Complete(ctx context.Context, req provider.Request) (provider.Message, provider.Usage, error) {
	ch, err := m.Stream(ctx, req)
	if err != nil {
		return provider.Message{}, provider.Usage{}, err
	}
	var msg provider.Message
	msg.Role = provider.RoleAssistant
	for c := range ch {
		if c.Type == "text" {
			msg.Content += c.Text
		}
		if c.Type == "tool_calls" {
			msg.ToolCalls = append(msg.ToolCalls, c.ToolCalls...)
		}
	}
	return msg, provider.Usage{}, nil
}
func (m *mockProvider) Stream(ctx context.Context, req provider.Request) (<-chan provider.Chunk, error) {
	out := make(chan provider.Chunk, 4)
	go func() {
		defer close(out)
		if m.i >= len(m.rounds) {
			out <- provider.Chunk{Type: "text", Text: "done"}
			out <- provider.Chunk{Type: "done"}
			return
		}
		msg := m.rounds[m.i]
		m.i++
		if msg.Content != "" {
			out <- provider.Chunk{Type: "text", Text: msg.Content}
		}
		if len(msg.ToolCalls) > 0 {
			out <- provider.Chunk{Type: "tool_calls", ToolCalls: msg.ToolCalls}
		}
		out <- provider.Chunk{Type: "done"}
	}()
	return out, nil
}

type collectEmitter struct {
	evs []event.Event
}

func (c *collectEmitter) Emit(ev event.Event) error {
	c.evs = append(c.evs, ev)
	return nil
}

func TestLoopToolThenAnswer(t *testing.T) {
	dir := t.TempDir()
	st, err := session.Open(filepath.Join(dir, "a.sqlite"))
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
		ToolName: "echo", ToolDescription: "echo",
		ToolSchema:     json.RawMessage(`{"type":"object","properties":{"x":{"type":"string"}}}`),
		IsReadOnly:     true,
		IsParallelSafe: true,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			return map[string]any{"ok": true, "args": string(args)}, nil
		},
	})

	mp := &mockProvider{rounds: []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{
			ID: "c1", Name: "echo", Arguments: json.RawMessage(`{"x":"1"}`),
		}}},
		{Role: provider.RoleAssistant, Content: "final answer"},
	}}
	em := &collectEmitter{}
	r := NewRunner()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = r.Run(ctx, Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u",
		Provider: mp, Model: "m", Tools: reg,
		Permission:    permission.NewEngine(permission.Policy{Mode: permission.ModeAuto}),
		Store:         st,
		Emitter:       em,
		SystemPrompt:  "sys",
		ExtraMessages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}},
		MaxSteps:      8,
		SkipCompact:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var sawText, sawTool, sawDone bool
	for _, e := range em.evs {
		switch e.Type {
		case event.TypeTextDelta:
			sawText = true
		case event.TypeToolResult:
			sawTool = true
		case event.TypeRunCompleted:
			sawDone = true
		}
	}
	if !sawTool || !sawText || !sawDone {
		t.Fatalf("events tool=%v text=%v done=%v", sawTool, sawText, sawDone)
	}
}

func TestPermissionPauseAndResume(t *testing.T) {
	dir := t.TempDir()
	st, err := session.Open(filepath.Join(dir, "b.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sess, _ := st.CreateSession("u", "t", nil)
	run, _ := st.CreateRun(sess.ID, "u", "mock", "m")

	var execCount atomic.Int32
	reg := tool.NewRegistry()
	_ = reg.Register(&tool.FuncTool{
		ToolName: "danger_write", ToolDescription: "write",
		ToolSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`),
		IsReadOnly: false, ToolRisk: tool.RiskHigh,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			execCount.Add(1)
			return map[string]any{"ok": true, "wrote": true}, nil
		},
	})

	mp := &mockProvider{rounds: []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{
			ID: "c-danger", Name: "danger_write", Arguments: json.RawMessage(`{"path":"/tmp/x"}`),
		}}},
		{Role: provider.RoleAssistant, Content: "wrote ok"},
	}}
	em := &collectEmitter{}
	r := NewRunner()
	ctx := context.Background()
	_, err = r.Run(ctx, Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u",
		Provider: mp, Model: "m", Tools: reg,
		Permission:    permission.NewEngine(permission.Policy{Mode: permission.ModeAsk}),
		Store:         st,
		Emitter:       em,
		SystemPrompt:  "sys",
		ExtraMessages: []provider.Message{{Role: provider.RoleUser, Content: "write it"}},
		MaxSteps:      8,
		SkipCompact:   true,
		ProviderConfig: provider.Config{Name: "mock", Kind: provider.KindOpenAIComp},
	})
	pe, ok := err.(*PauseError)
	if !ok {
		t.Fatalf("want PauseError got %v", err)
	}
	if pe.Kind != PausePermission {
		t.Fatalf("kind %s", pe.Kind)
	}
	if execCount.Load() != 0 {
		t.Fatal("must not execute before approve")
	}
	// durable state
	var loaded ResumeState
	if err := st.LoadRunResume(run.ID, &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.WaitingIndex != 0 || len(loaded.PendingCalls) != 1 {
		t.Fatalf("resume state %+v", loaded)
	}

	// resume with approve — same mock continues to second round
	em2 := &collectEmitter{}
	// need hub-less store clear happens inside Run
	_, err = r.Run(ctx, Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u",
		Provider: mp, Model: "m", Tools: reg,
		Permission:   permission.NewEngine(permission.Policy{Mode: permission.ModeAsk}),
		Store:        st,
		Emitter:      em2,
		SystemPrompt: "sys",
		MaxSteps:     8,
		SkipCompact:  true,
		Resume:       &loaded,
		Decision:     &ResumeDecision{Approve: true, CallID: "c-danger", OnceGrant: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if execCount.Load() != 1 {
		t.Fatalf("exec count %d", execCount.Load())
	}
	var done bool
	for _, e := range em2.evs {
		if e.Type == event.TypeRunCompleted {
			done = true
		}
	}
	if !done {
		t.Fatal("expected completed after resume")
	}
}
