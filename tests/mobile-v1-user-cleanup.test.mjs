import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(root, 'mobile-v1-store.js'));
const { MobileV1BlobManager } = require(path.join(root, 'mobile-v1-blob-manager.js'));
const { MobileV1OutboxDispatcher } = require(path.join(root, 'mobile-v1-outbox-dispatcher.js'));
const { MobileV1Wake } = require(path.join(root, 'mobile-v1-wake.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const DIGEST = 'a'.repeat(64);

function createStore(dir) {
  const db = createDatabase(path.join(dir, 'mobile.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry, blobRoot: path.join(dir, 'blobs') });
  db.exec(`CREATE TABLE IF NOT EXISTS one_clients (
    client_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL
  )`);
  return { db, store };
}

function createManager(store, logs = [], options = {}) {
  return new MobileV1BlobManager({
    store,
    availableDiskBytes: () => Number.MAX_SAFE_INTEGER,
    limits: { minFreeDiskBytes: 1, gcIntervalMs: 60_000 },
    log: (...args) => logs.push(args),
    syncDirectory: options.syncDirectory || (async () => {}),
    syncFile: options.syncFile,
  });
}

function insertOwnerState(store, owner, suffix) {
  const db = store.db;
  const now = Date.now();
  const device = `device-${suffix}-1234567890`;
  const uploadId = `upl_${String(suffix).padEnd(32, '0').slice(0, 32)}`;
  db.prepare(`INSERT INTO mobile_devices
    (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
     app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
     refresh_generation, enabled, automatic_enabled, sync_interval_sec, config_revision,
     registry_hash, last_acked_cursor, last_sync_at, last_seen_at, created_at,
     revoked_at, revoke_reason)
    VALUES (?, ?, ?, ?, 'phone', 'ios', '1', ?, '{}', ?, 1, 1, 1, 300, 1,
            ?, 0, NULL, ?, ?, NULL, NULL)`).run(
      device, owner, `name-${suffix}`, `token-${suffix}`, Buffer.alloc(1), `refresh-${suffix}`,
      store.registryHash, now, now,
    );
  db.prepare(`INSERT INTO mobile_device_proof_challenges
    (nonce_hash, owner_user_id, device_id, method, canonical_path, body_sha256,
     usage, proof_timestamp, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, 'POST', '/sync', ?, 'access', ?, ?, ?, NULL)`).run(
      `nonce-${suffix}`, owner, device, '0'.repeat(64), now, now, now + 30_000,
    );
  store.setEntityVersion({ ownerUserId: owner, entityType: 'note', entityId: `note-${suffix}`, revision: 1 });
  store.setFieldRevisions({ ownerUserId: owner, entityType: 'note', entityId: `note-${suffix}`, fields: ['title'], revision: 1 });
  store.appendChange({ ownerUserId: owner, entityType: 'note', entityId: `note-${suffix}`, action: 'upsert', revision: 1, fieldMask: ['title'] });
  store.recordAppliedOp({ ownerUserId: owner, deviceId: device, opId: `op-${suffix}`, batchId: `batch-${suffix}`, result: { ok: true } });
  db.prepare(`INSERT INTO mobile_sync_runs
    (run_id, owner_user_id, device_id, trigger, state, started_at, from_cursor)
    VALUES (?, ?, ?, 'manual', 'running', ?, 0)`).run(`run-${suffix}`, owner, device, now);
  db.prepare(`INSERT INTO mobile_sensitive_grants
    (grant_hash, owner_user_id, action, target_hash, expires_at, consumed_at, created_at, request_id)
    VALUES (?, ?, 'device.bind', ?, ?, NULL, ?, ?)`).run(
      `grant-${suffix}`, owner, `target-${suffix}`, now + 30_000, now, `request-${suffix}`,
    );
  db.prepare(`INSERT INTO mobile_device_bind_attempts
    (attempt_hash, owner_user_id, device_id, token_id, expected_binding_revision,
     expected_refresh_generation, grant_hash, request_fingerprint, created_at, expires_at,
     completed_at, replay_expires_at, result_binding_revision, result_refresh_generation, request_id)
    VALUES (?, ?, ?, ?, 1, 1, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)`).run(
      `attempt-${suffix}`, owner, device, `token-${suffix}`, `grant-${suffix}`,
      now, now + 30_000, `request-${suffix}`,
    );
  db.prepare(`INSERT INTO mobile_sensitive_attempts
    (owner_user_id, window_started_at, attempts) VALUES (?, ?, 1)`).run(owner, now);
  db.prepare(`INSERT INTO mobile_blob_uploads
    (upload_id, owner_user_id, device_id, sha256, size, mime, chunk_bytes,
     chunk_hashes_json, encrypted, received_json, state, received_bytes,
     finalizing_at, finalize_attempts, failed_at, failure_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, 7, 'application/octet-stream', 7, ?, 0, '[]',
            'receiving', 0, NULL, 0, NULL, NULL, ?, ?)`).run(
      uploadId, owner, device, DIGEST, JSON.stringify([DIGEST]), now, now,
    );
  db.prepare(`INSERT INTO mobile_blobs
    (owner_user_id, sha256, size, mime, chunk_bytes, chunk_count,
     encrypted, created_by_device_id, created_at)
    VALUES (?, ?, 7, 'application/octet-stream', 7, 1, 0, ?, ?)`).run(owner, DIGEST, device, now);
  db.prepare('INSERT INTO one_clients (client_id, owner_user_id) VALUES (?, ?)')
    .run(`legacy-${suffix}`, owner);

  fs.mkdirSync(store.blobOwnerDirectory(owner), { recursive: true });
  fs.writeFileSync(path.join(store.blobOwnerDirectory(owner), `${DIGEST}.blob`), `body-${suffix}`);
  fs.mkdirSync(store.uploadChunkDir(uploadId), { recursive: true });
  fs.writeFileSync(path.join(store.uploadChunkDir(uploadId), '0.part'), `part-${suffix}`);
  return { device, uploadId };
}

const OWNER_TABLES = [
  'mobile_devices', 'mobile_device_proof_challenges', 'mobile_device_bind_attempts', 'mobile_entity_versions',
  'mobile_entity_field_revisions', 'mobile_sync_changes', 'mobile_change_retention',
  'mobile_change_outbox', 'mobile_applied_ops', 'mobile_sync_runs',
  'mobile_sensitive_grants', 'mobile_sensitive_attempts', 'mobile_blob_uploads',
  'mobile_blobs', 'one_clients',
];

test('account deletion transaction revokes all Mobile V1 state and isolates equal digests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-delete-'));
  const logs = [];
  const { db, store } = createStore(dir);
  const manager = createManager(store, logs);
  try {
    await manager.ready;
    const old = insertOwnerState(store, 'old-user-id', '1');
    insertOwnerState(store, 'new-user-id', '2');
    const otherCounts = new Map(OWNER_TABLES.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`)
        .get('new-user-id').count,
    ]));
    await manager.prepareDeleteUserState('old-user-id');
    store.deleteUserState('old-user-id');
    assert.equal(await manager.deleteUserState('old-user-id'), true);

    for (const table of OWNER_TABLES) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`)
        .get('old-user-id').count, 0, table);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`)
        .get('new-user-id').count, otherCounts.get(table), `${table} other owner`);
    }
    assert.equal(fs.existsSync(store.blobOwnerDirectory('old-user-id')), false);
    assert.equal(fs.existsSync(store.uploadChunkDir(old.uploadId)), false);
    assert.equal(fs.readFileSync(path.join(store.blobOwnerDirectory('new-user-id'), `${DIGEST}.blob`), 'utf8'), 'body-2');
    assert.equal(store.getBlob('new-user-id', DIGEST).owner_user_id, 'new-user-id');
    assert.notEqual(store.blobOwnerDirectory('_uploads'), path.join(store.blobRoot, '_uploads'));
    assert.notEqual(store.blobOwnerDirectory('_CLEANUP'), path.join(store.blobRoot, '_cleanup'));
    assert.equal(JSON.stringify(logs).includes('old-user-id'), false);
    assert.equal(JSON.stringify(logs).includes(DIGEST), false);
  } finally {
    manager.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rolled-back deletion preserves authority and creates no cleanup task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-rollback-'));
  const { db, store } = createStore(dir);
  try {
    insertOwnerState(store, 'rollback-user', '3');
    const transaction = db.transaction(() => {
      store.deleteUserState('rollback-user');
      throw new Error('inject rollback');
    });
    assert.throws(() => transaction(), /inject rollback/);
    assert.ok(store.getDeviceRow('device-3-1234567890'));
    assert.equal(store.listUserCleanupJobs('rollback-user').length, 0);
    assert.equal(fs.existsSync(store.blobOwnerDirectory('rollback-user')), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup retries a post-commit cleanup after a simulated process crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-recover-'));
  let first = createStore(dir);
  const seeded = insertOwnerState(first.store, 'crashed-user', '4');
  first.store.deleteUserState('crashed-user');
  assert.equal(first.store.listUserCleanupJobs('crashed-user').length, 1);
  first.db.close();

  const logs = [];
  const reopened = createStore(dir);
  const manager = createManager(reopened.store, logs);
  try {
    await manager.ready;
    assert.equal(reopened.store.listUserCleanupJobs('crashed-user').length, 0);
    assert.equal(fs.existsSync(reopened.store.blobOwnerDirectory('crashed-user')), false);
    assert.equal(fs.existsSync(reopened.store.uploadChunkDir(seeded.uploadId)), false);
    assert.equal(JSON.stringify(logs).includes('crashed-user'), false);
  } finally {
    manager.close();
    reopened.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup migrates the committed legacy owner layout before exact legacy cleanup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-legacy-'));
  const first = createStore(dir);
  const body = Buffer.from('shared legacy body');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  for (const owner of ['LegacyUser', 'legacyuser']) {
    first.db.prepare(`INSERT INTO mobile_blobs
      (owner_user_id, sha256, size, mime, chunk_bytes, chunk_count,
       encrypted, created_by_device_id, created_at)
      VALUES (?, ?, ?, 'application/octet-stream', ?, 1, 0, NULL, ?)`)
      .run(owner, digest, body.length, body.length, Date.now());
  }
  const legacyDirectory = first.store.legacyBlobOwnerDirectory('LegacyUser');
  for (const owner of ['LegacyUser', 'legacyuser']) {
    const ownerDirectory = first.store.legacyBlobOwnerDirectory(owner);
    fs.mkdirSync(ownerDirectory, { recursive: true });
    fs.writeFileSync(path.join(ownerDirectory, `${digest}.blob`), body);
  }
  first.db.close();

  const reopened = createStore(dir);
  const manager = createManager(reopened.store);
  try {
    await manager.ready;
    for (const owner of ['LegacyUser', 'legacyuser']) {
      assert.deepEqual(fs.readFileSync(path.join(reopened.store.blobOwnerDirectory(owner), `${digest}.blob`)), body);
    }
    await manager.prepareDeleteUserState('LegacyUser');
    reopened.store.deleteUserState('LegacyUser');
    assert.equal(await manager.deleteUserState('LegacyUser'), true);
    assert.equal(fs.existsSync(path.join(legacyDirectory, `${digest}.blob`)), false);
    assert.deepEqual(fs.readFileSync(path.join(
      reopened.store.blobOwnerDirectory('legacyuser'), `${digest}.blob`,
    )), body);
  } finally {
    manager.close();
    reopened.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a transient legacy migration fsync failure keeps startup available for a later retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-legacy-fsync-'));
  const current = createStore(dir);
  const owner = 'legacy-fsync-user';
  const body = Buffer.from('legacy fsync fallback');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  current.db.prepare(`INSERT INTO mobile_blobs
    (owner_user_id, sha256, size, mime, chunk_bytes, chunk_count,
     encrypted, created_by_device_id, created_at)
    VALUES (?, ?, ?, 'application/octet-stream', ?, 1, 0, NULL, ?)`)
    .run(owner, digest, body.length, body.length, Date.now());
  const legacyDirectory = current.store.legacyBlobOwnerDirectory(owner);
  const legacyFile = path.join(legacyDirectory, `${digest}.blob`);
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(legacyFile, body);
  const logs = [];
  const deferred = createManager(current.store, logs, {
    syncFile: async () => { throw Object.assign(new Error('transient'), { code: 'EPERM' }); },
  });
  try {
    await deferred.ready;
    assert.equal(fs.existsSync(current.store.blobFilePath({ owner_user_id: owner, sha256: digest })), false);
    const chunks = [];
    for await (const chunk of current.store.createBlobReadStream({ owner_user_id: owner, sha256: digest })) {
      chunks.push(chunk);
    }
    assert.deepEqual(Buffer.concat(chunks), body);
    const rendered = JSON.stringify(logs);
    assert.equal(rendered.includes(owner), false);
    assert.equal(rendered.includes(digest), false);
  } finally {
    deferred.close();
  }

  const recovered = createManager(current.store);
  try {
    await recovered.ready;
    assert.deepEqual(fs.readFileSync(current.store.blobFilePath({
      owner_user_id: owner,
      sha256: digest,
    })), body);
  } finally {
    recovered.close();
    current.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup syncs every modified source parent before acknowledging the job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-cleanup-fsync-'));
  const current = createStore(dir);
  const synced = [];
  const manager = createManager(current.store, [], {
    syncDirectory: async (directory) => { synced.push(path.resolve(directory)); },
  });
  try {
    await manager.ready;
    const owner = 'durable-source-user';
    insertOwnerState(current.store, owner, 'c');
    const legacyDirectory = current.store.legacyBlobOwnerDirectory(owner);
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, `${DIGEST}.blob`), 'legacy');
    fs.writeFileSync(path.join(legacyDirectory, 'unrelated.blob'), 'keep');

    await manager.prepareDeleteUserState(owner);
    current.store.deleteUserState(owner);
    assert.equal(await manager.deleteUserState(owner), true);

    const expected = [
      current.store.blobRoot,
      path.join(current.store.blobRoot, '_uploads'),
      path.join(current.store.blobRoot, '_cleanup'),
      legacyDirectory,
    ].map((directory) => path.resolve(directory));
    for (const directory of expected) assert.equal(synced.includes(directory), true, directory);
    assert.equal(fs.existsSync(path.join(legacyDirectory, 'unrelated.blob')), true);
    assert.equal(current.store.listUserCleanupJobs(owner).length, 0);
  } finally {
    manager.close();
    current.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed persistent descriptors stay retryable and never enter logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-bad-job-'));
  const first = createStore(dir);
  insertOwnerState(first.store, 'descriptor-secret-user', '5');
  first.store.deleteUserState('descriptor-secret-user');
  first.db.prepare(`UPDATE mobile_user_cleanup_jobs SET upload_ids_json = ?
    WHERE owner_user_id = ?`).run('{"secret":"do-not-log"}', 'descriptor-secret-user');
  first.db.close();

  const logs = [];
  const reopened = createStore(dir);
  const manager = createManager(reopened.store, logs);
  try {
    await manager.ready;
    assert.equal(reopened.store.listUserCleanupJobs('descriptor-secret-user').length, 1);
    assert.equal(fs.existsSync(reopened.store.blobOwnerDirectory('descriptor-secret-user')), true);
    assert.throws(() => reopened.store.deleteUserState('descriptor-secret-user'), /descriptor is invalid/);
    assert.equal(reopened.db.prepare(`SELECT upload_ids_json FROM mobile_user_cleanup_jobs
      WHERE owner_user_id = ?`).get('descriptor-secret-user').upload_ids_json, '{"secret":"do-not-log"}');
    reopened.db.prepare(`UPDATE mobile_user_cleanup_jobs
      SET cleanup_id = 'bad-cleanup-id', upload_ids_json = '[]' WHERE owner_user_id = ?`)
      .run('descriptor-secret-user');
    assert.throws(() => reopened.store.deleteUserState('descriptor-secret-user'), /descriptor is invalid/);
    assert.equal(reopened.db.prepare(`SELECT cleanup_id FROM mobile_user_cleanup_jobs
      WHERE owner_user_id = ?`).get('descriptor-secret-user').cleanup_id, 'bad-cleanup-id');
    const rendered = JSON.stringify(logs);
    assert.equal(rendered.includes('descriptor-secret-user'), false);
    assert.equal(rendered.includes('do-not-log'), false);
  } finally {
    manager.close();
    reopened.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported directory fsync keeps the cleanup task until restart confirmation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-durable-'));
  const first = createStore(dir);
  const manager = createManager(first.store, [], {
    syncDirectory: async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); },
  });
  try {
    await manager.ready;
    insertOwnerState(first.store, 'durable-user', '8');
    await manager.prepareDeleteUserState('durable-user');
    first.store.deleteUserState('durable-user');
    assert.equal(await manager.deleteUserState('durable-user'), false);
    const pending = first.store.listUserCleanupJobs('durable-user');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].lastErrorCode, 'awaiting_cleanup_confirmation');
  } finally {
    manager.close();
    first.db.close();
  }

  const reopened = createStore(dir);
  const recovered = createManager(reopened.store);
  try {
    await recovered.ready;
    assert.equal(reopened.store.listUserCleanupJobs('durable-user').length, 0);
  } finally {
    recovered.close();
    reopened.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup never follows an upload-root junction outside blob storage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-junction-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-outside-'));
  const logs = [];
  const { db, store } = createStore(dir);
  const manager = createManager(store, logs);
  try {
    await manager.ready;
    const seeded = insertOwnerState(store, 'junction-user', '6');
    fs.rmSync(path.join(store.blobRoot, '_uploads'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outside, seeded.uploadId), { recursive: true });
    const outsideMarker = path.join(outside, seeded.uploadId, 'outside-secret.txt');
    fs.writeFileSync(outsideMarker, 'must-survive');
    try {
      fs.symlinkSync(outside, path.join(store.blobRoot, '_uploads'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        t.skip('junction creation is unavailable on this filesystem');
        return;
      }
      throw error;
    }

    await manager.prepareDeleteUserState('junction-user');
    store.deleteUserState('junction-user');
    assert.equal(await manager.deleteUserState('junction-user'), false);
    assert.equal(fs.readFileSync(outsideMarker, 'utf8'), 'must-survive');
    assert.equal(store.listUserCleanupJobs('junction-user').length, 1);
    assert.equal(JSON.stringify(logs).includes('junction-user'), false);
    assert.equal(JSON.stringify(logs).includes('outside-secret'), false);
  } finally {
    manager.close();
    db.close();
    const uploadRoot = path.join(store.blobRoot, '_uploads');
    try {
      if (fs.lstatSync(uploadRoot).isSymbolicLink()) fs.unlinkSync(uploadRoot);
      else fs.rmSync(uploadRoot, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('prepareDeleteUserState blocks new work and joins an active finalizer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-drain-'));
  const { db, store } = createStore(dir);
  const manager = createManager(store);
  try {
    await manager.ready;
    let releaseFinalizer;
    let markStarted;
    const gate = new Promise((resolve) => { releaseFinalizer = resolve; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    manager._finalize = async () => {
      markStarted();
      await gate;
    };
    manager._scheduleFinalization({
      upload_id: 'upl_77777777777777777777777777777777',
      owner_user_id: 'draining-owner',
      device_id: 'draining-device',
      state: 'receiving',
      failed_at: null,
    });
    await started;
    let drained = false;
    const draining = manager.prepareDeleteUserState('draining-owner').then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drained, false);
    assert.throws(() => manager._acquireRequest('draining-owner', 'new-device'), /unavailable/);
    releaseFinalizer();
    await draining;
    assert.equal(drained, true);
  } finally {
    manager.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizer drain timeout is bounded and restoreUserState compensates a failed transaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mobile-timeout-'));
  const { db, store } = createStore(dir);
  const manager = createManager(store);
  try {
    await manager.ready;
    let releaseFinalizer;
    let markStarted;
    const gate = new Promise((resolve) => { releaseFinalizer = resolve; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    manager._finalize = async () => { markStarted(); await gate; };
    manager._scheduleFinalization({
      upload_id: 'upl_99999999999999999999999999999999',
      owner_user_id: 'timeout-owner',
      device_id: 'timeout-device',
      state: 'receiving',
      failed_at: null,
    });
    await started;
    const began = Date.now();
    await assert.rejects(manager.prepareDeleteUserState('timeout-owner', 25), /did not drain/);
    assert.ok(Date.now() - began < 1000);
    manager.restoreUserState('timeout-owner');
    const releaseRequest = manager._acquireRequest('timeout-owner', 'restored-device');
    releaseRequest();
    releaseFinalizer();
    await manager.waitForIdle(null, 2000);
  } finally {
    manager.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wake and outbox teardown block stale owner activity without affecting another account', async () => {
  const wake = new MobileV1Wake({ heartbeatMs: 60_000 });
  const req = new EventEmitter();
  req.headers = {};
  const res = new EventEmitter();
  Object.assign(res, {
    writableLength: 0, writableEnded: false, destroyed: false,
    setHeader() {}, write() { return true; }, end() { this.writableEnded = true; },
  });
  assert.equal(wake.subscribe({ req, res, ownerUserId: 'old-owner', deviceId: 'device-old', currentCursor: 0 }), true);
  assert.equal(wake.deleteUserState('old-owner'), 1);
  assert.equal(res.writableEnded, true);
  assert.equal(wake.subscribe({ req: new EventEmitter(), res: new EventEmitter(), ownerUserId: 'old-owner', deviceId: 'device-new', currentCursor: 0 }), false);

  const pending = [
    { outboxId: 1, ownerUserId: 'old-owner', throughCursor: 3, createdAt: 1 },
    { outboxId: 2, ownerUserId: 'other-owner', throughCursor: 4, createdAt: 1 },
  ];
  const published = [];
  const bridge = {
    pendingWakeEvents() { return pending.slice(); },
    acknowledgeWakeEvents(ids) {
      for (const id of ids) pending.splice(pending.findIndex((row) => row.outboxId === id), 1);
    },
  };
  const worker = new MobileV1OutboxDispatcher({
    changeBridge: bridge,
    wake: { publish: (...args) => published.push(args) },
    pollMs: 60_000,
  });
  assert.equal(worker.start(), true);
  await worker.deleteUserState('old-owner');
  await worker.flush();
  worker.restoreUserState('old-owner');
  wake.restoreUserState('old-owner');
  assert.equal(worker.blockedOwners.has('old-owner'), false);
  assert.equal(wake.blockedOwners.has('old-owner'), false);
  worker.close();
  wake.close();
  assert.deepEqual(published, [['other-owner', 4, 'change']]);
  assert.deepEqual(pending.map((row) => row.ownerUserId), ['old-owner']);
});
