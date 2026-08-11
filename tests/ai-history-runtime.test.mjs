import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  AiHistoryRuntimeController,
  AiHistoryWakeHub,
  registerAiHistoryRoutes,
} from '../ai-history-runtime.js';
import { AiRuntimeBridge } from '../ai-runtime-bridge.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1ChangeBridge } = require(path.join(repoRoot, 'mobile-v1-change-bridge.js'));
const { AiHistoryService } = require(path.join(repoRoot, 'ai-history-service.js'));
const sourceRegistry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function readyRegistry() {
  const registry = structuredClone(sourceRegistry);
  for (const type of ['aiConversation', 'aiMessage']) {
    registry.entities.find((entry) => entry.type === type).status = 'implemented-runtime-test';
  }
  return registry;
}

function fakeHistoryService() {
  const conversations = new Map();
  const messages = new Map();
  const commits = [];
  const tombstones = [];
  const owner = (user) => String(user?.userId || '');
  const owned = (map, user, id, code) => {
    const row = map.get(String(id));
    if (!row || row.ownerUserId !== owner(user) || row.deletedAt) {
      const error = new Error('not found');
      error.code = code;
      error.status = 404;
      throw error;
    }
    return row;
  };
  return {
    conversations,
    messages,
    commits,
    tombstones,
    createConversation(user, patch) {
      const row = { revision: 1, createdAt: Date.now(), updatedAt: Date.now(), archived: false, ...patch, ownerUserId: owner(user) };
      conversations.set(row.id, row);
      return { ...row };
    },
    readConversation(user, id) { return { ...owned(conversations, user, id, 'ai_conversation_not_found') }; },
    listConversations(user) { return [...conversations.values()].filter((row) => row.ownerUserId === owner(user) && !row.deletedAt).map((row) => ({ ...row })); },
    updateConversation(user, id, patch, options = {}) {
      const row = owned(conversations, user, id, 'ai_conversation_not_found');
      if (options.expectedRevision && options.expectedRevision !== row.revision) {
        const error = new Error('revision conflict'); error.code = 'revision_conflict'; error.status = 409; throw error;
      }
      Object.assign(row, patch, { revision: row.revision + 1, updatedAt: Date.now() });
      return { ...row };
    },
    deleteConversation(user, id) {
      const row = owned(conversations, user, id, 'ai_conversation_not_found');
      row.deletedAt = Date.now(); row.revision += 1;
      tombstones.push(['conversation', id, row.ownerUserId]);
      return true;
    },
    listMessages(user, { conversationId } = {}) {
      return [...messages.values()].filter((row) => row.ownerUserId === owner(user) && !row.deletedAt && (!conversationId || row.conversationId === conversationId)).map((row) => ({ ...row }));
    },
    readMessage(user, id) { return { ...owned(messages, user, id, 'ai_message_not_found') }; },
    updateMessage(user, id, patch) {
      const row = owned(messages, user, id, 'ai_message_not_found');
      Object.assign(row, patch, { revision: row.revision + 1, updatedAt: Date.now() });
      return { ...row };
    },
    deleteMessage(user, id) {
      const row = owned(messages, user, id, 'ai_message_not_found'); row.deletedAt = Date.now(); row.revision += 1;
      tombstones.push(['message', id, row.ownerUserId]); return true;
    },
    appendCompletedTurn(user, conversationId, turn, options = {}) {
      const conversation = owned(conversations, user, conversationId, 'ai_conversation_not_found');
      if (options.expectedRevision && options.expectedRevision !== conversation.revision) {
        const error = new Error('revision conflict'); error.code = 'revision_conflict'; error.status = 409; throw error;
      }
      const nextConversation = { ...conversation, ...(turn.conversationPatch || {}), revision: conversation.revision + 1, updatedAt: Date.now() };
      conversations.set(conversationId, nextConversation);
      const resultMessages = [turn.userMessage, turn.assistantMessage].map((message) => {
        const row = { revision: 1, createdAt: Date.now(), updatedAt: Date.now(), attachments: [], ...message, conversationId, ownerUserId: owner(user) };
        messages.set(row.id, row);
        return { ...row };
      });
      commits.push({ ownerUserId: owner(user), conversationId, turn: structuredClone(turn) });
      return { conversation: { ...nextConversation }, messages: resultMessages };
    },
    migrateLegacyOwnedHistory(user, sessions) {
      return { imported: sessions.length, ownerUserId: owner(user) };
    },
  };
}

function appServer(service, wakeHub = null) {
  const app = express();
  app.use(express.json());
  const requireUser = (req, res, next) => {
    const userId = String(req.headers['x-test-user'] || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    req.user = { userId };
    next();
  };
  const controller = new AiHistoryRuntimeController({ service, wakeHub, idFactory: (() => { let n = 0; return () => `generated-${++n}`; })() });
  registerAiHistoryRoutes(app, { requireUser, service, controller, wakeHub });
  const server = http.createServer(app);
  return { server, controller };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function json(base, path, userId, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-test-user': userId, ...(init.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
}

test('web history routes create, rename, list and delete only owner-scoped canonical rows', async (t) => {
  const service = fakeHistoryService();
  const { server } = appServer(service);
  const base = await listen(server);
  t.after(() => server.close());

  const created = await json(base, '/api/ai/history/conversations', 'alice', {
    method: 'POST', body: JSON.stringify({ id: 'conv-1', title: 'first' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.conversation.ownerUserId, 'alice');

  const renamed = await json(base, '/api/ai/history/conversations/conv-1', 'alice', {
    method: 'PATCH', body: JSON.stringify({ title: 'renamed', expectedRevision: 1 }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.conversation.title, 'renamed');

  const foreignRead = await json(base, '/api/ai/history/conversations/conv-1/messages', 'bob');
  assert.equal(foreignRead.status, 404);
  const foreignDelete = await json(base, '/api/ai/history/conversations/conv-1', 'bob', { method: 'DELETE' });
  assert.equal(foreignDelete.status, 404);
  assert.equal(service.conversations.get('conv-1').deletedAt, undefined);

  const deleted = await json(base, '/api/ai/history/conversations/conv-1', 'alice', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(service.tombstones, [['conversation', 'conv-1', 'alice']]);
});

test('runtime persists one completed turn and excludes partial, tool args, results and usage', () => {
  const service = fakeHistoryService();
  service.createConversation({ userId: 'alice' }, { id: 'conv-1', title: 'safe' });
  const controller = new AiHistoryRuntimeController({ service, idFactory: (() => { let n = 0; return () => `m-${++n}`; })() });

  controller.beginRun({ userId: 'alice' }, 'run-1', {
    conversationId: 'conv-1',
    userMessage: { id: 'user-1', content: 'safe question' },
    assistantMessageId: 'assistant-1',
    providerId: 'provider-1',
    model: 'model-1',
  });
  controller.observeEvent('run-1', { type: 'text.delta', data: { text: 'partial SECRET_PARTIAL' } });
  controller.observeEvent('run-1', { type: 'tool.pending', data: { name: 'secret_tool', args: { apiKey: 'SECRET_ARGS' } } });
  controller.observeEvent('run-1', { type: 'tool.result', data: { result: { token: 'SECRET_RESULT' } } });
  assert.equal(service.commits.length, 0);
  controller.observeEvent('run-1', { type: 'message.completed', data: { role: 'assistant', content: 'final answer' } });
  const persisted = controller.observeEvent('run-1', { type: 'run.completed', data: { metrics: { usage: 'SECRET_USAGE' } } });
  assert.ok(persisted);
  assert.equal(service.commits.length, 1);
  assert.deepEqual([...service.messages.values()].map(({ role, content }) => [role, content]), [
    ['user', 'safe question'],
    ['assistant', 'final answer'],
  ]);
  assert.doesNotMatch(JSON.stringify(service.commits), /SECRET_PARTIAL|SECRET_ARGS|SECRET_RESULT|SECRET_USAGE|secret_tool/);
  assert.equal(controller.observeEvent('run-1', { type: 'run.completed', data: {} }), null, 'terminal replay is idempotent');
});

test('runtime completion retries a concurrent conversation revision without overwriting its rename', () => {
  const service = fakeHistoryService();
  service.createConversation({ userId: 'alice' }, { id: 'conv-1', title: 'initial', providerId: 'old-p', model: 'old-m' });
  const controller = new AiHistoryRuntimeController({ service });
  controller.beginRun({ userId: 'alice' }, 'run-rename', {
    conversationId: 'conv-1', title: 'automatic title', providerId: 'new-p', model: 'new-m',
    userMessage: { id: 'u-rename', content: 'question' }, assistantMessageId: 'a-rename',
  });
  service.updateConversation({ userId: 'alice' }, 'conv-1', { title: 'renamed elsewhere' }, { expectedRevision: 1 });
  controller.observeEvent('run-rename', { type: 'message.completed', data: { role: 'assistant', content: 'answer' } });
  controller.observeEvent('run-rename', { type: 'run.completed', data: {} });
  assert.equal(service.conversations.get('conv-1').title, 'renamed elsewhere');
  assert.equal(service.messages.size, 2);
});

test('runtime bridge monitors completion independently and sends canonical bootstrap on a separate field', async () => {
  const service = fakeHistoryService();
  service.createConversation({ userId: 'alice' }, { id: 'conv-1', title: 'safe', providerId: 'p', model: 'm' });
  service.messages.set('prior-u', { id: 'prior-u', ownerUserId: 'alice', conversationId: 'conv-1', role: 'user', content: 'prior question', revision: 1 });
  service.messages.set('prior-a', { id: 'prior-a', ownerUserId: 'alice', conversationId: 'conv-1', role: 'assistant', content: 'prior answer', revision: 1 });
  const controller = new AiHistoryRuntimeController({ service });
  const requests = [];
  const sse = [
    'event: text.delta\ndata: {"type":"text.delta","runId":"run-1","data":{"text":"SECRET_PARTIAL"}}\n\n',
    'event: tool.result\ndata: {"type":"tool.result","runId":"run-1","data":{"result":{"apiKey":"SECRET_TOOL"}}}\n\n',
    'event: message.completed\ndata: {"type":"message.completed","runId":"run-1","data":{"role":"assistant","content":"final answer"}}\n\n',
    'event: run.completed\ndata: {"type":"run.completed","runId":"run-1","data":{"metrics":{"secret":"SECRET_USAGE"}}}\n\n',
  ].join('');
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (String(url).endsWith('/admin/runs')) {
      return new Response(JSON.stringify({ ok: true, runId: 'run-1', sessionId: 'runtime-1', ticket: 'ticket-1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const bridge = new AiRuntimeBridge({
    baseUrl: 'http://runtime.test', adminToken: 'admin', fetchImpl, historyController: controller,
  });
  const bootstrapMessages = controller.bootstrapMessages({ userId: 'alice' }, 'conv-1');
  await bridge.startRun({ userId: 'alice' }, {
    sessionId: 'runtime-1', provider: { id: 'p' }, model: 'm', message: 'new question',
    bootstrapMessages,
    historyCommit: {
      conversationId: 'conv-1', title: 'safe', providerId: 'p', model: 'm',
      userMessage: { id: 'new-u', content: 'new question' }, assistantMessageId: 'new-a',
    },
  });
  await bridge.historyMonitors.get('run-1');
  const posted = JSON.parse(requests[0].init.body);
  assert.deepEqual(posted.bootstrapMessages, [
    { role: 'user', content: 'prior question' },
    { role: 'assistant', content: 'prior answer' },
  ]);
  assert.equal(posted.historyCommit, undefined);
  assert.deepEqual([...service.messages.values()].slice(-2).map(({ role, content }) => [role, content]), [
    ['user', 'new question'], ['assistant', 'final answer'],
  ]);
  assert.doesNotMatch(JSON.stringify(service.commits), /SECRET_PARTIAL|SECRET_TOOL|SECRET_USAGE/);
});

test('cancelled and failed runtime runs never persist partial transcript', () => {
  const service = fakeHistoryService();
  service.createConversation({ userId: 'alice' }, { id: 'conv-1', title: 'safe' });
  const controller = new AiHistoryRuntimeController({ service });
  for (const [runId, terminal] of [['run-abort', 'run.aborted'], ['run-fail', 'run.failed']]) {
    controller.beginRun({ userId: 'alice' }, runId, {
      conversationId: 'conv-1', userMessage: { content: `question-${runId}` },
    });
    controller.observeEvent(runId, { type: 'text.delta', data: { text: 'do not store' } });
    controller.observeEvent(runId, { type: terminal, data: { error: 'SECRET_ERROR' } });
  }
  assert.equal(service.commits.length, 0);
  assert.equal(service.messages.size, 0);
});

test('database generation reset and account deletion discard pending plaintext', () => {
  const service = fakeHistoryService();
  service.createConversation({ userId: 'alice' }, { id: 'conv-a', title: 'a' });
  service.createConversation({ userId: 'bob' }, { id: 'conv-b', title: 'b' });
  const controller = new AiHistoryRuntimeController({ service });
  controller.beginRun({ userId: 'alice' }, 'run-a', { conversationId: 'conv-a', userMessage: { content: 'alice pending secret' } });
  controller.beginRun({ userId: 'bob' }, 'run-b', { conversationId: 'conv-b', userMessage: { content: 'bob pending secret' } });
  assert.equal(controller.deleteUserState('alice'), 1);
  assert.equal(controller.observeEvent('run-a', { type: 'message.completed', data: { content: 'late old-db answer' } }), null);
  assert.equal(controller.pendingRuns.size, 1);
  assert.equal(controller.reset(), 1);
  assert.equal(controller.observeEvent('run-b', { type: 'run.completed', data: {} }), null);
  assert.equal(service.commits.length, 0);
});

test('canonical bootstrap is role- and owner-scoped and never carries attachment or runtime fields', () => {
  const service = fakeHistoryService();
  service.createConversation({ userId: 'alice' }, { id: 'conv-a', title: 'a' });
  service.createConversation({ userId: 'bob' }, { id: 'conv-b', title: 'b' });
  service.messages.set('a-user', { id: 'a-user', ownerUserId: 'alice', conversationId: 'conv-a', role: 'user', content: 'hello', revision: 1, toolEvents: 'SECRET_TOOL' });
  service.messages.set('a-ai', { id: 'a-ai', ownerUserId: 'alice', conversationId: 'conv-a', role: 'assistant', content: 'world', revision: 1, usage: 'SECRET_USAGE' });
  service.messages.set('a-system', { id: 'a-system', ownerUserId: 'alice', conversationId: 'conv-a', role: 'system', content: 'SECRET_SYSTEM', revision: 1 });
  service.messages.set('b-user', { id: 'b-user', ownerUserId: 'bob', conversationId: 'conv-b', role: 'user', content: 'SECRET_BOB', revision: 1 });
  const controller = new AiHistoryRuntimeController({ service });
  assert.deepEqual(controller.bootstrapMessages({ userId: 'alice' }, 'conv-a'), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ]);
  assert.deepEqual(controller.bootstrapMessages({ userId: 'alice' }, 'conv-b'), []);
});

test('ownerless or foreign legacy browser history is rejected instead of assigned to current account', async (t) => {
  const service = fakeHistoryService();
  const { server } = appServer(service);
  const base = await listen(server);
  t.after(() => server.close());
  for (const sessions of [
    [{ id: 'old-ownerless', messages: [] }],
    [{ id: 'old-bob', ownerUserId: 'bob', messages: [] }],
  ]) {
    const result = await json(base, '/api/ai/history/import-owned-legacy', 'alice', {
      method: 'POST', body: JSON.stringify({ sessions }),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'legacy_history_owner_unproven');
  }
});

test('real SQLite service, REST and runtime completion share one atomic owner feed', async (t) => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  db.pragma('foreign_keys = ON');
  const bridge = new MobileV1ChangeBridge({ db, registry: readyRegistry() });
  const wakeHub = new AiHistoryWakeHub({ heartbeatMs: 60_000 });
  const service = new AiHistoryService(db, {
    mobileChangeBridge: bridge,
    attachmentResolver: () => null,
    onMutation: ({ ownerUserId }) => wakeHub.publish(ownerUserId),
  });
  const { server, controller } = appServer(service, wakeHub);
  const base = await listen(server);
  t.after(() => { wakeHub.close(); server.close(); db.close(); });

  const created = await json(base, '/api/ai/history/conversations', 'alice', {
    method: 'POST', body: JSON.stringify({ id: 'real-conv', title: 'question' }),
  });
  assert.equal(created.status, 201);
  controller.beginRun({ userId: 'alice' }, 'real-run', {
    conversationId: 'real-conv',
    userMessage: { id: 'real-user', content: 'visible question' },
    assistantMessageId: 'real-assistant',
  });
  controller.observeEvent('real-run', { type: 'text.delta', data: { text: 'SECRET_PARTIAL' } });
  controller.observeEvent('real-run', { type: 'tool.result', data: { result: { token: 'SECRET_TOOL' } } });
  controller.observeEvent('real-run', { type: 'message.completed', data: { role: 'assistant', content: 'visible answer' } });
  controller.observeEvent('real-run', { type: 'run.completed', data: { usage: 'SECRET_USAGE' } });

  const history = await json(base, '/api/ai/history/conversations?withMessages=1', 'alice');
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.conversations[0].messages.map(({ role, content }) => [role, content]), [
    ['user', 'visible question'], ['assistant', 'visible answer'],
  ]);
  assert.doesNotMatch(JSON.stringify(history.body), /SECRET_PARTIAL|SECRET_TOOL|SECRET_USAGE/);
  const changes = bridge.store.changePage('alice', 0, 100).changes;
  assert.deepEqual(changes.map(({ entityType, entityId }) => [entityType, entityId]), [
    ['aiConversation', 'real-conv'],
    ['aiMessage', 'real-user'],
    ['aiMessage', 'real-assistant'],
  ]);
  assert.equal(
    bridge.store.getEntityVersion('alice', 'aiConversation', 'real-conv').revision,
    2,
    'server-authority-only conversation touch advances the revision ledger without an empty field change',
  );

  const missingCas = await json(base, '/api/ai/history/messages/real-assistant', 'alice', { method: 'DELETE', body: '{}' });
  assert.equal(missingCas.status, 400);
  assert.equal(missingCas.body.code, 'expected_revision_required');
  const foreign = await json(base, '/api/ai/history/conversations?withMessages=1', 'bob');
  assert.deepEqual(foreign.body.conversations, []);
});

test('browser wake stream is owner-scoped and carries no row payload', async (t) => {
  const service = fakeHistoryService();
  const wakeHub = new AiHistoryWakeHub({ heartbeatMs: 60_000 });
  const { server } = appServer(service, wakeHub);
  const base = await listen(server);
  t.after(() => { wakeHub.close(); server.close(); });

  const abort = new AbortController();
  const response = await fetch(`${base}/api/ai/history/events`, { headers: { 'x-test-user': 'alice' }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let transcript = decoder.decode((await reader.read()).value || new Uint8Array());
  wakeHub.publish('bob');
  wakeHub.publish('alice');
  while (!transcript.includes('event: change')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    transcript += decoder.decode(chunk.value);
  }
  abort.abort();
  assert.match(transcript, /event: change/);
  assert.doesNotMatch(transcript, /conversation|message|provider|model|content|bob/);
});
