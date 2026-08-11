import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { WebDavSyncError } = require('../webdav-sync-service');
const { createWebDavSyncRouter } = require('../webdav-sync-routes');

const calls = [];
const service = {
  async getConfig(userId) {
    calls.push(['get', userId]);
    return { configured: true, baseUrl: 'https://dav.example.test/', username: 'alice', hasPassword: true };
  },
  async patchConfig(userId, body) {
    calls.push(['patch', userId, body]);
    if (body.failUnknown) throw new Error(`upstream included ${body.password}`);
    return { configured: true, baseUrl: body.baseUrl || '', username: body.username || '', hasPassword: !!body.password };
  },
  async testConnection(userId, body) {
    calls.push(['test', userId, body]);
    if (body.conflict) throw new WebDavSyncError(409, 'webdav_conflict');
    if (body.rateLimited) throw new WebDavSyncError(429, 'webdav_rate_limited', true);
    return { ok: true, reachable: true };
  },
  async syncNow(userId) {
    calls.push(['sync', userId]);
    return { ok: true, mode: 'backup', bytes: 3, etag: '"1"' };
  },
  async deleteConfigAndDrain(userId) {
    calls.push(['delete', userId]);
    return true;
  },
};

let server;
let baseUrl;
let authCalls = 0;
let sensitiveCalls = 0;

before(async () => {
  const app = express();
  app.use(express.json());
  const authentication = (req, res, next) => {
    authCalls += 1;
    if (req.headers['x-test-auth'] !== 'yes') return res.status(401).json({ ok: false });
    req.user = { userId: 'user-1' };
    return next();
  };
  const sensitiveVerification = (req, res, next) => {
    sensitiveCalls += 1;
    if (req.headers['x-test-sensitive'] !== 'yes') return res.status(403).json({ ok: false });
    return next();
  };
  const sensitiveRateLimiter = (_req, _res, next) => next();
  app.use('/api/webdav-sync', createWebDavSyncRouter({ service, authentication, sensitiveRateLimiter, sensitiveVerification }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function request(pathname, { method = 'GET', body, auth = true, sensitive = false } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(auth ? { 'x-test-auth': 'yes' } : {}),
      ...(sensitive ? { 'x-test-sensitive': 'yes' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function startAbortTestServer(service) {
  const app = express();
  app.use(express.json());
  app.use('/api/webdav-sync', createWebDavSyncRouter({
    service,
    authentication: (req, _res, next) => {
      req.user = { userId: 'user-1' };
      next();
    },
    sensitiveRateLimiter: (_req, _res, next) => next(),
    sensitiveVerification: (_req, _res, next) => next(),
  }));
  const abortServer = http.createServer(app);
  await new Promise((resolve) => abortServer.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${abortServer.address().port}`,
    close: () => new Promise((resolve) => abortServer.close(resolve)),
  };
}

function disconnectRequest(base, pathname, { method, body } = {}) {
  const target = new URL(`${base}${pathname}`);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const client = http.request(target, {
    method,
    headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
  });
  client.on('error', () => {});
  client.end(payload);
  return client;
}

test('router construction requires authentication, rate limiting, and sensitive verification middleware', () => {
  assert.throws(() => createWebDavSyncRouter({ service }), /authentication middleware/);
  assert.throws(
    () => createWebDavSyncRouter({ service, authentication: (_req, _res, next) => next() }),
    /sensitive rate limiter middleware/,
  );
  assert.throws(
    () => createWebDavSyncRouter({
      service,
      authentication: (_req, _res, next) => next(),
      sensitiveRateLimiter: (_req, _res, next) => next(),
    }),
    /sensitive verification middleware/,
  );
});

test('every route is authenticated and mutating/active operations require sensitive verification', async () => {
  const anonymous = await request('/api/webdav-sync/config', { auth: false });
  assert.equal(anonymous.status, 401);

  const deniedPatch = await request('/api/webdav-sync/config', {
    method: 'PATCH',
    body: { baseUrl: 'https://dav.example.test/' },
  });
  assert.equal(deniedPatch.status, 403);

  const deniedTest = await request('/api/webdav-sync/test', { method: 'POST', body: {} });
  assert.equal(deniedTest.status, 403);
  const deniedSync = await request('/api/webdav-sync/sync-now', { method: 'POST' });
  assert.equal(deniedSync.status, 403);
  const deniedDelete = await request('/api/webdav-sync/config', { method: 'DELETE' });
  assert.equal(deniedDelete.status, 403);
  assert.ok(authCalls >= 5);
  assert.ok(sensitiveCalls >= 4);
});

test('GET and PATCH config never return the password', async () => {
  const get = await request('/api/webdav-sync/config');
  const getBody = await get.json();
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(getBody.config.hasPassword, true);
  assert.equal(Object.hasOwn(getBody.config, 'password'), false);

  const password = 'route-secret-password';
  const patch = await request('/api/webdav-sync/config', {
    method: 'PATCH',
    sensitive: true,
    body: { baseUrl: 'https://dav.example.test/', username: 'alice', password },
  });
  const patchText = await patch.text();
  assert.equal(patch.status, 200);
  assert.equal(patchText.includes(password), false);
  const parsed = JSON.parse(patchText);
  assert.equal(parsed.config.hasPassword, true);
  assert.equal(Object.hasOwn(parsed.config, 'password'), false);
});

test('sensitive secret is consumed by middleware and never reaches config or test services', async () => {
  const verificationSecret = 'account-step-up-secret';
  const patch = await request('/api/webdav-sync/config', {
    method: 'PATCH',
    sensitive: true,
    body: { baseUrl: 'https://dav.example.test/', secret: verificationSecret },
  });
  assert.equal(patch.status, 200);
  const patchCall = calls.findLast(([kind]) => kind === 'patch');
  assert.equal(Object.hasOwn(patchCall[2], 'secret'), false);

  const tested = await request('/api/webdav-sync/test', {
    method: 'POST',
    sensitive: true,
    body: { baseUrl: 'https://dav.example.test/', secret: verificationSecret },
  });
  assert.equal(tested.status, 200);
  const testCall = calls.findLast(([kind]) => kind === 'test');
  assert.equal(Object.hasOwn(testCall[2], 'secret'), false);
});

test('test and sync-now expose injectable service results', async () => {
  const tested = await request('/api/webdav-sync/test', {
    method: 'POST',
    sensitive: true,
    body: { baseUrl: 'https://dav.example.test/' },
  });
  assert.equal(tested.status, 200);
  assert.equal((await tested.json()).result.reachable, true);

  const synced = await request('/api/webdav-sync/sync-now', { method: 'POST', sensitive: true });
  const body = await synced.json();
  assert.equal(synced.status, 200);
  assert.equal(body.result.mode, 'backup');
  assert.equal(calls.some(([kind, userId]) => kind === 'sync' && userId === 'user-1'), true);
});

test('a normally finished response does not abort its request signal', async (t) => {
  let observedSignal;
  const normalService = {
    getConfig: async () => ({ configured: false }),
    patchConfig: async (_userId, _body, { signal }) => {
      observedSignal = signal;
      assert.equal(signal.aborted, false);
      return { configured: true };
    },
    deleteConfigAndDrain: async () => false,
    testConnection: async () => ({ reachable: true }),
    syncNow: async () => ({ mode: 'backup' }),
  };
  const normalServer = await startAbortTestServer(normalService);
  t.after(normalServer.close);
  const response = await fetch(`${normalServer.baseUrl}/api/webdav-sync/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://dav.example.test/' }),
  });
  assert.equal(response.status, 200);
  await response.text();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedSignal.aborted, false);
});

test('DELETE config is a sensitive, idempotent lifecycle operation with a minimal response', async () => {
  const secret = 'delete-step-up-secret';
  const denied = await request('/api/webdav-sync/config', { method: 'DELETE' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.text()).includes(secret), false);

  const removed = await request('/api/webdav-sync/config', {
    method: 'DELETE',
    sensitive: true,
    body: { secret },
  });
  const text = await removed.text();
  assert.equal(removed.status, 200);
  assert.equal(text.includes(secret), false);
  assert.deepEqual(JSON.parse(text), { ok: true, deleted: true });
  assert.equal(calls.some(([kind, userId]) => kind === 'delete' && userId === 'user-1'), true);
});

test('route errors are fixed, sanitized payloads', async () => {
  const password = 'must-not-leak';
  const unknown = await request('/api/webdav-sync/config', {
    method: 'PATCH',
    sensitive: true,
    body: { failUnknown: true, password },
  });
  const unknownText = await unknown.text();
  assert.equal(unknown.status, 500);
  assert.equal(unknownText.includes(password), false);
  assert.equal(JSON.parse(unknownText).error.code, 'webdav_backup_failed');

  const conflict = await request('/api/webdav-sync/test', {
    method: 'POST',
    sensitive: true,
    body: { conflict: true },
  });
  const conflictBody = await conflict.json();
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.error.code, 'webdav_conflict');
  assert.equal(conflictBody.error.retryable, false);

  const rateLimited = await request('/api/webdav-sync/test', {
    method: 'POST',
    sensitive: true,
    body: { rateLimited: true },
  });
  const rateBody = await rateLimited.json();
  assert.equal(rateLimited.status, 429);
  assert.equal(rateBody.error.code, 'webdav_rate_limited');
  assert.equal(rateBody.error.retryable, true);
});

test('real client disconnects cancel pre-commit PATCH, preserve committed DELETE and publish an explicit sync outcome', async (t) => {
  let patchStarted;
  let patchAborted;
  let deleteStarted;
  let deleteAborted;
  let syncStarted;
  let syncAborted;
  const patchStartedPromise = new Promise((resolve) => { patchStarted = resolve; });
  const patchAbortedPromise = new Promise((resolve) => { patchAborted = resolve; });
  const deleteStartedPromise = new Promise((resolve) => { deleteStarted = resolve; });
  const deleteAbortedPromise = new Promise((resolve) => { deleteAborted = resolve; });
  const syncStartedPromise = new Promise((resolve) => { syncStarted = resolve; });
  const syncAbortedPromise = new Promise((resolve) => { syncAborted = resolve; });
  let savedConfigs = 0;
  let deletedConfigs = 0;
  let remotePublishes = 0;
  const service = {
    getConfig: async () => ({ configured: false }),
    async patchConfig(_userId, _body, { signal }) {
      patchStarted();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      patchAborted();
      if (signal.aborted) throw signal.reason;
      savedConfigs += 1;
      return { configured: true };
    },
    async deleteConfigAndDrain(_userId, { signal }) {
      deletedConfigs += 1; // Credential deletion is committed before draining stale sync work.
      deleteStarted();
      signal.addEventListener('abort', deleteAborted, { once: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    },
    async testConnection() { return { ok: true }; },
    async syncNow(_userId, { signal }) {
      remotePublishes += 1; // The remote publish completed before the response connection dropped.
      syncStarted();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      syncAborted();
      throw new WebDavSyncError(503, 'webdav_sync_unknown');
    },
  };
  const abortServer = await startAbortTestServer(service);
  t.after(abortServer.close);

  const patch = disconnectRequest(abortServer.baseUrl, '/api/webdav-sync/config', {
    method: 'PATCH', body: { baseUrl: 'https://dav.example.test/' },
  });
  await patchStartedPromise;
  patch.destroy();
  await patchAbortedPromise;
  assert.equal(savedConfigs, 0, 'an aborted PATCH must not persist credentials or config');

  const deleted = disconnectRequest(abortServer.baseUrl, '/api/webdav-sync/config', { method: 'DELETE' });
  await deleteStartedPromise;
  deleted.destroy();
  await deleteAbortedPromise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(deletedConfigs, 1, 'a completed credential deletion is never rolled back after disconnect');

  const sync = disconnectRequest(abortServer.baseUrl, '/api/webdav-sync/sync-now', { method: 'POST' });
  await syncStartedPromise;
  sync.destroy();
  await syncAbortedPromise;
  assert.equal(remotePublishes, 1, 'a disconnected response must not undo a published backup');
});
