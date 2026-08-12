import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const oneRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const embeddedSource = path.join(oneRoot, 'src', 'rdp', 'native-rdp-embedded.js');
const nativeFrame = "`about:blank#zephyr-one-native-rdp?tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}`";
const browserFramePattern = /`\/rdp\.html\?[^`\r\n]*`/g;
const browserOnlyAssets = [
  'rdp.html',
  'rdp-audio-scheduler.js',
  'rdp-diagnostics.js',
  'rdp-fs-provider.js',
  'rdp-input-channel.js',
  'rdp-mobile-keyboard.js',
  'rdp-render-command-queue.js',
  'rdp-renderer.js',
  'rdp-resolution-policy.js',
  'rdp-touch.js',
  'rdp-trace.js',
  'rdp-video-decoder.js',
  'rdp-wasm-client.js',
  'rdp-wasm-memory.js',
  'rdp-wasm-runtime.js',
  'rdp-worker-bridge.js',
  'rdp-worker-frame-scheduler.js',
  'rdp-worker-probe.js',
  'rdp-worker.js',
];
const textExtensions = new Set(['.html', '.js', '.mjs', '.css', '.json']);
const forbidden = [/rdp-wasm/i, /\/rdp\.html/i];

function isStrictlyInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertPathChainHasNoLinks(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`staged root path must not contain a symlink or junction: ${current}`);
    }
  }
}

function assertSafeStagedPublic(stagedRoot, publicDir) {
  assertPathChainHasNoLinks(stagedRoot);
  const rootStat = fs.lstatSync(stagedRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`staged root must be a real directory, not a symlink or junction: ${stagedRoot}`);
  }

  const realRoot = fs.realpathSync.native(stagedRoot);
  const pending = [publicDir];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    const relative = path.relative(stagedRoot, current) || '.';
    if (stat.isSymbolicLink()) {
      throw new Error(`staged public tree contains a symlink or junction: ${relative}`);
    }

    const realCurrent = fs.realpathSync.native(current);
    if (!isStrictlyInside(realRoot, realCurrent)) {
      throw new Error(`staged public path resolves outside the staged root: ${relative}`);
    }
    if (!stat.isDirectory()) continue;

    for (const entry of fs.readdirSync(current)) {
      pending.push(path.join(current, entry));
    }
  }
}

function scan(dir, publicDir, remaining) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file, publicDir, remaining);
    else if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
      const source = fs.readFileSync(file, 'utf8');
      if (forbidden.some((pattern) => pattern.test(source))) {
        remaining.push(path.relative(publicDir, file));
      }
    }
  }
}

function assertBrowserFrameContract(browserFrame) {
  const query = browserFrame.slice(1, -1).split('?')[1];
  const parameters = new Map(query.split('&').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const expected = new Map([
    ['embed', '1'],
    ['tabId', '${encodeURIComponent(session.id)}'],
    ['connectionId', "${encodeURIComponent(session.connectionId || '')}"],
  ]);
  const invalid = [...expected].filter(([name, value]) => parameters.get(name) !== value);
  if (invalid.length) {
    throw new Error(
      `browser RDP frame entry in staged app.js has invalid ${invalid.map(([name]) => name).join(', ')} binding`,
    );
  }
}

export function stageNativeRdp(stagedRoot = path.join(oneRoot, 'zephyr-core')) {
  stagedRoot = path.resolve(stagedRoot);
  const publicDir = path.join(stagedRoot, 'public');
  const appFile = path.join(publicDir, 'app.js');
  const embeddedTarget = path.join(publicDir, 'zephyr-one-native-rdp.js');

  if (!fs.existsSync(appFile)) throw new Error(`staged app.js is missing: ${appFile}`);
  if (!fs.existsSync(embeddedSource)) throw new Error(`native RDP overlay is missing: ${embeddedSource}`);
  assertSafeStagedPublic(stagedRoot, publicDir);
  if (!fs.lstatSync(appFile).isFile()) throw new Error(`staged app.js is not a regular file: ${appFile}`);

  const appSource = fs.readFileSync(appFile, 'utf8');
  const browserFrames = appSource.match(browserFramePattern) || [];
  if (browserFrames.length !== 1) {
    throw new Error(`expected one browser RDP frame entry in staged app.js, found ${browserFrames.length}`);
  }
  assertBrowserFrameContract(browserFrames[0]);

  const stagedAppSource = appSource.replace(browserFrames[0], nativeFrame);
  const nativeFrameCount = stagedAppSource.split(nativeFrame).length - 1;
  if (nativeFrameCount !== 1 || browserFramePattern.test(stagedAppSource)) {
    throw new Error('native RDP frame replacement did not produce exactly one native-only entry');
  }
  fs.writeFileSync(appFile, stagedAppSource);
  fs.copyFileSync(embeddedSource, embeddedTarget);

  for (const asset of browserOnlyAssets) {
    fs.rmSync(path.join(publicDir, asset), { force: true });
  }
  fs.rmSync(path.join(publicDir, 'vendor', 'rdp-wasm'), { recursive: true, force: true });

  const remaining = [];
  scan(publicDir, publicDir, remaining);
  if (remaining.length) {
    throw new Error(`browser RDP references remain in staged public assets: ${remaining.join(', ')}`);
  }

  return embeddedTarget;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const target = stageNativeRdp(process.argv[2]);
  console.log(`Staged native RDP overlay: ${target}`);
}
