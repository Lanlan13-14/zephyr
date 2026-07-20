package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkerHistoryReplaySurvivesRestart(t *testing.T) {
	root := t.TempDir()
	h := NewWorkerHistory(root)
	h.AppendOutput("u1", "s1", []byte("AAAA"))
	h.AppendResize("u1", "s1", 120, 40)
	h.AppendOutput("u1", "s1", []byte("BBBB"))
	restarted := NewWorkerHistory(root)
	if got := restarted.ReplayTail("u1", "s1"); got != "AAAABBBB" {
		t.Fatalf("replay=%q", got)
	}
}

func TestWorkerHistoryWritesNodeCompatibleNDJSON(t *testing.T) {
	root := t.TempDir()
	h := NewWorkerHistory(root)
	h.AppendOutput("user", "session", []byte{0x41, 0x00, 0x1b})
	state := h.stateLocked("user", "session")
	raw, err := os.ReadFile(state.Path)
	if err != nil {
		t.Fatal(err)
	}
	var rec historyRecord
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Type != "output" || rec.Seq != 1 {
		t.Fatalf("record=%+v", rec)
	}
	data, err := base64.StdEncoding.DecodeString(rec.Data)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string([]byte{0x41, 0x00, 0x1b}) {
		t.Fatalf("data=%v", data)
	}
}

func TestWorkerHistoryIsolatesUsers(t *testing.T) {
	root := t.TempDir()
	h := NewWorkerHistory(root)
	h.AppendOutput("u1", "same", []byte("one"))
	h.AppendOutput("u2", "same", []byte("two"))
	if h.ReplayTail("u1", "same") != "one" || h.ReplayTail("u2", "same") != "two" {
		t.Fatal("history leaked across users")
	}
	if filepath.Dir(h.stateLocked("u1", "same").Path) == filepath.Dir(h.stateLocked("u2", "same").Path) {
		t.Fatal("users share directory")
	}
}

func TestWorkerHistoryCompacts(t *testing.T) {
	t.Setenv("TERMINAL_HISTORY_SESSION_BYTES", "1048576")
	root := t.TempDir()
	h := NewWorkerHistory(root)
	chunk := []byte(strings.Repeat("x", 32*1024))
	for i := 0; i < 50; i++ {
		h.AppendOutput("u", "s", chunk)
	}
	info, err := os.Stat(h.stateLocked("u", "s").Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > 1048576 {
		t.Fatalf("journal too large: %d", info.Size())
	}
	if h.ReplayTail("u", "s") == "" {
		t.Fatal("compaction lost all replay data")
	}
}

func TestWorkerHistoryHashAndMetaMatchNode(t *testing.T) {
	root := t.TempDir()
	h := NewWorkerHistory(root)
	h.AppendResize("user/a", "session:b", 99, 33)
	state := h.stateLocked("user/a", "session:b")
	if filepath.Base(state.Path) != "3eb1ad32f27e59af29b2e9b6.ndjson" {
		t.Fatalf("path=%s", state.Path)
	}
	metaPath := strings.TrimSuffix(state.Path, ".ndjson") + ".meta.json"
	var meta struct {
		UserID    string `json:"userId"`
		SessionID string `json:"sessionId"`
		Seq       int64  `json:"seq"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.UserID != "user/a" || meta.SessionID != "session:b" || meta.Seq != 1 || meta.Cols != 99 || meta.Rows != 33 {
		t.Fatalf("meta=%+v", meta)
	}
}
