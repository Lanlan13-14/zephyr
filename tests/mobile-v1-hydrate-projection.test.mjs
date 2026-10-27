import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store, MobileStoreError } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { MobileV1Api, sendThrown } = require(path.join(repoRoot, 'mobile-v1-routes.js'));

const connectionSpec = {
  type: 'connection',
  ownerField: 'ownerUserId',
  editableFields: ['name', 'host'],
  secretFields: [],
  serverAuthorityFields: ['ownerUserId', 'revision'],
  opaquePreserveFields: [],
  deviceLocalFields: [],
};
const registry = { entities: [connectionSpec] };
const user = { userId: 'owner-1', username: 'owner' };
const device = { device_id: 'device-1', owner_user_id: user.userId };

function freshStore() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  return { db, store, close: () => { try { db.close(); } catch {} } };
}

function apiFor(store, adapters) {
  const api = Object.create(MobileV1Api.prototype);
  api.store = store;
  api.entityByType = new Map([['connection', connectionSpec]]);
  api.adapters = adapters;
  api.log = () => {};
  return api;
}

function auth() {
  return { user, device };
}

test('known-type adapter.read throw aborts the change page instead of skipping', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: user.userId,
      entityType: 'connection',
      entityId: 'c-boom',
      action: 'upsert',
      revision: 2,
      fieldMask: ['name'],
    });
    const api = apiFor(ctx.store, new Map([['connection', {
      read() { throw new Error('boom'); },
      residency() { return 'owned'; },
    }]]));

    let page = null;
    assert.throws(
      () => { page = api.executeChangesForDevice(auth(), { sinceCursor: 0, limit: 10 }); },
      (err) => err instanceof MobileStoreError
        && err.code === 'sync_projection_failed'
        && err.status === 500
        && err.message === 'canonical projection failed',
    );
    assert.equal(page, null, 'a projection failure must not return a skippable page');
  } finally {
    ctx.close();
  }
});

test('unknown types stay unsupported:true and do not throw', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: user.userId,
      entityType: 'futureWidget',
      entityId: 'w1',
      action: 'upsert',
      revision: 1,
      fieldMask: ['name'],
    });
    const api = apiFor(ctx.store, new Map());
    const page = api.executeChangesForDevice(auth(), { sinceCursor: 0, limit: 10 });
    assert.equal(page.ok, true);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].unsupported, true);
    assert.deepEqual(page.changes[0].payload, {});
    assert.equal(page.nextCursor > 0, true);
  } finally {
    ctx.close();
  }
});

test('known-type adapter.read returning null is skippable unsupported, not a throw', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: user.userId,
      entityType: 'connection',
      entityId: 'c-gone',
      action: 'upsert',
      revision: 4,
      fieldMask: ['name'],
    });
    const api = apiFor(ctx.store, new Map([['connection', {
      read() { return null; },
      residency() { return 'missing'; },
    }]]));
    const page = api.executeChangesForDevice(auth(), { sinceCursor: 0, limit: 10 });
    assert.equal(page.ok, true);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].unsupported, true);
    assert.deepEqual(page.changes[0].payload, {});
  } finally {
    ctx.close();
  }
});

test('explicit not-found from adapter.read is skippable, other errors are not', () => {
  const ctx = freshStore();
  try {
    ctx.store.appendChange({
      ownerUserId: user.userId,
      entityType: 'connection',
      entityId: 'c-404',
      action: 'upsert',
      revision: 1,
      fieldMask: ['name'],
    });
    const missing = new MobileStoreError(
      'resource_not_found_or_inaccessible',
      'gone',
      404,
    );
    const api = apiFor(ctx.store, new Map([['connection', {
      read() { throw missing; },
      residency() { return 'missing'; },
    }]]));
    const page = api.executeChangesForDevice(auth(), { sinceCursor: 0, limit: 10 });
    assert.equal(page.changes[0].unsupported, true);
  } finally {
    ctx.close();
  }
});

test('projectPayload throw is sync_projection_failed, never unsupported', () => {
  const ctx = freshStore();
  try {
    const exploding = {};
    Object.defineProperty(exploding, 'name', {
      enumerable: true,
      get() { throw new Error('project boom'); },
    });
    const api = apiFor(ctx.store, new Map([['connection', {
      read() { return exploding; },
      residency() { return 'owned'; },
    }]]));
    assert.throws(
      () => api.hydrateChange(user, {
        changeSeq: 9,
        entityType: 'connection',
        entityId: 'c-project',
        action: 'upsert',
        revision: 1,
        fieldMask: ['name'],
      }, device),
      (err) => err.code === 'sync_projection_failed' && err.status === 500,
    );
  } finally {
    ctx.close();
  }
});

test('sync_projection_failed is a public error code and is not rewritten to internal_error', () => {
  const registries = [
    path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'error-registry.json'),
    path.join(repoRoot, 'mobile-contracts', 'registries', 'error-registry.json'),
  ];
  for (const file of registries) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = (parsed.errors || []).find((row) => row.code === 'sync_projection_failed');
    assert.ok(entry, `${file} must declare sync_projection_failed`);
    assert.equal(entry.httpStatus, 500);
    assert.equal(entry.retryable, true);
  }

  const err = new MobileStoreError('sync_projection_failed', 'canonical projection failed', 500, {
    retryable: true,
    details: { entityType: 'connection', entityId: 'c-boom', changeSeq: 9 },
  });
  let captured = null;
  const res = {
    status(code) {
      captured = { status: code };
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
  sendThrown(res, err, 'req-1');
  assert.equal(captured.status, 500);
  assert.equal(captured.body.ok, false);
  assert.equal(captured.body.error.code, 'sync_projection_failed');
  assert.notEqual(captured.body.error.code, 'internal_error');
  assert.equal(captured.body.error.retryable, true);
});
