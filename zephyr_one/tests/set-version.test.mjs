/**
 * Unit tests for scripts/set-version.py (version stamping from release tags).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'set-version.py');

function runSetVersion(tag, extraEnv = {}) {
  // Isolate from CI: GITHUB_RUN_NUMBER would override computed versionCode.
  const env = { ...process.env, ...extraEnv };
  delete env.GITHUB_ENV;
  delete env.GITHUB_RUN_NUMBER;
  delete env.ZEPHYR_ONE_VERSION_CODE;
  delete env.ZEPHYR_ONE_VERSION;
  const python = process.env.ZEPHYR_ONE_TEST_PYTHON || process.env.PYTHON || 'python3';
  return spawnSync(python, [SCRIPT, tag], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('set-version.py', () => {
  let tmp;
  let origPackage;
  let origCargo;
  let origTauri;

  const packageJson = path.join(ROOT, 'package.json');
  const cargoToml = path.join(ROOT, 'src-tauri', 'Cargo.toml');
  const tauriConf = path.join(ROOT, 'src-tauri', 'tauri.conf.json');

  before(() => {
    origPackage = fs.readFileSync(packageJson, 'utf8');
    origCargo = fs.readFileSync(cargoToml, 'utf8');
    origTauri = fs.readFileSync(tauriConf, 'utf8');
  });

  after(() => {
    fs.writeFileSync(packageJson, origPackage);
    fs.writeFileSync(cargoToml, origCargo);
    fs.writeFileSync(tauriConf, origTauri);
  });

  it('parses one-v0.1.7 → 0.1.7 into package.json / Cargo.toml / tauri.conf.json', () => {
    const r = runSetVersion('one-v0.1.7');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_NAME=0\.1\.7/);
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_CODE=\d+/);

    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    assert.equal(pkg.version, '0.1.7');

    const cargo = fs.readFileSync(cargoToml, 'utf8');
    assert.match(cargo, /^version = "0\.1\.7"$/m);

    const conf = JSON.parse(fs.readFileSync(tauriConf, 'utf8'));
    assert.equal(conf.version, '0.1.7');
  });

  it('parses bare 0.2.3 and v1.0.0', () => {
    let r = runSetVersion('0.2.3');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(packageJson, 'utf8')).version, '0.2.3');

    r = runSetVersion('v1.0.0');
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(packageJson, 'utf8')).version, '1.0.0');
    assert.match(r.stdout, /ZEPHYR_ONE_VERSION_CODE=10000/);
  });

  it('rejects unparseable tags', () => {
    const r = runSetVersion('not-a-version');
    assert.notEqual(r.status, 0);
  });
});
