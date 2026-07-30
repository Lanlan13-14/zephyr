import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { executeAiToolForHost } from '../ai-agent-service.js';

const root = path.resolve(import.meta.dirname, '..');
const agentSource = readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');

function baseDeps(sessionFs) {
  return {
    storage: { getSettings: () => ({ ai: { permissions: {} } }) },
    sessionFs,
  };
}

test('attachment read uses authoritative runtime session over local/model ids', async () => {
  const calls = [];
  const result = await executeAiToolForHost('user_attachment_read_v1', {
    sessionId: 'model-stale-session',
    attachmentId: 'att-1',
  }, {
    user: { userId: 'u1', role: 'user' },
    sessionId: 'runtime-session',
    context: {
      runtimeSessionId: 'context-runtime-session',
      aiChatSessionId: 'browser-chat-session',
    },
    deps: baseDeps({
      async readAttachmentBytes(userId, sessionId, attachmentId) {
        calls.push({ userId, sessionId, attachmentId });
        return {
          item: { id: attachmentId, name: 'hello.txt', mime: 'text/plain', kind: 'text', size: 5 },
          data: Buffer.from('hello'),
        };
      },
    }),
  });

  assert.deepEqual(calls, [{ userId: 'u1', sessionId: 'runtime-session', attachmentId: 'att-1' }]);
  assert.equal(result.data.content, 'hello');
});

test('attachment read falls back to context runtime id before browser/model ids', async () => {
  let usedSessionId = '';
  await executeAiToolForHost('user_attachment_read_v1', {
    sessionId: 'model-stale-session',
    attachmentId: 'att-2',
  }, {
    user: { userId: 'u1', role: 'user' },
    context: {
      runtimeSessionId: 'context-runtime-session',
      aiChatSessionId: 'browser-chat-session',
    },
    deps: baseDeps({
      async readAttachmentBytes(_userId, sessionId, attachmentId) {
        usedSessionId = sessionId;
        return {
          item: { id: attachmentId, name: 'hello.txt', mime: 'text/plain', kind: 'text', size: 5 },
          data: Buffer.from('hello'),
        };
      },
    }),
  });
  assert.equal(usedSessionId, 'context-runtime-session');
});

test('all session-scoped tools share the authoritative resolver', () => {
  const uses = agentSource.match(/const sessionId = resolveAiSessionId\(args, ctx\);/g) || [];
  assert.equal(uses.length, 6, 'workspace, attachment and sandbox tools must use one resolver');
  assert.doesNotMatch(agentSource, /args\.sessionId \|\| ctx\?\.context\?\.aiChatSessionId \|\| ctx\?\.sessionId/);
  assert.match(agentSource, /ctx\?\.sessionId\s*\n\s*\|\| ctx\?\.context\?\.runtimeSessionId/);
});
