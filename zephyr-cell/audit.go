package cell

import "time"

// AuditEntry records a single auditable action in the cell (§6.1, §8.3).
// Audit is append-only, written to host/container-external storage, and
// physically unreachable from the guest.
type AuditEntry struct {
	// TS is the timestamp of the event (UTC).
	TS time.Time `json:"ts"`

	// Session is the session ID (ZEPHYR_SESSION_ID).
	Session string `json:"session"`

	// Kind classifies the event.
	Kind AuditKind `json:"kind"`

	// Cmd is the command that was executed (for exec events).
	Cmd string `json:"cmd,omitempty"`

	// ExitCode is the process exit code (for exec/offload events).
	ExitCode int `json:"exit_code,omitempty"`

	// Duration is the wall-clock time of the operation.
	Duration time.Duration `json:"duration,omitempty"`

	// BytesOut is the total output bytes produced.
	BytesOut int `json:"bytes_out,omitempty"`

	// Offloads lists the zc-* commands invoked during this operation.
	Offloads []string `json:"offloads,omitempty"`

	// NetPeers lists the network peers contacted (IP:port or domain).
	NetPeers []string `json:"net_peers,omitempty"`

	// EnvKeys lists the environment variable NAMES that were set (never
	// values — values are sensitive and must not appear in audit; §3.3).
	EnvKeys []string `json:"env_keys,omitempty"`

	// Engine is the engine that handled this operation.
	Engine string `json:"engine,omitempty"`

	// Error, if non-empty, is the structured error message.
	Error string `json:"error,omitempty"`

	// UserID is the owning user (Web/multi-user deployments; empty for
	// single-user/native).
	UserID string `json:"user_id,omitempty"`
}

// AuditKind classifies an audit event.
type AuditKind string

const (
	// AuditExec records a command execution.
	AuditExec AuditKind = "exec"

	// AuditOffload records a native offload (zc-*) invocation.
	AuditOffload AuditKind = "offload"

	// AuditFileRead records a file read operation.
	AuditFileRead AuditKind = "file_read"

	// AuditFileWrite records a file write operation.
	AuditFileWrite AuditKind = "file_write"

	// AuditNetwork records a network egress connection.
	AuditNetwork AuditKind = "network"

	// AuditPTY records a PTY session lifecycle event (open/close/resize).
	AuditPTY AuditKind = "pty"

	// AuditSnapshot records a snapshot or restore operation.
	AuditSnapshot AuditKind = "snapshot"

	// AuditLifecycle records cell lifecycle events (spawn/pause/resume/kill).
	AuditLifecycle AuditKind = "lifecycle"

	// AuditSeccompFallback records a seccomp fallback retry (Android §4.5.3).
	AuditSeccompFallback AuditKind = "seccomp_fallback"

	// AuditInstall records a package installation (apk/pip/npm).
	AuditInstall AuditKind = "install"
)
