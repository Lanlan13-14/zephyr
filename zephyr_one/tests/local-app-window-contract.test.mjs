import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('runtime hands the authenticated session to a top-level loopback window', () => {
  const runtime = read('electron/runtime.mjs');
  const main = read('electron/main.mjs');
  assert.match(runtime, /const LOCAL_APP_PATH = '\/app\.html\?zephyrOne=1'/);
  assert.match(runtime, /httpOnly:\s*true/);
  assert.match(runtime, /sameSite:\s*'lax'/);
  assert.doesNotMatch(runtime, /domain:\s*'127\.0\.0\.1'/);
  assert.match(main, /cookies\.remove\(cookie\.url, cookie\.name\)/);
  assert.match(main, /cookies\.set\(cookie\)/);
  assert.match(main, /productWindow\.loadURL\(target\)/);
  assert.match(main, /mainWindow\.hide\(\)/);
  assert.match(main, /preload: preloadPath\(\)/);
});

test('local product navigation and window lifecycle fail closed', () => {
  const main = read('electron/main.mjs');
  assert.match(main, /will-navigate/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /action: 'deny'/);
  assert.match(main, /app\.quit\(\)/);
});

test('the product session is partitioned and external links fail closed', () => {
  /* Electron official hardening: the loopback core's cookie lives on a
   * dedicated partition (never defaultSession), and only https:// leaves
   * via shell.openExternal. Plain http:// and the loopback origin itself
   * are denied without launching. */
  const main = read('electron/main.mjs');
  assert.match(main, /fromPartition\('persist:zephyr-one'/);
  assert.match(main, /partition: 'persist:zephyr-one'/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /callback\(false\)/);
  assert.match(main, /url\.startsWith\('https:\/\/'\)/);
  assert.doesNotMatch(main, /url\.startsWith\('http:\/\/127\.0\.0\.1:'\) \|\| url\.startsWith\('https:\/\/'\) \|\| url\.startsWith\('http:\/\/'\)/);
});

test('window-bound IPC acts only on the sender window', () => {
  /* Official guidance is to validate the sender of every IPC message: each
   * window command resolves its window from event.sender and refuses
   * orphaned senders instead of touching a global window handle. */
  const main = read('electron/main.mjs');
  assert.match(main, /function senderWindow\(event\)/);
  assert.match(main, /senderWindow\(event\)\?\.minimize/);
  assert.match(main, /senderWindow\(event\)\?\.close/);
  assert.match(main, /const window = senderWindow\(event\);/);
});

test('About shows the full display build including the pre suffix', () => {
  /* one-v0.1.20pre15 must read 0.1.20pre15 in About, not bare 0.1.20.
   * app.getVersion() is marketing-only; the suffix travels on
   * ZEPHYR_ONE_FULL_VERSION / ZEPHYR_ONE_PRERELEASE. */
  const main = read('electron/main.mjs');
  const runtime = read('electron/runtime.mjs');
  assert.match(main, /function displayVersion/);
  assert.match(main, /ZEPHYR_ONE_FULL_VERSION/);
  assert.match(main, /ZEPHYR_ONE_PRERELEASE/);
  assert.match(main, /ipcMain\.handle\('get_app_version', \(\) => displayVersion\(\)\)/);
  assert.match(runtime, /ZEPHYR_ONE_FULL_VERSION/);
  assert.match(runtime, /ZEPHYR_ONE_PRERELEASE/);
});

test('trusted shell explicitly enters only after runtime_start returns', () => {
  const renderer = read('src/main.js');
  const main = read('electron/main.mjs');
  const start = renderer.indexOf("await safeInvoke('runtime_start')");
  const enter = renderer.indexOf("await safeInvoke('runtime_enter')", start);
  assert.ok(start >= 0 && enter > start);
  assert.match(main, /ipcMain\.handle\('runtime_enter'/);
  assert.match(main, /ipcMain\.handle\('runtime_restart'/);
});

test('release autostart starts only the child and defers every WebView operation', () => {
  const runtime = read('electron/runtime.mjs');
  const main = read('electron/main.mjs');
  assert.match(runtime, /export function shouldAutostart/);
  assert.match(main, /shouldAutostart\(process\.env\.ZEPHYR_ONE_AUTOSTART_RUNTIME, windowsRelease\)/);
  assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'com\.zephyr\.one'\)\)/);
  assert.match(main, /startRuntime\(\)/);
  assert.match(main, /\.then\(\(\) => enterProduct\(\)\)/);
  assert.doesNotMatch(main, /if \(windowsRelease\) kick\(\);/);
  assert.match(runtime, /state\.starting/);
  const overlayAt = main.indexOf("path.join(app.getAppPath(), 'dist', 'index.html')");
  const autostartAt = main.indexOf('.then(() => enterProduct())');
  assert.ok(overlayAt >= 0 && autostartAt > overlayAt, 'overlay must load before autostart enters the product');
  assert.match(main, /instanceId: body\.instanceId/);
  assert.match(runtime, /instanceId: String\(instanceId \|\| ''\)/);
});
