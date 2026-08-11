import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(root, 'mobile-v1-store.js'));
const { FileSyncConfigService } = require(path.join(root, 'file-sync-config-service.js'));
const { createFileSyncConfigAdapter } = require(path.join(root, 'mobile-v1-file-config-entity.js'));
const { OneClientManager } = require(path.join(root, 'one-client-manager.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function createLegacyTable(db) {
  db.exec(`CREATE TABLE one_clients (
    client_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    owner_username TEXT NOT NULL,
    device_name TEXT,
    platform TEXT,
    app_version TEXT,
    token_id TEXT NOT NULL,
    device_token_hash TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sync_interval_sec INTEGER NOT NULL DEFAULT 300,
    last_sync_at INTEGER,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoke_reason TEXT,
    device_fingerprint TEXT,
    sync_revision INTEGER NOT NULL DEFAULT 0
  )`);
}

function insertLegacy(db, {
  id = 'device-stable-0001', owner = 'owner-1', name = 'Legacy device', interval = 300,
  enabled = 1, automatic = 1, revision = 1, revokedAt = null,
  tokenHash = 'LEGACY_TOKEN_HASH_CANARY', fingerprint = 'FINGERPRINT_CANARY',
  revokeReason = null,
} = {}) {
  db.prepare(`INSERT INTO one_clients
    (client_id, owner_user_id, owner_username, device_name, platform, app_version,
     token_id, device_token_hash, enabled, sync_interval_sec, last_sync_at, last_seen_at,
     created_at, revoked_at, revoke_reason, device_fingerprint, sync_revision,
     automatic_enabled, config_revision)
    VALUES (?, ?, ?, ?, 'android', 'legacy-version', 'LEGACY_TOKEN_ID_CANARY', ?, ?, ?,
      NULL, 10, 1, ?, ?, ?, 99, ?, ?)`).run(
    id, owner, owner, name, tokenHash, enabled, interval, revokedAt,
    revokeReason, fingerprint, automatic, revision,
  );
}

function insertMobile(db, {
  id = 'device-stable-0001', owner = 'owner-1', name = 'Mobile device', interval = 600,
  enabled = 1, automatic = 1, revision = 1, revokedAt = null,
  refreshHash = 'REFRESH_HASH_CANARY', revokeReason = null,
} = {}) {
  db.prepare(`INSERT INTO mobile_devices
    (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
     app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
     refresh_generation, enabled, automatic_enabled, sync_interval_sec, config_revision,
     registry_hash, last_acked_cursor, last_sync_at, last_seen_at, created_at,
     revoked_at, revoke_reason)
    VALUES (?, ?, ?, 'MOBILE_TOKEN_ID_CANARY', ?, 'android', 'mobile-version', ?, ?, ?,
      7, ?, ?, ?, ?, 'REGISTRY_HASH_CANARY', 0, NULL, 11, 2, ?, ?)`).run(
    id, owner, owner, name, Buffer.from('ENCRYPTION_KEY_CANARY'),
    'SIGNING_JWK_CANARY', refreshHash, enabled, automatic, interval, revision,
    revokedAt, revokeReason,
  );
}

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-file-config-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  createLegacyTable(db);
  const store = new MobileV1Store({ db, entityRegistry: registry });
  const service = new FileSyncConfigService({ db, store, now: () => 1_900_000_000_000 });
  return {
    directory, db, store, service,
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('migration adds config columns and same-owner v1 identity wins without changing its id', () => {
  const ctx = fresh();
  try {
    insertLegacy(ctx.db, {
      id: 'device-stable-0001', name: 'stale legacy', interval: 30,
      automatic: 0, revision: 50,
    });
    insertMobile(ctx.db, {
      id: 'device-stable-0001', name: 'authoritative mobile', interval: 900,
      automatic: 1, revision: 3,
    });
    ctx.service.reconcileAll();

    const legacyColumns = ctx.db.prepare('PRAGMA table_info(one_clients)').all().map((row) => row.name);
    const mobileColumns = ctx.db.prepare('PRAGMA table_info(mobile_devices)').all().map((row) => row.name);
    assert.ok(legacyColumns.includes('automatic_enabled'));
    assert.ok(legacyColumns.includes('config_revision'));
    assert.ok(mobileColumns.includes('config_revision'));

    assert.deepEqual(ctx.service.list('owner-1'), [{
      clientId: 'device-stable-0001',
      ownerUserId: 'owner-1',
      deviceName: 'authoritative mobile',
      enabled: true,
      automaticEnabled: true,
      syncIntervalSec: 900,
      syncRevision: 3,
    }]);
    const legacy = ctx.db.prepare('SELECT * FROM one_clients WHERE client_id = ?').get('device-stable-0001');
    assert.equal(legacy.device_name, 'authoritative mobile');
    assert.equal(legacy.sync_interval_sec, 900);
    assert.equal(legacy.config_revision, 3);
    assert.equal(legacy.device_token_hash, 'LEGACY_TOKEN_HASH_CANARY', 'migration never copies or rotates credentials');
  } finally {
    ctx.cleanup();
  }
});

test('toggle and interval writes are atomic, owner-isolated, optimistic and idempotent', () => {
  const ctx = fresh();
  try {
    insertMobile(ctx.db, { id: 'mobile-owner-00001', owner: 'owner-1', revision: 1 });
    insertMobile(ctx.db, { id: 'mobile-owner-00002', owner: 'owner-2', revision: 1 });

    const toggled = ctx.service.setAutomaticEnabled('owner-1', 'mobile-owner-00001', false, {
      expectedRevision: 1,
      actorDeviceId: 'mobile-owner-00001',
    });
    assert.equal(toggled.syncRevision, 2);
    const interval = ctx.service.setInterval('owner-1', 'mobile-owner-00001', 999999, {
      expectedRevision: 2,
      actorDeviceId: 'mobile-owner-00001',
    });
    assert.equal(interval.syncIntervalSec, 86400);
    assert.equal(interval.syncRevision, 3);
    const ownerChanges = ctx.store.changePage('owner-1', 0, 20).changes;
    assert.equal(ownerChanges.length, 2);
    assert.deepEqual(ownerChanges.map((change) => change.actorDeviceId), [
      'mobile-owner-00001',
      'mobile-owner-00001',
    ]);
    assert.equal(ctx.store.changePage('owner-2', 0, 20).changes.length, 0);

    const cursor = ctx.store.latestCursor('owner-1');
    const duplicate = ctx.service.setInterval('owner-1', 'mobile-owner-00001', 86400, {
      expectedRevision: 3,
    });
    assert.equal(duplicate.syncRevision, 3);
    assert.equal(ctx.store.latestCursor('owner-1'), cursor, 'same logical write allocates no cursor');
    assert.throws(
      () => ctx.service.setEnabled('owner-1', 'mobile-owner-00001', false, { expectedRevision: 2 }),
      (error) => error.code === 'revision_conflict' && error.status === 409,
    );
    assert.throws(
      () => ctx.service.setEnabled('owner-2', 'mobile-owner-00001', false),
      (error) => error.code === 'client_not_found' && error.status === 404,
    );
    assert.equal(ctx.service.read('owner-2', 'mobile-owner-00002').syncRevision, 1);
  } finally {
    ctx.cleanup();
  }
});

test('same id across accounts is never rebound or mirrored across the account boundary', () => {
  const ctx = fresh();
  try {
    insertLegacy(ctx.db, { id: 'colliding-device-id', owner: 'legacy-owner', name: 'legacy owner' });
    insertMobile(ctx.db, { id: 'colliding-device-id', owner: 'mobile-owner', name: 'mobile owner' });
    ctx.service.reconcileAll();

    assert.equal(ctx.service.read('legacy-owner', 'colliding-device-id').deviceName, 'legacy owner');
    assert.equal(ctx.service.read('mobile-owner', 'colliding-device-id').deviceName, 'mobile owner');
    ctx.service.setInterval('mobile-owner', 'colliding-device-id', 120);
    const legacy = ctx.db.prepare('SELECT * FROM one_clients WHERE client_id = ?').get('colliding-device-id');
    assert.equal(legacy.sync_interval_sec, 300);
    assert.equal(ctx.store.changePage('legacy-owner', 0, 20).changes.length, 0);
    assert.equal(ctx.store.changePage('mobile-owner', 0, 20).changes.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('network policy and SAF paths remain device-local and never enter the feed', () => {
  const ctx = fresh();
  try {
    insertLegacy(ctx.db, { id: 'legacy-local-0001', owner: 'owner-1' });
    for (const patch of [
      { networkPolicy: 'unmetered' },
      { safTreeUri: 'content://secret/tree' },
      { localPath: 'C:\\private\\files' },
    ]) {
      assert.throws(
        () => ctx.service.update('owner-1', 'legacy-local-0001', patch),
        (error) => error.code === 'invalid_request'
          && error.details?.residency === 'device-local',
      );
    }
    const projected = JSON.stringify(ctx.service.read('owner-1', 'legacy-local-0001'));
    assert.doesNotMatch(projected, /network|content:\/\/|private/i);
    assert.equal(ctx.store.latestCursor('owner-1'), 0);
  } finally {
    ctx.cleanup();
  }
});

test('revoke produces one owner tombstone, invalidates credentials and leaks no canary', () => {
  const ctx = fresh();
  try {
    insertLegacy(ctx.db, { id: 'revoke-device-001', owner: 'owner-1' });
    insertMobile(ctx.db, {
      id: 'revoke-device-001', owner: 'owner-1', revokeReason: 'MOBILE_REASON_CANARY',
    });
    ctx.service.reconcileAll();

    const before = JSON.stringify(ctx.service.list('owner-1'));
    for (const forbidden of [
      'LEGACY_TOKEN_HASH_CANARY', 'FINGERPRINT_CANARY', 'REFRESH_HASH_CANARY',
      'ENCRYPTION_KEY_CANARY', 'SIGNING_JWK_CANARY', 'MOBILE_REASON_CANARY',
      'MOBILE_TOKEN_ID_CANARY',
    ]) assert.ok(!before.includes(forbidden), `${forbidden} must not be projected`);

    const result = ctx.service.revoke('owner-1', 'revoke-device-001', 'NEW_REASON_CANARY', {
      expectedRevision: 1,
    });
    assert.equal(result.revoked, true);
    assert.equal(ctx.service.read('owner-1', 'revoke-device-001'), null);
    const mobile = ctx.db.prepare('SELECT * FROM mobile_devices WHERE device_id = ?').get('revoke-device-001');
    const legacy = ctx.db.prepare('SELECT * FROM one_clients WHERE client_id = ?').get('revoke-device-001');
    assert.equal(mobile.refresh_token_hash, null);
    assert.equal(legacy.device_token_hash, null);

    const changes = ctx.store.changePage('owner-1', 0, 20).changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, 'delete');
    assert.equal(changes[0].entityType, 'fileSyncConfig');
    assert.equal(changes[0].tombstone.ownerUserId, 'owner-1');
    const wire = JSON.stringify({ changes, outbox: ctx.store.wakeOutboxPage(20) });
    assert.ok(!wire.includes('NEW_REASON_CANARY'));
    assert.ok(!wire.includes('REFRESH_HASH_CANARY'));
    assert.ok(!wire.includes('FINGERPRINT_CANARY'));

    const cursor = ctx.store.latestCursor('owner-1');
    assert.equal(ctx.service.revoke('owner-1', 'revoke-device-001').duplicate, true);
    assert.equal(ctx.store.latestCursor('owner-1'), cursor);
  } finally {
    ctx.cleanup();
  }
});

test('entity adapter projects safe config and keeps bind/revoke outside generic push', () => {
  const ctx = fresh();
  try {
    insertMobile(ctx.db, { id: 'adapter-device-001', owner: 'owner-1' });
    const adapter = createFileSyncConfigAdapter({ service: ctx.service });
    const user = { userId: 'owner-1' };
    const row = adapter.read(user, 'adapter-device-001');
    assert.equal(adapter.idOf(row), 'adapter-device-001');
    assert.equal(adapter.revisionOf(row), 1);
    assert.deepEqual(adapter.list(user), [row]);
    assert.equal(adapter.residency(user, 'adapter-device-001'), 'owned');
    const updated = adapter.update(
      user,
      'adapter-device-001',
      { automaticEnabled: false },
      { actorDeviceId: 'adapter-device-001' },
    );
    assert.equal(updated.automaticEnabled, false);
    assert.equal(ctx.store.changePage(user.userId, 0, 20).changes[0].actorDeviceId, 'adapter-device-001');
    assert.equal(Object.prototype.hasOwnProperty.call(updated, 'actorDeviceId'), false);
    assert.throws(() => adapter.create(user, 'new-device', {}), (error) => error.code === 'unsupported_scope');
    assert.throws(() => adapter.remove(user, 'adapter-device-001'), (error) => (
      error.code === 'sensitive_verification_required' && error.status === 403
    ));
  } finally {
    ctx.cleanup();
  }
});

test('legacy OneClientManager facade emits config changes without publishing credential metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-file-config-manager-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  try {
    const token = { id: 'token-id-metadata', token: 'FILE_AGENT_SECRET_CANARY', name: 'test' };
    const manager = new OneClientManager({
      db,
      fileAgentManager: {
        listTokens(_username, options) {
          return [{ ...token, token: options?.includeToken ? token.token : undefined }];
        },
      },
      resourceService: { listConnections: () => [], listOwned: () => [] },
      notesService: { list: () => ({ notes: [], total: 0 }) },
      userSettingsService: { effective: () => ({}) },
      storage: {},
      log: () => {},
    });
    const user = { userId: 'owner-1', username: 'owner-1' };
    const bound = manager.bind(user, {
      clientId: 'legacy-manager-001', tokenId: token.id, deviceName: 'Manager device',
      deviceFingerprint: 'MANAGER_FINGERPRINT_CANARY',
    });
    assert.ok(bound.deviceToken);
    const rebound = manager.bind(user, {
      clientId: 'legacy-manager-001', tokenId: token.id, deviceName: 'Rebound device',
      syncIntervalSec: 40,
    });
    assert.notEqual(rebound.deviceToken, bound.deviceToken);
    assert.equal(manager.resolveDeviceToken(bound.deviceToken), null, 'rebind rotates the legacy credential');
    assert.equal(rebound.client.clientId, bound.client.clientId, 'rebind preserves the stable identity');
    assert.equal(rebound.client.syncRevision, 2);
    manager.updateInterval(user.userId, 'legacy-manager-001', 45);
    manager.setAutomaticEnabled(user.userId, 'legacy-manager-001', false);
    manager.revoke(user.userId, 'legacy-manager-001', 'MANAGER_REASON_CANARY');

    const store = manager.fileSyncConfigService.changeBridge.store;
    const changes = store.changePage(user.userId, 0, 20).changes;
    assert.deepEqual(changes.map((change) => change.action), [
      'upsert', 'upsert', 'upsert', 'upsert', 'delete',
    ]);
    const wire = JSON.stringify({
      changes,
      outbox: store.wakeOutboxPage(20),
      listed: manager.listForUser(user.userId),
    });
    assert.ok(!wire.includes('FILE_AGENT_SECRET_CANARY'));
    assert.ok(!wire.includes('MANAGER_FINGERPRINT_CANARY'));
    assert.ok(!wire.includes('MANAGER_REASON_CANARY'));
    assert.equal(manager.resolveDeviceToken(bound.deviceToken), null);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
