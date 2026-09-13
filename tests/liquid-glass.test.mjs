import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function run(file) {
  const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (r.status) throw new Error(file + ' exited ' + r.status);
}

test('liquid-glass tab layout', () => {
  run('liquid-glass-tab-layout.test.js');
});

test('liquid-glass tab gesture', () => {
  run('liquid-glass-tab-gesture.test.js');
});
