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
const { UserSettingsService } = require(path.join(root, 'user-settings-service.js'));
const {
  AiKnowledgeService,
  createAiKnowledgeEntityAdapters,
} = require(path.join(root, 'mobile-v1-ai-knowledge-entities.js'));
const { executeAiToolForHost } = require(path.join(root, 'ai-agent-service.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const enabledRegistry = structuredClone(registry);
for (const entity of enabledRegistry.entities) {
  if (['aiMemory', 'aiSkill', 'aiEnv'].includes(entity.type)) {
    entity.status = 'implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection';
  }
}

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ai-knowledge-sync-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`CREATE TABLE user_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);
  let timestamp = 1_900_000_000_000;
  const now = () => ++timestamp;
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const service = new AiKnowledgeService({ db, now, mobileChangeBridge: bridge });
  const storage = {
    getSettings: () => ({
      ai: {
        enabled: true,
        permissions: { memory: true, env: true },
        memory: { enabled: true, maxItems: 500 },
        providers: [],
      },
    }),
  };
  const userSettings = new UserSettingsService(db, storage, now, {
    mobileChangeBridge: bridge,
    aiKnowledgeService: service,
  });
  return {
    db,
    bridge,
    service,
    userSettings,
    storage,
    adapters: createAiKnowledgeEntityAdapters({ service, registry: enabledRegistry }),
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('AI knowledge is account-scoped and emits only editable safe fields', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    const aliceMemory = context.service.create(alice, 'aiMemory', 'memory-1', {
      title: 'Alice deployment notes',
      content: 'Restart the blue service after approval.',
      scope: 'project',
      projects: ['zephyr'],
      tags: ['deploy'],
      connectionIds: ['conn-a'],
    });
    const bobMemory = context.service.create(bob, 'aiMemory', 'memory-1', {
      title: 'Bob notes', content: 'Do not expose this account.',
    });

    assert.equal(aliceMemory.ownerUserId, 'alice');
    assert.equal(bobMemory.ownerUserId, 'bob');
    assert.equal(context.service.read(bob, 'aiMemory', 'memory-1').title, 'Bob notes');
    assert.equal(context.service.read(alice, 'aiMemory', 'memory-1').title, 'Alice deployment notes');
    assert.equal(context.service.read(bob, 'aiMemory', 'missing'), null);
    assert.equal(context.service.residency(bob, 'aiMemory', 'memory-1'), 'owned');

    const change = context.bridge.store.changePage('alice', 0, 10).changes[0];
    assert.deepEqual(change.fieldMask.sort(), [
      'connectionIds', 'content', 'project', 'projects', 'scope', 'tags', 'title',
    ]);
    assert.equal(context.bridge.store.changePage('bob', 0, 10).changes.length, 1);
    assert.equal(context.bridge.pendingWakeEvents().length, 2);
  } finally {
    context.cleanup();
  }
});

test('Web compatibility writes feed canonical rows and runtime reads the same account view', async () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const secret = 'ENV_VALUE_CANARY_NOT_IN_SYNC';
    context.userSettings.replaceAiKnowledge(alice, {
      memories: [{ id: 'web-memory', title: 'Web memory', content: 'Written by the settings form.', enabled: false }],
      skills: [{ id: 'web-skill', name: 'Web skill', prompt: 'Be concise.', enabled: true }],
      envVars: [{ id: 'web-env', name: 'WEB_ENV', value: secret, description: 'runtime only', enabled: true, visibleToAi: true }],
    });

    const webAi = context.userSettings.effective(alice).ai;
    assert.equal(webAi.memories[0].content, 'Written by the settings form.');
    assert.equal(webAi.memories[0].enabled, false);
    assert.equal(webAi.envVars[0].value, '');
    assert.equal(webAi.envVars[0].hasValue, true);
    const runtimeAi = context.userSettings.runtimeAi(alice);
    assert.equal(runtimeAi.envVars[0].value, secret);
    assert.equal(runtimeAi.envVars[0].description, 'runtime only');
    /* A subsequent full-form save carries only the redacted Web env row.
     * It must not turn the value into an accidental clear. */
    context.userSettings.replaceAiKnowledge(alice, {
      memories: webAi.memories,
      skills: webAi.skills,
      envVars: webAi.envVars,
    });
    assert.equal(context.userSettings.runtimeAi(alice).envVars[0].value, secret);

    const changes = context.bridge.store.changePage('alice', 0, 20).changes;
    assert.deepEqual(changes.map((change) => change.entityType), ['aiMemory', 'aiSkill', 'aiEnv']);
    assert.deepEqual(changes[2].fieldMask.sort(), ['enabled', 'name', 'visibleToAi']);
    const mirrored = JSON.stringify({
      rows: context.db.prepare('SELECT payload_json FROM ai_knowledge_entities').all(),
      changes,
      outbox: context.bridge.pendingWakeEvents(),
    });
    assert.ok(!mirrored.includes(secret));

    const aiSaved = await executeAiToolForHost('memory_save', {
      title: 'AI memory', content: 'Written by the canonical AI tool.',
    }, {
      user: alice,
      confirmedToolId: 'memory_save',
      deps: { storage: context.storage, userSettingsService: context.userSettings, addActivity: () => {} },
    });
    assert.equal(aiSaved.data.memory.content, 'Written by the canonical AI tool.');
    assert.ok(context.userSettings.effective(alice).ai.memories.some((item) => item.id === aiSaved.data.memory.id));
  } finally {
    context.cleanup();
  }
});

test('Web env secret revisions make stale mobile clear and replace conflict without feed disclosure', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const initialCanary = 'WEB_ENV_INITIAL_SECRET_CANARY';
    const replacementCanary = 'WEB_ENV_REPLACEMENT_SECRET_CANARY';
    const created = context.service.writeFromWeb(alice, 'aiEnv', 'web-secret-env', {
      name: 'WEB_SECRET_ENV', enabled: true, visibleToAi: false, value: initialCanary,
    });
    assert.equal(created.revision, 1);
    assert.equal(context.bridge.store.fieldRevisions('alice', 'aiEnv', created.id).get('value'), 1);

    const updated = context.service.writeFromWeb(alice, 'aiEnv', created.id, {
      value: replacementCanary,
    }, { expectedRevision: created.revision });
    assert.equal(updated.revision, 2);
    assert.equal(context.bridge.store.fieldRevisions('alice', 'aiEnv', created.id).get('value'), 2);
    let changes = context.bridge.store.changePage('alice', 0, 20).changes;
    assert.deepEqual(changes[1].fieldMask, []);

    context.db.exec(`CREATE TRIGGER reject_web_secret_wake BEFORE INSERT ON mobile_change_outbox
      BEGIN SELECT RAISE(ABORT, 'web secret wake unavailable'); END;`);
    assert.throws(
      () => context.service.writeFromWeb(alice, 'aiEnv', created.id, {
        value: 'WEB_ENV_ROLLBACK_SECRET_CANARY',
      }, { expectedRevision: updated.revision }),
      /web secret wake unavailable/,
    );
    assert.equal(context.service.read(alice, 'aiEnv', created.id).revision, 2);
    assert.equal(context.service.listForUser(alice, 'aiEnv', { forRuntime: true })[0].value, replacementCanary);
    assert.equal(context.bridge.store.fieldRevisions('alice', 'aiEnv', created.id).get('value'), 2);
    assert.equal(context.bridge.store.changePage('alice', 0, 20).changes.length, 2);
    assert.equal(context.bridge.pendingWakeEvents().length, 2);
    context.db.exec('DROP TRIGGER reject_web_secret_wake');

    const adapter = context.adapters.get('aiEnv');
    const api = Object.create(MobileV1Api.prototype);
    api.entityByType = new Map([['aiEnv', enabledRegistry.entities.find((entity) => entity.type === 'aiEnv')]]);
    api.adapters = new Map([['aiEnv', adapter]]);
    api.store = context.bridge.store;
    let envelopesOpened = 0;
    api.openSecretEnvelopes = () => ({
      values: (envelopesOpened += 1, { value: 'MUST_NOT_OPEN' }), release() {},
    });
    const apply = (operation) => context.db.transaction(() => api.applyOperation({
      ownerUserId: alice.userId,
      user: alice,
      deviceId: 'stale-web-device',
      deviceRow: { device_id: 'stale-web-device', owner_user_id: alice.userId },
      batchId: 'web-secret-conflict-batch',
      operation,
    }))();
    const staleClear = apply({
      opId: 'stale-web-clear', entityType: 'aiEnv', entityId: created.id,
      action: 'upsert', baseRevision: 1, fieldMask: [], payload: {},
      clearSecretFields: ['value'],
    });
    const staleReplace = apply({
      opId: 'stale-web-replace', entityType: 'aiEnv', entityId: created.id,
      action: 'upsert', baseRevision: 1, fieldMask: [], payload: {},
      secretEnvelopes: { value: { opaque: true } },
    });
    assert.equal(staleClear.status, 'conflict');
    assert.equal(staleReplace.status, 'conflict');
    assert.equal(envelopesOpened, 0);

    changes = context.bridge.store.changePage('alice', 0, 20).changes;
    const publicSurface = JSON.stringify({ changes, outbox: context.bridge.pendingWakeEvents() });
    assert.ok(!publicSurface.includes(initialCanary));
    assert.ok(!publicSurface.includes(replacementCanary));
    assert.ok(!publicSurface.includes('WEB_ENV_ROLLBACK_SECRET_CANARY'));
    assert.ok(!publicSurface.includes('"value"'));
  } finally {
    context.cleanup();
  }
});

test('ownerless legacy AI arrays are not auto-migrated or copied across accounts', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    const legacy = {
      memories: [{ id: 'legacy-memory', title: 'legacy', content: 'only explicit owner may claim this' }],
      skills: [{ id: 'legacy-skill', name: 'legacy', prompt: 'legacy prompt' }],
      envVars: [{ id: 'legacy-env', name: 'LEGACY_ENV', value: 'legacy-secret' }],
    };
    assert.deepEqual(context.userSettings.effective(alice).ai.memories, []);
    assert.deepEqual(context.userSettings.effective(bob).ai.envVars, []);
    assert.throws(
      () => context.service.migrateLegacyForOwner(bob, legacy, { legacyOwnerUserId: 'alice' }),
      (error) => error.code === 'legacy_ai_owner_required',
    );
    assert.equal(context.service.list(alice, 'aiMemory').length, 0);
    context.service.migrateLegacyForOwner(alice, legacy, { legacyOwnerUserId: 'alice' });
    assert.equal(context.userSettings.effective(alice).ai.memories[0].id, 'legacy-memory');
    assert.deepEqual(context.userSettings.effective(bob).ai.memories, []);
    assert.equal(context.userSettings.runtimeAi(alice).envVars[0].value, 'legacy-secret');
  } finally {
    context.cleanup();
  }
});

test('skill revisions are monotonic, conflict-aware, and no-op retries are cursor-idempotent', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const created = context.service.create(alice, 'aiSkill', 'skill-1', {
      name: 'Summarize', description: 'Short summaries', prompt: 'Use bullets.', enabled: true,
    });
    const updated = context.service.update(alice, 'aiSkill', 'skill-1', { prompt: 'Use concise bullets.' }, {
      expectedRevision: created.revision,
    });
    assert.equal(updated.revision, 2);
    const cursor = context.bridge.store.latestCursor('alice');
    assert.throws(
      () => context.service.update(alice, 'aiSkill', 'skill-1', { name: 'stale' }, { expectedRevision: 1 }),
      (error) => error.code === 'revision_conflict',
    );
    assert.equal(context.bridge.store.latestCursor('alice'), cursor);

    const replay = context.service.update(alice, 'aiSkill', 'skill-1', { prompt: 'Use concise bullets.' }, {
      expectedRevision: updated.revision,
    });
    assert.equal(replay.revision, updated.revision);
    assert.equal(context.bridge.store.latestCursor('alice'), cursor);

    const adapter = context.adapters.get('aiSkill');
    assert.equal(adapter.read({ userId: 'bob' }, 'skill-1'), null);
  } finally {
    context.cleanup();
  }
});

test('environment sync fails closed around values, API keys, tool secrets, and unsafe names', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const canary = 'CANARY_env_value_api_key_tool_secret';
    for (const [index, forbidden] of [
      { name: 'SAFE_NAME', value: canary },
      { name: 'SAFE_NAME', apiKey: canary },
      { name: 'SAFE_NAME', toolSecret: canary },
      { name: 'BAD-NAME', enabled: true },
    ].entries()) {
      assert.throws(
        () => context.service.create(alice, 'aiEnv', `env-rejected-${index}`, forbidden),
        (error) => error.code === 'invalid_ai_knowledge',
      );
    }
    assert.equal(context.bridge.store.latestCursor('alice'), 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM ai_knowledge_entities').get().count, 0);

    const env = context.service.create(alice, 'aiEnv', 'env-1', {
      name: 'SAFE_NAME', enabled: true, visibleToAi: false,
    });
    const projected = context.service.read(alice, 'aiEnv', env.id);
    assert.deepEqual(Object.keys(projected).sort(), [
      'createdAt', 'enabled', 'id', 'name', 'ownerUserId', 'revision', 'updatedAt', 'visibleToAi',
    ]);
    const serialized = JSON.stringify({
      row: projected,
      changes: context.bridge.store.changePage('alice', 0, 10),
      outbox: context.bridge.pendingWakeEvents(),
    });
    assert.ok(!serialized.includes(canary));
    assert.deepEqual(context.bridge.store.changePage('alice', 0, 10).changes[0].fieldMask.sort(), [
      'enabled', 'name', 'visibleToAi',
    ]);
  } finally {
    context.cleanup();
  }
});

test('mobile env envelopes use the canonical ciphertext store without a secret feed field', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const adapter = context.adapters.get('aiEnv');
    const receipt = {};
    const canary = 'MOBILE_ENV_ENVELOPE_CANARY';
    const created = adapter.create(alice, 'mobile-env', {
      name: 'MOBILE_ENV', enabled: true, visibleToAi: false, value: canary,
    }, { actorDeviceId: 'device-a', mutationReceipt: receipt });
    assert.equal(created.revision, 1);
    assert.ok(receipt.changeSeq > 0);
    assert.equal(context.service.listForUser(alice, 'aiEnv')[0].value, '');
    assert.equal(context.service.listForUser(alice, 'aiEnv', { forRuntime: true })[0].value, canary);

    const secretOnlyReceipt = {};
    const updated = adapter.update(alice, created.id, {
      name: 'MOBILE_ENV', value: `${canary}_UPDATED`,
    }, { actorDeviceId: 'device-a', mutationReceipt: secretOnlyReceipt });
    assert.equal(updated.revision, 2);
    assert.equal(secretOnlyReceipt.handled, true);
    assert.equal(context.bridge.store.changePage('alice', 0, 10).changes.length, 1);

    const mirrored = JSON.stringify({
      canonical: context.db.prepare('SELECT payload_json FROM ai_knowledge_entities').all(),
      feed: context.bridge.store.changePage('alice', 0, 10),
      outbox: context.bridge.pendingWakeEvents(),
    });
    assert.ok(!mirrored.includes(canary));
    assert.deepEqual(context.bridge.store.changePage('alice', 0, 10).changes[0].fieldMask.sort(), [
      'enabled', 'name', 'visibleToAi',
    ]);
  } finally {
    context.cleanup();
  }
});

test('pure-secret clear and replace are atomic, conflict-aware, and replay-idempotent', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const adapter = context.adapters.get('aiEnv');
    const initialCanary = 'INITIAL_ENV_SECRET_CANARY';
    const replacementCanary = 'REPLACEMENT_ENV_SECRET_CANARY';
    const created = adapter.create(alice, 'atomic-env', {
      name: 'ATOMIC_ENV', enabled: true, visibleToAi: false, value: initialCanary,
    });

    const api = Object.create(MobileV1Api.prototype);
    api.entityByType = new Map([['aiEnv', enabledRegistry.entities.find((entity) => entity.type === 'aiEnv')]]);
    api.adapters = new Map([['aiEnv', adapter]]);
    api.store = context.bridge.store;
    let envelopesOpened = 0;
    api.openSecretEnvelopes = ({ envelopes }) => ({
      values: envelopes ? (envelopesOpened += 1, { value: replacementCanary }) : {},
      release() {},
    });

    const apply = (operation) => context.db.transaction(() => api.applyOperation({
      ownerUserId: alice.userId,
      user: alice,
      deviceId: 'device-alice',
      deviceRow: { device_id: 'device-alice', owner_user_id: alice.userId },
      batchId: 'batch-secret-atomic',
      operation,
    }))();
    const clearOperation = {
      opId: 'clear-env-value', entityType: 'aiEnv', entityId: created.id,
      action: 'upsert', baseRevision: created.revision, fieldMask: [], payload: {},
      clearSecretFields: ['value'],
    };

    const cleared = apply(clearOperation);
    assert.equal(cleared.status, 'accepted');
    assert.equal(cleared.revision, 2);
    assert.equal(context.service.listForUser(alice, 'aiEnv', { forRuntime: true })[0].value, '');
    let changes = context.bridge.store.changePage(alice.userId, 0, 20).changes;
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[1].fieldMask, [], 'secret field names never enter the public feed mask');
    assert.equal(context.bridge.pendingWakeEvents().length, 2, 'clear must enqueue a payload-free wake');
    assert.equal(context.bridge.store.fieldRevisions(alice.userId, 'aiEnv', created.id).get('value'), 2);

    const replayedClear = apply(clearOperation);
    assert.equal(replayedClear.status, 'duplicate');
    assert.equal(replayedClear.changeSeq, cleared.changeSeq);
    assert.equal(context.bridge.store.changePage(alice.userId, 0, 20).changes.length, 2);
    assert.equal(context.bridge.pendingWakeEvents().length, 2);

    const staleReplace = {
      opId: 'stale-replace-env-value', entityType: 'aiEnv', entityId: created.id,
      action: 'upsert', baseRevision: 1, fieldMask: [], payload: {},
      secretEnvelopes: { value: { opaque: true } },
    };
    const conflict = apply(staleReplace);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.revision, 2);
    assert.deepEqual(conflict.conflict.fields, ['value']);
    assert.equal(conflict.conflict.serverPayload.value, undefined);
    assert.equal(envelopesOpened, 0, 'a stale envelope must conflict before decryption');
    assert.equal(apply(staleReplace).status, 'conflict', 'conflict retries keep the original logical result');

    const replaceOperation = {
      opId: 'replace-env-value', entityType: 'aiEnv', entityId: created.id,
      action: 'upsert', baseRevision: 2, fieldMask: [], payload: {},
      secretEnvelopes: { value: { opaque: true } },
    };
    context.db.exec(`CREATE TRIGGER reject_secret_wake BEFORE INSERT ON mobile_change_outbox
      BEGIN SELECT RAISE(ABORT, 'secret wake unavailable'); END;`);
    assert.throws(() => apply(replaceOperation), /secret wake unavailable/);
    assert.equal(context.service.read(alice, 'aiEnv', created.id).revision, 2,
      'failed outbox insert must roll the canonical revision back');
    assert.equal(context.service.listForUser(alice, 'aiEnv', { forRuntime: true })[0].value, '',
      'failed outbox insert must roll the authoritative secret back');
    assert.equal(context.bridge.store.changePage(alice.userId, 0, 20).changes.length, 2);
    assert.equal(context.bridge.pendingWakeEvents().length, 2);
    assert.equal(context.bridge.store.findAppliedOp(alice.userId, 'device-alice', replaceOperation.opId), null);

    context.db.exec('DROP TRIGGER reject_secret_wake');
    const replaced = apply(replaceOperation);
    assert.equal(replaced.status, 'accepted');
    assert.equal(replaced.revision, 3);
    assert.equal(context.service.listForUser(alice, 'aiEnv', { forRuntime: true })[0].value, replacementCanary);
    changes = context.bridge.store.changePage(alice.userId, 0, 20).changes;
    assert.equal(changes.length, 3);
    assert.deepEqual(changes[2].fieldMask, []);
    assert.equal(context.bridge.pendingWakeEvents().length, 3);
    assert.equal(context.bridge.store.fieldRevisions(alice.userId, 'aiEnv', created.id).get('value'), 3);

    const replayedReplace = apply(replaceOperation);
    assert.equal(replayedReplace.status, 'duplicate');
    assert.equal(replayedReplace.changeSeq, replaced.changeSeq);
    const publicArtifacts = JSON.stringify({
      cleared, conflict, replaced, changes,
      outbox: context.bridge.pendingWakeEvents(),
    });
    assert.ok(!publicArtifacts.includes(initialCanary));
    assert.ok(!publicArtifacts.includes(replacementCanary));
    assert.ok(!publicArtifacts.includes('opaque'));
  } finally {
    context.cleanup();
  }
});

test('deletion creates a content-free tombstone and restore advances revision', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const memory = context.service.create(alice, 'aiMemory', 'memory-delete', {
      title: 'Private memory', content: 'CONTENT_CANARY_NEVER_IN_TOMBSTONE',
    });
    context.service.remove(alice, 'aiMemory', memory.id, { expectedRevision: memory.revision });
    const deleted = context.service.read(alice, 'aiMemory', memory.id, { includeDeleted: true });
    assert.equal(deleted.revision, 2);
    assert.ok(deleted.deletedAt);
    const history = context.bridge.store.changePage('alice', 0, 10).changes;
    assert.deepEqual(history.map((item) => [item.action, item.revision]), [['upsert', 1], ['delete', 2]]);
    assert.equal(history[1].tombstone.lastKnownName, 'Private memory');
    assert.ok(!JSON.stringify(history[1]).includes('CONTENT_CANARY_NEVER_IN_TOMBSTONE'));

    const restored = context.service.restore(alice, 'aiMemory', memory.id, { expectedRevision: deleted.revision });
    assert.equal(restored.revision, 3);
    assert.equal(restored.content, 'CONTENT_CANARY_NEVER_IN_TOMBSTONE');
  } finally {
    context.cleanup();
  }
});

test('feed/outbox failures roll back the canonical AI row in the same transaction', () => {
  const context = fresh();
  try {
    context.db.exec(`CREATE TRIGGER reject_ai_knowledge_change BEFORE INSERT ON mobile_sync_changes
      BEGIN SELECT RAISE(ABORT, 'feed unavailable'); END;`);
    assert.throws(
      () => context.service.create({ userId: 'alice' }, 'aiSkill', 'skill-atomic', {
        name: 'Atomic', prompt: 'This write must roll back.',
      }),
      /feed unavailable/,
    );
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM ai_knowledge_entities').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, 0);
  } finally {
    context.cleanup();
  }
});
