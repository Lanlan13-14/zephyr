import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs']);
const FORBIDDEN_ONE_FILES = [
  'public/rdp.html',
  'public/rdp-audio-scheduler.js',
  'public/rdp-diagnostics.js',
  'public/rdp-fs-provider.js',
  'public/rdp-input-channel.js',
  'public/rdp-mobile-keyboard.js',
  'public/rdp-render-command-queue.js',
  'public/rdp-renderer.js',
  'public/rdp-resolution-policy.js',
  'public/rdp-touch.js',
  'public/rdp-trace.js',
  'public/rdp-video-decoder.js',
  'public/rdp-wasm-client.js',
  'public/rdp-wasm-memory.js',
  'public/rdp-wasm-runtime.js',
  'public/rdp-worker-bridge.js',
  'public/rdp-worker-frame-scheduler.js',
  'public/rdp-worker.js',
  'public/rdp-worker-probe.js',
  'public/vendor/rdp-wasm',
];
const REQUIRED_WEB_FILES = [
  'rdp.html',
  'rdp-wasm-client.js',
  'rdp-wasm-runtime.js',
  'rdp-worker.js',
  'vendor/rdp-wasm/main.wasm',
];
const NATIVE_FAMILIES = [
  { name: 'FreeRDP 3 core', pattern: /(?:^|[/\\])(?:lib)?freerdp3(?=[-.\s(),]|$)/i },
  { name: 'FreeRDP 3 client', pattern: /(?:^|[/\\])(?:lib)?freerdp-client3(?=[-.\s(),]|$)/i },
  { name: 'WinPR 3', pattern: /(?:^|[/\\])(?:lib)?winpr3(?=[-.\s(),]|$)/i },
];
const NATIVE_LIBRARY_PATTERN = /(?:^|[/\\\s(])(?:lib)?(?:freerdp(?:-[a-z-]+)?|winpr(?:-[a-z-]+)?)(\d*)(?=[-.\s(),]|$)/gi;
const NATIVE_LIBRARY_ARTIFACT_PATTERN = /(?:\.a|\.lib|\.dll|\.dylib|\.so(?:\.\d+)*|\.pc)$/i;
const PATCHED_FREERDP_STAMP = '3.30.0+cliprdr-reassembly-limit-v1';
const PATCHED_FREERDP_DEFINE = '#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1';

function fail(message) {
  throw new Error(`FreeRDP packaging contract: ${message}`);
}

function requirePath(target, kind = 'path') {
  if (!fs.existsSync(target)) fail(`${kind} does not exist: ${target}`);
}

function relativeSlash(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function walkFiles(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  return result;
}

export function assertFreeRdp3Only(values, context) {
  const invalid = [];
  for (const value of values) {
    for (const match of String(value).matchAll(NATIVE_LIBRARY_PATTERN)) {
      if (match[1] !== '3') invalid.push(value);
    }
  }
  if (invalid.length) {
    fail(`${context} contains non-v3 FreeRDP/WinPR libraries: ${[...new Set(invalid)].join(', ')}`);
  }

  const missing = NATIVE_FAMILIES
    .filter(({ pattern }) => !values.some((value) => pattern.test(value)))
    .map(({ name }) => name);
  if (missing.length) {
    fail(`${context} is missing ${missing.join(', ')}. Observed: ${values.join(', ') || '(none)'}`);
  }
}

export function assertNoDynamicFreeRdp(values, context) {
  const found = values.filter((value) => [...String(value).matchAll(NATIVE_LIBRARY_PATTERN)].length > 0);
  if (found.length) {
    fail(`${context} dynamically references FreeRDP/WinPR despite the pinned static-link contract: ${found.join(', ')}`);
  }
}

export function verifyPatchedFreeRdpInstall(installRoot) {
  installRoot = path.resolve(installRoot);
  requirePath(installRoot, 'pinned FreeRDP install');
  const stamp = path.join(installRoot, '.zephyr-freerdp-tag');
  const header = path.join(installRoot, 'include', 'freerdp3', 'freerdp', 'client', 'channels.h');
  requirePath(stamp, 'patched FreeRDP stamp');
  requirePath(header, 'patched FreeRDP public header');
  if (fs.readFileSync(stamp, 'utf8').trim() !== PATCHED_FREERDP_STAMP) {
    fail(`patched FreeRDP stamp is not ${PATCHED_FREERDP_STAMP}`);
  }
  if (!fs.readFileSync(header, 'utf8').split(/\r?\n/).some((line) => line.trim() === PATCHED_FREERDP_DEFINE)) {
    fail(`patched FreeRDP header is missing ${PATCHED_FREERDP_DEFINE}`);
  }

  const files = walkFiles(installRoot);
  const relativeFiles = files.map((file) => relativeSlash(installRoot, file));
  const nativeArtifacts = relativeFiles.filter(
    (file) => /(?:freerdp|winpr)/i.test(file) && NATIVE_LIBRARY_ARTIFACT_PATTERN.test(file),
  );
  assertFreeRdp3Only(nativeArtifacts, 'pinned install');
  if (nativeArtifacts.some((file) => /\.lib$/i.test(file))) {
    for (const name of ['remdesk-common.lib', 'rdpsnd-common.lib']) {
      if (!relativeFiles.some((file) => path.basename(file).toLowerCase() === name)) {
        fail(`pinned Windows static install is missing private channel archive ${name}`);
      }
    }
    const unixOnlyFlags = [];
    for (const file of files.filter((candidate) => path.extname(candidate).toLowerCase() === '.pc')) {
      const matches = fs.readFileSync(file, 'utf8').match(/-l(?:dl|rt|pthread|m)(?=\s|$)/g) || [];
      if (matches.length) unixOnlyFlags.push(`${relativeSlash(installRoot, file)}: ${matches.join(', ')}`);
    }
    if (unixOnlyFlags.length) {
      fail(`pinned Windows pkg-config metadata contains Unix-only libraries: ${unixOnlyFlags.join('; ')}`);
    }
  }
  for (const name of ['freerdp3.pc', 'freerdp-client3.pc', 'winpr3.pc']) {
    const file = files.find((candidate) => path.basename(candidate) === name);
    if (!file) fail(`pinned install is missing pkg-config module ${name}`);
    if (!/^Version:\s*3\.30\.0\s*$/m.test(fs.readFileSync(file, 'utf8'))) {
      fail(`${name} does not report pinned version 3.30.0`);
    }
  }
}

function runTool(candidates, args, context) {
  const errors = [];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, args, { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0) return `${result.stdout || ''}\n${result.stderr || ''}`;
    errors.push(
      result.error?.message || `${candidate} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  fail(`${context} could not run (${errors.join(' | ')})`);
}

export function parseWindowsDependencies(output) {
  return [...new Set(output.match(/[A-Za-z0-9_.+-]+\.dll/gi) || [])];
}

function readCString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) fail(`PE string offset is outside the file: ${offset}`);
  const end = buffer.indexOf(0, offset);
  if (end < 0) fail(`PE string at offset ${offset} is not NUL terminated`);
  return buffer.toString('ascii', offset, end);
}

export function parsePeDependencies(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    fail('Windows executable is not a valid PE file (missing MZ header)');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail('Windows executable is not a valid PE file (missing PE header)');
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalOffset);
  const directoryOffset = optionalOffset + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (directoryOffset < optionalOffset || directoryOffset + 16 > buffer.length) {
    fail(`Windows executable has an unsupported PE optional-header magic: 0x${magic.toString(16)}`);
  }
  const importRva = buffer.readUInt32LE(directoryOffset + 8);
  if (!importRva) return [];

  const sectionsOffset = optionalOffset + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionsOffset + index * 40;
    if (offset + 40 > buffer.length) fail('Windows executable has a truncated PE section table');
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20),
    });
  }
  const rvaToOffset = (rva) => {
    const section = sections.find(({ virtualAddress, virtualSize, rawSize }) =>
      rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize),
    );
    if (!section) fail(`PE RVA 0x${rva.toString(16)} is not covered by a section`);
    return section.rawOffset + (rva - section.virtualAddress);
  };

  const imports = [];
  let descriptorOffset = rvaToOffset(importRva);
  for (let count = 0; count < 4096; count += 1, descriptorOffset += 20) {
    if (descriptorOffset + 20 > buffer.length) fail('Windows executable has a truncated PE import table');
    const fields = Array.from({ length: 5 }, (_, index) => buffer.readUInt32LE(descriptorOffset + index * 4));
    if (fields.every((value) => value === 0)) return [...new Set(imports)];
    imports.push(readCString(buffer, rvaToOffset(fields[3])));
  }
  fail('Windows executable PE import table did not terminate');
}

export function parseMachODependencies(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(compatibility version/i)[0])
    .filter(Boolean);
}

export function parseElfDependencies(output) {
  return [...new Set(
    [...output.matchAll(/\(NEEDED\)\s+Shared library:\s*\[([^\]]+)\]/g)].map((match) => match[1]),
  )];
}

export function verifyStagedCore(stagedCore, webPublic) {
  stagedCore = path.resolve(stagedCore);
  webPublic = path.resolve(webPublic);
  requirePath(stagedCore, 'staged core');
  requirePath(webPublic, 'standalone Web public directory');

  for (const relative of FORBIDDEN_ONE_FILES) {
    const target = path.join(stagedCore, ...relative.split('/'));
    if (fs.existsSync(target)) fail(`Zephyr One staged a browser-only RDP asset: ${relative}`);
  }

  const stagedPublic = path.join(stagedCore, 'public');
  requirePath(stagedPublic, 'staged public directory');
  const forbiddenReferences = [];
  for (const file of walkFiles(stagedPublic)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/rdp-wasm/i.test(source) || /(?:^|["'`(=\s])\/rdp\.html(?:[?"'`\s)]|$)/im.test(source)) {
      forbiddenReferences.push(relativeSlash(stagedCore, file));
    }
  }
  if (forbiddenReferences.length) {
    fail(`Zephyr One public assets still reference WASM RDP or /rdp.html: ${forbiddenReferences.join(', ')}`);
  }

  for (const relative of REQUIRED_WEB_FILES) {
    requirePath(path.join(webPublic, ...relative.split('/')), `standalone Web asset ${relative}`);
  }
  const webRdpHtml = fs.readFileSync(path.join(webPublic, 'rdp.html'), 'utf8');
  if (!/rdp-wasm-client\.js/.test(webRdpHtml)) {
    fail('standalone Web rdp.html no longer references its WASM client');
  }
  const webApp = fs.readFileSync(path.join(webPublic, 'app.js'), 'utf8');
  if (!/\/rdp\.html(?:\?|["'`])/.test(webApp)) {
    fail('standalone Web app.js no longer routes browser RDP sessions to /rdp.html');
  }
}

export function verifyWindowsBundle(executable, dllRoot) {
  executable = path.resolve(executable);
  dllRoot = path.resolve(dllRoot);
  requirePath(executable, 'Windows executable');
  requirePath(dllRoot, 'Windows DLL directory');

  const imports = parsePeDependencies(fs.readFileSync(executable));
  assertFreeRdp3Only(imports, `${path.basename(executable)} imports`);

  const bundledDlls = fs.readdirSync(dllRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dll')
    .map((entry) => entry.name);
  assertFreeRdp3Only(bundledDlls, `DLL payload under ${dllRoot}`);

  const missingImports = imports
    .filter((name) => NATIVE_FAMILIES.some(({ pattern }) => pattern.test(name)))
    .filter((name) => !bundledDlls.some((bundled) => bundled.toLowerCase() === name.toLowerCase()));
  if (missingImports.length) fail(`Windows payload is missing imported DLLs: ${missingImports.join(', ')}`);
}

export function verifyWindowsStaticBundle(executable, dllRoot) {
  executable = path.resolve(executable);
  dllRoot = path.resolve(dllRoot);
  requirePath(executable, 'Windows executable');
  requirePath(dllRoot, 'Windows DLL directory');
  const imports = parsePeDependencies(fs.readFileSync(executable));
  assertNoDynamicFreeRdp(imports, `${path.basename(executable)} imports`);
  const bundledDlls = fs.readdirSync(dllRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.dll')
    .map((entry) => entry.name);
  assertNoDynamicFreeRdp(bundledDlls, `DLL payload under ${dllRoot}`);
}

export function verifyMacosBundle(appBundle, { staticFreeRdp = false } = {}) {
  appBundle = path.resolve(appBundle);
  const macosDir = path.join(appBundle, 'Contents', 'MacOS');
  const frameworksDir = path.join(appBundle, 'Contents', 'Frameworks');
  requirePath(macosDir, 'macOS executable directory');
  requirePath(frameworksDir, 'macOS Frameworks directory');
  const executables = fs.readdirSync(macosDir)
    .map((name) => path.join(macosDir, name))
    .filter((file) => fs.statSync(file).isFile());
  if (executables.length !== 1) {
    fail(`expected one main executable in ${macosDir}, found ${executables.length}`);
  }

  const frameworkFiles = walkFiles(frameworksDir)
    .filter((file) => file.endsWith('.dylib') || file.includes('.framework'));
  const inspected = [executables[0], ...frameworkFiles];
  const allDependencies = [];
  const unresolved = [];
  for (const binary of inspected) {
    const dependencies = parseMachODependencies(runTool(['otool'], ['-L', binary], `otool for ${binary}`));
    allDependencies.push(...dependencies);
    for (const dependency of dependencies) {
      if (dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) continue;
      let resolved;
      if (dependency.startsWith('@executable_path/')) {
        resolved = path.resolve(macosDir, dependency.slice('@executable_path/'.length));
      } else if (dependency.startsWith('@loader_path/')) {
        resolved = path.resolve(path.dirname(binary), dependency.slice('@loader_path/'.length));
      } else if (dependency.startsWith('@rpath/')) {
        const suffix = dependency.slice('@rpath/'.length).split('/').join(path.sep);
        resolved = frameworkFiles.find((file) => file.endsWith(suffix));
      } else if (path.isAbsolute(dependency) && dependency.startsWith(`${appBundle}${path.sep}`)) {
        resolved = dependency;
      }
      if (!resolved || !fs.existsSync(resolved)) {
        unresolved.push(`${relativeSlash(appBundle, binary)} -> ${dependency}`);
      }
    }
  }
  if (unresolved.length) {
    fail(`macOS app has unresolved or build-host Mach-O dependencies: ${unresolved.join(', ')}`);
  }
  if (staticFreeRdp) assertNoDynamicFreeRdp(allDependencies, 'macOS Mach-O dependency closure');
  else assertFreeRdp3Only(allDependencies, 'macOS Mach-O dependency closure');

  const bundledNames = frameworkFiles.map((file) => path.basename(file));
  if (staticFreeRdp) assertNoDynamicFreeRdp(bundledNames, 'macOS Contents/Frameworks payload');
  else assertFreeRdp3Only(bundledNames, 'macOS Contents/Frameworks payload');
}

export function verifyLinuxBundles(executable, bundleRoot, { staticFreeRdp = false } = {}) {
  executable = path.resolve(executable);
  bundleRoot = path.resolve(bundleRoot);
  requirePath(executable, 'Linux executable');
  requirePath(bundleRoot, 'Linux bundle directory');
  const imports = parseElfDependencies(runTool(['readelf'], ['-d', executable], `readelf for ${executable}`));
  if (staticFreeRdp) assertNoDynamicFreeRdp(imports, `${path.basename(executable)} ELF imports`);
  else assertFreeRdp3Only(imports, `${path.basename(executable)} ELF imports`);

  const packages = walkFiles(bundleRoot).filter((file) => /\.(?:deb|rpm)$/i.test(file));
  if (!packages.length) fail(`no .deb or .rpm packages found under ${bundleRoot}`);
  for (const file of packages) {
    const dependencies = file.toLowerCase().endsWith('.deb')
      ? runTool(['dpkg-deb'], ['-f', file, 'Depends'], `Debian dependency metadata for ${file}`)
      : runTool(['rpm'], ['-qp', '--requires', file], `RPM dependency metadata for ${file}`);
    const packageDependencies = dependencies.split(/\s|,|\|/).filter(Boolean);
    if (staticFreeRdp) assertNoDynamicFreeRdp(packageDependencies, `${path.basename(file)} package dependencies`);
    else assertFreeRdp3Only(packageDependencies, `${path.basename(file)} package dependencies`);
  }
}

function usage() {
  console.error('usage: verify-rdp-packaging.mjs <staged|patched-install|windows|windows-static|macos|macos-static|linux|linux-static> <arguments...>');
  process.exitCode = 2;
}

function main(argv) {
  const [mode, ...args] = argv;
  if (mode === 'staged' && args.length === 2) verifyStagedCore(args[0], args[1]);
  else if (mode === 'patched-install' && args.length === 1) verifyPatchedFreeRdpInstall(args[0]);
  else if (mode === 'windows' && args.length === 2) verifyWindowsBundle(args[0], args[1]);
  else if (mode === 'windows-static' && args.length === 2) verifyWindowsStaticBundle(args[0], args[1]);
  else if (mode === 'macos' && args.length === 1) verifyMacosBundle(args[0]);
  else if (mode === 'macos-static' && args.length === 1) verifyMacosBundle(args[0], { staticFreeRdp: true });
  else if (mode === 'linux' && args.length === 2) verifyLinuxBundles(args[0], args[1]);
  else if (mode === 'linux-static' && args.length === 2) verifyLinuxBundles(args[0], args[1], { staticFreeRdp: true });
  else return usage();
  console.log(`FreeRDP packaging contract passed: ${mode}`);
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
