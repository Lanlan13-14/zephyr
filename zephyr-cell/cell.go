package cell

import (
	"context"
	"io"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
)

// Cell is an opaque handle to a running sandboxed Linux environment (§6.1).
// A Cell is created by Spawn and must be killed when no longer needed.
//
// Execution semantics (§6.2):
//   - Same-cell Exec calls are serialized (internal mutex). For concurrency,
//     spawn multiple cells.
//   - Persistent shell: command runs in a long-lived shell; cwd/env persist
//     across calls.
//   - Guardrails: 10min wall-clock, 100KB output truncation, 30min idle pause.
//   - Error is data: structured errors, never raw exceptions.
//   - Audit: all exec/offload/network actions are append-only logged.
//   - Web disconnect ≠ session death: Cell-Server preserves the session for
//     reconnection (default 10min).
type Cell struct {
	id       string
	session  string
	template Template
	engine   engine.Engine
	caps     CapabilitySet
	created  time.Time
}

// Option configures a Cell at spawn time.
type Option func(*spawnConfig)

type spawnConfig struct {
	sessionID string
	endpoint  string // Web/Cell-Server: wss:// endpoint
	token     string // Web/Cell-Server: bearer token
}

// WithSessionID sets a specific session ID. If empty, a UUID is generated.
func WithSessionID(id string) Option {
	return func(c *spawnConfig) { c.sessionID = id }
}

// WithEndpoint sets the remote Cell-Server endpoint (Web deployments).
func WithEndpoint(url string) Option {
	return func(c *spawnConfig) { c.endpoint = url }
}

// WithToken sets the bearer token for Cell-Server authentication.
func WithToken(token string) Option {
	return func(c *spawnConfig) { c.token = token }
}

// Spawn creates a new Cell from the given template (§6.1).
// The engine is selected automatically based on host platform and capabilities.
// Returns ENGINE_UNAVAILABLE if no suitable engine can start.
//
// This is the SDK entry point. The ctx governs the spawn operation itself;
// the cell lives until Kill() is called or idle timeout expires.
func Spawn(ctx context.Context, tpl Template, opts ...Option) (*Cell, error) {
	// Engine selection and boot are deferred to engine.Registry (§4.1).
	// This stub establishes the API contract; wiring is not handled here.
	_ = ctx
	_ = tpl
	_ = opts
	return nil, ErrEngineUnavailable
}

// ID returns the cell's unique identifier.
func (c *Cell) ID() string { return c.id }

// SessionID returns the ZEPHYR_SESSION_ID for this cell.
func (c *Cell) SessionID() string { return c.session }

// Exec runs a command in the cell and returns the result (§6.1).
// Commands are serialized within the same cell.
func (c *Cell) Exec(ctx context.Context, cmd string, opts ...ExecOption) (*ExecResult, error) {
	_ = ctx
	_ = cmd
	_ = opts
	return nil, ErrEngineUnsupported
}

// ExecStream runs a command with line-by-line streaming output (§6.1).
// The onLine callback is invoked for each output line; the final ExecResult
// is returned when the command completes.
func (c *Cell) ExecStream(ctx context.Context, cmd string, onLine func(StreamLine)) (*ExecResult, error) {
	_ = ctx
	_ = cmd
	_ = onLine
	return nil, ErrEngineUnsupported
}

// PTY opens an interactive terminal session (§6.1).
// Requires CapPTY capability.
func (c *Cell) PTY(rows, cols int) (*PTYSession, error) {
	if !c.caps.Has(CapPTY) {
		return nil, ErrEngineUnsupported
	}
	_ = rows
	_ = cols
	return nil, ErrEngineUnsupported
}

// WriteFile writes content to a guest path (§6.1).
// The path must be under a writable bind mount (/cell/workspace, /cell/tmp, etc.).
func (c *Cell) WriteFile(guestPath string, r io.Reader) error {
	_ = guestPath
	_ = r
	return ErrEngineUnsupported
}

// ReadFile reads a file from the guest filesystem (§6.1).
// The caller must close the returned ReadCloser.
func (c *Cell) ReadFile(guestPath string) (io.ReadCloser, error) {
	_ = guestPath
	return nil, ErrEngineUnsupported
}

// ListDir lists the contents of a guest directory (§6.1).
func (c *Cell) ListDir(guestPath string) ([]FileInfo, error) {
	_ = guestPath
	return nil, ErrEngineUnsupported
}

// InstallPackage installs packages via apk in the guest (§3.1).
// The package manager is always apk across all six platforms.
func (c *Cell) InstallPackage(pkgs ...string) error {
	_ = pkgs
	return ErrEngineUnsupported
}

// Snapshot creates a memory snapshot of the cell (§6.1).
// Only available on engines with CapSnapshot (currently CellVM).
func (c *Cell) Snapshot() (SnapshotID, error) {
	if !c.caps.Has(CapSnapshot) {
		return "", ErrEngineUnsupported
	}
	return "", ErrEngineUnsupported
}

// Restore restores a cell from a previously taken snapshot.
func (c *Cell) Restore(id SnapshotID) error {
	if !c.caps.Has(CapSnapshot) {
		return ErrEngineUnsupported
	}
	_ = id
	return ErrEngineUnsupported
}

// Metrics returns current resource usage statistics (§8.2).
func (c *Cell) Metrics() (*Metrics, error) {
	return nil, ErrEngineUnsupported
}

// Capabilities returns the engine capability bitmask (§2.3).
// Upper layers branch on capabilities, never on platform names.
func (c *Cell) Capabilities() CapabilitySet {
	return c.caps
}

// AuditLog returns audit entries since the given time (§8.3).
// Audit is append-only and physically unreachable from the guest.
func (c *Cell) AuditLog(since time.Time) ([]AuditEntry, error) {
	_ = since
	return nil, ErrEngineUnsupported
}

// Pause suspends the cell, preserving state (§6.1).
// Paused cells consume minimal resources; resume with Resume().
func (c *Cell) Pause() error {
	return ErrEngineUnsupported
}

// Resume resumes a paused cell.
func (c *Cell) Resume() error {
	return ErrEngineUnsupported
}

// Kill terminates the cell and releases all resources (§6.1).
// Kill is idempotent.
func (c *Cell) Kill() error {
	return ErrEngineUnsupported
}

// Preflight requests permissions for the given offloads in advance (§7.3).
// This triggers system/browser permission prompts proactively rather than
// waiting for first use. Denial returns PERMISSION_DENIED per offload.
func (c *Cell) Preflight(offloads []string) map[string]error {
	result := make(map[string]error, len(offloads))
	for _, o := range offloads {
		result[o] = ErrEngineUnsupported
	}
	return result
}
