# Zephyr Cell

> **One SDK, six platforms.** A real, secure, everywhere-available computer for AI.

Zephyr Cell is the unified sandboxed Linux execution environment for Zephyr AI agents. It replaces the legacy L2 restricted exec with a complete Linux user-space (Alpine aarch64 rootfs) that runs identically across six platforms through platform-specific engines behind one SDK API.

## Platforms

| Platform | Engine | Key |
|----------|--------|-----|
| Linux arm64 | Direct (user ns + seccomp + cgroup v2) | Native performance |
| macOS ARM | CellVM (Virtualization.framework) | VM boundary + snapshot |
| Windows | WSL2-bridge | VM boundary via Hyper-V |
| Android | PRoot (ptrace user-space chroot) | No root required |
| iOS | Asbestos (threaded-code interpreter) | W^X compliant, App Store safe |
| Web | Cell-Server (Docker + Direct nesting) | Double sandbox + WS transport |

## Architecture

```
L5  Application / Agent (depends only on Cell SDK)
L4  Cell SDK (Go / Kotlin / Swift / C# / C / TypeScript — API identical)
L3  Cell Core (engine routing, session coordination, quotas, audit, framing)
L2  Engine (Direct / CellVM / WSL2 / PRoot / Asbestos / QEMU / Cell-Server)
L1  Guest (Alpine Linux aarch64 rootfs — byte-identical across platforms)
L0  Native Offload Handlers (zc-* stubs → host platform APIs)
```

## Status

**M0 — Foundation (this PR):** SDK interfaces frozen, frame protocol defined, audit schema codified, engine abstraction established, contract tests scaffolded. Code only; no engine wiring.

## Package Structure

```
zephyr-cell/
├── doc.go              Package documentation
├── cell.go             Cell handle, Spawn, top-level SDK API
├── capability.go       Capability bits and engine matrices (§2.3)
├── template.go         Template, Limits, NetworkPolicy (§6.1, §8.1)
├── exec.go             ExecResult, ExecOption, StreamLine (§6.1)
├── pty.go              PTY session interface (§6.1)
├── files.go            FileInfo for guest filesystem (§6.1)
├── snapshot.go         Snapshot ID type (§6.1)
├── metrics.go          Runtime metrics (§8.2)
├── audit.go            Audit entry schema (§8.3)
├── errors.go           Structured error codes (§6.2)
├── env.go              Unified environment variables (§3.3)
├── paths.go            Guest path constants (§3.2)
├── offload.go          Offload envelope and exit codes (§5)
├── cell_test.go        SDK contract tests
├── engine/
│   ├── engine.go       Engine interface (§4.1)
│   ├── registry.go     Engine registry and selection (ADR-002)
│   └── registry_test.go
├── protocol/
│   ├── doc.go          Protocol documentation
│   ├── types.go        Frame type constants (§6.3)
│   ├── frame.go        Frame encode/decode (§6.3)
│   └── frame_test.go
└── rootfs/
    ├── layer.go        Layer, Manifest, content-addressing (§3.1)
    └── layer_test.go
```

## Design Reference

Full specification: [`FREEZE/ZEPHYR-CELL.md`](../FREEZE/ZEPHYR-CELL.md)

## License

GPL-3.0, same as the Zephyr project.
