package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/agent"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
)

type captureTool struct{}

func (captureTool) Name() string { return "remote_desktop_capture_v1" }
func (captureTool) Description() string { return "capture" }
func (captureTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object","properties":{}}`) }
func (captureTool) ReadOnly() bool { return true }
func (captureTool) Risk() tool.Risk { return tool.RiskLow }
func (captureTool) ParallelSafe() bool { return false }
func (captureTool) Execute(context.Context, json.RawMessage) (any, error) {
	return map[string]any{
		"ok": true,
		"data": map[string]any{
			"clientCaptureRequired": true,
			"clientCapture": map[string]any{"type": "remote_desktop_capture_v1", "tabId": "rdp-1", "maxWidth": 640},
		},
	}, nil
}

type captureEmitter struct{ capture chan event.ClientCapture }
func (e captureEmitter) Emit(ev event.Event) error {
	if ev.Type == event.TypeClientCapture {
		var c event.ClientCapture
		_ = json.Unmarshal(ev.Data, &c)
		select { case e.capture <- c: default: }
	}
	return nil
}

func TestRDPClientCaptureBecomesNativeImageInNextProviderRequest(t *testing.T) {
	var mu sync.Mutex
	var calls int
	var first map[string]any
	var second map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		calls++
		n := calls
		if n == 1 { first = body }
		if n == 2 { second = body }
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if n == 1 {
			_, _ = fmt.Fprint(w, "data: {\"id\":\"resp-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-capture\",\"function\":{\"name\":\"remote_desktop_capture_v1\",\"arguments\":\"{}\"}}]}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		_, _ = fmt.Fprint(w, "data: {\"id\":\"resp-2\",\"choices\":[{\"delta\":{\"content\":\"我能看到远程桌面图片\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	store, err := session.Open(filepath.Join(t.TempDir(), "vision.sqlite"))
	if err != nil { t.Fatal(err) }
	defer store.Close()
	sess, _ := store.CreateSession("u1", "vision", nil)
	run, _ := store.CreateRun(sess.ID, "u1", "openai", "vision-model")
	reg := tool.NewRegistry()
	if err := reg.Register(captureTool{}); err != nil { t.Fatal(err) }

	srv := New(config.Config{AdminToken: "secret"}, store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer srv.Close()
	captureCh := make(chan event.ClientCapture, 1)
	providerCfg := provider.Config{Kind: provider.KindOpenAIComp, BaseURL: upstream.URL, APIKey: "k", DefaultModel: "vision-model", APIMode: "chat"}
	p, err := provider.New(providerCfg)
	if err != nil { t.Fatal(err) }
	cfg := agent.Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u1", Provider: p, Model: "vision-model",
		Tools: reg, Store: store, Emitter: captureEmitter{capture: captureCh}, SystemPrompt: "test",
		ExtraMessages: []provider.Message{{Role: provider.RoleUser, Content: "屏幕上有什么"}},
		ProviderConfig: providerCfg, Captures: srv.captures, MaxSteps: 4,
	}
	runErr := make(chan error, 1)
	go func() { _, err := srv.runner.Run(context.Background(), cfg); runErr <- err }()

	var capture event.ClientCapture
	select {
	case capture = <-captureCh:
	case err := <-runErr:
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("run ended before capture: %v calls=%d first=%s", err, calls, mustJSON(first))
	case <-time.After(3 * time.Second):
		t.Fatal("client.capture not emitted")
	}
	if capture.CallID != "call-capture" { t.Fatalf("callId=%q", capture.CallID) }
	select {
	case err := <-runErr:
		if _, ok := err.(*agent.PauseError); !ok { t.Fatalf("expected pause, got %v", err) }
	case <-time.After(3 * time.Second):
		t.Fatal("capture pause was not persisted")
	}

	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("pixels")...)
	asset, err := srv.captures.Put("u1", run.ID, capture.CallID, "image/png", png)
	if err != nil { t.Fatal(err) }
	var state agent.ResumeState
	if err := store.LoadRunResume(run.ID, &state); err != nil { t.Fatal(err) }
	resume := agent.Config{
		RunID: run.ID, SessionID: sess.ID, UserID: "u1", Provider: p, Model: state.Model,
		Tools: reg, Store: store, Emitter: captureEmitter{capture: captureCh}, SystemPrompt: state.SystemPrompt,
		VolatilePrompt: state.VolatilePrompt, Options: state.Options, MaxSteps: state.MaxSteps,
		ProviderConfig: providerCfg, Captures: srv.captures, Resume: &state,
		Decision: &agent.ResumeDecision{
			Approve: true, CallID: capture.CallID, CaptureAssetID: asset.ID,
			CaptureResult: json.RawMessage(`{"captureId":"rdp-1:123:640:360","capture":{"tabId":"rdp-1","protocol":"RDP","captureId":"rdp-1:123:640:360"}}`),
		},
	}
	if _, err := srv.runner.Run(context.Background(), resume); err != nil { t.Fatal(err) }

	mu.Lock()
	defer mu.Unlock()
	if calls != 2 { t.Fatalf("provider calls=%d", calls) }
	messages, _ := second["messages"].([]any)
	found := false
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		parts, _ := msg["content"].([]any)
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			if part["type"] == "image_url" {
				image, _ := part["image_url"].(map[string]any)
				url, _ := image["url"].(string)
				if len(url) > len("data:image/png;base64,") && url[:len("data:image/png;base64,")] == "data:image/png;base64," { found = true }
			}
		}
	}
	if !found { t.Fatalf("native image_url missing from second request: %s", mustJSON(second)) }
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return fmt.Sprint(string(b)) }
