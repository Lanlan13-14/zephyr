import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [process.env.CHROMIUM_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
const chromium = candidates.find(existsSync);
if (!chromium) { console.error('Chromium is required for test:browser-smoke'); process.exit(2); }
const port = 18765;
const url = `http://127.0.0.1:${port}/tests/rdp-renderer-browser-smoke.html`;
const server = spawn(process.execPath, ['tests/static-smoke-server.mjs', String(port)], { stdio: 'ignore' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await wait(100);
  }
  throw new Error('static smoke server did not become ready');
}
function runChromium() {
  const profile = mkdtempSync(join(tmpdir(), 'zephyr-smoke-'));
  try {
    return spawnSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--virtual-time-budget=5000', '--dump-dom', url], { encoding: 'utf8', timeout: 45000 });
  } finally { rmSync(profile, { recursive: true, force: true }); }
}

try {
  await waitForServer();
  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = runChromium();
    if (!result.error && result.status === 0) break;
    if (attempt === 1) await wait(500);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Chromium exited ${result.status}: ${result.stderr}`);
  const match = result.stdout.match(/<pre id="out">([^<]+)<\/pre>/);
  if (!match) throw new Error(`smoke result missing: ${result.stderr}`);
  const value = JSON.parse(match[1].replaceAll('&quot;', '"'));
  if (!value.ok || value.presents?.[0] !== 1 || value.pixels?.length !== 32) throw new Error(`smoke failed: ${JSON.stringify(value)}`);
  console.log(JSON.stringify(value));
} finally { server.kill('SIGTERM'); }
