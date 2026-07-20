package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const historyRecordBytes = 64 * 1024

type historyRecord struct {
	Seq    int64  `json:"seq"`
	TS     int64  `json:"ts"`
	Type   string `json:"type"`
	Data   string `json:"data,omitempty"`
	Cols   int    `json:"cols,omitempty"`
	Rows   int    `json:"rows,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type historyState struct {
	UserID    string
	SessionID string
	Path      string
	Seq       int64
	Cols      int
	Rows      int
}

type WorkerHistory struct {
	root            string
	maxSessionBytes int64
	maxReplayBytes  int
	maxSegments     int
	mu              sync.Mutex
	states          map[string]*historyState
}

func NewWorkerHistory(root string) *WorkerHistory {
	if root == "" {
		root = filepath.Join("data", "terminal-history")
	}
	return &WorkerHistory{
		root:            root,
		maxSessionBytes: envInt64("TERMINAL_HISTORY_SESSION_BYTES", 16*1024*1024),
		maxReplayBytes:  int(envInt64("TERMINAL_HISTORY_REPLAY_BYTES", 2*1024*1024)),
		maxSegments:     int(envInt64("TERMINAL_HISTORY_SEGMENTS", 8)),
		states:          make(map[string]*historyState),
	}
}

func envInt64(name string, fallback int64) int64 {
	if value, err := strconv.ParseInt(os.Getenv(name), 10, 64); err == nil && value > 0 {
		return value
	}
	return fallback
}

func historySafeID(value string) string {
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("._-", r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
		if b.Len() >= 120 {
			break
		}
	}
	if b.Len() == 0 {
		return "anonymous"
	}
	return b.String()
}

func historyHash(userID, sessionID string) string {
	sum := sha256.Sum256([]byte(userID + ":" + sessionID))
	return hex.EncodeToString(sum[:])[:24]
}

func (h *WorkerHistory) stateLocked(userID, sessionID string) *historyState {
	key := userID + "\x00" + sessionID
	if state := h.states[key]; state != nil {
		return state
	}
	dir := filepath.Join(h.root, historySafeID(userID))
	_ = os.MkdirAll(dir, 0700)
	state := &historyState{UserID: userID, SessionID: sessionID, Path: filepath.Join(dir, historyHash(userID, sessionID)+".ndjson")}
	metaPath := strings.TrimSuffix(state.Path, ".ndjson") + ".meta.json"
	if raw, err := os.ReadFile(metaPath); err == nil {
		var meta struct {
			Seq  int64 `json:"seq"`
			Cols int   `json:"cols"`
			Rows int   `json:"rows"`
		}
		if json.Unmarshal(raw, &meta) == nil {
			state.Seq, state.Cols, state.Rows = meta.Seq, meta.Cols, meta.Rows
		}
	}
	if state.Seq == 0 {
		for i := h.maxSegments; i >= 1; i-- {
			if seq := scanLastSeq(fmt.Sprintf("%s.%d", state.Path, i)); seq > state.Seq {
				state.Seq = seq
			}
		}
		if seq := scanLastSeq(state.Path); seq > state.Seq {
			state.Seq = seq
		}
	}
	h.states[key] = state
	return state
}

func scanLastSeq(path string) int64 {
	file, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 512*1024)
	var seq int64
	for scanner.Scan() {
		var rec historyRecord
		if json.Unmarshal(scanner.Bytes(), &rec) == nil && rec.Seq > seq {
			seq = rec.Seq
		}
	}
	return seq
}

func (h *WorkerHistory) append(userID, sessionID string, rec historyRecord) {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.stateLocked(userID, sessionID)
	state.Seq++
	rec.Seq = state.Seq
	rec.TS = time.Now().UnixMilli()
	raw, err := json.Marshal(rec)
	if err != nil {
		return
	}
	raw = append(raw, '\n')
	file, err := os.OpenFile(state.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	_, _ = file.Write(raw)
	_ = file.Close()
	if rec.Type == "resize" {
		state.Cols, state.Rows = rec.Cols, rec.Rows
	}
	h.writeMetaLocked(state)
	if info, err := os.Stat(state.Path); err == nil && info.Size() > h.maxSessionBytes {
		h.compactLocked(state)
	}
}

func (h *WorkerHistory) writeMetaLocked(state *historyState) {
	meta := map[string]any{"version": 1, "userId": state.UserID, "sessionId": state.SessionID, "seq": state.Seq, "cols": state.Cols, "rows": state.Rows, "updatedAt": time.Now().UnixMilli()}
	payload, _ := json.Marshal(meta)
	path := strings.TrimSuffix(state.Path, ".ndjson") + ".meta.json"
	tmp := path + ".tmp"
	if os.WriteFile(tmp, payload, 0600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func (h *WorkerHistory) AppendOutput(userID, sessionID string, data []byte) {
	for len(data) > 0 {
		n := len(data)
		if n > historyRecordBytes {
			n = historyRecordBytes
		}
		h.append(userID, sessionID, historyRecord{Type: "output", Data: base64.StdEncoding.EncodeToString(data[:n])})
		data = data[n:]
	}
}
func (h *WorkerHistory) AppendResize(userID, sessionID string, cols, rows int) {
	h.append(userID, sessionID, historyRecord{Type: "resize", Cols: cols, Rows: rows})
}
func (h *WorkerHistory) AppendClose(userID, sessionID, reason string) {
	if len(reason) > 500 {
		reason = reason[:500]
	}
	h.append(userID, sessionID, historyRecord{Type: "close", Reason: reason})
}

func (h *WorkerHistory) ReplayTail(userID, sessionID string) string {
	h.mu.Lock()
	state := h.stateLocked(userID, sessionID)
	path := state.Path
	limit := h.maxReplayBytes
	h.mu.Unlock()
	paths := make([]string, 0, h.maxSegments+1)
	for i := h.maxSegments; i >= 1; i-- {
		p := fmt.Sprintf("%s.%d", path, i)
		if _, err := os.Stat(p); err == nil {
			paths = append(paths, p)
		}
	}
	paths = append(paths, path)
	chunks := make([][]byte, 0, 128)
	total := 0
	for _, journal := range paths {
		file, err := os.Open(journal)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64*1024), 512*1024)
		for scanner.Scan() {
			var rec historyRecord
			if json.Unmarshal(scanner.Bytes(), &rec) != nil || rec.Type != "output" {
				continue
			}
			data, err := base64.StdEncoding.DecodeString(rec.Data)
			if err != nil {
				continue
			}
			chunks = append(chunks, data)
			total += len(data)
			for total > limit && len(chunks) > 1 {
				total -= len(chunks[0])
				chunks = chunks[1:]
			}
		}
		_ = file.Close()
	}
	out := make([]byte, 0, total)
	for _, chunk := range chunks {
		out = append(out, chunk...)
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return string(out)
}

func (h *WorkerHistory) compactLocked(state *historyState) {
	_ = os.Remove(fmt.Sprintf("%s.%d", state.Path, h.maxSegments))
	for i := h.maxSegments - 1; i >= 1; i-- {
		from := fmt.Sprintf("%s.%d", state.Path, i)
		to := fmt.Sprintf("%s.%d", state.Path, i+1)
		if _, err := os.Stat(from); err == nil {
			_ = os.Rename(from, to)
		}
	}
	if _, err := os.Stat(state.Path); err == nil {
		_ = os.Rename(state.Path, state.Path+".1")
	}
	_ = os.WriteFile(state.Path, nil, 0600)
}
