import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store, fieldPathsOverlap } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const routes = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileV1Api, fieldPathsOverlap: routesFieldPathsOverlap } = routes;

const registry = { entities: [] };

function freshStore() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  return { db, store, cleanup: () => { try { db.close(); } catch {} } };
}

test('routes re-exports the store fieldPathsOverlap function', () => {
  assert.equal(routesFieldPathsOverlap, fieldPathsOverlap);
  assert.equal(fieldPathsOverlap('config', 'config.x'), true);
  assert.equal(fieldPathsOverlap('config.x', 'config'), true);
  assert.equal(fieldPathsOverlap('items', 'items.0.name'), true);
  assert.equal(fieldPathsOverlap('items.0.name', 'items'), true);
  assert.equal(fieldPathsOverlap('setting', 'settings.theme'), false);
  assert.equal(fieldPathsOverlap('config.x', 'config.y'), false);
});

test('config vs config.x after base is an overlap, not a disjoint edit', () => {
  const ctx = freshStore();
  try {
    ctx.store.setFieldRevisions({
      ownerUserId: 'u1', entityType: 'settings', entityId: 's1',
      fields: ['config'], revision: 4,
    });
    assert.equal(
      ctx.store.hasOverlap('u1', 'settings', 's1', 3, ['config.x']),
      true,
      'a client editing config.x must conflict with a later server write to config',
    );
    assert.equal(ctx.store.hasOverlap('u1', 'settings', 's1', 4, ['config.x']), false);
    assert.equal(ctx.store.hasOverlap('u1', 'settings', 's1', 3, ['theme']), false);
  } finally {
    ctx.cleanup();
  }
});

test('array root items overlaps a later items.0.name write', () => {
  const ctx = freshStore();
  try {
    ctx.store.setFieldRevisions({
      ownerUserId: 'u1', entityType: 'note', entityId: 'n1',
      fields: ['items.0.name'], revision: 6,
    });
    assert.equal(
      ctx.store.hasOverlap('u1', 'note', 'n1', 5, ['items']),
      true,
      'replacing items must conflict with a later leaf write under items',
    );
    assert.equal(ctx.store.hasOverlap('u1', 'note', 'n1', 6, ['items']), false);
    assert.equal(ctx.store.hasOverlap('u1', 'note', 'n1', 5, ['title']), false);
  } finally {
    ctx.cleanup();
  }
});

test('empty field ledger with entity revision 5 and incoming base 3 is not a no-conflict', () => {
  const ctx = freshStore();
  try {
    ctx.store.setEntityVersion({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1', revision: 5,
    });
    assert.equal(
      ctx.store.fieldRevisions('u1', 'connection', 'c1').size,
      0,
      'precondition: historical row has no field ledger',
    );
    assert.equal(
      ctx.store.hasOverlap('u1', 'connection', 'c1', 3, ['name']),
      true,
      'empty ledger plus unseen entity revision must fail closed and require rebase',
    );
    assert.equal(
      ctx.store.hasOverlap('u1', 'connection', 'c1', 5, ['name']),
      false,
      'a client already at the entity revision may continue',
    );
  } finally {
    ctx.cleanup();
  }
});

test('empty ledger with an unprojected change after base also fail-closes', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c1',
      action: 'upsert', revision: 4, fieldMask: ['host'],
    });
    assert.equal(ctx.store.fieldRevisions('u1', 'connection', 'c1').size, 0);
    assert.equal(ctx.store.hasOverlap('u1', 'connection', 'c1', 3, ['name']), true);
  } finally {
    ctx.cleanup();
  }
});

test('only a never-seen entity may report no overlap from an empty ledger', () => {
  const ctx = freshStore();
  try {
    assert.equal(ctx.store.getEntityVersion('u1', 'connection', 'new-row'), null);
    assert.equal(ctx.store.hasOverlap('u1', 'connection', 'new-row', 0, ['name']), false);
  } finally {
    ctx.cleanup();
  }
});

test('hasFieldOverlap trusts store.hasOverlap rather than a second exact-name walk', () => {
  const ctx = freshStore();
  try {
    ctx.store.setFieldRevisions({
      ownerUserId: 'u1', entityType: 'settings', entityId: 's1',
      fields: ['config'], revision: 4,
    });
    const api = Object.create(MobileV1Api.prototype);
    api.store = ctx.store;
    assert.equal(api.hasFieldOverlap('u1', 'settings', 's1', 3, ['config.x']), true);

    ctx.store.setEntityVersion({
      ownerUserId: 'u1', entityType: 'connection', entityId: 'c-empty', revision: 5,
    });
    assert.equal(api.hasFieldOverlap('u1', 'connection', 'c-empty', 3, ['host']), true);
  } finally {
    ctx.cleanup();
  }
});
