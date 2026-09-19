// Package engine defines the Engine interface that every platform-specific
// execution engine must implement (§4.1).
//
// Cell Core calls Engine methods through the same trait/interface; the SDK
// layer hides engine differences behind capability bits (§2.3).
//
// Engines: Direct (Linux), CellVM (macOS ARM), WSL2-bridge (Windows),
// PRoot (Android), Asbestos (iOS), QEMU-user (fallback), Cell-Server (Web).
package engine

import (
	"context"
	"io"
)

// Config is the boot configuration passed to Engine.Boot.
type Config struct {
	// RootfsPath is the host-side path to the rootfs layers directory.
	RootfsPath string

	// DataDir is the host-side path for persistent data (sessions, audit, cache).
	DataDir string

	// CellVersion is the Cell SDK version string.
	CellVersion string
}

// SessionConfig configures a new session within a booted engine.
type SessionConfig struct {
	// SessionID is the unique session identifier (ZEPHYR_SESSION_ID).
	SessionID string

	// Env is the full environment snapshot to inject (§3.3).
	Env map[string]string

	// BindMounts maps guest paths to host paths for bind mounting (§3.2).
	BindMounts map[string]string

	// Limits constrains resource consumption for this session.
	Limits ExecLimits
}

// ExecLimits are the resource limits for a single exec call.
type ExecLimits struct {
	// WallClockSeconds is the maximum wall-clock time in seconds.
	WallClockSeconds int

	// MaxOutputBytes is the maximum output bytes before truncation.
	MaxOutputBytes int

	// MaxProcs is the maximum concurrent process count.
	MaxProcs int
}

// ExecResult is the engine-level execution result.
type ExecResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
	// DurationMs is the wall-clock duration in milliseconds.
	DurationMs int64
	Truncated  bool
}

// StreamLine is a single line of streaming output from the engine.
type StreamLine struct {
	Stream string // "stdout" or "stderr"
	Data   []byte
	Seq    uint64
}

// PTYHandle represents an engine-level PTY session.
type PTYHandle struct {
	ID     string
	Reader io.Reader
	Writer io.Writer
	Close  func() error
	Resize func(rows, cols int) error
}

// Engine is the interface that every platform-specific execution engine must
// implement (§4.1). Unimplemented primitives must return ErrUnsupported.
type Engine interface {
	// Name returns the engine identifier (direct, cellvm, wsl2, proot,
	// asbestos, qemu, cellserver).
	Name() string

	// Boot initializes the engine with the given configuration.
	// Called once; subsequent calls are no-ops or return an error.
	Boot(ctx context.Context, cfg Config) error

	// SpawnSession creates a new isolated session within the engine.
	SpawnSession(ctx context.Context, cfg SessionConfig) error

	// Exec runs a command in the given session, returning the result.
	Exec(ctx context.Context, sessionID string, cmd string, limits ExecLimits) (*ExecResult, error)

	// ExecStream runs a command with line-by-line streaming output.
	ExecStream(ctx context.Context, sessionID string, cmd string, limits ExecLimits, onLine func(StreamLine)) (*ExecResult, error)

	// SpawnPTY opens an interactive PTY in the given session.
	SpawnPTY(ctx context.Context, sessionID string, rows, cols int) (*PTYHandle, error)

	// Signal sends a signal to the given session's process group.
	Signal(ctx context.Context, sessionID string, sig int) error

	// Mount performs a dynamic bind mount in the given session.
	Mount(ctx context.Context, sessionID string, guestPath, hostPath string) error

	// Unmount removes a bind mount from the given session.
	Unmount(ctx context.Context, sessionID string, guestPath string) error

	// InterceptExecve registers an offload interception point for the
	// given guest binary path.
	InterceptExecve(ctx context.Context, path string) error

	// Teardown destroys a session and reclaims all resources.
	Teardown(ctx context.Context, sessionID string) error

	// Shutdown gracefully shuts down the entire engine.
	Shutdown(ctx context.Context) error
}

// ErrUnsupported is returned by Engine methods that are not implemented.
// This maps to ENGINE_UNSUPPORTED in the SDK error model.
var ErrUnsupported = &EngineError{Code: "ENGINE_UNSUPPORTED", Message: "not supported by this engine"}

// EngineError is a structured engine-level error.
type EngineError struct {
	Code    string
	Message string
	Cause   error
}

func (e *EngineError) Error() string {
	s := "engine: " + e.Code + ": " + e.Message
	if e.Cause != nil {
		s += ": " + e.Cause.Error()
	}
	return s
}

func (e *EngineError) Unwrap() error { return e.Cause }
