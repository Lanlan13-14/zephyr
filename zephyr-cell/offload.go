package cell

// Offload defines the Native Offload envelope format and error codes (§5).

// OffloadResult is the JSON envelope returned by offload handlers (§5.3).
type OffloadResult struct {
	// ExitCode follows standard offload conventions:
	//   0   = success
	//   124 = timeout
	//   125 = permission denied
	//   126 = unavailable on this platform
	//   127 = unknown offload command
	ExitCode int `json:"exit_code"`

	// Stdout is the handler's standard output (truncated at MaxOutputKB).
	Stdout string `json:"stdout"`

	// Stderr is the handler's standard error.
	Stderr string `json:"stderr,omitempty"`

	// Files lists output files written to /cell/outbox/ (for large results).
	Files []OffloadFile `json:"files,omitempty"`

	// Truncated indicates whether stdout was truncated due to size limits.
	Truncated bool `json:"truncated"`
}

// OffloadFile describes a file produced by an offload handler.
type OffloadFile struct {
	// GuestPath is the path within the guest (always under /cell/outbox/).
	GuestPath string `json:"guest_path"`

	// Mime is the MIME type of the file.
	Mime string `json:"mime"`

	// Bytes is the file size in bytes.
	Bytes int64 `json:"bytes"`
}

// Standard offload exit codes (§5.3).
const (
	OffloadExitSuccess         = 0
	OffloadExitTimeout         = 124
	OffloadExitPermissionDenied = 125
	OffloadExitUnavailable     = 126
	OffloadExitUnknown         = 127
)

// OffloadCommands lists all standard zc-* offload commands (§5.2).
// Guest stubs are placed at /usr/local/bin/zc-*.
var OffloadCommands = []string{
	"zc-calendar",
	"zc-contacts",
	"zc-location",
	"zc-notify",
	"zc-clipboard",
	"zc-speak",
	"zc-speech",
	"zc-vision",
	"zc-photos",
	"zc-device",
	"zc-open",
	"zc-weather",
	"zc-alarm",
	"zc-ffmpeg",
}

// OffloadRequest is the wire-protocol request sent from guest to host
// when a zc-* stub is execve'd (§5.1).
type OffloadRequest struct {
	// Command is the zc-* command name (e.g., "zc-calendar").
	Command string `json:"command"`

	// Args is the argument vector (argv[1:]).
	Args []string `json:"args"`

	// Env is the guest environment at execve time (key=value pairs).
	// Sensitive values are NOT included in audit (§3.3).
	Env map[string]string `json:"env,omitempty"`

	// Cwd is the guest working directory at execve time.
	Cwd string `json:"cwd"`

	// SessionID is the ZEPHYR_SESSION_ID for permission scoping.
	SessionID string `json:"session_id"`
}
