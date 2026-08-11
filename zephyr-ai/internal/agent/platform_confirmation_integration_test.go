package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func runPlatformConfirmationCase(t *testing.T, policy permission.Policy, auto bool) (bool, []event.Event, error) {
	t.Helper()
	confirmed := false
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/ai-host/v1/tools":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "tools": []map[string]any{{
				"name": "danger_write", "description": "write", "parameters": map[string]any{"type": "object", "properties": map[string]any{}},
				"readOnly": false, "risk": "high", "parallelSafe": false,
			}}})
		case "/internal/ai-host/v1/call":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			confirmed, _ = body["confirmed"].(bool)
			if !confirmed {
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]any{
					"confirmationRequired": true,
					"confirmation":         map[string]any{"id": "legacy-ask", "tool": "danger_write", "summary": "confirm", "args": map[string]any{}},
				}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]any{"ok": true}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer host.Close()

	st, err := session.Open(filepath.Join(t.TempDir(), "platform.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sess, _ := st.CreateSession("u", "t", nil)
	run, _ := st.CreateRun(sess.ID, "u", "mock", "m")
	reg := tool.NewRegistry()
	ph := platform.NewHost(host.URL, "")
	if err := platform.RegisterFromHost(context.Background(), reg, ph, "u", sess.ID, run.ID, "generation", "nonce", nil); err != nil {
		t.Fatal(err)
	}
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
		AutoConfirm: auto, AutoConfirmDelayMS: 1,
		Store: st, Emitter: em, SystemPrompt: "sys",
		ExtraMessages: []provider.Message{{Role: provider.RoleUser, Content: "write"}},
		MaxSteps:      4, SkipCompact: true,
	})
	return confirmed, em.evs, err
}

func assertNoPermissionAsk(t *testing.T, evs []event.Event) {
	t.Helper()
	for _, ev := range evs {
		if ev.Type == event.TypePermissionAsk {
			t.Fatal("unexpected permission.ask")
		}
	}
}

func TestPlatformAutoConfirmDoesNotAskTwice(t *testing.T) {
	confirmed, evs, err := runPlatformConfirmationCase(t, permission.Policy{Mode: permission.ModeAsk}, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !confirmed {
		t.Fatal("Node platform call did not receive confirmed=true")
	}
	assertNoPermissionAsk(t, evs)
}

func TestPlatformYoloDoesNotAskAgain(t *testing.T) {
	confirmed, evs, err := runPlatformConfirmationCase(t, permission.Policy{Mode: permission.ModeYolo}, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !confirmed {
		t.Fatal("YOLO platform call did not receive confirmed=true")
	}
	assertNoPermissionAsk(t, evs)
}
