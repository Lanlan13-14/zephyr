# 2026-10-30 audit remediation (incomplete Link product)

## Scope and execution restrictions

[KNOWN] Baseline: `ac62b87d4eea1eeed485b661854d6dceeb7e3e05`. Work is on `zephyr-link-foundation-v1` in an isolated worktree. The operator prohibited local builds/tests and subagents; verification is delegated only to GitHub Actions. Source review and `git diff --check` are not test results.

## Implemented in this change, pending CI

- [KNOWN] AI host RPC now requires a valid provider `callId`. The runner propagates it through Go platform tools and Cell L2 to Node. Cache identity is account/session/run/call/database-generation, not runId alone. Retry authorization is checked before and after waiting. In-flight calls and failures are shared; bounded capacity fails closed rather than evicting side-effect keys. Canonical authorization/confirmation remains authoritative. This is process-local deduplication, not durable AI RPC.
- [KNOWN] Cell `Session.Exec` permits exact bare command names only. Arguments (including `env` proxy commands), shell composition, redirection, substitutions and paths are denied. Structured argv with per-command policy is not implemented.
- [KNOWN] WebDAV production proxy exposes restore and binds the real Notes/Resource services after initialization and database replacement. Missing services fail closed; all ownership/id collisions are preflighted; update failure is never changed into create/upsert. Restore ordering is proxies/keys/jump-hosts/connections/notes. Production service wraps writes in its SQLite transaction, and rechecks cancellation after decryption.
- [KNOWN] File RPC requests use existing-parent realpath jail; Agent Desktop provider rejects symlink components and parent traversal before filesystem operations. This is not an atomic openat/no-follow jail; concurrent filesystem replacement and Android SAF remain unverified.
- [KNOWN] New CI tests include production manager/router/HTTP vault GET/real Notes database; wrong password/tamper; cross-account id collision; runtime call identity and revoked replay; real legacy/v2 RPC symlink rejection; Go Cell engine-entry rejection; baseline A/B proofs.

## CI and release evidence

[KNOWN] `Zephyr Link` runs product Node groups, full Link/AI/Cell Go vet/tests, Go↔Node vectors, Android arm64 cross-build and Flutter Agent tests. The reviewed baseline must fail the new behavioral regressions. These jobs are independent from the strict `production-release-gate`.

[KNOWN] Required production vectors with `unsupported` now make the production runner exit nonzero. The known 64 gaps are deliberately **not** treated as passing or waived. The production gate is expected to remain red until all requirements are implemented. Development tests may pass while release is blocked.

[KNOWN] Mobile workflow now triggers on the Link branch. It rebuilds all Android Go runtimes from a clean fixed checkout and inspects the actual three Go binaries extracted from the APK: revision, Go 1.26.10, target, clean VCS state, and binary-mode govulncheck. Push/PR validation does not publish a release. Committed old fallback `.so` files are not claimed refreshed by this source change.

## Explicitly not completed

- [KNOWN] No real PTY/RDP/VNC Handoff routes or cross-device handoff. Legacy no-epoch clients remain compatible and are not a security boundary.
- [KNOWN] KindAI status/unsupported handler is not tool execution; no durable run store or ZSL AI broker.
- [KNOWN] iOS has no real LinkChannel runtime; Android import choice UI is incomplete; no three-platform pairing, device sandbox/SAF or runtime E2E evidence.
- [KNOWN] No WebDAV B2 multi-writer oplog, epoch revocation/key rotation or multi-copy HA/long soak tests.
- [KNOWN] D15 full local/system policy provisioning, VFS mounts and 22 offload are not completed by server-side checks.
- [KNOWN] L5 mobile compile evidence is requested in CI; L6–L8 are not claimed. Full P0–P6 and D1–D15 completion must not be inferred.

## Compatibility

[KNOWN] Deploy Node and Go AI host together. Old Go host without callId is now rejected (intentional breaking internal contract). No data migration. Revert this change if needed without deleting user data. Do not revert strict release failure merely to get a green badge.


## Additional packaged-binary finding

- [KNOWN] The first real APK scan (run 41069517107) reported GO-2026-5841 in `klauspost/compress v1.17.11` (`s2.NewDict`); host-source scanning alone did not report it. The Link module is upgraded to v1.18.7 using checksums from the official Go sum database; the APK inspector requires the patched dependency in the actual extracted Link binary. All three Go runtimes are scanned even if one fails, with any failure blocking artifact delivery. Final CI results, not this note, are the evidence of remediation.
