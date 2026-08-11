import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));

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
const hmacKey = Buffer.alloc(32, 0x5a);

function freshStore() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  store._hmacKey = Buffer.from(hmacKey);
  return { db, store, close: () => { try { db.close(); } catch {} } };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: null,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); },
    json(value) { this.body = value; return value; },
  };
}

function row(id, revision = 1) {
  return { id, ownerUserId: user.userId, revision, name: 'connection-' + id, updatedAt: revision };
}

function apiFor(store, rows, { list } = {}) {
  const api = Object.create(MobileV1Api.prototype);
  api.requireDevice = () => ({ user, device });
  api.bootstrapTypes = ['connection'];
  api.entityByType = new Map([['connection', registry.entities[0]]]);
  api.adapters = new Map([['connection', {
    list: list || (() => [...rows.values()]),
    get: (_user, id) => rows.get(String(id)) || null,
    idOf: (value) => value.id,
    revisionOf: (value) => value.revision,
  }]]);
  api.store = store;
  return api;
}

function bootstrap(api, query = {}) {
  const res = fakeResponse();
  api.handleBootstrap({ mobileRequestId: 'bootstrap-request', query }, res);
  return res;
}

function append(store, { id, action, revision }) {
  store.appendChange({
    ownerUserId: user.userId,
    entityType: 'connection',
    entityId: id,
    action,
    revision,
    fieldMask: action === 'upsert' ? ['name'] : undefined,
    tombstone: action === 'delete' ? { ownerUserId: user.userId } : undefined,
  });
}

test('bootstrap keyset pages converge across inter-page deletes, inserts and updates', () => {
  const ctx = freshStore();
  try {
    const rows = new Map(['a', 'b', 'c', 'd'].map((id) => [id, row(id)]));
    const api = apiFor(ctx.store, rows);
    const first = bootstrap(api, { pageSize: 2 });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body.entities.map((entity) => entity.entityId), ['a', 'b']);
    assert.equal(first.body.snapshotCursor, 0);
    assert.ok(first.body.nextPageToken);

    rows.delete('a');
    append(ctx.store, { id: 'a', action: 'delete', revision: 2 });
    rows.delete('c');
    append(ctx.store, { id: 'c', action: 'delete', revision: 2 });
    rows.set('aa', row('aa'));
    append(ctx.store, { id: 'aa', action: 'upsert', revision: 1 });
    rows.set('d', row('d', 2));
    append(ctx.store, { id: 'd', action: 'upsert', revision: 2 });
    rows.set('z', row('z'));
    append(ctx.store, { id: 'z', action: 'upsert', revision: 1 });

    const second = bootstrap(api, { pageSize: 2, pageToken: first.body.nextPageToken });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.body.entities.map((entity) => entity.entityId), ['d']);
    assert.equal(second.body.snapshotCursor, first.body.snapshotCursor);
    assert.equal(second.body.complete, true);
    assert.equal(second.body.nextPageToken, null);

    const mirror = new Map();
    for (const entity of [...first.body.entities, ...second.body.entities]) {
      mirror.set(entity.entityId, entity.revision);
    }
    for (const change of ctx.store.changePage(user.userId, first.body.snapshotCursor, 100).changes) {
      if (change.action === 'delete') mirror.delete(change.entityId);
      else mirror.set(change.entityId, rows.get(change.entityId).revision);
    }
    assert.deepEqual([...mirror].sort(), [['aa', 1], ['b', 1], ['d', 2], ['z', 1]]);
  } finally {
    ctx.close();
  }
});

test('bootstrap aborts the page when adapter.list throws', () => {
  const ctx = freshStore();
  try {
    const api = apiFor(ctx.store, new Map(), { list: () => { throw new Error('private adapter detail'); } });
    const res = bootstrap(api, { pageSize: 2 });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'internal_error');
    assert.equal(Object.hasOwn(res.body, 'nextPageToken'), false);
    assert.equal(JSON.stringify(res.body).includes('private adapter detail'), false);
  } finally {
    ctx.close();
  }
});

test('bootstrap tokens survive restart but reject tamper and stale bindings', () => {
  const first = freshStore();
  const state = first.store.beginBootstrapSnapshot({
    bootstrapId: 'bs-restart-test',
    snapshotCursor: 12,
    typeOrder: ['connection'],
    upperBounds: ['z'],
    ownerUserId: user.userId,
    deviceId: device.device_id,
    generation: device.refresh_generation,
  });
  const token = first.store.sealBootstrapToken({ ...state, afterEntityId: 'b' });
  first.close();

  const restarted = freshStore();
  try {
    const binding = {
      ownerUserId: user.userId,
      deviceId: device.device_id,
      generation: device.refresh_generation,
      registryHash: restarted.store.registryHash,
      typeOrder: ['connection'],
    };
    const opened = restarted.store.openBootstrapToken(token, binding);
    assert.equal(opened.afterEntityId, 'b');
    assert.equal(opened.snapshotCursor, 12);

    const [body, signature] = token.split('.');
    const tampered = (body[0] === 'A' ? 'B' : 'A') + body.slice(1) + '.' + signature;
    assert.throws(() => restarted.store.openBootstrapToken(tampered, binding), { code: 'bootstrap_expired' });
    assert.throws(() => restarted.store.openBootstrapToken(token, {
      ...binding, ownerUserId: 'owner-2',
    }), { code: 'bootstrap_expired' });
    assert.throws(() => restarted.store.openBootstrapToken(token, {
      ...binding, deviceId: 'device-2',
    }), { code: 'bootstrap_expired' });
    assert.throws(() => restarted.store.openBootstrapToken(token, {
      ...binding, generation: device.refresh_generation + 1,
    }), { code: 'bootstrap_expired' });
    assert.throws(() => restarted.store.openBootstrapToken(token, {
      ...binding, registryHash: '0'.repeat(64),
    }), { code: 'bootstrap_expired' });

    const resealed = restarted.store.sealBootstrapToken({ ...opened, afterEntityId: 'c' });
    const expiryOf = (value) => JSON.parse(Buffer.from(value.split('.')[0], 'base64url')).expiresAt;
    assert.equal(expiryOf(resealed), expiryOf(token), 'paging must not extend the original TTL');
    const realNow = Date.now;
    try {
      Date.now = () => opened.expiresAt + 1;
      assert.throws(() => restarted.store.openBootstrapToken(token, binding), { code: 'bootstrap_expired' });
    } finally {
      Date.now = realNow;
    }
  } finally {
    restarted.close();
  }
});

test('changes fail closed for future and retained-away cursors', () => {
  const ctx = freshStore();
  try {
    append(ctx.store, { id: 'a', action: 'upsert', revision: 1 });
    const latest = ctx.store.latestCursor(user.userId);
    ctx.store.appendChange({
      ownerUserId: 'owner-2',
      entityType: 'connection',
      entityId: 'foreign',
      action: 'upsert',
      revision: 1,
      fieldMask: ['name'],
    });
    const api = apiFor(ctx.store, new Map([['a', row('a')]]));

    const future = fakeResponse();
    api.handleChanges({ mobileRequestId: 'future', query: { sinceCursor: latest + 1 } }, future);
    assert.equal(future.statusCode, 409);
    assert.equal(future.body.error.code, 'cursor_invalid');
    assert.equal(future.body.error.details.bootstrapRequired, true);
    assert.equal(future.body.error.details.latestCursor, latest);
    assert.equal(Object.hasOwn(future.body, 'nextCursor'), false);

    assert.equal(ctx.store.pruneChangesBefore(user.userId, latest + 1), 1);
    assert.equal(ctx.store.latestCursor(user.userId), latest, 'retention must preserve the owner cursor watermark');
    const expired = fakeResponse();
    api.handleChanges({ mobileRequestId: 'expired', query: { sinceCursor: 0 } }, expired);
    assert.equal(expired.statusCode, 410);
    assert.equal(expired.body.error.code, 'cursor_expired');
    assert.equal(expired.body.error.details.bootstrapRequired, true);
    assert.equal(Object.hasOwn(expired.body, 'nextCursor'), false);
  } finally {
    ctx.close();
  }
});
