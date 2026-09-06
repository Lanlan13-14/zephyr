import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing ${start}`);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
}

function storageHarness() {
  const values = new Map();
  const context = vm.createContext({
    AI_CHAT_STORAGE_KEY: 'zephyr.ai.chats',
    aiChatSessions: [],
    aiCurrentSessionId: null,
    myIdentity: { userId: 'owner-a' },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  vm.runInContext(
    between('function aiHistoryCacheMetadata', 'async function loadAiChats'),
    context,
    { filename: 'public/app.js#ai-history-storage' },
  );
  return { context, values };
}

test('AI browser persistence stores routing metadata but no transcript or attachment refs', () => {
  const { context, values } = storageHarness();
  context.aiCurrentSessionId = 'conversation-a';
  context.aiChatSessions = [{
    id: 'conversation-a',
    runtimeSessionId: 'runtime-a',
    collabMode: 'standard',
    runProfile: 'balanced',
    permissionMode: 'ask',
    title: 'SECRET_TITLE_CANARY',
    messages: [{ role: 'user', content: 'SECRET_MESSAGE_CANARY' }],
    attachments: [{ id: 'SECRET_ATTACHMENT_CANARY' }],
  }];

  context.saveAiChats();
  const raw = values.get('zephyr.ai.chats');
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored).sort(), ['current', 'ownerUserId', 'sessions', 'version']);
  assert.deepEqual(Object.keys(stored.sessions[0]).sort(), [
    'collabMode', 'id', 'permissionMode', 'runProfile', 'runtimeSessionId',
  ]);
  assert.doesNotMatch(raw, /SECRET_TITLE_CANARY|SECRET_MESSAGE_CANARY|SECRET_ATTACHMENT_CANARY/);
});

test('ownerless v1 browser history is deleted instead of assigned to the active account', () => {
  const { context, values } = storageHarness();
  values.set('zephyr.ai.chats', JSON.stringify({
    version: 1,
    current: 'legacy',
    sessions: [{ id: 'legacy', messages: [{ content: 'SECRET_LEGACY_CANARY' }] }],
  }));

  const cache = context.readAiHistoryMetadataCache();
  assert.equal(values.has('zephyr.ai.chats'), false);
  assert.equal(cache.current, '');
  assert.equal(cache.sessions.length, 0);
});

test('AI history UI loads canonical rows and refreshes from the owner wake stream', () => {
  const loading = between('async function loadAiChats', 'function ensureCanonicalAiConversation');
  const wake = between('function createBrowserChangeWakeClient', 'async function init()');
  assert.match(loading, /api\('\/api\/ai\/history\/conversations\?withMessages=1'\)/);
  assert.match(loading, /messages:\s*Array\.isArray\(conversation\.messages\)/);
  assert.match(wake, /endpoint:\s*'\/api\/me\/change-wake'/);
  assert.match(wake, /aiConversation:\s*'aiHistory'[\s\S]*aiMessage:\s*'aiHistory'/);
  assert.match(wake, /aiHistory:\s*\(\)\s*=>\s*scheduleAiHistoryReload\(120\)/);
  assert.doesNotMatch(source, /\/api\/ai\/history\/events/);
});

test('delete, clear, edit, and regeneration use canonical CAS deletes', () => {
  const conversationDelete = between('async function deleteAiChatConfirmed', 'async function clearCurrentAiChat');
  const clear = between('async function clearCurrentAiChat', 'function updateAiPanelResponsiveState');
  const tailDelete = between('async function deleteCanonicalAiTail', 'async function sendAiMessage');
  const send = between('async function sendAiMessage()', 'async function appendAiFiles');

  /* The delete must still be a canonical CAS delete — an expectedRevision is always sent. The
   * revision now comes from the canonical-ized session (a refetched `revision` local), not the
   * possibly-stale in-memory `target.revision`, so a 0 or stale revision can no longer silently
   * skip or 409 the server delete. */
  assert.match(conversationDelete, /api\(`\/api\/ai\/history\/conversations\/[\s\S]*expectedRevision=/);
  assert.match(conversationDelete, /method:\s*'DELETE'/);
  assert.match(conversationDelete, /revision_conflict/);
  assert.match(clear, /api\(`\/api\/ai\/history\/conversations\/[\s\S]*expectedRevision=/);
  assert.match(tailDelete, /api\(`\/api\/ai\/history\/messages\/[\s\S]*expectedRevision=/);
  assert.match(send, /await deleteCanonicalAiTail\(session,\s*editingIndex\)/);
  assert.match(send, /session\.messages\s*=\s*session\.messages\.slice\(0,/);
});

test('legacy followups retain the original safe history commit across confirmations', () => {
  const remoteFollowup = between('async function continueAiAfterRemoteDesktopClientActions', 'function maskAiSensitive');
  const confirmationFollowup = between('async function continueAiAfterConfirmation', 'function localizedAiConfirmationSummary');

  assert.match(remoteFollowup, /historyCommit:\s*historyCommit\s*\|\|\s*undefined/);
  assert.match(remoteFollowup, /appendAiConfirmation\([\s\S]*historyCommit\s*\}/);
  assert.match(confirmationFollowup, /historyCommit:\s*pending\.historyCommit\s*\|\|\s*undefined/);
  assert.match(confirmationFollowup, /appendAiConfirmation\([\s\S]*historyCommit:\s*pending\.historyCommit/);
});

test('server startup shares one canonical history service across Web, Runtime, and Mobile', () => {
  assert.match(serverSource, /const aiHistoryService = new AiHistoryService\(storage\.rawDb\(\), aiHistoryServiceOptions\(\)\)/);
  assert.match(serverSource, /const aiHistoryRuntime = new AiHistoryRuntimeController\(\{ service: aiHistoryService \}\)/);
  assert.match(serverSource, /aiRuntimeBridge\.setHistoryController\(aiHistoryRuntime\)/);
  assert.match(serverSource, /registerAiHistoryRoutes\(app,\s*\{[\s\S]*?service:\s*aiHistoryService,[\s\S]*?controller:\s*aiHistoryRuntime/);

  const mobileConstructions = serverSource.match(/new MobileV1Api\(\{[\s\S]*?aiHistoryService,[\s\S]*?entityRegistry:/g) || [];
  assert.equal(mobileConstructions.length, 2, 'initial and post-import Mobile V1 runtimes must share canonical history');
  assert.match(serverSource, /registerAiRoutes\(app,\s*\{[\s\S]*?aiHistoryRuntime,/);
});

test('database replacement and account lifecycle discard pending plaintext before authority changes', () => {
  const rebuild = serverSource.slice(
    serverSource.indexOf('function rebuildAuthServices()'),
    serverSource.indexOf('const MAX_IMPORT_DATABASE_BYTES'),
  );
  const resetAt = rebuild.indexOf('aiHistoryRuntime.reset()');
  const rebuildServiceAt = rebuild.indexOf('Object.assign(aiHistoryService, new AiHistoryService');
  assert.ok(resetAt >= 0 && rebuildServiceAt > resetAt, 'pending runs must be reset before service rebinding');

  const lifecycle = serverSource.slice(
    serverSource.indexOf('const webDavUserLifecycle ='),
    serverSource.indexOf('async function prepareMobileUserStateDeletion'),
  );
  assert.equal((lifecycle.match(/aiHistoryRuntime\.deleteUserState\(userId\)/g) || []).length, 2);
  assert.equal((lifecycle.match(/aiHistoryService\.deleteUserState\(userId\)/g) || []).length, 2);
});

test('runtime route sends canonical bootstrap separately and registers only the completed-turn commit', () => {
  const route = serverSource.slice(
    serverSource.indexOf("app.post('/api/ai/runtime/runs'"),
    serverSource.indexOf("app.post('/api/ai/runtime/runs/:id/abort'"),
  );
  assert.match(route, /aiHistoryRuntime\.ensureConversation\(req\.user,/);
  assert.match(route, /aiHistoryRuntime\.bootstrapMessages\(req\.user, canonicalConversation\.id\)/);
  assert.match(route, /aiRuntimeBridge\.startRun\(req\.user,\s*\{[\s\S]*?bootstrapMessages:\s*canonicalBootstrapMessages,[\s\S]*?historyCommit:/);
  assert.match(route, /historyUserContent\s*\?\?\s*req\.body\?\.message/);
});
