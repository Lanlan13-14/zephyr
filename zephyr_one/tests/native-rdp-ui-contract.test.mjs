import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const stage = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-zephyr-core.sh'), 'utf8');

test('desktop One no longer injects a native RDP shell controller', () => {
  assert.doesNotMatch(renderer, /createNativeRdpShellController/);
  assert.doesNotMatch(renderer, /rdp_native_connect/);
  assert.doesNotMatch(stage, /stage-native-rdp\.mjs/);
});
