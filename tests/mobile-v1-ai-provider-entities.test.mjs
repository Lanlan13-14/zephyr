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
const { AiProviderService } = require(path.join(root, 'ai-provider-service.js'));
const { MobileV1ChangeBridge } = require(path.join(root, 'mobile-v1-change-bridge.js'));
const {
  getAiProviderSyncCapability,
  createAiProviderEntityAdapters,
} = require(path.join(root, 'mobile-v1-ai-provider-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

const enabledRegistry = structuredClone(registry);
enabledRegistry.entities.find((entry) => entry.type === 'aiProvider').status = 'implemented-canonical-provider-service';

const fakeSecretCrypto = {
  encryptSecret(value, aad) {
    return Buffer.from(JSON.stringify({ aad, value }), 'utf8').toString('base64');
  },
  decryptSecret(value, aad) {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
    assert.equal(decoded.aad, aad);
    return decoded.value;
  },
};

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ai-provider-sync-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (userId TEXT PRIMARY KEY, isSuperAdmin INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
  `);
  let timestamp = 1_950_000_000_000;
  const bridge = new MobileV1ChangeBridge({ db, registry: enabledRegistry });
  const service = new AiProviderService(db, {
    now: () => ++timestamp,
    mobileChangeBridge: bridge,
    secretCrypto: fakeSecretCrypto,
  });
  const adapters = createAiProviderEntityAdapters({ registry: enabledRegistry, service });
  return {
    db,
    bridge,
    service,
    adapter: adapters.get('aiProvider'),
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('adapter requires both an implemented registry and an atomic canonical change feed', () => {
  const context = fresh();
  try {
    const capability = getAiProviderSyncCapability({ registry, service: context.service });
    assert.equal(capability.enabled, true);
    assert.equal(createAiProviderEntityAdapters({ registry, service: context.service }).size, 1);

    context.service.mobileChangeBridge = null;
    const withoutFeed = getAiProviderSyncCapability({ registry, service: context.service });
    assert.equal(withoutFeed.enabled, false);
    assert.equal(withoutFeed.code, 'ai_provider_capability_missing');
    assert.deepEqual(withoutFeed.missing, ['atomicChangeFeed']);
    assert.equal(createAiProviderEntityAdapters({ registry, service: context.service }).size, 0);
  } finally {
    context.cleanup();
  }
});

test('legacy provider rows migrate revisions, tombstones, and sensitive storage in place', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ai-provider-legacy-'));
  const db = createDatabase(path.join(directory, 'legacy.db'), { forceBuiltin: true });
  try {
    const canary = 'CANARY_LEGACY_PROVIDER_SECRET';
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE users (userId TEXT PRIMARY KEY, isSuperAdmin INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
      CREATE TABLE ai_providers (
        provider_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL, base_url TEXT, api_key_enc TEXT, default_model TEXT,
        models_json TEXT NOT NULL DEFAULT '[]', config_json TEXT NOT NULL DEFAULT '{}',
        visibility TEXT NOT NULL DEFAULT 'private', share_with_users INTEGER NOT NULL DEFAULT 0,
        share_with_admins INTEGER NOT NULL DEFAULT 0, shared_user_ids_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO ai_providers
      (provider_id,owner_user_id,name,type,base_url,api_key_enc,default_model,models_json,
       config_json,visibility,share_with_users,share_with_admins,shared_user_ids_json,
       enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'legacy-provider', 'alice', 'Legacy', 'openai-compatible',
      `https://user:${canary}@example.invalid/v1?access_token=${canary}`,
      fakeSecretCrypto.encryptSecret(canary, 'ai-provider:legacy-provider:apiKey'),
      'model-a', JSON.stringify([{ id: 'model-a', extra: { accessToken: canary } }]),
      JSON.stringify({ extraHeaders: canary, options: { extraJson: canary, vision: true } }),
      'private', 0, 0, '[]', 1, 10, 10,
    );

    const service = new AiProviderService(db, { secretCrypto: fakeSecretCrypto });
    const columns = new Set(db.prepare('PRAGMA table_info(ai_providers)').all().map((row) => row.name));
    assert.ok(columns.has('revision'));
    assert.ok(columns.has('deleted_at'));
    assert.ok(columns.has('secret_config_enc'));
    const durable = db.prepare(`SELECT base_url, config_json, models_json, secret_config_enc,
      revision, deleted_at FROM ai_providers WHERE provider_id=?`).get('legacy-provider');
    assert.equal(durable.base_url, 'https://example.invalid/v1');
    assert.equal(durable.revision, 1);
    assert.equal(durable.deleted_at, null);
    assert.ok(!JSON.stringify(durable).includes(canary));

    const restored = service.getOwned('alice', 'legacy-provider', { includeSecret: true });
    assert.ok(restored.baseUrl.includes(canary));
    assert.equal(restored.apiKey, canary);
    assert.equal(restored.config.extraHeaders, canary);
    assert.equal(restored.config.options.extraJson, canary);
    assert.equal(restored.models[0].extra.accessToken, canary);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical provider projection and feed never expose credentials or arbitrary config', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const canary = 'CANARY_PROVIDER_SECRET_9f12';
    context.service.create(alice, {
      id: 'provider-safe',
      name: 'Safe provider',
      type: 'openai-compatible',
      baseUrl: 'https://api.example.invalid/v1',
      apiKey: canary,
      extraHeaders: JSON.stringify({ Authorization: `Bearer ${canary}` }),
      defaultModel: 'model-a',
      models: [{
        id: 'model-a',
        label: 'Model A',
        userAgent: 'Zephyr/1',
        extra: { accessToken: canary, responseMode: 'json' },
      }],
      config: {
        apiMode: 'responses',
        organization: 'project-visible-on-web-only',
        session: canary,
        options: { vision: true, max_tokens: 4096, extraJson: JSON.stringify({ access_token: canary }) },
      },
    }, { changedSecretFields: ['apiKey'] });

    const projected = context.adapter.read(alice, 'provider-safe');
    assert.deepEqual(Object.keys(projected).filter((key) => key !== 'apiKey').sort(), [
      'baseUrl', 'config', 'createdAt', 'defaultModel', 'enabled', 'id', 'models', 'name',
      'ownerUserId', 'revision', 'shareWithAdmins', 'shareWithUsers', 'sharedUserIds',
      'type', 'updatedAt', 'visibility',
    ]);
    assert.equal(projected.apiKey, canary);
    assert.deepEqual(projected.config, {
      apiMode: 'responses',
      options: { vision: true, max_tokens: 4096 },
    });
    assert.equal(projected.models[0].userAgent, undefined);
    assert.equal(projected.models[0].extra, undefined);

    const durable = context.db.prepare(`SELECT base_url, api_key_enc, config_json,
      models_json, secret_config_enc FROM ai_providers WHERE provider_id=?`).get('provider-safe');
    assert.equal(durable.base_url, 'https://api.example.invalid/v1');
    assert.ok(durable.api_key_enc);
    assert.ok(durable.secret_config_enc);
    assert.ok(!durable.config_json.includes(canary));
    assert.ok(!durable.models_json.includes(canary));
    assert.ok(!durable.api_key_enc.includes(canary));
    assert.ok(!durable.secret_config_enc.includes(canary));

    const replacementCanary = 'CANARY_PROVIDER_REPLACEMENT_SECRET_72a1';
    const secretOnly = context.service.update(alice, 'provider-safe', {
      apiKey: replacementCanary,
    }, {
      expectedRevision: 1,
      changedSecretFields: ['apiKey'],
    });
    assert.equal(secretOnly.revision, 2);
    assert.equal(context.bridge.store.fieldRevisions('alice', 'aiProvider', 'provider-safe').get('apiKey'), 2);
    const providerChanges = context.bridge.store.changePage('alice', 0, 20).changes;
    assert.deepEqual(providerChanges[1].fieldMask, []);

    const { projectPayload } = require(path.join(root, 'mobile-v1-entities.js'));
    const spec = enabledRegistry.entities.find((entity) => entity.type === 'aiProvider');
    const wire = projectPayload(spec, projected);
    assert.equal(wire.apiKey, undefined);
    assert.equal(wire.hasApiKey, true);
    const syncState = JSON.stringify({
      wire,
      changes: providerChanges,
      outbox: context.bridge.pendingWakeEvents(),
    });
    assert.ok(!syncState.includes(canary));
    assert.ok(!syncState.includes(replacementCanary));
    assert.ok(!syncState.includes('"apiKey"'));
    assert.deepEqual(context.bridge.store.changePage('alice', 0, 20).changes[0].fieldMask.sort(), [
      'baseUrl', 'config', 'defaultModel', 'enabled', 'models', 'name', 'shareWithAdmins',
      'shareWithUsers', 'sharedUserIds', 'type', 'visibility',
    ]);
  } finally {
    context.cleanup();
  }
});

test('mobile patches preserve server-only model/config data and reject credential endpoints', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const canary = 'CANARY_EXISTING_HEADER';
    context.service.create(alice, {
      id: 'provider-preserve',
      baseUrl: 'https://api.example.invalid/v1',
      extraHeaders: canary,
      models: [{ id: 'model-a', userAgent: 'Server-UA', extra: { accessToken: canary } }],
      config: { apiMode: 'chat', options: { vision: true, extraJson: canary } },
    });

    const updated = context.adapter.update(alice, 'provider-preserve', {
      config: { apiMode: 'responses', extraHeaders: 'MOBILE_MUST_NOT_SET', options: { vision: false, extraJson: 'NO' } },
      models: [{ id: 'model-a', label: 'Renamed', extra: { refreshToken: 'NO' } }],
    });
    assert.deepEqual(updated.config, { apiMode: 'responses', options: { vision: false } });
    const canonical = context.service.getOwned('alice', 'provider-preserve', { includeSecret: true });
    assert.equal(canonical.config.extraHeaders, canary);
    assert.equal(canonical.config.options.extraJson, canary);
    assert.equal(canonical.models[0].userAgent, 'Server-UA');
    assert.equal(canonical.models[0].extra.accessToken, canary);
    assert.equal(canonical.models[0].extra.refreshToken, undefined);

    assert.throws(
      () => context.adapter.update(alice, 'provider-preserve', {
        baseUrl: 'https://user:password@example.invalid/v1?access_token=secret',
      }),
      (error) => error.code === 'ai_provider_endpoint_not_syncable',
    );
    assert.equal(context.service.getOwned('alice', 'provider-preserve').revision, 2);

    context.service.create(alice, {
      id: 'provider-server-endpoint',
      baseUrl: 'https://user:password@example.invalid/v1?access_token=server-only',
    });
    const stored = context.db.prepare('SELECT base_url FROM ai_providers WHERE provider_id=?')
      .get('provider-server-endpoint');
    assert.equal(stored.base_url, 'https://example.invalid/v1');
    assert.throws(
      () => context.adapter.read(alice, 'provider-server-endpoint'),
      (error) => error.code === 'ai_provider_endpoint_not_syncable',
    );
  } finally {
    context.cleanup();
  }
});

test('owner isolation, tombstones, restore revisions, and feed rollback are atomic', () => {
    const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    const mutationReceipt = {};
    const created = context.adapter.create(alice, 'provider-life', {
      name: 'Lifecycle', baseUrl: 'https://api.example.invalid/v1',
    }, { actorDeviceId: 'device-alice', mutationReceipt });
    assert.equal(created.revision, 1);
    assert.equal(mutationReceipt.changeSeq, 1);
    assert.equal(context.adapter.read(bob, 'provider-life'), null);
    assert.equal(context.adapter.residency(bob, 'provider-life'), 'foreign');
    assert.throws(
      () => context.adapter.create(bob, 'provider-life', { name: 'collision' }),
      (error) => error.code === 'resource_not_found_or_inaccessible',
    );

    context.adapter.remove(alice, 'provider-life');
    assert.equal(context.adapter.read(alice, 'provider-life'), null);
    assert.equal(context.adapter.residency(alice, 'provider-life'), 'owned');
    const deleted = context.service.readOwned('alice', 'provider-life', { includeDeleted: true });
    assert.equal(deleted.revision, 2);
    assert.ok(deleted.deletedAt);
    const restored = context.adapter.restore(alice, 'provider-life');
    assert.equal(restored.revision, 3);

    const changes = context.bridge.store.changePage('alice', 0, 20).changes;
    assert.equal(changes[0].actorDeviceId, 'device-alice');
    assert.deepEqual(changes.map((change) => [change.action, change.revision]), [
      ['upsert', 1], ['delete', 2], ['upsert', 3],
    ]);
    assert.ok(!JSON.stringify(changes[1].tombstone).includes('https://'));

    context.db.exec(`CREATE TRIGGER reject_provider_feed BEFORE INSERT ON mobile_sync_changes
      BEGIN SELECT RAISE(ABORT, 'feed unavailable'); END;`);
    assert.throws(
      () => context.adapter.create(alice, 'provider-rollback', { name: 'Must roll back' }),
      /feed unavailable/,
    );
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM ai_providers WHERE provider_id=?')
      .get('provider-rollback').count, 0);
  } finally {
    context.cleanup();
  }
});

test('renaming an AI provider does not stamp apiKey as a secret change', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const created = context.service.create(alice, {
      id: 'provider-rename',
      name: 'Old name',
      type: 'openai-compatible',
      baseUrl: 'https://api.example.invalid/v1',
      apiKey: 'sk-live-secret',
    });
    assert.equal(created.revision, 1);
    assert.equal(created.apiKey, undefined);
    const renamed = context.service.update(alice, 'provider-rename', { name: 'New name' });
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.apiKey, undefined);
    const revisions = context.bridge.store.fieldRevisions(alice.userId, 'aiProvider', 'provider-rename');
    assert.equal(revisions.get('name'), 2);
    assert.notEqual(revisions.get('apiKey'), 2);
    const page = context.bridge.store.changePage(alice.userId, 0, 20);
    const rename = page.changes.find((change) => change.revision === 2);
    assert.ok(rename.fieldMask.includes('name'));
    assert.ok(!rename.fieldMask.includes('apiKey'));
  } finally {
    context.cleanup();
  }
});
