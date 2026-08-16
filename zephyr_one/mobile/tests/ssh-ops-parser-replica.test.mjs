import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('python replica of docker/stats parsers stays aligned with Kotlin', () => {
  const result = spawnSync('python3', [path.join(here, 'ssh-ops-parser-replica.py')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ssh-ops-parser-replica: ok/);
});
