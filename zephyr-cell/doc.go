// Package cell implements the Zephyr Cell SDK — a six-platform-uniform
// sandboxed Linux execution environment for AI agents.
//
// Cell is the unified replacement for Zephyr's L2 restricted exec. It provides
// a complete Linux user-space (Alpine aarch64 rootfs) with persistent shell
// sessions, structured output, native offload, and append-only audit — running
// on six platforms through platform-specific engines behind one SDK API.
//
// Object model (aligned with E2B intuition):
//
//	Template → Cell → Exec / PTY / Files / Snapshot / Metrics
//
// Design contract: every public type, method name, parameter order, and error
// code in this package is the canonical definition. Language bindings for
// Kotlin, Swift, C#, C ABI, and TypeScript MUST mirror this package exactly;
// divergence is caught by the SDK alignment CI gate (§10.5).
package cell
