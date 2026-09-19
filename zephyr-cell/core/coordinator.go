// Package core implements the Cell Core session coordinator (L3 in the
// architecture stack). It manages cell lifecycles, serializes per-session
// execution, enforces quotas and guardrails, records audit events, and
// routes operations to the appropriate engine.
//
// Key responsibilities (§6.2):
//   - Per-cell mutex: same-cell Exec calls are serialized
//   - Persistent shell lifecycle: auto-rebuild on death, env snapshot
//   - Wall-clock enforcement: SIGTERM → 5s grace → SIGKILL
//   - Output truncation: excess to /cell/outbox/<uuid>
//   - Idle timeout: auto-pause after configured duration
//   - Audit: all exec/offload/network events logged append-only
//   - Web disconnect ≠ session death: preserve for reconnection
package core

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
	"github.com/google/uuid"
)

// Session represents a single Cell session managed by the coordinator.
// Each session has its own mutex (§4.5.2: per-session mutex, not global FIFO).
type Session struct {
	mu sync.Mutex // per-session serialization (§6.2 rule 1)

	ID        string
	CellID    string
	Template  cell.Template
	Engine    engine.Engine
	Caps      cell.CapabilitySet
	CreatedAt time.Time

	// Persistent shell state
	shellAlive  atomic.Bool
	shellGeneration atomic.Uint64

	// Idle tracking
	lastActivity atomic.Int64 // unix nanos
	paused       atomic.Bool

	// Lifecycle
	killed atomic.Bool

	// Audit sink
	auditSink AuditSink

	// Quota tracker
	quota *QuotaTracker
}

// AuditSink is the interface for audit event recording.
// Implementations must be append-only and goroutine-safe.
type AuditSink interface {
	// Record appends an audit entry. Must not block indefinitely.
	Record(entry cell.AuditEntry)
}

// QuotaTracker tracks resource usage against limits.
type QuotaTracker struct {
	mu    sync.Mutex
	limits cell.Limits

	execCount      int64
	totalOutputKB  int64
	totalDuration  time.Duration
}

// NewQuotaTracker creates a quota tracker with the given limits.
func NewQuotaTracker(limits cell.Limits) *QuotaTracker {
	return &QuotaTracker{limits: limits}
}

// RecordExec records an execution's resource usage.
func (q *QuotaTracker) RecordExec(outputBytes int, duration time.Duration) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.execCount++
	q.totalOutputKB += int64(outputBytes) / 1024
	q.totalDuration += duration
}

// CheckOutput checks if the given output size exceeds the per-exec limit.
// Returns the allowed size and whether truncation is needed.
func (q *QuotaTracker) CheckOutput(sizeBytes int) (allowed int, truncated bool) {
	maxBytes := q.limits.MaxOutputKB * 1024
	if maxBytes <= 0 {
		maxBytes = 100 * 1024 // default 100KB
	}
	if sizeBytes <= maxBytes {
		return sizeBytes, false
	}
	return maxBytes, true
}

// Coordinator manages all active Cell sessions.
type Coordinator struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	eng      engine.Engine
	caps     cell.CapabilitySet
	version  string
	audit    AuditSink

	// Global rate limiter (§8.1: L2 inherited 3-tier quotas)
	globalRate *RateLimiter
}

// NewCoordinator creates a new session coordinator.
func NewCoordinator(eng engine.Engine, caps cell.CapabilitySet, version string, audit AuditSink) *Coordinator {
	return &Coordinator{
		sessions:   make(map[string]*Session),
		eng:        eng,
		caps:       caps,
		version:    version,
		audit:      audit,
		globalRate: NewRateLimiter(4, time.Hour), // L2 default: 4 global per hour
	}
}

// SpawnSession creates a new session. If sessionID is empty, a UUID is generated.
func (c *Coordinator) SpawnSession(ctx context.Context, tpl cell.Template, sessionID string) (*Session, error) {
	if c.eng == nil {
		return nil, cell.ErrEngineUnavailable
	}

	if sessionID == "" {
		sessionID = uuid.New().String()
	}

	c.mu.Lock()
	if _, exists := c.sessions[sessionID]; exists {
		c.mu.Unlock()
		return nil, cell.NewErrorf(cell.ErrCodeInternal, "session %s already exists", sessionID)
	}
	c.mu.Unlock()

	limits := tpl.Limits
	if limits.MaxOutputKB == 0 {
		limits = cell.DefaultLimits()
	}

	// Build engine session config
	env := cell.DefaultEnv(sessionID, c.eng.Name(), c.version)
	// Merge template env overrides
	for k, v := range tpl.Env {
		env[k] = v
	}

	sCfg := engine.SessionConfig{
		SessionID: sessionID,
		Env:       env,
		BindMounts: map[string]string{
			cell.GuestWorkspace:    "", // host path resolved by engine
			cell.GuestInbox:        "",
			cell.GuestOutbox:       "",
			cell.GuestTmp:          "",
			cell.GuestSharedMemory: "",
			cell.GuestSharedSkills: "",
			cell.GuestSharedCache:  "",
		},
		Limits: engine.ExecLimits{
			WallClockSeconds: int(limits.WallClock.Seconds()),
			MaxOutputBytes:   limits.MaxOutputKB * 1024,
			MaxProcs:         limits.MaxProcs,
		},
	}

	if err := c.eng.SpawnSession(ctx, sCfg); err != nil {
		return nil, cell.NewError(cell.ErrCodeEngineUnavailable, "failed to spawn session", err)
	}

	sess := &Session{
		ID:        sessionID,
		CellID:    uuid.New().String(),
		Template:  tpl,
		Engine:    c.eng,
		Caps:      c.caps,
		CreatedAt: time.Now(),
		auditSink: c.audit,
		quota:     NewQuotaTracker(limits),
	}
	sess.touchActivity()

	c.mu.Lock()
	c.sessions[sessionID] = sess
	c.mu.Unlock()

	// Record lifecycle audit
	if c.audit != nil {
		c.audit.Record(cell.AuditEntry{
			TS:      time.Now(),
			Session: sessionID,
			Kind:    cell.AuditLifecycle,
			Cmd:     "spawn",
			Engine:  c.eng.Name(),
			EnvKeys: cell.EnvKeys(),
		})
	}

	return sess, nil
}

// GetSession returns a session by ID, or nil if not found.
func (c *Coordinator) GetSession(id string) *Session {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessions[id]
}

// KillSession terminates a session and releases resources (idempotent).
func (c *Coordinator) KillSession(ctx context.Context, sessionID string) error {
	c.mu.Lock()
	sess, ok := c.sessions[sessionID]
	if !ok {
		c.mu.Unlock()
		return cell.ErrSessionNotFound
	}
	delete(c.sessions, sessionID)
	c.mu.Unlock()

	sess.killed.Store(true)

	if c.audit != nil {
		c.audit.Record(cell.AuditEntry{
			TS:      time.Now(),
			Session: sessionID,
			Kind:    cell.AuditLifecycle,
			Cmd:     "kill",
			Engine:  c.eng.Name(),
		})
	}

	return c.eng.Teardown(ctx, sessionID)
}

// ActiveSessions returns the count of active sessions.
func (c *Coordinator) ActiveSessions() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.sessions)
}

// SessionIDs returns all active session IDs.
func (c *Coordinator) SessionIDs() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	ids := make([]string, 0, len(c.sessions))
	for id := range c.sessions {
		ids = append(ids, id)
	}
	return ids
}

// touchActivity updates the last activity timestamp.
func (s *Session) touchActivity() {
	s.lastActivity.Store(time.Now().UnixNano())
}

// LastActivity returns the time of last activity.
func (s *Session) LastActivity() time.Time {
	return time.Unix(0, s.lastActivity.Load())
}

// IdleDuration returns how long the session has been idle.
func (s *Session) IdleDuration() time.Duration {
	return time.Since(s.LastActivity())
}

// IsKilled reports whether the session has been terminated.
func (s *Session) IsKilled() bool {
	return s.killed.Load()
}

// Exec runs a command in this session with per-session serialization (§6.2 rule 1).
func (s *Session) Exec(ctx context.Context, cmd string, limits engine.ExecLimits) (*engine.ExecResult, error) {
	if s.IsKilled() {
		return nil, cell.NewError(cell.ErrCodeSessionDead, "session has been killed", nil)
	}

	// Per-session mutex: same-cell Exec calls serialized (§6.2 rule 1)
	s.mu.Lock()
	defer s.mu.Unlock()

	s.touchActivity()

	start := time.Now()

	// Wall-clock enforcement via context deadline
	wallClock := time.Duration(limits.WallClockSeconds) * time.Second
	if wallClock <= 0 {
		wallClock = s.Template.Limits.WallClock
	}
	if wallClock <= 0 {
		wallClock = 10 * time.Minute
	}

	execCtx, cancel := context.WithTimeout(ctx, wallClock)
	defer cancel()

	result, err := s.Engine.Exec(execCtx, s.ID, cmd, limits)
	duration := time.Since(start)

	// Record quota
	if result != nil {
		s.quota.RecordExec(len(result.Stdout)+len(result.Stderr), duration)
	}

	// Record audit
	if s.auditSink != nil {
		entry := cell.AuditEntry{
			TS:       time.Now(),
			Session:  s.ID,
			Kind:     cell.AuditExec,
			Cmd:      cmd,
			Duration: duration,
			Engine:   s.Engine.Name(),
		}
		if result != nil {
			entry.ExitCode = result.ExitCode
			entry.BytesOut = len(result.Stdout) + len(result.Stderr)
		}
		if err != nil {
			entry.Error = err.Error()
		}
		s.auditSink.Record(entry)
	}

	// Handle output truncation
	if result != nil {
		allowed, truncated := s.quota.CheckOutput(len(result.Stdout))
		if truncated {
			result.Stdout = result.Stdout[:allowed]
			result.Truncated = true
		}
		allowed, truncated = s.quota.CheckOutput(len(result.Stderr))
		if truncated {
			result.Stderr = result.Stderr[:allowed]
			result.Truncated = true
		}
	}

	return result, err
}

// RateLimiter implements a sliding-window rate limiter.
type RateLimiter struct {
	mu       sync.Mutex
	maxCount int
	window   time.Duration
	events   []time.Time
}

// NewRateLimiter creates a rate limiter with the given max count per window.
func NewRateLimiter(maxCount int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		maxCount: maxCount,
		window:   window,
		events:   make([]time.Time, 0, maxCount),
	}
}

// Allow checks if an event is allowed. If yes, records it and returns true.
func (r *RateLimiter) Allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-r.window)

	// Prune old events
	valid := r.events[:0]
	for _, t := range r.events {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	r.events = valid

	if len(r.events) >= r.maxCount {
		return false
	}

	r.events = append(r.events, now)
	return true
}

// Count returns the number of events in the current window.
func (r *RateLimiter) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	cutoff := time.Now().Add(-r.window)
	count := 0
	for _, t := range r.events {
		if t.After(cutoff) {
			count++
		}
	}
	return count
}

// RunIdleReaper periodically checks for idle sessions and pauses them (§6.2 rule 3).
// Runs until ctx is canceled.
func (c *Coordinator) RunIdleReaper(ctx context.Context, checkInterval time.Duration) {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.reapIdleSessions()
		}
	}
}

func (c *Coordinator) reapIdleSessions() {
	c.mu.RLock()
	var toReap []string
	for id, sess := range c.sessions {
		if sess.paused.Load() {
			continue
		}
		idle := sess.IdleDuration()
		if idle > sess.Template.Limits.IdleTimeout && sess.Template.Limits.IdleTimeout > 0 {
			toReap = append(toReap, id)
		}
	}
	c.mu.RUnlock()

	for _, id := range toReap {
		sess := c.GetSession(id)
		if sess != nil && !sess.paused.Load() {
			sess.paused.Store(true)
			if c.audit != nil {
				c.audit.Record(cell.AuditEntry{
					TS:      time.Now(),
					Session: id,
					Kind:    cell.AuditLifecycle,
					Cmd:     fmt.Sprintf("idle_pause (idle %s)", sess.IdleDuration().Round(time.Second)),
					Engine:  c.eng.Name(),
				})
			}
		}
	}
}
