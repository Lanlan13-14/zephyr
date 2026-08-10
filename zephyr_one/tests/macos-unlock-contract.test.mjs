import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * macOS system-unlock contracts for Zephyr One.
 *
 * Doc claims pinned here:
 *   - ARCHITECTURE.md "OS unlock": macOS uses the real LocalAuthentication API
 *     via `localauthentication-rs`; only ever the OS authenticator, never an
 *     app-invented password; optional and default OFF.
 *   - README.md: LocalAuthentication (Touch ID / 账户密码) on macOS; Linux
 *     reports unavailable rather than faking it.
 *
 * Source-level assertions, because the behaviour lives in Rust that only
 * compiles on a Mac. Written to fail loudly if the mechanism is removed or
 * silently swapped for a stub.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const authRs = read('zephyr_one/src-tauri/src/auth/mod.rs');
const cargoToml = read('zephyr_one/src-tauri/Cargo.toml');
const cargoLock = read('zephyr_one/src-tauri/Cargo.lock');

/** Slice the #[cfg(target_os = "macos")] fn unlock_macos body. */
function macosUnlockBlock() {
    const at = authRs.indexOf('fn unlock_macos');
    assert.ok(at > 0, 'unlock_macos must exist');
    // The next top-level fn after it bounds the block.
    const next = authRs.indexOf('\nfn ', at + 1);
    const nextCfg = authRs.indexOf('\n#[cfg(', at + 1);
    const end = nextCfg > 0 ? nextCfg : next;
    return authRs.slice(at, end > at ? end : undefined);
}

test('localauthentication-rs is a macOS-only dependency, resolved in the lockfile', () => {
    const macSectionAt = cargoToml.indexOf('[target.\'cfg(target_os = "macos")\'.dependencies]');
    assert.ok(macSectionAt > 0, 'Cargo.toml must declare a macOS-only dependency section');
    const winSectionAt = cargoToml.indexOf('[target.\'cfg(target_os = "windows")\'.dependencies]');
    const macSection = cargoToml.slice(macSectionAt, winSectionAt > macSectionAt ? winSectionAt : undefined);
    assert.match(macSection, /localauthentication-rs = "[^"]+"/,
        'LocalAuthentication must come from the real crate, gated to macOS');

    assert.match(macSection, /localauthentication-rs = "0\.1"/,
        '0.1.0 is the only published release and the one this API audit covers; a req bump needs re-verification');

    // The main dependency table must not pull it in for every platform.
    const mainDeps = cargoToml.slice(cargoToml.indexOf('[dependencies]'), macSectionAt);
    assert.doesNotMatch(mainDeps, /localauthentication-rs/,
        'an unconditional dep would fail to build on Windows/Linux runners');

    // Locked, not floating: the crate graph CI compiles is the one audited.
    assert.match(cargoLock, /name = "localauthentication-rs"\nversion = "[^"]+"/,
        'the crate must be pinned in Cargo.lock');
});

test('macOS unlock calls the real LocalAuthentication policy evaluation', () => {
    const block = macosUnlockBlock();
    assert.match(block, /use localauthentication_rs::\{LAPolicy, LocalAuthentication\};/);
    assert.match(block, /LocalAuthentication::new\(\)/);
    // DeviceOwnerAuthentication = biometry OR account password; the biometrics-
    // only policy would lock out Macs without Touch ID, contradicting the docs
    // ("Touch ID / 账户密码").
    assert.match(block, /LAPolicy::DeviceOwnerAuthentication/,
        'must use the device-owner policy, not the biometrics-only one');
    assert.match(block, /la\.evaluate_policy\(policy, reason\)/,
        'the OS prompt must actually be evaluated with the caller-provided reason');
});

test('success is reachable only through a true evaluate_policy verdict', () => {
    const block = macosUnlockBlock();
    // The verdict is bound to a local and branches on it — no unconditional
    // ok:true path may exist in the macOS implementation.
    assert.match(block, /let ok = la\.evaluate_policy\(policy, reason\);/);
    assert.match(block, /if ok \{/);
    const okCount = (block.match(/ok: true/g) || []).length;
    assert.equal(okCount, 1, 'exactly one success construction, inside the `if ok` branch');
    assert.ok(block.indexOf('if ok {') < block.indexOf('ok: true'),
        'the success path must sit inside the verdict branch');
    // Failure reports an error string rather than pretending to succeed.
    assert.match(block, /ok: false/);
    assert.match(block, /error: Some\(/);
});

test('the call site matches the verified localauthentication-rs 0.1.0 API exactly', () => {
    /* API surface verified against the published crate archive
     * (localauthentication-rs-0.1.0.crate, extracted and read):
     *   src/lib.rs:42   pub fn new() -> Self
     *   src/lib.rs:75   pub fn can_evaluate_policy(&self, policy: LAPolicy) -> bool
     *   src/lib.rs:116  pub fn evaluate_policy(&self, policy: LAPolicy, reason: &str) -> bool
     *   src/lib.rs:129  LAPolicy::DeviceOwnerAuthentication
     * evaluate_policy BLOCKS the calling thread (src/lib.rs:92; the Swift shim
     * parks on a DispatchSemaphore, swift-lib/src/lib.swift:18-27), so no
     * callback/future handling may appear at the call site. */
    const block = macosUnlockBlock();
    // reason arrives as &str, exactly what evaluate_policy takes.
    assert.match(block, /fn unlock_macos\(reason: &str\) -> UnlockResult/);
    // Construction is the zero-arg new() - no stub struct literal or Default.
    assert.match(block, /let la = LocalAuthentication::new\(\);/);
    assert.doesNotMatch(block, /LocalAuthentication\s*\{|LocalAuthentication::default/);
    // Crate docs (src/lib.rs:84) require checking evaluability first, so a Mac
    // with no enrolled credential fails honestly instead of hanging a prompt.
    assert.match(block, /la\.can_evaluate_policy\(policy\)/);
    assert.ok(
        block.indexOf('la.can_evaluate_policy(policy)') < block.indexOf('la.evaluate_policy(policy, reason)'),
        'can_evaluate_policy must gate the evaluate_policy call',
    );
    // evaluate_policy returns a plain bool. Result-shaped handling means
    // someone coded against an imagined API or swapped in a stub.
    assert.match(block, /let ok = la\.evaluate_policy\(policy, reason\);/);
    assert.doesNotMatch(block, /\.unwrap\(\)|\.expect\(|\.is_ok\(\)|match la\.evaluate_policy|if let Ok/);
});

test('capabilities are reported per platform, with Linux honestly unavailable', () => {
    const macCapAt = authRs.indexOf('#[cfg(target_os = "macos")]');
    assert.ok(macCapAt > 0);
    const macCap = authRs.slice(macCapAt, authRs.indexOf('#[cfg(target_os = "windows")]', macCapAt));
    assert.match(macCap, /available: true/);
    assert.match(macCap, /biometry: true/);
    assert.match(macCap, /LocalAuthentication/);

    const linuxAt = authRs.indexOf('#[cfg(target_os = "linux")]');
    assert.ok(linuxAt > 0);
    const linuxCap = authRs.slice(linuxAt, authRs.indexOf('}', authRs.indexOf('reason:', linuxAt)));
    assert.match(linuxCap, /available: false/, 'Linux must report unavailable, not fake support');
});

test('the dev bypass feature exists but is never part of a store build', () => {
    assert.match(cargoToml, /dev-system-unlock-bypass = \[\]/, 'the escape hatch must stay declared');
    const defaultAt = cargoToml.indexOf('default = [');
    assert.ok(defaultAt > 0);
    const defaultLine = cargoToml.slice(defaultAt, cargoToml.indexOf(']', defaultAt));
    assert.doesNotMatch(defaultLine, /dev-system-unlock-bypass/,
        'default features must never include the bypass');
    assert.match(cargoToml, /NEVER enable for store builds/i,
        'the warning comment is the only thing standing between this and a mistake');

    // In auth.rs the bypass branch must come first so it cannot be shadowed,
    // and must be cfg-gated so release builds compile it out entirely.
    const bypassAt = authRs.indexOf('#[cfg(feature = "dev-system-unlock-bypass")]');
    const macosAt = authRs.indexOf('#[cfg(target_os = "macos")]', authRs.indexOf('pub fn unlock'));
    assert.ok(bypassAt > 0 && macosAt > bypassAt,
        'the bypass must be the first branch of unlock(), then the real OS paths');
});

test('the unlock commands are wired into the Tauri invoke handler', () => {
    const commandsRs = read('zephyr_one/src-tauri/src/commands/mod.rs');
    assert.match(commandsRs, /pub fn auth_capabilities\(app: AppHandle\) -> auth::AuthCapabilities/);
    assert.match(commandsRs, /pub fn auth_unlock\(app: AppHandle, reason: Option<String>\) -> auth::UnlockResult/);

    const libRs = read('zephyr_one/src-tauri/src/lib.rs');
    assert.match(libRs, /commands::auth_capabilities,/);
    assert.match(libRs, /commands::auth_unlock,/);
});

test('system unlock is optional and defaults OFF in both stores', () => {
    // README: 可选，默认关. Two stores both defaulting to false is what keeps an
    // upgrade from suddenly gating the app behind a prompt the user never asked for.
    const mainJs = read('zephyr_one/src/main.js');
    assert.match(mainJs, /requireUnlock: false/, 'shell boot state must default off');
    assert.match(mainJs, /state\.requireUnlock = data\.requireUnlock === true/,
        'only an explicit true may arm it');

    const storeJs = read('zephyr_one/src/js/settings/store.js');
    assert.match(storeJs, /requireUnlock: false/, 'settings store must default off');
});

test('the bridge mints a success verdict only from UnlockResult.ok', () => {
    /* The product UI reaches LocalAuthentication through unlock_bridge (the
     * WebView is a remote origin and cannot invoke). The grant decision starts
     * here: ok:true may only be posted when the OS authenticator said yes. */
    const bridgeRs = read('zephyr_one/src-tauri/src/unlock_bridge/mod.rs');
    const verdictAt = bridgeRs.indexOf('let verdict = crate::auth::unlock(&app, &reason);');
    assert.ok(verdictAt > 0, 'the bridge must call the real auth::unlock');
    const gateAt = bridgeRs.indexOf('if verdict.ok {', verdictAt);
    assert.ok(gateAt > verdictAt, 'the success body must be gated on the verdict');
    const okBody = bridgeRs.indexOf('\\"ok\\":true', verdictAt);
    assert.ok(okBody > gateAt, 'the ok:true payload must be inside the gated branch');
    // Cancellation/failure is reported, never silently retried into a success.
    const failBody = bridgeRs.indexOf('\\"ok\\":false', verdictAt);
    assert.ok(failBody > okBody, 'failure must be posted explicitly');
});
