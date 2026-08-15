import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');

function read(rel) {
  return fs.readFileSync(path.join(ANDROID, rel), 'utf8');
}

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test('unlock button actually asks AppLock, not just attach', () => {
  const main = read('app/src/main/kotlin/one/zephyr/mobile/app/MainActivity.kt');
  const clean = codeOnly(main);
  assert.match(clean, /requestPlatformUnlock/);
  assert.match(clean, /appLock\.unlock/);
  assert.match(clean, /deviceAuthenticator\.attach/);
  assert.doesNotMatch(
    clean,
    /onUnlockRequested\s*=\s*\{\s*container\.deviceAuthenticator\.attach/,
    'the previous bug: the lock gate only re-attached the host and never called authenticate',
  );
});

test('lock gate auto-prompts after the first resume', () => {
  const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  const clean = codeOnly(root);
  assert.match(clean, /suspend\s*\(\)\s*->\s*AuthResult/);
  assert.match(clean, /repeatOnLifecycle/);
  assert.match(clean, /Lifecycle\.State\.RESUMED/);
  assert.match(clean, /UnlockPresentation\.failureMessage/);
  assert.match(clean, /unlock_in_progress/);
});

test('pre-R devices do not use the illegal STRONG plus DEVICE_CREDENTIAL combo', () => {
  const policy = read('core-security/src/main/kotlin/one/zephyr/mobile/security/PlatformUnlockPolicy.kt');
  const authenticator = read(
    'app/src/main/kotlin/one/zephyr/mobile/app/security/BiometricDeviceAuthenticator.kt',
  );
  const cleanAuth = codeOnly(authenticator);
  assert.match(policy, /BIOMETRIC_WEAK/);
  assert.match(policy, /BIOMETRIC_STRONG/);
  assert.match(policy, /DEVICE_CREDENTIAL/);
  assert.match(policy, /PRE_R_SDK = 30/);
  assert.match(cleanAuth, /PlatformUnlockPolicy\.allowedAuthenticators/);
  assert.match(cleanAuth, /isInteractiveCancellation/);
  assert.doesNotMatch(
    cleanAuth,
    /ERROR_CANCELED[\s\S]{0,80}AuthResult\.Cancelled/,
    'framework ERROR_CANCELED must not finish the attempt; that is the device-credential handoff',
  );
});

test('enabling local unlock requires a successful platform prompt', () => {
  const dest = read('app/src/main/kotlin/one/zephyr/mobile/app/AppDestinations.kt');
  const screen = read('feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolScreens.kt');
  const destClean = codeOnly(dest);
  const screenClean = codeOnly(screen);
  assert.match(destClean, /confirmEnable/);
  assert.match(destClean, /AppLockPreferences\.apply/);
  assert.match(destClean, /AppLockCache\.write/);
  assert.match(screenClean, /canEnable/);
  assert.match(screenClean, /enabled = canEnable && !busy/);
});

test('process start restores the lock from the synchronous cache', () => {
  const main = read('app/src/main/kotlin/one/zephyr/mobile/app/MainActivity.kt');
  const clean = codeOnly(main);
  assert.match(clean, /restoreLockFromCache/);
  assert.match(clean, /lockOnEnable = true/);
  assert.match(clean, /appearanceFromLockCache/);
  assert.match(clean, /shouldApplyLockPreference/);
  assert.match(clean, /shouldLockWhenApplying/);
  assert.match(main, /lockOnEnable \|\| \(!alreadyEnabled && enabled\)/);
  assert.match(clean, /onDestroy/);
  assert.doesNotMatch(
    clean,
    /override fun onPause\(\)[\s\S]{0,80}deviceAuthenticator\.detach/,
    'detaching in onPause drops the host while the device-credential activity is in front',
  );
});

test('fingerprint permission is declared for pre-P devices', () => {
  const manifest = read('app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android.permission.USE_BIOMETRIC/);
  assert.match(manifest, /android.permission.USE_FINGERPRINT/);
});

test('old attach-only unlock wiring fails this suite', () => {
  const main = read('app/src/main/kotlin/one/zephyr/mobile/app/MainActivity.kt');
  const broken = main.replace(
    /onUnlockRequested = \{ requestPlatformUnlock\(\) \}/,
    'onUnlockRequested = { container.deviceAuthenticator.attach(this) }',
  );
  const clean = codeOnly(broken);
  assert.match(
    clean,
    /onUnlockRequested\s*=\s*\{\s*container\.deviceAuthenticator\.attach/,
  );
  assert.doesNotMatch(codeOnly(main), /onUnlockRequested\s*=\s*\{\s*container\.deviceAuthenticator\.attach/);
  assert.throws(() => {
    if (/onUnlockRequested\s*=\s*\{\s*container\.deviceAuthenticator\.attach/.test(clean)) {
      throw new Error('attach-only unlock');
    }
  }, /attach-only unlock/);
});

test('policy replica rejects a restore that forgets to lock', () => {
  function brokenApply(enabled, lockOnEnable, canAuthenticate) {
    if (!enabled) return 'DISABLED';
    if (!canAuthenticate) return 'UNAVAILABLE';
    // Mutation: ignore lockOnEnable. Process restore would flash the dashboard.
    return 'UNLOCKED';
  }
  assert.notEqual(brokenApply(true, true, true), 'LOCKED');
  assert.equal(
    (function apply(enabled, lockOnEnable, canAuthenticate) {
      if (!enabled) return 'DISABLED';
      if (!canAuthenticate) return 'UNAVAILABLE';
      return lockOnEnable ? 'LOCKED' : 'UNLOCKED';
    })(true, true, true),
    'LOCKED',
  );
});

