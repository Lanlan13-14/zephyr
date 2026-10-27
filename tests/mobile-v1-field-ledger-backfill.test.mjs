import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));

const registry = { entities: [] };
const OWNER = 'u1';
const TYPE = 'connection';
const ID = 'c1';

function freshStore() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  return { db, store, cleanup: () => { try { db.close(); } catch {} } };
}

test('empty ledger plus live canonical row backfills name/host at current revision', () => {
  const ctx = freshStore();
  try {
    ctx.store.setEntityVersion({
      ownerUserId: OWNER, entityType: TYPE, entityId: ID, revision: 5,
    });
    assert.equal(ctx.store.fieldRevisions(OWNER, TYPE, ID).size, 0);
    assert.equal(ctx.store.hasOverlap(OWNER, TYPE, ID, 4, ['name']), true,
      'precondition: empty ledger still fail-closes');

    const written = ctx.store.backfillFieldLedger({
      ownerUserId: OWNER,
      entityType: TYPE,
      entityId: ID,
      fields: ['name', 'host'],
      revision: 5,
      changedAt: 1_700_000_000_000,
    });
    assert.equal(written, 2);
    const ledger = ctx.store.fieldRevisions(OWNER, TYPE, ID);
    assert.equal(ledger.get('name'), 5);
    assert.equal(ledger.get('host'), 5);
    assert.equal(ctx.store.hasOverlap(OWNER, TYPE, ID, 5, ['name']), false);
    assert.equal(ctx.store.hasOverlap(OWNER, TYPE, ID, 4, ['name']), true);
    assert.equal(
      ctx.store.hasOverlap(OWNER, TYPE, ID, 4, ['remark']),
      false,
      'disjoint fields become mergeable after a current-revision baseline',
    );
  } finally {
    ctx.cleanup();
  }
});

test('backfillFieldLedger is a no-op when any per-field row already exists', () => {
  const ctx = freshStore();
  try {
    ctx.store.setFieldRevisions({
      ownerUserId: OWNER, entityType: TYPE, entityId: ID,
      fields: ['name'], revision: 3, changedAt: 10,
    });
    const skipped = ctx.store.backfillFieldLedger({
      ownerUserId: OWNER,
      entityType: TYPE,
      entityId: ID,
      fields: ['name', 'host'],
      revision: 9,
      changedAt: 99,
    });
    assert.equal(skipped, 0);
    const ledger = ctx.store.fieldRevisions(OWNER, TYPE, ID);
    assert.equal(ledger.size, 1);
    assert.equal(ledger.get('name'), 3);
    assert.equal(ledger.has('host'), false);
  } finally {
    ctx.cleanup();
  }
});

test('MobileV1Api.backfillEmptyFieldLedgers seeds wired adapters only', () => {
  const ctx = freshStore();
  try {
    ctx.store.setEntityVersion({
      ownerUserId: OWNER, entityType: TYPE, entityId: ID, revision: 5,
    });
    ctx.store.setEntityVersion({
      ownerUserId: OWNER, entityType: 'note', entityId: 'n-deleted', revision: 2,
      deletedAt: Date.now(),
    });
    ctx.store.setEntityVersion({
      ownerUserId: OWNER, entityType: 'futureType', entityId: 'x1', revision: 1,
    });

    const spec = {
      type: TYPE,
      editableFields: ['name', 'host'],
      secretFields: [],
    };
    const reads = [];
    const api = Object.create(MobileV1Api.prototype);
    api.store = ctx.store;
    api.log = () => {};
    api.entityByType = new Map([[TYPE, spec]]);
    api.adapters = new Map([[TYPE, {
      read: (user, id) => {
        reads.push({ userId: user.userId, id });
        return { name: 'office', host: '10.0.0.2' };
      },
    }]]);

    const filled = api.backfillEmptyFieldLedgers();
    assert.equal(filled, 2);
    assert.deepEqual(reads, [{ userId: OWNER, id: ID }]);
    const ledger = ctx.store.fieldRevisions(OWNER, TYPE, ID);
    assert.equal(ledger.get('name'), 5);
    assert.equal(ledger.get('host'), 5);
    assert.equal(ctx.store.fieldRevisions(OWNER, 'note', 'n-deleted').size, 0);
    assert.equal(ctx.store.fieldRevisions(OWNER, 'futureType', 'x1').size, 0);

    const again = api.backfillEmptyFieldLedgers();
    assert.equal(again, 0);
    assert.equal(ctx.store.fieldRevisions(OWNER, TYPE, ID).get('name'), 5);
  } finally {
    ctx.cleanup();
  }
});
