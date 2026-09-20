/**
 * Embedded Zephyr core runtime for the Electron shell.
 *
 * Port of the former Tauri runtime: spawn a loopback Node child, exchange a
 * one-time startup challenge for an HttpOnly session cookie, then load the
 * product UI in the trusted BrowserWindow.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STARTUP_CHALLENGE_ENV = 'ZEPHYR_ONE_STARTUP_CHALLENGE';
const READY_PROBE_HEADER = 'X-Zephyr-One-Ready-Probe';
const READY_PROOF_HEADER = 'x-zephyr-one-ready-proof';
const BOOTSTRAP_HEADER = 'X-Zephyr-One-Bootstrap-Challenge';
const READY_CONTEXT = Buffer.from('zephyr-one-ready-v1\0', 'utf8');
const LOCAL_APP_PATH = '/app.html?zephyrOne=1';
const UI_READY_MARKER = 'zephyr-one-ui-ready.json';
const EMBEDDED_CORE_READY_TIMEOUT_MS = process.platform === 'win32' ? 210_000 : 60_000;

const state = {
  child: null,
  port: 0,
  baseUrl: '',
  startupChallenge: null,
  sessionReady: false,
  sessionId: '',
  localAppOrigin: '',
  dataDir: '',
  nodePath: '',
  autostartLog: null,
};

function encodeHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function generateChallenge() {
  return crypto.randomBytes(32);
}

function nodeCompatiblePath(value) {
  const text = String(value);
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice(8)}`;
  if (text.startsWith('\\\\?\\')) return text.slice(4);
  return value;
}

function appendLog(message) {
  const logPath = state.autostartLog;
  if (!logPath) return;
  const millis = Date.now();
  const line = `${millis} pid=${process.pid} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch { /* best effort */ }
}

export function appendRuntimeLog(userDataDir, message) {
  const logPath = path.join(userDataDir, 'zephyr-data', 'zephyr-autostart.log');
  state.autostartLog = logPath;
  appendLog(message);
}

export function shouldAutostart(config, windowsRelease) {
  const value = String(config || '').trim();
  if (['1', 'true', 'yes', 'on'].some((enabled) => value.toLowerCase() === enabled)) return true;
  if (['0', 'false', 'no', 'off'].some((disabled) => value.toLowerCase() === disabled)) return false;
  return !!windowsRelease;
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function resourceCandidates(resourceDir, relative) {
  return [
    path.join(resourceDir, relative),
    path.join(resourceDir, '_up_', relative),
    path.join(resourceDir, 'resources', relative),
    path.join(resourceDir, 'resources', '_up_', relative),
  ];
}

export function resolveCoreDir({ resourceDir, appPath, isPackaged }) {
  const candidates = [];
  if (resourceDir) candidates.push(...resourceCandidates(resourceDir, 'zephyr-core'));
  if (!isPackaged) {
    candidates.push(path.join(appPath, 'zephyr-core'));
    candidates.push(path.join(appPath, '..', 'zephyr-core'));
    candidates.push(path.join(appPath, '..'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'server.js')) && fs.existsSync(path.join(candidate, 'public'))) {
      return nodeCompatiblePath(fs.realpathSync(candidate));
    }
  }
  throw new Error('未找到本地 Zephyr 核心（server.js + public）。构建前请运行 scripts/stage-zephyr-core.sh');
}

export function resolveNodeBin({ resourceDir, appPath, isPackaged }) {
  if (resourceDir) {
    for (const root of resourceCandidates(resourceDir, 'desktop-runtime')) {
      for (const name of ['node.exe', 'node', path.join('bin', 'node')]) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
  }
  if (!isPackaged) {
    if (process.env.ZEPHYR_NODE_PATH && fs.existsSync(process.env.ZEPHYR_NODE_PATH)) {
      return process.env.ZEPHYR_NODE_PATH;
    }
    for (const name of ['desktop-runtime/node.exe', 'desktop-runtime/node']) {
      const candidate = path.join(appPath, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return process.execPath;
  }
  throw new Error('安装包缺少内置 Node 运行时，请重新安装 Zephyr One。');
}

function readinessMac(challenge, probe, port) {
  return crypto.createHmac('sha256', challenge)
    .update(READY_CONTEXT)
    .update(probe)
    .update('\0', 'utf8')
    .update(String(port), 'utf8')
    .digest();
}

function requestOnce(url, { method = 'GET', headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitHttpReady(child, url, port, challenge, timeoutMs) {
  const probe = crypto.randomBytes(32);
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      if (child.exitCode != null) {
        throw new Error(`本地 Zephyr 进程提前退出（${child.exitCode}）`);
      }
      try {
        const response = await requestOnce(url, {
          headers: { [READY_PROBE_HEADER]: encodeHex(probe) },
          timeoutMs: 2000,
        });
        const proof = String(response.headers[READY_PROOF_HEADER] || '');
        const expected = readinessMac(challenge, probe, port).toString('hex');
        if (response.status === 200 && proof === expected) return;
      } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`本地 Zephyr 启动超时（${url}）`);
  } finally {
    probe.fill(0);
  }
}

function sessionIdFromSetCookie(header) {
  const match = String(header || '').match(/zephyr_sid=([^;]+)/i);
  if (!match) return '';
  const sid = decodeURIComponent(match[1]);
  if (sid.length < 16 || sid.length > 256) return '';
  if (![...sid].every((ch) => /[A-Za-z0-9_-]/.test(ch))) return '';
  return sid;
}

async function exchangeBootstrap(baseUrl, challenge) {
  const response = await requestOnce(`${baseUrl.replace(/\/+$/, '')}/__zephyr_one/bootstrap`, {
    method: 'POST',
    headers: { [BOOTSTRAP_HEADER]: encodeHex(challenge) },
    timeoutMs: 5000,
  });
  if (response.status !== 204) {
    throw new Error(`embedded bootstrap returned unexpected status ${response.status}`);
  }
  const sid = sessionIdFromSetCookie(response.headers['set-cookie']);
  if (!sid) throw new Error('embedded bootstrap omitted its session cookie');
  return sid;
}

function capturePipe(stream, bucket) {
  if (!stream) return;
  stream.on('data', (chunk) => {
    bucket.push(chunk.toString('utf8'));
    if (bucket.join('').length > 64 * 1024) bucket.splice(0, bucket.length - 8);
  });
}

export function runtimeInfo() {
  const running = !!(state.child && state.child.exitCode == null);
  return {
    running,
    baseUrl: state.baseUrl,
    port: state.port,
    dataDir: state.dataDir,
    mode: running ? 'local-node' : 'stopped',
    nodePath: state.nodePath,
  };
}

export async function ensureStarted({
  userDataDir,
  resourceDir,
  appPath,
  isPackaged,
  appVersion,
  shellSecret,
  shellInstance,
}) {
  if (state.child && state.child.exitCode == null && state.sessionReady) {
    return runtimeInfo();
  }
  if (state.child) await stopRuntime();

  const dataDir = path.join(userDataDir, 'zephyr-data');
  fs.mkdirSync(dataDir, { recursive: true });
  state.autostartLog = path.join(dataDir, 'zephyr-autostart.log');
  appendLog('runtime_start command entered');

  const core = resolveCoreDir({ resourceDir, appPath, isPackaged });
  const node = nodeCompatiblePath(resolveNodeBin({ resourceDir, appPath, isPackaged }));
  const port = await pickPort();
  const publicOrigin = `http://127.0.0.1:${port}`;
  const challenge = generateChallenge();

  const env = {
    ...process.env,
    ZEPHYR_DATA_DIR: dataDir,
    HTTP_ENABLED: 'true',
    HTTPS_ENABLED: 'false',
    PORT: String(port),
    PUBLIC_ORIGIN: publicOrigin,
    TRUST_PROXY: 'false',
    ZEPHYR_ONE_EMBEDDED: '1',
    ZEPHYR_BACKUP_WINDOWS_ACL_TIMEOUT_MS: '90000',
    ZEPHYR_BACKUP_ALLOW_TOKEN_DEFAULT_OWNER: '1',
    [STARTUP_CHALLENGE_ENV]: encodeHex(challenge),
    ZEPHYR_ONE_SHELL_SECRET: shellSecret,
    ZEPHYR_ONE_SHELL_INSTANCE: shellInstance,
    ZEPHYR_VERSION: appVersion || '0.1.0',
    ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;

  const spawnOpts = {
    cwd: core,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
  if (process.platform === 'win32') {
    spawnOpts.windowsVerbatimArguments = false;
  }

  const child = spawn(node, [path.join(core, 'server.js')], spawnOpts);
  const logs = [];
  capturePipe(child.stdout, logs);
  capturePipe(child.stderr, logs);
  try { fs.unlinkSync(path.join(dataDir, UI_READY_MARKER)); } catch { /* absent */ }

  try {
    await waitHttpReady(child, `${publicOrigin}/healthz`, port, challenge, EMBEDDED_CORE_READY_TIMEOUT_MS);
    const sid = await exchangeBootstrap(publicOrigin, challenge);
    challenge.fill(0);
    state.child = child;
    state.port = port;
    state.baseUrl = publicOrigin;
    state.startupChallenge = null;
    state.sessionReady = true;
    state.sessionId = sid;
    state.localAppOrigin = publicOrigin;
    state.dataDir = dataDir;
    state.nodePath = node;
    appendLog(`runtime ready port=${port} node=${node}`);
    return runtimeInfo();
  } catch (error) {
    try { child.kill(); } catch { /* already gone */ }
    challenge.fill(0);
    const details = logs.join('').trim();
    throw new Error(details ? `${error.message}\n\n运行日志：\n${details}` : error.message);
  }
}

export async function stopRuntime() {
  const child = state.child;
  state.child = null;
  state.sessionReady = false;
  state.sessionId = '';
  state.localAppOrigin = '';
  state.port = 0;
  state.baseUrl = '';
  state.nodePath = '';
  if (!child) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill(); } catch { resolve(); }
  });
}

export function localAppUrl() {
  if (!state.baseUrl) throw new Error('embedded product is not ready for trusted entry');
  return `${state.baseUrl.replace(/\/+$/, '')}${LOCAL_APP_PATH}`;
}

export function sessionCookie() {
  if (!state.sessionId) throw new Error('embedded product session is missing');
  return {
    url: state.baseUrl,
    name: 'zephyr_sid',
    value: state.sessionId,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
  };
}

export function writeUiReadyMarker({ nonce, corePid, url, instanceId }) {
  if (!state.dataDir) return;
  const configured = process.env.ZEPHYR_ONE_UI_READY_MARKER;
  if (!configured && !nonce) return;
  const marker = path.join(state.dataDir, UI_READY_MARKER);
  if (configured && path.resolve(configured) !== path.resolve(marker)) {
    throw new Error('UI-ready marker path is not the current private runtime directory');
  }
  if (!/^[a-f0-9]{64}$/.test(String(nonce || ''))) {
    throw new Error('UI-ready launch nonce is invalid');
  }
  const payload = {
    schemaVersion: 1,
    nonce,
    product: 'zephyr-one',
    windowLabel: 'local-app',
    topLevel: true,
    authenticated: true,
    appReady: true,
    readyState: 'complete',
    port: state.port,
    instanceId: String(instanceId || ''),
    corePid,
    url,
    createdAtMs: Date.now(),
  };
  const temporary = `${marker}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload));
  fs.renameSync(temporary, marker);
}

export function currentSessionId() {
  return state.sessionId;
}

export function currentBaseUrl() {
  return state.baseUrl;
}

export function currentCorePid() {
  return state.child && state.child.pid ? state.child.pid : 0;
}

export function hereDir(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}
