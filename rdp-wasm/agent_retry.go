package main

import (
	"strings"
	"time"
)

const (
	// Chunk-level retries cover transient busy/timeout/backpressure without
	// failing the whole Explorer copy. Total budget stays under typical IRP
	// patience; permanent errors (not_found/read_only/…) still fail once.
	agentRequestMaxAttempts = 4
	agentRequestRetryBase   = 25 * time.Millisecond
)

func isRetryableAgentError(err error) bool {
	if err == nil {
		return false
	}
	if zerr, ok := err.(*zft2Error); ok {
		if zerr.Retryable {
			return true
		}
		switch zerr.Code {
		case "busy", "timeout", "io_error", "backpressure":
			return true
		default:
			return false
		}
	}
	// Non-protocol transport blips (WS closed mid-flight is NOT retried here —
	// the connection layer owns reconnect). Plain backpressure strings are.
	msg := err.Error()
	return strings.Contains(msg, "backpressure") || strings.Contains(msg, "request window is full")
}
