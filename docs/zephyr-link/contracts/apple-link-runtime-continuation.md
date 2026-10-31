# Apple in-process Link runtime continuation

[KNOWN] This change follows `29b71276`. It is not a claim that the iOS packaged application is a complete product or that Handoff/KindAI/D1–D15 are complete. The generated IPA host still contains local-only protocol/binding placeholders; those are a separate composition task.

## Implemented, awaiting CI evidence

- [KNOWN] The existing Go Link Node is built from the current clean commit as a C archive for macOS host tests and arm64 iOS device packaging. SwiftPM links the actual archive and has no stub/HTTPS fallback if native symbols are missing. The runner moves from cancelled `macos-14` to `macos-15`.
- [KNOWN] The C ABI owns at most 16 binding-scoped handles and only permits dial/finish/push. It does not open a listener, execute a process, expose private identity keys, or permit server/ML-KEM administration calls. JSON request/response buffers are bounded.
- [KNOWN] A real Swift LinkChannel lazily dials the shared Go protocol core, requires the server's enrolled-device proof step, signs the frozen transcript with the existing generation-leased Keychain identity, finishes before sending owned-sync frames, carries SPKI pins, and never sets insecure mode. HTTPS remains capabilities discovery, not owned-data fallback.
- [KNOWN] The production binding factory defaults to this channel rather than nil→HTTPS. Full-operation FIFO protects against Swift actor reentrancy and sequence races. An ambiguous push is not automatically replayed; the next actor round redials using the existing durable business IDs.
- [KNOWN] Cleanup disables the channel synchronously, quiesces scheduler work, and destroys the native handle. Native redial/failed push destroys retained old/pending sessions. Go key slices are overwritten and future seal/open/rebind fails; internal AEAD schedules are left to GC, so full physical key-memory erasure is not claimed.

## Verification requested (not results)

- [KNOWN] Go real enrolled-peer handshake + encrypted sync frame, forbidden native routes, concurrent close, retained-key destruction and permanent close behavior.
- [KNOWN] Swift invokes the real linked C archive and checks actual Go version/revision/clean identity, proof-before-push ordering, protocol rejection, FIFO reentrancy, no uncertain replay and teardown.
- [KNOWN] Existing Node/Go/Swift/Android suites and unsigned iOS device compilation remain mandatory. No local tests/builds or subagents were used.

## Explicit remaining work

[KNOWN] The installed iOS host's binding/runtime UI composition is still local-only. No real handset pairing, permissions, PTY/RDP/VNC Handoff, KindAI broker, B2/HA, production 64 missing vectors or full release is proven by this native library work.
