import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

describe('Windows install smoke harness', () => {
  it('ships a PowerShell smoke that installs/launches and probes healthz', () => {
    const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'windows-install-smoke.ps1'), 'utf8');
    assert.match(smoke, /node_compatible|Zephyr HTTP|healthz|EISDIR|\\\\{2}\?\\C:/);
    assert.match(smoke, /HoldSec|ReadyTimeoutSec/);
    assert.match(smoke, /diagnostics\.txt/);
    assert.match(smoke, /zephyr-node\.log/);
    // Must not claim success without an HTTP ready signal
    assert.match(smoke, /Zephyr HTTP.*localhost/);
  });

  it('wires smoke + cargo path tests into the Windows CI job', () => {
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');
    assert.match(wf, /windows-install-smoke\.ps1/);
    assert.match(wf, /Cargo test Windows path helpers/);
    assert.match(wf, /name: windows-install-smoke/);
    assert.match(wf, /build-windows:/);
  });

  it('keeps Windows verbatim path stripping in the runtime', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'runtime', 'mod.rs'), 'utf8');
    assert.match(runtime, /fn node_compatible_path/);
    assert.match(runtime, /strip_prefix\(r"\\\\?\\/);
    assert.match(runtime, /windows_verbatim_paths_are_safe_for_node/);
    assert.match(runtime, /EISDIR|verbatim/);
  });
});
