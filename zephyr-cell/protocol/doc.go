// Package protocol implements the Cell wire protocol — the unified frame
// format used across all transports: function call, Unix socket, abstract
// socket, vsock, and WebSocket (§6.3).
//
// Frame layout:
//
//	┌──────────────┬──────────┬──────────────────┐
//	│ u32 length   │ u8 type  │ payload (bytes)  │
//	│ (big-endian) │          │                  │
//	└──────────────┴──────────┴──────────────────┘
//
// The same format runs on all transports. This is the technical foundation
// for Web (browser↔Docker) and native (in-process) sharing one contract.
//
// WebSocket adds: TLS, token auth, Origin check, per-connection rate limit,
// max frame 4MB (excess goes through the fs chunked channel).
package protocol
