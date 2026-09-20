import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

test('desktop One does not expose a native RDP connect command', () => {
  assert.doesNotMatch(main, /rdp_native_connect/);
  assert.doesNotMatch(renderer, /rdp_native_connect/);
});
