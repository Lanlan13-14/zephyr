import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = path.resolve(__dirname, '..');
const REAL_SCRIPT = path.join(REAL_ROOT, 'scripts', 'set-version.py');

let root;
let script;

function copy(rel) {
  const from = path.join(REAL_ROOT, rel);
  const to = path.join(root, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function runSetVersion(tag, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.GITHUB_ENV;
  delete env.GITHUB_RUN_NUMBER;
  delete env.ZEPHYR_ONE_VERSION_CODE;
  delete env.ZEPHYR_ONE_VERSION;
  const python = process.env.ZEPHYR_ONE_TEST_PYTHON || process.env.PYTHON || 'python3';
  return spawnSync(python, [script, tag], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

describe('set-version.py', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-set-version-'));
    script = path.join(root, 'scripts', 'set-version.py');
    for (const rel of [
      'scripts/set-version.py',
      'package.json',
      'src-tauri/Cargo.toml',
      'src-tauri/tauri.conf.json',
    ]) copy(rel);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses an isolated copy instead of mutating the live project', () => {
    const before = fs.readFileSync(path.join(REAL_ROOT, 'package.json'), 'utf8');
    const r = runSetVersion('one-v9.8.7');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(fs.readFileSync(path.join(REAL_ROOT, 'package.json'), 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '9.8.7');
  });

  it('parses one-v0.1.7 into all three manifests', () => {
    const r = runSetVersion('one-v0.1.7');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_NAME=0\.1\.7/);
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_CODE=\d+/);

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.1.7');
    const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
    assert.match(cargo, /^version = "0\.1\.7"$/m);
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(conf.version, '0.1.7');
  });

  it('parses bare 0.2.3 and v1.0.0', () => {
    let r = runSetVersion('0.2.3');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.2.3');

    r = runSetVersion('v1.0.0');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.0');
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_CODE=10000/);
  });

  it('rejects unparseable tags', () => {
    const r = runSetVersion('not-a-version');
    assert.notEqual(r.status, 0);
  });
});
