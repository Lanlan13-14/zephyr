// Package archive persists compacted conversation fragments for on-demand
// retrieval via the history_search tool. Never stores provider API keys.
package archive

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

type Store struct {
	db *sql.DB
}

type Entry struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	UserID    string `json:"userId"`
	RunID     string `json:"runId,omitempty"`
	Kind      string `json:"kind"` // tool_snip | tool_prune | fold | file_snapshot
	Role      string `json:"role,omitempty"`
	Name      string `json:"name,omitempty"`
	ToolCallID string `json:"toolCallId,omitempty"`
	Content   string `json:"content"`
	MetaJSON  string `json:"meta,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

type Hit struct {
	Entry
	Score float64 `json:"score"`
	Snippet string `json:"snippet"`
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "archive.sqlite")
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if _, err := db.Exec(`
CREATE TABLE IF NOT EXISTS archive_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arch_session ON archive_entries(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arch_user ON archive_entries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arch_kind ON archive_entries(kind, session_id);
`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Put(e Entry) (string, error) {
	if s == nil {
		return "", fmt.Errorf("archive closed")
	}
	if e.ID == "" {
		e.ID = fmt.Sprintf("arc_%d_%s", time.Now().UnixNano(), shortRand())
	}
	if e.CreatedAt == 0 {
		e.CreatedAt = time.Now().UnixMilli()
	}
	// Cap single entry size (4 MiB text)
	if len(e.Content) > 4<<20 {
		e.Content = e.Content[:4<<20] + "…[truncated]"
	}
	_, err := s.db.Exec(`INSERT INTO archive_entries(id,session_id,user_id,run_id,kind,role,name,tool_call_id,content,meta_json,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.SessionID, e.UserID, e.RunID, e.Kind, e.Role, e.Name, e.ToolCallID, e.Content, e.MetaJSON, e.CreatedAt)
	return e.ID, err
}

// PutMessages archives a slice of messages (used when folding old history).
func (s *Store) PutMessages(userID, sessionID, runID, kind string, msgs []provider.Message) ([]string, error) {
	var ids []string
	for _, m := range msgs {
		content := m.Content
		if content == "" && len(m.ToolCalls) > 0 {
			b, _ := json.Marshal(m.ToolCalls)
			content = string(b)
		}
		id, err := s.Put(Entry{
			SessionID:  sessionID,
			UserID:     userID,
			RunID:      runID,
			Kind:       kind,
			Role:       string(m.Role),
			Name:       m.Name,
			ToolCallID: m.ToolCallID,
			Content:    content,
		})
		if err != nil {
			return ids, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// Search does a simple multi-term substring rank over archive content.
// scope session|user (default session).
func (s *Store) Search(userID, sessionID, query string, scope string, limit int) ([]Hit, error) {
	if s == nil {
		return nil, fmt.Errorf("archive closed")
	}
	if limit <= 0 || limit > 50 {
		limit = 12
	}
	terms := tokenize(query)
	if len(terms) == 0 {
		return nil, nil
	}
	var rows *sql.Rows
	var err error
	if scope == "user" || scope == "global" {
		rows, err = s.db.Query(`SELECT id,session_id,user_id,run_id,kind,role,name,tool_call_id,content,meta_json,created_at
FROM archive_entries WHERE user_id=? ORDER BY created_at DESC LIMIT 800`, userID)
	} else {
		rows, err = s.db.Query(`SELECT id,session_id,user_id,run_id,kind,role,name,tool_call_id,content,meta_json,created_at
FROM archive_entries WHERE user_id=? AND session_id=? ORDER BY created_at DESC LIMIT 800`, userID, sessionID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []Hit
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.SessionID, &e.UserID, &e.RunID, &e.Kind, &e.Role, &e.Name, &e.ToolCallID, &e.Content, &e.MetaJSON, &e.CreatedAt); err != nil {
			return nil, err
		}
		score, snip := scoreEntry(e.Content, terms)
		if score <= 0 {
			continue
		}
		hits = append(hits, Hit{Entry: e, Score: score, Snippet: snip})
	}
	// simple selection sort top-N by score
	for i := 0; i < len(hits); i++ {
		best := i
		for j := i + 1; j < len(hits); j++ {
			if hits[j].Score > hits[best].Score {
				best = j
			}
		}
		hits[i], hits[best] = hits[best], hits[i]
	}
	if len(hits) > limit {
		hits = hits[:limit]
	}
	// strip full content in list results (caller can Get)
	for i := range hits {
		if utf8.RuneCountInString(hits[i].Content) > 400 {
			// keep snippet only in response payload later
		}
	}
	return hits, rows.Err()
}

func (s *Store) Get(userID, id string) (*Entry, error) {
	row := s.db.QueryRow(`SELECT id,session_id,user_id,run_id,kind,role,name,tool_call_id,content,meta_json,created_at
FROM archive_entries WHERE id=? AND user_id=?`, id, userID)
	var e Entry
	if err := row.Scan(&e.ID, &e.SessionID, &e.UserID, &e.RunID, &e.Kind, &e.Role, &e.Name, &e.ToolCallID, &e.Content, &e.MetaJSON, &e.CreatedAt); err != nil {
		return nil, err
	}
	return &e, nil
}

// Around returns entries near a hit by time in the same session.
func (s *Store) Around(userID, sessionID string, aroundMS int64, radius int) ([]Entry, error) {
	if radius <= 0 {
		radius = 5
	}
	rows, err := s.db.Query(`SELECT id,session_id,user_id,run_id,kind,role,name,tool_call_id,content,meta_json,created_at
FROM archive_entries WHERE user_id=? AND session_id=? AND created_at BETWEEN ? AND ?
ORDER BY created_at ASC LIMIT ?`,
		userID, sessionID, aroundMS-int64(radius)*60000, aroundMS+int64(radius)*60000, radius*4)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.SessionID, &e.UserID, &e.RunID, &e.Kind, &e.Role, &e.Name, &e.ToolCallID, &e.Content, &e.MetaJSON, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func tokenize(q string) []string {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return nil
	}
	parts := strings.FieldsFunc(q, func(r rune) bool {
		return r == ' ' || r == ',' || r == ';' || r == '\n' || r == '\t'
	})
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if utf8.RuneCountInString(p) >= 2 {
			out = append(out, p)
		}
	}
	return out
}

func scoreEntry(content string, terms []string) (float64, string) {
	low := strings.ToLower(content)
	var score float64
	var first int = -1
	for _, t := range terms {
		idx := strings.Index(low, t)
		if idx < 0 {
			continue
		}
		score += 1.0
		// rare-ish bonus
		if utf8.RuneCountInString(t) >= 5 {
			score += 0.5
		}
		if first < 0 || idx < first {
			first = idx
		}
	}
	if score <= 0 {
		return 0, ""
	}
	// snippet
	start := first - 80
	if start < 0 {
		start = 0
	}
	end := first + 160
	if end > len(content) {
		end = len(content)
	}
	// byte-safe-ish: clamp to valid runes
	snip := content[start:end]
	if start > 0 {
		snip = "…" + snip
	}
	if end < len(content) {
		snip = snip + "…"
	}
	return score, snip
}

func shortRand() string {
	const hex = "0123456789abcdef"
	x := time.Now().UnixNano()
	b := make([]byte, 6)
	for i := 0; i < 6; i++ {
		b[i] = hex[(x>>uint(i*4))&15]
		x = x*1103515245 + 12345
	}
	return string(b)
}
