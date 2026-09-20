import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-zephyr-core.sh'), 'utf8');

test('desktop One no longer links a patched FreeRDP clipboard reassembler', () => {
  assert.doesNotMatch(stage, /cliprdr/);
  assert.doesNotMatch(stage, /stage-native-rdp/);
});
