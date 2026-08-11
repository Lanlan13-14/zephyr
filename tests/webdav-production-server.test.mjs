import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const require = createRequire(import.meta.url);
const { createDatabase } = require('../sqlite-driver');
const { ownerHash } = require('../webdav-sensitive-attempt-store');

const ROOT = path.resolve(import.meta.dirname, '..');

function strongKey() {
  return crypto.randomBytes(32).toString('base64url');
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function rawJsonRequest(base, route, body, { contentLength = true } = {}) {
  const url = new URL(base);
  const payload = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      method: 'PATCH',
      path: route,
      headers: {
        'content-type': 'application/json',
        ...(contentLength ? { 'content-length': String(payload.length) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, text, body: parsed });
      });
    });
    request.once('error', reject);
    if (contentLength) request.end(payload);
    else {
      const split = Math.floor(payload.length / 2);
      request.write(payload.subarray(0, split));
      request.end(payload.subarray(split));
    }
  });
}

async function startServer({ configured = true } = {}) {
  const dataFixture = createSecureTestDataDir('zephyr-webdav-server-');
  const dir = dataFixture.dataDir;
  const port = await freePort();
  const aiHostPort = await freePort();
  const env = {
    ...process.env,
    HTTP_ENABLED: 'true',
    HTTPS_ENABLED: 'false',
    PORT: String(port),
    ZEPHYR_BIND_HOST: '127.0.0.1',
    ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${aiHostPort}`,
    ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${aiHostPort}`,
    ZEPHYR_DATA_DIR: dir,
    ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(dir, 'crypto', 'key.json'),
    ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
    ZEPHYR_TRUST_PROXY: 'true',
    ENCRYPTION_KEY: 'webdav-production-server-test',
    NODE_ENV: 'test',
  };
  delete env.WEBDAV_BACKUP_KEY;
  delete env.WEBDAV_CREDENTIAL_KEY;
  if (configured) {
    env.WEBDAV_BACKUP_KEY = strongKey();
    env.WEBDAV_CREDENTIAL_KEY = strongKey();
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output.slice(-3000)}`);
    try {
      const health = await fetch(`${base}/healthz`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (Date.now() >= deadline) throw new Error(`server startup timeout:\n${output.slice(-3000)}`);

  async function stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    removeSecureTestDataDir(dataFixture);
  }

  async function api(cookie, method, route, body, { forwardedFor = '' } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, body: parsed, text };
  }

  async function login(username, password) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200, `login failed: ${await response.text()}`);
    return (response.headers.get('set-cookie') || '').split(';')[0];
  }

  async function bootstrapAdmin() {
    const cookie = await login('admin', 'admin');
    const changed = await api(cookie, 'POST', '/api/auth/change-password', {
      currentPassword: 'admin',
      newPassword: 'admin-webdav-pass-1',
    });
    assert.equal(changed.status, 200);
    return cookie;
  }

  return { api, base, bootstrapAdmin, child, dir, login, output: () => output, stop };
}

test('real server mounts user-scoped WebDAV routes and deletion prevents same-name inheritance', async () => {
  const server = await startServer({ configured: true });
  try {
    const unauthenticated = await server.api('', 'GET', '/api/webdav-sync/config');
    assert.equal(unauthenticated.status, 401);

    const adminCookie = await server.bootstrapAdmin();
    const created = await server.api(adminCookie, 'POST', '/api/admin/users', {
      username: 'webdav-alice',
      password: 'alice-webdav-pass-1',
      role: 'user',
      mustChangePassword: false,
    });
    assert.equal(created.status, 200);
    const originalUserId = created.body.user.userId;
    const aliceCookie = await server.login('webdav-alice', 'alice-webdav-pass-1');

    const denied = await server.api(aliceCookie, 'PATCH', '/api/webdav-sync/config', {
      baseUrl: 'https://dav.example.test/root',
      username: 'alice-dav',
      password: 'remote-dav-password',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'sensitive_verification_failed');

    const patched = await server.api(aliceCookie, 'PATCH', '/api/webdav-sync/config', {
      baseUrl: 'https://dav.example.test/root',
      remotePath: 'zephyr',
      username: 'alice-dav',
      password: 'remote-dav-password',
      enabled: true,
      secret: 'alice-webdav-pass-1',
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.config.configured, true);
    assert.equal(patched.body.config.hasPassword, true);
    assert.equal(patched.text.includes('remote-dav-password'), false);
    assert.equal(Object.hasOwn(patched.body.config, 'password'), false);

    const deleteCookie = await server.login('webdav-alice', 'alice-webdav-pass-1');
    const deniedDelete = await server.api(deleteCookie, 'DELETE', '/api/webdav-sync/config', {});
    assert.equal(deniedDelete.status, 403);
    assert.equal(deniedDelete.body.error.code, 'sensitive_verification_failed');
    const deleted = await server.api(deleteCookie, 'DELETE', '/api/webdav-sync/config', {
      secret: 'alice-webdav-pass-1',
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.deepEqual(deleted.body, { ok: true, deleted: true });
    assert.equal(deleted.text.includes('remote-dav-password'), false);
    const afterDelete = await server.api(deleteCookie, 'GET', '/api/webdav-sync/config');
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.body.config.configured, false);
    const reconfigured = await server.api(deleteCookie, 'PATCH', '/api/webdav-sync/config', {
      baseUrl: 'https://dav.example.test/root',
      remotePath: 'zephyr',
      username: 'alice-dav',
      password: 'remote-dav-password',
      enabled: true,
      secret: 'alice-webdav-pass-1',
    });
    assert.equal(reconfigured.status, 200, reconfigured.text);
    assert.equal(reconfigured.body.config.configured, true);

    const removed = await server.api(adminCookie, 'DELETE', `/api/admin/users/${originalUserId}`, {
      resourcePolicy: 'delete-resources',
    });
    assert.equal(removed.status, 200, removed.text);
    const inspectionDb = createDatabase(path.join(server.dir, 'zephyr.db'), { forceBuiltin: true });
    try {
      assert.equal(inspectionDb.prepare(`
        SELECT COUNT(*) AS count FROM webdav_sensitive_attempt_buckets WHERE owner_hash = ?
      `).get(ownerHash(originalUserId)).count, 0, 'account deletion must clear old account/session budgets');
    } finally {
      inspectionDb.close();
    }

    const recreated = await server.api(adminCookie, 'POST', '/api/admin/users', {
      username: 'webdav-alice',
      password: 'alice-new-pass-2',
      role: 'user',
      mustChangePassword: false,
    });
    assert.equal(recreated.status, 200, recreated.text);
    assert.notEqual(recreated.body.user.userId, originalUserId, 'same-name recreation must receive a fresh identity');
    const recreatedCookie = await server.login('webdav-alice', 'alice-new-pass-2');
    const config = await server.api(recreatedCookie, 'GET', '/api/webdav-sync/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.config.configured, false);
    assert.equal(config.body.config.hasPassword, false);
    assert.equal(config.text.includes('dav.example.test'), false);
    const deniedTest = await server.api(recreatedCookie, 'POST', '/api/webdav-sync/test', {}, {
      forwardedFor: '127.0.0.2',
    });
    assert.equal(deniedTest.status, 403, deniedTest.text);
    const deniedSync = await server.api(recreatedCookie, 'POST', '/api/webdav-sync/sync-now', {}, {
      forwardedFor: '127.0.0.2',
    });
    assert.equal(deniedSync.status, 403, deniedSync.text);
  } finally {
    await server.stop();
  }
});

test('missing dedicated keys leave the real server healthy while WebDAV fails closed', async () => {
  const server = await startServer({ configured: false });
  try {
    const health = await fetch(`${server.base}/healthz`);
    assert.equal(health.status, 200);
    const adminCookie = await server.bootstrapAdmin();
    const config = await server.api(adminCookie, 'GET', '/api/webdav-sync/config');
    assert.equal(config.status, 503);
    assert.equal(config.body.error.code, 'webdav_unavailable');
    assert.equal(server.output().includes('webdav_keys_unavailable'), true);
  } finally {
    await server.stop();
  }
});

test('WebDAV JSON guard rejects large declared and chunked bodies before authentication', async () => {
  const server = await startServer({ configured: false });
  const secret = 'webdav-body-secret-must-not-echo';
  const oversized = JSON.stringify({ secret, padding: 'x'.repeat(16 * 1024) });
  try {
    const getWithoutBody = await server.api('', 'GET', '/api/webdav-sync/config');
    assert.equal(getWithoutBody.status, 401, 'bodyless GET must still reach WebDAV authentication');

    const declared = await rawJsonRequest(server.base, '/api/webdav-sync/config', oversized);
    assert.equal(declared.status, 413);
    assert.equal(declared.body?.error?.code, 'webdav_request_too_large');
    assert.equal(declared.text.includes(secret), false);

    const chunked = await rawJsonRequest(server.base, '/api/webdav-sync/config', oversized, { contentLength: false });
    assert.equal(chunked.status, 413);
    assert.equal(chunked.body?.error?.code, 'webdav_request_too_large');
    assert.equal(chunked.text.includes(secret), false);

    const malformed = await rawJsonRequest(server.base, '/api/webdav-sync/config', `{"secret":"${secret}"`);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body?.error?.code, 'webdav_request_invalid_json');
    assert.equal(malformed.text.includes(secret), false);
  } finally {
    await server.stop();
  }
});
