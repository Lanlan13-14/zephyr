// Package quota implements the three-tier rate limiting and resource quota
// system (§8.1), inherited from L2's quota model.
//
// Three levels:
//   - Global: max concurrent executions across all sessions
//   - Per-user: max concurrent executions per user (Web/multi-user)
//   - Per-session: max executions per hour per session
//
// L2 defaults (§2.6): global 4 / user 2 / session 60 per hour.
package quota

import (
	"fmt"
	"sync"
	"time"
)

// Config holds the three-tier quota configuration.
type Config struct {
	// GlobalMaxConcurrent is the max concurrent executions across all sessions.
	GlobalMaxConcurrent int

	// UserMaxConcurrent is the max concurrent executions per user.
	UserMaxConcurrent int

	// SessionMaxPerHour is the max executions per hour per session.
	SessionMaxPerHour int

	// MaxOutputKB is the per-exec output size limit in kilobytes.
	MaxOutputKB int

	// MaxDiskMB is the per-session workspace disk quota in megabytes.
	MaxDiskMB int

	// MaxWebSessionsPerUser is the max concurrent Cell sessions per user (Web).
	MaxWebSessionsPerUser int
}

// DefaultConfig returns the L2-inherited default quota configuration (§2.6).
func DefaultConfig() Config {
	return Config{
		GlobalMaxConcurrent:   4,
		UserMaxConcurrent:     2,
		SessionMaxPerHour:     60,
		MaxOutputKB:           100,
		MaxDiskMB:             1024,
		MaxWebSessionsPerUser: 5,
	}
}

// Manager enforces three-tier quotas.
type Manager struct {
	mu     sync.Mutex
	config Config

	// Global concurrent count
	globalActive int

	// Per-user concurrent count
	userActive map[string]int

	// Per-session hourly count (sliding window)
	sessionExecs map[string][]time.Time

	// Per-user session count (Web)
	userSessions map[string]int
}

// NewManager creates a quota manager with the given config.
func NewManager(cfg Config) *Manager {
	return &Manager{
		config:       cfg,
		userActive:   make(map[string]int),
		sessionExecs: make(map[string][]time.Time),
		userSessions: make(map[string]int),
	}
}

// AcquireExec tries to acquire an execution slot. Returns an error if
// any quota is exceeded.
func (m *Manager) AcquireExec(userID, sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check global concurrent
	if m.config.GlobalMaxConcurrent > 0 && m.globalActive >= m.config.GlobalMaxConcurrent {
		return fmt.Errorf("quota: global concurrent limit reached (%d)", m.config.GlobalMaxConcurrent)
	}

	// Check per-user concurrent
	if m.config.UserMaxConcurrent > 0 && userID != "" {
		if m.userActive[userID] >= m.config.UserMaxConcurrent {
			return fmt.Errorf("quota: user %q concurrent limit reached (%d)", userID, m.config.UserMaxConcurrent)
		}
	}

	// Check per-session hourly rate
	if m.config.SessionMaxPerHour > 0 {
		now := time.Now()
		cutoff := now.Add(-time.Hour)
		events := m.sessionExecs[sessionID]

		// Prune old events
		valid := events[:0]
		for _, t := range events {
			if t.After(cutoff) {
				valid = append(valid, t)
			}
		}

		if len(valid) >= m.config.SessionMaxPerHour {
			m.sessionExecs[sessionID] = valid
			return fmt.Errorf("quota: session %q hourly limit reached (%d/hr)", sessionID, m.config.SessionMaxPerHour)
		}

		m.sessionExecs[sessionID] = append(valid, now)
	}

	// Acquire slots
	m.globalActive++
	if userID != "" {
		m.userActive[userID]++
	}

	return nil
}

// ReleaseExec releases an execution slot.
func (m *Manager) ReleaseExec(userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.globalActive > 0 {
		m.globalActive--
	}
	if userID != "" && m.userActive[userID] > 0 {
		m.userActive[userID]--
	}
}

// AcquireSession tries to acquire a session slot for a user (Web quotas).
func (m *Manager) AcquireSession(userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.config.MaxWebSessionsPerUser > 0 && userID != "" {
		if m.userSessions[userID] >= m.config.MaxWebSessionsPerUser {
			return fmt.Errorf("quota: user %q session limit reached (%d)", userID, m.config.MaxWebSessionsPerUser)
		}
		m.userSessions[userID]++
	}
	return nil
}

// ReleaseSession releases a session slot.
func (m *Manager) ReleaseSession(userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if userID != "" && m.userSessions[userID] > 0 {
		m.userSessions[userID]--
	}
}

// Stats returns current quota usage statistics.
func (m *Manager) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()

	s := Stats{
		GlobalActive: m.globalActive,
		GlobalMax:    m.config.GlobalMaxConcurrent,
		UserActive:   make(map[string]int, len(m.userActive)),
		UserMax:      m.config.UserMaxConcurrent,
	}
	for k, v := range m.userActive {
		s.UserActive[k] = v
	}
	return s
}

// Stats holds current quota usage.
type Stats struct {
	GlobalActive int
	GlobalMax    int
	UserActive   map[string]int
	UserMax      int
}
