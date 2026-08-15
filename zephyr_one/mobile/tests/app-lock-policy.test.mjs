import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// androidx.biometric constants. Kept numeric so this suite runs without an Android SDK.
const BIOMETRIC_STRONG = 0x000f;
const BIOMETRIC_WEAK = 0x00ff;
const DEVICE_CREDENTIAL = 0x8000;
const ERROR_CANCELED = 5;
const ERROR_USER_CANCELED = 10;
const ERROR_NEGATIVE_BUTTON = 13;
const ERROR_LOCKOUT = 7;
const ERROR_HW_UNAVAILABLE = 1;

function allowedAuthenticators(sdkInt) {
  return sdkInt >= 30
    ? BIOMETRIC_STRONG | DEVICE_CREDENTIAL
    : BIOMETRIC_WEAK | DEVICE_CREDENTIAL;
}

function isInteractiveCancellation(code) {
  return code === ERROR_USER_CANCELED || code === ERROR_NEGATIVE_BUTTON;
}

function timeoutWire(delay) {
  if (delay === 'ONE_MINUTE') return '1m';
  if (delay === 'FIVE_MINUTES') return '5m';
  return 'immediate';
}

function timeoutFromWire(raw) {
  if (raw === '1m') return 'ONE_MINUTE';
  if (raw === '5m') return 'FIVE_MINUTES';
  return 'IMMEDIATE';
}

function failureMessage(result, unavailable) {
  if (result.kind === 'success' || result.kind === 'cancelled') return null;
  return result.canAuthenticate ? result.message : unavailable;
}

function applyLock({ state, delay }, enabled, nextDelay, lockOnEnable, canAuthenticate) {
  if (!enabled) {
    return { result: 'DISABLED', state: 'DISABLED', delay: 'IMMEDIATE' };
  }
  if (state !== 'DISABLED') {
    return { result: 'ALREADY_ENABLED', state, delay: nextDelay };
  }
  if (!canAuthenticate) {
    return { result: 'UNAVAILABLE', state: 'DISABLED', delay };
  }
  if (lockOnEnable) {
    return { result: 'LOCKED', state: 'LOCKED', delay: nextDelay };
  }
  return { result: 'UNLOCKED', state: 'UNLOCKED', delay: nextDelay };
}

test('pre-R combo is weak plus device credential, R+ is strong plus device credential', () => {
  assert.equal(allowedAuthenticators(26), BIOMETRIC_WEAK | DEVICE_CREDENTIAL);
  assert.equal(allowedAuthenticators(29), BIOMETRIC_WEAK | DEVICE_CREDENTIAL);
  assert.equal(allowedAuthenticators(30), BIOMETRIC_STRONG | DEVICE_CREDENTIAL);
  assert.equal(allowedAuthenticators(35), BIOMETRIC_STRONG | DEVICE_CREDENTIAL);
  assert.notEqual(allowedAuthenticators(29), allowedAuthenticators(30));
});

test('framework cancel is not an interactive dismissal', () => {
  assert.equal(isInteractiveCancellation(ERROR_USER_CANCELED), true);
  assert.equal(isInteractiveCancellation(ERROR_NEGATIVE_BUTTON), true);
  assert.equal(isInteractiveCancellation(ERROR_CANCELED), false);
  assert.equal(isInteractiveCancellation(ERROR_LOCKOUT), false);
  assert.equal(isInteractiveCancellation(ERROR_HW_UNAVAILABLE), false);
});

test('timeout wire rejects unknown values', () => {
  assert.equal(timeoutFromWire(timeoutWire('IMMEDIATE')), 'IMMEDIATE');
  assert.equal(timeoutFromWire(timeoutWire('ONE_MINUTE')), 'ONE_MINUTE');
  assert.equal(timeoutFromWire(timeoutWire('FIVE_MINUTES')), 'FIVE_MINUTES');
  assert.equal(timeoutFromWire(null), 'IMMEDIATE');
  assert.equal(timeoutFromWire('tomorrow'), 'IMMEDIATE');
});

test('unlock failure copy keeps platform text only when hardware works', () => {
  assert.equal(failureMessage({ kind: 'success' }, '不可用'), null);
  assert.equal(failureMessage({ kind: 'cancelled' }, '不可用'), null);
  assert.equal(
    failureMessage({ kind: 'failed', canAuthenticate: true, message: '指纹不匹配' }, '不可用'),
    '指纹不匹配',
  );
  assert.equal(
    failureMessage({ kind: 'failed', canAuthenticate: false, message: 'none' }, '不可用'),
    '不可用',
  );
});

function roomApply(alreadyEnabled, enabled, lockOnEnable, canAuthenticate) {
  const restoreLock = lockOnEnable || (!alreadyEnabled && enabled);
  const state = alreadyEnabled ? 'UNLOCKED' : 'DISABLED';
  return applyLock({ state, delay: 'IMMEDIATE' }, enabled, 'IMMEDIATE', restoreLock, canAuthenticate);
}

test('settings enable stays unlocked; process restore locks; empty disable is a no-op path', () => {
  const enabled = applyLock({ state: 'DISABLED', delay: 'IMMEDIATE' }, true, 'FIVE_MINUTES', false, true);
  assert.deepEqual(enabled, { result: 'UNLOCKED', state: 'UNLOCKED', delay: 'FIVE_MINUTES' });

  const restored = applyLock({ state: 'DISABLED', delay: 'IMMEDIATE' }, true, 'IMMEDIATE', true, true);
  assert.deepEqual(restored, { result: 'LOCKED', state: 'LOCKED', delay: 'IMMEDIATE' });

  const already = applyLock({ state: 'LOCKED', delay: 'IMMEDIATE' }, true, 'ONE_MINUTE', true, true);
  assert.deepEqual(already, { result: 'ALREADY_ENABLED', state: 'LOCKED', delay: 'ONE_MINUTE' });

  const off = applyLock({ state: 'UNLOCKED', delay: 'ONE_MINUTE' }, false, 'ONE_MINUTE', true, true);
  assert.deepEqual(off, { result: 'DISABLED', state: 'DISABLED', delay: 'IMMEDIATE' });

  const unavailable = applyLock({ state: 'DISABLED', delay: 'IMMEDIATE' }, true, 'IMMEDIATE', true, false);
  assert.deepEqual(unavailable, { result: 'UNAVAILABLE', state: 'DISABLED', delay: 'IMMEDIATE' });

  assert.equal(roomApply(false, true, false, true).result, 'LOCKED', 'Room-only restore must lock');
  assert.equal(roomApply(true, true, false, true).result, 'ALREADY_ENABLED', 'in-session enable stays unlocked');
  assert.equal(roomApply(false, false, false, true).result, 'DISABLED', 'empty disable stays off');
});

test('kotlin sources still encode the same policy the replica executes', () => {
  const policy = fs.readFileSync(
    path.join(ROOT, 'android/core-security/src/main/kotlin/one/zephyr/mobile/security/PlatformUnlockPolicy.kt'),
    'utf8',
  );
  const prefs = fs.readFileSync(
    path.join(ROOT, 'android/core-security/src/main/kotlin/one/zephyr/mobile/security/AppLock.kt'),
    'utf8',
  );
  const presentation = fs.readFileSync(
    path.join(ROOT, 'android/core-security/src/main/kotlin/one/zephyr/mobile/security/UnlockPresentation.kt'),
    'utf8',
  );
  assert.match(policy, /PRE_R_SDK = 30/);
  assert.match(policy, /BIOMETRIC_WEAK or\s+BiometricManager\.Authenticators\.DEVICE_CREDENTIAL/);
  assert.match(policy, /BIOMETRIC_STRONG or\s+BiometricManager\.Authenticators\.DEVICE_CREDENTIAL/);
  assert.match(policy, /ERROR_USER_CANCELED/);
  assert.match(policy, /ERROR_NEGATIVE_BUTTON/);
  assert.doesNotMatch(
    policy,
    /isInteractiveCancellation[\s\S]*ERROR_CANCELED/,
    'ERROR_CANCELED must stay out of interactive cancellation',
  );
  assert.match(prefs, /lockOnEnable/);
  assert.match(prefs, /AppLockApplyResult\.LOCKED/);
  assert.match(prefs, /AppLockApplyResult\.UNLOCKED/);
  assert.match(presentation, /result\.availability\.canAuthenticate/);
});

test('python AppLock replica matches the Kotlin JUnit cases', () => {
  const replica = path.join(ROOT, 'tests/app-lock-junit-replica.py');
  const result = spawnSync('python3', [replica], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /all cases passed/);
});

test('python replica fails if lockOnEnable is deleted', () => {
  const replica = fs.readFileSync(path.join(ROOT, 'tests/app-lock-junit-replica.py'), 'utf8');
  assert.match(replica, /if lock_on_enable:/);
  const mutated = replica.replace(
    /if lock_on_enable:\n        lock\.lock_now\(\)\n        return AppLockApplyResult\.LOCKED\n    return AppLockApplyResult\.UNLOCKED/,
    'return AppLockApplyResult.UNLOCKED',
  );
  assert.doesNotMatch(mutated, /if lock_on_enable:/);
  const tmp = path.join(ROOT, 'tests/.app-lock-junit-replica.mutated.py');
  fs.writeFileSync(tmp, mutated);
  try {
    const result = spawnSync('python3', [tmp], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'deleting lockOnEnable must fail the restore case');
    assert.match(result.stderr + result.stdout, /process restore locks|FAIL/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

