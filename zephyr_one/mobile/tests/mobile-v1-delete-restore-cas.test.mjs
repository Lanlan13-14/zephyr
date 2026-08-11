import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));

const entityRegistry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

const owner = { userId: 'cas-owner', username: 'cas-user' };
const entityId = 'cas-secret-entity';
const secretCanary = 'DELETE_RESTORE_SECRET_CANARY_9e2d5c';
const spec = {
  type: 'connection',
  ownerField: 'ownerUserId',
  editableFields: ['name'],
  opaquePreserveFields: [],
  secretFields: ['password'],
  serverAuthorityFields: ['ownerUserId', 'revision'],
  deviceLocalFields: [],
};

function createHarness({ revision = 3, deleted = false, missing = false } = {}) {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry });
  db.exec(`CREATE TABLE cas_entities (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    deleted_at INTEGER
  )`);
  if (!missing) {
    db.prepare(`INSERT INTO cas_entities
      (id, owner_user_id, revision, name, password, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      entityId,
      owner.userId,
      revision,
      'Canonical secret entity',
      secretCanary,
      deleted ? 100 : null,
    );
    store.setEntityVersion({
      ownerUserId: owner.userId,
      entityType: spec.type,
      entityId,
      revision,
      deletedAt: deleted ? 100 : null,
    });
    store.setFieldRevisions({
      ownerUserId: owner.userId,
      entityType: spec.type,
      entityId,
      fields: ['name', 'password'],
      revision,
    });
  }

  const select = (includeDeleted = false) => db.prepare(`SELECT
    id, owner_user_id AS ownerUserId, revision, name, password,
    deleted_at AS deletedAt
    FROM cas_entities WHERE id = ? AND owner_user_id = ?
      ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(entityId, owner.userId) || null;
  const adapter = {
    residency: () => (select(true) ? 'owned' : 'missing'),
    read: () => select(false),
    revisionOf: (row) => Number(row.revision),
    remove: () => {
      const changed = db.prepare(`UPDATE cas_entities
        SET revision = revision + 1, deleted_at = 200
        WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`)
        .run(entityId, owner.userId).changes;
      if (changed !== 1) throw new Error('canonical delete lost its compare-and-set');
      return true;
    },
    restore: () => {
      const changed = db.prepare(`UPDATE cas_entities
        SET revision = revision + 1, deleted_at = NULL
        WHERE id = ? AND owner_user_id = ? AND deleted_at IS NOT NULL`)
        .run(entityId, owner.userId).changes;
      if (changed !== 1) throw new Error('canonical restore lost its compare-and-set');
      return select(false);
    },
  };
  const api = Object.create(MobileV1Api.prototype);
  api.entityByType = new Map([[spec.type, spec]]);
  api.adapters = new Map([[spec.type, adapter]]);
  api.store = store;
  api.db = db;

  const apply = (operation, deviceId = 'cas-device-1') => db.transaction(() => api.applyOperation({
    ownerUserId: owner.userId,
    user: owner,
    deviceId,
    deviceRow: { device_id: deviceId, owner_user_id: owner.userId },
    batchId: 'cas-batch',
    operation: {
      entityType: spec.type,
      entityId,
      fieldMask: [],
      payload: {},
      ...operation,
    },
  }))();

  const counts = () => ({
    changes: Number(db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count),
    outbox: Number(db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count),
    receipts: Number(db.prepare('SELECT COUNT(*) AS count FROM mobile_applied_ops').get().count),
  });
  return { api, db, store, apply, counts, select, close: () => db.close() };
}

function assertSafeConflict(result, revision, expectedPayload) {
  assert.equal(result.status, 'conflict');
  assert.equal(result.revision, revision);
  assert.equal(result.conflict.reason, 'field_overlap');
  assert.equal(result.conflict.currentRevision, revision);
  assert.deepEqual(result.conflict.fields, []);
  assert.deepEqual(result.conflict.serverPayload, expectedPayload);
  assert.equal(JSON.stringify(result).includes(secretCanary), false);
}

test('delete rejects future revisions, conflicts when stale, and accepts only the exact live revision', () => {
  const harness = createHarness({ revision: 3 });
  try {
    const staleOperation = { opId: 'delete-stale', action: 'delete', baseRevision: 2 };
    const stale = harness.apply(staleOperation);
    assertSafeConflict(stale, 3, {
      ownerUserId: owner.userId,
      name: 'Canonical secret entity',
    });
    assert.deepEqual(stale.conflict.serverChangedFields, ['name', 'password']);
    assert.equal(harness.select().revision, 3);
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 1 });

    assert.deepEqual(harness.apply(staleOperation), stale,
      'a stale conflict replay must return its durable logical result');
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 1 });

    assert.throws(
      () => harness.apply({ opId: 'delete-future', action: 'delete', baseRevision: 4 }),
      (error) => error.code === 'revision_conflict'
        && error.details.baseRevision === 4
        && error.details.currentRevision === 3,
    );
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 1 });

    const accepted = harness.apply({ opId: 'delete-equal', action: 'delete', baseRevision: 3 });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.revision, 4);
    assert.ok(accepted.changeSeq > 0);
    assert.equal(harness.select(), null);
    assert.deepEqual(harness.counts(), { changes: 1, outbox: 1, receipts: 2 });

    const replay = harness.apply({ opId: 'delete-equal', action: 'delete', baseRevision: 99 });
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.revision, accepted.revision);
    assert.equal(replay.changeSeq, accepted.changeSeq);
    assert.deepEqual(harness.counts(), { changes: 1, outbox: 1, receipts: 2 });
  } finally {
    harness.close();
  }
});

test('restore compares against the tombstone revision and preserves its receipt on replay', () => {
  const harness = createHarness({ revision: 4, deleted: true });
  try {
    const staleOperation = { opId: 'restore-stale', action: 'restore', baseRevision: 3 };
    const stale = harness.apply(staleOperation);
    assertSafeConflict(stale, 4, { ownerUserId: owner.userId });
    assert.equal(Object.hasOwn(stale.conflict.serverPayload, 'name'), false,
      'a tombstone conflict must not retain editable canonical values');
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 1 });

    assert.throws(
      () => harness.apply({ opId: 'restore-future', action: 'restore', baseRevision: 5 }),
      (error) => error.code === 'revision_conflict'
        && error.details.baseRevision === 5
        && error.details.currentRevision === 4,
    );
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 1 });

    const accepted = harness.apply({ opId: 'restore-equal', action: 'restore', baseRevision: 4 });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.revision, 5);
    assert.ok(accepted.changeSeq > 0);
    assert.equal(harness.select().revision, 5);
    assert.deepEqual(harness.counts(), { changes: 1, outbox: 1, receipts: 2 });

    const replay = harness.apply({ opId: 'restore-equal', action: 'restore', baseRevision: 0 });
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.revision, accepted.revision);
    assert.equal(replay.changeSeq, accepted.changeSeq);
    assert.deepEqual(harness.apply(staleOperation), stale);
    assert.deepEqual(harness.counts(), { changes: 1, outbox: 1, receipts: 2 });
  } finally {
    harness.close();
  }
});

test('two equal-base deletes have one winner and one secret-safe tombstone conflict', () => {
  const harness = createHarness({ revision: 6 });
  try {
    const winner = harness.apply({ opId: 'delete-winner', action: 'delete', baseRevision: 6 }, 'cas-device-1');
    const loser = harness.apply({ opId: 'delete-loser', action: 'delete', baseRevision: 6 }, 'cas-device-2');

    assert.equal(winner.status, 'accepted');
    assert.equal(winner.revision, 7);
    assertSafeConflict(loser, 7, { ownerUserId: owner.userId });
    assert.deepEqual(harness.counts(), { changes: 1, outbox: 1, receipts: 2 });
    assert.equal(harness.store.getEntityVersion(owner.userId, spec.type, entityId).revision, 7);
  } finally {
    harness.close();
  }
});

test('missing delete keeps the existing duplicate/no-event contract', () => {
  const harness = createHarness({ missing: true });
  try {
    const result = harness.apply({ opId: 'delete-missing', action: 'delete', baseRevision: 0 });
    assert.deepEqual(result, {
      opId: 'delete-missing', status: 'duplicate', entityId, revision: 0,
    });
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 1 });
  } finally {
    harness.close();
  }
});

test('receipt failure rolls canonical mutation, version, change, and outbox back together', () => {
  const harness = createHarness({ revision: 8 });
  try {
    harness.store.recordAppliedOp = () => { throw new Error('injected receipt failure'); };
    assert.throws(
      () => harness.apply({ opId: 'delete-rollback', action: 'delete', baseRevision: 8 }),
      /injected receipt failure/,
    );

    const canonical = harness.select();
    assert.equal(canonical.revision, 8);
    assert.equal(canonical.deletedAt, null);
    const version = harness.store.getEntityVersion(owner.userId, spec.type, entityId);
    assert.equal(version.revision, 8);
    assert.equal(version.deleted_at, null);
    assert.deepEqual(harness.counts(), { changes: 0, outbox: 0, receipts: 0 });
  } finally {
    harness.close();
  }
});
