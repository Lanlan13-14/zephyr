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
  assert.match(main, /startRuntime\(\)\.catch/);
  assert.doesNotMatch(main, /if \(windowsRelease\) kick\(\);/);
  assert.doesNotMatch(main, /await startRuntime\(\);\s*await enterProduct\(\);/s);
  assert.match(runtime, /state\.starting/);
  assert.match(main, /instanceId: body\.instanceId/);
  assert.match(runtime, /instanceId: String\(instanceId \|\| ''\)/);
});
