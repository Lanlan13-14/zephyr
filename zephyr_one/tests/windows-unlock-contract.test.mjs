import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Windows system-unlock contracts for Zephyr One.
 *
 * Doc claims pinned here:
 *   - ARCHITECTURE.md "OS unlock": Windows uses the real UserConsentVerifier
 *     (Windows Hello / device PIN) via the windows crate; only ever the OS
 *     authenticator, never an app-invented password; optional and default OFF.
 *   - README.md: Windows Hello / PIN on Windows; optional, default off.
 *
 * Source-level assertions, because the behaviour lives in Rust that only
 * compiles on Windows. Written to fail loudly if the mechanism is removed or
 * silently swapped for a stub.
 *
 * API surface verified against the windows crate 0.58 docs (docs.rs):
 *   UserConsentVerifier::RequestVerificationAsync(&HSTRING)
 *       -> windows::core::Result<IAsyncOperation<UserConsentVerificationResult>>
 *   IAsyncOperation<T>::get() blocks and yields windows::core::Result<T>
 *   UserConsentVerificationResult::Verified is the only success variant used.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const authRs = read('zephyr_one/src-tauri/src/auth/mod.rs');
const cargoToml = read('zephyr_one/src-tauri/Cargo.toml');
const cargoLock = read('zephyr_one/src-tauri/Cargo.lock');

/** Slice the #[cfg(target_os = "windows")] fn unlock_windows body. */
function windowsUnlockBlock() {
    const at = authRs.indexOf('fn unlock_windows');
    assert.ok(at > 0, 'unlock_windows must exist');
    const next = authRs.indexOf('\nfn ', at + 1);
    const nextCfg = authRs.indexOf('\n#[cfg(', at + 1);
    const end = nextCfg > 0 ? nextCfg : next;
    return authRs.slice(at, end > at ? end : undefined);
}

test('the windows crate is a Windows-only dependency, resolved in the lockfile', () => {
    const winSectionAt = cargoToml.indexOf("[target.'cfg(target_os = \"windows\")'.dependencies]");
    assert.ok(winSectionAt > 0, 'Cargo.toml must declare a Windows-only dependency section');
    const winSection = cargoToml.slice(winSectionAt);
    assert.match(winSection, /windows = \{ version = "0\.58"/,
        'UserConsentVerifier must come from the real windows crate, gated to Windows');
    assert.match(winSection, /"Security_Credentials_UI"/,
        'the Security_Credentials_UI feature carries UserConsentVerifier');
    assert.match(winSection, /"Foundation"/,
        'the Foundation feature carries IAsyncOperation');

    // The main dependency table must not pull it in for every platform.
    const mainDeps = cargoToml.slice(cargoToml.indexOf('[dependencies]'), winSectionAt);
    assert.doesNotMatch(mainDeps, /windows = \{/,
        'an unconditional dep would bloat macOS/Linux builds');

    // Locked, not floating: the crate graph CI compiles is the one audited.
    assert.match(cargoLock, /name = "windows"\nversion = "0\.58\.[^"]+"/,
        'the windows crate must be pinned in Cargo.lock');
});

test('Windows unlock calls the real UserConsentVerifier verification', () => {
    const block = windowsUnlockBlock();
    assert.match(block, /use windows::core::HSTRING;/);
    assert.match(block, /use windows::Security::Credentials::UI::\{/);
    assert.match(block, /UserConsentVerificationResult, UserConsentVerifier/);
    // The caller-provided reason reaches the OS prompt as an HSTRING.
    assert.match(block, /HSTRING::from\(reason\)/);
    assert.match(block, /UserConsentVerifier::RequestVerificationAsync\(&msg\)/,
        'the OS verifier must actually be invoked');
    // IAsyncOperation::get() blocks for the verdict; fire-and-forget would
    // report success before the user did anything.
    assert.match(block, /\.get\(\)/, 'the async operation must be awaited with .get()');
});

test('success is reachable only through a Verified verdict', () => {
    const block = windowsUnlockBlock();
    assert.match(block, /UserConsentVerificationResult::Verified/);
    const okCount = (block.match(/ok: true/g) || []).length;
    assert.equal(okCount, 1, 'exactly one success construction, inside the Verified arm');
    assert.ok(
        block.indexOf('UserConsentVerificationResult::Verified') < block.indexOf('ok: true'),
        'the success path must sit inside the Verified match arm',
    );
    // Every non-Verified outcome fails honestly with an error string.
    assert.match(block, /Ok\(other\) => UnlockResult/);
    assert.match(block, /Err\(e\) => UnlockResult/);
    assert.match(block, /ok: false/);
    assert.match(block, /error: Some\(/);
    // No stub: a bare unconditional success would prove nothing about the user.
    assert.doesNotMatch(block, /UnlockResult \{\s*ok: true\s*\}/);
});

test('the call site matches the windows 0.58 API shape exactly', () => {
    const block = windowsUnlockBlock();
    assert.match(block, /fn unlock_windows\(reason: &str\) -> UnlockResult/);
    // RequestVerificationAsync returns Result<IAsyncOperation<..>>: both the
    // launch error and the verdict error are handled, never unwrapped.
    assert.match(block, /match UserConsentVerifier::RequestVerificationAsync\(&msg\) \{/);
    assert.doesNotMatch(block, /\.unwrap\(\)|\.expect\(/);
    // The success method label is the honest identifier.
    assert.match(block, /method: Some\("windows_hello"\.into\(\)\)/);
});

test('Windows capabilities are reported as available with biometry', () => {
    const capAt = authRs.indexOf('pub fn capabilities');
    assert.ok(capAt > 0);
    const winCapAt = authRs.indexOf('#[cfg(target_os = "windows")]', capAt);
    assert.ok(winCapAt > 0);
    const winCap = authRs.slice(winCapAt, authRs.indexOf('#[cfg(', winCapAt + 1));
    assert.match(winCap, /available: true/);
    assert.match(winCap, /biometry: true/);
    assert.match(winCap, /Windows Hello/);
});
