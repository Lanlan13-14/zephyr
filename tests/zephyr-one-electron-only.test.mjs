import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const one = path.join(root, 'zephyr_one');
const read = (relative) => fs.readFileSync(path.join(one, relative), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('Electron is the only desktop host and has no obsolete native RDP injector', () => {
  for (const relative of ['src-tauri', 'scripts/tauri.freerdp.windows.json',
    'scripts/stage-native-rdp.mjs', 'src/rdp/native-rdp-client.js',
    'src/rdp/native-rdp-embedded.js']) {
    assert.equal(fs.existsSync(path.join(one, relative)), false, relative);
  }
  assert.equal(pkg.main, 'electron/main.mjs');
  for (const file of ['package.json', 'package-lock.json', 'vite.config.js',
    'electron/main.mjs', 'electron/preload.cjs', 'src/main.js']) {
    assert.doesNotMatch(read(file), /src-tauri|__TAURI|@tauri-apps|TAURI_ENV|isTauri/);
  }
  assert.match(read('src/main.js'), /window\.zephyrOne\.invoke/);
  assert.match(read('electron/preload.cjs'), /exposeInMainWorld\('zephyrOne'/);
  for (const command of ['runtime_start', 'runtime_enter', 'runtime_stop',
    'runtime_restart', 'auth_unlock', 'auth_capabilities', 'set_theme_icon']) {
    assert.ok(read('electron/main.mjs').includes(`ipcMain.handle('${command}'`), command);
  }
});

test('neutral desktop artwork resolves both in development and packaged resources', () => {
  const runtime = pkg.build.extraResources.find((item) => item.to === 'runtime-icons');
  assert.equal(runtime.from, 'platform_assets/desktop/runtime-icons');
  for (const theme of ['frost', 'lava', 'asagi', 'cyber']) {
    assert.ok(fs.existsSync(path.join(one, runtime.from, `zephyr-one-${theme}.png`)));
  }
  for (const platform of ['win', 'mac', 'linux']) {
    assert.ok(fs.existsSync(path.join(one, pkg.build[platform].icon)));
    assert.match(pkg.build[platform].icon, /^platform_assets\/desktop\/icons/);
  }
  const main = read('electron/main.mjs');
  assert.match(main, /process\.resourcesPath, 'runtime-icons'/);
  assert.match(main, /if \(app\.isPackaged\) return path\.join\(iconsDir\(\), 'zephyr-one-frost\.png'\)/);
  assert.equal(main.match(/icon: windowIconPath\(\)/g)?.length, 2);
});

test('desktop preserves Web RDP and shared mobile native libraries', () => {
  const stage = read('scripts/stage-zephyr-core.sh');
  assert.match(stage, /for d in public server preview src/);
  assert.doesNotMatch(stage, /stage-native-rdp|src\/rdp|zephyr-one-native-rdp/);
  const transform = fs.readFileSync(path.join(root, 'zephyr-one-embed-surface.js'), 'utf8');
  assert.doesNotMatch(transform, /native-rdp-(?:client|embedded)|zephyr-one-native-rdp\.js/);
  for (const relative of ['public/rdp.html', 'public/rdp-wasm-client.js',
    'zephyr_one/native/freerdp-core/zephyr_rdp.c', 'zephyr_one/mobile/android',
    'zephyr_one/mobile/ios']) assert.ok(fs.existsSync(path.join(root, relative)), relative);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/zephyr-one.yml'), 'utf8');
  assert.match(workflow, /test -f zephyr-core\/public\/rdp\.html/);
  assert.match(workflow, /test -f zephyr-core\/public\/rdp-wasm-client\.js/);
});
