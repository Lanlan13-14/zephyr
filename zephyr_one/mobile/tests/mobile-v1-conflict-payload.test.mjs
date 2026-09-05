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

const alice = { userId: 'owner-alice', username: 'alice' };
const bob = { userId: 'owner-bob', username: 'bob' };
const canary = 'CONFLICT_SECRET_CANARY_71f54c';

const connectionSpec = {
  type: 'connection',
  ownerField: 'ownerUserId',
  editableFields: ['name', 'host'],
  opaquePreserveFields: ['rdpPipeline'],
  secretFields: ['password', 'privateKey'],
  serverAuthorityFields: [
    'ownerUserId', 'createdByUserId', 'revision', 'createdAt', 'updatedAt', 'lastConnectedAt',
  ],
  deviceLocalFields: ['ephemeral'],
};

function canonicalConnection(overrides = {}) {
  return {
    id: 'conn-1',
    ownerUserId: alice.userId,
    createdByUserId: 'actor-user-secret',
    revision: 5,
    createdAt: 10,
    updatedAt: 20,
    lastConnectedAt: 30,
    name: 'Server name',
    host: 'server.example',
    rdpPipeline: { codec: 'avc444' },
    password: canary,
    privateKey: canary,
    ephemeral: true,
    actorDeviceId: 'device-foreign-secret',
    unknownServerOnly: canary,
    ...overrides,
  };
}

function makeHarness({ spec = connectionSpec, row = canonicalConnection(), version, residency = 'owned' } = {}) {
  const state = {
    row,
    version: version === undefined
      ? (row ? { revision: Number(row.revision) || 1, deleted_at: null } : null)
      : version,
    changes: [],
    outbox: [],
    applied: [],
    writes: 0,
  };
  const store = {
    findAppliedOp: () => null,
    getEntityVersion: () => state.version,
    hasOverlap: () => true,
    fieldRevisions: () => new Map([
      ['host', 2],
      ['name', 5],
      ['password', 5],
    ]),
    appendChange(change) {
      state.changes.push(change);
      state.outbox.push({ ownerUserId: change.ownerUserId });
      return state.changes.length;
    },
    setEntityVersion() {},
    setFieldRevisions() {},
    recordAppliedOp(value) { state.applied.push(value); },
    startRun: () => 1,
    finishRun() {},
    latestCursor: () => state.changes.length,
  };
  const adapter = {
    read: () => state.row,
    residency: () => residency,
    revisionOf: (value) => Number(value.revision) || 1,
    update: () => { state.writes += 1; throw new Error('conflicts must not write'); },
    create: () => { state.writes += 1; throw new Error('conflicts must not write'); },
    remove: () => { state.writes += 1; throw new Error('conflicts must not write'); },
  };
  const api = Object.create(MobileV1Api.prototype);
  api.entityByType = new Map([[spec.type, spec]]);
  api.adapters = new Map([[spec.type, adapter]]);
  api.store = store;
  api.db = { transaction: (fn) => fn };
  api.assertRegistry = () => true;
  api.requireDevice = () => ({
    user: alice,
    device: { device_id: 'device-alice', owner_user_id: alice.userId, last_acked_cursor: 0 },
  });
  return { api, state, store };
}

function operation(spec = connectionSpec, overrides = {}) {
  return {
    opId: 'op-conflict',
    entityType: spec.type,
    entityId: 'conn-1',
    action: 'upsert',
    baseRevision: 3,
    fieldMask: [spec.editableFields[0]],
    payload: { [spec.editableFields[0]]: 'Local name' },
    ...overrides,
  };
}

function apply(harness, user = alice, op = operation()) {
  return harness.api.applyOperation({
    ownerUserId: user.userId,
    user,
    deviceId: 'device-' + user.username,
    deviceRow: { device_id: 'device-' + user.username, owner_user_id: user.userId },
    batchId: 'batch-conflict',
    operation: op,
  });
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
  };
}

test('field overlap returns the owner-scoped Android conflict wire fields without secrets', () => {
  const harness = makeHarness();
  const result = apply(harness);

  assert.equal(result.status, 'conflict');
  assert.equal(result.revision, 5);
  assert.equal(result.conflict.currentRevision, 5);
  assert.deepEqual(result.conflict.serverChangedFields, ['name', 'password']);
  assert.deepEqual(result.conflict.fields, ['name']);
  assert.deepEqual(result.conflict.serverPayload, {
    ownerUserId: alice.userId,
    name: 'Server name',
    host: 'server.example',
    rdpPipeline: { codec: 'avc444' },
  });

  const wire = JSON.stringify(result);
  assert.equal(wire.includes(canary), false);
  assert.equal(wire.includes('device-foreign-secret'), false);
  assert.equal(wire.includes('actor-user-secret'), false);
  for (const field of ['id', 'revision', 'createdAt', 'updatedAt', 'lastConnectedAt', 'ephemeral']) {
    assert.equal(Object.hasOwn(result.conflict.serverPayload, field), false, field);
  }
  assert.equal(harness.state.writes, 0);
  assert.equal(harness.state.changes.length, 0);
  assert.equal(harness.state.outbox.length, 0);
  assert.equal(harness.state.applied.length, 1, 'only the idempotent logical result is recorded');
});

test('a durable conflict writes only the replay result, never change or wake outbox rows', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  try {
    const store = new MobileV1Store({ db, entityRegistry });
    store.setEntityVersion({
      ownerUserId: alice.userId,
      entityType: 'connection',
      entityId: 'conn-1',
      revision: 5,
    });
    store.setFieldRevisions({
      ownerUserId: alice.userId,
      entityType: 'connection',
      entityId: 'conn-1',
      fields: ['name'],
      revision: 5,
    });

    const api = Object.create(MobileV1Api.prototype);
    api.entityByType = new Map([['connection', connectionSpec]]);
    api.adapters = new Map([['connection', {
      read: () => canonicalConnection(),
      residency: () => 'owned',
      revisionOf: (row) => row.revision,
    }]]);
    api.store = store;

    const result = apply({ api }, alice, operation());
    assert.equal(result.status, 'conflict');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_applied_ops').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, 0);

    const replay = store.findAppliedOp(alice.userId, 'device-alice', 'op-conflict');
    assert.deepEqual(replay, result);
  } finally {
    try { db.close(); } catch {}
  }
});

test('the same canonical row can never become a second account conflict payload', () => {
  const mine = makeHarness();
  assert.equal(apply(mine, alice).conflict.serverPayload.ownerUserId, alice.userId);

  const foreign = makeHarness({ residency: 'owned' });
  assert.throws(
    () => apply(foreign, bob, operation(connectionSpec, { opId: 'op-foreign' })),
    (error) => {
      assert.equal(error.code, 'cursor_invalid');
      assert.equal(error.details.bootstrapRequired, true);
      assert.equal(Object.hasOwn(error.details, 'currentRevision'), false);
      assert.equal(JSON.stringify(error.details).includes(alice.userId), false);
      assert.equal(JSON.stringify(error.details).includes(canary), false);
      return true;
    },
  );
  assert.equal(foreign.state.applied.length, 0);
  assert.equal(foreign.state.changes.length, 0);
  assert.equal(foreign.state.outbox.length, 0);
});

test('deleted and missing canonical conflict state produce a typed bootstrap signal', () => {
  for (const [name, version] of [
    ['deleted', { revision: 8, deleted_at: 100 }],
    ['missing', { revision: 7, deleted_at: null }],
  ]) {
    const harness = makeHarness({ row: null, version });
    const req = {
      mobileRequestId: 'request-' + name,
      body: {
        protocolVersion: 1,
        registryHash: 'a'.repeat(64),
        deviceId: 'device-alice',
        batchId: 'batch-' + name,
        baseCursor: 0,
        operations: [operation(connectionSpec, { opId: 'op-' + name })],
      },
    };
    const res = fakeResponse();
    harness.api.handlePush(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.results[0].status, 'rejected');
    assert.equal(res.body.results[0].error.error.code, 'cursor_invalid');
    assert.equal(res.body.results[0].error.error.retryable, false);
    assert.equal(res.body.results[0].error.error.details.bootstrapRequired, true);
    assert.equal(Object.hasOwn(res.body.results[0], 'conflict'), false);
    assert.equal(JSON.stringify(res.body).includes('serverPayload'), false);
    assert.equal(harness.state.applied.length, 0);
    assert.equal(harness.state.changes.length, 0);
    assert.equal(harness.state.outbox.length, 0);
  }
});

test('server-only, oversized, and depth-17 conflict projections fail closed', () => {
  const serverSpec = {
    type: 'serverSettings', ownerField: 'serverId', editableFields: ['appearance'],
    opaquePreserveFields: [], secretFields: [], serverAuthorityFields: ['serverId'], deviceLocalFields: [],
  };
  const cases = [
    makeHarness({ spec: serverSpec, row: { serverId: 'server-1', revision: 5, appearance: {} } }),
    makeHarness({ row: canonicalConnection({ name: 'x'.repeat(2 * 1024 * 1024) }) }),
  ];

  const aiSpec = {
    type: 'aiProvider', ownerField: 'ownerUserId', editableFields: ['config'],
    opaquePreserveFields: [], secretFields: ['apiKey'],
    serverAuthorityFields: ['ownerUserId', 'revision'], deviceLocalFields: [],
  };
  let nested = 'leaf';
  for (let index = 0; index < 16; index += 1) nested = { child: nested };
  const deep = makeHarness({
    spec: aiSpec,
    row: { ownerUserId: alice.userId, revision: 5, config: nested, apiKey: canary },
  });
  deep.store.fieldRevisions = () => new Map([['config', 5]]);
  cases.push(deep);

  for (const [index, harness] of cases.entries()) {
    const spec = [...harness.api.entityByType.values()][0];
    assert.throws(
      () => apply(harness, alice, operation(spec, {
        opId: 'op-unsafe-' + index,
        entityId: spec.type === 'serverSettings' ? 'server-settings' : 'conn-1',
      })),
      (error) => error.code === 'cursor_invalid' && error.details.bootstrapRequired === true,
    );
    assert.equal(harness.state.applied.length, 0);
    assert.equal(harness.state.changes.length, 0);
    assert.equal(harness.state.outbox.length, 0);
  }
});

test('a conflict projection at JSON depth 16 remains valid', () => {
  const spec = {
    type: 'aiProvider', ownerField: 'ownerUserId', editableFields: ['config'],
    opaquePreserveFields: [], secretFields: ['apiKey'],
    serverAuthorityFields: ['ownerUserId', 'revision'], deviceLocalFields: [],
  };
  let nested = 'leaf';
  for (let index = 0; index < 15; index += 1) nested = { child: nested };
  const harness = makeHarness({
    spec,
    row: { ownerUserId: alice.userId, revision: 5, config: nested, apiKey: canary },
  });
  harness.store.fieldRevisions = () => new Map([['config', 5]]);

  const result = apply(harness, alice, operation(spec, { opId: 'op-depth-16' }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflict.serverPayload.ownerUserId, alice.userId);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test('a later overlapping edit wins instead of parking a conflict card', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  try {
    const store = new MobileV1Store({ db, entityRegistry });
    store.setEntityVersion({
      ownerUserId: alice.userId,
      entityType: 'connection',
      entityId: 'conn-1',
      revision: 5,
    });
    store.setFieldRevisions({
      ownerUserId: alice.userId,
      entityType: 'connection',
      entityId: 'conn-1',
      fields: ['name'],
      revision: 5,
      changedAt: 1_000,
    });

    const state = { writes: 0, row: canonicalConnection() };
    const api = Object.create(MobileV1Api.prototype);
    api.entityByType = new Map([['connection', connectionSpec]]);
    api.adapters = new Map([['connection', {
      read: () => state.row,
      residency: () => 'owned',
      revisionOf: (row) => Number(row.revision) || 1,
      update: (user, id, patch) => {
        state.writes += 1;
        state.row = { ...state.row, ...patch, revision: 6, updatedAt: 2_000 };
        return state.row;
      },
      create: () => { throw new Error('LWW must update, not create'); },
      remove: () => { throw new Error('LWW must not delete'); },
    }]]);
    api.store = store;
    api.db = { transaction: (fn) => () => fn() };
    api.assertRegistry = () => true;
    api.changeBridge = { recordMutation: () => ({ changeSeq: 1 }) };

    const result = apply({ api }, alice, operation(connectionSpec, {
      clientModifiedAt: 2_000,
      payload: { name: 'Phone name' },
    }));
    assert.equal(result.status, 'accepted');
    assert.equal(state.writes, 1);
    assert.equal(state.row.name, 'Phone name');
    assert.equal(store.fieldWriteTimes(alice.userId, 'connection', 'conn-1').get('name'), 2_000);
  } finally {
    try { db.close(); } catch {}
  }
});

test('an older overlapping edit still conflicts when the server write is newer', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  try {
    const store = new MobileV1Store({ db, entityRegistry });
    store.setEntityVersion({
      ownerUserId: alice.userId,
      entityType: 'connection',
      entityId: 'conn-1',
      revision: 5,
    });
    store.setFieldRevisions({
      ownerUserId: alice.userId,
      entityType: 'connection',
      entityId: 'conn-1',
      fields: ['name'],
      revision: 5,
      changedAt: 3_000,
    });

    const api = Object.create(MobileV1Api.prototype);
    api.entityByType = new Map([['connection', connectionSpec]]);
    api.adapters = new Map([['connection', {
      read: () => canonicalConnection(),
      residency: () => 'owned',
      revisionOf: (row) => row.revision,
      update: () => { throw new Error('older write must not clobber'); },
    }]]);
    api.store = store;
    api.db = { transaction: (fn) => () => fn() };
    api.assertRegistry = () => true;

    const result = apply({ api }, alice, operation(connectionSpec, { clientModifiedAt: 1_000 }));
    assert.equal(result.status, 'conflict');
    assert.equal(result.conflict.reason, 'field_overlap');
  } finally {
    try { db.close(); } catch {}
  }
});

test('OpenAPI source freezes the safe conflict payload and Android field names', () => {
  const openapi = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'openapi-mobile-v1.json'),
    'utf8',
  ));
  const conflict = openapi.components.schemas.PushConflict;
  assert.deepEqual(conflict.required, [
    'reason', 'currentRevision', 'serverChangedFields', 'serverPayload',
  ]);
  assert.equal(conflict.additionalProperties, false);
  assert.equal(conflict.properties.reason.const, 'field_overlap');
  assert.equal(conflict.properties.serverPayload.type, 'object');
  assert.equal(
    openapi.components.schemas.PushResult.properties.conflict.$ref,
    '#/components/schemas/PushConflict',
  );
});
