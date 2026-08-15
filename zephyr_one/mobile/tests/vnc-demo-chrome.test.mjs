import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');

const read = (rel) => fs.readFileSync(path.join(ANDROID, rel), 'utf8');

const chrome = read('feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteChrome.kt');
const screen = read('feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteScreen.kt');
const routes = read('feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteRoutes.kt');
const viewModel = read('feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/VncViewModel.kt');
const engine = read('protocol-vnc/src/main/kotlin/one/zephyr/mobile/protocol/vnc/VncEngine.kt');
const socket = read('protocol-vnc/src/main/kotlin/one/zephyr/mobile/protocol/vnc/SocketVncEngine.kt');
const pixel = read('protocol-vnc/src/main/kotlin/one/zephyr/mobile/protocol/vnc/VncPixelFormat.kt');
const latency = read('protocol-vnc/src/main/kotlin/one/zephyr/mobile/protocol/vnc/RfbUpdateLatency.kt');

test('VNC tool strip is the demo nine-item set', () => {
  assert.match(chrome, /POINTER_MODE, KEYBOARD, VNC_QUALITY, FIT, ZOOM, CLIPBOARD/);
  assert.match(chrome, /JOYSTICK, RECONNECT, DISCONNECT/);
  assert.doesNotMatch(chrome, /Protocol\.VNC -> listOf\([\s\S]*DRIVE/);
});

test('VNC quality cycles 高质量 RGB888 / 平衡 RGB565 / 性能 RGB555', () => {
  assert.match(viewModel, /HIGH\("高质量", RfbPixelFormat\.RGB888\)/);
  assert.match(viewModel, /BALANCED\("平衡", RfbPixelFormat\.RGB565\)/);
  assert.match(viewModel, /PERFORMANCE\("性能", RfbPixelFormat\.RGB555\)/);
  assert.match(pixel, /val RGB555 = RfbPixelFormat\(/);
  assert.match(viewModel, /fun cycleQuality\(\)/);
  assert.match(routes, /RemoteIntent\.CycleQuality -> viewModel\.cycleQuality\(\)/);
  assert.match(screen, /RemoteDockItem\.VNC_QUALITY -> onIntent\(RemoteIntent\.CycleQuality\)/);
});

test('status pill latency comes from a measured update RTT', () => {
  assert.match(engine, /fun latency\(sessionId: String\): Flow<Long>/);
  assert.match(socket, /override fun latency\(sessionId: String\)/);
  assert.match(socket, /updateLatency\.markRequested\(\)/);
  assert.match(socket, /updateLatency\.sample\(\)/);
  assert.match(viewModel, /engine\.latency\(sessionId\)\.collect/);
  assert.match(viewModel, /registry\.setLatency\(sessionId, sample\)/);
  assert.match(screen, /VncDemoStatus\.latencyLabel/);
  assert.match(latency, /const val MIN_MS = 1L/);
  assert.match(viewModel, /fun statusText\(/);
});

test('disconnect still pops the opened VNC window', () => {
  const vnc = routes.slice(routes.indexOf('private fun dispatchVnc'));
  assert.match(vnc, /RemoteIntent\.Disconnect -> \{[\s\S]*viewModel\.disconnect\(\)[\s\S]*onBack\(\)/);
  assert.match(viewModel, /SESSION_CLOSED/);
});

test('the python replica of the latency sampler is green', () => {
  const replica = path.join(ROOT, 'tests/vnc-update-latency-replica.py');
  const result = spawnSync('python3', [replica], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
