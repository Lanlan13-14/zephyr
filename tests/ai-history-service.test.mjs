import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1ChangeBridge } = require(path.join(repoRoot, 'mobile-v1-change-bridge.js'));
const { AiHistoryService } = require(path.join(repoRoot, 'ai-history-service.js'));
const {
  createAiHistoryEntityAdapters,
  getAiHistorySyncCapability,
} = require(path.join(repoRoot, 'mobile-v1-ai-history-entities.js'));

const sourceRegistry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function readyRegistry() {
  const registry = structuredClone(sourceRegistry);
  for (const type of ['aiConversation', 'aiMessage']) {
    registry.entities.find((entity) => entity.type === type).status = 'implemented-canonical-service';
  }
  return registry;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function freshService(options = {}) {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  let tick = 1_800_000_000_000;
  const registry = readyRegistry();
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const attachments = options.attachments || new Map();
  const attachmentResolver = options.attachmentResolver || ((user, ref) => {
    const row = attachments.get(String(ref?.id || ''));
    if (!row || row.ownerUserId !== user.userId) return null;
    return row;
  });
  const service = new AiHistoryService(db, {
    now: options.now || (() => ++tick),
    mobileChangeBridge: bridge,
    attachmentResolver,
    legacyOwnershipVerifier: options.legacyOwnershipVerifier,
    onMutation: options.onMutation,
  });
  return {
    db,
    bridge,
    store: bridge.store,
    service,
    attachments,
    cleanup() {
      try { db.close(); } catch {}
    },
  };
}

const alice = { userId: 'account-alice' };
const bob = { userId: 'account-bob' };

test('a detached history service does not claim an atomic mobile feed', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  try {
    const service = new AiHistoryService(db, { mobileChangeBridge: false });
    assert.equal(service.mobileSyncCapabilities.atomicChangeFeed, false);
    assert.equal(getAiHistorySyncCapability({ registry: readyRegistry(), service }).enabled, false);
    assert.throws(
      () => service.purgeTombstones({ before: Date.now() }),
      (error) => error.code === 'atomic_change_feed_required',
    );
  } finally {
    db.close();
  }
});

test('canonical rows and revisions survive a builtin SQLite close and reopen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ai-history-persist-'));
  const filename = path.join(dir, 'history.db');
  let db;
  try {
    db = createDatabase(filename, { forceBuiltin: true });
    let bridge = new MobileV1ChangeBridge({ db, registry: readyRegistry() });
    let service = new AiHistoryService(db, {
      now: () => 1_900_000_000_000,
      mobileChangeBridge: bridge,
    });
    const conversation = service.createConversation(alice, { id: 'persisted', title: 'Before restart' });
    service.createMessage(alice, {
      id: 'persisted-message', conversationId: conversation.id, role: 'assistant', content: 'durable body',
    });
    service.updateConversation(alice, conversation.id, { title: 'After edit' }, { expectedRevision: 1 });
    await nextTurn();
    db.close();

    db = createDatabase(filename, { forceBuiltin: true });
    bridge = new MobileV1ChangeBridge({ db, registry: readyRegistry() });
    service = new AiHistoryService(db, { mobileChangeBridge: bridge });
    assert.deepEqual(
      [service.readConversation(alice, conversation.id).title, service.readConversation(alice, conversation.id).revision],
      ['After edit', 2],
    );
    assert.deepEqual(
      [service.readMessage(alice, 'persisted-message').content, service.readMessage(alice, 'persisted-message').revision],
      ['durable body', 1],
    );
    assert.equal(service.mobileChangeBridge.store.latestCursor(alice.userId), 3);
  } finally {
    try { db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical AI history is owner scoped, stable, sorted, and CAS protected', () => {
  const ctx = freshService({ now: () => 1_800_000_000_000 });
  try {
    assert.deepEqual(ctx.service.mobileSyncCapabilities, {
      stableIds: true,
      revisions: true,
      tombstones: true,
      ownerIsolation: true,
      atomicChangeFeed: true,
      persistentOnly: true,
      attachmentResidency: true,
    });
    assert.equal(getAiHistorySyncCapability({
      registry: readyRegistry(),
      service: ctx.service,
    }).enabled, true);
    const adapters = createAiHistoryEntityAdapters({ registry: readyRegistry(), service: ctx.service });
    assert.equal(typeof adapters.get('aiConversation').create, 'function');
    assert.equal(typeof adapters.get('aiMessage').remove, 'function');

    const aliceShared = ctx.service.createConversation(alice, {
      id: 'same-id', title: 'Alice first', providerId: 'provider-a', model: 'model-a',
    });
    const aliceNewest = ctx.service.createConversation(alice, { id: 'newest', title: 'Newest' });
    const bobShared = ctx.service.createConversation(bob, { id: 'same-id', title: 'Bob private' });
    assert.equal(aliceShared.id, bobShared.id);
    assert.notEqual(aliceShared.ownerUserId, bobShared.ownerUserId);
    assert.deepEqual(ctx.service.listConversations(alice).map((row) => row.id), ['newest', 'same-id']);
    assert.equal(aliceShared.createdAt, aliceShared.updatedAt);
    assert.deepEqual(ctx.service.listConversations(bob).map((row) => row.title), ['Bob private']);
    assert.equal(ctx.service.conversationResidency(alice, 'same-id'), 'owned');
    assert.equal(ctx.service.conversationResidency({ userId: 'account-charlie' }, 'same-id'), 'foreign');

    const edited = ctx.service.updateConversation(alice, aliceShared.id, { title: 'Edited' }, {
      expectedRevision: aliceShared.revision,
    });
    assert.equal(edited.revision, 2);
    assert.ok(edited.updatedAt > aliceShared.updatedAt);
    assert.equal(edited.providerId, 'provider-a');
    assert.equal(edited.model, 'model-a');
    assert.throws(
      () => ctx.service.updateConversation(alice, aliceShared.id, { title: 'Stale' }, {
        expectedRevision: aliceShared.revision,
      }),
      (error) => error.code === 'revision_conflict',
    );
    assert.equal(ctx.service.readConversation(bob, 'newest'), null);

    ctx.service.createMessage(alice, {
      id: 'message-b', conversationId: 'same-id', role: 'user', content: 'second timestamp',
    });
    ctx.service.createMessage(alice, {
      id: 'message-a', conversationId: 'same-id', role: 'assistant', content: 'later timestamp',
    });
    ctx.service.createMessage(bob, {
      id: 'message-a', conversationId: 'same-id', role: 'user', content: 'same id, other owner',
    });
    assert.deepEqual(ctx.service.listMessages(alice).map((row) => row.id), ['message-a', 'message-b']);
    assert.deepEqual(ctx.service.listMessages(bob).map((row) => row.content), ['same id, other owner']);
    assert.equal(ctx.service.messageResidency({ userId: 'account-charlie' }, 'message-a'), 'foreign');

    const oneUseId = ctx.service.createMessage(alice, {
      id: 'one-use-id', conversationId: 'newest', role: 'user', content: 'temporary',
    });
    ctx.service.deleteMessage(alice, oneUseId.id, { expectedRevision: oneUseId.revision });
    ctx.service.purgeTombstones({ before: Number.MAX_SAFE_INTEGER, ownerUserId: alice.userId });
    assert.throws(
      () => ctx.service.createMessage(alice, {
        id: oneUseId.id, conversationId: 'newest', role: 'user', content: 'must not reset revision',
      }),
      (error) => error.code === 'entity_id_tombstoned',
    );
  } finally {
    ctx.cleanup();
  }
});

test('conversation delete and restore produce dependency ordered message tombstones and monotonic revisions', () => {
  const ctx = freshService();
  try {
    const conversation = ctx.service.createConversation(alice, { id: 'lifecycle', title: 'Lifecycle' });
    ctx.service.createMessage(alice, {
      id: 'm-1', conversationId: conversation.id, role: 'user', content: 'hello',
    });
    ctx.service.createMessage(alice, {
      id: 'm-2', conversationId: conversation.id, role: 'assistant', content: 'world',
    });
    const deleteReceipt = {};
    const deleted = ctx.service.deleteConversation(alice, conversation.id, {
      expectedRevision: 1,
      actorDeviceId: 'device-delete',
      mutationReceipt: deleteReceipt,
    });
    assert.equal(deleted.revision, 2);
    assert.ok(deleted.deletedAt);
    assert.deepEqual(
      ctx.service.listMessages(alice, { conversationId: conversation.id, includeDeleted: true })
        .map((row) => [row.id, row.revision, row.deletedByConversation, !!row.deletedAt]),
      [['m-1', 2, true, true], ['m-2', 2, true, true]],
    );
    const deleteChanges = ctx.store.changePage(alice.userId, 0, 50).changes.slice(-3);
    assert.deepEqual(deleteChanges.map((change) => [change.entityType, change.action, change.revision]), [
      ['aiMessage', 'delete', 2],
      ['aiMessage', 'delete', 2],
      ['aiConversation', 'delete', 2],
    ]);
    assert.deepEqual(deleteReceipt.changeSeqs, deleteChanges.map((change) => change.changeSeq));
    assert.equal(deleteReceipt.changeSeq, deleteChanges.at(-1).changeSeq);

    const restoreReceipt = {};
    const restored = ctx.service.restoreConversation(alice, conversation.id, {
      expectedRevision: 2,
      actorDeviceId: 'device-restore',
      mutationReceipt: restoreReceipt,
    });
    assert.equal(restored.revision, 3);
    assert.deepEqual(
      ctx.service.listMessages(alice, { conversationId: conversation.id })
        .map((row) => [row.id, row.revision, row.deletedAt]),
      [['m-1', 3, null], ['m-2', 3, null]],
    );
    const restoreChanges = ctx.store.changePage(alice.userId, 0, 100).changes.slice(-3);
    assert.deepEqual(restoreChanges.map((change) => [change.entityType, change.action, change.revision]), [
      ['aiConversation', 'upsert', 3],
      ['aiMessage', 'upsert', 3],
      ['aiMessage', 'upsert', 3],
    ]);

    const directlyDeleted = ctx.service.deleteMessage(alice, 'm-1', { expectedRevision: 3 });
    assert.equal(directlyDeleted.revision, 4);
    assert.equal(directlyDeleted.deletedByConversation, false);
    const directlyRestored = ctx.service.restoreMessage(alice, 'm-1', { expectedRevision: 4 });
    assert.equal(directlyRestored.revision, 5);
    assert.equal(directlyRestored.deletedAt, null);

    ctx.service.deleteConversation(alice, conversation.id, { expectedRevision: 3 });
    const ledgerBeforeGc = ctx.store.changePage(alice.userId, 0, 200).changes;
    const purged = ctx.service.purgeTombstones({ before: Number.MAX_SAFE_INTEGER, ownerUserId: alice.userId });
    assert.deepEqual(purged, { messages: 2, conversations: 1 });
    assert.equal(ctx.service.readConversation(alice, conversation.id, { includeDeleted: true }), null);
    assert.deepEqual(ctx.store.changePage(alice.userId, 0, 200).changes, ledgerBeforeGc);
    assert.throws(
      () => ctx.service.createConversation(alice, { id: conversation.id, title: 'No revision reset' }),
      (error) => error.code === 'entity_id_tombstoned',
    );
    assert.throws(
      () => ctx.service.purgeTombstones({ before: Date.now(), ownerUserId: '   ' }),
      (error) => error.code === 'invalid_tombstone_owner',
    );
    assert.equal(ctx.service.createConversation(bob, {
      id: conversation.id, title: 'Same id is valid for another owner',
    }).revision, 1);
  } finally {
    ctx.cleanup();
  }
});

test('message persistence rejects unsafe roles and inline blobs and stores only proven private attachment references', () => {
  const logs = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  const attachments = new Map([
    ['owned-ref', {
      id: 'owned-ref', ownerUserId: alice.userId, shared: false,
      mobileSyncAllowed: true, residency: 'private-owned',
      name: 'report.txt', mime: 'text/plain', size: 14,
      content: 'ATTACHMENT-BLOB-CANARY',
    }],
    ['foreign-ref', {
      id: 'foreign-ref', ownerUserId: bob.userId, shared: false,
      mobileSyncAllowed: true, residency: 'private-owned', name: 'foreign.txt', mime: 'text/plain', size: 99,
    }],
    ['shared-ref', {
      id: 'shared-ref', ownerUserId: alice.userId, shared: true,
      mobileSyncAllowed: true, residency: 'owned', name: 'shared.txt', mime: 'text/plain', size: 9,
    }],
  ]);
  const ctx = freshService({ attachments });
  try {
    ctx.service.createConversation(alice, {
      id: 'secure', title: 'Safe',
      runtimeMetadata: { apiKey: 'CONVERSATION-RUNTIME-CANARY' },
      activeRunId: 'ACTIVE-RUN-CANARY',
    });
    const message = ctx.service.createMessage(alice, {
      id: 'safe-message',
      conversationId: 'secure',
      role: 'assistant',
      content: 'Visible final answer',
      attachments: [{ id: 'owned-ref', content: 'CLIENT-BLOB-CANARY', ownerUserId: bob.userId }],
      toolEvents: [{ arguments: 'TOOL-ARGS-CANARY' }],
      usage: { secret: 'USAGE-CANARY' },
      contextSnapshot: 'CONTEXT-CANARY',
      streamState: 'STREAM-CANARY',
      runtimeMetadata: { apiKey: 'RUNTIME-CANARY' },
    });
    assert.deepEqual(message.attachments, [{
      id: 'owned-ref', name: 'report.txt', mime: 'text/plain', size: 14,
    }]);
    const raw = ctx.db.prepare(`SELECT role, content, attachments_json FROM ai_messages
      WHERE owner_user_id=? AND message_id=?`).get(alice.userId, message.id);
    assert.doesNotMatch(JSON.stringify(raw), /ATTACHMENT-BLOB|CLIENT-BLOB|TOOL-ARGS|USAGE-CANARY|CONTEXT-CANARY|STREAM-CANARY|RUNTIME-CANARY/);
    assert.doesNotMatch(
      JSON.stringify(ctx.db.prepare(`SELECT * FROM ai_conversations
        WHERE owner_user_id=? AND conversation_id=?`).get(alice.userId, 'secure')),
      /CONVERSATION-RUNTIME-CANARY|ACTIVE-RUN-CANARY/,
    );
    assert.throws(
      () => ctx.service.createMessage(alice, {
        id: 'system', conversationId: 'secure', role: 'system', content: 'SYSTEM-CANARY',
      }),
      (error) => error.code === 'ai_message_role_forbidden',
    );
    assert.throws(
      () => ctx.service.createMessage(alice, {
        id: 'developer', conversationId: 'secure', role: 'developer', content: 'DEVELOPER-CANARY',
      }),
      (error) => error.code === 'ai_message_role_forbidden',
    );
    assert.throws(
      () => ctx.service.createMessage(alice, {
        id: 'tool', conversationId: 'secure', role: 'tool', content: 'TOOL-CONTENT-CANARY',
      }),
      (error) => error.code === 'ai_message_role_forbidden',
    );
    assert.throws(
      () => ctx.service.createMessage(alice, {
        id: 'inline', conversationId: 'secure', role: 'user', content: 'data:image/png;base64,AAAA',
      }),
      (error) => error.code === 'inline_attachment_forbidden',
    );
    for (const id of ['foreign-ref', 'shared-ref']) {
      assert.throws(
        () => ctx.service.createMessage(alice, {
          id: `bad-${id}`, conversationId: 'secure', role: 'user', content: 'x', attachments: [{ id }],
        }),
        (error) => error.code === 'attachment_not_syncable',
      );
    }
    assert.equal(ctx.service.assertAttachmentOwned(alice, { id: 'owned-ref' }).ownerUserId, alice.userId);
    const adapter = createAiHistoryEntityAdapters({ registry: readyRegistry(), service: ctx.service })
      .get('aiMessage');
    assert.deepEqual(adapter.read(alice, message.id).attachments, [{
      id: 'owned-ref', name: 'report.txt', mime: 'text/plain', size: 14,
    }]);
    attachments.get('owned-ref').shared = true;
    assert.equal(ctx.service.assertAttachmentOwned(alice, { id: 'owned-ref' }), null);
    assert.deepEqual(adapter.read(alice, message.id).attachments, []);
    assert.deepEqual(logs, []);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    ctx.cleanup();
  }
});

test('canonical rows, changes, outbox, receipts, and payload-free wakes share commit fate', async () => {
  const wakes = [];
  const ctx = freshService({ onMutation: (event) => wakes.push(event) });
  try {
    const subscriptionEvents = [];
    const unsubscribe = ctx.service.subscribe(alice.userId, (event) => subscriptionEvents.push(event));
    ctx.db.exec(`CREATE TRIGGER reject_ai_history_feed BEFORE INSERT ON mobile_sync_changes
      BEGIN SELECT RAISE(ABORT, 'feed unavailable'); END;`);
    assert.throws(
      () => ctx.service.createConversation(alice, { id: 'rollback-create', title: 'Must rollback' }),
      /feed unavailable/,
    );
    await nextTurn();
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ai_conversations').get().count, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, 0);
    assert.deepEqual(wakes, []);
    assert.deepEqual(subscriptionEvents, []);
    ctx.db.exec('DROP TRIGGER reject_ai_history_feed');

    const conversation = ctx.service.createConversation(alice, { id: 'atomic-turn', title: 'Initial' });
    const changeCount = ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count;
    const outboxCount = ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count;
    assert.throws(
      () => ctx.service.appendCompletedTurn(alice, conversation.id, {
        userMessage: { id: 'duplicate', content: 'user text' },
        assistantMessage: { id: 'duplicate', content: 'assistant text' },
      }, { expectedRevision: conversation.revision }),
      (error) => error.code === 'revision_conflict',
    );
    await nextTurn();
    assert.equal(ctx.service.listMessages(alice).length, 0);
    assert.equal(ctx.service.readConversation(alice, conversation.id).revision, 1);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count, changeCount);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, outboxCount);
    assert.equal(wakes.length, 1, 'a committed wake survives a later same-tick rolled-back cursor');
    assert.deepEqual(Object.keys(wakes[0]).sort(), ['cursor', 'ownerUserId']);
    assert.equal(wakes[0].ownerUserId, alice.userId);
    assert.equal(subscriptionEvents.length, 1);
    wakes.length = 0;
    subscriptionEvents.length = 0;

    const receipt = {};
    const completed = ctx.service.appendCompletedTurn(alice, conversation.id, {
      userMessage: { id: 'turn-user', content: 'question' },
      assistantMessage: { id: 'turn-assistant', content: 'answer' },
      conversationPatch: { title: 'Completed title' },
    }, {
      expectedRevision: 1,
      actorDeviceId: 'runtime-bridge',
      mutationReceipt: receipt,
    });
    assert.equal(completed.conversation.revision, 2);
    assert.deepEqual(completed.messages.map((row) => row.revision), [1, 1]);
    assert.equal(receipt.changeSeqs.length, 3);
    assert.equal(receipt.changeSeq, Math.max(...receipt.changeSeqs));
    const turnChanges = ctx.store.changePage(alice.userId, changeCount, 20).changes;
    assert.deepEqual(turnChanges.map((change) => [change.entityType, change.revision, change.actorDeviceId]), [
      ['aiMessage', 1, 'runtime-bridge'],
      ['aiMessage', 1, 'runtime-bridge'],
      ['aiConversation', 2, 'runtime-bridge'],
    ]);
    await nextTurn();
    assert.equal(wakes.length, 1, 'same-account writes in one turn coalesce to one payload-free wake');
    assert.equal(subscriptionEvents.length, 1);

    wakes.length = 0;
    subscriptionEvents.length = 0;
    const unchangedMetadataReceipt = {};
    const secondTurn = ctx.service.appendCompletedTurn(alice, conversation.id, {
      userMessage: { id: 'turn-user-2', content: 'follow-up' },
      assistantMessage: { id: 'turn-assistant-2', content: 'follow-up answer' },
      conversationPatch: { title: 'Completed title' },
    }, {
      expectedRevision: 2,
      mutationReceipt: unchangedMetadataReceipt,
    });
    assert.equal(secondTurn.conversation.revision, 3);
    assert.ok(secondTurn.conversation.updatedAt > completed.conversation.updatedAt);
    assert.equal(unchangedMetadataReceipt.changeSeqs.length, 2, 'metadata-only touch has no duplicate feed row');
    await nextTurn();
    assert.equal(wakes.length, 1);
    unsubscribe();
  } finally {
    ctx.cleanup();
  }
});

test('legacy import requires verified explicit ownership and account deletion erases only that owner', () => {
  const ctx = freshService({
    legacyOwnershipVerifier: ({ user, session, evidence }) => (
      evidence === 'runtime-owned-export' && session.ownerUserId === user.userId
    ),
  });
  try {
    ctx.service.createConversation(bob, { id: 'same-conversation', title: 'Bob remains' });
    ctx.service.createMessage(bob, {
      id: 'same-message', conversationId: 'same-conversation', role: 'user', content: 'Bob remains private',
    });
    const stats = ctx.service.migrateLegacyOwnedHistory(alice, [
      { id: 'ownerless', title: 'Do not guess', messages: [{ role: 'user', content: 'OWNERLESS-CANARY' }] },
      { ownerUserId: bob.userId, id: 'foreign', title: 'Foreign', messages: [] },
      {
        ownerUserId: alice.userId,
        id: 'same-conversation',
        title: 'Alice imported',
        createdAt: 100,
        updatedAt: 200,
        messages: [
          { id: 'same-message', role: 'user', content: 'Alice question', createdAt: 101 },
          { id: 'answer', role: 'assistant', content: 'Alice answer', createdAt: 102 },
          { id: 'system-secret', role: 'system', content: 'SYSTEM-IMPORT-CANARY' },
          { id: 'tool-secret', role: 'tool', content: 'TOOL-IMPORT-CANARY', toolArgs: 'ARG-CANARY' },
        ],
      },
    ], { source: 'go-runtime', ownershipEvidence: 'runtime-owned-export' });
    assert.deepEqual(stats, {
      conversationsCreated: 1,
      messagesCreated: 2,
      skippedUnverified: 2,
      skippedUnsafe: 2,
      skippedExisting: 0,
    });
    assert.deepEqual(ctx.service.listConversations(alice).map((row) => row.title), ['Alice imported']);
    assert.deepEqual(
      ctx.service.listConversations(alice).map((row) => [row.createdAt, row.updatedAt]),
      [[100, 200]],
    );
    assert.deepEqual(ctx.service.listMessages(alice).map((row) => row.content), ['Alice question', 'Alice answer']);
    const rawDump = JSON.stringify({
      conversations: ctx.db.prepare('SELECT * FROM ai_conversations').all(),
      messages: ctx.db.prepare('SELECT * FROM ai_messages').all(),
    });
    assert.doesNotMatch(rawDump, /OWNERLESS-CANARY|SYSTEM-IMPORT-CANARY|TOOL-IMPORT-CANARY|ARG-CANARY/);

    const deleted = ctx.service.deleteUserState(alice.userId);
    assert.deepEqual(deleted, { messages: 2, conversations: 1 });
    assert.deepEqual(ctx.service.listConversations(alice), []);
    assert.deepEqual(ctx.service.listMessages(alice), []);
    assert.equal(ctx.service.readConversation(bob, 'same-conversation').title, 'Bob remains');
    assert.equal(ctx.service.readMessage(bob, 'same-message').content, 'Bob remains private');
  } finally {
    ctx.cleanup();
  }
});
