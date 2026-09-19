package cell

import "fmt"

// Error codes follow structured-error-as-data discipline (§6.2 rule 4):
// structured fields for LLM consumption, never raw exceptions.

// CellError is a structured error with a machine-readable code, a human-
// readable message, and an LLM-readable suggestion.
type CellError struct {
	// Code is the machine-readable error code.
	Code ErrorCode

	// Message is the human-readable description.
	Message string

	// Suggestion is an LLM-readable hint for recovery (may be empty).
	Suggestion string

	// Engine is the engine that produced the error (may be empty).
	Engine string

	// Cause is the underlying error (may be nil).
	Cause error
}

func (e *CellError) Error() string {
	s := fmt.Sprintf("cell: %s: %s", e.Code, e.Message)
	if e.Cause != nil {
		s += ": " + e.Cause.Error()
	}
	return s
}

func (e *CellError) Unwrap() error { return e.Cause }

// ErrorCode is a machine-readable error identifier.
type ErrorCode string

const (
	// ErrCodeEngineUnsupported: the requested operation is not supported by
	// the current engine. Check Capabilities().
	ErrCodeEngineUnsupported ErrorCode = "ENGINE_UNSUPPORTED"

	// ErrCodeEngineUnavailable: the engine could not start (e.g., user
	// namespaces disabled, WSL2 not installed, Docker not running).
	ErrCodeEngineUnavailable ErrorCode = "ENGINE_UNAVAILABLE"

	// ErrCodeTimeout: exec exceeded WallClock limit.
	ErrCodeTimeout ErrorCode = "TIMEOUT"

	// ErrCodeOutputTruncated: output exceeded MaxOutputKB; excess in outbox.
	ErrCodeOutputTruncated ErrorCode = "OUTPUT_TRUNCATED"

	// ErrCodeRootfsCorrupt: rootfs layer failed integrity verification.
	ErrCodeRootfsCorrupt ErrorCode = "ROOTFS_CORRUPT"

	// ErrCodeRootfsMismatch: rootfs architecture does not match host.
	ErrCodeRootfsMismatch ErrorCode = "ROOTFS_MISMATCH"

	// ErrCodeSessionNotFound: the referenced session does not exist.
	ErrCodeSessionNotFound ErrorCode = "SESSION_NOT_FOUND"

	// ErrCodeSessionDead: the persistent shell died and was rebuilt.
	ErrCodeSessionDead ErrorCode = "SESSION_DEAD"

	// ErrCodeQuotaExceeded: a resource quota was exceeded (CPU/memory/disk/
	// procs/sessions).
	ErrCodeQuotaExceeded ErrorCode = "QUOTA_EXCEEDED"

	// ErrCodePermissionDenied: an offload call was denied by the user or
	// system (exit code 125).
	ErrCodePermissionDenied ErrorCode = "PERMISSION_DENIED"

	// ErrCodeOffloadUnavailable: the requested offload is not available on
	// this platform (exit code 126).
	ErrCodeOffloadUnavailable ErrorCode = "OFFLOAD_UNAVAILABLE"

	// ErrCodeOffloadUnknown: unknown zc-* command (exit code 127).
	ErrCodeOffloadUnknown ErrorCode = "OFFLOAD_UNKNOWN"

	// ErrCodeOffloadTimeout: offload handler did not respond within the
	// timeout (exit code 124).
	ErrCodeOffloadTimeout ErrorCode = "OFFLOAD_TIMEOUT"

	// ErrCodeResetFailed: the engine could not restore the sandbox to
	// its template state.
	ErrCodeResetFailed ErrorCode = "RESET_FAILED"

	// ErrCodeTransport: frame protocol or transport-level failure.
	ErrCodeTransport ErrorCode = "TRANSPORT"

	// ErrCodeAuth: authentication/authorization failure (Web/Cell-Server).
	ErrCodeAuth ErrorCode = "AUTH"

	// ErrCodeInternal: unexpected internal error.
	ErrCodeInternal ErrorCode = "INTERNAL"
)

// Sentinel errors for common conditions.
var (
	ErrEngineUnsupported = &CellError{Code: ErrCodeEngineUnsupported, Message: "operation not supported by current engine"}
	ErrEngineUnavailable = &CellError{Code: ErrCodeEngineUnavailable, Message: "engine could not start"}
	ErrSessionNotFound   = &CellError{Code: ErrCodeSessionNotFound, Message: "session not found"}
	ErrQuotaExceeded     = &CellError{Code: ErrCodeQuotaExceeded, Message: "resource quota exceeded"}
	ErrResetFailed       = &CellError{Code: ErrCodeResetFailed, Message: "sandbox reset failed"}
)

// NewError creates a CellError with the given code, message, and optional cause.
func NewError(code ErrorCode, msg string, cause error) *CellError {
	return &CellError{Code: code, Message: msg, Cause: cause}
}

// NewErrorf creates a CellError with a formatted message.
func NewErrorf(code ErrorCode, format string, args ...any) *CellError {
	return &CellError{Code: code, Message: fmt.Sprintf(format, args...)}
}
