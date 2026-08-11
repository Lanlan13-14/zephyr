import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const app = read('public/app.js');
const agent = read('ai-agent-service.js');
const server = read('server.js');
const fsMod = read('ai-session-fs.js');
const history = read('ai-history-service.js');

function appStorageHarness() {
  const start = app.indexOf('function aiHistoryCacheMetadata');
  const end = app.indexOf('async function loadAiChats', start);
  assert.ok(start >= 0 && end > start, 'canonical AI browser cache helpers must exist');
  const values = new Map();
  const context = vm.createContext({
    AI_CHAT_STORAGE_KEY: 'zephyr-ai-chat-sessions',
    aiChatSessions: [],
    aiCurrentSessionId: null,
    myIdentity: { userId: 'owner-a' },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  vm.runInContext(app.slice(start, end), context, { filename: 'public/app.js#ai-history-cache' });
  return { context, values };
}

test('attachment API routes exist and use multer memory storage', () => {
  assert.match(agent, /app\.post\('\/api\/ai\/attachments'/);
  assert.match(agent, /app\.get\('\/api\/ai\/attachments'/);
  assert.match(agent, /app\.delete\('\/api\/ai\/attachments\/:id'/);
  assert.match(agent, /multer\.memoryStorage/);
  assert.match(server, /sessionFs: aiSessionFs/);
  assert.match(fsMod, /ai-sessions/);
});

test('frontend uploads FormData refs and browser persistence keeps metadata only', () => {
  assert.match(app, /apiMaybeForm\('\/api\/ai\/attachments'/);
  assert.match(app, /attachments: attachmentIds/);
  assert.doesNotMatch(app, /content: `附件图片：\$\{file\.name\}\\n\$\{dataUrl\}`/);
  assert.match(app, /发送附件需要 Go Runtime|attachments\.length && !useRuntime/);
});

test('browser AI cache excludes transcript, attachment, and large payload data', () => {
  const { context, values } = appStorageHarness();
  context.aiCurrentSessionId = 'conversation-a';
  context.aiChatSessions = [{
    id: 'conversation-a',
    runtimeSessionId: 'runtime-a',
    title: 'SECRET_TITLE_CANARY',
    messages: [{
      role: 'user',
      content: `data:image/png;base64,SECRET_INLINE_CANARY${'A'.repeat(2_200_000)}`,
      attachments: [{ id: 'SECRET_ATTACHMENT_CANARY', dataUrl: 'SECRET_ATTACHMENT_PAYLOAD_CANARY' }],
    }],
  }];
  context.saveAiChats();

  const raw = values.get('zephyr-ai-chat-sessions');
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored.sessions[0]).sort(), [
    'collabMode', 'id', 'permissionMode', 'runProfile', 'runtimeSessionId',
  ]);
  assert.doesNotMatch(raw, /SECRET_TITLE_CANARY|SECRET_INLINE_CANARY|SECRET_ATTACHMENT_CANARY|SECRET_ATTACHMENT_PAYLOAD_CANARY/);
  assert.ok(raw.length < 1024, 'large transcript and attachment payloads must not enter browser persistence');
});

test('canonical history rejects inline payloads and derives bounded attachment references', () => {
  assert.match(history, /const MAX_CONTENT_CHARS = 2 \* 1024 \* 1024/);
  assert.match(history, /if \(value\.length > MAX_CONTENT_CHARS\)/);
  assert.match(history, /INLINE_DATA_URL\.test\(value\)/);
  assert.match(history, /this\.attachmentResolver\(user, \{ \.\.\.attachment, id: requestedId \}\)/);
  assert.match(history, /safe\.push\(\{\s*id: resolved\.id,\s*name: resolved\.name,\s*mime: resolved\.mime,\s*size: resolved\.size,\s*\}\)/);
});

test('runtime startRun resolves attachment ids into multimodal parts', () => {
  assert.match(server, /buildUserParts/);
  assert.match(server, /req\.body\?\.attachments/);
  assert.match(server, /parts: contentParts/);
});
