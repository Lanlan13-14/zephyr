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
const PYTHON_PROBE_TIMEOUT_MS = 5_000;

function isUsablePython(command, args = []) {
  const probe = spawnSync(command, [...args, '--version'], {
    encoding: 'utf8',
    timeout: PYTHON_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return probe.status === 0
    && !probe.error
    && /Python 3\./.test(`${probe.stdout || ''}${probe.stderr || ''}`);
}

function resolvePython() {
  const explicit = [
    process.env.ZEPHYR_ONE_TEST_PYTHON,
    process.env.PYTHON,
  ].filter(Boolean);
  const bundled = [
    path.join(REAL_ROOT, '.tooling', 'python', 'python.exe'),
    path.join(REAL_ROOT, '.tooling', 'python', 'python3.exe'),
    path.join(REAL_ROOT, '..', '.tooling', 'python', 'python.exe'),
    path.join(REAL_ROOT, '..', '.tooling', 'python', 'python3.exe'),
    path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    ),
  ].filter((candidate) => fs.existsSync(candidate));
  const candidates = [
    ...explicit.map((command) => ({ command, args: [] })),
    ...bundled.map((command) => ({ command, args: [] })),
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] },
  ];

  return candidates.find(({ command, args }) => isUsablePython(command, args));
}

const PYTHON = resolvePython();
if (!PYTHON) {
  throw new Error(
    'set-version tests require a runnable Python 3 interpreter. Set ZEPHYR_ONE_TEST_PYTHON or PYTHON, install the Windows py launcher, or provide python/python3 on PATH.',
  );
}

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
  return spawnSync(PYTHON.command, [...PYTHON.args, script, tag], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function resultMessage(result) {
  const launchError = result.error
    ? `Failed to start Python (${result.error.code || result.error.name}): ${result.error.message}`
    : '';
  return [launchError, result.stderr, result.stdout].filter(Boolean).join('\n');
}

function manifestVersions() {
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).version;
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = /^version\s*=\s*"([^"]+)"$/m.exec(cargo)?.[1];
  const tauriVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
  return { packageVersion, cargoVersion, tauriVersion };
}

function assertManifestVersions(version) {
  assert.deepEqual(manifestVersions(), {
    packageVersion: version,
    cargoVersion: version,
    tauriVersion: version,
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
    assert.equal(r.status, 0, resultMessage(r));
    assert.equal(fs.readFileSync(path.join(REAL_ROOT, 'package.json'), 'utf8'), before);
    assertManifestVersions('9.8.7');
  });

  it('parses one-v0.1.7 into all three manifests', () => {
    const r = runSetVersion('one-v0.1.7');
    assert.equal(r.status, 0, resultMessage(r));
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_NAME=0\.1\.7/);
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_CODE=\d+/);

    assertManifestVersions('0.1.7');
  });

  it('parses bare 0.2.3 and v1.0.0', () => {
    let r = runSetVersion('0.2.3');
    assert.equal(r.status, 0, resultMessage(r));
    assertManifestVersions('0.2.3');

    r = runSetVersion('v1.0.0');
    assert.equal(r.status, 0, resultMessage(r));
    assertManifestVersions('1.0.0');
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_CODE=10000/);
  });

  it('rejects unparseable tags', () => {
    const before = manifestVersions();
    const r = runSetVersion('not-a-version');
    assert.notEqual(r.status, 0, resultMessage(r));
    assert.equal(r.error, undefined, resultMessage(r));
    assert.deepEqual(manifestVersions(), before);
  });
});
