import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const one = path.resolve(here, '..');
const repo = path.resolve(one, '..');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/zephyr-one.yml'), 'utf8');
const buildRs = fs.readFileSync(path.join(one, 'native/zephyr-one-rdp/build.rs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(one, 'native/zephyr-one-rdp/vcpkg.json'), 'utf8'));
const stage = fs.readFileSync(path.join(one, 'scripts/stage-native-rdp-bin.sh'), 'utf8');
const smoke = fs.readFileSync(path.join(one, 'scripts/smoke-native-rdp-helper.py'), 'utf8');
const windowsSmoke = fs.readFileSync(path.join(one, 'scripts/windows-install-smoke.ps1'), 'utf8');

function job(name, next) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `${name} job exists`);
  const end = next ? workflow.indexOf(`  ${next}:`, start) : workflow.length;
  assert.notEqual(end, -1, `${next} job follows ${name}`);
  return workflow.slice(start, end);
}

test('every desktop release job builds and stages the native helper', () => {
  for (const [name, next] of [
    ['build-windows', 'build-macos'],
    ['build-macos', 'build-linux'],
    ['build-linux', 'release'],
  ]) {
    const text = job(name, next);
    assert.match(text, /lukka\/run-vcpkg@v11/, `${name}: static dependencies`);
    assert.match(text, /runVcpkgInstall: true/, `${name}: manifest installed`);
    assert.match(text, /ZEPHYR_ONE_RDP_STATIC=1/, `${name}: static link requested`);
    assert.doesNotMatch(text, /validation_only != 'true'/,
      `${name}: validation_only must still build and inspect the package`);
    assert.match(text, /stage-native-rdp-bin\.sh/, `${name}: helper staged`);
    assert.match(text, /native-bin\/zephyr-one-rdp/, `${name}: staged helper asserted`);
    assert.ok(text.indexOf('stage-native-rdp-bin.sh') < text.indexOf('tauri build'),
      `${name}: helper exists before Tauri bundles resources`);
  }
});

test('test job exercises C, Rust, staging, and a live RDP server', () => {
  const text = job('test', 'build-windows');
  for (const marker of ['run-ctests.sh', 'cargo test --locked',
    'stage-native-rdp-bin.sh', 'e2e/live-session.py']) {
    assert.ok(text.includes(marker), `test job contains ${marker}`);
  }
});

test('vcpkg manifest is pinned and carries the FreeRDP client', () => {
  assert.match(manifest['builtin-baseline'], /^[0-9a-f]{40}$/);
  const freerdp = manifest.dependencies.find((v) => v?.name === 'freerdp');
  assert.ok(freerdp);
  assert.equal(freerdp['default-features'], false);
  assert.deepEqual(freerdp.features, ['client']);
  assert.ok(manifest.dependencies.some((v) => v?.name === 'pkgconf' && v.host));
});

test('build and staging scripts enforce self-contained protocol smoke', () => {
  assert.match(buildRs, /\.statik\(statik\)/);
  assert.match(buildRs, /ZEPHYR_ONE_RDP_STATIC/);
  assert.doesNotMatch(buildRs, /vcpkg::Config|\.find_package\s*\(/,
    'do not use vcpkg-rs single-library probing and lose client/winpr/private libs');
  assert.match(stage, /cargo build --locked/);
  assert.match(stage, /smoke-native-rdp-helper\.py/);
  assert.match(smoke, /freerdpMajor/);
  assert.match(smoke, /MSG_STOP/);
});

test('Linux no longer publishes a dependency-less fake portable binary', () => {
  const text = job('build-linux', 'release');
  assert.doesNotMatch(text, /cp -v src-tauri\/target\/release\/zephyr-one/);
  assert.match(text, /dpkg-deb -c/);
  assert.match(text, /rpm -qlp/);
});


test('Windows install smoke validates the installed helper', () => {
  assert.match(windowsSmoke, /Get-ChildItem[\s\S]*zephyr-one-rdp\.exe/);
  assert.match(windowsSmoke, /Where-Object[\s\S]*native-bin/);
  assert.match(windowsSmoke, /Dump-Fail "installed app is missing/);
  assert.match(windowsSmoke, /smoke-native-rdp-helper\.py/);
});

test('macOS and Linux inspect built packages, not only staging', () => {
  assert.match(workflow, /Inspect macOS app bundle native helper/);
  assert.match(workflow, /find "\$app"[\s\S]*native-bin\/zephyr-one-rdp/);
  assert.match(workflow, /dpkg-deb -c "\$deb"[\s\S]*native-bin\/zephyr-one-rdp/);
  assert.match(workflow, /rpm -qlp "\$rpm"[\s\S]*native-bin\/zephyr-one-rdp/);
});
