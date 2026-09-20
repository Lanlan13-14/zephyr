import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('desktop One no longer registers a native RDP surface command set', () => {
  const main = read('zephyr_one/electron/main.mjs');
  assert.doesNotMatch(main, /rdp_native_surface_/);
  assert.doesNotMatch(read('zephyr_one/src/main.js'), /rdp_native_surface_/);
});

test('embedded One keeps the Web RDP proxy and WASM client', () => {
  const server = read('server.js');
  assert.match(server, /pathname === '\/rdp-proxy'/);
  assert.doesNotMatch(server, /ZEPHYR_ONE_EMBEDDED && pathname === '\/rdp-proxy'/);
  assert.match(read('public/app.js'), /\/rdp\.html\?/);
});
