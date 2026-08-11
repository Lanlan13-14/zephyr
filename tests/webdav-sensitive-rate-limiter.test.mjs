import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { createDatabase } = require('../sqlite-driver');
const {
  createWebDavSensitiveAttemptStore,
  ensureWebDavSensitiveAttemptSchema,
  ownerHash,
} = require('../webdav-sensitive-attempt-store');
const {
  RATE_LIMIT_RESPONSE,
  createWebDavSensitiveRateLimiter,
  makeRateLimitKey,
} = require('../webdav-sensitive-rate-limiter');
const { createWebDavSyncRouter } = require('../webdav-sync-routes');

const ROOT = path.resolve(import.meta.dirname, '..');
const WINDOW_MS = 5 * 60 * 1000;

function openDatabase(filename) {
  const db = createDatabase(filename, { forceBuiltin: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  return db;
}

function createTempDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-webdav-rate-limit-'));
  const filename = path.join(directory, 'zephyr.db');
  const handles = new Set();
  const open = () => {
    const db = openDatabase(filename);
    handles.add(db);
    return db;
  };
  t.after(() => {
    for (const db of handles) {
      try { db.close(); } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { filename, open };
}

function requestShape({ userId = 'user-1', sessionId = 'session-1', clientIp = '127.0.0.1' } = {}) {
  return {
    user: userId ? { userId } : undefined,
    session: sessionId ? { sid: sessionId } : undefined,
    headers: { 'x-client-ip': clientIp },
    socket: { remoteAddress: clientIp },
  };
}

function invokeLimiter(limiter, identity) {
  let status = 200;
  let payload;
  let passed = false;
  const res = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  limiter(requestShape(identity), res, () => { passed = true; });
  return { passed, status, payload };
}

function limiterFor(database, options = {}) {
  return createWebDavSensitiveRateLimiter({
    database,
    getClientIp: (req) => req.headers['x-client-ip'] || '127.0.0.1',
    ...options,
  });
}

function makeService(calls) {
  return {
    async getConfig() { return {}; },
    async patchConfig(userId) { calls.push(['patch', userId]); return {}; },
    async testConnection(userId) { calls.push(['test', userId]); return {}; },
    async syncNow(userId) { calls.push(['sync', userId]); return {}; },
    async deleteConfigAndDrain(userId) { calls.push(['delete', userId]); return false; },
  };
}

async function withServer({ limiter, sensitiveVerification }, run) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/webdav-sync', createWebDavSyncRouter({
    service: makeService(calls),
    authentication: (req, res, next) => {
      if (req.headers['x-auth'] !== 'yes') return res.status(401).json({ ok: false });
      req.user = { userId: req.headers['x-user'] || 'user-1' };
      req.session = { sid: req.headers['x-session'] || 'session-1' };
      next();
    },
    sensitiveRateLimiter: limiter,
    sensitiveVerification,
    getUserId: (req) => req.user.userId,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      calls,
      request: (route, { headers = {}, body } = {}) => fetch(`${baseUrl}/api/webdav-sync${route}`, {
        method: 'POST',
        headers: { 'x-auth': 'yes', ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('authentication precedes durable rate limiting and the uniform denial never verifies or calls service', async (t) => {
  const temp = createTempDatabase(t);
  const db = temp.open();
  let verificationCalls = 0;
  let now = 1_000;
  const limiter = limiterFor(db, { now: () => now, maxAttempts: 2 });
  await withServer({
    limiter,
    sensitiveVerification: (_req, _res, next) => { verificationCalls += 1; next(); },
  }, async ({ calls, request }) => {
    assert.equal((await request('/test', { headers: { 'x-auth': 'no' } })).status, 401);
    assert.equal(verificationCalls, 0);
    assert.deepEqual(calls, []);
    assert.equal((await request('/test')).status, 200);
    assert.equal((await request('/test')).status, 200);
    const denied = await request('/test');
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), RATE_LIMIT_RESPONSE);
    assert.equal(verificationCalls, 2);
    assert.deepEqual(calls, [['test', 'user-1'], ['test', 'user-1']]);
    now += WINDOW_MS;
    assert.equal((await request('/test')).status, 200);
    assert.equal(limiter.entryCount({ timestamp: now }), 3);
  });
});

test('rotating IP or session cannot loosen account and session budgets', (t) => {
  const temp = createTempDatabase(t);
  const db = temp.open();
  const limiter = limiterFor(db, { maxAttempts: 1 });

  assert.equal(
    makeRateLimitKey({ userId: 'user-1', sessionId: 'session-1', clientIp: '192.0.2.1' }),
    makeRateLimitKey({ userId: 'user-1', sessionId: 'session-1', clientIp: '192.0.2.99' }),
  );

  assert.equal(invokeLimiter(limiter).passed, true);
  assert.deepEqual(invokeLimiter(limiter, { clientIp: '192.0.2.20' }), {
    passed: false,
    status: 429,
    payload: RATE_LIMIT_RESPONSE,
  });
  assert.equal(invokeLimiter(limiter, { sessionId: 'session-2', clientIp: '192.0.2.21' }).status, 429);
  assert.equal(invokeLimiter(limiter, { userId: 'user-2' }).status, 429, 'global IP budget must also constrain a fresh account');
  assert.equal(invokeLimiter(limiter, {
    userId: 'user-2',
    sessionId: 'session-2',
    clientIp: '192.0.2.22',
  }).passed, true);

  const rows = db.prepare(`
    SELECT bucket_type, attempt_count FROM webdav_sensitive_attempt_buckets
    ORDER BY bucket_type, bucket_hash
  `).all();
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.attempt_count === 1));
});

test('successful sensitive verification consumes attempts and never clears history', async (t) => {
  const temp = createTempDatabase(t);
  const limiter = limiterFor(temp.open(), { maxAttempts: 2 });
  let verificationCalls = 0;
  await withServer({
    limiter,
    sensitiveVerification: (req, res, next) => {
      verificationCalls += 1;
      if (req.headers['x-verification'] !== 'pass') return res.status(403).json({ ok: false });
      next();
    },
  }, async ({ calls, request }) => {
    assert.equal((await request('/test')).status, 403);
    assert.equal((await request('/test', { headers: { 'x-verification': 'pass' } })).status, 200);
    assert.equal((await request('/test', { headers: { 'x-verification': 'pass' } })).status, 429);
    assert.equal(verificationCalls, 2);
    assert.deepEqual(calls, [['test', 'user-1']]);
  });
});

test('two limiter instances share one database budget', (t) => {
  const temp = createTempDatabase(t);
  const firstDb = temp.open();
  const secondDb = temp.open();
  const first = limiterFor(firstDb, { maxAttempts: 2 });
  const second = limiterFor(secondDb, { maxAttempts: 2 });

  assert.equal(invokeLimiter(first).passed, true);
  assert.equal(invokeLimiter(second).passed, true);
  assert.equal(invokeLimiter(first).status, 429);
  assert.deepEqual(
    firstDb.prepare('SELECT bucket_type, attempt_count FROM webdav_sensitive_attempt_buckets ORDER BY bucket_type')
      .all().map((row) => ({ ...row })),
    [
      { bucket_type: 'account', attempt_count: 2 },
      { bucket_type: 'ip', attempt_count: 2 },
      { bucket_type: 'session', attempt_count: 2 },
    ],
  );
});

test('budget survives restart and a dynamic storage handle rebinds prepared statements', (t) => {
  const temp = createTempDatabase(t);
  let currentDb = temp.open();
  let now = 1_000;
  const longLived = createWebDavSensitiveRateLimiter({
    getDatabase: () => currentDb,
    getClientIp: (req) => req.headers['x-client-ip'],
    maxAttempts: 1,
    now: () => now,
  });
  assert.equal(invokeLimiter(longLived).passed, true);

  currentDb.close();
  currentDb = temp.open();
  const restarted = limiterFor(currentDb, { maxAttempts: 1, now: () => now });
  assert.equal(invokeLimiter(restarted).status, 429, 'restart must not reset persisted attempts');

  now += WINDOW_MS;
  assert.equal(invokeLimiter(longLived).passed, true, 'the old limiter must bind the reopened storage handle');
  assert.equal(longLived.entryCount({ timestamp: now }), 3);
});

test('concurrent database clients atomically consume the shared account budget', async (t) => {
  const temp = createTempDatabase(t);
  const bootstrap = temp.open();
  ensureWebDavSensitiveAttemptSchema(bootstrap);
  bootstrap.close();

  const workerSource = String.raw`
    const { parentPort, workerData } = require('node:worker_threads');
    const { createDatabase } = require(workerData.sqliteDriver);
    const { createWebDavSensitiveAttemptStore } = require(workerData.storeModule);
    const db = createDatabase(workerData.filename, { forceBuiltin: true });
    const store = createWebDavSensitiveAttemptStore({
      database: db,
      windowMs: workerData.windowMs,
      maxAttempts: workerData.maxAttempts,
      maxEntries: 1000,
      busyTimeoutMs: 10000,
    });
    parentPort.postMessage({ ready: true });
    parentPort.once('message', () => {
      try {
        parentPort.postMessage({ allowed: store.consume({
          userId: 'shared-account',
          sessionId: workerData.sessionId,
          clientIp: workerData.clientIp,
          timestamp: 1000,
        }) });
      } catch (error) {
        parentPort.postMessage({ error: String(error && (error.code || error.message) || error) });
      } finally {
        db.close();
        parentPort.close();
      }
    });
  `;
  const workers = Array.from({ length: 12 }, (_, index) => new Worker(workerSource, {
    eval: true,
    execArgv: [],
    workerData: {
      filename: temp.filename,
      sqliteDriver: path.join(ROOT, 'sqlite-driver.js'),
      storeModule: path.join(ROOT, 'webdav-sensitive-attempt-store.js'),
      windowMs: WINDOW_MS,
      maxAttempts: 4,
      sessionId: `session-${index}`,
      clientIp: `198.51.100.${index + 1}`,
    },
  }));
  t.after(() => workers.forEach((worker) => worker.terminate()));
  const exits = workers.map((worker) => once(worker, 'exit'));
  const ready = await Promise.all(workers.map((worker) => once(worker, 'message')));
  assert.ok(ready.every(([message]) => message.ready === true));
  const results = workers.map((worker) => once(worker, 'message'));
  workers.forEach((worker) => worker.postMessage('go'));
  const messages = (await Promise.all(results)).map(([message]) => message);
  assert.deepEqual(messages.filter((message) => message.error), []);
  assert.equal(messages.filter((message) => message.allowed).length, 4);
  await Promise.all(exits);

  const inspect = temp.open();
  assert.deepEqual(inspect.prepare(`
    SELECT bucket_type, COUNT(*) AS bucket_count, SUM(attempt_count) AS attempt_count
      FROM webdav_sensitive_attempt_buckets
     GROUP BY bucket_type ORDER BY bucket_type
  `).all().map((row) => ({ ...row })), [
    { bucket_type: 'account', bucket_count: 1, attempt_count: 4 },
    { bucket_type: 'ip', bucket_count: 4, attempt_count: 4 },
    { bucket_type: 'session', bucket_count: 4, attempt_count: 4 },
  ]);
});

test('global IP budget stops cross-account flooding without weakening account budgets', (t) => {
  const temp = createTempDatabase(t);
  const limiter = limiterFor(temp.open(), { maxAttempts: 2 });
  const commonIp = '203.0.113.40';
  assert.equal(invokeLimiter(limiter, { userId: 'user-1', sessionId: 'session-1', clientIp: commonIp }).passed, true);
  assert.equal(invokeLimiter(limiter, { userId: 'user-2', sessionId: 'session-2', clientIp: commonIp }).passed, true);
  assert.equal(invokeLimiter(limiter, { userId: 'user-3', sessionId: 'session-3', clientIp: commonIp }).status, 429);
  assert.equal(invokeLimiter(limiter, {
    userId: 'user-3',
    sessionId: 'session-3',
    clientIp: '203.0.113.41',
  }).passed, true, 'a denied multi-bucket transaction must not partially consume account/session state');
});

test('capacity and TTL cleanup are bounded and fail closed without partial rows', (t) => {
  const temp = createTempDatabase(t);
  let now = 1_000;
  const limiter = limiterFor(temp.open(), {
    now: () => now,
    maxAttempts: 2,
    maxEntries: 3,
    cleanupBatchSize: 1,
  });
  assert.equal(invokeLimiter(limiter).passed, true);
  assert.equal(limiter.entryCount({ timestamp: now }), 3);

  now += WINDOW_MS;
  const replacement = { userId: 'user-2', sessionId: 'session-2', clientIp: '192.0.2.2' };
  assert.equal(invokeLimiter(limiter, replacement).status, 429);
  assert.equal(invokeLimiter(limiter, replacement).status, 429);
  assert.equal(invokeLimiter(limiter, replacement).passed, true);
  assert.equal(limiter.entryCount({ timestamp: now }), 3);
});

test('SQLite lock contention and missing identity fail closed with the same response', (t) => {
  const temp = createTempDatabase(t);
  const lockDb = temp.open();
  const requestDb = temp.open();
  ensureWebDavSensitiveAttemptSchema(lockDb);
  const limiter = limiterFor(requestDb, { busyTimeoutMs: 25 });

  lockDb.exec('BEGIN IMMEDIATE');
  try {
    assert.deepEqual(invokeLimiter(limiter), { passed: false, status: 429, payload: RATE_LIMIT_RESPONSE });
  } finally {
    lockDb.exec('ROLLBACK');
  }
  assert.deepEqual(
    invokeLimiter(limiter, { userId: '', sessionId: '', clientIp: '' }),
    { passed: false, status: 429, payload: RATE_LIMIT_RESPONSE },
  );
});

test('account deletion clears only owned buckets and recreated identity starts isolated', (t) => {
  const temp = createTempDatabase(t);
  const db = temp.open();
  const limiter = limiterFor(db, { maxAttempts: 1 });
  const oldIdentity = { userId: 'old-user-id', sessionId: 'old-session', clientIp: '192.0.2.50' };
  assert.equal(invokeLimiter(limiter, oldIdentity).passed, true);
  assert.equal(invokeLimiter(limiter, { ...oldIdentity, clientIp: '192.0.2.51' }).status, 429);

  assert.equal(limiter.deleteUserState(oldIdentity.userId, { database: db }), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webdav_sensitive_attempt_buckets WHERE owner_hash = ?')
    .get(ownerHash(oldIdentity.userId)).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM webdav_sensitive_attempt_buckets WHERE bucket_type = 'ip'").get().count, 1);

  assert.equal(invokeLimiter(limiter, {
    userId: 'new-user-id',
    sessionId: oldIdentity.sessionId,
    clientIp: '192.0.2.60',
  }).passed, true, 'same-name recreation receives a fresh immutable user budget');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webdav_sensitive_attempt_buckets WHERE owner_hash = ?')
    .get(ownerHash('new-user-id')).count, 2);
});

test('attempt store rejects invalid limits instead of silently disabling protection', () => {
  assert.throws(() => createWebDavSensitiveAttemptStore({ database: {}, windowMs: 0, maxAttempts: 1, maxEntries: 3 }), /windowMs/);
  assert.throws(() => createWebDavSensitiveRateLimiter(), /database or getDatabase/);
});
