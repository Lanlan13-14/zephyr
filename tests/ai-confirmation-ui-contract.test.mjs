import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const goServer = readFileSync(path.join(root, 'zephyr-ai/internal/server/server.go'), 'utf8');

function extractFn(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(m, `${name} missing`);
  const paren = src.indexOf('(', m.index);
  let pd = 0, brace = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    else if (src[i] === '{' && pd === 0) { brace = i; break; }
  }
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`failed to extract ${name}`);
}

test('confirmation click resolves the closest action exactly once', () => {
  const fn = extractFn(app, 'handleAiChatAreaClick');
  assert.match(fn, /closest\?\.\('\[data-ai-confirm-approve\],\[data-ai-confirm-deny\]'\)/);
  assert.match(fn, /if \(!button \|\| button\.disabled\) return/);
  assert.match(fn, /event\.preventDefault\(\)/);
  assert.match(fn, /event\.stopPropagation\(\)/);
  assert.match(fn, /item\.disabled = true/);
  assert.match(fn, /resolveAiConfirmation\(id, !!approveId\)/);
});

test('paused permission run cannot turn first approval click into abort', () => {
  const resolve = extractFn(app, 'resolveAiConfirmation');
  assert.match(resolve, /const activeController = aiRunForSession\(sessionId\)/);
  assert.match(resolve, /if \(pending && activeController\)[\s\S]*?activeController\.abort\(\)[\s\S]*?clearAiSessionRun/);
  assert.doesNotMatch(resolve, /if \(aiIsSessionRunning\(sessionId\)\) \{ stopAiResponse\(sessionId\); return; \}/);
  assert.match(app, /case 'permission\.ask':[\s\S]*?abortController\.abort\(\)[\s\S]*?clearAiSessionRun\(sessionId, abortController\)/);
});

test('permission resume returns and stores a fresh SSE ticket', () => {
  assert.match(goServer, /ticket := s\.issueTicket\(userID, runID, sessionID\)/);
  assert.match(goServer, /"sessionId": sessionID, "ticket": ticket/);
  const resolve = extractFn(app, 'resolveAiConfirmation');
  assert.match(resolve, /const permissionResult = await api/);
  assert.match(resolve, /const ticket = permissionResult\?\.ticket \|\| session\?\.runtimeTicket/);
  assert.match(resolve, /session\.runtimeTicket = permissionResult\.ticket/);
});
