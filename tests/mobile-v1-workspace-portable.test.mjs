import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { MobileV1ChangeBridge } = require(path.join(root, 'mobile-v1-change-bridge.js'));
const { MobileV1Api } = require(path.join(root, 'mobile-v1-routes.js'));
const { WorkspaceService, MAX_WORKSPACES_PER_USER } = require(path.join(root, 'workspace-service.js'));
const { createWorkspacePortableAdapter } = require(path.join(root, 'mobile-v1-workspace-entity.js'));
const { PORTABLE_CLIENT_ID } = require(path.join(root, 'workspace-portable-sync-service.js'));

const productionRegistry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const workspaceSpec = productionRegistry.entities.find((entity) => entity.type === 'workspaceState');
assert.ok(workspaceSpec, 'the production registry must declare workspaceState');
const registry = {
  version: productionRegistry.version,
  entities: [structuredClone(workspaceSpec)],
};

function expressResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
  };
}

function workspaceApi(context) {
  return new MobileV1Api({
    db: context.db,
    storage: { rawDb: () => context.db },
    sessionStore: {},
    resourceService: {},
    notesService: null,
    userSettingsService: null,
    fileAgentManager: {},
    authz: {},
    entityRegistry: registry,
    store: context.bridge.store,
    blobs: {},
    shared: {},
    wake: { publish() {} },
    changeBridge: context.bridge,
    workspacePortableSyncService: context.workspaces.portableSyncService,
  });
}

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-workspace-portable-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`
    CREATE TABLE workspaces (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      state_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, client_id, workspace_id)
    );
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL,
      ephemeral INTEGER NOT NULL DEFAULT 0
    );
  `);
  let timestamp = 1_900_000_000_000;
  const now = () => ++timestamp;
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const workspaces = new WorkspaceService(db, { now, mobileChangeBridge: bridge });
  const adapter = createWorkspacePortableAdapter({ service: workspaces.portableSyncService });
  const addConnection = (id, ownerUserId, ephemeral = false) => db
    .prepare('INSERT INTO connections (id, ownerUserId, ephemeral) VALUES (?, ?, ?)')
    .run(id, ownerUserId, ephemeral ? 1 : 0);
  return {
    db,
    bridge,
    workspaces,
    adapter,
    addConnection,
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('stable wire ids bind the full owner/client/workspace identity without exposing clientId', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    context.addConnection('owned', 'alice');
    context.addConnection('foreign', 'bob');
    context.addConnection('ephemeral', 'alice', true);

    context.workspaces.put(alice, {
      workspaceId: 'same-local-id',
      clientId: 'desktop-a',
      name: 'Desk A',
      state: {
        version: 2,
        tabs: [
          { connectionId: 'owned', protocol: 'SSH', order: 9, sessionId: 'sid-secret', tabId: 'tab-runtime', active: true },
          { connectionId: 'foreign', protocol: 'RDP' },
          { connectionId: 'ephemeral', protocol: 'SSH' },
        ],
        terminal: { frames: { secret: 'screen' }, splitX: '33%' },
        clipboard: { text: 'never-sync' },
        panels: { ai: { sessionId: 'ai-runtime' } },
        ui: { activeView: 'terminal', dashboardScrollY: 500 },
      },
    });
    const first = context.adapter.list(alice)[0];
    assert.match(first.workspaceId, /^wsp_[A-Za-z0-9_-]+$/);
    assert.deepEqual(first.state, {
      version: 1,
      tabs: [{ connectionId: 'owned', protocol: 'SSH', order: 0 }],
    });
    const wire = JSON.stringify(first);
    for (const forbidden of [
      'desktop-a', 'sid-secret', 'tab-runtime', 'never-sync', 'screen',
      'ai-runtime', 'splitX', 'dashboardScrollY', 'activeView', 'foreign', 'ephemeral',
    ]) assert.equal(wire.includes(forbidden), false, forbidden);
    const storedProjection = context.db.prepare(`SELECT projection_json
      FROM workspace_portable_identities WHERE owner_user_id = ? AND portable_id = ?`)
      .get('alice', first.workspaceId).projection_json;
    for (const forbidden of ['desktop-a', 'sid-secret', 'tab-runtime', 'never-sync', 'screen', 'ai-runtime', 'foreign', 'ephemeral']) {
      assert.equal(storedProjection.includes(forbidden), false, forbidden);
    }

    context.workspaces.put(alice, {
      workspaceId: 'same-local-id',
      clientId: 'desktop-a',
      name: 'Desk A renamed',
      state: { tabs: [{ connectionId: 'owned', protocol: 'RDP' }] },
      expectedRevision: 1,
    });
    assert.equal(context.adapter.list(alice)[0].workspaceId, first.workspaceId);

    context.workspaces.put(alice, {
      workspaceId: 'same-local-id',
      clientId: 'desktop-b',
      name: 'Desk B',
      state: { tabs: [{ connectionId: 'owned' }] },
    });
    const rows = context.adapter.list(alice);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.workspaceId)).size, 2);
    assert.deepEqual(
      context.db.prepare(`SELECT owner_user_id, source_client_id, source_workspace_id, portable_id
        FROM workspace_portable_identities ORDER BY source_client_id`).all().map((row) => ({ ...row })),
      [
        { owner_user_id: 'alice', source_client_id: 'desktop-a', source_workspace_id: 'same-local-id', portable_id: first.workspaceId },
        { owner_user_id: 'alice', source_client_id: 'desktop-b', source_workspace_id: 'same-local-id', portable_id: rows.find((row) => row.workspaceId !== first.workspaceId).workspaceId },
      ],
    );

    const restarted = new WorkspaceService(context.db, {
      now: () => 1_900_000_100_000,
      mobileChangeBridge: context.bridge,
    });
    const restartedAdapter = createWorkspacePortableAdapter({ service: restarted.portableSyncService });
    assert.equal(
      restartedAdapter.list(alice).find((row) => row.name === 'Desk A renamed').workspaceId,
      first.workspaceId,
    );
    assert.throws(
      () => restarted.put(alice, {
        workspaceId: 'forged-portable-source', clientId: PORTABLE_CLIENT_ID, state: {},
      }),
      (error) => error.code === 'invalid_client_id',
    );
  } finally {
    context.cleanup();
  }
});

test('mobile writes stay canonical, owner-isolated, and preserve local runtime fields', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    context.addConnection('alice-conn', 'alice');
    context.addConnection('bob-conn', 'bob');

    const created = context.adapter.create(alice, 'portable.device.one', {
      name: 'Phone layout',
      state: {
        tabs: [{ connectionId: 'alice-conn', protocol: 'ssh', sessionId: 'must-drop' }],
        clipboard: { text: 'must-drop' },
      },
    });
    assert.equal(created.workspaceId, 'portable.device.one');
    assert.equal(created.revision, 1);
    const canonical = context.db.prepare('SELECT * FROM workspaces WHERE user_id = ?').get('alice');
    assert.equal(canonical.client_id, PORTABLE_CLIENT_ID);
    assert.equal(JSON.stringify(canonical).includes('must-drop'), false);
    assert.equal(context.adapter.read(bob, created.workspaceId), null);
    assert.equal(context.adapter.residency(bob, created.workspaceId), 'missing');
    assert.throws(
      () => context.adapter.update(bob, created.workspaceId, { name: 'stolen' }),
      (error) => error.code === 'resource_not_found_or_inaccessible',
    );

    context.workspaces.put(alice, {
      workspaceId: 'runtime-source',
      clientId: 'desktop-runtime',
      name: 'Runtime source',
      state: {
        version: 2,
        tabs: [{
          connectionId: 'alice-conn', protocol: 'SSH', sessionId: 'local-sid',
          tabId: 'local-tab', minimized: true, active: true,
        }],
        terminal: { splitX: '41%', tabs: { 'local-tab': { scrollY: 99 } } },
        clipboard: { text: 'local-only' },
      },
    });
    const runtimePortable = context.adapter.list(alice).find((row) => row.name === 'Runtime source');
    const updated = context.adapter.update(alice, runtimePortable.workspaceId, {
      name: 'Portable rename',
      state: { tabs: [{ connectionId: 'alice-conn', protocol: 'TELNET' }] },
    });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.state.tabs, [
      { connectionId: 'alice-conn', protocol: 'TELNET', order: 0 },
    ]);
    const restoredCanonical = context.workspaces.get('alice', 'runtime-source', { clientId: 'desktop-runtime' });
    assert.equal(restoredCanonical.state.tabs[0].sessionId, 'local-sid');
    assert.equal(restoredCanonical.state.tabs[0].tabId, 'local-tab');
    assert.equal(restoredCanonical.state.terminal.splitX, '41%');
    assert.equal(restoredCanonical.state.clipboard.text, 'local-only');

    const cursor = context.bridge.store.latestCursor('alice');
    assert.throws(
      () => context.adapter.update(alice, runtimePortable.workspaceId, {
        state: { tabs: [{ connectionId: 'bob-conn', protocol: 'SSH' }] },
      }),
      (error) => error.code === 'invalid_request',
    );
    assert.equal(context.bridge.store.latestCursor('alice'), cursor);
    assert.throws(
      () => context.adapter.create(alice, 'foreign-layout', {
        state: { tabs: [{ connectionId: 'bob-conn' }] },
      }),
      (error) => error.code === 'invalid_request',
    );
    assert.equal(context.db.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE user_id='alice' AND workspace_id LIKE 'portable-%'",
    ).get().count, 1);
  } finally {
    context.cleanup();
  }
});

test('canonical row, identity, version and change feed roll back as one transaction', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    context.addConnection('owned', 'alice');
    context.db.exec(`CREATE TRIGGER reject_workspace_change
      BEFORE INSERT ON mobile_sync_changes
      WHEN NEW.entity_type = 'workspaceState'
      BEGIN SELECT RAISE(ABORT, 'reject workspace feed'); END`);

    assert.throws(() => context.workspaces.put(alice, {
      workspaceId: 'atomic',
      clientId: 'desktop',
      name: 'Atomic',
      state: { tabs: [{ connectionId: 'owned' }] },
    }));
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workspace_portable_identities').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM mobile_entity_versions').get().count, 0);
  } finally {
    context.cleanup();
  }
});

test('mobile route mutation context yields exactly one actor-attributed event per operation', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const deviceId = 'device-workspace-route';
    context.addConnection('owned', 'alice');
    const api = workspaceApi(context);
    assert.equal(api.adapters.has('workspaceState'), true);
    assert.deepEqual(api.bootstrapTypes, ['workspaceState']);

    const apply = (operation) => context.db.transaction(() => api.applyOperation({
      ownerUserId: alice.userId,
      user: alice,
      deviceId,
      deviceRow: { owner_user_id: alice.userId, device_id: deviceId },
      batchId: 'workspace-route-batch',
      operation,
    }))();
    const common = { entityType: 'workspaceState', entityId: 'route-workspace' };
    const created = apply({
      ...common,
      opId: 'workspace-create',
      action: 'upsert',
      baseRevision: 0,
      fieldMask: ['name', 'state'],
      payload: {
        name: 'Route workspace',
        state: { tabs: [{ connectionId: 'owned', protocol: 'SSH' }] },
      },
    });
    assert.equal(created.revision, 1);
    const updated = apply({
      ...common,
      opId: 'workspace-update',
      action: 'upsert',
      baseRevision: 1,
      fieldMask: ['name'],
      payload: { name: 'Route workspace renamed' },
    });
    assert.equal(updated.revision, 2);
    const deleted = apply({
      ...common, opId: 'workspace-delete', action: 'delete', baseRevision: 2,
    });
    assert.equal(deleted.revision, 3);
    const restored = apply({
      ...common, opId: 'workspace-restore', action: 'restore', baseRevision: 3,
    });
    assert.equal(restored.revision, 4);

    const changes = context.bridge.store.changePage(alice.userId, 0, 20).changes;
    assert.equal(changes.length, 4, 'canonical receipts prevent route fallback duplicates');
    assert.deepEqual(changes.map((change) => [change.action, change.revision]), [
      ['upsert', 1], ['upsert', 2], ['delete', 3], ['upsert', 4],
    ]);
    assert.ok(changes.every((change) => change.actorDeviceId === deviceId));
    assert.deepEqual(
      [created.changeSeq, updated.changeSeq, deleted.changeSeq, restored.changeSeq],
      changes.map((change) => change.changeSeq),
    );

    api.requireDevice = () => ({
      user: alice,
      device: { owner_user_id: alice.userId, device_id: deviceId },
    });
    const bootstrapResponse = expressResponse();
    api.handleBootstrap(
      { mobileRequestId: 'workspace-bootstrap', query: { pageSize: 500 } },
      bootstrapResponse,
    );
    const bootstrap = bootstrapResponse.body;
    assert.equal(bootstrapResponse.statusCode, 200);
    const bootstrapWorkspace = bootstrap.entities.find((row) => row.entityType === 'workspaceState');
    assert.equal(bootstrapWorkspace.entityId, 'route-workspace');
    assert.equal(bootstrapWorkspace.revision, 4);
    assert.deepEqual(bootstrapWorkspace.fieldMask, ['name', 'state']);
    assert.equal(Object.hasOwn(bootstrapWorkspace.payload, 'clientId'), false);

    const changeResponse = expressResponse();
    api.handleChanges(
      { mobileRequestId: 'workspace-changes', query: { sinceCursor: 0, limit: 20 } },
      changeResponse,
    );
    const changePage = changeResponse.body;
    assert.equal(changeResponse.statusCode, 200);
    const routeChanges = changePage.changes.filter((change) => change.entityType === 'workspaceState');
    assert.equal(routeChanges.length, 4);
    assert.equal(routeChanges.at(-1).payload.name, 'Route workspace renamed');
    assert.equal(routeChanges.at(-1).unsupported, undefined);
  } finally {
    context.cleanup();
  }
});

test('bootstrap failures preserve sendThrown status and safe JSON envelope', () => {
  const context = fresh();
  try {
    const api = workspaceApi(context);
    api.requireDevice = () => ({
      user: { userId: 'alice' },
      device: { owner_user_id: 'alice', device_id: 'device-workspace-error' },
    });
    api.adapters.get('workspaceState').list = () => {
      throw new Error('private database path C:\\secrets\\workspace.db');
    };

    const response = expressResponse();
    const returned = api.handleBootstrap(
      { mobileRequestId: 'workspace-bootstrap-error', query: { pageSize: 500 } },
      response,
    );

    assert.equal(returned, response, 'the response stub preserves Express chaining semantics');
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, {
      ok: false,
      error: {
        code: 'internal_error',
        message: '\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef',
        retryable: true,
        details: null,
        requestId: 'workspace-bootstrap-error',
      },
    });
    assert.equal(JSON.stringify(response.body).includes('private database path'), false);
  } finally {
    context.cleanup();
  }
});

test('delete, restore, retention prune, and stale GC emit durable owner tombstones', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    context.addConnection('owned', 'alice');
    context.workspaces.put(alice, {
      workspaceId: 'delete-me', clientId: 'desktop', name: 'Delete me',
      state: { tabs: [{ connectionId: 'owned' }] },
    });
    const portable = context.adapter.list(alice)[0];
    context.adapter.remove(alice, portable.workspaceId);
    assert.equal(context.adapter.read(alice, portable.workspaceId), null);
    let history = context.bridge.store.changePage('alice', 0, 200).changes;
    assert.deepEqual(history.slice(0, 2).map((change) => [change.action, change.revision]), [
      ['upsert', 1], ['delete', 2],
    ]);
    assert.equal(history[1].tombstone.ownerUserId, 'alice');
    assert.equal(history[1].tombstone.lastKnownName, 'Delete me');
    assert.equal(JSON.stringify(history[1]).includes('owned'), false);

    const restored = context.adapter.restore(alice, portable.workspaceId);
    assert.equal(restored.revision, 3);
    assert.equal(restored.workspaceId, portable.workspaceId);

    for (let index = 0; index < MAX_WORKSPACES_PER_USER; index += 1) {
      context.workspaces.put(alice, {
        workspaceId: `retention-${index}`,
        clientId: `client-${index}`,
        name: `Retention ${index}`,
        state: { tabs: [{ connectionId: 'owned' }] },
      });
    }
    assert.equal(context.workspaces.list('alice').length, MAX_WORKSPACES_PER_USER);
    assert.ok(context.db.prepare(`SELECT COUNT(*) AS count FROM workspace_portable_identities
      WHERE owner_user_id = 'alice' AND deleted_at IS NOT NULL`).get().count >= 1);

    const stale = context.workspaces.list('alice')[0];
    context.db.prepare(`UPDATE workspaces SET updated_at = 1
      WHERE user_id = ? AND client_id = ? AND workspace_id = ?`).run(
      stale.userId, stale.clientId, stale.workspaceId,
    );
    assert.equal(context.workspaces.gcStale(24 * 60 * 60 * 1000), 1);
    history = context.bridge.store.changePage('alice', 0, 500).changes;
    const deletes = history.filter((change) => change.action === 'delete');
    assert.ok(deletes.length >= 3, 'explicit delete, retention prune and GC each emit a tombstone');
    assert.ok(deletes.every((change) => change.tombstone.ownerUserId === 'alice'));
  } finally {
    context.cleanup();
  }
});
