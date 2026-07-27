package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/agent"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
)

func TestCaptureImageUploadIsBoundAndTemporary(t *testing.T) {
	store, err := session.Open(t.TempDir() + "/ai.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sess, _ := store.CreateSession("u1", "test", nil)
	run, _ := store.CreateRun(sess.ID, "u1", "openai", "model")
	state := agent.ResumeState{Kind: agent.PauseCapture, PendingCalls: []provider.ToolCall{{ID: "call-1", Name: "remote_desktop_capture_v1"}}, WaitingIndex: 0, Capture: &event.ClientCapture{CallID: "call-1", Name: "remote_desktop.capture"}}
	if err := store.SaveRunResume(run.ID, state); err != nil {
		t.Fatal(err)
	}
	srv := New(config.Config{AdminToken: "secret"}, store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Handler())
	defer httpSrv.Close()
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("pixels")...)
	endpoint := httpSrv.URL + "/admin/runs/" + run.ID + "/capture-image?userId=u1&callId=call-1"
	req, _ := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(png))
	req.Header.Set("X-AI-Admin", "secret")
	req.Header.Set("Content-Type", "image/png")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	id, _ := body["captureAssetId"].(string)
	if resp.StatusCode != 200 || id == "" || !srv.captures.Owns(id, "u1", run.ID, "call-1") {
		t.Fatalf("unexpected response: %d %#v", resp.StatusCode, body)
	}
	bad := endpoint + "&extra=" + url.QueryEscape("x")
	req2, _ := http.NewRequest(http.MethodPost, bad, bytes.NewReader([]byte("not-image")))
	req2.Header.Set("X-AI-Admin", "secret")
	req2.Header.Set("Content-Type", "image/png")
	resp2, _ := http.DefaultClient.Do(req2)
	if resp2.StatusCode == 200 {
		t.Fatal("forged image must fail")
	}
	resp2.Body.Close()
}
