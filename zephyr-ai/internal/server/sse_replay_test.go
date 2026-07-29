package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
)

func TestSSEReplayHonorsLastEventID(t *testing.T) {
	store, err := session.Open(filepath.Join(t.TempDir(), "sse.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sess, _ := store.CreateSession("u1", "sse", nil)
	run, _ := store.CreateRun(sess.ID, "u1", "test", "model")
	for i := int64(1); i <= 3; i++ {
		if err := store.AppendEvent(run.ID, i, "text.delta", map[string]any{"seq": i}); err != nil {
			t.Fatal(err)
		}
	}
	srv := New(config.Config{AdminToken: "secret"}, store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer srv.Close()
	req := httptest.NewRequest(http.MethodGet, "/v1/runs/"+run.ID+"/events", nil)
	req.SetPathValue("id", run.ID)
	req.Header.Set("X-AI-Admin", "secret")
	req.Header.Set("Last-Event-ID", "2")
	rec := httptest.NewRecorder()
	srv.handleSSE(rec, req)
	text := rec.Body.String()
	if strings.Contains(text, "id: 1") || strings.Contains(text, "id: 2") || !strings.Contains(text, "id: 3") {
		t.Fatalf("unexpected replay: %s", text)
	}
}
