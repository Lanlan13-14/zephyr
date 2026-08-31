import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { createEntityAdapters } = require(path.join(repoRoot, 'mobile-v1-entities.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileStoreError } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { HttpError } = require(path.join(repoRoot, 'authz.js'));

const mine = { userId: 'user-mine', username: 'mine', role: 'user' };
const other = { userId: 'user-other', username: 'other', role: 'user' };
const TYPES = ['connection', 'proxy', 'sshKey', 'jumpHost', 'note'];

function normalizedRow(type, id, ownerUserId, revision = 3) {
  const row = { id, ownerUserId, revision, name: type + '-' + id };
  if (type === 'note') {
    return {
      ...row,
      noteId: id,
      title: row.name,
      content: 'body',
      deletedAt: null,
    };
  }
  return row;
}

function makeAdapterHarness() {
  const rows = new Map();
  const calls = [];
  for (const type of TYPES) {
    rows.set(type, new Map([
      ['mine-' + type, normalizedRow(type, 'mine-' + type, mine.userId)],
      ['shared-' + type, normalizedRow(type, 'shared-' + type, other.userId)],
    ]));
  }

  const get = (type, id) => rows.get(type).get(String(id)) || null;
  const ownedResult = (type, id, user) => {
    const row = get(type, id);
    if (!row) {
      const err = new Error('missing');
      err.code = 'resource_not_found_or_inaccessible';
      throw err;
    }
    // The normal Web services allow shared rows. The sync adapter must narrow it.
    return { ...row, owner: row.ownerUserId === user.userId ? 'own' : 'shared' };
  };
  const save = (type, id, user, patch = {}) => {
    const current = get(type, id);
    const row = normalizedRow(type, id, user.userId, current ? current.revision + 1 : 1);
    Object.assign(row, current || {}, patch, { ownerUserId: user.userId, revision: row.revision });
    rows.get(type).set(id, row);
    return row;
  };

  const storage = {
    getConnectionById: (id) => get('connection', id),
    listAllConnectionRows: () => [...rows.get('connection').values()],
    getProxyRaw: (id) => get('proxy', id),
    getSshKeyRaw: (id) => get('sshKey', id),
    listJumpHosts: () => [...rows.get('jumpHost').values()],
    listProxiesRaw: () => [...rows.get('proxy').values()],
    listSshKeysRaw: () => [...rows.get('sshKey').values()],
    rawDb: () => ({
      prepare(sql) {
        const type = /FROM connections/.test(sql) ? 'connection'
          : /FROM proxies/.test(sql) ? 'proxy'
            : /FROM ssh_keys/.test(sql) ? 'sshKey'
              : /FROM jump_hosts/.test(sql) ? 'jumpHost'
                : /FROM notes/.test(sql) ? 'note' : null;
        assert.ok(type, 'owner lookup must use a known narrow table query');
        assert.equal(/password|privateKey|private_key|passphrase|content/.test(sql), false,
          'owner lookup must not select secret/content columns');
        return {
          get(id) {
            const row = get(type, id);
            return row ? {
              ...row,
              id: row.id,
              ownerUserId: row.ownerUserId,
              revision: row.revision,
            } : undefined;
          },
        };
      },
    }),
  };

  const resourceService = {
    storage,
    listConnections: () => [...rows.get('connection').values()],
    getConnection: (user, id) => ownedResult('connection', id, user),
    listOwnedRawForSync: (user, type) => [...rows.get(type).values()]
      .filter((row) => row.ownerUserId === user.userId),
    createConnection: (user, patch) => {
      calls.push(['create', 'connection', patch.id]);
      return save('connection', patch.id, user, patch);
    },
    updateConnection: (user, id, mutate) => {
      calls.push(['update', 'connection', id]);
      return save('connection', id, user, mutate(get('connection', id)));
    },
    deleteConnection: (_user, id) => {
      calls.push(['remove', 'connection', id]);
      rows.get('connection').delete(id);
      return true;
    },
    listOwned: (_user, type) => [...rows.get(type).values()],
    getRawAuthorized: (user, type, id) => ownedResult(type, id, user),
    createOwned: (user, type, patch) => {
      calls.push(['create', type, patch.id]);
      return save(type, patch.id, user, patch);
    },
    updateOwned: (user, type, id, patch) => {
      calls.push(['update', type, id]);
      return save(type, id, user, patch);
    },
    deleteOwned: (_user, type, id) => {
      calls.push(['remove', type, id]);
      rows.get(type).delete(id);
      return true;
    },
  };

  const notesService = {
    list: () => ({ notes: [...rows.get('note').values()] }),
    listOwnedForSync: (user) => [...rows.get('note').values()]
      .filter((row) => row.ownerUserId === user.userId),
    get: (user, id) => ownedResult('note', id, user),
    create: (user, patch) => {
      calls.push(['create', 'note', patch.id]);
      return save('note', patch.id, user, patch);
    },
    update: (user, id, patch) => {
      calls.push(['update', 'note', id, patch.expectedRevision]);
      assert.equal(patch.expectedRevision, get('note', id).revision);
      return save('note', id, user, patch);
    },
    delete: (_user, id) => {
      calls.push(['remove', 'note', id]);
      rows.get('note').delete(id);
      return true;
    },
    restore: (user, id) => {
      calls.push(['restore', 'note', id]);
      return save('note', id, user, { deletedAt: null });
    },
  };

  return {
    rows,
    calls,
    adapters: createEntityAdapters({ resourceService, notesService, storage }),
  };
}

function assertInaccessible(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'resource_not_found_or_inaccessible');
    assert.equal(err.status, 404);
    assert.equal(err.message, '\u8d44\u6e90\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u8bbf\u95ee');
    return true;
  });
}

test('all sync adapters expose only owner rows and never mutate shared-to-me rows', () => {
  const harness = makeAdapterHarness();

  for (const type of TYPES) {
    const adapter = harness.adapters.get(type);
    assert.deepEqual(adapter.list(mine).map((row) => row.ownerUserId), [mine.userId], type + ' list');
    const owned = adapter.read(mine, 'mine-' + type);
    assert.equal(owned.ownerUserId, mine.userId, type + ' owner read');
    assert.equal(adapter.idOf(owned), 'mine-' + type, type + ' canonical sync id');
    assert.equal(adapter.read(mine, 'shared-' + type), null, type + ' shared read');
    assert.equal(adapter.read(mine, 'missing-' + type), null, type + ' missing read');

    for (const id of ['shared-' + type, 'missing-' + type]) {
      assertInaccessible(() => adapter.update(mine, id, { name: 'takeover' }));
      assertInaccessible(() => adapter.remove(mine, id));
    }
    assertInaccessible(() => adapter.create(mine, 'shared-' + type, { name: 'replace' }));

    assert.equal(harness.rows.get(type).get('shared-' + type).ownerUserId, other.userId);
    assert.equal(harness.rows.get(type).get('shared-' + type).name, type + '-shared-' + type);
  }

  const note = harness.adapters.get('note');
  assertInaccessible(() => note.restore(mine, 'shared-note'));
  assertInaccessible(() => note.restore(mine, 'missing-note'));
  assert.equal(harness.calls.some((call) => call[2] === 'shared-note'), false);
});

function makeApplyStore() {
  const state = { appended: [], fields: [], applied: [] };
  return {
    state,
    findAppliedOp: () => null,
    getEntityVersion: () => null,
    latestCursor: () => state.appended.length,
    hasOverlap: () => false,
    appendChange(change) { state.appended.push(change); return state.appended.length; },
    setEntityVersion() {},
    setFieldRevisions(value) { state.fields.push(value); },
    recordAppliedOp(value) { state.applied.push(value); },
  };
}

test('shared and nonexistent deletes are indistinguishable and produce no mirror feed row', () => {
  const harness = makeAdapterHarness();
  const store = makeApplyStore();
  const api = Object.create(MobileV1Api.prototype);
  api.adapters = harness.adapters;
  api.entityByType = new Map(TYPES.map((type) => [type, { type, editableFields: ['name'], secretFields: [] }]));
  api.store = store;

  for (const type of TYPES) {
    const results = ['shared-' + type, 'missing-' + type].map((entityId, index) => api.applyOperation({
      ownerUserId: mine.userId,
      user: mine,
      deviceId: 'device-1',
      deviceRow: { device_id: 'device-1', owner_user_id: mine.userId },
      batchId: 'batch-' + type,
      operation: {
        opId: 'delete-' + type + '-' + index,
        entityType: type,
        entityId,
        action: 'delete',
        baseRevision: 0,
        fieldMask: [],
      },
    }));
    assert.deepEqual(
      results.map((result) => ({ status: result.status, revision: result.revision })),
      [{ status: 'duplicate', revision: 0 }, { status: 'duplicate', revision: 0 }],
      type,
    );
  }
  assert.equal(store.state.appended.length, 0);
  assert.equal(harness.calls.some((call) => call[0] === 'remove'), false);
});

test('an accidentally owner-mismatched change aborts hydration before a cursor can advance', () => {
  const harness = makeAdapterHarness();
  const api = Object.create(MobileV1Api.prototype);
  api.adapters = harness.adapters;
  api.entityByType = new Map(TYPES.map((type) => [type, {
    type, editableFields: ['name'], secretFields: [], deviceLocalFields: [],
  }]));

  assert.throws(
    () => api.hydrateChange(mine, {
      changeSeq: 8, entityType: 'connection', entityId: 'shared-connection',
      action: 'upsert', revision: 3, fieldMask: ['name'],
    }),
    (err) => err.code === 'shared_residency_violation' && err.status === 409,
  );
  assert.throws(
    () => api.hydrateChange(mine, {
      changeSeq: 9, entityType: 'connection', entityId: 'missing-connection',
      action: 'delete', revision: 4,
      tombstone: { ownerUserId: other.userId },
    }),
    (err) => err.code === 'shared_residency_violation' && err.status === 409,
  );

  const deletedAfterUpsert = api.hydrateChange(mine, {
    changeSeq: 10, entityType: 'connection', entityId: 'missing-connection',
    action: 'upsert', revision: 4, fieldMask: ['name'],
  });
  assert.deepEqual(deletedAfterUpsert.payload, {});
});

test('bootstrap refuses an adapter regression that returns a foreign row', () => {
  const api = Object.create(MobileV1Api.prototype);
  api.requireDevice = () => ({
    user: mine,
    device: { device_id: 'device-1', owner_user_id: mine.userId },
  });
  api.bootstrapTypes = ['connection'];
  api.entityByType = new Map([['connection', {
    editableFields: ['name'], secretFields: [], deviceLocalFields: [],
  }]]);
  api.adapters = new Map([['connection', {
    list: () => [normalizedRow('connection', 'shared-connection', other.userId)],
    idOf: (row) => row.id,
    revisionOf: (row) => row.revision,
  }]]);
  api.store = { latestCursor: () => 41 };
  const req = { mobileRequestId: 'request-bootstrap', query: {} };
  const res = fakeResponse();
  api.handleBootstrap(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'shared_residency_violation');
  assert.equal(Object.hasOwn(res.body, 'nextPageToken'), false);
  assert.equal(JSON.stringify(res.body).includes('shared-connection'), false);
});

test('secret envelopes accept only the exact next server revision and current key version', () => {
  const api = Object.create(MobileV1Api.prototype);
  api.serverEncryptionKey = () => ({ publicKey: Buffer.alloc(1184), keyVersion: 4 });
  const base = {
    spec: { secretFields: ['password'] },
    entityType: 'connection',
    entityId: 'conn-1',
    deviceRow: { device_id: 'device-1', owner_user_id: mine.userId },
    entityRevision: 8,
  };

  for (const entityRevision of [7, 9, 8.5, '8', '08']) {
    assert.throws(
      () => api.openSecretEnvelopes({
        ...base,
        envelopes: { password: { entityRevision, keyVersion: 4 } },
      }),
      (err) => err.code === 'revision_conflict' && err.status === 409,
    );
  }
  assert.throws(
    () => api.openSecretEnvelopes({
      ...base,
      envelopes: { password: { entityRevision: 8, keyVersion: 3 } },
    }),
    (err) => err.code === 'invalid_request',
  );
  assert.throws(
    () => api.openSecretEnvelopes({
      ...base,
      envelopes: { password: { entityRevision: 8, keyVersion: '4' } },
    }),
    (err) => err.code === 'invalid_request',
  );
});

test('secret clear validates identity, ownership, allowlists, and protocol intent before writing', () => {
  const spec = {
    type: 'connection', ownerField: 'ownerUserId', editableFields: ['name'], secretFields: ['password'],
    serverAuthorityFields: [], opaquePreserveFields: [], deviceLocalFields: [],
  };
  const operation = {
    opId: 'clear-password', entityType: 'connection', entityId: 'conn-1', action: 'upsert',
    baseRevision: 1, fieldMask: [], payload: {}, clearSecretFields: ['password'],
  };
  const api = Object.create(MobileV1Api.prototype);
  api.entityByType = new Map([['connection', spec]]);
  api.store = makeApplyStore();
  let writes = 0;
  let opened = 0;
  let residency = 'owned';
  api.adapters = new Map([['connection', {
    residency: () => residency,
    read: () => ({ id: 'conn-1', ownerUserId: mine.userId, revision: 1, name: 'Host' }),
    revisionOf: (row) => row.revision,
    update: (_user, _id, patch) => {
      writes += 1;
      assert.equal(Object.getPrototypeOf(patch), null);
      assert.deepEqual({ ...patch }, { password: '' });
      return { id: 'conn-1', ownerUserId: mine.userId, revision: 2, name: 'Host' };
    },
  }]]);
  api.openSecretEnvelopes = ({ envelopes }) => {
    if (!envelopes) return { values: {}, release() {} };
    opened += 1;
    return { values: { password: 'SHOULD_NEVER_OPEN' }, release() {} };
  };
  const invoke = (nextOperation = operation, overrides = {}) => api.applyOperation({
    ownerUserId: mine.userId,
    user: mine,
    deviceId: 'device-1',
    deviceRow: { device_id: 'device-1', owner_user_id: mine.userId },
    batchId: 'batch-secret-validation',
    operation: nextOperation,
    ...overrides,
  });

  assert.throws(
    () => invoke(operation, { deviceRow: { device_id: 'other-device', owner_user_id: mine.userId } }),
    (error) => error.code === 'device_proof_invalid' && error.status === 401,
  );
  assert.throws(
    () => invoke(operation, { deviceRow: { device_id: 'device-1', owner_user_id: other.userId } }),
    (error) => error.code === 'device_proof_invalid' && error.status === 401,
  );
  assert.throws(
    () => invoke({ ...operation, clearSecretFields: ['name'] }),
    (error) => error.code === 'invalid_request',
  );
  assert.throws(
    () => invoke({ ...operation, secretEnvelopes: {}, clearSecretFields: [] }),
    (error) => error.code === 'invalid_request' && /mutually exclusive/.test(error.message),
  );
  residency = 'foreign';
  assert.throws(
    () => invoke({ ...operation, clearSecretFields: undefined, secretEnvelopes: { password: {} } }),
    (error) => error.code === 'invalid_request',
    'both properties remain mutually exclusive even when one value is undefined',
  );
  const foreignReplace = { ...operation };
  delete foreignReplace.clearSecretFields;
  foreignReplace.secretEnvelopes = { password: {} };
  assert.throws(
    () => invoke(foreignReplace),
    (error) => error.code === 'resource_not_found_or_inaccessible' && error.status === 404,
  );
  assert.equal(opened, 0, 'foreign or malformed intent must fail before envelope decryption');
  assert.equal(writes, 0);

  residency = 'owned';
  const accepted = invoke();
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.revision, 2);
  assert.equal(writes, 1);
  assert.equal(opened, 0, 'a clear never invokes the envelope opener');
  assert.deepEqual(api.store.state.appended[0].fieldMask, []);
  assert.deepEqual(api.store.state.fields[0].fields, ['password']);
});

test('secret fields participate in overlap detection and field revision bookkeeping', () => {
  const store = makeApplyStore();
  const api = Object.create(MobileV1Api.prototype);
  api.entityByType = new Map([['connection', {
    type: 'connection', editableFields: ['name'], secretFields: ['password'],
    serverAuthorityFields: [], opaquePreserveFields: [], deviceLocalFields: [],
  }]]);
  let updated = 0;
  api.adapters = new Map([['connection', {
    read: () => ({ id: 'conn-1', ownerUserId: mine.userId, revision: 4, name: 'old' }),
    revisionOf: (row) => row.revision,
    update: (_user, _id, patch) => {
      updated += 1;
      assert.equal(patch.password, 'opened');
      return { id: 'conn-1', ownerUserId: mine.userId, revision: 5, name: patch.name };
    },
  }]]);
  api.store = store;
  api.openSecretEnvelopes = (input) => {
    assert.equal(input.entityRevision, 5);
    return { values: { password: 'opened' }, release() {} };
  };

  const operation = {
    opId: 'secret-update', entityType: 'connection', entityId: 'conn-1', action: 'upsert',
    baseRevision: 3, fieldMask: ['name'], payload: { name: 'new' },
    secretEnvelopes: { password: { entityRevision: 5, keyVersion: 1 } },
  };
  let overlapFields = null;
  store.hasOverlap = (_owner, _type, _id, _base, fields) => {
    overlapFields = fields;
    return true;
  };

  const conflict = api.applyOperation({
    ownerUserId: mine.userId, user: mine, deviceId: 'device-1',
    deviceRow: { device_id: 'device-1', owner_user_id: mine.userId },
    batchId: 'batch-conflict', operation,
  });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(overlapFields, ['name', 'password']);
  assert.deepEqual(conflict.conflict.fields, ['name', 'password']);
  assert.equal(updated, 0);

  store.hasOverlap = (_owner, _type, _id, _base, fields) => {
    overlapFields = fields;
    return false;
  };
  const accepted = api.applyOperation({
    ownerUserId: mine.userId, user: mine, deviceId: 'device-1',
    deviceRow: { device_id: 'device-1', owner_user_id: mine.userId },
    batchId: 'batch-accepted', operation: { ...operation, opId: 'secret-update-2' },
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.revision, 5);
  assert.equal(updated, 1);
  assert.deepEqual(overlapFields, ['name', 'password']);
  assert.deepEqual(store.state.fields.at(-1).fields, ['name', 'password']);
});

function fakeResponse() {
  return {
    body: null,
    statusCode: 200,
    headers: new Map(),
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
  };
}

function invokePushWith(error) {
  const api = Object.create(MobileV1Api.prototype);
  api.requireDevice = () => ({
    user: mine,
    device: { device_id: 'device-1', owner_user_id: mine.userId, last_acked_cursor: 0 },
  });
  api.assertRegistry = () => true;
  api.entityByType = new Map();
  api.db = { transaction: (fn) => fn };
  api.applyOperation = () => { throw error; };
  api.store = {
    startRun: () => 1,
    latestCursor: () => 0,
    finishRun() {},
  };
  const req = {
    mobileRequestId: 'request-1',
    body: {
      protocolVersion: 1,
      registryHash: 'a'.repeat(64),
      deviceId: 'device-1',
      batchId: 'batch-1',
      baseCursor: 0,
      operations: [{
        opId: 'op-1', entityType: 'unknown', entityId: 'entity-1',
        action: 'upsert', baseRevision: 0, fieldMask: ['name'], payload: { name: 'test' },
      }],
    },
  };
  const res = fakeResponse();
  api.handlePush(req, res);
  return res.body.results[0].error.error;
}

test('push preserves typed business errors but never returns internal exception text', () => {
  const business = invokePushWith(new MobileStoreError('invalid_request', 'stable public detail', 400));
  assert.equal(business.code, 'invalid_request');
  assert.equal(business.message, 'stable public detail');
  assert.equal(business.retryable, false);

  const sqliteText = 'SQLITE_CONSTRAINT: UNIQUE failed: connections.id secret=/tmp/private-key';
  const internal = invokePushWith(Object.assign(new Error(sqliteText), { code: 'SQLITE_CONSTRAINT' }));
  assert.equal(internal.code, 'internal_error');
  assert.equal(internal.message, '\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef');
  assert.equal(internal.retryable, true);
  assert.equal(JSON.stringify(internal).includes('SQLITE'), false);
  assert.equal(JSON.stringify(internal).includes('/tmp/private-key'), false);

  const fakeTyped = invokePushWith(Object.assign(new Error('pretend public'), {
    code: 'invalid_request', status: 400,
  }));
  assert.equal(fakeTyped.code, 'internal_error');
  assert.equal(fakeTyped.message.includes('pretend'), false);

  const unregistered = invokePushWith(new HttpError(400, 'unregistered_sql_detail', sqliteText));
  assert.equal(unregistered.code, 'internal_error');
  assert.equal(JSON.stringify(unregistered).includes('SQLITE'), false);
});
