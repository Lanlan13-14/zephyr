package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
)

func TestSessionUsageEndpointIsUserScoped(t *testing.T) {
	store, err := session.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sess, _ := store.CreateSession("u1", "usage", nil)
	run, _ := store.CreateRun(sess.ID, "u1", "p", "m")
	_ = store.UpdateRunStatus(run.ID, "completed", "", map[string]any{"providerCalls": 1, "inputTokens": 42, "outputTokens": 7, "latestContextTokens": 42})
	srv := New(config.Config{AdminToken: "token", DataDir: t.TempDir()}, store, slog.Default())
	defer srv.Close()
	req := httptest.NewRequest(http.MethodGet, "/admin/sessions/"+sess.ID+"/usage?userId=u1", nil)
	req.Header.Set("X-AI-Admin", "token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		OK    bool                 `json:"ok"`
		Usage session.SessionUsage `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Usage.InputTokens != 42 || body.Usage.OutputTokens != 7 {
		t.Fatalf("bad body: %+v", body)
	}
}
