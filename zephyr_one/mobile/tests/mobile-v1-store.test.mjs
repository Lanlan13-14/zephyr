// Server-side mobile v1 store: schema, cursor and idempotency behaviour.
//
// The store is the only writer of mobile_sync_changes / mobile_applied_ops, so
// these assertions are what stop a push from being applied twice or a cursor
// from advancing past a change the device never received.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  return { db, store, cleanup: () => { try { db.close(); } catch {} } };
}

// Every table and index the frozen DDL names, so a rename fails here rather
// than at the first device bind on a production box.
const REQUIRED_TABLES = [
  'mobile_devices',
  'mobile_device_proof_challenges',
  'mobile_device_bind_attempts',
  'mobile_entity_versions',
  'mobile_entity_field_revisions',
  'mobile_sync_changes',
  'mobile_applied_ops',
  'mobile_sync_runs',
  'mobile_sensitive_grants',
  'mobile_sensitive_attempts',
];

const REQUIRED_INDEXES = [
  'idx_mobile_devices_owner',
  'idx_mobile_devices_token',
  'idx_mobile_proof_challenges_device',
  'idx_mobile_proof_challenges_expiry',
  'idx_mobile_bind_attempts_owner_device',
  'idx_mobile_bind_attempts_expiry',
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
      'sync_interval_sec', 'binding_revision', 'registry_hash', 'last_acked_cursor', 'last_sync_at',
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

test('proof challenges are high-entropy, request-bound and single-use', () => {
  const ctx = freshStore();
  try {
    const binding = {
      ownerUserId: 'u1', deviceId: 'd1', method: 'POST',
      canonicalPath: '/api/mobile/v1/sync/push', bodySha256: 'A'.repeat(43) + '=',
      usage: 'sync.push',
    };
    const first = ctx.store.issueProofChallenge(binding);
    const second = ctx.store.issueProofChallenge(binding);
    assert.match(first.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.nonce, second.nonce);
    assert.equal(first.timestamp, Math.floor(first.timestamp));
    assert.ok(first.expiresAt > Date.now());

    const attempt = { ...binding, nonce: first.nonce, timestamp: first.timestamp };
    assert.equal(ctx.store.consumeProofChallenge({ ...attempt, deviceId: 'd2' }), false,
      'a challenge must not cross devices');
    assert.equal(ctx.store.consumeProofChallenge({ ...attempt, canonicalPath: '/api/mobile/v1/sync/ack' }), false,
      'a challenge must not cross routes');
    assert.equal(ctx.store.consumeProofChallenge({ ...attempt, bodySha256: 'B'.repeat(43) + '=' }), false,
      'a challenge must not cross bodies');
    assert.equal(ctx.store.consumeProofChallenge(attempt), true);
    assert.equal(ctx.store.consumeProofChallenge(attempt), false, 'a spent challenge must reject replay');
  } finally {
    ctx.cleanup();
  }
});

test('independent proof challenges can be consumed concurrently exactly once each', async () => {
  const ctx = freshStore();
  try {
    const binding = {
      ownerUserId: 'u1', deviceId: 'd1', method: 'GET',
      canonicalPath: '/api/mobile/v1/sync/status',
      bodySha256: 'A'.repeat(43) + '=', usage: 'sync.status',
    };
    const challenges = Array.from({ length: 8 }, () => ctx.store.issueProofChallenge(binding));
    const consumed = await Promise.all(challenges.map((challenge) => Promise.resolve().then(() =>
      ctx.store.consumeProofChallenge({
        ...binding, nonce: challenge.nonce, timestamp: challenge.timestamp,
      }))));
    assert.deepEqual(consumed, Array(8).fill(true));

    const replayRace = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() =>
      ctx.store.consumeProofChallenge({
        ...binding, nonce: challenges[0].nonce, timestamp: challenges[0].timestamp,
      }))));
    assert.deepEqual(replayRace, Array(8).fill(false));
  } finally {
    ctx.cleanup();
  }
});

test('expired proof challenges fail and issuance is bounded per device', () => {
  const ctx = freshStore();
  try {
    const binding = {
      ownerUserId: 'u1', deviceId: 'd1', method: 'GET',
      canonicalPath: '/api/mobile/v1/sync/status',
      bodySha256: 'A'.repeat(43) + '=', usage: 'sync.status',
    };
    const expired = ctx.store.issueProofChallenge(binding);
    ctx.db.prepare('UPDATE mobile_device_proof_challenges SET expires_at = 0 WHERE nonce_hash IS NOT NULL').run();
    assert.equal(ctx.store.consumeProofChallenge({
      ...binding, nonce: expired.nonce, timestamp: expired.timestamp,
    }), false);

    for (let i = 0; i < 16; i += 1) ctx.store.issueProofChallenge(binding);
    assert.throws(() => ctx.store.issueProofChallenge(binding), (err) =>
      err.code === 'rate_limited' && err.status === 429);
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

    ctx.store.setFieldRevisions({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      fields: ['name'], revision: 9, changedAt: 1_700_000_000_100,
    });
    const times = ctx.store.fieldWriteTimes('u1', 'connection', 'c1');
    assert.equal(times.get('name'), 1_700_000_000_100);
    assert.ok((times.get('host') || 0) > 0, 'an omitted changedAt still stamps wall-clock time');
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

test('cursor expiry tracks only owner rows actually removed by retention', () => {
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

    // Removing the last survivor must retain the owner's GC watermark. A fresh
    // bootstrap uses latestCursor and therefore starts at a servable cursor.
    assert.equal(ctx.store.pruneChangesBefore('u1', third + 1), 1);
    assert.equal(ctx.store.oldestCursor('u1'), 0);
    assert.equal(ctx.store.latestCursor('u1'), third);
    assert.equal(ctx.store.isCursorExpired('u1', 0), true);
    assert.equal(ctx.store.isCursorExpired('u1', third), false);

    const reopened = new MobileV1Store({ db: ctx.db, entityRegistry: registry });
    assert.equal(reopened.latestCursor('u1'), third,
      'retention state must survive a server restart');
    assert.equal(reopened.isCursorExpired('u1', third), false);
  } finally {
    ctx.cleanup();
  }
});

test('actor enrichment never coalesces the same entity revision across owners', () => {
  const ctx = freshStore();
  try {
    const foreignSeq = ctx.store.appendChange({
      ownerUserId: 'u1',
      entityType: 'oneUserSettings',
      entityId: 'appearance',
      action: 'upsert',
      revision: 1,
      fieldMask: ['appearance.theme'],
      actorDeviceId: null,
    });
    const foreignChangeBefore = ctx.db.prepare(`SELECT * FROM mobile_sync_changes
      WHERE owner_user_id = ? AND change_seq = ?`).get('u1', foreignSeq);
    const foreignOutboxBefore = ctx.db.prepare(`SELECT * FROM mobile_change_outbox
      WHERE owner_user_id = ? AND change_seq = ?`).get('u1', foreignSeq);

    const ownSeq = ctx.store.appendChange({
      ownerUserId: 'u2',
      entityType: 'oneUserSettings',
      entityId: 'appearance',
      action: 'upsert',
      revision: 1,
      fieldMask: ['appearance.customColors'],
      actorDeviceId: 'u2-device',
    });

    assert.notEqual(ownSeq, foreignSeq);
    assert.deepEqual(
      ctx.db.prepare(`SELECT * FROM mobile_sync_changes
        WHERE owner_user_id = ? AND change_seq = ?`).get('u1', foreignSeq),
      foreignChangeBefore,
      'the foreign change row must not be enriched or rewritten',
    );
    assert.deepEqual(
      ctx.db.prepare(`SELECT * FROM mobile_change_outbox
        WHERE owner_user_id = ? AND change_seq = ?`).get('u1', foreignSeq),
      foreignOutboxBefore,
      'the foreign wake outbox row must not be replaced or redelivered',
    );
    assert.deepEqual(ctx.store.changePage('u1', 0, 20).changes.map((change) => ({
      actorDeviceId: change.actorDeviceId,
      fieldMask: change.fieldMask,
    })), [{ actorDeviceId: null, fieldMask: ['appearance.theme'] }]);
    assert.deepEqual(ctx.store.changePage('u2', 0, 20).changes.map((change) => ({
      actorDeviceId: change.actorDeviceId,
      fieldMask: change.fieldMask,
    })), [{ actorDeviceId: 'u2-device', fieldMask: ['appearance.customColors'] }]);
    assert.deepEqual(ctx.store.wakeOutboxPage(20).map((event) => [
      event.ownerUserId,
      event.throughCursor,
    ]), [
      ['u1', foreignSeq],
      ['u2', ownSeq],
    ]);
  } finally {
    ctx.cleanup();
  }
});

test('foreign cursor gaps do not expire a new or empty owner feed', () => {
  const ctx = freshStore();
  try {
    const foreignFirst = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'foreign-1',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const foreignSecond = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'foreign-2',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });

    assert.ok(foreignSecond > foreignFirst);
    assert.equal(ctx.store.latestCursor('empty-owner'), 0);
    assert.equal(ctx.store.oldestCursor('empty-owner'), 0);
    assert.equal(ctx.store.isCursorExpired('empty-owner', 0), false);
    assert.deepEqual(ctx.store.changePage('empty-owner', 0, 50), {
      fromCursor: 0,
      nextCursor: 0,
      hasMore: false,
      changes: [],
    });

    // A prune request that only spans foreign rows must not manufacture owner
    // retention history or reveal that those rows exist.
    assert.equal(ctx.store.pruneChangesBefore('empty-owner', foreignSecond + 1), 0);
    assert.equal(ctx.store.prunedThroughCursor('empty-owner'), 0);
    assert.equal(ctx.store.isCursorExpired('empty-owner', 0), false);
  } finally {
    ctx.cleanup();
  }
});

test('retention expiry is exact across interleaved owner sequence gaps', () => {
  const ctx = freshStore();
  try {
    const first = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'mine-1',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const foreign = ctx.store.appendChange({
      ownerUserId: 'u2', entityType: 'connection', entityId: 'theirs',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const survivor = ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'mine-2',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });

    assert.ok(first < foreign && foreign < survivor);
    assert.equal(ctx.store.isCursorExpired('u1', 0), false,
      'a high first sequence is not evidence of retention loss');
    assert.equal(ctx.store.pruneChangesBefore('u1', survivor), 1);
    assert.equal(ctx.store.prunedThroughCursor('u1'), first);
    assert.equal(ctx.store.isCursorExpired('u1', 0), true);
    assert.equal(ctx.store.isCursorExpired('u1', first), false,
      'the foreign gap before the survivor does not belong to u1');
    assert.equal(ctx.store.isCursorExpired('u1', foreign), false);
    assert.deepEqual(
      ctx.store.changePage('u1', first, 50).changes.map((change) => change.entityId),
      ['mine-2'],
    );
    assert.deepEqual(
      ctx.store.changePage('u2', 0, 50).changes.map((change) => change.entityId),
      ['theirs'],
    );

    // The boundary is exclusive and a no-op prune cannot advance the owner
    // watermark beyond a row that was actually deleted.
    assert.equal(ctx.store.pruneChangesBefore('u1', survivor), 0);
    assert.equal(ctx.store.prunedThroughCursor('u1'), first);
    assert.equal(ctx.store.pruneChangesBefore('u1', survivor + 1), 1);
    assert.equal(ctx.store.prunedThroughCursor('u1'), survivor);
    assert.equal(ctx.store.isCursorExpired('u1', survivor - 1), true);
    assert.equal(ctx.store.isCursorExpired('u1', survivor), false);

    assert.equal(ctx.store.prunedThroughCursor('u2'), 0);
    assert.equal(ctx.store.isCursorExpired('u2', 0), false);
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

test('sensitive verification attempts are durably rate limited per account', () => {
  const ctx = freshStore();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = ctx.store.takeSensitiveVerificationAttempt('u1', 1_000_000);
      assert.equal(result.remaining, 9 - attempt);
    }
    assert.throws(
      () => ctx.store.takeSensitiveVerificationAttempt('u1', 1_000_001),
      (err) => err.code === 'rate_limited' && err.status === 429 && err.retryable === true,
    );
    assert.equal(ctx.store.takeSensitiveVerificationAttempt('u2', 1_000_001).remaining, 9,
      'one account must not spend another account\'s verification budget');
    assert.equal(ctx.store.takeSensitiveVerificationAttempt('u1', 1_300_000).remaining, 9,
      'the next fixed window must restore the account budget');
  } finally {
    ctx.cleanup();
  }
});

test('only one concurrent grant consumer can perform the transition', async () => {
  const ctx = freshStore();
  try {
    const created = ctx.store.createGrant({
      ownerUserId: 'u1', action: 'token.reveal', targetIds: ['tok-1'], requestId: 'req-race',
    });
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() =>
      ctx.store.consumeGrant({
        ownerUserId: 'u1', action: 'token.reveal', targetIds: ['tok-1'], grant: created.grant,
      }))));
    assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((entry) => entry.status === 'rejected'
      && entry.reason?.code === 'sensitive_grant_consumed').length, 7);
  } finally {
    ctx.cleanup();
  }
});
