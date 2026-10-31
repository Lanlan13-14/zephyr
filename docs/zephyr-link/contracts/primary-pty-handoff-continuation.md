# Primary SSH PTY continuation — 2026-10-31

## Implemented surface (requires the commit's Actions evidence)

- `PrimaryPtyHandoff` attaches to the real `sshTerminalSessions`, headless xterm framebuffer,
  exact output byte sequence, ssh2 stream input and window-change. It does not export SSH
  credentials, files, handles or process state. Execution stays `primary_pty`, trust is
  `trusted-primary`, not zero knowledge or process migration.
- Source browser explicitly offers a saved, same-owner SSH PTY. No Telnet, RDP, VNC,
  transient credentials, shared cross-user assets or direct mobile SSH are advertised.
- Receiver browser/Android lists primary PTYs; prepare captures an ANSI framebuffer and
  its output boundary. Renderer must consume/draw it before commit. Commit CAS increments
  epoch, clears old input receipts, detaches original socket and emits HANDOFF_TRANSFERRED.
- Original socket messages including omitted epoch, SFTP/exec/disconnect and ordinary
  reconnect cannot regain the retained PTY. Authenticated lease is server-held; body
  userId/deviceId/leaseId fields are rejected. Every read/input/resize checks live account,
  current device binding and saved-connection USE permission, same owner only.
- Output deltas use bounded 512 KiB rings and base64 exact bytes, 128 KiB pages; stale
  cursors/overflow or changed source geometry require another snapshot, never silent gaps.
  Snapshot cap is 2 MiB. Prepare IDs expire at 30 s; preparations are bounded to 128.
- Input has per-owner epoch + sequence + SHA-256 digest and 256 bounded receipts, consumed
  before write. Same-sequence retransmission cannot write twice. Uncertain write never
  auto-retries; failure is not proof that the remote command did not run. Server backpressure
  and 64 KiB input size bounds apply. Leases/receipts are in-memory because PTY is in-memory;
  supervisor/server process death cannot resume a fictional durable PTY.
- ZSL kind 11 shared-terminal uses authenticated loopback Node bridge; kind 15 AI stays
  separate. Proven session identity, not body fields, reaches the bridge. Android sync and
  terminal frames share a binding-level push mutex and SPKI policy; account stop cancels/
  joins requests. Android host delegates normal SSH unchanged and never reads local
  upstream credentials when receiving. A visible Termux view draw precedes the ACK.
- UI: browser terminal `接力`; Smartbar device entry opens actual primary PTY receive list,
  not a false "this device has a PTY" promise. Android session list `接收主端 SSH 会话`.
  Closing a receiver detaches; it does not acquire a separate kill capability.

## Regression evidence to collect remotely

Node product agent group: coordinator CAS/expiry/revoke/geometry/input replay/overflow,
real headless ANSI alt-screen/colors/cursor restore, actual server+ssh2 PTY transfer with
one upstream shell, old-socket input/disconnect/reconnect negative cases, fixed-kind live
binding bridge, browser render barrier and real xterm consumed callback, original terminal
snapshot/history/resume tests. Go module tests include encrypted kind-11 authenticated
roundtrip alongside AI. Android JVM suite includes receive-before-ACK denial, identical
byte-array ACK, credential wiping and uncertain input no retry. Mobile CI rebuilds real
Go libraries/APK and verifies identity/vulnerabilities; Apple regression still required.

## Not claimed / release boundary

- No arbitrary desktop/mobile-local PTY migration, no RDP/VNC surface/clipboard handoff.
- No cross-user/high-risk approval handoff, HA failover or durable process migration.
- No iOS PTY consumer UI in this commit (Apple Link runtime exists separately).
- No event/tool approval authority transfer to AI: this PTY capability is PTY-only.
- No completion of D1–D15; 245-case production release gate remains strict/red unless
  actual supported product vectors are implemented. No release or production guarantee.
- Remote tests are not physical-device proof; do not claim device UX/performance numbers.

## Rollback

Revert the continuation commit. Existing non-offered SSH/Telnet terminal paths remain
compatible. A server restart closes its real upstream sessions; never attempt to restore
owner capabilities from client-supplied snapshots or request identifiers.
