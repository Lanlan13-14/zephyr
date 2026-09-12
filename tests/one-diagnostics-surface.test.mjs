import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

test('One diagnostics is a real sync page, not the about screen', () => {
  const route = read('zephyr_one/mobile/android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ConnectedScreens.kt');
  assert.match(route, /PushedPageHeader\(title = "诊断"/);
  assert.doesNotMatch(route, /PushedPageHeader\(title = "关于 Zephyr One"/);
  assert.match(route, /最近错误/);
  assert.match(route, /persistedDiagnosticText\(\)/);
});

test('Zephyr Link tool summary is live pending count, not a hardcoded 3', () => {
  const summaries = read('zephyr_one/mobile/android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolsRootScreen.kt');
  assert.doesNotMatch(summaries, /3 项待同步/);
  const root = read('zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  assert.match(root, /pendingCount/);
  assert.match(root, /项待同步/);
});

test('device list uses the dual SID/DeviceAccess plane', () => {
  const routes = read('mobile-v1-routes.js');
  assert.match(routes, /requireSidOrDeviceAccess/);
  assert.match(routes, /handleListDevices[\s\S]*requireSidOrDeviceAccess/);
  const screens = read('zephyr_one/mobile/android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ConnectedScreens.kt');
  assert.match(screens, /当前账号还没有已注册的 One 设备/);
  assert.match(screens, /api\.devices\(\)/);
});
