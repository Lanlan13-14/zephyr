// Server-side mobile v1 store: schema, cursor and idempotency behaviour.
//
// The store is the only writer of mobile_sync_changes / mobile_applied_ops, so
// these assertions are what stop a push from being applied twice or a cursor
// from advancing past a change the device never received.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));

const registry = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'), 'utf8'),
);

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mv1-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  return { db, store, dir, cleanup: () => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Every table and index the frozen DDL names, so a rename fails here rather
// than at the first device bind on a production box.
const REQUIRED_TABLES = [
  'mobile_devices',
  'mobile_entity_versions',
  'mobile_entity_field_revisions',
  'mobile_sync_changes',
  'mobile_applied_ops',
  'mobile_sync_runs',
  'mobile_sensitive_grants',
];

const REQUIRED_INDEXES = [
  'idx_mobile_devices_owner',
  'idx_mobile_devices_token',
  'idx_mobile_field_revision_entity',
  'idx_mobile_changes_owner_seq',
  'idx_mobile_changes_entity',
  'idx_mobile_applied_ops_expiry',
  'idx_mobile_sync_runs_device',
  'idx_mobile_sensitive_grants_expiry',
];

test('the frozen DDL is created in full', () => {
  const ctx = freshStore();
  try {
    const names = ctx.db
      .prepare('SELECT name FROM sqlite_master WHERE type = ?')
      .all('table')
      .map((row) => row.name);
    for (const table of REQUIRED_TABLES) {
      assert.ok(names.includes(table), table + ' must exist');
    }

    const indexes = ctx.db
      .prepare('SELECT name FROM sqlite_master WHERE type = ?')
      .all('index')
      .map((row) => row.name);
    for (const index of REQUIRED_INDEXES) {
      assert.ok(indexes.includes(index), index + ' must exist');
    }
  } finally {
    ctx.cleanup();
  }
});

test('mobile_devices carries every column the bind flow writes', () => {
  const ctx = freshStore();
  try {
    const cols = ctx.db.prepare('PRAGMA table_info(mobile_devices)').all().map((c) => c.name);
    for (const col of [
      'device_id', 'owner_user_id', 'owner_username_compat', 'token_id', 'device_name',
      'platform', 'app_version', 'encryption_public_key', 'signing_public_jwk',
      'refresh_token_hash', 'refresh_generation', 'enabled', 'automatic_enabled',
      'sync_interval_sec', 'registry_hash', 'last_acked_cursor', 'last_sync_at',
      'last_seen_at', 'created_at', 'revoked_at', 'revoke_reason',
    ]) {
      assert.ok(cols.includes(col), 'mobile_devices.' + col + ' is required by DATA_AND_MIGRATION.md 2');
    }
  } finally {
    ctx.cleanup();
  }
});

test('construction is idempotent and the registry hash is stable', () => {
  const ctx = freshStore();
  try {
    const first = ctx.store.registryHash;
    // Re-running must not throw: the core restarts far more often than it migrates.
    const second = new MobileV1Store({ db: ctx.db, entityRegistry: registry }).registryHash;
    assert.equal(second, first);
    assert.match(first, /^[0-9a-f]{64}$/, 'registryHash must be a sha256 hex digest');
  } finally {
    ctx.cleanup();
  }
});

test('the registry hash changes when the registry changes', () => {
  const ctx = freshStore();
  try {
    const mutated = JSON.parse(JSON.stringify(registry));
    mutated.entities[0].editableFields.push('somethingNew');
    const other = new MobileV1Store({ db: ctx.db, entityRegistry: mutated }).registryHash;
    assert.notEqual(other, ctx.store.registryHash, 'a registry edit must move the hash or clients cannot detect drift');
  } finally {
    ctx.cleanup();
  }
});

test('recording a change allocates a monotonic cursor', () => {
  const ctx = freshStore();
  try {
    const a = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      action: 'upsert', revision: 1, fieldMask: ['name'], actorDeviceId: 'd1',
    });
    const b = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c2',
      action: 'upsert', revision: 1, fieldMask: ['name'], actorDeviceId: 'd1',
    });
    assert.ok(b > a, 'change_seq must increase');
    assert.equal(ctx.store.latestCursor('u1'), b);
  } finally {
    ctx.cleanup();
  }
});

test('cursors are per owner, so one account cannot read another feed', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    ctx.store.appendChange({
      ownerUserId: 'u2', entityType: 'connection', entityId: 'c9',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });

    const page = ctx.store.changePage('u1', 0, 50);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].entityId, 'c1');
    for (const change of page.changes) {
      assert.notEqual(change.entityId, 'c9', 'another owner change must never appear in this feed');
    }
  } finally {
    ctx.cleanup();
  }
});

test('a replayed opId returns the stored result and writes nothing new', () => {
  const ctx = freshStore();
  try {
    const result = { opId: 'op-1', status: 'accepted', entityId: 'c1', revision: 2, changeSeq: 7 };
    ctx.store.recordAppliedOp({ ownerUserId: 'u1', deviceId: 'd1', opId: 'op-1', batchId: 'b1', result });

    const replayed = ctx.store.findAppliedOp('u1', 'd1', 'op-1');
    assert.deepEqual(replayed, result, 'a replay must return the identical logical result');

    // A second record of the same opId must not overwrite the stored result:
    // that is what makes 100 replays return one revision instead of many.
    ctx.store.recordAppliedOp({
      ownerUserId: 'u1', deviceId: 'd1', opId: 'op-1', batchId: 'b2',
      result: { opId: 'op-1', status: 'accepted', revision: 999 },
    });
    assert.deepEqual(ctx.store.findAppliedOp('u1', 'd1', 'op-1'), result, 'replay must be write-once');

    // Same opId from a different device is a different operation.
    assert.equal(ctx.store.findAppliedOp('u1', 'd2', 'op-1'), null);
    // And from a different owner.
    assert.equal(ctx.store.findAppliedOp('u2', 'd1', 'op-1'), null);
  } finally {
    ctx.cleanup();
  }
});

test('field revisions decide overlap, which is what makes a conflict detectable', () => {
  const ctx = freshStore();
  try {
    ctx.store.setFieldRevisions({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      fields: ['name', 'host'], revision: 8,
    });

    const map = ctx.store.fieldRevisions('u1', 'connection', 'c1');
    assert.equal(map.get('name'), 8);
    assert.equal(map.get('host'), 8);

    // baseRevision 7 with server field revision 8 on the same field is an overlap.
    assert.equal(ctx.store.hasOverlap('u1', 'connection', 'c1', 7, ['name']), true);
    // A disjoint field at the same base revision is not: this is the false
    // conflict that whole-entity revision comparison would produce.
    assert.equal(ctx.store.hasOverlap('u1', 'connection', 'c1', 7, ['remark']), false);
    // Same base as the recorded revision is not an overlap either.
    assert.equal(ctx.store.hasOverlap('u1', 'connection', 'c1', 8, ['name']), false);
  } finally {
    ctx.cleanup();
  }
});

test('a tombstone is retained without the entity payload', () => {
  const ctx = freshStore();
  try {
    const seq = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      action: 'delete', revision: 3,
      tombstone: { entityType: 'connection', entityId: 'c1', deletedRevision: 3, lastKnownName: 'Office' },
    });
    const page = ctx.store.changePage('u1', seq - 1, 10);
    const change = page.changes.find((c) => c.changeSeq === seq);
    assert.equal(change.action, 'delete');
    assert.equal(change.tombstone.lastKnownName, 'Office');
    assert.equal(change.payload, undefined, 'a delete carries no payload');
    assert.equal(change.fieldMask, undefined, 'a delete carries no fieldMask');
  } finally {
    ctx.cleanup();
  }
});

test('an upsert change always carries a fieldMask', () => {
  const ctx = freshStore();
  try {
    const seq = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      action: 'upsert', revision: 2, fieldMask: ['name', 'host'],
    });
    const page = ctx.store.changePage('u1', 0, 10);
    const change = page.changes.find((c) => c.changeSeq === seq);
    assert.deepEqual(change.fieldMask, ['name', 'host']);
    assert.equal(change.tombstone, undefined, 'an upsert carries no tombstone');
  } finally {
    ctx.cleanup();
  }
});

test('change pages report hasMore and advance the cursor monotonically', () => {
  const ctx = freshStore();
  try {
    const seqs = [];
    for (let i = 0; i < 5; i += 1) {
      seqs.push(ctx.store.appendChange({
        ownerUserId: 'u1', entityType: 'connection', entityId: 'c' + i,
        action: 'upsert', revision: 1, fieldMask: ['name'],
      }));
    }
    // change_seq is a global AUTOINCREMENT, so assert monotonicity rather than
    // exact values: another owner's writes legitimately consume sequence numbers.
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1]);

    const first = ctx.store.changePage('u1', 0, 2);
    assert.equal(first.changes.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, seqs[1]);

    const second = ctx.store.changePage('u1', first.nextCursor, 2);
    assert.equal(second.fromCursor, seqs[1]);
    assert.equal(second.changes[0].changeSeq, seqs[2]);

    const last = ctx.store.changePage('u1', seqs[2], 10);
    assert.equal(last.hasMore, false, 'the final page must not claim more');
    assert.equal(last.nextCursor, seqs[4]);

    // An exhausted cursor returns an empty page that does not rewind.
    const empty = ctx.store.changePage('u1', seqs[4], 10);
    assert.equal(empty.changes.length, 0);
    assert.equal(empty.nextCursor, seqs[4]);
  } finally {
    ctx.cleanup();
  }
});

test('the change feed is partitioned by owner', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'mine',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    ctx.store.appendChange({
      ownerUserId: 'u2', entityType: 'connection', entityId: 'theirs',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });

    const mine = ctx.store.changePage('u1', 0, 50);
    assert.deepEqual(mine.changes.map((c) => c.entityId), ['mine']);
    const theirs = ctx.store.changePage('u2', 0, 50);
    assert.deepEqual(theirs.changes.map((c) => c.entityId), ['theirs']);
  } finally {
    ctx.cleanup();
  }
});

test('a cursor older than the oldest retained change is reported expired', () => {
  const ctx = freshStore();
  try {
    const first = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const second = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c2',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const third = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c3',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });

    // Nothing collected yet: every cursor from 0 upwards is still servable.
    assert.equal(ctx.store.isCursorExpired('u1', 0), false);
    assert.equal(ctx.store.isCursorExpired('u1', first), false);

    /* Retention GC removes the first two. A device parked at `first` has still
     * seen everything up to `first`, and `third` is the next change it needs,
     * so there is no gap for it and it must NOT be forced to bootstrap. */
    assert.equal(ctx.store.pruneChangesBefore('u1', third), 2);
    assert.equal(ctx.store.oldestCursor('u1'), third);
    assert.equal(
      ctx.store.isCursorExpired('u1', second),
      false,
      'a device holding the change right before the oldest survivor has no gap',
    );

    /* A device parked at cursor 0, however, missed `first` and `second`, and
     * those rows no longer exist. Serving it from `third` would silently skip
     * two changes, so it must be told to bootstrap again. */
    assert.equal(
      ctx.store.isCursorExpired('u1', 0),
      true,
      'a device that slept through GC must be told to bootstrap',
    );
    assert.equal(ctx.store.isCursorExpired('u1', first), true);

    // An empty feed cannot expire anyone: there is nothing to have missed.
    assert.equal(ctx.store.pruneChangesBefore('u1', third + 1), 1);
    assert.equal(ctx.store.isCursorExpired('u1', 0), false);
  } finally {
    ctx.cleanup();
  }
});

test('sensitive grants are single-use and bound to their exact target list', () => {
  const ctx = freshStore();
  try {
    const created = ctx.store.createGrant({
      ownerUserId: 'u1', action: 'device.revoke', targetIds: ['d2'], requestId: 'req-1',
    });
    assert.ok(created.grant, 'a grant token must be returned');
    assert.ok(created.expiresAt > Date.now(), 'a grant must expire in the future');

    // Wrong target list must not be accepted even with the right token.
    assert.throws(
      () => ctx.store.consumeGrant({
        ownerUserId: 'u1', action: 'device.revoke', targetIds: ['d3'], grant: created.grant,
      }),
      (err) => err.code === 'sensitive_verification_required',
      'a grant is bound to its exact target list, so another list needs fresh verification',
    );

    // Correct action + targets consumes it exactly once.
    assert.equal(
      ctx.store.consumeGrant({
        ownerUserId: 'u1', action: 'device.revoke', targetIds: ['d2'], grant: created.grant,
      }),
      true,
    );
    assert.throws(
      () => ctx.store.consumeGrant({
        ownerUserId: 'u1', action: 'device.revoke', targetIds: ['d2'], grant: created.grant,
      }),
      (err) => err.code === 'sensitive_grant_consumed',
      'replaying a consumed grant must be reported as a replay, not as a fresh failure',
    );
  } finally {
    ctx.cleanup();
  }
});
