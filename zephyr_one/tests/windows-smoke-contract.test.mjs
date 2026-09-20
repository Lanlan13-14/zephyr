import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

describe('Windows install smoke harness', () => {
  it('proves readiness only for the captured installed runtime tree', () => {
    const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'windows-install-smoke.ps1'), 'utf8');
    assert.match(smoke, /healthz/);
    assert.match(smoke, /HoldSec|ReadyTimeoutSec/);
    assert.match(smoke, /ExpectedNode/);
    assert.match(smoke, /ExpectedServer/);
    assert.match(smoke, /zephyr-autostart\.log/);
    assert.match(smoke, /zephyr-one-embed\.css/);
    assert.match(smoke, /zephyr-one-windows-x64-\*\.exe/);
    assert.match(smoke, /resources\\desktop-runtime\\node\.exe/);
    assert.match(smoke, /resources\\zephyr-core\\server\.js/);
    assert.match(smoke, /C:\\ZephyrOneSmoke/);
    assert.match(smoke, /\/D=\$\(\$script:InstallDir\)/);
    assert.doesNotMatch(smoke, /src-tauri\\target\\release\\bundle/);
    assert.doesNotMatch(smoke, /ArgumentList "\/S"/);
  });

  it('wires smoke into the Windows CI job', () => {
    const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');
    assert.match(workflow, /windows-install-smoke\.ps1/);
    assert.match(workflow, /name: windows-install-smoke/);
    assert.match(workflow, /build-windows:/);
    assert.match(workflow, /electron-builder/);
  });

  it('keeps Windows verbatim path stripping in the runtime', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'electron', 'runtime.mjs'), 'utf8');
    assert.match(runtime, /function nodeCompatiblePath/);
    assert.match(runtime, /\\\\?\\/);
  });

  it('starts the bundled Node runtime directly on every desktop platform', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'electron', 'runtime.mjs'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
    assert.match(runtime, /spawn\(node, \[path\.join\(core, 'server\.js'\)\], spawnOpts\)/);
    assert.match(runtime, /ZEPHYR_ONE_EMBEDDED: '1'/);
    assert.match(runtime, /ZEPHYR_ONE_SHELL_SECRET/);
    assert.match(runtime, /ZEPHYR_ONE_SHELL_INSTANCE/);
    assert.match(runtime, /windowsHide:\s*true/);
    assert.match(main, /shouldAutostart/);
  });

  it('keeps the Windows smoke deadline outside the embedded core deadline', () => {
    const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');
    assert.match(workflow, /windows-install-smoke\.ps1[^\n]*-ReadyTimeoutSec 240/);
  });
});
