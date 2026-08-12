import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertFreeRdp3Only,
  assertNoDynamicFreeRdp,
  parseElfDependencies,
  parseMachODependencies,
  parsePeDependencies,
  parseWindowsDependencies,
  verifyPatchedFreeRdpInstall,
  verifyStagedCore,
} from '../scripts/verify-rdp-packaging.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.dirname(ROOT);

function write(root, relative, content = '') {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-rdp-package-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const staged = path.join(fixture, 'zephyr-core');
  const web = path.join(fixture, 'web-public');
  write(staged, 'public/app.js', "import './zephyr-one-native-rdp.js';\n");
  write(staged, 'public/zephyr-one-native-rdp.js', "export const engine = 'native-freerdp';\n");
  write(web, 'rdp.html', '<script type="module" src="rdp-wasm-client.js"></script>');
  write(web, 'rdp-wasm-client.js', "import './rdp-wasm-runtime.js';\n");
  write(web, 'rdp-wasm-runtime.js', "export const runtime = './vendor/rdp-wasm/main.wasm';\n");
  write(web, 'rdp-worker.js', "import './rdp-wasm-runtime.js';\n");
  write(web, 'vendor/rdp-wasm/main.wasm', Buffer.from([0, 97, 115, 109]));
  write(web, 'app.js', "frame.src = `/rdp.html?connectionId=${id}`;\n");
  return { staged, web };
}

test('staged One rejects browser RDP files without changing standalone Web RDP', (t) => {
  const { staged, web } = makeFixture(t);
  assert.doesNotThrow(() => verifyStagedCore(staged, web));

  write(staged, 'public/rdp-worker.js', "import './rdp-wasm-runtime.js';\n");
  assert.throws(
    () => verifyStagedCore(staged, web),
    /staged a browser-only RDP asset: public\/rdp-worker\.js/,
  );
});

test('staged One rejects a hidden /rdp.html navigation reference', (t) => {
  const { staged, web } = makeFixture(t);
  write(staged, 'public/chunk.js', "location.href = '/rdp.html?embed=1';\n");
  assert.throws(
    () => verifyStagedCore(staged, web),
    /public assets still reference WASM RDP or \/rdp\.html: public\/chunk\.js/,
  );
});

test('standalone Web WASM RDP is a required source distribution surface', () => {
  const webPublic = path.join(REPO, 'public');
  for (const relative of [
    'rdp.html',
    'rdp-wasm-client.js',
    'rdp-wasm-runtime.js',
    'rdp-worker.js',
    'vendor/rdp-wasm/main.wasm',
  ]) {
    assert.ok(fs.existsSync(path.join(webPublic, ...relative.split('/'))), `missing ${relative}`);
  }
  assert.match(fs.readFileSync(path.join(webPublic, 'rdp.html'), 'utf8'), /rdp-wasm-client\.js/);
  assert.match(fs.readFileSync(path.join(webPublic, 'app.js'), 'utf8'), /\/rdp\.html\?/);
});

test('platform dependency parsers retain all three native library families', () => {
  assert.deepEqual(
    parseWindowsDependencies('Image has the following dependencies:\r\n freerdp3.dll\r\n FREERDP-CLIENT3.dll\r\n winpr3.dll'),
    ['freerdp3.dll', 'FREERDP-CLIENT3.dll', 'winpr3.dll'],
  );
  assert.deepEqual(
    parseMachODependencies(
      'zephyr-one:\n\t@executable_path/../Frameworks/libfreerdp3.3.dylib (compatibility version 3.0.0, current version 3.12.0)\n' +
      '\t@executable_path/../Frameworks/libfreerdp-client3.3.dylib (compatibility version 3.0.0, current version 3.12.0)\n' +
      '\t@executable_path/../Frameworks/libwinpr3.3.dylib (compatibility version 3.0.0, current version 3.12.0)\n',
    ),
    [
      '@executable_path/../Frameworks/libfreerdp3.3.dylib',
      '@executable_path/../Frameworks/libfreerdp-client3.3.dylib',
      '@executable_path/../Frameworks/libwinpr3.3.dylib',
    ],
  );
  assert.deepEqual(
    parseElfDependencies(
      ' 0x0000000000000001 (NEEDED) Shared library: [libfreerdp3.so.3]\n' +
      ' 0x0000000000000001 (NEEDED) Shared library: [libfreerdp-client3.so.3]\n' +
      ' 0x0000000000000001 (NEEDED) Shared library: [libwinpr3.so.3]\n',
    ),
    ['libfreerdp3.so.3', 'libfreerdp-client3.so.3', 'libwinpr3.so.3'],
  );
});

test('native dependency contract accepts only the FreeRDP 3 ABI', () => {
  const valid = ['libfreerdp3.so.3', 'libfreerdp-client3.so.3', 'libwinpr3.so.3'];
  assert.doesNotThrow(() => assertFreeRdp3Only(valid, 'fixture'));

  for (const forbidden of [
    'libfreerdp2.so.2',
    'libfreerdp-client2.2.dylib',
    'winpr2.dll',
    'libfreerdp.so',
    'freerdp4.dll',
  ]) {
    assert.throws(
      () => assertFreeRdp3Only([...valid, forbidden], 'fixture'),
      /contains non-v3 FreeRDP\/WinPR libraries/,
      forbidden,
    );
  }
});

test('static release contract rejects every dynamic FreeRDP or WinPR ABI', () => {
  assert.doesNotThrow(() => assertNoDynamicFreeRdp(['kernel32.dll', 'libssl.3.dylib'], 'fixture'));
  for (const forbidden of ['freerdp3.dll', 'libfreerdp-client3.3.dylib', 'libwinpr2.so.2']) {
    assert.throws(
      () => assertNoDynamicFreeRdp(['kernel32.dll', forbidden], 'fixture'),
      /dynamically references FreeRDP\/WinPR despite the pinned static-link contract/,
    );
  }
});

test('pinned install requires the audited 3.30 clipboard marker and v3-only archives', (t) => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-freerdp-install-'));
  t.after(() => fs.rmSync(install, { recursive: true, force: true }));
  write(install, '.zephyr-freerdp-tag', '3.30.0+cliprdr-reassembly-limit-v1');
  write(
    install,
    'include/freerdp3/freerdp/client/channels.h',
    '#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1\n',
  );
  for (const name of ['freerdp3', 'freerdp-client3', 'winpr3']) {
    write(install, `lib/lib${name}.a`, name);
    write(install, `lib/${name}.lib`, name);
    write(install, `lib/pkgconfig/${name}.pc`, `Name: ${name}\nVersion: 3.30.0\n`);
  }
  write(install, 'lib/remdesk-common.lib', 'remdesk');
  write(install, 'lib/rdpsnd-common.lib', 'rdpsnd');
  write(install, 'include/freerdp3/freerdp/freerdp.h', '#pragma once\n');
  write(install, 'include/winpr3/winpr/winpr.h', '#pragma once\n');
  write(install, 'lib/cmake/FreeRDP-Client3/FreeRDP-ClientConfig.cmake', '# metadata, not a native artifact\n');
  assert.doesNotThrow(() => verifyPatchedFreeRdpInstall(install));

  fs.rmSync(path.join(install, 'lib/remdesk-common.lib'));
  assert.throws(() => verifyPatchedFreeRdpInstall(install), /missing private channel archive remdesk-common\.lib/);
  write(install, 'lib/remdesk-common.lib', 'remdesk');

  fs.appendFileSync(path.join(install, 'lib/pkgconfig/winpr3.pc'), 'Libs.private: -ldl -lrt\n');
  assert.throws(() => verifyPatchedFreeRdpInstall(install), /contains Unix-only libraries/);
  write(install, 'lib/pkgconfig/winpr3.pc', 'Name: winpr3\nVersion: 3.30.0\n');

  write(install, 'lib/libfreerdp2.a', 'forbidden');
  assert.throws(() => verifyPatchedFreeRdpInstall(install), /contains non-v3 FreeRDP\/WinPR libraries/);
});

test('PE import parsing does not depend on Visual Studio tools being on PATH', () => {
  const pe = Buffer.alloc(0x500);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'ascii');
  pe.writeUInt16LE(1, 0x86); // NumberOfSections
  pe.writeUInt16LE(0xf0, 0x94); // SizeOfOptionalHeader
  pe.writeUInt16LE(0x20b, 0x98); // PE32+
  pe.writeUInt32LE(0x1000, 0x98 + 112 + 8); // Import directory RVA
  const section = 0x98 + 0xf0;
  pe.writeUInt32LE(0x200, section + 8); // VirtualSize
  pe.writeUInt32LE(0x1000, section + 12); // VirtualAddress
  pe.writeUInt32LE(0x200, section + 16); // SizeOfRawData
  pe.writeUInt32LE(0x200, section + 20); // PointerToRawData
  const names = ['freerdp3.dll', 'freerdp-client3.dll', 'winpr3.dll'];
  names.forEach((name, index) => {
    const nameOffset = 0x280 + index * 0x30;
    pe.writeUInt32LE(0x1000 + nameOffset - 0x200, 0x200 + index * 20 + 12);
    pe.write(`${name}\0`, nameOffset, 'ascii');
  });
  assert.deepEqual(parsePeDependencies(pe), names);
});

test('Windows staging copies the complete vcpkg DLL closure', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-rdp-dll-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, 'bin');
  const destination = path.join(fixture, 'runtime');
  fs.mkdirSync(source);
  for (const name of ['freerdp3.dll', 'freerdp-client3.dll', 'winpr3.dll', 'libcrypto-3-x64.dll']) {
    fs.writeFileSync(path.join(source, name), name);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'stage-windows-freerdp.mjs'), source, destination],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readdirSync(destination).sort(),
    ['FREERDP_RUNTIME.json', 'freerdp-client3.dll', 'freerdp3.dll', 'libcrypto-3-x64.dll', 'winpr3.dll'],
  );
});

test('Windows staging rejects a mixed FreeRDP 2 and 3 DLL source', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-rdp-dll-v2-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, 'bin');
  const destination = path.join(fixture, 'runtime');
  fs.mkdirSync(source);
  for (const name of ['freerdp3.dll', 'freerdp-client3.dll', 'winpr3.dll', 'libfreerdp2-2.dll']) {
    fs.writeFileSync(path.join(source, name), name);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'stage-windows-freerdp.mjs'), source, destination],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains non-v3 native libraries.*libfreerdp2-2\.dll/s);
  assert.equal(fs.existsSync(destination), false);
});

test('desktop build metadata requires the complete FreeRDP 3 ABI', () => {
  const buildScript = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
  const pkgConfigResolver = fs.readFileSync(path.join(ROOT, 'scripts', 'resolve-rdp-pkgconfig.py'), 'utf8');
  const nativeBuild = fs.readFileSync(
    path.join(ROOT, 'native', 'freerdp-core', 'scripts', 'build-freerdp.sh'),
    'utf8',
  );
  assert.match(buildScript, /\["freerdp3", "freerdp-client3", "winpr3"\]/);
  assert.match(buildScript, /MIN_FREERDP3_VERSION: &str = "3\.0\.0"/);
  assert.match(buildScript, /3\.30\.0\+cliprdr-reassembly-limit-v1/);
  assert.match(buildScript, /ZEPHYR_ONE_REQUIRE_PATCHED_FREERDP/);
  assert.match(buildScript, /ZEPHYR_ONE_RDP_STATIC/);
  assert.match(pkgConfigResolver, /ZEPHYR_ONE_RDP_STATIC/);
  assert.doesNotMatch(
    pkgConfigResolver,
    /PKG_CONFIG_ALL_STATIC/,
    'the FreeRDP-only static setting must not affect GTK, DBus, or other Cargo pkg-config probes',
  );
  assert.doesNotMatch(buildScript, /CANDIDATES|&\["freerdp2", "freerdp-client2", "winpr2"\]/);
  assert.match(
    nativeBuild,
    /MINGW\*\|MSYS\*\|CYGWIN\*\|Windows_NT\)[\s\S]*CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL/,
    'Windows static FreeRDP must use the /MD CRT used by static-md dependencies and Rust',
  );
  assert.match(
    nativeBuild,
    /-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF/,
    'vendored FreeRDP archives must not carry LTO into the shim link',
  );
  assert.match(
    nativeBuild,
    /-DWITH_SYSTEMD=OFF/,
    'the optional WinPR journald appender must not enter the static pkg-config closure',
  );
  assert.match(
    nativeBuild,
    /grep -q '\^WITH_SYSTEMD:BOOL=OFF\$'\s+"\$BUILD\/CMakeCache\.txt"/,
    'a stamped install built with the optional journald appender must be rebuilt',
  );
  assert.ok(
    nativeBuild.lastIndexOf('-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF') >
      nativeBuild.indexOf('${ZEPHYR_FREERDP_CMAKE_ARGS:-}'),
    'callers must not be able to override the no-LTO invariant',
  );
  assert.match(
    nativeBuild,
    /grep -q '\^CMAKE_INTERPROCEDURAL_OPTIMIZATION:BOOL=OFF\$'[\s\S]*"\$BUILD\/CMakeCache\.txt"/,
    'a stamped install built with LTO must be rebuilt',
  );
  const darwinPostInstall = nativeBuild.match(/\n  Darwin\)\n([\s\S]*?)\n    ;;/)?.[1] || '';
  assert.match(
    darwinPostInstall,
    /sed -E 's\/\(\^\|\[\[:space:\]\]\)-lrt\(\[\[:space:\]\]\|\$\)\/\\1\\2\/g'/,
    'macOS must remove FreeRDP 3.30\'s Linux-only standalone -lrt pkg-config token',
  );
  assert.doesNotMatch(
    darwinPostInstall,
    /-l\(dl\|rt\|pthread\|m\)/,
    'macOS must preserve every static dependency except the unavailable standalone -lrt token',
  );

  const tauriConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(tauriConfig.bundle.linux, undefined, 'static FreeRDP must not create distro runtime dependencies');

  const ctest = fs.readFileSync(path.join(ROOT, 'native', 'freerdp-core', 'run-ctests.sh'), 'utf8');
  assert.match(ctest, /PKGS="freerdp-client3 freerdp3 winpr3"/);
  assert.match(ctest, /PKG_CONFIG_BIN="\$\{PKG_CONFIG:-pkg-config\}"/);
  assert.match(ctest, /"\$PKG_CONFIG_BIN" --atleast-version=3\.0\.0 \$PKGS/);
  assert.match(ctest, /"\$PKG_CONFIG_BIN" --libs --static \$PKGS/);
  assert.match(ctest, /Linux\) LIBS_LINK="-Wl,--start-group \$LIBS_PKG -Wl,--end-group"/);
  assert.match(ctest, /-o "\$OUT\/zephyr_rdp_test" \$LIBS_LINK/);
  assert.match(ctest, /-Wall -Wextra -Werror/);
  assert.doesNotMatch(ctest, /(?:^|\s)-Wno-error(?:\s|\\|$)/m);
  assert.doesNotMatch(ctest, /--exists freerdp2|PKGS="freerdp2/);
});

test('release workflow verifies the staged tree and every desktop bundle type', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'zephyr-one.yml'), 'utf8');
  assert.match(workflow, /verify-rdp-packaging\.mjs staged zephyr-core \.\.\/public/);
  assert.ok(
    (workflow.match(/native\/freerdp-core\/scripts\/build-freerdp\.sh/g) || []).length >= 4,
    'test and all release platforms must build pinned FreeRDP',
  );
  assert.ok(
    (workflow.match(/verify-rdp-packaging\.mjs patched-install/g) || []).length >= 4,
    'test and all release platforms must verify the patch marker',
  );
  assert.doesNotMatch(workflow, /vcpkg install freerdp|apt-get install[^\n]*freerdp3-dev|brew install freerdp/);
  assert.doesNotMatch(workflow, /tauri build --config scripts\/tauri\.freerdp\.windows\.json/);
  assert.match(workflow, /verify-rdp-packaging\.mjs windows-static/);
  assert.match(workflow, /ilammy\/msvc-dev-cmd@v1/);
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'windows-install-smoke.ps1'), 'utf8');
  assert.match(smoke, /must statically link pinned FreeRDP but contains native DLLs/);
  assert.ok(
    (workflow.match(/--atleast-version=3\.0\.0 freerdp3 freerdp-client3 winpr3/g) || []).length >= 4,
    'every desktop CI platform must verify the FreeRDP 3 pkg-config modules before building',
  );
  assert.ok(
    (workflow.match(/--libs --static freerdp-client3 freerdp3 winpr3/g) || []).length >= 4,
    'every desktop CI platform must reject libsystemd from the static FreeRDP closure',
  );
  assert.ok(
    (workflow.match(/-lsystemd/g) || []).length >= 4,
    'every desktop CI platform must explicitly reject libsystemd from the static FreeRDP closure',
  );
  const macosJob =
    workflow.match(/\r?\n  build-macos:\r?\n([\s\S]*?)\r?\n  build-linux:/)?.[1] || '';
  assert.match(
    macosJob,
    /--libs --static freerdp-client3 freerdp3 winpr3 \| grep -Eq -- '\(\^\|\[\[:space:\]\]\)-lrt\(\[\[:space:\]\]\|\$\)'/,
    'macOS CI must reject a standalone -lrt token before Cargo links the native FreeRDP engine',
  );
  assert.match(
    workflow,
    /PKG_CONFIG_ALL_STATIC:-.*must not be set before Cargo probes native dependencies/s,
    'the native Cargo test must fail before GTK or DBus pkg-config probes can inherit global static mode',
  );
  assert.match(workflow, /dylibbundler -od -b/);
  assert.match(workflow, /verify-rdp-packaging\.mjs macos-static/);
  assert.match(workflow, /verify-rdp-packaging\.mjs linux-static/);
  assert.doesNotMatch(workflow, /cp -v src-tauri\/target\/release\/zephyr-one "dist-out\/zephyr-one-linux-x64/);
});

test('Windows resource overlay installs FreeRDP DLLs next to the executable', () => {
  const overlay = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'scripts', 'tauri.freerdp.windows.json'), 'utf8'),
  );
  assert.equal(overlay.bundle.resources['../zephyr-core'], 'zephyr-core');
  assert.equal(overlay.bundle.resources['../desktop-runtime'], 'desktop-runtime');
  assert.equal(overlay.bundle.resources['../freerdp-runtime/*.dll'], '');
});
