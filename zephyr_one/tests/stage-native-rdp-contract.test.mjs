import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ONE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = fs.readFileSync(path.join(ONE_ROOT, 'scripts', 'stage-zephyr-core.sh'), 'utf8');

test('desktop staging no longer replaces Web RDP with a native marker', () => {
  assert.doesNotMatch(STAGE, /stage-native-rdp\.mjs/);
  assert.doesNotMatch(STAGE, /about:blank#zephyr-one-native-rdp/);
});
