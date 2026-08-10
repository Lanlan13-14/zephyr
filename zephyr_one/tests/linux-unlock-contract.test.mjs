import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Linux system-unlock contracts for Zephyr One.
 *
 * Doc claims pinned here:
 *   - ARCHITECTURE.md "OS unlock": Linux is unavailable -- "reports so rather
 *     than faking it". Only ever the OS authenticator, never an app-invented
 *     password; optional and default OFF.
 *   - auth/mod.rs module table: "Linux | no portable system unlock; reports
 *     unavailable".
 *
 * There is no portable Linux system-unlock API: PAM is an authentication
 * stack without a user prompt contract, polkit authorizes actions rather
 * than gating an app, and libsecret/keyrings store secrets instead of
 * verifying the user. So the contract here is NEGATIVE: capabilities must
 * report unavailable with the documented reason, unlock() must fail with an
 * error, and no code path may manufacture a success on Linux.
 *
 * Source-level assertions, because the behaviour lives in Rust compiled per
 * platform. Written to fail loudly if a fake prompt or a PAM/polkit dep is
 * ever introduced as a "Linux unlock".
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const authRs = read('zephyr_one/src-tauri/src/auth/mod.rs');
const cargoToml = read('zephyr_one/src-tauri/Cargo.toml');

/**
 * Slice the two #[cfg(target_os = "linux")] arms of auth/mod.rs:
 * [0] is the capabilities() arm, [1] is the unlock() arm.
 */
function linuxArms() {
    const marker = '#[cfg(target_os = "linux")]';
    const arms = [];
    let from = 0;
    while (true) {
        const at = authRs.indexOf(marker, from);
        if (at < 0) break;
        const end = authRs.indexOf('#[cfg(', at + marker.length);
        arms.push(authRs.slice(at, end > at ? end : undefined));
        from = at + marker.length;
    }
    assert.equal(arms.length, 2,
        'auth/mod.rs must have exactly two Linux arms: capabilities() and unlock()');
    return arms;
}

test('Linux capabilities report unavailable, with the documented Chinese reason', () => {
    const cap = linuxArms()[0];
    assert.match(cap, /available: false/, 'Linux must not claim unlock support');
    assert.match(cap, /biometry: false/, 'no biometry claim without an OS API');
    assert.match(cap, /reason: "Linux \u65e0\u7edf\u4e00\u7cfb\u7edf\u89e3\u9501 API"\.into\(\)/,
        'the UI shows this string verbatim; changing it desyncs the docs');
    assert.doesNotMatch(cap, /available: true/,
        'a true anywhere in the Linux arm would arm the UI toggle for a mechanism that does not exist');
    assert.doesNotMatch(cap, /unsupported platform/,
        'Linux is a supported desktop target with its own honest arm, not the fallback');
});

test('Linux unlock() fails honestly with an error, never a fake success', () => {
    const arm = linuxArms()[1];
    assert.match(arm, /ok: false/);
    assert.match(arm, /method: None/, 'no method name may be invented for a mechanism that did not run');
    assert.match(arm,
        /error: Some\("Linux \u5f53\u524d\u4e0d\u652f\u6301\u7cfb\u7edf\u89e3\u9501\uff0c\u8bf7\u4fdd\u6301\u5f00\u5173\u5173\u95ed"\.into\(\)\)/,
        'the error tells the user to keep the toggle off; the wording is user-visible');
    assert.equal((arm.match(/ok: true/g) || []).length, 0,
        'the Linux arm must contain no success construction at all');
    assert.doesNotMatch(arm, /localauthentication|UserConsentVerifier|\bpam\b|\bpolkit\b/i,
        'the Linux arm must not call another platform\'s API or a pretend one');
});

test('no Linux unlock mechanism exists anywhere: no helper fn, no Linux-only deps', () => {
    // macOS has unlock_macos and Windows unlock_windows backed by real crates;
    // a fn unlock_linux would be a fake by definition, per the docs above.
    assert.doesNotMatch(authRs, /fn unlock_linux/,
        'there is no real API to wrap, so a Linux helper could only be a stub');
    assert.doesNotMatch(cargoToml, /\[target\.'cfg\(target_os = "linux"\)'\./,
        'a Linux-only dependency section would mean someone added an unlock crate');
    assert.doesNotMatch(cargoToml, /\b(libpam|pam-client|polkit|secret-service)\b/i,
        'PAM/polkit/keyring crates are not an app unlock prompt; adding one needs a doc ADR first');
});

test('the dev bypass is the only ok:true path in unlock(), and store builds compile it out', () => {
    assert.match(cargoToml, /dev-system-unlock-bypass = \[\]/, 'the escape hatch must stay declared');
    const defaultAt = cargoToml.indexOf('default = [');
    assert.ok(defaultAt > 0);
    const defaultLine = cargoToml.slice(defaultAt, cargoToml.indexOf(']', defaultAt));
    assert.doesNotMatch(defaultLine, /dev-system-unlock-bypass/,
        'default features must never include the bypass');
    assert.match(cargoToml, /NEVER enable for store builds/i,
        'the warning comment is the only thing standing between this and a mistake');

    const unlockAt = authRs.indexOf('pub fn unlock');
    assert.ok(unlockAt > 0);
    const bypassAt = authRs.indexOf('#[cfg(feature = "dev-system-unlock-bypass")]', unlockAt);
    const linuxAt = authRs.indexOf('#[cfg(target_os = "linux")]', unlockAt);
    assert.ok(bypassAt > unlockAt && bypassAt < linuxAt,
        'the bypass must be the first branch of unlock(), ahead of every OS path');

    // In a store build the bypass branch is compiled out, and with it the ONLY
    // success construction in unlock(): on Linux ok:true is then unreachable.
    const body = authRs.slice(unlockAt, authRs.indexOf('fn unlock_macos', unlockAt));
    assert.equal((body.match(/ok: true/g) || []).length, 1,
        'exactly one success construction may exist in unlock(), the cfg-gated dev bypass');
});

test('system unlock stays optional and defaults OFF in both stores', () => {
    // The Linux error string tells the user to keep the toggle off; both stores
    // defaulting to false is what makes that the state they already have.
    const mainJs = read('zephyr_one/src/main.js');
    assert.match(mainJs, /requireUnlock: false/, 'shell boot state must default off');
    assert.match(mainJs, /state\.requireUnlock = data\.requireUnlock === true/,
        'only an explicit true may arm it');

    const storeJs = read('zephyr_one/src/js/settings/store.js');
    assert.match(storeJs, /requireUnlock: false/, 'settings store must default off');
});

test('the bridge mints a success verdict only from UnlockResult.ok', () => {
    /* The product UI reaches unlock through unlock_bridge (the WebView is a
     * remote origin and cannot invoke). On Linux the verdict is always
     * ok:false; this pin ensures the bridge cannot post ok:true anyway. */
    const bridgeRs = read('zephyr_one/src-tauri/src/unlock_bridge/mod.rs');
    const verdictAt = bridgeRs.indexOf('let verdict = crate::auth::unlock(&app, &reason);');
    assert.ok(verdictAt > 0, 'the bridge must call the real auth::unlock');
    const gateAt = bridgeRs.indexOf('if verdict.ok {', verdictAt);
    assert.ok(gateAt > verdictAt, 'the success body must be gated on the verdict');
    const okBody = bridgeRs.indexOf('\\"ok\\":true', verdictAt);
    assert.ok(okBody > gateAt, 'the ok:true payload must be inside the gated branch');
    // Failure is posted explicitly, never silently retried into a success.
    const failBody = bridgeRs.indexOf('\\"ok\\":false', verdictAt);
    assert.ok(failBody > okBody, 'failure must be posted explicitly');
});
