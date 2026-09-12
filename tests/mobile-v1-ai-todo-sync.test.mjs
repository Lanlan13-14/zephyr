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
const { UserSettingsService } = require(path.join(root, 'user-settings-service.js'));
const {
  AiKnowledgeService,
  createAiKnowledgeEntityAdapters,
} = require(path.join(root, 'mobile-v1-ai-knowledge-entities.js'));

/* aiTodo (standard todo list, PR #129) rides the same AiKnowledgeService
 * channel as aiMemory/aiSkill/aiEnv: account-scoped rows, revision bumps,
 * tombstones, and a change feed the mobile sync engine consumes through the
 * generated entity adapters. This suite pins the sync-facing contract. */

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const enabledRegistry = structuredClone(registry);
for (const entity of enabledRegistry.entities) {
  if (['aiMemory', 'aiSkill', 'aiEnv', 'aiTodo'].includes(entity.type)) {
    entity.status = 'implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection';
  }
}

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ai-todo-sync-'));
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

const TODO_SPEC = registry.entities.find((e) => e.type === 'aiTodo');

test('aiTodo is a registered sync entity with todo-safe editable fields', () => {
  assert.ok(TODO_SPEC, 'entity-registry must declare aiTodo');
  assert.equal(TODO_SPEC.deleteMode, 'tombstone');
  assert.equal(TODO_SPEC.ownerField, 'ownerUserId');
  assert.deepEqual(TODO_SPEC.secretFields, []);
  for (const field of ['title', 'status', 'priority', 'dueAt', 'steps', 'note', 'source']) {
    assert.ok(TODO_SPEC.editableFields.includes(field), `editableFields must include ${field}`);
  }
});

test('aiTodo rows are account-scoped, revisioned, and feed the change bridge', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };

    const created = context.service.create(alice, 'aiTodo', 'todo-1', {
      title: '检查磁盘',
      status: 'pending',
      priority: 'high',
      dueAt: 1770000000000,
      steps: [{ id: 'step-1', title: 'df -h', done: false }],
      source: 'web',
    });
    assert.equal(created.ownerUserId, 'alice');
    assert.equal(created.revision, 1);

    // account isolation
    assert.equal(context.service.read(bob, 'aiTodo', 'todo-1'), null);

    // status transition bumps revision and emits an upsert change
    const updated = context.service.writeFromMobile(alice, 'aiTodo', 'todo-1', { status: 'in_progress' });
    assert.equal(updated.revision, 2);
    const feed = context.bridge.store.changePage(alice.userId, 0, 50).changes
      .filter((change) => change.entityType === 'aiTodo');
    assert.equal(feed.length, 2);
    assert.deepEqual(feed.map((change) => change.revision).sort(), [1, 2]);

    // tombstone delete (remove() writes the tombstone; verify via includeDeleted read)
    context.service.remove(alice, 'aiTodo', 'todo-1', { expectedRevision: 2 });
    const tombstone = context.service.read(alice, 'aiTodo', 'todo-1', { includeDeleted: true });
    assert.equal(tombstone.deletedAt !== null, true);
    assert.equal(context.service.read(alice, 'aiTodo', 'todo-1'), null);
  } finally {
    context.cleanup();
  }
});

test('generated adapters expose aiTodo with the canonical CRUD surface', () => {
  const context = fresh();
  try {
    const adapter = context.adapters.get('aiTodo');
    assert.ok(adapter, 'createAiKnowledgeEntityAdapters must include aiTodo');

    const alice = { userId: 'alice' };
    adapter.create(alice, 'todo-a', {
      title: '通过适配器创建',
      steps: [{ id: 'step-1', title: '第一步', done: false }],
      source: 'ai',
    });
    const row = adapter.read(alice, 'todo-a');
    assert.equal(row.title, '通过适配器创建');
    assert.equal(row.source, 'ai');
    assert.deepEqual(row.steps, [{ id: 'step-1', title: '第一步', done: false }]);

    adapter.update(alice, 'todo-a', { status: 'completed' });
    assert.equal(adapter.read(alice, 'todo-a').status, 'completed');
    assert.equal(adapter.read(alice, 'todo-a').revision, 2);

    adapter.remove(alice, 'todo-a');
    assert.equal(adapter.read(alice, 'todo-a'), null);

    adapter.restore(alice, 'todo-a');
    const restored = adapter.read(alice, 'todo-a');
    assert.equal(restored.status, 'completed');
    assert.ok(restored.deletedAt === null || restored.deletedAt === undefined);

    // listOwnedForSync must enumerate only non-deleted rows for the owner
    adapter.create(alice, 'todo-b', { title: '第二条' });
    adapter.remove(alice, 'todo-b');
    const synced = adapter.list(alice).map((row) => row.id);
    assert.ok(synced.includes('todo-a'));
    assert.ok(!synced.includes('todo-b'));
  } finally {
    context.cleanup();
  }
});

test('normalization rejects malformed todo payloads and caps collections', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    assert.throws(() => context.service.create(alice, 'aiTodo', 'bad-1', { title: 'x', status: 'wat' }));
    assert.throws(() => context.service.create(alice, 'aiTodo', 'bad-2', { title: 'x', priority: 'mega' }));
    assert.throws(() => context.service.create(alice, 'aiTodo', 'bad-3', { title: '  ' }));
    assert.throws(() => context.service.create(alice, 'aiTodo', 'bad-4', { title: 'x', dueAt: -5 }));
    const tooManySteps = { title: 'x', steps: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, title: `t${i}` })) };
    assert.throws(() => context.service.create(alice, 'aiTodo', 'bad-5', tooManySteps));

    const ok = context.service.create(alice, 'aiTodo', 'ok-1', {
      title: '合法待办',
      dueAt: null,
      steps: [{ id: 'a', title: '唯一', done: true }, { id: 'a', title: '重复id被去重', done: false }, { title: '' }],
    });
    assert.equal(ok.dueAt, null);
    assert.equal(ok.steps.length, 1);
  } finally {
    context.cleanup();
  }
});
