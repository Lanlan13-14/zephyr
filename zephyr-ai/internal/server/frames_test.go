package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/agent"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/adapters/openai_chat"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/streamnorm"
)

func TestFramesEndpointReplaysAndStreams(t *testing.T) {
	dir := t.TempDir()
	store, err := session.Open(dir + "/t.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := New(config.Config{AdminToken: "secret"}, store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer srv.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	defer upstream.Close()

	sess, _ := store.CreateSession("u1", "frames", nil)
	run, _ := store.CreateRun(sess.ID, "u1", "openai", "m")
	hub := newSSEHub()
	fhub := newFrameHub()
	srv.mu.Lock()
	srv.emitters[run.ID] = hub
	srv.frameHubs[run.ID] = fhub
	srv.mu.Unlock()

	p, err := provider.NewAdapter(provider.Config{Kind: provider.KindOpenAIComp, BaseURL: upstream.URL, APIMode: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = srv.runner.Run(context.Background(), agent.Config{
			RunID: run.ID, SessionID: sess.ID, UserID: "u1",
			Provider: p, Model: "m", Store: store, Emitter: hub,
			FrameStore: store, NormSink: fhub.Publish,
			ProviderConfig: provider.Config{ID: "p1"},
			MaxSteps:       1,
		})
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("run hung")
	}

	frames, err := store.ListFrames(run.ID, -1)
	if err != nil || len(frames) == 0 {
		t.Fatalf("frames=%d err=%v", len(frames), err)
	}
	if frames[0].Type != "start" {
		t.Fatalf("first frame=%q", frames[0].Type)
	}
	last := frames[len(frames)-1]
	if last.Type != "done" {
		t.Fatalf("last frame=%q", last.Type)
	}
	var doneFrame streamnorm.Event
	if err := json.Unmarshal(last.Frame, &doneFrame); err != nil {
		t.Fatal(err)
	}
	if doneFrame.StopReason != streamnorm.StopStop {
		t.Fatalf("stop=%q", doneFrame.StopReason)
	}
	// Sequence is gapless from zero.
	for i, f := range frames {
		if f.Seq != i {
			t.Fatalf("frame %d seq=%d", i, f.Seq)
		}
	}

	// HTTP replay serves the same frames.
	req := httptest.NewRequest("GET", "/v1/runs/"+run.ID+"/frames", nil)
	req.Header.Set("x-ai-admin", "secret")
	req.SetPathValue("id", run.ID)
	rec := httptest.NewRecorder()
	srv.handleFrames(rec, req.WithContext(context.Background()))
	resp := rec.Result()
	body := rec.Body.String()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "event: start") || !strings.Contains(body, "event: done") {
		t.Fatalf("replay missing frames: %s", body)
	}
}
