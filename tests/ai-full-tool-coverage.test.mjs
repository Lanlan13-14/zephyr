import test from 'node:test';
import assert from 'node:assert/strict';
import aiAgent from '../ai-agent-service.js';
import extended from '../ai-extended-capabilities.js';
import { PLAYBOOKS } from '../ai-playbooks.js';

const permissions = { browser: true, webSearch: true, webFetch: true, memory: true, env: true, notesRead: true, notesWrite: true, remoteExecute: true, fileRead: true, fileWrite: true };

test('every model-visible platform tool has capability risk and confirmation metadata', () => {
  const catalog = aiAgent.listToolCatalog({ permissions });
  const unbound = catalog.filter((tool) => !tool.capabilityId || !/^R[0-4]$/.test(tool.risk) || !['never', 'always'].includes(tool.confirmation));
  assert.deepEqual(unbound.map((tool) => ({ name: tool.name, capabilityId: tool.capabilityId, risk: tool.risk, confirmation: tool.confirmation })), []);
  const loose = catalog.filter((tool) => tool.parameters?.type === 'object' && tool.parameters.additionalProperties !== false);
  assert.deepEqual(loose.map((tool) => tool.name), []);
});

test('deprecated duplicate asset and terminal aliases are not model-visible', () => {
  const names = new Set(aiAgent.listToolCatalog({ permissions }).map((tool) => tool.name));
  for (const name of ['list_connections', 'list_zephyr_resources', 'terminal_read_output', 'open_connection', 'connection_create', 'connection_update', 'connection_delete', 'proxy_save', 'ssh_key_save', 'jump_host_save', 'snippet_save']) {
    assert.equal(names.has(name), false, name);
  }
});

test('capability_search can discover extended operational capabilities', async () => {
  const deps = {
    storage: { getSettings: () => ({ ai: { enabled: true, permissions: {} } }) },
    resourceService: {},
  };
  const result = await aiAgent.executeAiToolForHost('capability_search', { query: 'remote_read_file' }, { user: { userId: 'u1' }, deps });
  assert.ok(result.data.capabilities.some((item) => item.capabilityId === 'ssh.file_read' && item.toolIds.includes('remote_read_file')));
});

test('extended capability mapping covers each mapped tool exactly once', () => {
  const seen = new Map();
  const playbookIds = new Set(PLAYBOOKS.map((item) => item.id));
  for (const capability of extended.EXTENDED_CAPABILITIES) {
    assert.equal(playbookIds.has(capability.playbookId), true, `${capability.id} missing playbook ${capability.playbookId}`);
    assert.match(capability.risk, /^R[0-4]$/);
    assert.ok(capability.playbookId);
    for (const tool of capability.toolIds) {
      assert.equal(seen.has(tool), false, `${tool} duplicate mapping`);
      seen.set(tool, capability.id);
      assert.equal(extended.policyForExtendedTool(tool).capabilityId, capability.id);
    }
  }
});
