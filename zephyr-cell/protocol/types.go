package protocol

// FrameType identifies the type of a protocol frame (§6.3).
type FrameType uint8

const (
	// --- Exec lifecycle ---

	// FrameExecReq requests command execution.
	FrameExecReq FrameType = 0x01

	// FrameExecLine is a streaming output line (stdout or stderr).
	FrameExecLine FrameType = 0x02

	// FrameExecResult is the final execution result.
	FrameExecResult FrameType = 0x03

	// --- PTY ---

	// FramePTYIn carries input data to the PTY.
	FramePTYIn FrameType = 0x10

	// FramePTYOut carries output data from the PTY.
	FramePTYOut FrameType = 0x11

	// FramePTYResize requests a PTY resize.
	FramePTYResize FrameType = 0x12

	// FramePTYOpen requests a new PTY session.
	FramePTYOpen FrameType = 0x13

	// FramePTYClose closes a PTY session.
	FramePTYClose FrameType = 0x14

	// --- Filesystem ---

	// FrameFSReq is a filesystem request (read/write/list/stat).
	FrameFSReq FrameType = 0x20

	// FrameFSResp is a filesystem response (may be chunked for large files).
	FrameFSResp FrameType = 0x21

	// FrameFSChunk is a file data chunk (for files exceeding max frame size).
	FrameFSChunk FrameType = 0x22

	// --- Offload ---

	// FrameOffloadReq requests a native offload (zc-*) execution.
	FrameOffloadReq FrameType = 0x30

	// FrameOffloadResp returns the offload result.
	FrameOffloadResp FrameType = 0x31

	// --- Observability ---

	// FrameMetrics carries metrics data.
	FrameMetrics FrameType = 0x40

	// FrameAuditPull requests audit log entries since a timestamp.
	FrameAuditPull FrameType = 0x41

	// FrameAuditData carries audit log entries.
	FrameAuditData FrameType = 0x42

	// --- Session management ---

	// FrameAttach attaches to an existing session (reconnect after disconnect).
	FrameAttach FrameType = 0x50

	// FrameDetach detaches from a session without killing it.
	FrameDetach FrameType = 0x51

	// FrameReset requests resetting a session to its template state.
	FrameReset FrameType = 0x52

	// FrameResetResult returns the result of a reset request.
	FrameResetResult FrameType = 0x53

	// --- Keepalive ---

	// FramePing is a keepalive ping.
	FramePing FrameType = 0xF0

	// FramePong is a keepalive pong.
	FramePong FrameType = 0xF1

	// --- Error ---

	// FrameError carries an error from the engine/server.
	FrameError FrameType = 0xFF
)

// String returns the human-readable name of the frame type.
func (t FrameType) String() string {
	switch t {
	case FrameExecReq:
		return "EXEC_REQ"
	case FrameExecLine:
		return "EXEC_LINE"
	case FrameExecResult:
		return "EXEC_RESULT"
	case FramePTYIn:
		return "PTY_IN"
	case FramePTYOut:
		return "PTY_OUT"
	case FramePTYResize:
		return "PTY_RESIZE"
	case FramePTYOpen:
		return "PTY_OPEN"
	case FramePTYClose:
		return "PTY_CLOSE"
	case FrameFSReq:
		return "FS_REQ"
	case FrameFSResp:
		return "FS_RESP"
	case FrameFSChunk:
		return "FS_CHUNK"
	case FrameOffloadReq:
		return "OFFLOAD_REQ"
	case FrameOffloadResp:
		return "OFFLOAD_RESP"
	case FrameMetrics:
		return "METRICS"
	case FrameAuditPull:
		return "AUDIT_PULL"
	case FrameAuditData:
		return "AUDIT_DATA"
	case FrameAttach:
		return "ATTACH"
	case FrameDetach:
		return "DETACH"
	case FrameReset:
		return "RESET"
	case FrameResetResult:
		return "RESET_RESULT"
	case FramePing:
		return "PING"
	case FramePong:
		return "PONG"
	case FrameError:
		return "ERROR"
	default:
		return "UNKNOWN"
	}
}

// IsValid reports whether the frame type is a known type.
func (t FrameType) IsValid() bool {
	switch t {
	case FrameExecReq, FrameExecLine, FrameExecResult,
		FramePTYIn, FramePTYOut, FramePTYResize, FramePTYOpen, FramePTYClose,
		FrameFSReq, FrameFSResp, FrameFSChunk,
		FrameOffloadReq, FrameOffloadResp,
		FrameMetrics, FrameAuditPull, FrameAuditData,
		FrameAttach, FrameDetach, FrameReset, FrameResetResult,
		FramePing, FramePong,
		FrameError:
		return true
	default:
		return false
	}
}
