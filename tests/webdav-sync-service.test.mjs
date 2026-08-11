import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDatabase } = require('../sqlite-driver');
const {
  BACKUP_FILE,
  WebDavSyncError,
  WebDavSyncService,
  canonicalPath,
  publicWebDavError,
  userNamespace,
  validateAddress,
  validateBaseUrl,
} = require('../webdav-sync-service');

const openServers = new Set();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => server.close(resolve))));
  openServers.clear();
});

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 80 * 1024 * 1024) reject(new Error('test request too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class MockDav {
  constructor() {
    this.collections = new Set(['/dav/']);
    this.files = new Map();
    this.calls = [];
    this.counter = 0;
    this.failNext = new Map();
    this.delayNext = new Map();
    this.afterCommitDelayNext = new Map();
    this.xxeNext = false;
    this.largeNext = 0;
    this.omitMoveEtag = false;
    this.replaceAfterMove = null;
    this.abortedResponses = 0;
    this.username = 'dav-user';
    this.password = 'dav-password';
    this.server = http.createServer((req, res) => this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    openServers.add(this.server);
    const { port } = this.server.address();
    this.baseUrl = `http://127.0.0.1:${port}/dav/`;
    return this;
  }

  nextEtag() {
    this.counter += 1;
    return `"mock-${this.counter}"`;
  }

  parent(pathname) {
    const trimmed = pathname.replace(/\/$/, '');
    const index = trimmed.lastIndexOf('/');
    return `${trimmed.slice(0, index + 1)}`;
  }

  backupPath(userId, remotePath = 'backups') {
    return `/dav/${remotePath}/${userNamespace(userId)}/${BACKUP_FILE}`;
  }

  mutate(pathname, body) {
    this.files.set(pathname, { body: Buffer.from(body), etag: this.nextEtag(), contentType: 'application/octet-stream' });
  }

  async handle(req, res) {
    res.on('close', () => {
      if (!res.writableEnded) this.abortedResponses += 1;
    });
    const url = new URL(req.url, this.baseUrl);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();
    const body = await readRequest(req);
    this.calls.push({ method, pathname, headers: { ...req.headers }, body });

    const expectedAuth = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401);
      res.end('credentials rejected');
      return;
    }

    const failure = this.failNext.get(method);
    if (failure) {
      this.failNext.delete(method);
      res.writeHead(failure);
      res.end('temporary upstream detail must stay private');
      return;
    }
    const delay = this.delayNext.get(method);
    if (delay) {
      this.delayNext.delete(method);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (res.destroyed) return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        DAV: '1, 2',
        Allow: 'OPTIONS, PROPFIND, MKCOL, GET, PUT, MOVE, DELETE',
      });
      res.end();
      return;
    }

    if (method === 'PROPFIND') {
      if (this.xxeNext) {
        this.xxeNext = false;
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY leak SYSTEM "file:///secret">]><x>&leak;</x>');
        return;
      }
      if (this.largeNext) {
        const size = this.largeNext;
        this.largeNext = 0;
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end('x'.repeat(size));
        return;
      }
      const file = this.files.get(pathname);
      const exists = !!file || this.collections.has(pathname.endsWith('/') ? pathname : `${pathname}/`);
      if (!exists) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers['if-match'] && (!file || req.headers['if-match'] !== file.etag)) {
        res.writeHead(412);
        res.end();
        return;
      }
      const etag = file?.etag || '';
      res.writeHead(207, { 'Content-Type': 'application/xml', ...(etag ? { ETag: etag } : {}) });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop></d:propstat></d:response></d:multistatus>`);
      return;
    }

    if (method === 'MKCOL') {
      const collection = pathname.endsWith('/') ? pathname : `${pathname}/`;
      if (this.collections.has(collection)) {
        res.writeHead(405);
      } else if (!this.collections.has(this.parent(collection))) {
        res.writeHead(409);
      } else {
        this.collections.add(collection);
        res.writeHead(201);
      }
      res.end();
      return;
    }

    if (method === 'PUT') {
      if (!this.collections.has(this.parent(pathname))) {
        res.writeHead(409);
        res.end();
        return;
      }
      const current = this.files.get(pathname);
      if (req.headers['if-none-match'] === '*' && current) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (req.headers['if-match'] && req.headers['if-match'] !== current?.etag) {
        res.writeHead(412);
        res.end();
        return;
      }
      const etag = this.nextEtag();
      this.files.set(pathname, { body, etag, contentType: req.headers['content-type'] });
      res.writeHead(current ? 204 : 201, { ETag: etag });
      res.end();
      return;
    }

    if (method === 'MOVE') {
      const source = this.files.get(pathname);
      let destination;
      try { destination = new URL(req.headers.destination).pathname; } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const current = this.files.get(destination);
      if (!source) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers['if-match'] && req.headers['if-match'] !== source.etag) {
        res.writeHead(412);
        res.end();
        return;
      }
      const destinationCondition = String(req.headers.if || '').match(/\(\[([^\]]+)\]\)/)?.[1];
      if (destinationCondition && destinationCondition !== current?.etag) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (String(req.headers.overwrite).toUpperCase() !== 'T' && current) {
        res.writeHead(412);
        res.end();
        return;
      }
      const etag = this.nextEtag();
      this.files.set(destination, { ...source, etag });
      this.files.delete(pathname);
      if (this.replaceAfterMove !== null) {
        const replacement = this.replaceAfterMove;
        this.replaceAfterMove = null;
        this.mutate(destination, replacement);
      }
      const afterCommitDelay = this.afterCommitDelayNext.get(method);
      if (afterCommitDelay) {
        this.afterCommitDelayNext.delete(method);
        await new Promise((resolve) => setTimeout(resolve, afterCommitDelay));
        if (res.destroyed) return;
      }
      res.writeHead(current ? 204 : 201, this.omitMoveEtag ? {} : { ETag: etag });
      res.end();
      return;
    }

    if (method === 'GET') {
      const file = this.files.get(pathname);
      if (!file) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { ETag: file.etag, 'Content-Type': file.contentType });
        res.end(file.body);
      }
      return;
    }

    if (method === 'DELETE') {
      const file = this.files.get(pathname);
      if (!file) {
        res.writeHead(404);
      } else if (req.headers['if-match'] && req.headers['if-match'] !== file.etag) {
        res.writeHead(412);
      } else {
        this.files.delete(pathname);
        res.writeHead(204);
      }
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  }
}

function memorySecretCrypto() {
  const values = new Map();
  return {
    encryptSecret(value, aad) {
      const ciphertext = `TEST_ENCRYPTED:${crypto.randomUUID()}`;
      values.set(`${aad}:${ciphertext}`, String(value));
      return ciphertext;
    },
    decryptSecret(ciphertext, aad) {
      const value = values.get(`${aad}:${ciphertext}`);
      if (value === undefined) throw new Error('bad test ciphertext');
      return value;
    },
  };
}

function makeService(mock, options = {}) {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  let backup = Buffer.from('backup-v1');
  const service = new WebDavSyncService({
    db,
    secretCrypto: memorySecretCrypto(),
    backupProvider: async () => ({ body: backup, contentType: 'application/x-zephyr-backup' }),
    allowHttpLoopback: true,
    allowLoopback: true,
    retryDelay: async () => {},
    ...options,
  });
  return { db, service, setBackup: (value) => { backup = Buffer.from(value); } };
}

function configure(service, mock, userId = 'alice') {
  return service.patchConfig(userId, {
    baseUrl: mock.baseUrl,
    remotePath: 'backups',
    username: mock.username,
    password: mock.password,
    enabled: true,
  });
}

test('strict URL, path, and address validation rejects traversal and unsafe targets', () => {
  assert.throws(() => validateBaseUrl('http://example.com/dav'), (error) => error.code === 'webdav_insecure_url');
  assert.throws(() => validateBaseUrl('https://user:pass@example.com/dav'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => validateBaseUrl('https://example.com/dav?token=secret'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => validateBaseUrl('https://example.com/a/%252e%252e/private'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => validateBaseUrl('https://example.com/a/%2525252525252e%2525252525252e/private'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => validateBaseUrl('https://example.com:0/dav'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => canonicalPath('safe/%252e%252e/private'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => canonicalPath('safe/%2fprivate'), (error) => error.code === 'webdav_invalid_config');
  assert.throws(() => validateAddress('10.0.0.1'), (error) => error.code === 'webdav_ssrf_blocked');
  assert.throws(() => validateAddress('169.254.169.254'), (error) => error.code === 'webdav_ssrf_blocked');
  assert.match(validateBaseUrl('http://127.0.0.1:8080/dav', { allowHttpLoopback: true }), /^http:/);
});

test('configuration encrypts credentials, never returns a password, and is isolated by user', async () => {
  const mock = await new MockDav().start();
  const { db, service } = makeService(mock);
  const alice = configure(service, mock, 'alice');
  configure(service, mock, 'bob');

  assert.equal(alice.hasPassword, true);
  assert.equal(alice.username, mock.username);
  assert.equal(Object.hasOwn(alice, 'password'), false);
  const rows = db.prepare('SELECT * FROM webdav_sync_configs ORDER BY user_id').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.username_enc, mock.username);
    assert.notEqual(row.password_enc, mock.password);
    assert.equal(JSON.stringify(row).includes(mock.password), false);
  }
  assert.notEqual(userNamespace('alice'), userNamespace('bob'));

  await service.syncNow('alice');
  await service.syncNow('bob');
  assert.ok(mock.files.has(mock.backupPath('alice')));
  assert.ok(mock.files.has(mock.backupPath('bob')));
  assert.equal([...mock.files.keys()].some((pathname) => pathname.includes('alice') || pathname.includes('bob')), false);
});

test('an already-aborted caller cannot save or delete WebDAV credentials before the local commit', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock);
  const saveController = new AbortController();
  saveController.abort(new WebDavSyncError(499, 'webdav_request_aborted', true));
  assert.throws(
    () => service.patchConfig('alice', {
      baseUrl: mock.baseUrl,
      username: mock.username,
      password: mock.password,
      enabled: true,
    }, { signal: saveController.signal }),
    (error) => error.code === 'webdav_request_aborted',
  );
  assert.equal(service.getConfig('alice').configured, false);

  configure(service, mock);
  const deleteController = new AbortController();
  deleteController.abort(new WebDavSyncError(499, 'webdav_request_aborted', true));
  await assert.rejects(
    service.deleteConfigAndDrain('alice', { signal: deleteController.signal }),
    (error) => error.code === 'webdav_request_aborted',
  );
  assert.equal(service.getConfig('alice').configured, true);
});

test('credentials are bound to canonical origin and never inherited across scheme, host, or port', async () => {
  const first = await new MockDav().start();
  const second = await new MockDav().start();
  const { db, service } = makeService(first);
  const initial = configure(service, first);
  assert.equal(initial.version, 1);

  await assert.rejects(
    service.testConnection('alice', { baseUrl: second.baseUrl, remotePath: 'backups' }),
    (error) => error.code === 'webdav_auth_failed',
  );
  const crossOriginCall = second.calls.find((call) => call.method === 'OPTIONS');
  assert.equal(crossOriginCall.headers.authorization, undefined);

  const sameOriginPath = service.patchConfig('alice', { baseUrl: `${first.baseUrl}nested/` });
  assert.equal(sameOriginPath.hasPassword, true);
  assert.equal(sameOriginPath.username, first.username);
  assert.equal(sameOriginPath.version, 2);

  const hostChanged = service.patchConfig('alice', {
    baseUrl: first.baseUrl.replace('127.0.0.1', 'localhost'),
  });
  assert.equal(hostChanged.hasPassword, false);
  assert.equal(hostChanged.username, '');
  assert.equal(hostChanged.version, 3);

  const rebound = service.patchConfig('alice', { username: first.username, password: first.password });
  assert.equal(rebound.hasPassword, true);
  const portChanged = service.patchConfig('alice', { baseUrl: second.baseUrl.replace('127.0.0.1', 'localhost') });
  assert.equal(portChanged.hasPassword, false);
  assert.equal(portChanged.username, '');

  service.patchConfig('alice', { username: first.username, password: first.password });
  const schemeChanged = service.patchConfig('alice', {
    baseUrl: second.baseUrl.replace('http://', 'https://'),
  });
  assert.equal(schemeChanged.hasPassword, false);
  assert.equal(schemeChanged.username, '');
  const row = db.prepare('SELECT * FROM webdav_sync_configs WHERE user_id=?').get('alice');
  assert.equal(row.password_enc, null);
  assert.equal(row.username_enc, null);
  assert.equal(row.credential_origin, new URL(schemeChanged.baseUrl).origin);
});

test('client implements required DAV primitives within the user namespace', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock);
  configure(service, mock);
  await service.syncNow('alice');

  assert.equal((await service.options('alice')).status, 204);
  assert.equal((await service.propfind('alice')).status, 207);
  assert.equal((await service.mkcol('alice', 'manual')).status, 201);
  const put = await service.put('alice', 'manual/source.bin', Buffer.from('hello'), { createOnly: true });
  assert.equal(put.status, 201);
  const move = await service.move('alice', 'manual/source.bin', 'manual/moved.bin', {
    sourceEtag: put.headers.etag,
  });
  assert.equal(move.status, 201);
  assert.deepEqual((await service.get('alice', 'manual/moved.bin')).body, Buffer.from('hello'));
  assert.equal((await service.delete('alice', 'manual/moved.bin', { etag: move.headers.etag })).status, 204);
  await assert.rejects(service.get('alice', '../outside'), (error) => error.code === 'webdav_invalid_config');
});

test('sync uploads a temporary object then MOVE commits it atomically', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock);
  configure(service, mock);

  const result = await service.syncNow('alice');
  assert.equal(result.mode, 'backup');
  assert.equal(result.bytes, Buffer.byteLength('backup-v1'));
  assert.match(result.etag, /^"mock-/);
  const finalPath = mock.backupPath('alice');
  assert.equal(mock.files.get(finalPath).body.toString(), 'backup-v1');

  const writes = mock.calls.filter((call) => call.method === 'PUT' || call.method === 'MOVE');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, 'PUT');
  assert.match(writes[0].pathname, /\.zephyr-upload-[0-9a-f-]+\.tmp$/);
  assert.equal(writes[0].headers['if-none-match'], '*');
  assert.equal(writes[1].method, 'MOVE');
  assert.equal(new URL(writes[1].headers.destination).pathname, finalPath);
  assert.equal(mock.calls.some((call) => call.method === 'PUT' && call.pathname === finalPath), false);
});

test('first sync refuses to replace a pre-existing remote backup', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock);
  configure(service, mock);
  const finalPath = mock.backupPath('alice');
  mock.mutate(finalPath, 'pre-existing-backup');

  await assert.rejects(service.syncNow('alice'), (error) => error.code === 'webdav_conflict');
  assert.equal(mock.files.get(finalPath).body.toString(), 'pre-existing-backup');
  const move = mock.calls.find((call) => call.method === 'MOVE');
  assert.equal(move.headers.overwrite, 'F');
  assert.equal([...mock.files.keys()].some((path) => path.endsWith('.tmp')), false);
  assert.equal(service.getConfig('alice').lastEtag, null);
});

test('MOVE without an ETag adopts only an ETag verified against the uploaded bytes', async () => {
  const mock = await new MockDav().start();
  mock.omitMoveEtag = true;
  const { service } = makeService(mock);
  configure(service, mock);

  const result = await service.syncNow('alice');
  assert.match(result.etag, /^"mock-/);
  const finalPath = mock.backupPath('alice');
  assert.equal(mock.calls.some((call) => call.method === 'GET' && call.pathname === finalPath), true);
  assert.equal(mock.files.get(finalPath).body.toString(), 'backup-v1');
});

test('MOVE read-back never adopts a concurrent writer ETag', async () => {
  const mock = await new MockDav().start();
  mock.omitMoveEtag = true;
  mock.replaceAfterMove = 'concurrent-writer';
  const { service } = makeService(mock);
  configure(service, mock);

  await assert.rejects(service.syncNow('alice'), (error) => error.code === 'webdav_conflict');
  const finalPath = mock.backupPath('alice');
  assert.equal(mock.files.get(finalPath).body.toString(), 'concurrent-writer');
  assert.equal(service.getConfig('alice').lastEtag, null);
  assert.equal(service.getConfig('alice').lastErrorCode, 'webdav_conflict');
});

test('ETag-less MOVE read-back remains bounded by the backup quota', async () => {
  const mock = await new MockDav().start();
  mock.omitMoveEtag = true;
  mock.replaceAfterMove = Buffer.alloc(2048, 0x78);
  const { service } = makeService(mock, { maxBackupBytes: 1024 });
  configure(service, mock);

  await assert.rejects(
    service.syncNow('alice'),
    (error) => error.code === 'webdav_response_too_large',
  );
  assert.equal(service.getConfig('alice').lastEtag, null);
  assert.equal(service.getConfig('alice').lastErrorCode, 'webdav_response_too_large');
});

test('ETag conflict is detected with If-Match and does not overwrite remote data', async () => {
  const mock = await new MockDav().start();
  const { service, setBackup } = makeService(mock);
  configure(service, mock);
  await service.syncNow('alice');
  const finalPath = mock.backupPath('alice');
  mock.mutate(finalPath, 'external-change');
  setBackup('backup-v2');

  await assert.rejects(service.syncNow('alice'), (error) => {
    assert.equal(error.code, 'webdav_conflict');
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(mock.files.get(finalPath).body.toString(), 'external-change');
  const conditional = mock.calls.findLast((call) => call.method === 'PROPFIND' && call.pathname === finalPath);
  assert.match(conditional.headers['if-match'], /^"mock-/);
  assert.equal(service.getConfig('alice').lastErrorCode, 'webdav_conflict');
});

test('changing the remote target clears stale ETag state', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock);
  configure(service, mock);
  await service.syncNow('alice');
  assert.ok(service.getConfig('alice').lastEtag);

  const updated = service.patchConfig('alice', { remotePath: 'new-backups' });
  assert.equal(updated.lastEtag, null);
  assert.equal(updated.lastSyncedAt, null);
  assert.equal(updated.lastErrorCode, null);
});

test('sync completion uses config-version CAS and cannot update replacement config status', async () => {
  const mock = await new MockDav().start();
  const { db, service } = makeService(mock);
  configure(service, mock);
  const originalMove = service.move.bind(service);
  service.move = async (...args) => {
    const response = await originalMove(...args);
    db.prepare(`UPDATE webdav_sync_configs
      SET remote_path='replacement',config_version=config_version+1,last_etag=NULL,last_synced_at=NULL,last_error_code=NULL
      WHERE user_id='alice'`).run();
    return response;
  };

  await assert.rejects(service.syncNow('alice'), (error) => error.code === 'webdav_config_changed');
  const current = service.getConfig('alice');
  assert.equal(current.remotePath, 'replacement');
  assert.equal(current.version, 2);
  assert.equal(current.lastEtag, null);
  assert.equal(current.lastSyncedAt, null);
  assert.equal(current.lastErrorCode, null);
});

test('patching config aborts an old sync before it can write the old target', async () => {
  const mock = await new MockDav().start();
  let entered;
  let releaseBackup;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const backupWait = new Promise((resolve) => { releaseBackup = resolve; });
  const { service } = makeService(mock, {
    backupProvider: async () => {
      entered();
      await backupWait;
      return Buffer.from('old-config-backup');
    },
  });
  configure(service, mock);
  const running = service.syncNow('alice');
  await enteredPromise;
  const replacement = service.patchConfig('alice', { remotePath: 'replacement' });
  releaseBackup();
  await assert.rejects(running, (error) => error.code === 'webdav_config_changed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacement.version, 2);
  assert.equal(service.getConfig('alice').lastErrorCode, null);
  assert.equal(mock.files.has(mock.backupPath('alice')), false);
});

test('config replacement during MOVE deletes the old-target temporary upload', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock, { maxRetries: 0, timeoutMs: 1_000 });
  configure(service, mock);
  mock.delayNext.set('MOVE', 250);
  const running = service.syncNow('alice');
  const deadline = Date.now() + 2_000;
  while (![...mock.files.keys()].some((pathname) => pathname.includes('.zephyr-upload-'))) {
    if (Date.now() >= deadline) assert.fail('temporary upload was not created');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  service.patchConfig('alice', { remotePath: 'replacement' });
  await assert.rejects(running, (error) => error.code === 'webdav_config_changed');
  await service.close();
  assert.equal([...mock.files.keys()].some((pathname) => pathname.includes('.zephyr-upload-')), false);
  assert.equal(mock.calls.some((call) => call.method === 'DELETE' && call.pathname.includes('.zephyr-upload-')), true);
});

test('close aborts new access immediately and drains the underlying active provider', async () => {
  const mock = await new MockDav().start();
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { service } = makeService(mock, {
    backupProvider: async () => {
      entered();
      await held;
      return Buffer.from('held-until-drained');
    },
  });
  configure(service, mock);
  const running = service.syncNow('alice').catch((error) => error);
  await started;
  let drained = false;
  const closing = service.close().then(() => { drained = true; });
  const stopped = await running;
  assert.equal(stopped.code, 'webdav_unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'close waits for the provider rather than only the public race');
  await assert.rejects(service.syncNow('alice'), (error) => error.code === 'webdav_unavailable');
  release();
  await closing;
  assert.equal(drained, true);
});

test('active-operation gate enforces per-user and global concurrency with 429', async () => {
  const mock = await new MockDav().start();
  let entered;
  let releaseBackup;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const backupWait = new Promise((resolve) => { releaseBackup = resolve; });
  const { service } = makeService(mock, {
    operationLimits: {
      maxConcurrentGlobal: 1,
      maxConcurrentPerUser: 1,
      maxOperationsGlobal: 100,
      maxOperationsPerUser: 100,
    },
    backupProvider: async () => {
      entered();
      await backupWait;
      return Buffer.from('held');
    },
  });
  configure(service, mock, 'alice');
  configure(service, mock, 'bob');
  const running = service.syncNow('alice');
  await enteredPromise;
  await assert.rejects(service.testConnection('alice'), (error) => error.status === 429 && error.code === 'webdav_rate_limited');
  await assert.rejects(service.testConnection('bob'), (error) => error.status === 429 && error.code === 'webdav_rate_limited');
  releaseBackup();
  await running;
});

test('active-operation gate enforces per-user and global rate windows', async () => {
  const mock = await new MockDav().start();
  const perUser = makeService(mock, {
    operationLimits: { maxOperationsPerUser: 1, maxOperationsGlobal: 100 },
  }).service;
  configure(perUser, mock, 'alice');
  await perUser.testConnection('alice');
  await assert.rejects(perUser.testConnection('alice'), (error) => error.status === 429 && error.code === 'webdav_rate_limited');

  const global = makeService(mock, {
    operationLimits: { maxOperationsPerUser: 100, maxOperationsGlobal: 1 },
  }).service;
  configure(global, mock, 'alice');
  configure(global, mock, 'bob');
  await global.testConnection('alice');
  await assert.rejects(global.testConnection('bob'), (error) => error.status === 429 && error.code === 'webdav_rate_limited');
});

test('operation deadline aborts the active HTTP response and frees the semaphore', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock, {
    timeoutMs: 1_000,
    operationDeadlineMs: 60,
    maxRetries: 0,
    operationLimits: { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1 },
  });
  configure(service, mock);
  mock.delayNext.set('OPTIONS', 250);
  await assert.rejects(service.testConnection('alice'), (error) => error.code === 'webdav_timeout');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(mock.abortedResponses >= 1);
  assert.equal((await service.testConnection('alice')).reachable, true);
});

test('caller cancellation before upload performs no remote write and frees the operation slot', async () => {
  const mock = await new MockDav().start();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { service } = makeService(mock, {
    operationLimits: { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1 },
    backupProvider: ({ signal }) => new Promise((resolve, reject) => {
      entered();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  configure(service, mock);
  const controller = new AbortController();
  const running = service.syncNow('alice', { signal: controller.signal });
  await started;
  controller.abort(new WebDavSyncError(499, 'webdav_request_aborted', true));
  await assert.rejects(running, (error) => error.code === 'webdav_request_aborted');
  assert.equal(mock.calls.some((call) => call.method === 'PUT' || call.method === 'MOVE'), false);
  assert.equal((await service.testConnection('alice')).reachable, true, 'the cancelled sync released its semaphore');
});

test('caller cancellation after remote publication records an explicit unknown state without rolling it back', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock, {
    maxRetries: 0,
    timeoutMs: 1_000,
    operationLimits: { maxConcurrentGlobal: 1, maxConcurrentPerUser: 1 },
  });
  configure(service, mock);
  mock.afterCommitDelayNext.set('MOVE', 160);
  const controller = new AbortController();
  const running = service.syncNow('alice', { signal: controller.signal });
  const backupPath = mock.backupPath('alice');
  const deadline = Date.now() + 2_000;
  while (!mock.files.has(backupPath)) {
    if (Date.now() >= deadline) assert.fail('MOVE did not publish the backup');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const published = Buffer.from(mock.files.get(backupPath).body);
  controller.abort(new WebDavSyncError(499, 'webdav_request_aborted', true));
  await assert.rejects(running, (error) => error.code === 'webdav_sync_unknown');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.deepEqual(mock.files.get(backupPath)?.body, published, 'disconnect cleanup must not remove a committed backup');
  assert.equal(service.getConfig('alice').lastErrorCode, 'webdav_sync_unknown');
  assert.equal((await service.testConnection('alice')).reachable, true, 'the uncertain sync released its semaphore');
});

test('deleteConfig removes credentials and prevents an in-flight sync from writing status', async () => {
  const mock = await new MockDav().start();
  let entered;
  let releaseBackup;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const backupWait = new Promise((resolve) => { releaseBackup = resolve; });
  const { db, service } = makeService(mock, {
    backupProvider: async () => {
      entered();
      await backupWait;
      return Buffer.from('deleted-user');
    },
  });
  configure(service, mock);
  const running = service.syncNow('alice');
  await enteredPromise;
  assert.equal(service.deleteConfig('alice'), true);
  assert.equal(service.deleteConfig('alice'), false);
  releaseBackup();
  await assert.rejects(running, (error) => error.code === 'webdav_config_changed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getConfig('alice').configured, false);
  assert.equal(service.getConfig('alice').version, 0);
  assert.equal(db.prepare('SELECT 1 FROM webdav_sync_configs WHERE user_id=?').get('alice'), undefined);

  const recreated = service.patchConfig('alice', {
    baseUrl: mock.baseUrl,
    remotePath: 'recreated',
    enabled: false,
  });
  assert.equal(recreated.username, '');
  assert.equal(recreated.hasPassword, false);
  assert.equal(recreated.version, 1);
  const recreatedRow = db.prepare('SELECT username_enc,password_enc FROM webdav_sync_configs WHERE user_id=?').get('alice');
  assert.equal(recreatedRow.username_enc, null);
  assert.equal(recreatedRow.password_enc, null);
});

test('deleteConfigAndDrain waits for an aborted sync to remove its captured temporary upload', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock, { maxRetries: 0, timeoutMs: 1_000 });
  configure(service, mock);
  mock.delayNext.set('MOVE', 250);
  const running = service.syncNow('alice');
  const stopped = running.catch((error) => error);
  const deadline = Date.now() + 2_000;
  while (![...mock.files.keys()].some((pathname) => pathname.includes('.zephyr-upload-'))) {
    if (Date.now() >= deadline) assert.fail('temporary upload was not created');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(await service.deleteConfigAndDrain('alice'), true);
  assert.equal((await stopped).code, 'webdav_config_changed');
  assert.equal(service.getConfig('alice').configured, false);
  assert.equal([...mock.files.keys()].some((pathname) => pathname.includes('.zephyr-upload-')), false);
  assert.equal(mock.calls.some((call) => call.method === 'DELETE' && call.pathname.includes('.zephyr-upload-')), true);
});

test('delete and same-user recreation cannot receive stale status from the old config epoch', async () => {
  const mock = await new MockDav().start();
  let entered;
  let releaseBackup;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const backupWait = new Promise((resolve) => { releaseBackup = resolve; });
  const { service } = makeService(mock, {
    backupProvider: async () => {
      entered();
      await backupWait;
      throw new Error('old lifecycle failed');
    },
  });
  configure(service, mock);
  const stopped = service.syncNow('alice').catch((error) => error);
  await enteredPromise;
  assert.equal(service.deleteConfig('alice'), true);
  const recreated = service.patchConfig('alice', {
    baseUrl: mock.baseUrl,
    remotePath: 'new-account',
    enabled: false,
  });
  assert.equal(recreated.version, 1);
  assert.equal(recreated.lastErrorCode, null);
  releaseBackup();
  assert.equal((await stopped).code, 'webdav_config_changed');
  await service.close();
  const current = service.getConfig('alice');
  assert.equal(current.remotePath, 'new-account');
  assert.equal(current.lastErrorCode, null);
  assert.equal(current.lastSyncedAt, null);
});

test('transient reads retry within the configured limit and timeouts are sanitized', async () => {
  const mock = await new MockDav().start();
  const fixture = makeService(mock, { maxRetries: 1, timeoutMs: 50 });
  configure(fixture.service, mock);
  mock.failNext.set('OPTIONS', 503);
  const tested = await fixture.service.testConnection('alice');
  assert.equal(tested.reachable, true);
  assert.equal(mock.calls.filter((call) => call.method === 'OPTIONS').length, 2);

  const noRetry = makeService(mock, { maxRetries: 0, timeoutMs: 50 });
  configure(noRetry.service, mock, 'slow-user');
  mock.delayNext.set('OPTIONS', 150);
  await assert.rejects(noRetry.service.testConnection('slow-user'), (error) => {
    const safe = publicWebDavError(error);
    assert.equal(safe.code, 'webdav_timeout');
    assert.equal(JSON.stringify(safe).includes(mock.baseUrl), false);
    assert.equal(JSON.stringify(safe).includes(mock.password), false);
    return true;
  });
});

test('redirect responses are rejected without following or retrying them', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock, { maxRetries: 2 });
  configure(service, mock);
  mock.failNext.set('OPTIONS', 302);

  await assert.rejects(service.testConnection('alice'), (error) => {
    assert.equal(error.code, 'webdav_protocol_error');
    return true;
  });
  assert.equal(mock.calls.filter((call) => call.method === 'OPTIONS').length, 1);
});

test('SSRF checks run at request time and pin only validated addresses', async () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const service = new WebDavSyncService({
    db,
    secretCrypto: memorySecretCrypto(),
    backupProvider: async () => Buffer.from('x'),
    lookup: async () => [{ address: '10.1.2.3', family: 4 }],
  });
  service.patchConfig('alice', {
    baseUrl: 'https://dav.example.test/root/',
    remotePath: 'backup',
    username: 'u',
    password: 'p',
  });
  await assert.rejects(service.testConnection('alice'), (error) => error.code === 'webdav_ssrf_blocked');
});

test('PROPFIND rejects external entities and bounds hostile responses', async () => {
  const mock = await new MockDav().start();
  const { service } = makeService(mock, { maxResponseBytes: 1024 });
  configure(service, mock);
  await service.syncNow('alice');

  mock.xxeNext = true;
  await assert.rejects(service.propfind('alice'), (error) => error.code === 'webdav_protocol_error');
  mock.largeNext = 4096;
  await assert.rejects(service.propfind('alice'), (error) => error.code === 'webdav_response_too_large');
});
