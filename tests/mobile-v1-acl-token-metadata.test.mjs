import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { Authz, CAP } = require(path.join(root, 'authz.js'));
const { MobileV1ChangeBridge } = require(path.join(root, 'mobile-v1-change-bridge.js'));
const { SharingService } = require(path.join(root, 'sharing-service.js'));
const {
  ClientTokenMetadataService,
  ResourceAclMetadataService,
  TOKEN_SYNC_CONTRACT_VERSION,
} = require(path.join(root, 'acl-token-metadata-service.js'));
const { createAclTokenMetadataAdapters } = require(path.join(root, 'mobile-v1-acl-token-metadata.js'));
const { createEntityAdapters, projectPayload } = require(path.join(root, 'mobile-v1-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-acl-token-sync-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`
    CREATE TABLE resource_acl (
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT 'user',
      subject_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      granted_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      PRIMARY KEY (resource_type, resource_id, subject_type, subject_id)
    );
    CREATE TABLE audit_events (
      event_id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      target_user_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
  let timestamp = 2_000_000_000_000;
  const users = new Map([
    ['owner-a', { userId: 'owner-a', username: 'alice', status: 'active', role: 'user' }],
    ['owner-b', { userId: 'owner-b', username: 'bob', status: 'active', role: 'user' }],
    ['subject-a', { userId: 'subject-a', username: 'shared-a', status: 'active', role: 'user' }],
    ['subject-b', { userId: 'subject-b', username: 'shared-b', status: 'active', role: 'user' }],
  ]);
  const resourcesByKey = new Map([
    ['connection:connection-a', { id: 'connection-a', ownerUserId: 'owner-a', name: 'A secret host' }],
    ['connection:connection-b', { id: 'connection-b', ownerUserId: 'owner-b', name: 'B secret host' }],
  ]);
  const resources = {
    _rawResource(type, id) { return resourcesByKey.get(`${type}:${id}`) || null; },
  };
  const storage = {
    getUserById(id) { return users.get(id) || null; },
  };
  const authz = new Authz(db, { getUserById: (id) => users.get(id) || null, now: () => ++timestamp });
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const acl = new ResourceAclMetadataService({ db, authz, resources, changeBridge: bridge, now: () => ++timestamp });
  const sharing = new SharingService(authz, storage, resources);
  sharing.setAclMetadataService(acl);
  return {
    directory, db, users, resources, resourcesByKey, authz, bridge, acl, sharing,
    cleanup() {
      acl.uninstall();
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('resource ACL projections are owner-only, stable, and omit foreign resource details', () => {
  const context = fresh();
  try {
    context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-a', subjectId: 'subject-a',
      capabilities: [CAP.DISCOVER, CAP.VIEW], grantedByUserId: 'owner-a',
    });
    context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-b', subjectId: 'subject-b',
      capabilities: [CAP.VIEW], grantedByUserId: 'owner-b',
    });

    const ownerRows = context.acl.list(context.users.get('owner-a'));
    assert.equal(ownerRows.length, 1);
    assert.deepEqual(Object.keys(ownerRows[0]).sort(), [
      'capabilities', 'createdAt', 'expiresAt', 'grantKey', 'grantedByUserId',
      'resourceOwnerUserId', 'revision', 'revokedAt', 'subjectId', 'subjectType',
    ]);
    assert.equal(ownerRows[0].resourceOwnerUserId, 'owner-a');
    assert.equal(ownerRows[0].subjectId, 'subject-a');
    assert.ok(!JSON.stringify(ownerRows).includes('connection-a'));
    assert.ok(!JSON.stringify(ownerRows).includes('A secret host'));
    assert.deepEqual(context.acl.list(context.users.get('subject-a')), [], 'a recipient never receives a foreign owner ACL');
    assert.equal(context.acl.read(context.users.get('owner-b'), ownerRows[0].grantKey), null);

    context.resourcesByKey.set('connection:connection-a', {
      id: 'connection-a', ownerUserId: 'owner-b', name: 'Transferred resource',
    });
    assert.deepEqual(context.acl.list(context.users.get('owner-a')), [], 'stale stored ownership fails closed after transfer');
    assert.equal(context.acl.read(context.users.get('owner-b'), ownerRows[0].grantKey), null, 'ACL metadata never migrates to another owner implicitly');
    assert.throws(() => context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-a', subjectId: 'subject-a',
      capabilities: [CAP.VIEW], grantedByUserId: 'owner-b',
    }), (error) => error.code === 'acl_owner_changed_requires_revoke');
    context.resourcesByKey.set('connection:connection-a', {
      id: 'connection-a', ownerUserId: 'owner-a', name: 'A secret host',
    });

    const firstKey = ownerRows[0].grantKey;
    context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-a', subjectId: 'subject-a',
      capabilities: [CAP.DISCOVER, CAP.VIEW, CAP.USE], grantedByUserId: 'owner-a',
    });
    assert.equal(context.acl.list(context.users.get('owner-a'))[0].grantKey, firstKey);
    assert.equal(context.bridge.store.changePage('owner-a', 0, 20).changes.length, 2);
    assert.equal(context.bridge.store.changePage('subject-a', 0, 20).changes.length, 0);
  } finally {
    context.cleanup();
  }
});

test('owner ACL reductions and revocations advance revision with durable owner wake events', () => {
  const context = fresh();
  try {
    context.sharing.putShares(context.users.get('owner-a'), 'connection', 'connection-a', [{
      subjectId: 'subject-a', capabilities: [CAP.DISCOVER, CAP.VIEW, CAP.USE, CAP.CONTROL],
    }]);
    const adapter = createAclTokenMetadataAdapters({ resourceAclService: context.acl }).get('resourceAcl');
    const initial = adapter.list(context.users.get('owner-a'))[0];
    const updateReceipt = {};
    const reduced = adapter.update(context.users.get('owner-a'), initial.grantKey, {
      capabilities: [CAP.DISCOVER, CAP.VIEW],
    }, { actorDeviceId: 'device-owner-a', mutationReceipt: updateReceipt });
    assert.equal(reduced.revision, 2);
    assert.deepEqual(reduced.capabilities, [CAP.DISCOVER, CAP.VIEW]);
    assert.throws(
      () => adapter.update(context.users.get('owner-b'), initial.grantKey, { capabilities: [CAP.VIEW] }),
      (error) => error.code === 'acl_not_found',
    );

    const deleteReceipt = {};
    adapter.remove(context.users.get('owner-a'), initial.grantKey, {
      actorDeviceId: 'device-owner-a', mutationReceipt: deleteReceipt,
    });
    assert.equal(adapter.read(context.users.get('owner-a'), initial.grantKey), null);
    const deleted = context.acl.read(context.users.get('owner-a'), initial.grantKey, { includeRevoked: true });
    assert.equal(deleted.revision, 3);
    assert.ok(deleted.revokedAt);
    const changes = context.bridge.store.changePage('owner-a', 0, 20).changes;
    assert.deepEqual(changes.map((change) => [change.action, change.revision]), [
      ['upsert', 1], ['upsert', 2], ['delete', 3],
    ]);
    assert.equal(updateReceipt.changeSeq, changes[1].changeSeq);
    assert.equal(deleteReceipt.changeSeq, changes[2].changeSeq);
    assert.deepEqual(changes.map((change) => change.actorDeviceId), [
      null, 'device-owner-a', 'device-owner-a',
    ]);
    assert.equal(context.bridge.pendingWakeEvents().length, 3);
    assert.deepEqual(Object.keys(context.bridge.pendingWakeEvents()[0]).sort(), [
      'createdAt', 'outboxId', 'ownerUserId', 'throughCursor',
    ]);
  } finally {
    context.cleanup();
  }
});

test('empty ACL capability updates preserve the mobile actor and canonical receipt', () => {
  const context = fresh();
  try {
    context.sharing.putShares(context.users.get('owner-a'), 'connection', 'connection-a', [{
      subjectId: 'subject-a', capabilities: [CAP.VIEW],
    }]);
    const adapter = createAclTokenMetadataAdapters({ resourceAclService: context.acl }).get('resourceAcl');
    const initial = adapter.list(context.users.get('owner-a'))[0];
    const receipt = {};

    adapter.update(context.users.get('owner-a'), initial.grantKey, { capabilities: [] }, {
      actorDeviceId: 'device-owner-a',
      mutationReceipt: receipt,
    });

    const changes = context.bridge.store.changePage('owner-a', 0, 20).changes;
    assert.equal(changes.length, 2);
    assert.equal(changes[1].action, 'delete');
    assert.equal(changes[1].actorDeviceId, 'device-owner-a');
    assert.equal(receipt.changeSeq, changes[1].changeSeq);
  } finally {
    context.cleanup();
  }
});

test('ACL feed failure rolls back the canonical permission mutation', () => {
  const context = fresh();
  try {
    context.db.exec(`CREATE TRIGGER reject_acl_feed BEFORE INSERT ON mobile_sync_changes
      WHEN NEW.entity_type = 'resourceAcl'
      BEGIN SELECT RAISE(ABORT, 'ACL feed unavailable'); END;`);
    assert.throws(() => context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-a', subjectId: 'subject-a',
      capabilities: [CAP.VIEW], grantedByUserId: 'owner-a',
    }), /ACL feed unavailable/);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM resource_acl').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, 0);
  } finally {
    context.cleanup();
  }
});

test('resource deletion emits ACL tombstones using persisted ownership after the resource disappears', () => {
  const context = fresh();
  try {
    context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-a', subjectId: 'subject-a',
      capabilities: [CAP.VIEW], grantedByUserId: 'owner-a',
    });
    context.resourcesByKey.delete('connection:connection-a');
    assert.equal(context.authz.revokeAllForResource('connection', 'connection-a', 'owner-a'), 1);
    const changes = context.bridge.store.changePage('owner-a', 0, 20).changes;
    assert.deepEqual(changes.map((change) => change.action), ['upsert', 'delete']);
    assert.equal(context.bridge.store.changePage('subject-a', 0, 20).changes.length, 0);
  } finally {
    context.cleanup();
  }
});

class EncryptedTokenSource {
  constructor(db) {
    this.db = db;
    this.metadataSyncContract = {
      version: TOKEN_SYNC_CONTRACT_VERSION,
      storage: 'encrypted-sqlite',
      secretsEncrypted: true,
    };
    db.exec(`CREATE TABLE encrypted_client_tokens (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ciphertext TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )`);
  }

  _row(row) {
    if (!row) return null;
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      token: row.secret_ciphertext,
      tokenHash: 'HASH_CANARY',
      fingerprint: 'FINGERPRINT_CANARY',
      sid: 'SID_CANARY',
      ownerSid: 'OWNER_SID_CANARY',
      refreshCredential: 'REFRESH_CANARY',
      credentials: 'CREDENTIALS_CANARY',
      keyId: 'KEY_ID_CANARY',
      nonce: 'NONCE_CANARY',
      tag: 'TAG_CANARY',
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
    };
  }

  listTokenMetadata(ownerUserId) {
    return this.db.prepare('SELECT * FROM encrypted_client_tokens WHERE owner_user_id = ? AND revoked_at IS NULL')
      .all(ownerUserId).map((row) => this._row(row));
  }

  readTokenMetadata(ownerUserId, id, { includeDeleted = false } = {}) {
    const row = this.db.prepare(`SELECT * FROM encrypted_client_tokens
      WHERE owner_user_id = ? AND id = ? AND (? = 1 OR revoked_at IS NULL)`).get(ownerUserId, id, includeDeleted ? 1 : 0);
    return this._row(row);
  }

  renameTokenMetadata(ownerUserId, id, name, { expectedRevision }) {
    const result = this.db.prepare(`UPDATE encrypted_client_tokens SET
      name = ?, revision = revision + 1, updated_at = updated_at + 1
      WHERE owner_user_id = ? AND id = ? AND revision = ? AND revoked_at IS NULL`)
      .run(name, ownerUserId, id, expectedRevision);
    if (!result.changes) throw new Error('token revision conflict');
    return this.readTokenMetadata(ownerUserId, id);
  }

  revokeTokenMetadata(ownerUserId, id, { expectedRevision }) {
    const result = this.db.prepare(`UPDATE encrypted_client_tokens SET
      revision = revision + 1, revoked_at = updated_at + 1, updated_at = updated_at + 1
      WHERE owner_user_id = ? AND id = ? AND revision = ? AND revoked_at IS NULL`)
      .run(ownerUserId, id, expectedRevision);
    return result.changes > 0;
  }
}

test('plaintext token managers fail closed and do not register a mobile adapter', () => {
  const context = fresh();
  try {
    const plaintextManager = {
      listTokens() { return [{ id: 'token-1', ownerId: 'owner-a', token: 'PLAINTEXT_CANARY' }]; },
    };
    const service = new ClientTokenMetadataService({ db: context.db, source: plaintextManager, changeBridge: context.bridge });
    assert.equal(service.available, false);
    assert.equal(createAclTokenMetadataAdapters({ clientTokenService: service }).has('clientToken'), false);
    assert.throws(() => service.list(context.users.get('owner-a')), (error) => (
      error.code === 'client_token_canonical_store_not_ready' && error.status === 503
    ));
  } finally {
    context.cleanup();
  }
});

test('encrypted canonical token metadata is owner-isolated and strips every credential field', () => {
  const context = fresh();
  try {
    const source = new EncryptedTokenSource(context.db);
    source.db.prepare(`INSERT INTO encrypted_client_tokens
      (id, owner_user_id, name, secret_ciphertext, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 100, 100)`).run('token-a', 'owner-a', 'Laptop', 'TOKEN_SECRET_CANARY');
    source.db.prepare(`INSERT INTO encrypted_client_tokens
      (id, owner_user_id, name, secret_ciphertext, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 100, 100)`).run('token-b', 'owner-b', 'Phone', 'OTHER_TOKEN_CANARY');
    const service = new ClientTokenMetadataService({ db: context.db, source, changeBridge: context.bridge });
    const adapter = createAclTokenMetadataAdapters({ clientTokenService: service }).get('clientToken');
    assert.ok(adapter);
    assert.deepEqual(adapter.list(context.users.get('owner-a')), [{
      id: 'token-a', ownerUserId: 'owner-a', name: 'Laptop', revision: 1,
      createdAt: 100, updatedAt: 100, lastUsedAt: null,
    }]);
    assert.equal(adapter.read(context.users.get('owner-b'), 'token-a'), null);

    const updateReceipt = {};
    const renamed = adapter.update(
      context.users.get('owner-a'),
      'token-a',
      { name: 'Work laptop' },
      { actorDeviceId: 'device-owner-a', mutationReceipt: updateReceipt },
    );
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.name, 'Work laptop');
    assert.throws(
      () => service.update(context.users.get('owner-a'), 'token-a', { token: 'LEAK' }),
      (error) => error.code === 'client_token_secret_forbidden',
    );
    const deleteReceipt = {};
    adapter.remove(context.users.get('owner-a'), 'token-a', {
      actorDeviceId: 'device-owner-a', mutationReceipt: deleteReceipt,
    });
    const serialized = JSON.stringify({
      metadata: renamed,
      changes: context.bridge.store.changePage('owner-a', 0, 20),
      outbox: context.bridge.pendingWakeEvents(),
    });
    for (const canary of [
      'TOKEN_SECRET_CANARY', 'OTHER_TOKEN_CANARY', 'HASH_CANARY', 'FINGERPRINT_CANARY',
      'SID_CANARY', 'OWNER_SID_CANARY', 'REFRESH_CANARY', 'CREDENTIALS_CANARY',
      'KEY_ID_CANARY', 'NONCE_CANARY', 'TAG_CANARY',
    ]) assert.ok(!serialized.includes(canary), `${canary} must never enter mobile metadata`);
    const changes = context.bridge.store.changePage('owner-a', 0, 20).changes;
    assert.deepEqual(changes.map((change) => [change.action, change.revision]), [
      ['upsert', 2], ['delete', 3],
    ]);
    assert.equal(updateReceipt.changeSeq, changes[0].changeSeq);
    assert.equal(deleteReceipt.changeSeq, changes[1].changeSeq);
    assert.deepEqual(changes.map((change) => change.actorDeviceId), [
      'device-owner-a', 'device-owner-a',
    ]);
    assert.equal(context.bridge.store.changePage('owner-b', 0, 20).changes.length, 0);
  } finally {
    context.cleanup();
  }
});

test('central entity composition registers only owner-safe ACL and Client Token adapters', () => {
  const context = fresh();
  try {
    context.authz.grant({
      resourceType: 'connection', resourceId: 'connection-a', subjectId: 'subject-a',
      capabilities: [CAP.DISCOVER, CAP.VIEW], grantedByUserId: 'owner-a',
    });
    const source = new EncryptedTokenSource(context.db);
    source.db.prepare(`INSERT INTO encrypted_client_tokens
      (id, owner_user_id, name, secret_ciphertext, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 100, 100)`).run(
        'token-a', 'owner-a', 'Laptop', 'CENTRAL_TOKEN_SECRET_CANARY',
      );
    const clientTokenService = new ClientTokenMetadataService({
      db: context.db, source, changeBridge: context.bridge,
    });
    const adapters = createEntityAdapters({
      resourceService: {},
      storage: {},
      entityRegistry: registry,
      resourceAclService: context.acl,
      clientTokenService,
    });

    assert.ok(adapters.has('resourceAcl'));
    assert.ok(adapters.has('clientToken'));
    assert.equal(adapters.get('resourceAcl').list(context.users.get('subject-a')).length, 0);
    const aclRows = adapters.get('resourceAcl').list(context.users.get('owner-a'));
    assert.equal(aclRows.length, 1);
    assert.ok(!JSON.stringify(aclRows).includes('connection-a'));

    const tokenRows = adapters.get('clientToken').list(context.users.get('owner-a'));
    assert.equal(tokenRows.length, 1);
    assert.equal(adapters.get('clientToken').list(context.users.get('owner-b')).length, 0);
    const tokenSpec = registry.entities.find((entity) => entity.type === 'clientToken');
    const projected = projectPayload(tokenSpec, tokenRows[0]);
    assert.deepEqual(Object.keys(projected).sort(), [
      'createdAt', 'id', 'lastUsedAt', 'name', 'ownerUserId', 'revision', 'updatedAt',
    ]);
    assert.ok(!JSON.stringify(projected).includes('CENTRAL_TOKEN_SECRET_CANARY'));
  } finally {
    context.cleanup();
  }
});
