import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import aiAgent from '../ai-agent-service.js';
import capabilities from '../ai-capabilities.js';
import { PLAYBOOKS } from '../ai-playbooks.js';

const root = path.resolve(import.meta.dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'file-agent-manager.js'), 'utf8');

const names = ['agent_list_v1', 'agent_get_v1', 'agent_file_list_v1', 'agent_file_stat_v1', 'agent_file_read_text_v1', 'agent_file_mkdir_v1', 'agent_file_rename_v1', 'agent_file_delete_v1'];

test('Agent canonical catalog is complete and strict', () => {
  const catalog = aiAgent.listToolCatalog({});
  for (const name of names) {
    const item = catalog.find((tool) => tool.name === name);
    assert.ok(item, name);
    assert.equal(aiAgent.CANONICAL_TOOL_SCHEMAS[name].additionalProperties, false);
  }
  assert.equal(catalog.find((item) => item.name === 'agent_file_read_text_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'agent_file_delete_v1').risk, 'R3');
});

test('Agent manager is injected into both legacy and Go host paths', () => {
  assert.equal((server.match(/fileAgentManager,/g) || []).length >= 2, true);
  assert.match(manager, /appVersion:\s*this\.appVersion/);
  assert.match(manager, /isAgentOwnedByUser/);
});

test('Agent capability inventory preserves token human-only boundary', () => {
  for (const id of ['agent.list', 'agent.get', 'agent.files_read', 'agent.files_write']) {
    assert.ok(capabilities.CAPABILITIES.some((item) => item.id === id && item.state === 'implemented'));
  }
  const token = capabilities.CAPABILITIES.find((item) => item.id === 'agent.token_manage');
  assert.equal(token.mode, 'humanOnly');
  assert.equal(token.toolIds.length, 0);
  const playbook = PLAYBOOKS.find((item) => item.id === 'agent-device-files-v1');
  assert.match(playbook.prompt, /Agent Token/);
  assert.match(playbook.prompt, /readOnly=true/);
});
