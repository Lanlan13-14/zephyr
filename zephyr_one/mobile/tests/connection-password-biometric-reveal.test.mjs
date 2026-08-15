import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const lock = read('core-security/src/main/kotlin/one/zephyr/mobile/security/AppLock.kt');
const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const vm = read('feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorViewModel.kt');
const ui = read('feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt');
const route = read('feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionRoutes.kt');

test('local reveal refuses when app lock is disabled', () => {
  const reveal = lock.slice(lock.indexOf('suspend fun confirmLocalReveal'), lock.indexOf('/** Unbind'));
  assert.match(reveal, /if \(!isEnabled\)/);
  assert.match(reveal, /local unlock is disabled/);
  assert.match(lock, /suspend fun confirmEnable/);
});

test('password reveal requires enabled lock and revealSecret capability twice', () => {
  assert.match(vm, /ConnectionPasswordRevealPolicy\.allowed/);
  assert.match(vm, /localUnlockEnabled = passwordRevealEnabled\(\)/);
  assert.match(vm, /hasStoredPassword = existing\.password\.hasValue/);
  assert.match(vm, /canRevealSecret = existing\.capabilities\.canRevealSecret/);
  assert.match(vm, /\|\| !content\.passwordRevealAllowed/);
  assert.match(root, /if \(!appContainer\.appLock\.isEnabled \|\| !connection\.capabilities\.canRevealSecret\) return null/);
  assert.match(root, /confirmLocalReveal/);
  assert.match(root, /secretStore\.getText\(ref\)/);
});

test('reveal UI is absent unless allowed and reveals in place', () => {
  assert.match(ui, /if \(revealAllowed && state is SecretState\.Unchanged\)/);
  assert.match(ui, /revealedValue != null/);
  assert.match(ui, /onEditRevealed\(value\)/);
  assert.match(ui, /EditorIntent\.RevealPassword/);
  assert.match(ui, /EditorIntent\.HidePassword/);
});

test('revealed password clears on timer lock background and disposal', () => {
  assert.match(vm, /PASSWORD_REVEAL_MS = 30_000L/);
  assert.match(vm, /revealedPassword = null/);
  assert.match(vm, /override fun onLocked\(\)/);
  assert.match(route, /repeatOnLifecycle\(Lifecycle\.State\.STARTED\)/);
  assert.match(route, /finally \{[\s\S]*viewModel\.hidePassword\(\)/);
  assert.match(route, /onDispose\(viewModel::clearSecretBuffers\)/);
});
