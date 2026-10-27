import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { OneLinkLocalStore } = require(path.join(repoRoot, 'one-link-local-store.js'));

function fresh() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new OneLinkLocalStore(db);
  return { db, store, close: () => { try { db.close(); } catch {} } };
}

test('outbox insert failure rolls back with the caller transaction', () => {
  const ctx = fresh();
  try {
    ctx.db.exec('CREATE TABLE canonical (id TEXT PRIMARY KEY, title TEXT)');
    assert.throws(() => ctx.db.transaction(() => {
      ctx.db.prepare('INSERT INTO canonical (id, title) VALUES (?, ?)').run('n1', 'hello');
      ctx.store.upsertOutbox('', { opId: 'missing-account' });
    })(), /accountKey/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM canonical').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM one_link_outbox').get().n, 0);
  } finally {
    ctx.close();
  }
});

test('persistState round-trips cursors, outbox and conflicts per account', () => {
  const ctx = fresh();
  try {
    const key = 'srv:u1:dev-1';
    ctx.store.persistState(key, {
      appliedCursor: 11,
      ackedCursor: 10,
      snapshotCursor: 11,
      bootstrapComplete: true,
      outbox: [{
        opId: 'op-1', entityType: 'note', entityId: 'n1', action: 'upsert',
        baseRevision: 4, fieldMask: ['title'], payload: { title: 'local' },
        status: 'pending', createdLocally: false, enqueuedAt: 1,
      }],
      conflicts: [{
        conflictId: 'c-1', entityType: 'note', entityId: 'n1',
        base: { title: 'base' }, baseRevision: 4,
        local: { title: 'local' }, server: { title: 'server' },
        unresolved: true, at: 2,
      }],
      lastPushedRevisions: { 'note:n1': 4 },
      confirmedBaseRevisions: { 'note:n1': 4 },
    });
    const loaded = ctx.store.loadAccount(key);
    assert.equal(loaded.meta.appliedCursor, 11);
    assert.equal(loaded.meta.ackedCursor, 10);
    assert.equal(loaded.outbox.length, 1);
    assert.equal(loaded.outbox[0].payload.title, 'local');
    assert.equal(loaded.conflicts[0].local.title, 'local');
    assert.equal(loaded.conflicts[0].server.title, 'server');
  } finally {
    ctx.close();
  }
});

test('staging is account-scoped and can be cleared without touching outbox', () => {
  const ctx = fresh();
  try {
    const key = 'srv:u1:dev-1';
    ctx.store.upsertOutbox(key, {
      opId: 'op-keep', entityType: 'note', entityId: 'n1', action: 'upsert',
      status: 'pending', enqueuedAt: 1,
    });
    ctx.store.upsertStaging(key, {
      entityType: 'note', entityId: 'n9', revision: 3, payload: { title: 'boot' },
    });
    assert.equal(ctx.store.listStaging(key).length, 1);
    ctx.store.clearStaging(key);
    assert.equal(ctx.store.listStaging(key).length, 0);
    assert.equal(ctx.store.loadAccount(key).outbox.length, 1);
  } finally {
    ctx.close();
  }
});
