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

func runAutoConfirmCase(t *testing.T, policy permission.Policy, auto bool, delayMS int) (int32, []event.Event, error) {
	t.Helper()
	dir := t.TempDir()
	st, err := session.Open(filepath.Join(dir, "auto.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sess, _ := st.CreateSession("u", "t", nil)
	run, _ := st.CreateRun(sess.ID, "u", "mock", "m")
	var count atomic.Int32
	reg := tool.NewRegistry()
	_ = reg.Register(&tool.FuncTool{
		ToolName: "danger_write", ToolDescription: "write",
		ToolSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`),
		IsReadOnly: false, ToolRisk: tool.RiskHigh,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			count.Add(1)
			return map[string]any{"ok": true}, nil
		},
	})
	mp := &mockProvider{rounds: []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "c-auto", Name: "danger_write", Arguments: json.RawMessage(`{"path":"/tmp/x"}`)}}},
		{Role: provider.RoleAssistant, Content: "done"},
	}}
	em := &collectEmitter{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = NewRunner().Run(ctx, Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u", Provider: mp, Model: "m", Tools: reg,
		Permission: permission.NewEngine(policy), PermissionPolicy: policy,
		AutoConfirm: auto, AutoConfirmDelayMS: delayMS,
		Store: st, Emitter: em, SystemPrompt: "sys",
		ExtraMessages: []provider.Message{{Role: provider.RoleUser, Content: "write"}},
		MaxSteps:      4, SkipCompact: true,
	})
	return count.Load(), em.evs, err
}

func TestAutoConfirmExecutesAskModeWriterWithoutPermissionPause(t *testing.T) {
	count, evs, err := runAutoConfirmCase(t, permission.Policy{Mode: permission.ModeAsk}, true, 1)
	if err != nil {
		t.Fatalf("unexpected pause/error: %v", err)
	}
	if count != 1 {
		t.Fatalf("execute count %d", count)
	}
	for _, ev := range evs {
		if ev.Type == event.TypePermissionAsk {
			t.Fatal("auto-confirm must not emit permission.ask")
		}
	}
}

func TestAutoConfirmDoesNotOverrideExplicitAskRule(t *testing.T) {
	count, _, err := runAutoConfirmCase(t, permission.Policy{Mode: permission.ModeYolo, Ask: []permission.Rule{"danger_write(*)"}}, true, 0)
	if _, ok := err.(*PauseError); !ok {
		t.Fatalf("want permission pause, got %v", err)
	}
	if count != 0 {
		t.Fatalf("execute count %d", count)
	}
}
