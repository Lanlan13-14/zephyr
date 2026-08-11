import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const oneRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagedRoot = path.resolve(process.argv[2] || path.join(oneRoot, 'zephyr-core'));
const publicDir = path.join(stagedRoot, 'public');
const appFile = path.join(publicDir, 'app.js');
const embeddedSource = path.join(oneRoot, 'src', 'rdp', 'native-rdp-embedded.js');
const embeddedTarget = path.join(publicDir, 'zephyr-one-native-rdp.js');

if (!fs.existsSync(appFile)) throw new Error(`staged app.js is missing: ${appFile}`);
if (!fs.existsSync(embeddedSource)) throw new Error(`native RDP overlay is missing: ${embeddedSource}`);

const browserFrame = "`/rdp.html?embed=1&theme=${encodeURIComponent(frameTheme)}&tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}&v=20260804-rdp-ssh-scroll4`";
const nativeFrame = "`about:blank#zephyr-one-native-rdp?tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}`";
const appSource = fs.readFileSync(appFile, 'utf8');
const matches = appSource.split(browserFrame).length - 1;
if (matches !== 1) {
  throw new Error(`expected one browser RDP frame entry in staged app.js, found ${matches}`);
}
fs.writeFileSync(appFile, appSource.replace(browserFrame, nativeFrame));
fs.copyFileSync(embeddedSource, embeddedTarget);

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
for (const asset of browserOnlyAssets) {
  fs.rmSync(path.join(publicDir, asset), { force: true });
}
fs.rmSync(path.join(publicDir, 'vendor', 'rdp-wasm'), { recursive: true, force: true });

const textExtensions = new Set(['.html', '.js', '.mjs', '.css', '.json']);
const forbidden = [/rdp-wasm/i, /\/rdp\.html/i];
const remaining = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
      const source = fs.readFileSync(file, 'utf8');
      if (forbidden.some((pattern) => pattern.test(source))) {
        remaining.push(path.relative(publicDir, file));
      }
    }
  }
}
scan(publicDir);
if (remaining.length) {
  throw new Error(`browser RDP references remain in staged public assets: ${remaining.join(', ')}`);
}

console.log(`Staged native RDP overlay: ${embeddedTarget}`);
