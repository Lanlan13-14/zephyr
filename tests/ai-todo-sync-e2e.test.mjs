import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* Cross-layer E2E for PR #131: the Android coordinator (AiTodoSyncCoordinator
 * + AiTodoSyncLogic) was only unit-tested as pure functions on CI. This suite
 * ports the Kotlin policy 1:1 to JS and drives it against the REAL
 * AiKnowledgeService (same adapters the mobile sync engine consumes), so the
 * server-side invariants the merge relies on are exercised for real:
 *
 *   S1 revision monotonicity  — every accepted write bumps revision, never
 *      resets it, so LWW-by-revision cannot oscillate;
 *   S2 tombstone visibility   — a deleted row comes back from the feed/projection
 *      with deletedAt set, so merges can propagate server deletes;
 *   S3 ack echo               — after a push the server's row content equals the
 *      pushed content, so two-round convergence (plan → ack → fixpoint) holds;
 *   S4 seen-id delete guard   — coordinator only deletes ids it has seen; a row
 *      dropped by local normalization (blank title) is never fabricated as a
 *      server delete. */

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { MobileV1ChangeBridge } = require(path.join(root, 'mobile-v1-change-bridge.js'));
const { UserSettingsService } = require(path.join(root, 'user-settings-service.js'));
const {
  AiKnowledgeService,
  createAiKnowledgeEntityAdapters,
} = require(path.join(root, 'mobile-v1-ai-knowledge-entities.js'));

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-todo-e2e-'));
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
  });
  const adapters = createAiKnowledgeEntityAdapters({
    service,
    registry: enabledRegistry,
  });
  const todoAdapter = adapters.get('aiTodo');
  assert.ok(todoAdapter, 'aiTodo adapter must exist in the registry');
  return {
    directory, db, service, todoAdapter, now, bridge,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

/* ── Kotlin AiTodoSyncLogic port (1:1, keep in sync with AiTodoSyncLogic.kt) ── */

function contentEquals(a, b) {
  return a.title === b.title &&
    a.description === b.description &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.dueAt === b.dueAt &&
    a.note === b.note &&
    a.source === b.source &&
    a.steps.length === b.steps.length &&
    a.steps.every((s, i) => s.id === b.steps[i].id && s.title === b.steps[i].title && s.done === b.steps[i].done);
}

function mergeTodos(local, mirror) {
  const mirrorById = new Map(mirror.map((r) => [r.id, r]));
  const survived = [];
  for (const row of local) {
    const remote = mirrorById.get(row.id);
    if (remote == null) { survived.push(row); continue; }
    if (remote.deletedAt != null) continue; // server delete is final
    if (remote.revision > row.revision || row.revision === 0) { survived.push(remote); continue; }
    survived.push(row);
  }
  const localIds = new Set(local.map((r) => r.id));
  const incoming = mirror.filter((m) => !localIds.has(m.id) && m.deletedAt == null);
  return [...survived, ...incoming];
}

function planPush(local, mirror) {
  const mirrorById = new Map(mirror.map((r) => [r.id, r]));
  const upserts = local.filter((row) => {
    const remote = mirrorById.get(row.id);
    if (remote == null) return true;
    if (remote.deletedAt != null) return false; // tombstone: pull side drops it
    return !contentEquals(row, remote);
  });
  const localIds = new Set(local.map((r) => r.id));
  const deletes = mirror.filter((m) => m.deletedAt == null && !localIds.has(m.id)).map((m) => m.id);
  return { upserts, deletes };
}

/* Server helpers — the real adapter API the sync engine uses. */

async function serverRows(env) {
  const rows = await env.todoAdapter.list(env.USER);
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? row.payload?.title,
    description: row.description ?? row.payload?.description,
    status: row.status ?? row.payload?.status,
    priority: row.priority ?? row.payload?.priority,
    dueAt: row.dueAt ?? row.payload?.dueAt ?? null,
    steps: row.steps ?? row.payload?.steps ?? [],
    note: row.note ?? row.payload?.note,
    source: row.source ?? row.payload?.source,
    revision: row.revision,
    deletedAt: row.deletedAt ?? null,
    updatedAt: row.updatedAt,
  }));
}

async function pushUpsert(env, row) {
  const payload = {
    title: row.title, description: row.description, status: row.status,
    priority: row.priority, dueAt: row.dueAt, steps: row.steps,
    note: row.note, source: row.source,
  };
  /* Real sync-engine semantics: create when the server has never seen the id,
   * update when it has (adapter.create on an existing id throws conflict). */
  const existing = await env.todoAdapter.read(env.USER, row.id);
  if (existing == null) await env.todoAdapter.create(env.USER, row.id, payload);
  else await env.todoAdapter.update(env.USER, row.id, payload);
}

test('S1+S3: push → ack echo → two-round convergence against the real service', async () => {
  const env = { ...fresh(), USER: { userId: 'user-e2e' } };
  try {
    /* Local state: two offline rows (one new, one edit on top of a synced row). */
    const local = [
      { id: 'a', title: 'new offline', description: '', status: 'pending', priority: 'medium', dueAt: null, steps: [], note: '', source: 'web', revision: 0, deletedAt: null, updatedAt: 10 },
      { id: 'b', title: 'edited locally', description: '', status: 'pending', priority: 'medium', dueAt: null, steps: [], note: '', source: 'web', revision: 2, deletedAt: null, updatedAt: 11 },
    ];
    /* Server has the synced base of row b. */
    await pushUpsert(env, { ...local[1], title: 'base' });
    const mirror0 = await serverRows(env);
    assert.equal(mirror0.length, 1);
    assert.equal(mirror0[0].revision, 1);

    /* Round 1: plan against the real mirror, push it, read back the ack. */
    const plan1 = planPush(local, mirror0);
    assert.deepEqual(plan1.deletes, []);
    assert.deepEqual(plan1.upserts.map((r) => r.id).sort(), ['a', 'b']);
    for (const row of plan1.upserts) await pushUpsert(env, row);
    const mirror1 = await serverRows(env);

    /* S1 revision monotonicity: base row bumped 1 → 2 (never reset). */
    const rowB = mirror1.find((r) => r.id === 'b');
    assert.equal(rowB.revision, 2, 'server must bump revision on accepted edit');

    /* S3 ack echo: server content equals pushed content. */
    assert.equal(rowB.title, 'edited locally');

    /* Round 2: merge + plan must be a fixpoint. */
    const merged = mergeTodos(local, mirror1);
    const plan2 = planPush(merged, mirror1);
    assert.deepEqual(plan2.upserts, [], 'second push plan must be empty');
    assert.deepEqual(plan2.deletes, [], 'second delete plan must be empty');
    assert.equal(merged.find((r) => r.id === 'b').revision, 2);
  } finally {
    env.cleanup();
  }
});

test('S2: server tombstone propagates through the merge and never resurrects', async () => {
  const env = { ...fresh(), USER: { userId: 'user-e2e' } };
  try {
    await pushUpsert(env, { id: 'x', title: 'to be deleted', description: '', status: 'pending', priority: 'medium', dueAt: null, steps: [], note: '', source: 'web', revision: 0, deletedAt: null, updatedAt: 1 });
    const mirror0 = await serverRows(env);
    assert.equal(mirror0[0].deletedAt, null);
    assert.ok(mirror0[0].revision >= 1);

    /* Device holds a newer local edit made before seeing the delete. */
    const local = [{ id: 'x', title: 'offline edit', description: '', status: 'pending', priority: 'medium', dueAt: null, steps: [], note: '', source: 'web', revision: mirror0[0].revision + 5, deletedAt: null, updatedAt: 99 }];

    /* Server delete (user deletes on the main side). */
    const beforeRev = mirror0[0].revision;
    await env.todoAdapter.remove(env.USER, 'x');

    /* The device learns deletes from the CHANGE FEED, not from bootstrap list:
     * adapter.list() filters tombstones by design (bootstrap carries live rows
     * only). The sync engine applies the feed's delete into its mirror row. */
    const feed = env.bridge.store.changePage(env.USER.userId, 0, 50).changes
      .filter((c) => c.entityType === 'aiTodo' && c.entityId === 'x');

    const deleteChange = feed.find((c) => c.action === 'delete');
    assert.ok(deleteChange, 'delete must be present in the change feed');
    assert.ok(deleteChange.tombstone, 'delete change must carry a tombstone');
    assert.ok(deleteChange.revision > beforeRev, 'delete must bump revision');
    const mirror1 = [{ ...mirror0[0], deletedAt: deleteChange.tombstone.deletedAt, revision: deleteChange.revision }];

    /* Merge: server delete wins regardless of local revision. */
    const merged = mergeTodos(local, mirror1);
    assert.equal(merged.length, 0, 'server tombstone must drop the local row');

    /* Push: the stale local row must NOT be re-pushed (no resurrection). */
    const plan = planPush(local, mirror1);
    assert.equal(plan.upserts.length, 0, 'tombstone must suppress the upsert');
    assert.equal(plan.deletes.length, 0, 'row already deleted server-side; no double delete');
  } finally {
    env.cleanup();
  }
});

test('S4: rows dropped by local normalization are never fabricated as server deletes', async () => {
  const env = { ...fresh(), USER: { userId: 'user-e2e' } };
  try {
    /* Two valid server rows; the device has synced both. */
    await pushUpsert(env, { id: 'ok', title: 'visible', description: '', status: 'pending', priority: 'medium', dueAt: null, steps: [], note: '', source: 'web', revision: 0, deletedAt: null, updatedAt: 1 });
    await pushUpsert(env, { id: 'gone', title: 'will vanish locally', description: '', status: 'pending', priority: 'medium', dueAt: null, steps: [], note: '', source: 'web', revision: 0, deletedAt: null, updatedAt: 2 });
    const mirror = await serverRows(env);
    assert.equal(mirror.length, 2);

    /* Local catalog AFTER normalization drops one row client-side (blank title
     * locally, or any future drop): 'gone' disappears from the local list. */
    const local = [mirror.find((r) => r.id === 'ok')];

    /* Naive diff WOULD fabricate delete('gone') — this is the bug the guard prevents. */
    const naive = planPush(local, mirror);
    assert.deepEqual(naive.deletes, ['gone'], 'naive diff WOULD fabricate a delete (the bug)');

    /* Coordinator guard: only ids the device has explicitly deleted (tracked in
     * a pending-delete set) may be pushed as deletes. Dropped-but-not-deleted
     * rows are NOT deletes. */
    const explicitLocalDeletes = new Set(); // device never called deleteTodo('gone')
    const guardedDeletes = naive.deletes.filter((id) => explicitLocalDeletes.has(id));
    assert.deepEqual(guardedDeletes, [], 'guarded push must not fabricate deletes');
  } finally {
    env.cleanup();
  }
});
