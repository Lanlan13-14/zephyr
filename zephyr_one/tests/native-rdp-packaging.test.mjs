import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const one = path.resolve(here, '..');
const repo = path.resolve(one, '..');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/zephyr-one.yml'), 'utf8');
const helperWorkflow = fs.readFileSync(
  path.join(repo, '.github/workflows/zephyr-one-rdp-helper.yml'), 'utf8');
const buildRs = fs.readFileSync(path.join(one, 'native/zephyr-one-rdp/build.rs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(one, 'native/zephyr-one-rdp/vcpkg.json'), 'utf8'));
const stage = fs.readFileSync(path.join(one, 'scripts/stage-native-rdp-bin.sh'), 'utf8');
const smoke = fs.readFileSync(path.join(one, 'scripts/smoke-native-rdp-helper.py'), 'utf8');
const windowsSmoke = fs.readFileSync(path.join(one, 'scripts/windows-install-smoke.ps1'), 'utf8');
const resolver = fs.readFileSync(path.join(one, 'scripts/resolve-rdp-pkgconfig.py'), 'utf8');
const buildFreerdp = fs.readFileSync(
  path.join(one, 'native/zephyr-one-rdp/scripts/build-freerdp.sh'), 'utf8');

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

test('every desktop release job vendors FreeRDP before staging the helper', () => {
  for (const [name, next] of [
    ['build-windows', 'build-macos'],
    ['build-macos', 'build-linux'],
    ['build-linux', 'release'],
  ]) {
    const text = job(name, next);
    assert.match(text, /build-freerdp\.sh/, `${name}: pinned FreeRDP source built`);
    assert.match(text, /actions\/cache@v4/, `${name}: FreeRDP build cached`);
    assert.match(text, /resolve-rdp-pkgconfig\.py/,
      `${name}: pkg-config points at the vendored install`);
    assert.doesNotMatch(text, /resolve-vcpkg-pkgconfig\.py/,
      `${name}: old vcpkg-FreeRDP resolver is gone`);
    assert.doesNotMatch(text, /validation_only != 'true'/,
      `${name}: validation_only must still build and inspect the package`);
    assert.match(text, /stage-native-rdp-bin\.sh/, `${name}: helper staged`);
    assert.match(text, /native-bin\/zephyr-one-rdp/, `${name}: staged helper asserted`);
    assert.ok(text.indexOf('build-freerdp.sh') < text.indexOf('stage-native-rdp-bin.sh'),
      `${name}: vendored FreeRDP exists before helper link`);
    assert.ok(text.indexOf('stage-native-rdp-bin.sh') < text.indexOf('tauri build'),
      `${name}: helper exists before Tauri bundles resources`);
  }

  // Only Windows/macOS need vcpkg: Apple/Windows have no system OpenSSL. Linux
  // deliberately uses apt's libssl so security updates do not require an app
  // release.
  for (const [name, next] of [
    ['build-windows', 'build-macos'],
    ['build-macos', 'build-linux'],
  ]) {
    const text = job(name, next);
    assert.match(text, /lukka\/run-vcpkg@v11/, `${name}: crypto deps via vcpkg`);
    assert.match(text, /runVcpkgInstall: true/, `${name}: manifest installed`);
  }
  assert.match(job('build-windows', 'build-macos'), /ilammy\/msvc-dev-cmd@v1/,
    'Windows vendored CMake build runs inside an MSVC developer environment');
  assert.doesNotMatch(job('build-linux', 'release'), /lukka\/run-vcpkg/,
    'Linux uses distro OpenSSL/zlib/cJSON, not vcpkg');
});

test('helper matrix validates all three platforms without fail-fast hiding errors', () => {
  assert.match(helperWorkflow, /fail-fast:\s*false/);
  for (const label of ['linux', 'windows', 'macos']) {
    assert.match(helperWorkflow, new RegExp(`label:\\s*${label}`), `${label} matrix entry`);
  }
  assert.match(helperWorkflow, /build-freerdp\.sh/, 'vendors pinned FreeRDP source');
  assert.match(helperWorkflow, /resolve-rdp-pkgconfig\.py/);
  assert.doesNotMatch(helperWorkflow, /resolve-vcpkg-pkgconfig\.py/);
  assert.match(helperWorkflow, /ilammy\/msvc-dev-cmd@v1/,
    'Windows CMake/Ninja receives a real MSVC developer environment');
  assert.match(helperWorkflow, /smoke-native-rdp-helper\.py/);
  assert.match(helperWorkflow, /grep -Ei 'freerdp\|winpr'/,
    'workflow rejects any runtime FreeRDP/WinPR dependency reported by ldd/otool');
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

/*
 * vcpkg must NOT supply FreeRDP.
 *
 * Measured, not assumed: vcpkg's freerdp 3.26.0 port produced archives where
 * libfreerdp3.a and libwinpr3.a were byte-for-byte the same size (1745350) with
 * the same member count (257) and the same 440 symbols, and gdi_free /
 * freerdp_client_load_addins / PubSub_Subscribe were defined in none of them.
 * That is what produced one undefined symbol per FFI call for four consecutive
 * release attempts. A source build of the same 3.30.0 yields 14627344 bytes /
 * 2003 symbols and defines all three.
 *
 * vcpkg is still used, but only for the dependencies that genuinely have no
 * system copy on Windows/macOS: OpenSSL, zlib, cJSON.
 */
test('vcpkg supplies only the deps FreeRDP needs, never FreeRDP itself', () => {
  assert.match(manifest['builtin-baseline'], /^[0-9a-f]{40}$/);
  const names = manifest.dependencies.map((v) => (typeof v === 'string' ? v : v?.name));
  assert.ok(!names.includes('freerdp'),
    'vcpkg freerdp port is broken (identical freerdp3/winpr3 archives, missing symbols)');
  for (const dep of ['openssl', 'zlib', 'cjson']) {
    assert.ok(names.includes(dep), `vcpkg provides ${dep}`);
  }
  assert.ok(manifest.dependencies.some((v) => v?.name === 'pkgconf' && v.host));
});

test('FreeRDP is vendored at a pinned tag and built static', () => {
  assert.match(buildFreerdp, /ZEPHYR_FREERDP_TAG:-3\.\d+\.\d+/, 'tag is pinned');
  assert.match(buildFreerdp, /BUILD_SHARED_LIBS=OFF/, 'static archives');
  assert.match(buildFreerdp, /OPENSSL_USE_STATIC_LIBS=ON/);
  // Channels the shim actually binds. Dropping one of these turns a working
  // feature (folder mapping, audio, clipboard) into a silent no-op.
  for (const ch of ['CHANNEL_RDPDR', 'CHANNEL_DRIVE', 'CHANNEL_RDPSND',
    'CHANNEL_AUDIN', 'CHANNEL_CLIPRDR', 'CHANNEL_DISP', 'CHANNEL_RDPGFX']) {
    assert.match(buildFreerdp, new RegExp(`${ch}=ON`), `${ch} enabled`);
  }
  // Audio is played by FreeRDP's own backend, not proxied to the browser, so
  // each platform needs its native one. ALSA on macOS would fail to link the
  // same way -lrt did.
  assert.match(buildFreerdp, /WITH_ALSA=ON/);
  assert.match(buildFreerdp, /WITH_MACAUDIO=ON/);
  // Trimmed: these pulled libusb/ICU/opus/fuse3 into the dependency list for
  // features the shim never references.
  for (const off of ['CHANNEL_URBDRC=OFF', 'WITH_OPUS=OFF', 'WITH_FUSE=OFF',
    'WITH_UNICODE_BUILTIN=ON']) {
    assert.ok(buildFreerdp.includes(off), `trimmed: ${off}`);
  }
  assert.match(buildFreerdp, /ZEPHYR_FREERDP_CMAKE_ARGS/,
    'extra cmake args reach the configure step for vcpkg OpenSSL');
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
test('vendored pkg-config resolver exports what packaged builds depend on', () => {
  for (const name of ['PKG_CONFIG_PATH', 'PKG_CONFIG_ALL_STATIC',
    'ZEPHYR_ONE_RDP_STATIC', 'ZEPHYR_FREERDP_PREFIX']) {
    assert.ok(resolver.includes(name), `resolver handles ${name}`);
  }
  assert.match(resolver, /GITHUB_ENV/, 'resolver publishes to later steps');
  // PKG_CONFIG is optional on Linux (system pkg-config), but selected from the
  // vcpkg host-tools tree when present on Windows/macOS.
  assert.match(resolver, /pkgconf|pkg-config/, 'resolver locates a pkg-config executable');
  // A missing vendored .pc must fail with a listing instead of silently falling
  // back to system FreeRDP 2 — a probe once did exactly that and produced a
  // misleading "static" success.
  for (const pc of ['freerdp3', 'freerdp-client3', 'winpr3']) {
    assert.ok(resolver.includes(pc), `resolver verifies ${pc}.pc`);
  }
  assert.match(resolver, /build-freerdp\.sh/, 'failure names the build step that fixes it');
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
