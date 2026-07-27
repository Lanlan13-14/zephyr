package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/permission"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool/platform"
)

func runConfirmationContextCase(t *testing.T, policy permission.Policy, auto bool, delayMS int) (bool, []event.Event, error) {
	t.Helper()
	st, err := session.Open(filepath.Join(t.TempDir(), "permission.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sess, _ := st.CreateSession("u", "t", nil)
	run, _ := st.CreateRun(sess.ID, "u", "mock", "m")
	confirmed := false
	reg := tool.NewRegistry()
	_ = reg.Register(&tool.FuncTool{
		ToolName: "danger_write", ToolDescription: "write",
		ToolSchema: json.RawMessage(`{"type":"object","properties":{}}`),
		IsReadOnly: false, ToolRisk: tool.RiskHigh,
		Fn: func(ctx context.Context, args json.RawMessage) (any, error) {
			confirmed = platform.IsConfirmedCall(ctx, "danger_write")
			return map[string]any{"ok": true}, nil
		},
	})
	mp := &mockProvider{rounds: []provider.Message{
		{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "c1", Name: "danger_write", Arguments: json.RawMessage(`{}`)}}},
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
	return confirmed, em.evs, err
}

func TestAutoConfirmCarriesApprovalIntoPlatformCall(t *testing.T) {
	confirmed, evs, err := runConfirmationContextCase(t, permission.Policy{Mode: permission.ModeAsk}, true, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !confirmed {
		t.Fatal("auto-confirmed write must reach platform tool as confirmed")
	}
	for _, ev := range evs {
		if ev.Type == event.TypePermissionAsk {
			t.Fatal("auto-confirm must not emit a second permission ask")
		}
	}
}

func TestYoloCarriesApprovalIntoPlatformCall(t *testing.T) {
	confirmed, evs, err := runConfirmationContextCase(t, permission.Policy{Mode: permission.ModeYolo}, false, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !confirmed {
		t.Fatal("YOLO write must reach platform tool as confirmed")
	}
	for _, ev := range evs {
		if ev.Type == event.TypePermissionAsk {
			t.Fatal("YOLO must not emit permission ask")
		}
	}
}
