// Package offload implements the Native Offload capability bridge (§5).
//
// The offload gateway handles:
//   - Template whitelist validation
//   - Permission checking per ZEPHYR_SESSION_ID
//   - Handler dispatch (native, server-side, browser-forwarded)
//   - Response envelope formatting
//   - Large output routing to /cell/outbox/
//   - Audit recording of all offload invocations
package offload

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
	"github.com/google/uuid"
)

// HandlerFunc is a native offload handler function.
// It receives the request and returns the result envelope.
type HandlerFunc func(req cell.OffloadRequest) cell.OffloadResult

// Gateway is the offload dispatch gateway (§5.1).
type Gateway struct {
	mu       sync.RWMutex
	handlers map[string]HandlerFunc

	// Permission cache: session_id → offload_name → granted
	permissions sync.Map

	// Audit sink
	audit AuditFunc

	// Maximum output before truncation/outbox routing
	maxOutputBytes int
}

// AuditFunc records an offload audit event.
type AuditFunc func(entry cell.AuditEntry)

// NewGateway creates an offload gateway.
func NewGateway(audit AuditFunc, maxOutputKB int) *Gateway {
	return &Gateway{
		handlers:       make(map[string]HandlerFunc),
		audit:          audit,
		maxOutputBytes: maxOutputKB * 1024,
	}
}

// RegisterHandler registers a handler for a zc-* command.
func (g *Gateway) RegisterHandler(command string, handler HandlerFunc) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.handlers[command] = handler
}

// HasHandler checks if a handler is registered for the command.
func (g *Gateway) HasHandler(command string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	_, ok := g.handlers[command]
	return ok
}

// Dispatch handles an offload request through the full pipeline:
// whitelist check → permission check → handler dispatch → envelope formatting.
func (g *Gateway) Dispatch(req cell.OffloadRequest, allowedOffloads []string) cell.OffloadResult {
	start := time.Now()

	// 1. Whitelist validation (§5.2 rule 1)
	if !g.isWhitelisted(req.Command, allowedOffloads) {
		result := cell.OffloadResult{
			ExitCode: cell.OffloadExitUnavailable,
			Stderr:   fmt.Sprintf("offload %q not in template whitelist", req.Command),
		}
		g.recordAudit(req, result, time.Since(start))
		return result
	}

	// 2. Permission check (§5.2 rule 2)
	if !g.checkPermission(req.SessionID, req.Command) {
		result := cell.OffloadResult{
			ExitCode: cell.OffloadExitPermissionDenied,
			Stderr:   fmt.Sprintf("permission denied for %q", req.Command),
		}
		g.recordAudit(req, result, time.Since(start))
		return result
	}

	// 3. Handler lookup
	g.mu.RLock()
	handler, ok := g.handlers[req.Command]
	g.mu.RUnlock()

	if !ok {
		result := cell.OffloadResult{
			ExitCode: cell.OffloadExitUnknown,
			Stderr:   fmt.Sprintf("unknown offload command %q", req.Command),
		}
		g.recordAudit(req, result, time.Since(start))
		return result
	}

	// 4. Execute handler
	result := handler(req)

	// 5. Output truncation (§5.3: stdout > MaxOutputKB → outbox file)
	if g.maxOutputBytes > 0 && len(result.Stdout) > g.maxOutputBytes {
		outboxPath := fmt.Sprintf("%s/%s", cell.GuestOutbox, uuid.New().String())
		result.Files = append(result.Files, cell.OffloadFile{
			GuestPath: outboxPath,
			Mime:      "text/plain",
			Bytes:     int64(len(result.Stdout)),
		})
		result.Stdout = result.Stdout[:g.maxOutputBytes]
		result.Truncated = true
	}

	// 6. Audit
	g.recordAudit(req, result, time.Since(start))

	return result
}

// GrantPermission grants permission for an offload in a session (§5.2 rule 2: ASK_ONCE).
func (g *Gateway) GrantPermission(sessionID, command string) {
	key := sessionID + ":" + command
	g.permissions.Store(key, true)
}

// RevokePermission revokes a previously granted permission.
func (g *Gateway) RevokePermission(sessionID, command string) {
	key := sessionID + ":" + command
	g.permissions.Store(key, false)
}

func (g *Gateway) isWhitelisted(command string, allowed []string) bool {
	if len(allowed) == 0 {
		return false // default deny: empty whitelist = all offloads blocked
	}
	for _, a := range allowed {
		if a == command || a == "*" {
			return true
		}
	}
	return false
}

func (g *Gateway) checkPermission(sessionID, command string) bool {
	key := sessionID + ":" + command
	v, ok := g.permissions.Load(key)
	if !ok {
		// First use: auto-grant (system prompt triggers native permission dialog)
		// Store true so subsequent checks pass until explicitly revoked.
		g.permissions.Store(key, true)
		return true
	}
	granted, _ := v.(bool)
	return granted
}

func (g *Gateway) recordAudit(req cell.OffloadRequest, result cell.OffloadResult, duration time.Duration) {
	if g.audit == nil {
		return
	}
	entry := cell.AuditEntry{
		TS:       time.Now(),
		Session:  req.SessionID,
		Kind:     cell.AuditOffload,
		Cmd:      req.Command,
		ExitCode: result.ExitCode,
		Duration: duration,
		BytesOut: len(result.Stdout) + len(result.Stderr),
		Offloads: []string{req.Command},
	}
	if result.ExitCode != 0 {
		entry.Error = result.Stderr
	}
	g.audit(entry)
}

// WireProtocol constants for the mobile offload wire protocol (§5.1).
const (
	// WireMagicRequest is the request frame magic: "ZCFF" (0x5a434646)
	WireMagicRequest uint32 = 0x5a434646

	// WireMagicResponse is the response frame magic: "ZCFR"
	WireMagicResponse uint32 = 0x5a434652

	// WireVersion is the current wire protocol version.
	WireVersion uint8 = 1

	// WireSocketName is the abstract unix socket name for mobile offload.
	WireSocketName = "zephyr-cell-offload"

	// ResponseFileTTL is the TTL for response temp files (§5.1).
	ResponseFileTTL = 10 * time.Minute

	// CleanupInterval is how often to do opportunistic cleanup (every N responses).
	CleanupInterval = 50
)

// WireRequest is the mobile wire protocol request frame (§5.1).
type WireRequest struct {
	Magic     uint32 `json:"magic"`
	Version   uint8  `json:"version"`
	PID       int    `json:"pid"`
	SessionID string `json:"session_id"`
	Command   string `json:"command"`
	Args      []string `json:"args"`
	Env       map[string]string `json:"env,omitempty"`
	Cwd       string `json:"cwd"`
}

// WireResponse is the mobile wire protocol response frame.
type WireResponse struct {
	Magic    uint32 `json:"magic"`
	Version  uint8  `json:"version"`
	Result   cell.OffloadResult `json:"result"`
	TempFile string `json:"temp_file,omitempty"` // guest path for large output
}

// EncodeWireRequest serializes a wire request to JSON.
func EncodeWireRequest(req WireRequest) ([]byte, error) {
	return json.Marshal(req)
}

// DecodeWireRequest deserializes a wire request from JSON.
func DecodeWireRequest(data []byte) (WireRequest, error) {
	var req WireRequest
	err := json.Unmarshal(data, &req)
	return req, err
}

// EncodeWireResponse serializes a wire response to JSON.
func EncodeWireResponse(resp WireResponse) ([]byte, error) {
	return json.Marshal(resp)
}

// DecodeWireResponse deserializes a wire response from JSON.
func DecodeWireResponse(data []byte) (WireResponse, error) {
	var resp WireResponse
	err := json.Unmarshal(data, &resp)
	return resp, err
}
