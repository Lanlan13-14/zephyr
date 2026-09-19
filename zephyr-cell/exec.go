package cell

import "time"

// ExecResult holds the outcome of a command execution (§6.1).
// Error is data: structured fields for LLM consumption, never raw exceptions.
type ExecResult struct {
	// Stdout is the captured standard output. Truncated at Limits.MaxOutputKB;
	// if truncated, excess is written to /cell/outbox/<uuid>.
	Stdout []byte

	// Stderr is the captured standard error (same truncation rules).
	Stderr []byte

	// ExitCode is the process exit code. Standard offload exit codes:
	// 124=timeout, 125=permission denied, 126=unavailable, 127=unknown.
	ExitCode int

	// Duration is the wall-clock time the command took.
	Duration time.Duration

	// Truncated indicates whether output was truncated due to size limits.
	// When true, full output is available in /cell/outbox/.
	Truncated bool

	// Engine is the engine name that executed this command (for diagnostics).
	Engine string
}

// ExecOption configures a single Exec call.
type ExecOption func(*execConfig)

type execConfig struct {
	persistent bool
	env        map[string]string
	cwd        string
	wallClock  time.Duration
}

// WithPersistentShell runs the command in a persistent shell session.
// The shell process stays alive across calls; cwd and env changes persist.
// Prompt regex detection determines command completion.
func WithPersistentShell() ExecOption {
	return func(c *execConfig) { c.persistent = true }
}

// WithEnv adds or overrides environment variables for this exec call.
func WithEnv(env map[string]string) ExecOption {
	return func(c *execConfig) {
		if c.env == nil {
			c.env = make(map[string]string)
		}
		for k, v := range env {
			c.env[k] = v
		}
	}
}

// WithCwd sets the working directory for this exec call.
func WithCwd(path string) ExecOption {
	return func(c *execConfig) { c.cwd = path }
}

// WithWallClock overrides the wall-clock timeout for this exec call.
func WithWallClock(d time.Duration) ExecOption {
	return func(c *execConfig) { c.wallClock = d }
}

// StreamLine is a line of streaming output from ExecStream.
type StreamLine struct {
	// Stream is "stdout" or "stderr".
	Stream string

	// Data is the line content (without trailing newline).
	Data []byte

	// Seq is the monotonic sequence number within this exec.
	Seq uint64
}
