import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8766/tests/fixtures/panel-drag-physics-harness.html';
const chromium = process.env.CHROMIUM || 'chromium-browser';

const userData = `/tmp/panel-drag-chrome-${Date.now()}`;
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  `--user-data-dir=${userData}`,
  '--virtual-time-budget=8000',
  `--dump-dom`,
  URL,
];

// Prefer CDP evaluate via remote debugging for reliable JS state.
const port = 9333 + Math.floor(Math.random() * 200);
const proc = spawn(chromium, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  `--user-data-dir=${userData}`,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  URL,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderr = '';
proc.stderr.on('data', (d) => { stderr += d.toString(); });

async function waitPort(ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`devtools port not ready\n${stderr.slice(-800)}`);
}

function wsUrl(list) {
  const page = list.find((t) => t.type === 'page' && t.url.includes('panel-drag-physics-harness')) || list[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

async function cdpEval(ws, expression) {
  const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
  if (!WebSocket) {
    // Fallback: use chrome-remote-interface free path via HTTP is not available.
    // Install nothing — use node experimental websocket if present.
  }
  const WS = globalThis.WebSocket || (await import('ws')).default;
  return new Promise((resolve, reject) => {
    const sock = new WS(ws);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      sock.send(JSON.stringify({ id: mid, method, params }));
    });
    sock.onopen = async () => {
      try {
        await send('Runtime.enable');
        // wait for harness
        let result = null;
        for (let i = 0; i < 50; i++) {
          const r = await send('Runtime.evaluate', {
            expression: `(() => window.__HARNESS && window.__HARNESS.ready ? JSON.stringify(window.__HARNESS) : null)()`,
            returnByValue: true,
            awaitPromise: false,
          });
          const v = r?.result?.result?.value;
          if (v) { result = JSON.parse(v); break; }
          await sleep(100);
        }
        sock.close();
        if (!result) reject(new Error('harness not ready'));
        else resolve(result);
      } catch (e) {
        try { sock.close(); } catch {}
        reject(e);
      }
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg);
      }
    };
    sock.onerror = (e) => reject(e.error || e);
  });
}

try {
  const list = await waitPort();
  // Prefer undici/ws; if ws missing, install is not allowed mid-flight — try native.
  let harness;
  try {
    harness = await cdpEval(wsUrl(list));
  } catch (e) {
    // last-ditch: dump via Runtime over fetch is impossible; rethrow
    throw e;
  }
  proc.kill('SIGKILL');
  if (harness.error) {
    console.error('HARNESS_ERROR', harness.error);
    process.exit(2);
  }
  console.log(JSON.stringify(harness.steps, null, 2));
  const ok = harness.steps.physicsReady
    && harness.steps.moved
    && harness.steps.stuckClassCleared
    && harness.steps.noFrontSwitching
    && Math.abs(harness.steps.dx) > 40;
  if (!ok) {
    console.error('ASSERT_FAIL', {
      physicsReady: harness.steps.physicsReady,
      moved: harness.steps.moved,
      dx: harness.steps.dx,
      dy: harness.steps.dy,
      stuckClassCleared: harness.steps.stuckClassCleared,
    });
    process.exit(1);
  }
  console.log('RUNTIME_OK');
  process.exit(0);
} catch (err) {
  try { proc.kill('SIGKILL'); } catch {}
  console.error(String(err && err.stack || err));
  console.error('stderr_tail', stderr.slice(-1000));
  process.exit(1);
}
