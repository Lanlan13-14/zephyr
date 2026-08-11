// Package session persists AI chat sessions, messages, runs and tool traces.
//
// Authority is server-side. Browser localStorage is a cache only.
package session

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

type Store struct {
	db *sql.DB
	mu sync.Mutex
}

type Session struct {
	ID             string         `json:"id"`
	UserID         string         `json:"userId"`
	Title          string         `json:"title"`
	ProviderID     string         `json:"providerId,omitempty"`
	Model          string         `json:"model,omitempty"`
	Mode           string         `json:"mode,omitempty"` // standard|plan|goal
	PermissionMode string         `json:"permissionMode,omitempty"`
	ConnectionIDs  []string       `json:"connectionIds,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	DatabaseGeneration string     `json:"-"`
	CreatedAt      int64          `json:"createdAt"`
	UpdatedAt      int64          `json:"updatedAt"`
	ArchivedAt     int64          `json:"archivedAt,omitempty"`
}

type Message struct {
	ID         int64           `json:"id"`
	SessionID  string          `json:"sessionId"`
	Role       string          `json:"role"`
	Content    string          `json:"content,omitempty"`
	PartsJSON  json.RawMessage `json:"parts,omitempty"`
	ToolCalls  json.RawMessage `json:"toolCalls,omitempty"`
	ToolCallID string          `json:"toolCallId,omitempty"`
	Name       string          `json:"name,omitempty"`
	ResponseID string          `json:"responseId,omitempty"`
	RunID      string          `json:"runId,omitempty"`
	CreatedAt  int64           `json:"createdAt"`
}

type Run struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId"`
	UserID    string          `json:"userId"`
	Status    string          `json:"status"` // queued|running|waiting_permission|waiting_capture|completed|failed|aborted
	Provider  string          `json:"provider,omitempty"`
	Model     string          `json:"model,omitempty"`
	Error     string          `json:"error,omitempty"`
	Metrics   json.RawMessage `json:"metrics,omitempty"`
	CreatedAt int64           `json:"createdAt"`
	UpdatedAt int64           `json:"updatedAt"`
}

type SessionUsage struct {
	SessionID           string `json:"sessionId"`
	RunCount            int    `json:"runCount"`
	ProviderCalls       int    `json:"providerCalls"`
	InputTokens         int    `json:"inputTokens"`
	OutputTokens        int    `json:"outputTokens"`
	CacheCreationTokens int    `json:"cacheCreationTokens,omitempty"`
	CacheReadTokens     int    `json:"cacheReadTokens,omitempty"`
	LatestContextTokens int    `json:"latestContextTokens,omitempty"`
	LastRun             *Run   `json:"lastRun,omitempty"`
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // sqlite write safety
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS ai_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'standard',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  connection_ids_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  database_generation TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_user ON ai_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES ai_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  parts_json TEXT NOT NULL DEFAULT '',
  tool_calls_json TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  response_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, id);

CREATE TABLE IF NOT EXISTS ai_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  resume_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_session ON ai_runs(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_ai_events_run ON ai_events(run_id, seq);

CREATE TABLE IF NOT EXISTS ai_quota (
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  PRIMARY KEY(user_id, bucket)
);

CREATE TABLE IF NOT EXISTS ai_permission_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  rule TEXT NOT NULL,
  scope TEXT NOT NULL, -- once|session|user
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_grants_user ON ai_permission_grants(user_id, session_id);
`)
	if err != nil {
		return err
	}
	// Soft migrate older DBs missing resume_json
	_, _ = s.db.Exec(`ALTER TABLE ai_runs ADD COLUMN resume_json TEXT NOT NULL DEFAULT ''`)
	_, _ = s.db.Exec(`ALTER TABLE ai_sessions ADD COLUMN database_generation TEXT NOT NULL DEFAULT ''`)
	return nil
}

func (s *Store) SaveRunResume(runID string, state any) error {
	b, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE ai_runs SET resume_json=?, updated_at=? WHERE run_id=?`, string(b), nowMS(), runID)
	return err
}

func (s *Store) ClearRunResume(runID string) error {
	_, err := s.db.Exec(`UPDATE ai_runs SET resume_json='', updated_at=? WHERE run_id=?`, nowMS(), runID)
	return err
}

func (s *Store) LoadRunResume(runID string, dest any) error {
	var raw string
	err := s.db.QueryRow(`SELECT resume_json FROM ai_runs WHERE run_id=?`, runID).Scan(&raw)
	if err != nil {
		return err
	}
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("no_resume_state")
	}
	return json.Unmarshal([]byte(raw), dest)
}

func nowMS() int64 { return time.Now().UnixMilli() }

func (s *Store) CreateSession(userID string, title string, meta map[string]any, generation ...string) (*Session, error) {
	id := newID("ses")
	ts := nowMS()
	databaseGeneration := ""
	if len(generation) > 0 {
		databaseGeneration = generation[0]
	}
	metaJSON, _ := json.Marshal(meta)
	if metaJSON == nil {
		metaJSON = []byte("{}")
	}
	if title == "" {
		title = "新对话"
	}
	_, err := s.db.Exec(`INSERT INTO ai_sessions(session_id,user_id,title,metadata_json,database_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
		id, userID, title, string(metaJSON), databaseGeneration, ts, ts)
	if err != nil {
		return nil, err
	}
	return s.GetSession(userID, id, generation...)
}

func (s *Store) GetSession(userID, id string, generation ...string) (*Session, error) {
	query := `SELECT session_id,user_id,title,provider_id,model,mode,permission_mode,connection_ids_json,metadata_json,database_generation,created_at,updated_at,archived_at
FROM ai_sessions WHERE session_id=? AND user_id=?`
	args := []any{id, userID}
	if len(generation) > 0 {
		query += ` AND database_generation=?`
		args = append(args, generation[0])
	}
	row := s.db.QueryRow(query, args...)
	var sess Session
	var connJSON, metaJSON string
	if err := row.Scan(&sess.ID, &sess.UserID, &sess.Title, &sess.ProviderID, &sess.Model, &sess.Mode, &sess.PermissionMode, &connJSON, &metaJSON, &sess.DatabaseGeneration, &sess.CreatedAt, &sess.UpdatedAt, &sess.ArchivedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(connJSON), &sess.ConnectionIDs)
	_ = json.Unmarshal([]byte(metaJSON), &sess.Metadata)
	return &sess, nil
}

func (s *Store) ListSessions(userID string, limit int, generation ...string) ([]Session, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `SELECT session_id,user_id,title,provider_id,model,mode,permission_mode,connection_ids_json,metadata_json,database_generation,created_at,updated_at,archived_at
FROM ai_sessions WHERE user_id=? AND archived_at=0`
	args := []any{userID}
	if len(generation) > 0 {
		query += ` AND database_generation=?`
		args = append(args, generation[0])
	}
	query += ` ORDER BY updated_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var sess Session
		var connJSON, metaJSON string
		if err := rows.Scan(&sess.ID, &sess.UserID, &sess.Title, &sess.ProviderID, &sess.Model, &sess.Mode, &sess.PermissionMode, &connJSON, &metaJSON, &sess.DatabaseGeneration, &sess.CreatedAt, &sess.UpdatedAt, &sess.ArchivedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(connJSON), &sess.ConnectionIDs)
		_ = json.Unmarshal([]byte(metaJSON), &sess.Metadata)
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (s *Store) TouchSession(id string) error {
	_, err := s.db.Exec(`UPDATE ai_sessions SET updated_at=? WHERE session_id=?`, nowMS(), id)
	return err
}

func (s *Store) UpdateSession(userID, id string, patch map[string]any) (*Session, error) {
	sess, err := s.GetSession(userID, id)
	if err != nil {
		return nil, err
	}
	if v, ok := patch["title"].(string); ok {
		sess.Title = v
	}
	if v, ok := patch["providerId"].(string); ok {
		sess.ProviderID = v
	}
	if v, ok := patch["model"].(string); ok {
		sess.Model = v
	}
	if v, ok := patch["mode"].(string); ok {
		sess.Mode = v
	}
	if v, ok := patch["permissionMode"].(string); ok {
		sess.PermissionMode = v
	}
	connJSON, _ := json.Marshal(sess.ConnectionIDs)
	metaJSON, _ := json.Marshal(sess.Metadata)
	_, err = s.db.Exec(`UPDATE ai_sessions SET title=?,provider_id=?,model=?,mode=?,permission_mode=?,connection_ids_json=?,metadata_json=?,updated_at=? WHERE session_id=? AND user_id=?`,
		sess.Title, sess.ProviderID, sess.Model, sess.Mode, sess.PermissionMode, string(connJSON), string(metaJSON), nowMS(), id, userID)
	if err != nil {
		return nil, err
	}
	return s.GetSession(userID, id)
}

func (s *Store) ArchiveSession(userID, id string) error {
	_, err := s.db.Exec(`UPDATE ai_sessions SET archived_at=?, updated_at=? WHERE session_id=? AND user_id=?`, nowMS(), nowMS(), id, userID)
	return err
}

func (s *Store) AppendMessage(sessionID, runID string, msg provider.Message) (*Message, error) {
	parts, _ := json.Marshal(msg.Parts)
	if parts == nil {
		parts = []byte("")
	}
	tcs, _ := json.Marshal(msg.ToolCalls)
	if tcs == nil {
		tcs = []byte("")
	}
	ts := nowMS()
	res, err := s.db.Exec(`INSERT INTO ai_messages(session_id,role,content,parts_json,tool_calls_json,tool_call_id,name,response_id,run_id,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?)`,
		sessionID, string(msg.Role), msg.Content, string(parts), string(tcs), msg.ToolCallID, msg.Name, msg.ResponseID, runID, ts)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	_ = s.TouchSession(sessionID)
	return &Message{
		ID: id, SessionID: sessionID, Role: string(msg.Role), Content: msg.Content,
		PartsJSON: parts, ToolCalls: tcs, ToolCallID: msg.ToolCallID, Name: msg.Name,
		ResponseID: msg.ResponseID, RunID: runID, CreatedAt: ts,
	}, nil
}

const (
	maxBootstrapMessages     = 500
	maxBootstrapMessageBytes = 2 * 1024 * 1024
	maxBootstrapTotalBytes   = 8 * 1024 * 1024
)

// BootstrapMessages imports an owner-authenticated canonical transcript into
// a newly-created runtime session. It is intentionally insert-if-empty: Node
// may resend the same bootstrap on retries, but an existing runtime transcript
// can never be overwritten or extended through this path.
func (s *Store) BootstrapMessages(userID, sessionID string, messages []provider.Message) (bool, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(sessionID) == "" {
		return false, fmt.Errorf("bootstrap owner and session are required")
	}
	if len(messages) == 0 {
		return false, nil
	}
	if len(messages) > maxBootstrapMessages {
		return false, fmt.Errorf("bootstrap transcript exceeds %d messages", maxBootstrapMessages)
	}
	totalBytes := 0
	for _, message := range messages {
		if message.Role != provider.RoleUser && message.Role != provider.RoleAssistant {
			return false, fmt.Errorf("bootstrap transcript contains forbidden role %q", message.Role)
		}
		if len(message.Content) > maxBootstrapMessageBytes {
			return false, fmt.Errorf("bootstrap message exceeds %d bytes", maxBootstrapMessageBytes)
		}
		totalBytes += len(message.Content)
		if totalBytes > maxBootstrapTotalBytes {
			return false, fmt.Errorf("bootstrap transcript exceeds %d bytes", maxBootstrapTotalBytes)
		}
		if len(message.Parts) != 0 || len(message.ToolCalls) != 0 ||
			message.ToolCallID != "" || message.Name != "" || message.ResponseID != "" {
			return false, fmt.Errorf("bootstrap transcript must contain plain completed messages only")
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var owner string
	if err := tx.QueryRow(`SELECT user_id FROM ai_sessions WHERE session_id=?`, sessionID).Scan(&owner); err != nil {
		return false, err
	}
	if owner != userID {
		return false, fmt.Errorf("runtime session does not belong to authenticated owner")
	}
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM ai_messages WHERE session_id=?`, sessionID).Scan(&count); err != nil {
		return false, err
	}
	if count != 0 {
		return false, nil
	}
	ts := nowMS()
	for index, message := range messages {
		if _, err := tx.Exec(`INSERT INTO ai_messages
			(session_id,role,content,parts_json,tool_calls_json,tool_call_id,name,response_id,run_id,created_at)
			VALUES(?,?,?,'','','','','','bootstrap',?)`,
			sessionID, string(message.Role), message.Content, ts+int64(index)); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(`UPDATE ai_sessions SET updated_at=? WHERE session_id=? AND user_id=?`,
		ts+int64(len(messages)), sessionID, userID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ListMessages(sessionID string, afterID int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT id,session_id,role,content,parts_json,tool_calls_json,tool_call_id,name,response_id,run_id,created_at
FROM ai_messages WHERE session_id=? AND id>? ORDER BY id ASC LIMIT ?`, sessionID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var parts, tcs string
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &parts, &tcs, &m.ToolCallID, &m.Name, &m.ResponseID, &m.RunID, &m.CreatedAt); err != nil {
			return nil, err
		}
		if parts != "" {
			m.PartsJSON = json.RawMessage(parts)
		}
		if tcs != "" {
			m.ToolCalls = json.RawMessage(tcs)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ProviderMessages loads transcript as provider.Message slice (full history).
func (s *Store) ProviderMessages(sessionID string) ([]provider.Message, error) {
	msgs, err := s.ListMessages(sessionID, 0, 500)
	if err != nil {
		return nil, err
	}
	out := make([]provider.Message, 0, len(msgs))
	for _, m := range msgs {
		pm := provider.Message{
			Role:       provider.Role(m.Role),
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
			Name:       m.Name,
			ResponseID: m.ResponseID,
		}
		if len(m.PartsJSON) > 0 {
			_ = json.Unmarshal(m.PartsJSON, &pm.Parts)
		}
		if len(m.ToolCalls) > 0 {
			_ = json.Unmarshal(m.ToolCalls, &pm.ToolCalls)
		}
		out = append(out, pm)
	}
	return out, nil
}

func (s *Store) CreateRun(sessionID, userID, providerName, model string) (*Run, error) {
	id := newID("run")
	ts := nowMS()
	_, err := s.db.Exec(`INSERT INTO ai_runs(run_id,session_id,user_id,status,provider,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
		id, sessionID, userID, "queued", providerName, model, ts, ts)
	if err != nil {
		return nil, err
	}
	return &Run{ID: id, SessionID: sessionID, UserID: userID, Status: "queued", Provider: providerName, Model: model, CreatedAt: ts, UpdatedAt: ts}, nil
}

func (s *Store) UpdateRunStatus(runID, status, errMsg string, metrics any) error {
	var mj string = "{}"
	if metrics != nil {
		b, _ := json.Marshal(metrics)
		if len(b) > 0 {
			mj = string(b)
		}
	}
	_, err := s.db.Exec(`UPDATE ai_runs SET status=?, error=?, metrics_json=?, updated_at=? WHERE run_id=?`,
		status, errMsg, mj, nowMS(), runID)
	return err
}

func (s *Store) GetRun(runID string) (*Run, error) {
	row := s.db.QueryRow(`SELECT run_id,session_id,user_id,status,provider,model,error,metrics_json,created_at,updated_at FROM ai_runs WHERE run_id=?`, runID)
	var r Run
	var mj string
	if err := row.Scan(&r.ID, &r.SessionID, &r.UserID, &r.Status, &r.Provider, &r.Model, &r.Error, &mj, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	if mj != "" {
		r.Metrics = json.RawMessage(mj)
	}
	return &r, nil
}

func metricInt(raw json.RawMessage, key string) int {
	var data map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &data) != nil {
		return 0
	}
	value, ok := data[key].(float64)
	if !ok {
		return 0
	}
	return int(value)
}

func (s *Store) SessionUsage(userID, sessionID string, generation ...string) (SessionUsage, error) {
	if err := s.ValidateUserSession(userID, sessionID, generation...); err != nil {
		return SessionUsage{}, err
	}
	rows, err := s.db.Query(`SELECT run_id,session_id,user_id,status,provider,model,error,metrics_json,created_at,updated_at FROM ai_runs WHERE session_id=? AND user_id=? ORDER BY created_at ASC, rowid ASC`, sessionID, userID)
	if err != nil {
		return SessionUsage{}, err
	}
	defer rows.Close()
	usage := SessionUsage{SessionID: sessionID}
	for rows.Next() {
		var run Run
		var metrics string
		if err := rows.Scan(&run.ID, &run.SessionID, &run.UserID, &run.Status, &run.Provider, &run.Model, &run.Error, &metrics, &run.CreatedAt, &run.UpdatedAt); err != nil {
			return SessionUsage{}, err
		}
		run.Metrics = json.RawMessage(metrics)
		usage.RunCount++
		usage.ProviderCalls += metricInt(run.Metrics, "providerCalls")
		usage.InputTokens += metricInt(run.Metrics, "inputTokens")
		usage.OutputTokens += metricInt(run.Metrics, "outputTokens")
		usage.CacheCreationTokens += metricInt(run.Metrics, "cacheCreationTokens")
		usage.CacheReadTokens += metricInt(run.Metrics, "cacheReadTokens")
		if latest := metricInt(run.Metrics, "latestContextTokens"); latest > 0 {
			usage.LatestContextTokens = latest
		} else if input := metricInt(run.Metrics, "inputTokens"); input > 0 {
			usage.LatestContextTokens = input
		}
		runCopy := run
		var lastMetrics map[string]any
		if json.Unmarshal(run.Metrics, &lastMetrics) == nil {
			encoded, _ := json.Marshal(lastMetrics)
			runCopy.Metrics = encoded
		}
		usage.LastRun = &runCopy
	}
	if err := rows.Err(); err != nil {
		return SessionUsage{}, err
	}
	return usage, nil
}

func (s *Store) AppendEvent(runID string, seq int64, typ string, payload any) error {
	b, _ := json.Marshal(payload)
	_, err := s.db.Exec(`INSERT INTO ai_events(run_id,seq,type,payload_json,created_at) VALUES(?,?,?,?,?)`,
		runID, seq, typ, string(b), nowMS())
	return err
}

func (s *Store) ListEvents(runID string, afterSeq int64) ([]struct {
	Seq     int64
	Type    string
	Payload json.RawMessage
}, error) {
	rows, err := s.db.Query(`SELECT seq,type,payload_json FROM ai_events WHERE run_id=? AND seq>? ORDER BY seq ASC`, runID, afterSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct {
		Seq     int64
		Type    string
		Payload json.RawMessage
	}
	for rows.Next() {
		var seq int64
		var typ, payload string
		if err := rows.Scan(&seq, &typ, &payload); err != nil {
			return nil, err
		}
		out = append(out, struct {
			Seq     int64
			Type    string
			Payload json.RawMessage
		}{seq, typ, json.RawMessage(payload)})
	}
	return out, rows.Err()
}

// IncrQuota increments a bucket counter for the current window. windowSec e.g. 3600/86400.
func (s *Store) IncrQuota(userID, bucket string, windowSec int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().Unix()
	windowStart := now - (now % windowSec)
	var count int
	var ws int64
	err := s.db.QueryRow(`SELECT count, window_start FROM ai_quota WHERE user_id=? AND bucket=?`, userID, bucket).Scan(&count, &ws)
	if err == sql.ErrNoRows {
		_, err = s.db.Exec(`INSERT INTO ai_quota(user_id,bucket,count,window_start) VALUES(?,?,1,?)`, userID, bucket, windowStart)
		return 1, err
	}
	if err != nil {
		return 0, err
	}
	if ws != windowStart {
		_, err = s.db.Exec(`UPDATE ai_quota SET count=1, window_start=? WHERE user_id=? AND bucket=?`, windowStart, userID, bucket)
		return 1, err
	}
	count++
	_, err = s.db.Exec(`UPDATE ai_quota SET count=? WHERE user_id=? AND bucket=?`, count, userID, bucket)
	return count, err
}

func (s *Store) AddGrant(userID, sessionID, rule, scope string, ttlSec int64) error {
	exp := int64(0)
	if ttlSec > 0 {
		exp = time.Now().Unix() + ttlSec
	}
	_, err := s.db.Exec(`INSERT INTO ai_permission_grants(user_id,session_id,rule,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)`,
		userID, sessionID, rule, scope, time.Now().Unix(), exp)
	return err
}

func (s *Store) ListGrants(userID, sessionID string) ([]string, error) {
	now := time.Now().Unix()
	rows, err := s.db.Query(`SELECT rule FROM ai_permission_grants WHERE user_id=? AND (expires_at=0 OR expires_at>?) AND (scope='user' OR (scope='session' AND session_id=?))`,
		userID, now, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func newID(prefix string) string {
	return fmt.Sprintf("%s_%d_%s", prefix, time.Now().UnixNano(), randHex(6))
}

func randHex(n int) string {
	const hex = "0123456789abcdef"
	b := make([]byte, n)
	// cheap uniqueness; crypto not required for ids alongside timestamp
	x := time.Now().UnixNano()
	for i := 0; i < n; i++ {
		b[i] = hex[(x>>uint(i*4))&15]
		x = x*1103515245 + 12345
	}
	return string(b)
}

// ValidateUserSession ensures session belongs to user.
func (s *Store) ValidateUserSession(userID, sessionID string, generation ...string) error {
	var uid, databaseGeneration string
	err := s.db.QueryRow(`SELECT user_id,database_generation FROM ai_sessions WHERE session_id=?`, sessionID).Scan(&uid, &databaseGeneration)
	if err != nil {
		return fmt.Errorf("session_not_found")
	}
	if uid != userID {
		return fmt.Errorf("session_forbidden")
	}
	if len(generation) > 0 && databaseGeneration != generation[0] {
		return fmt.Errorf("session_generation_expired")
	}
	return nil
}

func NormalizeMode(m string) string {
	switch strings.ToLower(strings.TrimSpace(m)) {
	case "plan":
		return "plan"
	case "goal":
		return "goal"
	default:
		return "standard"
	}
}
