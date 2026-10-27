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

const registry = {
  classification: ['editableSync', 'opaquePreserve', 'serverOnly', 'deviceLocal'],
  entities: [{
    type: 'connection',
    ownerField: 'ownerUserId',
    editableFields: ['name'],
    secretFields: [],
    serverAuthorityFields: ['ownerUserId', 'revision'],
    opaquePreserveFields: [],
    deviceLocalFields: [],
  }],
};
const user = { userId: 'owner-1', username: 'owner' };
const device = {
  device_id: 'device-1',
  owner_user_id: user.userId,
  refresh_generation: 7,
};

function freshStore() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  store._hmacKey = Buffer.alloc(32, 0x5a);
  return { db, store, close: () => { try { db.close(); } catch {} } };
}

function row(id, revision = 1) {
  return { id, ownerUserId: user.userId, revision, name: 'connection-' + id, updatedAt: revision };
}

function apiFor(store, rows, { list } = {}) {
  let liveListAllowed = true;
  const api = Object.create(MobileV1Api.prototype);
  api.bootstrapTypes = ['connection'];
  api.entityByType = new Map([['connection', registry.entities[0]]]);
  api.adapters = new Map([['connection', {
    list: list || (() => {
      if (!liveListAllowed) throw new Error('live adapter.list must not run after page 1');
      return [...rows.values()];
    }),
    get: (_user, id) => rows.get(String(id)) || null,
    read: (_user, id) => rows.get(String(id)) || null,
    idOf: (value) => value.id,
    revisionOf: (value) => value.revision,
  }]]);
  api.store = store;
  api.forbidLiveList = () => { liveListAllowed = false; };
  return api;
}

test('an id inserted after page 1 must not appear on page 2 of the same bootstrap', () => {
  const ctx = freshStore();
  try {
    const rows = new Map(['a', 'b', 'c', 'd'].map((id) => [id, row(id)]));
    const api = apiFor(ctx.store, rows);
    const auth = { user, device };

    const first = api.executeBootstrapForDevice(auth, { pageSize: 2 });
    assert.deepEqual(first.entities.map((entity) => entity.entityId), ['a', 'b']);
    assert.equal(first.complete, false);
    assert.ok(first.nextPageToken);
    assert.ok(first.entities[0].payload && first.entities[0].payload.name, 'snapshot pages carry projected public payload');
    assert.equal(Object.hasOwn(first.entities[0].payload || {}, 'password'), false);

    api.forbidLiveList();
    rows.set('zz-inserted-after-page-1', row('zz-inserted-after-page-1'));
    rows.delete('c');

    const second = api.executeBootstrapForDevice(auth, {
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    const ids = second.entities.map((entity) => entity.entityId);
    assert.equal(
      ids.includes('zz-inserted-after-page-1'),
      false,
      'a row inserted after the snapshot transaction must not appear on a later page',
    );
    assert.deepEqual(ids, ['c', 'd']);
    assert.equal(second.complete, true);
    assert.equal(second.nextPageToken, null);

    const leftover = ctx.db.prepare(
      'SELECT COUNT(*) AS n FROM mobile_bootstrap_snapshots WHERE bootstrap_id = ?',
    ).get(first.bootstrapId);
    assert.equal(leftover.n, 0, 'completed bootstrap must drop snapshot rows');
  } finally {
    ctx.close();
  }
});

test('expired bootstrap tokens stay 410 and drop the snapshot', () => {
  const ctx = freshStore();
  try {
    const rows = new Map(['a', 'b', 'c'].map((id) => [id, row(id)]));
    const api = apiFor(ctx.store, rows);
    const first = api.executeBootstrapForDevice({ user, device }, { pageSize: 1 });
    assert.ok(first.nextPageToken);

    const snapCount = ctx.db.prepare(
      'SELECT COUNT(*) AS n FROM mobile_bootstrap_snapshots WHERE bootstrap_id = ?',
    ).get(first.bootstrapId);
    assert.ok(snapCount.n > 0);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31 * 60 * 1000;
      assert.throws(
        () => api.executeBootstrapForDevice({ user, device }, { pageToken: first.nextPageToken }),
        (err) => err.code === 'bootstrap_expired' && err.status === 410,
      );
    } finally {
      Date.now = realNow;
    }

    const after = ctx.db.prepare(
      'SELECT COUNT(*) AS n FROM mobile_bootstrap_snapshots WHERE bootstrap_id = ?',
    ).get(first.bootstrapId);
    assert.equal(after.n, 0, 'expired tokens must not leak snapshot rows');
  } finally {
    ctx.close();
  }
});
