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
const resolver = fs.readFileSync(path.join(one, 'scripts/resolve-vcpkg-pkgconfig.py'), 'utf8');

function job(name, next) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `${name} job exists`);
  const end = next ? workflow.indexOf(`  ${next}:`, start) : workflow.length;
  assert.notEqual(end, -1, `${next} job follows ${name}`);
  return workflow.slice(start, end);
}

/**
 * Collect the body lines of every job-level `env:` block.
 *
 * Job level is 4-space indent (`  build-linux:` → `    env:`); a step-level env
 * sits at 8. The distinction is the whole point of this scan, so it is done by
 * indent rather than by searching for the word `env`.
 */
function jobLevelEnvLines() {
  const lines = workflow.split('\n');
  const collected = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^ {4}env:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^ {6}\S/.test(line) || /^\s*$/.test(line)) {
        if (line.trim()) collected.push(line);
        continue;
      }
      inBlock = false;
    }
  }
  return collected;
}

test('job-level env never uses a step-only context', () => {
  /*
   * A job-level `env:` may only read github / inputs / matrix / needs /
   * secrets / strategy / vars. Using `runner.*` there does not fail the job:
   * GitHub refuses to parse the *entire workflow file*, so pushes stop running
   * too and a dispatch returns HTTP 422. That is why this is asserted
   * statically instead of being left to the next dispatch to discover.
   */
  const envLines = jobLevelEnvLines();
  assert.ok(envLines.length > 0, 'found job-level env blocks to check');

  const stepOnly = ['runner', 'steps', 'job', 'env', 'hashFiles'];
  for (const line of envLines) {
    for (const ctx of stepOnly) {
      assert.doesNotMatch(
        line,
        new RegExp(`\\$\\{\\{[^}]*\\b${ctx}\\.`),
        `job-level env must not reference the ${ctx} context: ${line.trim()}`,
      );
    }
  }

  // And the arch-dependent triplet must therefore be chosen in a step.
  assert.match(workflow, /Select vcpkg triplet for this runner/);
  assert.match(workflow, /VCPKG_DEFAULT_TRIPLET=\$triplet" >> "\$GITHUB_ENV"/);
});

test('every desktop release job builds and stages the native helper', () => {
  for (const [name, next] of [
    ['build-windows', 'build-macos'],
    ['build-macos', 'build-linux'],
    ['build-linux', 'release'],
  ]) {
    const text = job(name, next);
    assert.match(text, /lukka\/run-vcpkg@v11/, `${name}: static dependencies`);
    assert.match(text, /runVcpkgInstall: true/, `${name}: manifest installed`);
    /* Static linking is requested by resolve-vcpkg-pkgconfig.py rather than by
     * an inline shell line in each job. Asserting the call plus the resolver's
     * own behaviour keeps the guarantee while letting the three jobs share one
     * tested implementation; asserting the literal here would only prove the
     * YAML repeats itself. */
    assert.match(text, /resolve-vcpkg-pkgconfig\.py/,
      `${name}: resolves the vcpkg .pc directory and pkgconf`);
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
  assert.match(text, /--helper native-bin\/zephyr-one-rdp/,
    'live e2e runs the release helper staged for the installer');
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

/*
 * The three build jobs delegate their pkg-config wiring to this one script, so
 * the guarantee "packaged builds link FreeRDP statically" now lives here rather
 * than in three copies of inline shell. If the script stopped exporting these,
 * every desktop build would silently fall back to a dynamic link against a
 * FreeRDP that is not present on a user's machine.
 */
test('the vcpkg pkg-config resolver exports what packaged builds depend on', () => {
  for (const name of ['PKG_CONFIG', 'PKG_CONFIG_PATH', 'PKG_CONFIG_ALL_STATIC',
    'ZEPHYR_ONE_RDP_STATIC']) {
    assert.ok(resolver.includes(name), `resolver exports ${name}`);
  }
  assert.match(resolver, /GITHUB_ENV/, 'resolver publishes to later steps');
  // A missing .pc must fail the build with a directory listing, not proceed to
  // a dynamic link: this is exactly how the previous attempt failed silently.
  assert.match(resolver, /freerdp3|freerdp2/, 'resolver verifies FreeRDP .pc files exist');
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
