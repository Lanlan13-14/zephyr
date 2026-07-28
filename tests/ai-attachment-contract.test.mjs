import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const app = read('public/app.js');
const agent = read('ai-agent-service.js');
const server = read('server.js');
const fsMod = read('ai-session-fs.js');

test('attachment API routes exist and use multer memory storage', () => {
  assert.match(agent, /app\.post\('\/api\/ai\/attachments'/);
  assert.match(agent, /app\.get\('\/api\/ai\/attachments'/);
  assert.match(agent, /app\.delete\('\/api\/ai\/attachments\/:id'/);
  assert.match(agent, /multer\.memoryStorage/);
  assert.match(server, /sessionFs: aiSessionFs/);
  assert.match(fsMod, /ai-sessions/);
});

test('frontend uploads FormData refs and never embeds dataUrl content', () => {
  assert.match(app, /apiMaybeForm\('\/api\/ai\/attachments'/);
  assert.match(app, /attachments: attachmentIds/);
  assert.match(app, /sanitizeAiChatSessionsForStorage/);
  assert.match(app, /stripAiHistoryBase64/);
  assert.doesNotMatch(app, /content: `附件图片：\$\{file\.name\}\\n\$\{dataUrl\}`/);
  assert.match(app, /发送附件需要 Go Runtime|attachments\.length && !useRuntime/);
});

test('runtime startRun resolves attachment ids into multimodal parts', () => {
  assert.match(server, /buildUserParts/);
  assert.match(server, /req\.body\?\.attachments/);
  assert.match(server, /parts: contentParts/);
});
