import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const {
  MobileV1Store,
  CHANGE_RETENTION_DAYS,
} = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));

const registry = { entities: [] };
const DAY = 86400000;
const OWNER = 'owner-retention';

function freshStore() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  return { db, store, cleanup: () => { try { db.close(); } catch {} } };
}

function countChanges(store, owner) {
  return Number(store.db.prepare(
    'SELECT COUNT(*) AS n FROM mobile_sync_changes WHERE owner_user_id = ?',
  ).get(owner).n);
}

test('CHANGE_RETENTION_DAYS is 180 and is exported on the store class', () => {
  assert.equal(CHANGE_RETENTION_DAYS, 180);
  assert.equal(MobileV1Store.CHANGE_RETENTION_DAYS, 180);
});

test('181-day-old change is pruned, yesterday is kept, lagged cursor expires', () => {
  const ctx = freshStore();
  try {
    const now = Date.now();
    const oldSeq = ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'connection', entityId: 'c-old',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const newSeq = ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'connection', entityId: 'c-new',
      action: 'upsert', revision: 1, fieldMask: ['host'],
    });
    ctx.db.prepare('UPDATE mobile_sync_changes SET changed_at = ? WHERE change_seq = ?')
      .run(now - 181 * DAY, oldSeq);
    ctx.db.prepare('UPDATE mobile_sync_changes SET changed_at = ? WHERE change_seq = ?')
      .run(now - 1 * DAY, newSeq);

    const pruned = ctx.store.pruneChangesOlderThan(OWNER, now - CHANGE_RETENTION_DAYS * DAY);
    assert.equal(pruned, 1);
    const leftover = ctx.db.prepare(
      'SELECT change_seq, entity_id FROM mobile_sync_changes WHERE owner_user_id = ?',
    ).all(OWNER);
    assert.deepEqual(leftover.map((row) => row.entity_id), ['c-new']);
    assert.equal(leftover[0].change_seq, newSeq);
    assert.equal(ctx.store.prunedThroughCursor(OWNER), oldSeq);
    assert.equal(ctx.store.isCursorExpired(OWNER, 0), true);
    assert.equal(ctx.store.isCursorExpired(OWNER, oldSeq - 1), true);
    assert.equal(ctx.store.isCursorExpired(OWNER, oldSeq), false);
    assert.equal(ctx.store.isCursorExpired(OWNER, newSeq), false);

    const api = Object.create(MobileV1Api.prototype);
    api.store = ctx.store;
    api.hydrateChange = (user, change) => change;
    const auth = { user: { userId: OWNER }, device: { device_id: 'd1' } };
    assert.throws(
      () => api.executeChangesForDevice(auth, { sinceCursor: 0, limit: 10 }),
      (err) => err.code === 'cursor_expired' && err.status === 410,
    );
    const page = api.executeChangesForDevice(auth, { sinceCursor: oldSeq, limit: 10 });
    assert.equal(page.ok, true);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].entityId, 'c-new');
  } finally {
    ctx.cleanup();
  }
});

test('pruneChangesOlderThan is a no-op when nothing is past retention', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'note', entityId: 'n1',
      action: 'upsert', revision: 1, fieldMask: ['title'],
    });
    assert.equal(ctx.store.pruneChangesOlderThan(OWNER), 0);
    assert.equal(countChanges(ctx.store, OWNER), 1);
    assert.equal(ctx.store.prunedThroughCursor(OWNER), 0);
    assert.equal(ctx.store.isCursorExpired(OWNER, 0), false);
  } finally {
    ctx.cleanup();
  }
});

test('gcDeliveredWakeOutbox deletes only delivered rows old enough', () => {
  const ctx = freshStore();
  try {
    const now = Date.now();
    const deliveredSeq = ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'connection', entityId: 'c-delivered',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const pendingSeq = ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'connection', entityId: 'c-pending',
      action: 'upsert', revision: 1, fieldMask: ['host'],
    });
    const delivered = ctx.db.prepare(
      'SELECT outbox_id FROM mobile_change_outbox WHERE change_seq = ?',
    ).get(deliveredSeq);
    const pending = ctx.db.prepare(
      'SELECT outbox_id FROM mobile_change_outbox WHERE change_seq = ?',
    ).get(pendingSeq);
    ctx.db.prepare('UPDATE mobile_change_outbox SET delivered_at = ? WHERE outbox_id = ?')
      .run(now - 8 * DAY, delivered.outbox_id);

    const dropped = ctx.store.gcDeliveredWakeOutbox({ olderThanMs: 7 * DAY, now });
    assert.equal(dropped, 1);
    const remaining = ctx.db.prepare(
      'SELECT outbox_id, change_seq, delivered_at FROM mobile_change_outbox ORDER BY outbox_id',
    ).all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].outbox_id, pending.outbox_id);
    assert.equal(remaining[0].change_seq, pendingSeq);
    assert.equal(remaining[0].delivered_at, null);
  } finally {
    ctx.cleanup();
  }
});

test('gcDeliveredWakeOutbox never deletes undelivered rows even when ancient', () => {
  const ctx = freshStore();
  try {
    const now = Date.now();
    const seq = ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'note', entityId: 'n-stale',
      action: 'upsert', revision: 1, fieldMask: ['title'],
    });
    ctx.db.prepare('UPDATE mobile_change_outbox SET created_at = ? WHERE change_seq = ?')
      .run(now - 40 * DAY, seq);
    assert.equal(ctx.store.gcDeliveredWakeOutbox({ olderThanMs: 0, now }), 0);
    assert.equal(ctx.db.prepare(
      'SELECT COUNT(*) AS n FROM mobile_change_outbox WHERE delivered_at IS NULL',
    ).get().n, 1);
  } finally {
    ctx.cleanup();
  }
});

test('MobileV1Api constructor starts hourly maintenance and close() clears it', () => {
  const ctx = freshStore();
  let api;
  try {
    api = new MobileV1Api({
      db: ctx.db,
      store: ctx.store,
      entityRegistry: registry,
      storage: { rawDb: () => ctx.db },
      sessionStore: {},
      resourceService: { storage: { listAllConnectionRows: () => [] } },
      notesService: null,
      userSettingsService: null,
      fileAgentManager: {},
      authz: {},
      blobs: { close() {}, ready: Promise.resolve() },
      shared: {},
      wake: { publish() {}, close() {} },
    });
    assert.ok(api._maintenanceTimer, 'constructor must schedule hourly runMaintenance');
    api.close();
    assert.equal(api._maintenanceTimer, null);
    api.close();
  } finally {
    try { api?.close(); } catch {}
    ctx.cleanup();
  }
});

test('runMaintenance prunes aged changes and delivered wake rows for every owner', () => {
  const ctx = freshStore();
  try {
    const now = Date.now();
    const oldSeq = ctx.store.appendChange({
      ownerUserId: OWNER, entityType: 'connection', entityId: 'c-old',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    const freshSeq = ctx.store.appendChange({
      ownerUserId: 'other-owner', entityType: 'connection', entityId: 'c-fresh',
      action: 'upsert', revision: 1, fieldMask: ['name'],
    });
    ctx.db.prepare('UPDATE mobile_sync_changes SET changed_at = ? WHERE change_seq = ?')
      .run(now - 181 * DAY, oldSeq);
    ctx.db.prepare('UPDATE mobile_sync_changes SET changed_at = ? WHERE change_seq = ?')
      .run(now - 1 * DAY, freshSeq);
    const delivered = ctx.db.prepare(
      'SELECT outbox_id FROM mobile_change_outbox WHERE change_seq = ?',
    ).get(oldSeq);
    ctx.db.prepare('UPDATE mobile_change_outbox SET delivered_at = ? WHERE outbox_id = ?')
      .run(now - 10 * DAY, delivered.outbox_id);

    const result = ctx.store.runMaintenance({ now });
    assert.equal(result.pruned, 1);
    assert.equal(result.outboxDropped, 1);
    assert.equal(countChanges(ctx.store, OWNER), 0);
    assert.equal(countChanges(ctx.store, 'other-owner'), 1);
    assert.equal(ctx.store.isCursorExpired(OWNER, 0), true);
  } finally {
    ctx.cleanup();
  }
});
