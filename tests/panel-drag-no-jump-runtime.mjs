import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8767/tests/fixtures/panel-drag-no-jump-harness.html';
const chromium = process.env.CHROMIUM || 'chromium-browser';
const userData = `/tmp/panel-nojump-chrome-${Date.now()}`;
const port = 9400 + Math.floor(Math.random() * 200);

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

async function waitList(ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`devtools not ready\n${stderr.slice(-800)}`);
}

async function cdpEval(wsUrl) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
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
        let result = null;
        for (let i = 0; i < 80; i++) {
          const r = await send('Runtime.evaluate', {
            expression: `(() => window.__HARNESS && window.__HARNESS.ready ? JSON.stringify(window.__HARNESS) : null)()`,
            returnByValue: true,
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
  const list = await waitList();
  const page = list.find((t) => t.type === 'page' && t.url.includes('panel-drag-no-jump')) || list[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('no page');
  const harness = await cdpEval(page.webSocketDebuggerUrl);
  proc.kill('SIGKILL');
  if (harness.error) {
    console.error('HARNESS_ERROR', harness.error);
    process.exit(2);
  }
  console.log(JSON.stringify(harness.steps, null, 2));
  const s = harness.steps;
  const ok = s.physicsReady
    && s.bakeExact
    && s.noPostJump
    && s.minTopIsZero
    && s.finalInside
    && s.transformCleared
    && s.moved
    && Math.abs(s.bakeVisualDx || 0) < 1.0
    && Math.abs(s.bakeVisualDy || 0) < 1.0;
  if (!ok) {
    console.error('ASSERT_FAIL', {
      physicsReady: s.physicsReady,
      bakeExact: s.bakeExact,
      bakeVisualDx: s.bakeVisualDx,
      bakeVisualDy: s.bakeVisualDy,
      noPostJump: s.noPostJump,
      maxPostBakeJump: s.maxPostBakeJump,
      minTopIsZero: s.minTopIsZero,
      finalInside: s.finalInside,
      transformCleared: s.transformCleared,
      moved: s.moved,
      final: s.final,
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
