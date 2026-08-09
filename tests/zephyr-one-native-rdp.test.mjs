// Zephyr One's RDP engine is FreeRDP linked in-process, not the browser WASM client.
//
// Why a Node test for Rust code:
//   The compile-and-link proof lives in CI (`cargo test --lib` against
//   freerdp3-dev), because it needs a Rust toolchain and FreeRDP headers. What
//   this file guards is the wiring that decides *whether that proof runs at all*,
//   plus the architectural constraints a compiler cannot express.
//
//   That distinction matters here specifically. Commit b0e5a9c removed an earlier
//   native-RDP attempt and recorded two defects worth not repeating: build.rs
//   compiled the C shim while no Rust code consumed it, so Tauri required FreeRDP
//   for zero functionality; and the sidecar streamed frames through the Node core
//   into a Web canvas, which the development spec forbids. Neither is a type
//   error. Both are visible in the files below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const BUILD_RS = read('zephyr_one/src-tauri/build.rs');
const CARGO_TOML = read('zephyr_one/src-tauri/Cargo.toml');
const LIB_RS = read('zephyr_one/src-tauri/src/lib.rs');
const COMMANDS_RS = read('zephyr_one/src-tauri/src/commands/mod.rs');
const RDP_MOD = read('zephyr_one/src-tauri/src/rdp/mod.rs');
const RDP_FFI = read('zephyr_one/src-tauri/src/rdp/ffi.rs');
const RDP_SESSION = read('zephyr_one/src-tauri/src/rdp/session.rs');
const HEADER = read('zephyr_one/native/freerdp-core/zephyr_rdp.h');
const WORKFLOW = read('.github/workflows/zephyr-one.yml');
const ADR = read('FREEZE/zephyr one for mobile/NATIVE_ENGINE_DECISIONS.md');

test('the C shim is compiled by the build and consumed by Rust', () => {
    /* Both halves, asserted together on purpose. b0e5a9c reverted a build that
     * compiled the shim with no consumer -- FreeRDP became a hard dependency for
     * zero functionality. A test for either half alone would have passed then. */
    /* Asserted on the `.file(...)` call rather than on the filename: build.rs
     * also names zephyr_rdp.c in a rerun-if-changed line, so a mutation that
     * pointed the compiler at a different file would still "mention" it. */
    assert.match(BUILD_RS, /cc::Build::new\(\)/);
    assert.match(
        BUILD_RS,
        /\.file\(native\.join\("zephyr_rdp\.c"\)\)/,
        'build.rs must feed zephyr_rdp.c to the C compiler',
    );
    assert.match(BUILD_RS, /build\.compile\(/, 'and actually run the compile');
    assert.match(CARGO_TOML, /^cc = /m, 'cc is needed to compile it');
    assert.match(CARGO_TOML, /^pkg-config = /m, 'pkg-config is needed to find FreeRDP');

    // The consumer.
    assert.match(LIB_RS, /^mod rdp;\r?$/m, 'the rdp module must be registered in lib.rs');
    assert.match(LIB_RS, /rdp::SessionRegistry::new\(\)/, 'and its registry managed');
    assert.match(RDP_FFI, /pub fn zephyr_rdp_new\(/, 'the session entry point must be bound');
    assert.match(RDP_SESSION, /ffi::zephyr_rdp_run\(raw\)/, 'something must actually run a session');
    assert.match(COMMANDS_RS, /pub fn rdp_native_connect\(/, 'the UI must be able to reach it');
});

test('the engine is a hard dependency with one explicit, honest escape hatch', () => {
    /* A silent fallback is the failure mode to avoid: it would let One report
     * native RDP while running the same Go/WASM pipeline as the browser, which
     * ADR-004 forbids in as many words. */
    assert.match(BUILD_RS, /panic!\(/, 'a missing FreeRDP must fail the build, not degrade it');
    assert.match(BUILD_RS, /freerdp3-dev/, 'the failure must say how to fix it');
    assert.match(BUILD_RS, /ZEPHYR_ONE_SKIP_NATIVE_RDP/);

    // The opt-out must remove the cfg, so nothing links symbols that were never
    // compiled and every command reports unavailable instead.
    assert.match(BUILD_RS, /cargo:rustc-cfg=zephyr_native_rdp/);
    /* Index order alone is satisfied by a guard that never fires: rewriting the
     * condition to `if false` leaves both strings exactly where they were while
     * emitting the cfg for a build that has no engine, which would then link
     * symbols that were never compiled. Pin the condition itself. */
    assert.match(
        BUILD_RS,
        /if std::env::var\("ZEPHYR_ONE_SKIP_NATIVE_RDP"\)\s*\.as_deref\(\) == Ok\("1"\) \{/,
        'the skip must be gated on the env var, not on a constant',
    );
    const guardAt = BUILD_RS.search(/if std::env::var\("ZEPHYR_ONE_SKIP_NATIVE_RDP"\)/);
    const cfgAt = BUILD_RS.indexOf('cargo:rustc-cfg=zephyr_native_rdp');
    assert.ok(guardAt > 0 && guardAt < cfgAt, 'the skip must return before the cfg is emitted');
    // And the guarded block must actually leave the function.
    const guarded = BUILD_RS.slice(guardAt, cfgAt);
    assert.match(guarded, /\breturn;/, 'the skip path must return rather than fall through');

    assert.match(RDP_MOD, /Error::Unavailable/);
    assert.match(RDP_MOD, /"native_rdp_unavailable"/);
    assert.match(COMMANDS_RS, /pub fn rdp_native_capabilities\(/,
        'the UI must be able to ask before offering a connect button');
});

test('frames never cross into JavaScript', () => {
    /* The constraint b0e5a9c was reverted for. The spec requires the native core
     * to emit protocol and dirty rectangles while the platform layer owns the
     * surface; a command handing pixel bytes to the WebView rebuilds the sidecar.
     *
     * Asserted as an absence, which is why it is mechanical rather than a comment:
     * a future `rdp_native_poll_frame` returning Vec<u8> fails here. */
    const commandNames = [...COMMANDS_RS.matchAll(/pub fn (rdp_native_\w+)\(/g)].map((m) => m[1]);
    assert.ok(commandNames.length >= 10, `expected the full command surface, saw ${commandNames.length}`);

    for (const name of commandNames) {
        assert.doesNotMatch(name, /frame_data|pixels|poll_frame|read_frame|framebuffer/,
            `${name} looks like a pixel channel to the WebView`);
    }

    /* `request_full_frame` is legitimate and must not be mistaken for one: it
     * asks the *server* to repaint, and returns nothing. */
    const requestFull = COMMANDS_RS.slice(COMMANDS_RS.indexOf('pub fn rdp_native_request_full_frame'));
    const signature = requestFull.slice(0, requestFull.indexOf('{'));
    assert.match(signature, /Result<\(\), String>/,
        'request_full_frame must return nothing, not pixels');

    // No command returns a pixel buffer.
    assert.doesNotMatch(COMMANDS_RS, /rdp_native\w*[^;]*->\s*Result<Vec<u8>/s);

    // The sink is a Rust trait, so a surface owner implements it in-process.
    assert.match(RDP_SESSION, /pub trait FrameSink: Send \+ Sync/);
    assert.match(RDP_SESSION, /fn frame\(&self, rect: FrameRect/);
});

test('the hand-written struct mirror is checked against C, not merely written carefully', () => {
    /* #[repr(C)] agrees with the C ABI only if the field list and order match.
     * A drift is not a compile error across FFI: a `*const c_char` gets read
     * where an `i32` was written, so the session connects with garbage
     * credentials or dereferences an integer as a pointer. */
    assert.match(HEADER, /int32_t zephyr_rdp_config_layout\(int32_t selector\);/,
        'the C side must export its layout');
    /* Two definitions exist -- the real one under cfg(zephyr_native_rdp) and a
     * vacuous Ok() for builds without the engine -- so merely finding the name
     * proves nothing: renaming the real one leaves the fallback matching. Pin the
     * definition that actually compares offsets. */
    const layoutDefs = [...RDP_FFI.matchAll(/pub fn assert_layout_matches_c\(\)/g)];
    assert.equal(layoutDefs.length, 2,
        'expected both the native and the no-engine definition');
    const realDef = RDP_FFI.slice(layoutDefs[0].index);
    const realBody = realDef.slice(0, realDef.indexOf('pub fn assert_layout_matches_c', 10));
    assert.match(realBody, /offset_of!\(zephyr_rdp_config/,
        'the native assert_layout_matches_c must be the one comparing offsets');
    assert.match(realBody, /zephyr_rdp_config_layout\(/,
        'and it must read the offsets from the C side, not from itself');

    /* The comparison itself, not just its ingredients.
     *
     * Two mutations survive an assertion that only checks the pieces are
     * present: rewriting `if c_offset != rust_offset` to `if false`, and making
     * the C-side accessor return a constant. Both leave every name in place
     * while making the check vacuous -- and a vacuous ABI check is worse than no
     * check, because it reads as a guarantee. */
    assert.match(
        realBody,
        /if c_offset as usize != rust_offset \{/,
        'the offset comparison must actually compare C against Rust',
    );
    assert.match(
        realBody,
        /let c_of = \|selector: i32\| unsafe \{ zephyr_rdp_config_layout\(selector\) \}/,
        'the C accessor must forward its selector, not return a constant',
    );
    /* Both of these previously matched text inside the *error strings* rather
     * than the checks that produce them, so gutting the guard left the assertion
     * passing. Match the guards. */
    assert.match(
        realBody,
        /if expected_size as usize != size_of::<zephyr_rdp_config>\(\) \{/,
        'sizeof must be compared: matching offsets with a different size still misreads',
    );
    assert.match(
        realBody,
        /return Err\(format!\(\s*\r?\n\s*"offsetof\(\{name\}\)/,
        'a detected offset mismatch must return an error naming the field',
    );

    // Every field the C header declares must appear in the Rust mirror.
    const structBody = HEADER.slice(
        HEADER.indexOf('typedef struct zephyr_rdp_config {'),
        HEADER.indexOf('} zephyr_rdp_config;'),
    );
    const cFields = [...structBody.matchAll(/^\s*(?:const char\*|uint32_t|int32_t)\s+(\w+);/gm)]
        .map((m) => m[1]);
    assert.equal(cFields.length, 23, `expected 23 C fields, parsed ${cFields.length}`);

    for (const field of cFields) {
        assert.match(RDP_FFI, new RegExp(`pub ${field}:`),
            `zephyr_rdp_config.${field} is missing from the Rust mirror`);
        assert.match(RDP_FFI, new RegExp(`offset_of!\\(zephyr_rdp_config, ${field}\\)`),
            `${field} is declared but its offset is never compared against C`);
    }

    // And the check must gate connecting, not just exist in a test.
    assert.match(RDP_SESSION, /if let Err\(problem\) = ffi::assert_layout_matches_c\(\)/);
    assert.match(RDP_SESSION, /return Err\(Error::AbiMismatch\(problem\)\)/);
});

test('every exported shim function the engine needs is bound', () => {
    /* A missing binding is not a compile error until something calls it, so an
     * ABI function silently absent from the Rust side would only surface as a
     * feature that does nothing. */
    const exported = [...HEADER.matchAll(/^(?:[A-Za-z_][\w ]*\*?)\s+(zephyr_rdp_[a-z0-9_]+)\s*\(/gm)]
        .map((m) => m[1]);
    assert.ok(exported.length >= 15, `expected the shim's full surface, saw ${exported.length}`);

    /* Bound deliberately. The test helpers (`*_test_*`, `utf_roundtrip`,
     * `probe_drive`) and `isolate_stdout` are excluded with a reason: stdout
     * isolation existed for the sidecar's binary stdout channel, which no longer
     * exists, and probe_drive/UTF helpers are exercised by the C ctests. */
    const notNeeded = new Set([
        'zephyr_rdp_isolate_stdout',
        'zephyr_rdp_probe_drive',
        'zephyr_rdp_test_utf8_to_utf16le',
        'zephyr_rdp_test_utf16le_to_utf8',
    ]);

    const missing = exported.filter((fn) => !notNeeded.has(fn) && !RDP_FFI.includes(fn));
    assert.deepEqual(missing, [], `unbound shim functions: ${missing.join(', ')}`);
});

test('session teardown cannot use a freed pointer', () => {
    /* The concrete hazard: the run thread frees on exit while a UI thread is
     * midway through send_mouse. A raw `*mut` in the handle would invite exactly
     * that, and it is a use-after-free rather than a panic. */
    assert.match(RDP_SESSION, /session: Mutex<Option<\*mut ffi::zephyr_rdp_session>>/,
        'the pointer must be behind a mutex and nullable');
    assert.match(RDP_SESSION, /fn with_session<R>/, 'input must go through the guarded accessor');

    // Clearing before freeing, under the lock, is what makes "observed Some
    // implies live" true for every input caller.
    const thread = RDP_SESSION.slice(RDP_SESSION.indexOf('let code = unsafe { ffi::zephyr_rdp_run'));
    const clearAt = thread.indexOf('*slot = None;');
    const freeAt = thread.indexOf('ffi::zephyr_rdp_free(raw)');
    assert.ok(clearAt > 0 && freeAt > clearAt,
        'the slot must be cleared before the session is freed');

    // Input must not hold the lock across the blocking run call, or every send
    // would wait for the session to end.
    assert.match(RDP_SESSION, /Copied out without holding the lock/);
});

test('CI actually compiles and links the engine', () => {
    /* Without this the whole module is unverified: nothing in this repository can
     * compile Rust or C on the machine it was written on. */
    const test = WORKFLOW.slice(WORKFLOW.indexOf('  test:'), WORKFLOW.indexOf('  build-windows:'));
    assert.match(test, /freerdp3-dev/, 'the test job must install FreeRDP');
    assert.match(test, /run-ctests\.sh/, 'the C-level tests must still run');
    assert.match(test, /cargo test --lib/, 'the Rust must be compiled and its tests run');
    assert.match(test, /dtolnay\/rust-toolchain@stable/);

    // The documented escape hatch must stay buildable, or a contributor without
    // FreeRDP is blocked from compiling anything.
    assert.match(test, /ZEPHYR_ONE_SKIP_NATIVE_RDP: '1'/);
    assert.match(test, /cargo check --lib/);
});

test('every release build can satisfy the new hard dependency', () => {
    /* build.rs now panics without FreeRDP, so a release job that does not install
     * it fails at link time -- after a full frontend build. Each of the three
     * platforms needs its own package manager. */
    const job = (name, next) =>
        WORKFLOW.slice(WORKFLOW.indexOf(`  ${name}:`), WORKFLOW.indexOf(`  ${next}:`));

    assert.match(job('build-windows', 'build-macos'), /vcpkg install freerdp/);
    assert.match(job('build-macos', 'build-linux'), /brew install freerdp/);
    assert.match(job('build-linux', 'release'), /freerdp3-dev/);

    /* Windows links FreeRDP dynamically, so the DLLs must sit beside the exe or
     * the installed app dies with a missing-DLL dialog before showing a window. */
    const windows = job('build-windows', 'build-macos');
    assert.match(windows, /Stage FreeRDP runtime DLLs/);
    const stageAt = windows.indexOf('Stage FreeRDP runtime DLLs');
    const collectAt = windows.indexOf('Collect Windows artifacts');
    assert.ok(stageAt < collectAt, 'DLLs must be staged before artifacts are collected');
});

test('the Linux package declares its FreeRDP runtime dependency', () => {
    /* apt would otherwise install a .deb that cannot start. The alternation keeps
     * it installable on a distro that ships FreeRDP 2, which the shim also
     * supports through the accessor API. */
    const conf = JSON.parse(read('zephyr_one/src-tauri/tauri.conf.json'));
    const depends = conf.bundle.linux.deb.depends;
    assert.ok(Array.isArray(depends) && depends.length > 0, 'deb depends must not be empty');
    assert.ok(depends.some((d) => /libfreerdp/.test(d)), `no FreeRDP dependency in ${depends}`);
    assert.ok(depends.some((d) => /libwinpr/.test(d)), `no WinPR dependency in ${depends}`);
});

test('an unrecognised security or audio mode is refused, never defaulted', () => {
    /* The one mistake in the connect request that must never be quiet: silently
     * treating security="plaintxet" as Auto would negotiate something weaker
     * than the operator asked for. */
    /* The Rust sources spell CJK as `\u{65e0}` escapes -- a deliberate choice, so
     * that no editor or shell round-trip can mangle a user-facing string into
     * question marks. Match that form rather than the decoded characters. */
    assert.match(COMMANDS_RS, /RDP \\u\{5b89\}\\u\{5168\}\\u\{6a21\}\\u\{5f0f\}/,
        'an unrecognised security mode must be reported, not defaulted');
    assert.match(COMMANDS_RS, /\\u\{97f3\}\\u\{9891\}\\u\{6a21\}\\u\{5f0f\}/,
        'an unrecognised audio mode must be reported, not defaulted');
    assert.match(RDP_MOD, /pub fn parse\(value: &str\) -> Option<Self>/);

    // Parse returning Option is what forces the caller to decide; a Default impl
    // on the enum would let the mistake through.
    assert.doesNotMatch(RDP_MOD, /impl Default for Security/);
    assert.doesNotMatch(RDP_MOD, /impl Default for AudioMode/);
});

test('a folder mapping is validated before it can fail the whole connect', () => {
    /* freerdp_client_add_device_channel stats the path and fails the *entire*
     * settings assembly when it is gone, so an unmounted share would otherwise
     * surface as a generic connect failure with no hint at the cause. */
    assert.match(RDP_MOD, /pub fn validate_drive\(name: &str, path: &str\)/);
    assert.match(COMMANDS_RS, /pub fn rdp_native_validate_folder\(/);

    /* Newline-agnostic: these sources are checked out with CRLF on Windows, so a
     * pattern hard-coding \n would fail for a reason unrelated to the claim. */
    const startAt = RDP_SESSION.search(/#\[cfg\(zephyr_native_rdp\)\]\r?\n\s*fn start_impl/);
    assert.ok(startAt > 0, 'the native start_impl must exist');
    const start = RDP_SESSION.slice(startAt);
    const validateAt = start.indexOf('super::validate_drive(');
    const newAt = start.indexOf('ffi::zephyr_rdp_new(');
    assert.ok(validateAt > 0 && validateAt < newAt,
        'the mapping must be validated before the session is created');

    // Each reason keeps its own code, because the fix differs per case.
    for (const code of ['drive_name_empty', 'drive_path_empty', 'drive_not_found',
        'drive_not_directory', 'drive_name_unusable']) {
        assert.ok(RDP_MOD.includes(`"${code}"`), `missing drive reason code ${code}`);
    }
});

test('the docs no longer claim One ships the browser WASM engine', () => {
    /* ADR-004 recorded, correctly at the time, that the C core was consumed by
     * nothing and that desktop native RDP was therefore unimplemented. Leaving
     * that text in place while shipping the engine would make the freeze document
     * wrong in the opposite direction. */
    assert.doesNotMatch(
        ADR,
        /\u5c1a\u672a\u88ab\u4efb\u4f55 Rust\/\u5e73\u53f0\u4ee3\u7801\u6d88\u8d39/,
        'ADR-004 still says the C core has no consumer',
    );
    assert.match(ADR, /src-tauri/, 'ADR-004 should describe how it is now consumed');
});
