package session

import (
	"path/filepath"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestSessionRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "t.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sess, err := st.CreateSession("u1", "hello", map[string]any{"k": 1})
	if err != nil {
		t.Fatal(err)
	}
	if sess.UserID != "u1" {
		t.Fatalf("user %s", sess.UserID)
	}

	run, err := st.CreateRun(sess.ID, "u1", "p", "m")
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.AppendMessage(sess.ID, run.ID, provider.Message{Role: provider.RoleUser, Content: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.AppendMessage(sess.ID, run.ID, provider.Message{Role: provider.RoleAssistant, Content: "yo"})
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := st.ProviderMessages(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("msgs %d", len(msgs))
	}

	n, err := st.IncrQuota("u1", "hourly", 3600)
	if err != nil || n != 1 {
		t.Fatalf("quota %d %v", n, err)
	}
	n, err = st.IncrQuota("u1", "hourly", 3600)
	if err != nil || n != 2 {
		t.Fatalf("quota2 %d %v", n, err)
	}

	if err := st.ValidateUserSession("u1", sess.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.ValidateUserSession("u2", sess.ID); err == nil {
		t.Fatal("expected forbid")
	}
}
