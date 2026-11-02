import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');

function runVersion(root, env = {}) {
  const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./version').getAppVersion())"], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(probe.status, 0, probe.stderr || 'version probe failed');
  return probe.stdout;
}

test('packaged One core keeps the full prerelease version for About', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-release-version-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'version.js'), path.join(dir, 'version.js'));
    fs.copyFileSync(path.join(ROOT, 'agent-release.js'), path.join(dir, 'agent-release.js'));
    fs.writeFileSync(path.join(dir, 'zephyr-one-release.json'), JSON.stringify({
      version: '0.1.20',
      prerelease: 'pre40',
      fullVersion: '0.1.20pre40',
    }));
    assert.equal(runVersion(dir, {
      ZEPHYR_ONE_FULL_VERSION: '',
      ZEPHYR_ONE_PRERELEASE: '',
      ZEPHYR_VERSION: '0.1.20',
    }), '0.1.20pre40');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staging writes and verifies the release metadata file', () => {
  const stage = fs.readFileSync(path.join(ROOT, 'zephyr_one', 'scripts', 'stage-zephyr-core.sh'), 'utf8');
  assert.match(stage, /zephyr-one-release\.json/);
  assert.match(stage, /fullVersion/);
  assert.ok(stage.includes('test -f "$OUT/zephyr-one-release.json"'));
});
