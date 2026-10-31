package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/agent"
)

// The preview contains only the one currently paused tool. A changed input invalidates the hash.
func permissionInputHash(state *agent.ResumeState) (string, bool) {
	waiting, ok := state.WaitingCall()
	if !ok || state.Kind != agent.PausePermission || state.Ask == nil ||
		state.Ask.CallID != waiting.ID || state.Ask.Name != waiting.Name {
		return "", false
	}
	raw, err := json.Marshal(struct {
		CallID     string          `json:"callId"`
		Name       string          `json:"name"`
		Arguments  json.RawMessage `json:"arguments"`
		Generation string          `json:"generation"`
		Nonce      string          `json:"nonce"`
	}{waiting.ID, waiting.Name, waiting.Arguments, state.DatabaseGeneration, state.RunNonce})
	if err != nil {
		return "", false
	}
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:]), true
}

func (s *Server) handleRPCSnapshot(w http.ResponseWriter, r *http.Request) {
	id, owner := r.PathValue("id"), r.URL.Query().Get("userId")
	run, err := s.store.GetRun(id)
	if err != nil || owner == "" || run.UserID != owner {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	after, err := strconv.ParseInt(r.URL.Query().Get("afterSeq"), 10, 64)
	if err != nil || after < -1 {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid_cursor"})
		return
	}
	events, err := s.store.ListEvents(id, after, 201)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": "event_store_failed"})
		return
	}
	page := make([]any, 0, 200)
	size, cursor, more := 0, after, false
	for _, value := range events {
		if len(page) == 200 || (size > 0 && size+len(value.Payload) > 1<<20) {
			more = true
			break
		}
		if len(value.Payload) > 1<<20 {
			writeJSON(w, 413, map[string]any{"ok": false, "error": "event_too_large"})
			return
		}
		var payload any
		if json.Unmarshal(value.Payload, &payload) != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": "invalid_event"})
			return
		}
		page = append(page, map[string]any{"seq": value.Seq, "eventType": value.Type, "payload": payload})
		cursor, size = value.Seq, size+len(value.Payload)
	}
	out := map[string]any{"ok": true, "run": run, "events": page, "nextSeq": cursor, "hasMore": more}
	if run.Status == "waiting_permission" {
		var state agent.ResumeState
		if s.store.LoadRunResume(id, &state) == nil {
			if hash, ok := permissionInputHash(&state); ok {
				call, _ := state.WaitingCall()
				out["approval"] = map[string]any{"approvalId": state.Ask.AskID, "callId": call.ID, "tool": call.Name, "inputHash": hash, "arguments": call.Arguments, "risk": state.Ask.Risk, "expiresAt": time.Now().Add(2 * time.Minute).UnixMilli()}
			}
		}
	}
	writeJSON(w, 200, out)
}
