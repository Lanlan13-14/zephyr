import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const vm = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalViewModel.kt');
const screen = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt');
const bridge = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TermuxSessionBridge.kt');
const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const sshj = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');

test('accepting a first host key leaves CONNECTING before redial', () => {
  assert.match(vm, /trustHostKey\(sessionId\)[\s\S]*setTransport\(sessionId, SessionTransport\.DISCONNECTED[\s\S]*connect\(\)/);
});

test('real terminal canvas alone drives PTY geometry', () => {
  assert.match(screen, /\.onSizeChanged\s*\{[\s\S]*containerW = it\.width[\s\S]*containerH = it\.height/);
  assert.match(screen, /shortcutMatrixHeightPx = 0f/);
  assert.match(screen, /dockHeightPx = 0f/);
});

test('Termux system IME writes are bound to SSH and failures are caught', () => {
  assert.match(bridge, /fun bindWriteBytes/);
  assert.doesNotMatch(bridge, /writeBytes\s*=\s*\{\}/);
  assert.match(vm, /termux\?\.bindWriteBytes/);
  assert.match(vm, /runCatching \{ delegatingTransport\.write\(bytes\) \}/);
});

test('SSHJ implements shell, SFTP, exec and tcp-handshake latency', () => {
  assert.match(sshj, /newSFTPClient\(\)/);
  assert.match(sshj, /startSession\(\)/);
  assert.match(sshj, /Socket\(\)/);
  assert.match(sshj, /InetSocketAddress\(host, port\)/);
  assert.match(sshj, /remoteHostname/);
  assert.doesNotMatch(sshj, /Result\.failure\(UnsupportedOperationException/);
});

test('editor and batch execution no longer use unavailable ports', () => {
  assert.match(root, /DirectSshConnectionTester/);
  assert.match(root, /LiveSshExecPort/);
  assert.doesNotMatch(root, /exec\s*=\s*UnavailableRemotePorts/);
});

test('remote close pops terminal route', () => {
  assert.match(root, /SessionTransport\.CLOSED[\s\S]*RootRoute\.Root\(IslandDestination\.SESSIONS\)/);
});

test('terminal copy captures ClipboardManager outside the onCopy lambda', () => {
  // PR #29 merge failed here: LocalClipboardManager.current is @Composable and
  // cannot be read from productionTerminalEmulator's onCopy callback.
  assert.match(root, /val clipboardManager = LocalClipboardManager\.current/);
  assert.match(root, /clipboardManager\.setText\(AnnotatedString\(text\)\)/);
  assert.doesNotMatch(root, /onCopy = \{ text ->[\s\S]*LocalClipboardManager\.current/);
});

