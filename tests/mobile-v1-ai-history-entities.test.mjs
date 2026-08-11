import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createAiHistoryEntityAdapters,
  getAiHistorySyncCapability,
} = require(path.join(root, 'mobile-v1-ai-history-entities.js'));
const { createEntityAdapters } = require(path.join(root, 'mobile-v1-entities.js'));
const productionRegistry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const IMPLEMENTED_STATUS = 'implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection';

function readyRegistry({ conversationStatus = IMPLEMENTED_STATUS, messageStatus = IMPLEMENTED_STATUS } = {}) {
  const registry = structuredClone(productionRegistry);
  registry.entities.find((row) => row.type === 'aiConversation').status = conversationStatus;
  registry.entities.find((row) => row.type === 'aiMessage').status = messageStatus;
  return registry;
}

function blockedRegistry() {
  return readyRegistry({
    conversationStatus: 'blocked-no-canonical-server-schema',
    messageStatus: 'blocked-no-canonical-server-schema',
  });
}

function historyService() {
  const conversations = new Map();
  const messages = new Map();
  const attachmentProofs = new Map([
    ['owned', {
      id: 'owned', ownerUserId: 'alice', shared: false, residency: 'private-owned',
      mobileSyncAllowed: true, name: 'note.txt', mime: 'text/plain', size: 3,
      downloadToken: 'attachment-secret',
    }],
    ['shared', {
      id: 'shared', ownerUserId: 'bob', shared: true, residency: 'shared',
      mobileSyncAllowed: false, name: 'other', mime: 'text/plain', size: 99,
    }],
  ]);
  const tombstones = [];
  const mutationContexts = [];
  let attachmentProofCalls = 0;
  let clock = 100;
  const owner = (user, row) => row && row.ownerUserId === user.userId;
  const revision = (row, expected) => {
    if (!owner(expected.user, row)) return null;
    if (row.revision !== expected.expectedRevision) {
      const error = new Error('revision conflict');
      error.code = 'revision_conflict';
      throw error;
    }
    return row;
  };
  const api = {
    mobileSyncCapabilities: {
      stableIds: true,
      revisions: true,
      tombstones: true,
      ownerIsolation: true,
      atomicChangeFeed: true,
      persistentOnly: true,
      attachmentResidency: true,
    },
    listConversations: (user) => [...conversations.values()].filter((row) => owner(user, row) && row.deletedAt == null),
    readConversation: (user, id, { includeDeleted = false } = {}) => {
      const row = conversations.get(id);
      return owner(user, row) && (includeDeleted || row.deletedAt == null) ? row : null;
    },
    conversationResidency: (user, id) => conversations.has(id)
      ? (owner(user, conversations.get(id)) ? 'owned' : 'foreign') : 'missing',
    createConversation(user, patch, context = {}) {
      mutationContexts.push({ operation: 'createConversation', context });
      if (conversations.has(patch.id)) throw Object.assign(new Error('exists'), { code: 'id_collision' });
      const row = { ...patch, ownerUserId: user.userId, revision: 1, createdAt: ++clock, updatedAt: clock, deletedAt: null };
      conversations.set(row.id, row);
      return row;
    },
    updateConversation(user, id, patch, expected = {}) {
      mutationContexts.push({ operation: 'updateConversation', context: expected });
      const row = revision(conversations.get(id), { user, ...expected });
      if (!row) throw Object.assign(new Error('not found'), { code: 'not_found' });
      Object.assign(row, patch, { revision: row.revision + 1, updatedAt: ++clock });
      return row;
    },
    deleteConversation(user, id, expected = {}) {
      mutationContexts.push({ operation: 'deleteConversation', context: expected });
      const row = revision(conversations.get(id), { user, ...expected });
      if (!row) throw Object.assign(new Error('not found'), { code: 'not_found' });
      Object.assign(row, { revision: row.revision + 1, updatedAt: ++clock, deletedAt: clock });
      tombstones.push({ entityType: 'aiConversation', id, ownerUserId: user.userId, revision: row.revision });
      return row;
    },
    restoreConversation(user, id, expected = {}) {
      mutationContexts.push({ operation: 'restoreConversation', context: expected });
      const row = revision(conversations.get(id), { user, ...expected });
      if (!row || row.deletedAt == null) throw Object.assign(new Error('not found'), { code: 'not_found' });
      Object.assign(row, { revision: row.revision + 1, updatedAt: ++clock, deletedAt: null });
      return row;
    },
    listMessages: (user) => [...messages.values()].filter((row) => owner(user, row) && row.deletedAt == null),
    readMessage: (user, id, { includeDeleted = false } = {}) => {
      const row = messages.get(id);
      return owner(user, row) && (includeDeleted || row.deletedAt == null) ? row : null;
    },
    messageResidency: (user, id) => messages.has(id)
      ? (owner(user, messages.get(id)) ? 'owned' : 'foreign') : 'missing',
    assertAttachmentOwned(user, attachment) {
      attachmentProofCalls += 1;
      const proof = attachmentProofs.get(String(attachment?.id || ''));
      return proof?.ownerUserId === user.userId && proof.shared !== true && proof.mobileSyncAllowed === true
        ? proof
        : null;
    },
    createMessage(user, patch, context = {}) {
      mutationContexts.push({ operation: 'createMessage', context });
      if (messages.has(patch.id)) throw Object.assign(new Error('exists'), { code: 'id_collision' });
      if (!owner(user, conversations.get(patch.conversationId)) || conversations.get(patch.conversationId).deletedAt != null) {
        throw Object.assign(new Error('foreign conversation'), { code: 'foreign' });
      }
      const row = { ...patch, ownerUserId: user.userId, revision: 1, createdAt: ++clock, updatedAt: clock, deletedAt: null };
      messages.set(row.id, row);
      return row;
    },
    updateMessage(user, id, patch, expected = {}) {
      mutationContexts.push({ operation: 'updateMessage', context: expected });
      const row = revision(messages.get(id), { user, ...expected });
      if (!row) throw Object.assign(new Error('not found'), { code: 'not_found' });
      Object.assign(row, patch, { revision: row.revision + 1, updatedAt: ++clock });
      return row;
    },
    deleteMessage(user, id, expected = {}) {
      mutationContexts.push({ operation: 'deleteMessage', context: expected });
      const row = revision(messages.get(id), { user, ...expected });
      if (!row) throw Object.assign(new Error('not found'), { code: 'not_found' });
      Object.assign(row, { revision: row.revision + 1, updatedAt: ++clock, deletedAt: clock });
      tombstones.push({ entityType: 'aiMessage', id, ownerUserId: user.userId, revision: row.revision });
      return row;
    },
    restoreMessage(user, id, expected = {}) {
      mutationContexts.push({ operation: 'restoreMessage', context: expected });
      const row = revision(messages.get(id), { user, ...expected });
      if (!row || row.deletedAt == null) throw Object.assign(new Error('not found'), { code: 'not_found' });
      Object.assign(row, { revision: row.revision + 1, updatedAt: ++clock, deletedAt: null });
      return row;
    },
    insertRawConversation: (row) => conversations.set(row.id, row),
    insertRawMessage: (row) => messages.set(row.id, row),
    tombstones,
    mutationContexts,
    get attachmentProofCalls() { return attachmentProofCalls; },
  };
  return api;
}

test('production registry enables both canonical AI history types bidirectionally', () => {
  const service = historyService();
  const capability = getAiHistorySyncCapability({ registry: productionRegistry, service });
  assert.deepEqual(capability.directions, { aiConversation: 'bidirectional', aiMessage: 'bidirectional' });
  assert.equal(capability.enabled, true);
  assert.equal(capability.code, null);
  assert.deepEqual([...createAiHistoryEntityAdapters({ registry: productionRegistry, service }).keys()], [
    'aiConversation',
    'aiMessage',
  ]);
});

test('an explicit blocked registry fixture stays fail-closed even when a service is supplied', () => {
  const registry = blockedRegistry();
  const capability = getAiHistorySyncCapability({ registry, service: historyService() });
  assert.deepEqual(capability.directions, { aiConversation: 'blocked', aiMessage: 'blocked' });
  assert.equal(capability.enabled, false);
  assert.equal(capability.code, 'ai_history_schema_blocked');
  assert.deepEqual([...createAiHistoryEntityAdapters({ registry, service: historyService() })], []);
});

test('a requires-* registry status remains fail-closed', () => {
  const capability = getAiHistorySyncCapability({
    registry: readyRegistry({ conversationStatus: 'requires-security-review' }),
    service: historyService(),
  });
  assert.equal(capability.enabled, false);
  assert.equal(capability.directions.aiConversation, 'blocked');
});

test('unknown, empty, or misspelled registry statuses fail closed', () => {
  for (const status of ['', 'blocked', 'source-ready', 'implementd-canonical-service']) {
    const capability = getAiHistorySyncCapability({
      registry: readyRegistry({ conversationStatus: status }),
      service: historyService(),
    });
    assert.equal(capability.enabled, false, `${status || '<empty>'} must not enable writers`);
    assert.equal(capability.directions.aiConversation, 'blocked');
  }
});

test('registry read-only mode exposes safe reads but never writers', () => {
  const service = historyService();
  const adapters = createAiHistoryEntityAdapters({
    registry: readyRegistry({
      conversationStatus: 'implemented-read-only-canonical-service',
      messageStatus: 'implemented-read-only-canonical-service',
    }),
    service,
  });
  assert.ok(adapters.has('aiConversation'));
  assert.equal(typeof adapters.get('aiConversation').create, 'undefined');
  assert.equal(typeof adapters.get('aiMessage').remove, 'undefined');
  assert.equal(typeof adapters.get('aiMessage').restore, 'undefined');
});

test('central entity table wires both AI history adapters when the canonical service is ready', () => {
  const adapters = createEntityAdapters({
    entityRegistry: readyRegistry(),
    aiHistoryService: historyService(),
  });
  assert.equal(adapters.has('aiConversation'), true);
  assert.equal(adapters.has('aiMessage'), true);
});

test('bidirectional adapters preserve stable order, revisions, tombstones, and owners', () => {
  const service = historyService();
  const adapters = createAiHistoryEntityAdapters({ registry: readyRegistry(), service });
  const alice = { userId: 'alice' };
  const bob = { userId: 'bob' };
  const conversations = adapters.get('aiConversation');
  const messages = adapters.get('aiMessage');

  conversations.create(alice, 'conv-b', {
    title: 'Later', providerId: 'p', model: 'm', archived: false,
    runtimeMetadata: { systemPrompt: 'never' }, activeRunId: 'run-secret', secret: 'never',
  });
  conversations.create(alice, 'conv-a', { title: 'Earlier', providerId: 'p', model: 'm', archived: false });
  conversations.create(bob, 'conv-bob', { title: 'Private', providerId: 'p', model: 'm', archived: false });
  assert.deepEqual(conversations.list(alice).map((row) => row.id), ['conv-b', 'conv-a']);
  assert.equal(conversations.residency(alice, 'conv-bob'), 'foreign');
  assert.equal(conversations.read(alice, 'conv-bob'), null);
  assert.doesNotMatch(JSON.stringify(conversations.read(alice, 'conv-b')), /runtimeMetadata|systemPrompt|activeRunId|run-secret|secret/);

  const first = conversations.read(alice, 'conv-b');
  conversations.update(alice, 'conv-b', { title: 'Edited' });
  assert.equal(conversations.read(alice, 'conv-b').revision, first.revision + 1);
  assert.deepEqual(
    conversations.read(alice, 'conv-b').providerId + ':' + conversations.read(alice, 'conv-b').model + ':' + conversations.read(alice, 'conv-b').archived,
    'p:m:false',
    'a partial field-mask update must not erase unmasked conversation fields',
  );
  assert.throws(
    () => service.updateConversation(alice, 'conv-b', { title: 'stale' }, { expectedRevision: first.revision }),
    (error) => error.code === 'revision_conflict',
  );

  messages.create(alice, 'msg-1', {
    conversationId: 'conv-b', role: 'user', content: 'hello',
    attachments: [{
      id: 'owned', name: 'note.txt', mime: 'text/plain', size: 3, ownerUserId: 'alice',
      residency: 'private-owned', mobileSyncAllowed: true, downloadToken: 'attachment-secret',
    }],
  });
  const proofCallsAfterCreate = service.attachmentProofCalls;
  messages.create(alice, 'msg-duplicates', {
    conversationId: 'conv-b', role: 'user', content: 'deduplicated',
    attachments: Array.from({ length: 32 }, () => ({ id: 'owned', ownerUserId: 'alice' })),
  });
  assert.equal(
    service.attachmentProofCalls,
    proofCallsAfterCreate + 2,
    'duplicate ids are removed before each write and response projection proof',
  );
  service.insertRawMessage({
    id: 'trace', ownerUserId: 'alice', revision: 1, createdAt: 1, updatedAt: 1,
    conversationId: 'conv-b', role: 'tool', content: 'secret call args', toolEvents: [{ apiKey: 'nope' }],
  });
  service.insertRawMessage({
    id: 'developer', ownerUserId: 'alice', revision: 1, createdAt: 1, updatedAt: 1,
    conversationId: 'conv-b', role: 'developer', content: 'developer instructions', attachments: [],
  });
  service.insertRawMessage({
    id: 'foreign-attachment', ownerUserId: 'alice', revision: 1, createdAt: 2, updatedAt: 2,
    conversationId: 'conv-b', role: 'assistant', content: 'visible',
    attachments: [{ id: 'shared', ownerUserId: 'bob', shared: true, name: 'other', mime: 'text/plain', size: 99 }],
    streamState: 'streaming', contextSnapshot: 'never sync',
  });
  service.insertRawMessage({
    id: 'tie-b', ownerUserId: 'alice', revision: 1, createdAt: 50, updatedAt: 50,
    conversationId: 'conv-b', role: 'assistant', content: 'second tie', attachments: [],
    usage: { inputTokens: 2, billingReference: 'usage-secret' },
  });
  service.insertRawMessage({
    id: 'tie-a', ownerUserId: 'alice', revision: 1, createdAt: 50, updatedAt: 50,
    conversationId: 'conv-b', role: 'assistant', content: 'first tie', attachments: [],
  });
  assert.deepEqual(messages.list(alice).map((row) => row.id), ['foreign-attachment', 'tie-a', 'tie-b', 'msg-1', 'msg-duplicates']);
  assert.deepEqual(messages.read(alice, 'foreign-attachment').attachments, []);
  assert.deepEqual(messages.read(alice, 'msg-1').attachments, [
    { id: 'owned', name: 'note.txt', mime: 'text/plain', size: 3 },
  ]);
  assert.doesNotMatch(
    JSON.stringify(messages.list(alice)),
    /secret call args|developer instructions|apiKey|contextSnapshot|streamState|shared|usage|usage-secret|downloadToken|attachment-secret/,
  );
  assert.throws(
    () => messages.create(alice, 'bad', { conversationId: 'conv-b', role: 'system', content: 'prompt', attachments: [] }),
    (error) => error.code === 'ai_message_role_forbidden',
  );
  assert.throws(
    () => messages.create(alice, 'bad-file', {
      conversationId: 'conv-b', role: 'user', content: 'x', attachments: [{ id: 'shared', ownerUserId: 'bob', shared: true }],
    }),
    (error) => error.code === 'attachment_not_syncable',
  );
  messages.update(alice, 'msg-1', { content: 'edited only' });
  assert.equal(messages.read(alice, 'msg-1').content, 'edited only');
  assert.equal(messages.read(alice, 'msg-1').role, 'user');
  assert.equal(messages.read(alice, 'msg-1').conversationId, 'conv-b');
  messages.remove(alice, 'msg-1');
  conversations.remove(alice, 'conv-b');
  assert.deepEqual(service.tombstones.map((row) => [row.entityType, row.id, row.revision]), [
    ['aiMessage', 'msg-1', 3],
    ['aiConversation', 'conv-b', 3],
  ]);
  const restoredConversation = conversations.restore(alice, 'conv-b');
  const restoredMessage = messages.restore(alice, 'msg-1');
  assert.equal(restoredConversation.revision, 4);
  assert.equal(restoredMessage.revision, 4);
});

test('all writers preserve actor provenance and the canonical mutation receipt object', () => {
  const service = historyService();
  const adapters = createAiHistoryEntityAdapters({ registry: readyRegistry(), service });
  const user = { userId: 'alice' };
  const conversation = adapters.get('aiConversation');
  const message = adapters.get('aiMessage');
  const receipt = {};
  const mutationContext = { actorDeviceId: 'device-7', mutationReceipt: receipt };

  conversation.create(user, 'conv', { title: 'Visible' }, mutationContext);
  conversation.update(user, 'conv', { title: 'Edited' }, mutationContext);
  message.create(user, 'msg', { conversationId: 'conv', role: 'user', content: 'hello' }, mutationContext);
  message.update(user, 'msg', {
    content: 'edited', usage: { inputTokens: 99 }, contextSnapshot: 'private', streamState: 'running', secret: 'x',
  }, mutationContext);
  message.remove(user, 'msg', mutationContext);
  conversation.remove(user, 'conv', mutationContext);
  conversation.restore(user, 'conv', mutationContext);
  message.restore(user, 'msg', mutationContext);

  assert.deepEqual(service.mutationContexts.map(({ operation }) => operation), [
    'createConversation', 'updateConversation', 'createMessage', 'updateMessage',
    'deleteMessage', 'deleteConversation', 'restoreConversation', 'restoreMessage',
  ]);
  for (const { context } of service.mutationContexts) {
    assert.equal(context.actorDeviceId, 'device-7');
    assert.equal(context.mutationReceipt, receipt);
  }
  assert.deepEqual(message.read(user, 'msg'), {
    id: 'msg', ownerUserId: 'alice', revision: 4, createdAt: 103, updatedAt: 108,
    conversationId: 'conv', role: 'user', content: 'edited', attachments: [],
  });
});

test('writers return a typed inaccessible error instead of reading a revision from null', () => {
  const adapters = createAiHistoryEntityAdapters({ registry: readyRegistry(), service: historyService() });
  const user = { userId: 'alice' };
  for (const operation of [
    () => adapters.get('aiConversation').update(user, 'missing', { title: 'x' }),
    () => adapters.get('aiConversation').remove(user, 'missing'),
    () => adapters.get('aiConversation').restore(user, 'missing'),
    () => adapters.get('aiMessage').update(user, 'missing', { content: 'x' }),
    () => adapters.get('aiMessage').remove(user, 'missing'),
    () => adapters.get('aiMessage').restore(user, 'missing'),
  ]) {
    assert.throws(operation, (error) => (
      error.code === 'resource_not_found_or_inaccessible' && error.status === 404
    ));
  }
});

test('an incomplete persistence service cannot accidentally enable either type', () => {
  const service = historyService();
  service.mobileSyncCapabilities.atomicChangeFeed = false;
  const capability = getAiHistorySyncCapability({ registry: readyRegistry(), service });
  assert.equal(capability.enabled, false);
  assert.equal(capability.code, 'ai_history_capability_missing');
  assert.ok(capability.missing.includes('atomicChangeFeed'));
  assert.deepEqual([...createAiHistoryEntityAdapters({ registry: readyRegistry(), service })], []);
});
