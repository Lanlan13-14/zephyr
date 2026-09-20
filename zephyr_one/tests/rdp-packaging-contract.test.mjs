import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.dirname(ROOT);
const STAGE = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-zephyr-core.sh'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');

test('standalone Web WASM RDP is a required source distribution surface', () => {
  const webPublic = path.join(REPO, 'public');
  for (const relative of [
    'rdp.html',
    'rdp-wasm-client.js',
    'rdp-wasm-runtime.js',
    'rdp-worker.js',
    'vendor/rdp-wasm/main.wasm',
  ]) {
    assert.ok(fs.existsSync(path.join(webPublic, ...relative.split('/'))), `missing ${relative}`);
  }
  assert.match(fs.readFileSync(path.join(webPublic, 'rdp.html'), 'utf8'), /rdp-wasm-client\.js/);
  assert.match(fs.readFileSync(path.join(webPublic, 'app.js'), 'utf8'), /\/rdp\.html\?/);
});

test('staged desktop One keeps the Web RDP client', () => {
  assert.doesNotMatch(STAGE, /stage-native-rdp\.mjs/);
  assert.match(STAGE, /WASM RDP/);
});

test('the Electron workflow stages rdp.html instead of stripping it', () => {
  assert.match(WORKFLOW, /test -f zephyr-core\/public\/rdp\.html/);
  assert.match(WORKFLOW, /test -f zephyr-core\/public\/rdp-wasm-client\.js/);
  assert.doesNotMatch(WORKFLOW, /verify-rdp-packaging\.mjs/);
});
