# Android D1 first-import continuation

[KNOWN] This is an implementation continuation after `6111eebe`, not a claim that the Link product or D1–D15 is complete. No local compilation/tests or subagents; execution evidence must come from GitHub Actions.

## Behavior

- [KNOWN] The real device-local database is opened through `AppContainer.localImportBinding()` and the existing opaque account database scope, with owner filtering. No row owner is mutated and the source database/secrets are preserved.
- [KNOWN] Account activation arms the persisted import gate before network producers. The UI has per-type counts, defaults to keep-local/no selection/no credentials, and requires explicit consent for copy-and-upload. Dismissing leaves push paused; 文件同步 → 立即同步 reopens the choice.
- [KNOWN] Copy-as-new supports connection/proxy/sshKey/jumpHost/note/snippet and seven AI entity types. Singleton settings, ACLs, device tokens/configs, workspace runtime state, metadata and read-only activity are excluded from copying as new. No implicit copying of device-local overlays/path grants.
- [KNOWN] Only editable projections enter the copy batch. Nested secret aliases are scrubbed; authority/opaque/device-local fields are dropped. Known references are remapped to fresh IDs. Missing/unselected dependencies reject the plan. Shared-user/admin flags are false, explicit user grants are empty and visibility is private.
- [KNOWN] Credentials are optional and separately confirmed; they are decrypted only with the source account generation and rewrapped through the destination SecretMutationJournal. UTF-8 decoding uses wipeable buffers rather than a new immutable plaintext String. No plaintext credential enters the mirror, queue or copy batch.
- [KNOWN] The chosen copy plan/new IDs are durable. Partial retries cannot switch type/credential choices or release the gate with keep-local. Per-entity receipts commit with mirror/queue/secret journal. Existing IDs/tombstones cannot be overwritten. Binding/lock/generation is rechecked inside commit. Import runs in the account lifetime and shares an exclusion lock with all sync rounds.

## Verification requested (not results)

- [KNOWN] JVM behavioral tests: editable/authority/secret projection, every supported reference family, cycles, sharing removal, invalid references, absent dependencies, invalid/duplicate/reused IDs, excluded types, secret UTF-8 ownership and bad encoding, sync/import mutual exclusion, failure and cancellation unlock.
- [KNOWN] CI emulator instrumentation: actual Room transactions + Android Keystore for mirror/queue/receipt atomicity, collision defense, injected final-receipt write rollback including staged secret, stale binding guard, and cross-scope secret rewrap preserving source.
- [KNOWN] Mobile workflow adds an isolated Android 35 x86_64 emulator task for `LocalImportTransactionTest`; release depends on that task too. Kotlin app compilation and the existing Node/Go/Swift suites remain required.

## Not claimed

[KNOWN] No real handset UI approval/permission interaction, three-platform pairing, iOS Link runtime, Handoff, KindAI execution broker, WebDAV B2/HA, all production vectors or full Link release completion. These remain independent work, not waived by this UI.
