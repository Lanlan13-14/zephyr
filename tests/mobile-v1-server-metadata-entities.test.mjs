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
const { MobileV1Store } = require(path.join(root, 'mobile-v1-store.js'));
const { MobileV1Api } = require(path.join(root, 'mobile-v1-routes.js'));
const {
  CAPABILITIES,
  SERVER_SETTINGS_SECTION,
  createServerMetadataEntityAdapters,
  createServerMetadataServices,
  getServerMetadataSyncCapability,
  recordActivityEvent,
} = require(path.join(root, 'mobile-v1-server-metadata-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

const serviceCapabilities = Object.freeze({
  safeProjection: true,
  stableRevisions: true,
  ownerScopedReads: true,
  atomicChangeFeed: true,
});

function adapterFixtureRegistry() {
  const fixture = JSON.parse(JSON.stringify(registry));
  const serverSettings = fixture.entities.find((entity) => entity.type === 'serverSettings');
  assert.ok(serverSettings, 'serverSettings must be declared by the production registry');
  /* Projection and CAS tests exercise the adapter contract in isolation. The
   * production registry must remain blocked until server-global settings have
   * a scope-preserving change-feed design. */
  serverSettings.status = 'implemented-test-fixture';
  return fixture;
}

function parseStoredValue(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function createContext(grants = new Set(), entityRegistry = adapterFixtureRegistry()) {
  const settings = {
    appearance: {
      brandName: 'Zephyr', theme: 'dark', customCss: 'body { display:none }', customJs: 'steal()',
      brandIcon: 'data:image/png;base64,canary-icon', smtpPass: 'canary-smtp',
      terminalBackground: { type: 'url', url: 'https://user:pass@example.test/canary', fit: 'cover' },
    },
    notes: { enabled: true, storagePath: 'C:/private/notes' },
    ai: {
      enabled: true,
      permissions: { fileRead: true, token: 'canary-permission-token' },
      context: { windowTokens: 4, apiKey: 'canary-context-key' },
      memory: { enabled: true, maxItems: 10 },
      token: 'canary-ai-token',
    },
    security: { password: 'canary-security' },
    mail: { host: 'smtp.example', pass: 'canary-mail' },
    captcha: { secretKey: 'canary-captcha' },
  };
  const backups = [{
    backupId: 'backup-1', serverId: 'server-1', revision: 3, createdAt: 100, size: 8,
    sha256: 'a'.repeat(64), appVersion: '3.0', encryptionAlgorithm: 'AES-256-GCM', jobStatus: 'complete',
    label: 'Nightly', retentionHint: '30 days', backupKey: 'canary-backup-key', archivePath: 'C:/private/archive',
  }];
  const events = [
    {
      id: 'alice-event', userId: 'alice', time: 200,
      message: 'Login 192.0.2.8 SID=canary-sid token=canary-token Bearer canary-bearer user-agent=canary-ua C:/hidden https://user:pass@example.test/x',
      type: 'info', sourceIp: '192.0.2.8', actor: 'bob', target: 'C:/hidden', durationMs: 4,
      category: 'account', outcome: 'ok', protocol: 'SSH', connectionId: 'conn-1',
    },
    { id: 'bob-event', userId: 'bob', time: 201, message: 'Bob private', sourceIp: '198.51.100.2' },
  ];
  const updates = [];
  const adapters = createServerMetadataEntityAdapters({
    registry: entityRegistry,
    serverId: 'server-1',
    authorize: (user, capability) => grants.has(`${user.userId}:${capability}`),
    serverSettings: {
      mobileSyncCapabilities: serviceCapabilities,
      readServerSettings: () => ({
        sectionKey: SERVER_SETTINGS_SECTION,
        serverId: 'server-1',
        settings,
        revision: 7,
        updatedAt: 99,
      }),
      updateServerSettings: (patch, context) => {
        updates.push({ patch, context });
        return {
          sectionKey: SERVER_SETTINGS_SECTION,
          serverId: 'server-1',
          settings: {
            ...settings,
            appearance: { ...settings.appearance, ...(patch.appearance || {}) },
            ai: { ...settings.ai, ...(patch.ai || {}) },
          },
          revision: 8,
          updatedAt: 101,
        };
      },
    },
    /* Even a superficially complete seam must remain disabled while the
     * production registry says blocked-no-durable-job-metadata-layer. */
    backupMetadata: {
      mobileSyncCapabilities: serviceCapabilities,
      listBackupMetadata: () => backups,
      readBackupMetadata: (id) => backups.find((row) => row.backupId === id) || null,
      updateBackupMetadata: (id, patch, context) => {
        updates.push({ patch, context });
        return { ...backups.find((row) => row.backupId === id), ...patch, revision: 4 };
      },
    },
    activityEvents: {
      mobileSyncCapabilities: serviceCapabilities,
      listActivityEventsForUser: (userId) => events.filter((row) => row.userId === userId),
      readActivityEventForUser: (userId, id) => events.find((row) => row.userId === userId && row.id === id) || null,
    },
  });
  return { adapters, updates };
}

test('server metadata is fail-closed and allow-list projections contain no credentials or request identity', () => {
  const all = new Set([
    `alice:${CAPABILITIES.SETTINGS_READ}`,
    `alice:${CAPABILITIES.SETTINGS_UPDATE}`,
    `alice:${CAPABILITIES.SETTINGS_AI_UPDATE}`,
    `alice:${CAPABILITIES.BACKUP_READ}`,
    `alice:${CAPABILITIES.BACKUP_UPDATE}`,
    `alice:${CAPABILITIES.ACTIVITY_READ}`,
  ]);
  const ctx = createContext(all);
  const alice = { userId: 'alice', role: 'admin', status: 'active' };
  const bob = { userId: 'bob', role: 'admin', status: 'active' };

  assert.equal(ctx.adapters.has('backupMetadata'), false, 'registry-blocked backup job metadata is not wired');
  const server = ctx.adapters.get('serverSettings').list(alice);
  const activity = ctx.adapters.get('activityEvent').list(alice);
  const serialized = JSON.stringify({ server, activity });
  for (const canary of [
    'canary-smtp', 'canary-ai-token', 'canary-security', 'canary-mail', 'canary-captcha',
    'canary-permission-token', 'canary-context-key', 'canary-icon', 'C:/private', 'C:/hidden',
    '192.0.2.8', 'canary-sid', 'canary-token', 'canary-bearer', 'canary-ua', 'user:pass',
  ]) {
    assert.ok(!serialized.includes(canary), `must not project ${canary}`);
  }
  assert.equal(server[0].sectionKey, 'default');
  assert.equal(server[0].serverId, 'server-1');
  assert.equal(server[0].appearance.customCss, undefined);
  assert.equal(server[0].appearance.terminalBackground.url, undefined);
  assert.deepEqual(activity.map((row) => row.id), ['alice-event']);
  assert.equal(activity[0].sourceIp, undefined);
  assert.equal(activity[0].actor, undefined);
  assert.equal(activity[0].target, undefined);
  assert.equal(activity[0].durationMs, undefined);
  assert.equal(ctx.adapters.get('activityEvent').read(bob, 'alice-event'), null, 'cross-account reads are absent');
  assert.deepEqual(ctx.adapters.get('serverSettings').list(bob), [], 'missing capability is not inferred from role');
});

test('only explicit server settings fields mutate and AI runtime policy has a separate privilege gate', () => {
  const base = new Set([
    `alice:${CAPABILITIES.SETTINGS_READ}`,
    `alice:${CAPABILITIES.SETTINGS_UPDATE}`,
    `alice:${CAPABILITIES.ACTIVITY_READ}`,
  ]);
  const ctx = createContext(base);
  const user = { userId: 'alice' };
  const adapter = ctx.adapters.get('serverSettings');

  adapter.update(user, SERVER_SETTINGS_SECTION, {
    appearance: { theme: 'light', customCss: 'nope', password: 'nope' },
    security: { ipWhitelist: ['0.0.0.0/0'] },
  });
  assert.equal(ctx.updates[0].patch.appearance.theme, 'light');
  assert.equal(ctx.updates[0].patch.appearance.customCss, undefined);
  assert.equal(ctx.updates[0].patch.security, undefined);
  assert.equal(ctx.updates[0].context.source, 'mobile');

  assert.throws(
    () => adapter.update(user, SERVER_SETTINGS_SECTION, { appearance: { customCss: 'takeover' } }),
    (error) => error.code === 'unsupported_scope',
    'an allowed root containing only excluded children must not allocate a revision',
  );

  assert.throws(
    () => adapter.update(user, SERVER_SETTINGS_SECTION, { ai: { enabled: false } }),
    (error) => error.code === 'resource_not_found_or_inaccessible',
  );
  base.add(`alice:${CAPABILITIES.SETTINGS_AI_UPDATE}`);
  adapter.update(user, SERVER_SETTINGS_SECTION, {
    ai: { enabled: false, permissions: { fileRead: false, token: 'takeover' } },
  });
  assert.deepEqual(ctx.updates[1].patch.ai, { enabled: false, permissions: { fileRead: false } });
  assert.throws(() => adapter.remove(user, SERVER_SETTINGS_SECTION), (error) => error.code === 'unsupported_scope');
  for (const method of ['create', 'update', 'remove']) {
    assert.throws(() => ctx.adapters.get('activityEvent')[method](user, 'alice-event', {}), (error) => error.code === 'unsupported_scope');
  }
});

test('blocked or incomplete entity declarations do not install adapters', () => {
  for (const entityType of ['serverSettings', 'backupMetadata']) {
    const blocked = getServerMetadataSyncCapability({
      registry,
      entityType,
      service: { mobileSyncCapabilities: serviceCapabilities },
    });
    assert.equal(blocked.enabled, false, `${entityType} remains blocked in production`);
    assert.equal(blocked.code, 'server_metadata_registry_blocked');
  }

  const incomplete = getServerMetadataSyncCapability({
    registry: adapterFixtureRegistry(),
    entityType: 'serverSettings',
    service: {
      mobileSyncCapabilities: { ...serviceCapabilities, atomicChangeFeed: false },
      readServerSettings() {},
      updateServerSettings() {},
    },
  });
  assert.equal(incomplete.enabled, false);
  assert.deepEqual(incomplete.missing, ['atomicChangeFeed']);
});

test('canonical settings and activity services write fixture owner feed rows atomically and survive reconstruction', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-server-metadata-service-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE activities (
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, message TEXT NOT NULL, type TEXT,
        userId TEXT, sourceIp TEXT, durationMs INTEGER, category TEXT, outcome TEXT,
        actor TEXT, protocol TEXT, target TEXT, connectionId TEXT
      );
    `);
    const initial = {
      appearance: { brandName: 'Zephyr', theme: 'dark', customCss: 'server-only' },
      notes: { enabled: false, storagePath: 'C:/server-only' },
      ai: { enabled: true, permissions: { fileRead: true }, context: { windowTokens: 64 }, memory: { enabled: true, maxItems: 10 } },
      mail: { pass: 'server-only-secret' },
    };
    for (const [key, value] of Object.entries(initial)) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    }
    const storage = {
      getSettings: () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, parseStoredValue(row.value)])),
      updateSettings: (patch) => {
        const current = storage.getSettings();
        for (const [key, value] of Object.entries(patch || {})) {
          const next = value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(current[key] || {}), ...value }
            : value;
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(next));
        }
        return storage.getSettings();
      },
      addActivity: (row) => db.prepare(`INSERT INTO activities
        (id,time,message,type,userId,sourceIp,durationMs,category,outcome,actor,protocol,target,connectionId)
        VALUES (@id,@time,@message,@type,@userId,@sourceIp,@durationMs,@category,@outcome,@actor,@protocol,@target,@connectionId)`).run({
          type: 'info', userId: null, sourceIp: null, durationMs: null, category: null, outcome: null,
          actor: null, protocol: null, target: null, connectionId: null, ...row,
        }),
    };
    const bridge = new MobileV1ChangeBridge({ db, registry: adapterFixtureRegistry() });
    const services = createServerMetadataServices({ db, storage, changeBridge: bridge, now: () => 1_000 });

    const receipt = {};
    assert.throws(
      () => services.serverSettings.updateServerSettings(
        { appearance: { theme: 'light' } },
        { actorUserId: 'alice', expectedRevision: 9 },
      ),
      (error) => error.code === 'revision_conflict',
      'fixture adapter path preserves compare-and-swap semantics',
    );
    const updated = services.serverSettings.updateServerSettings(
      { appearance: { theme: 'light', customCss: 'mobile-takeover' } },
      { actorUserId: 'alice', actorDeviceId: 'device-1', mutationReceipt: receipt },
    );
    assert.equal(updated.revision, 2);
    assert.ok(receipt.changeSeq > 0);
    assert.equal(storage.getSettings().appearance.customCss, 'server-only', 'opaque server value is preserved');

    services.activityEvents.appendActivityEvent({
      id: 'event-1', userId: 'alice', time: 1_001, message: 'SSH token=canary at 203.0.113.9',
      type: 'info', sourceIp: '203.0.113.9', actor: 'alice', target: 'server.internal',
    });
    const safeEvent = services.activityEvents.readActivityEventForUser('alice', 'event-1');
    assert.equal(safeEvent.sourceIp, undefined, 'narrow service query never retrieves source IP');
    assert.equal(safeEvent.actor, undefined, 'narrow service query never retrieves actor/UA-adjacent identity');
    assert.equal(bridge.store.changePage('alice', 0, 10).changes.length, 2);
    assert.equal(bridge.store.changePage('bob', 0, 10).changes.length, 0);

    const rebuilt = createServerMetadataServices({ db, storage, changeBridge: bridge });
    assert.equal(rebuilt.serverSettings.readServerSettings().revision, 2, 'revision survives runtime rebuild');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('central MobileV1Api excludes registry-blocked server metadata from bootstrap', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-server-metadata-api-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE activities (
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, message TEXT NOT NULL, type TEXT,
        userId TEXT, sourceIp TEXT, durationMs INTEGER, category TEXT, outcome TEXT,
        actor TEXT, protocol TEXT, target TEXT, connectionId TEXT
      );
    `);
    for (const [key, value] of Object.entries({
      appearance: { brandName: 'Zephyr', theme: 'dark' },
      notes: { enabled: true },
      ai: { enabled: false, permissions: {}, context: {}, memory: { enabled: false, maxItems: 0 } },
    })) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    const storage = {
      rawDb: () => db,
      getSettings: () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, parseStoredValue(row.value)])),
      updateSettings: (patch) => {
        const current = storage.getSettings();
        for (const [key, value] of Object.entries(patch || {})) {
          const next = value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(current[key] || {}), ...value }
            : value;
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(next));
        }
        return storage.getSettings();
      },
      addActivity: () => {},
    };
    const store = new MobileV1Store({ db, entityRegistry: registry });
    const bridge = new MobileV1ChangeBridge({ db, store, registry });
    const services = createServerMetadataServices({ db, storage, changeBridge: bridge });
    const api = new MobileV1Api({
      db,
      storage,
      store,
      changeBridge: bridge,
      entityRegistry: registry,
      resourceService: {},
      notesService: null,
      serverMetadataServices: { serverSettings: services.serverSettings },
      serverMetadataAuthorize: (user, capability) => user.status === 'active'
        && [
          CAPABILITIES.SETTINGS_READ,
          CAPABILITIES.SETTINGS_UPDATE,
          CAPABILITIES.SETTINGS_AI_UPDATE,
          CAPABILITIES.ACTIVITY_READ,
        ].includes(capability),
      shared: {},
      blobs: {},
      wake: {},
    });
    assert.equal(api.adapters.has('serverSettings'), false);
    assert.equal(api.adapters.has('activityEvent'), false);
    assert.equal(api.adapters.has('backupMetadata'), false);
    assert.ok(!api.bootstrapTypes.includes('serverSettings'),
      'blocked server-global settings never enter a user bootstrap feed');
    assert.ok(!api.bootstrapTypes.includes('backupMetadata'),
      'blocked job metadata never enters a user bootstrap feed');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('server-side activity appends advance only the owner cursor and cannot be forged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-server-metadata-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  try {
    const bridge = new MobileV1ChangeBridge({ db, registry });
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    const recorded = recordActivityEvent(bridge, alice, {
      id: 'event-1', userId: 'alice', time: 500, message: 'SSH from 2001:db8::1', sourceIp: '2001:db8::1', target: 'hidden', revision: 500,
    });
    assert.equal(recorded.revision, 500);
    assert.equal(bridge.store.latestCursor('alice'), recorded.changeSeq);
    assert.equal(bridge.store.latestCursor('bob'), 0);
    const change = bridge.store.changePage('alice', 0, 10).changes[0];
    assert.equal(change.entityType, 'activityEvent');
    assert.deepEqual(change.fieldMask, []);
    assert.equal(change.action, 'upsert');
    assert.equal(bridge.store.changePage('bob', 0, 10).changes.length, 0);
    assert.throws(
      () => recordActivityEvent(bridge, bob, { id: 'event-2', userId: 'alice', time: 501, message: 'forged' }),
      /must belong to its owner/,
    );
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
