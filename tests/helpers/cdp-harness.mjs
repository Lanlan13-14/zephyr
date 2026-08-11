
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

export function findBrowser() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch headless Chrome with a throwaway profile and return a CDP handle. */
export async function launchBrowser({ port = 39222, timeoutMs = 30000 } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('no Chromium-family browser found');
  const profile = mkdtempSync(join(tmpdir(), 'zephyr-cdp-'));

  const child = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for the HTTP endpoint rather than parsing stderr: the banner format
  // differs between Chrome and Edge and between versions.
  const deadline = Date.now() + timeoutMs;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      wsUrl = info.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  if (!wsUrl) {
    child.kill();
    throw new Error('browser did not expose a debugging endpoint\n' + stderr.slice(-2000));
  }

  return { bin, child, port, profile, wsUrl };
}

export function closeBrowser(handle) {
  try { handle.child.kill(); } catch { /* already gone */ }
  try { rmSync(handle.profile, { recursive: true, force: true }); } catch { /* leave it */ }
}

/** Minimal CDP session over a single WebSocket. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/**
 * Open one page and collect everything that would tell a user "load failed":
 * console errors, uncaught exceptions, and failed network requests.
 */
export async function collectPageDiagnostics(wsUrl, url, { settleMs = 3500, cookies = [] } = {}) {
  const cdp = await Cdp.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const consoleErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const failedRequests = [];
  const scriptResponses = [];
  const requestUrls = new Map();

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type)))
      .join(' ');
    if (p.type === 'error') consoleErrors.push(text);
    else if (p.type === 'warning') consoleWarnings.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    exceptions.push(
      (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown exception'
    );
  });
  cdp.on('Network.requestWillBeSent', (p) => {
    requestUrls.set(p.requestId, p.request.url);
  });
  cdp.on('Network.loadingFailed', (p) => {
    failedRequests.push({
      url: requestUrls.get(p.requestId) || '(unknown)',
      error: p.errorText,
      type: p.type,
    });
  });
  cdp.on('Network.responseReceived', (p) => {
    if (p.type === 'Script') {
      scriptResponses.push({
        url: p.response.url,
        status: p.response.status,
        mimeType: p.response.mimeType,
      });
    }
    if (p.response.status >= 400) {
      failedRequests.push({
        url: p.response.url,
        error: 'HTTP ' + p.response.status,
        type: p.type,
      });
    }
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);

  for (const cookie of cookies) {
    const result = await cdp.send('Network.setCookie', cookie, sessionId);
    if (!result.success) throw new Error(`CDP rejected cookie ${cookie.name}`);
  }

  await cdp.send('Page.navigate', { url }, sessionId);

  // Fixed settle window: this app boots asynchronously (fetches settings, then
  // renders), so waiting only for the load event would miss errors thrown later.
  await sleep(settleMs);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result.value;
  };

  return {
    cdp, sessionId, evaluate,
    consoleErrors, consoleWarnings, exceptions, failedRequests, scriptResponses,
    async screenshot() {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      return Buffer.from(r.data, 'base64');
    },
    close() { cdp.close(); },
  };
}
