import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const DRAFT = path.join(ANDROID, 'feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionDraft.kt');
const EDITOR = path.join(ANDROID, 'feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt');
const ROOT_KT = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const CONTAINER = path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt');
const HOST = path.join(ANDROID, 'feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SshTerminalHost.kt');
const ROUTES = path.join(ANDROID, 'feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SessionRoutes.kt');
const ENGINE = path.join(ANDROID, 'protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('new connections start with a visible password field', () => {
  const draft = read(DRAFT);
  assert.match(draft, /password = SecretState\.Replace\(""\)/);
  assert.match(draft, /outgoingSecret/);
  const editor = read(EDITOR);
  assert.match(editor, /if \(stored\.hasValue\)/);
  assert.match(editor, /KeyboardType\.Password/);
});

test('app wires SSHJ instead of the unavailable stub', () => {
  const root = read(ROOT_KT);
  assert.match(root, /SshTerminalHost\(/);
  assert.match(root, /productionTerminalEmulator\(/);
  assert.doesNotMatch(root, /emulator = SimpleVtEmulator\(/);
  assert.match(root, /autoConnect = true/);
  assert.doesNotMatch(root, /UnavailableTerminalHost\(TERMINAL_ENGINE_MISSING\)/);
  assert.match(read(CONTAINER), /SshjEngine\(/);
  assert.match(read(HOST), /class SshTerminalHost/);
  assert.match(read(ENGINE), /class SshjEngine/);
});

test('terminal uses the system IME by default', () => {
  const routes = read(ROUTES);
  assert.match(routes, /mutableStateOf\(true\)/);
  assert.doesNotMatch(routes, /fake-ime/);
});
