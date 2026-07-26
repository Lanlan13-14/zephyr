import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import aiAgent from '../ai-agent-service.js';
import capabilities from '../ai-capabilities.js';
import { PLAYBOOKS } from '../ai-playbooks.js';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const names = ['terminal_read_v1', 'terminal_send_v1', 'terminal_wait_v1'];

test('terminal canonical tools share strict schemas and capability bindings', () => {
  const defs = aiAgent.toolDefinitions({});
  const catalog = aiAgent.listToolCatalog({});
  for (const name of names) {
    const def = defs.find((item) => item.function?.name === name);
    assert.equal(def.function.parameters, aiAgent.CANONICAL_TOOL_SCHEMAS[name]);
    assert.equal(def.function.parameters.additionalProperties, false);
    assert.ok(catalog.some((item) => item.name === name && item.capabilityId.startsWith('terminal.')));
  }
  assert.equal(catalog.find((item) => item.name === 'terminal_send_v1').risk, 'R2');
  assert.equal(catalog.find((item) => item.name === 'terminal_read_v1').readOnly, true);
});

test('terminal context carries authoritative session id for SSH and TELNET', () => {
  assert.match(app, /sessionId:\s*snapshot\?\.sessionId \|\| tab\?\.sessionId \|\| id/);
  assert.match(app, /\['SSH', 'TELNET'\]\.includes\(item\.protocol\)/);
  assert.match(server, /terminalSessions:\s*sshTerminalSessions/);
  assert.match(server, /terminalHistory/);
});

test('terminal session playbook explains TELNET non-SSH path', () => {
  const playbook = PLAYBOOKS.find((item) => item.id === 'terminal-session-ops-v1');
  assert.ok(playbook);
  assert.match(playbook.prompt, /terminal_send_v1/);
  assert.match(playbook.prompt, /TELNET 不支持 remote_execute/);
  for (const id of ['terminal.read', 'terminal.send', 'terminal.wait']) {
    assert.ok(capabilities.CAPABILITIES.some((item) => item.id === id && item.state === 'implemented'));
  }
});
