import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stageNativeRdp } from '../scripts/stage-native-rdp.mjs';

const ONE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PUBLIC = path.resolve(ONE_ROOT, '..', 'public');
const currentBrowserFrame = "`/rdp.html?embed=1&v=cache-version&theme=${encodeURIComponent(frameTheme)}&tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}`";
const nativeFrame = "`about:blank#zephyr-one-native-rdp?tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}`";

function write(root, relative, content = '') {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(t, appSource = `frame.src = session.page === 'rdp' ? ${currentBrowserFrame} : '/terminal.html';\n`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-native-rdp-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'public/app.js', appSource);
  write(root, 'public/rdp.html', '<script src="rdp-wasm-client.js"></script>');
  write(root, 'public/rdp-wasm-client.js', "import './rdp-wasm-runtime.js';\n");
  write(root, 'public/vendor/rdp-wasm/main.wasm', Buffer.from([0, 97, 115, 109]));
  return root;
}

test('staging replaces the current browser URL regardless of query parameter order', (t) => {
  const root = fixture(t, fs.readFileSync(path.join(WEB_PUBLIC, 'app.js'), 'utf8'));

  const result = spawnSync(process.execPath, [path.join(ONE_ROOT, 'scripts/stage-native-rdp.mjs'), root], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const overlay = path.join(root, 'public/zephyr-one-native-rdp.js');
  const stagedApp = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.equal(stagedApp.split(nativeFrame).length - 1, 1);
  assert.doesNotMatch(stagedApp, /\/rdp\.html|rdp-wasm/i);
  assert.ok(fs.existsSync(overlay));
  assert.equal(fs.existsSync(path.join(root, 'public/rdp.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'public/rdp-wasm-client.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'public/vendor/rdp-wasm')), false);
});

test('staging rejects an RDP template that loses a native session binding', (t) => {
  const malformed = currentBrowserFrame.replace(
    "connectionId=${encodeURIComponent(session.connectionId || '')}",
    'connectionId=',
  );
  const root = fixture(t, `frame.src = ${malformed};\n`);

  assert.throws(() => stageNativeRdp(root), /invalid connectionId binding/);
  assert.equal(fs.existsSync(path.join(root, 'public/zephyr-one-native-rdp.js')), false);
});

test('staging rejects multiple browser RDP entries instead of leaving a fallback', (t) => {
  const root = fixture(t, `const first = ${currentBrowserFrame};\nconst fallback = ${currentBrowserFrame};\n`);

  assert.throws(() => stageNativeRdp(root), /expected one browser RDP frame entry.*found 2/);
});

test('staging rejects browser RDP references outside the replaced app entry', (t) => {
  const root = fixture(t);
  write(root, 'public/lazy-chunk.js', "location.href = '/rdp.html?embed=1';\n");

  assert.throws(
    () => stageNativeRdp(root),
    /browser RDP references remain in staged public assets: lazy-chunk\.js/,
  );
});

test('staging rejects a browser asset junction that escapes the staged root before mutating files', (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-native-rdp-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'outside must survive');

  const escape = path.join(root, 'public/vendor/rdp-wasm');
  fs.rmSync(escape, { recursive: true, force: true });
  try {
    fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links are unavailable on this platform: ${error.code || error.message}`);
    return;
  }

  const originalApp = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.throws(
    () => stageNativeRdp(root),
    /staged public tree contains a symlink or junction: public[\\/]vendor[\\/]rdp-wasm/,
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside must survive');
  assert.equal(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), originalApp);
  assert.ok(fs.existsSync(path.join(root, 'public/rdp.html')));
  assert.equal(fs.existsSync(path.join(root, 'public/zephyr-one-native-rdp.js')), false);
});
