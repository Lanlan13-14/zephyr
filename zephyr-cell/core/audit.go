package core

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
)

// MemoryAuditStore is an in-memory audit store for testing and single-process
// deployments. Production deployments should use a persistent store (file-backed
// NDJSON or database).
//
// The store is append-only (§8.3) and segmented by session.
type MemoryAuditStore struct {
	mu        sync.RWMutex
	entries   []cell.AuditEntry
	bySession map[string][]int // session_id → indices into entries
}

// NewMemoryAuditStore creates a new in-memory audit store.
func NewMemoryAuditStore() *MemoryAuditStore {
	return &MemoryAuditStore{
		bySession: make(map[string][]int),
	}
}

// Record appends an audit entry (implements AuditSink).
func (s *MemoryAuditStore) Record(entry cell.AuditEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := len(s.entries)
	s.entries = append(s.entries, entry)
	s.bySession[entry.Session] = append(s.bySession[entry.Session], idx)
}

// Query returns audit entries matching the given filters.
func (s *MemoryAuditStore) Query(sessionID string, since time.Time, limit int) []cell.AuditEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []cell.AuditEntry

	if sessionID != "" {
		// Query by session
		indices, ok := s.bySession[sessionID]
		if !ok {
			return nil
		}
		for _, idx := range indices {
			entry := s.entries[idx]
			if !entry.TS.Before(since) {
				result = append(result, entry)
				if limit > 0 && len(result) >= limit {
					break
				}
			}
		}
	} else {
		// Query all
		for _, entry := range s.entries {
			if !entry.TS.Before(since) {
				result = append(result, entry)
				if limit > 0 && len(result) >= limit {
					break
				}
			}
		}
	}

	return result
}

// SessionIDs returns all session IDs that have audit entries.
func (s *MemoryAuditStore) SessionIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ids := make([]string, 0, len(s.bySession))
	for id := range s.bySession {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Count returns the total number of audit entries.
func (s *MemoryAuditStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries)
}

// Export returns all entries for a session as NDJSON (one JSON object per line).
// This is the format used for audit export and L2 migration dual-write (§2.6).
func (s *MemoryAuditStore) Export(sessionID string) ([]byte, error) {
	entries := s.Query(sessionID, time.Time{}, 0)
	var result []byte
	for _, entry := range entries {
		line, err := json.Marshal(entry)
		if err != nil {
			return nil, fmt.Errorf("audit: marshal error: %w", err)
		}
		result = append(result, line...)
		result = append(result, '\n')
	}
	return result, nil
}

// CrashScene captures the diagnostic information preserved when an engine
// or session crashes (§8.3).
type CrashScene struct {
	// Timestamp of the crash
	TS time.Time `json:"ts"`

	// SessionID that crashed
	SessionID string `json:"session_id"`

	// Engine that was running
	Engine string `json:"engine"`

	// RecentCommands are the last N commands executed before the crash
	RecentCommands []string `json:"recent_commands"`

	// RootfsVersion is the rootfs layer versions at crash time
	RootfsVersion string `json:"rootfs_version"`

	// Error is the crash error message
	Error string `json:"error"`

	// ProcessCount is the number of guest processes at crash time
	ProcessCount int `json:"process_count,omitempty"`
}

// CaptureCrashScene creates a crash diagnostic snapshot.
func CaptureCrashScene(sessionID, engineName, rootfsVer string, recentCmds []string, err error) CrashScene {
	scene := CrashScene{
		TS:             time.Now(),
		SessionID:      sessionID,
		Engine:         engineName,
		RecentCommands: recentCmds,
		RootfsVersion:  rootfsVer,
	}
	if err != nil {
		scene.Error = err.Error()
	}
	return scene
}
