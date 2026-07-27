import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const service = readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');
const defaults = readFileSync(path.join(root, 'ai-defaults.js'), 'utf8');
const playbooks = readFileSync(path.join(root, 'ai-playbooks.js'), 'utf8');
const tools = readFileSync(path.join(root, 'ai-terminal-session-tools.js'), 'utf8');

test('browser AI context exposes the active real terminal session explicitly', () => {
  assert.match(app, /activeTerminalSessionId:\s*activeTerminal\?\.sessionId \|\| activeTerminalTab/);
  assert.match(app, /activeTerminalConnectionId:\s*activeTerminal\?\.connectionId/);
  assert.match(app, /terminalSessions:\s*terminalOutputs\.map/);
  assert.match(app, /sessionId:\s*item\.sessionId \|\| item\.tabId/);
});

test('system prompt prints exact session id and forbids guessing connection ids', () => {
  assert.match(service, /当前活跃终端真实 sessionId：\$\{activeTerminalSessionId\}/);
  assert.match(service, /不要改写、加 ssh: 前缀或用 connectionId 猜测/);
  assert.match(service, /sessionId=\$\{sid \|\| '\[缺失\]'\} connectionId=/);
});

test('terminal canonical tools accept current context and aliases', () => {
  assert.match(tools, /function resolveSessionIdFromContext/);
  assert.match(tools, /context\?\.activeTerminalSessionId/);
  assert.match(tools, /item\.connectionId, cfg\.id, cfg\.name/);
  assert.match(tools, /replace\(\/\^\(\?:ssh\|telnet\|terminal\):\/i, ''\)/);
  assert.match(service, /readSession\([^\n]*ctx\.context \|\| \{\}\)/);
  assert.match(service, /sendSession\([^\n]*ctx\.context \|\| \{\}\)/);
  assert.match(service, /waitSession\([^\n]*ctx\.signal, ctx\.context \|\| \{\}\)/);
});

test('model guidance says omit sessionId rather than guess it', () => {
  assert.match(defaults, /省略 sessionId 让 terminal_\*_v1 默认选当前会话/);
  assert.match(defaults, /严禁把 connectionId 当 sessionId/);
  assert.match(playbooks, /activeTerminalSessionId/);
  assert.match(playbooks, /禁止把 connectionId 当成 sessionId/);
});
