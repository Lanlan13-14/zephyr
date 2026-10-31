package server

import (
	"bytes"
	"encoding/json"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/agent"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func rpcFixture(t *testing.T) (*Server, *session.Store, string, string, agent.ResumeState) {
	t.Helper()
	dir := t.TempDir()
	store, err := session.Open(filepath.Join(dir, "ai.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	srv := New(config.Config{AdminToken: "test-admin", DataDir: dir}, store, nil)
	t.Cleanup(srv.Close)
	sess, err := store.CreateSession("alice", "rpc", nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(sess.ID, "alice", "p", "m")
	if err != nil {
		t.Fatal(err)
	}
	state := agent.ResumeState{Kind: agent.PausePermission,
		DatabaseGeneration: "generation1", RunNonce: "nonce1", StrictLinkApproval: true,
		PendingCalls: []provider.ToolCall{{ID: "call1", Name: "terminal.exec", Arguments: json.RawMessage(`{"command":"rm target"}`)}},
		Ask:          &event.PermissionAsk{AskID: "call1", CallID: "call1", Name: "terminal.exec", Args: json.RawMessage(`{"command":"rm target"}`), Risk: "high"},
	}
	if err := store.SaveRunResume(run.ID, state); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateRunStatus(run.ID, "waiting_permission", "", nil); err != nil {
		t.Fatal(err)
	}
	return srv, store, run.ID, sess.ID, state
}

func TestRPCSnapshotIsOwnerBoundPagedAndOnlyCurrentInputPreview(t *testing.T) {
	srv, store, runID, _, state := rpcFixture(t)
	for i := 0; i < 205; i++ {
		if err := store.AppendEvent(runID, int64(i), "text.delta", map[string]any{"delta": "hi"}); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest("GET", "/admin/runs/"+runID+"/rpc-snapshot?userId=alice&afterSeq=-1", nil)
	req.SetPathValue("id", runID)
	rec := httptest.NewRecorder()
	srv.handleRPCSnapshot(rec, req)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var out struct {
		Events   []json.RawMessage `json:"events"`
		NextSeq  int64             `json:"nextSeq"`
		HasMore  bool              `json:"hasMore"`
		Approval struct {
			InputHash string `json:"inputHash"`
		} `json:"approval"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Events) != 200 || out.NextSeq != 199 || !out.HasMore {
		t.Fatalf("paging: %#v", out)
	}
	hash, ok := permissionInputHash(&state)
	if !ok || out.Approval.InputHash != hash {
		t.Fatal("missing exact input binding")
	}
	state.PendingCalls[0].Arguments = json.RawMessage(`{"command":"different"}`)
	changed, _ := permissionInputHash(&state)
	if changed == hash {
		t.Fatal("changed command kept approval hash")
	}
	foreign := httptest.NewRequest("GET", "/?userId=bob&afterSeq=-1", nil)
	foreign.SetPathValue("id", runID)
	denied := httptest.NewRecorder()
	srv.handleRPCSnapshot(denied, foreign)
	if denied.Code != 404 {
		t.Fatal("foreign run exposed")
	}
}

func TestStrictApprovalCannotUseLegacyMissingOrChangedInput(t *testing.T) {
	srv, _, runID, sessID, state := rpcFixture(t)
	hash, _ := permissionInputHash(&state)
	for _, inputHash := range []string{"", "wrong"} {
		raw, _ := json.Marshal(map[string]any{"userId": "alice", "sessionId": sessID, "callId": "call1", "tool": "terminal.exec", "approve": true, "scope": "once", "inputHash": inputHash})
		req := httptest.NewRequest("POST", "/", bytes.NewReader(raw))
		req.SetPathValue("id", runID)
		rec := httptest.NewRecorder()
		srv.handlePermission(rec, req)
		if rec.Code != 403 && rec.Code != 409 {
			t.Fatalf("unsafe approval %d %s", rec.Code, rec.Body.String())
		}
	}
	raw, _ := json.Marshal(map[string]any{"userId": "alice", "sessionId": sessID, "callId": "call1", "tool": "terminal.exec", "approve": false, "scope": "once", "inputHash": hash})
	req := httptest.NewRequest("POST", "/", bytes.NewReader(raw))
	req.SetPathValue("id", runID)
	rec := httptest.NewRecorder()
	srv.handlePermission(rec, req)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	again := httptest.NewRequest("POST", "/", bytes.NewReader(raw))
	again.SetPathValue("id", runID)
	replay := httptest.NewRecorder()
	srv.handlePermission(replay, again)
	if replay.Code != 409 {
		t.Fatal("consumed approval replayed")
	}
}

func TestApprovalResumeSQLiteCASHasExactlyOneWinner(t *testing.T) {
	_, store, runID, _, state := rpcFixture(t)
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := store.ConsumeRunResume(runID, state)
			if err != nil {
				t.Error(err)
			}
			if ok {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("approval winners %d", winners.Load())
	}
	current, err := store.GetRun(runID)
	if err != nil || current.Status != "running" {
		t.Fatalf("CAS state %#v %v", current, err)
	}
}
