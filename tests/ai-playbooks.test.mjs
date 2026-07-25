import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBOOKS, playbooksForCapabilities } from '../ai-playbooks.js';
import { formatAiContextForPrompt, toolDefinitions } from '../ai-agent-service.js';
import { AiRuntimeBridge } from '../ai-runtime-bridge.js';

test('connection asset playbook exists and covers canonical lifecycle', () => {
    const playbook = PLAYBOOKS.find((item) => item.id === 'asset-management-v1');
    assert.ok(playbook);
    for (const id of ['connection.create', 'connection.update', 'connection.delete', 'connection.test', 'connection.open']) {
        assert.ok(playbook.capabilityIds.includes(id), `missing ${id}`);
    }
    assert.match(playbook.prompt, /connection_create_v1/);
    assert.match(playbook.prompt, /connection_open_v1/);
    assert.match(playbook.prompt, /revision_conflict/);
    assert.match(playbook.prompt, /不能接收密码/);
    assert.deepEqual(playbooksForCapabilities(['connection.open']).map((item) => item.id), ['asset-management-v1']);
    const proxyPlaybook = PLAYBOOKS.find((item) => item.id === 'proxy-management-v1');
    assert.ok(proxyPlaybook);
    assert.match(proxyPlaybook.prompt, /proxy_create_v1/);
    assert.match(proxyPlaybook.prompt, /不接收或读取代理密码/);
    const keyPlaybook = PLAYBOOKS.find((item) => item.id === 'ssh-key-management-v1');
    assert.ok(keyPlaybook);
    assert.match(keyPlaybook.prompt, /ssh_key_validate_v1/);
    assert.match(keyPlaybook.prompt, /humanOnly/);
});

test('legacy and Go runtime prompt assembly include connection asset playbook', () => {
    const bridge = new AiRuntimeBridge();
    const compose = bridge.buildSystemCompose({ skills: [] }, '', []);
    const playbook = compose.skills.find((item) => item.id === 'playbook:asset-management-v1');
    assert.ok(playbook);
    assert.match(playbook.prompt, /connection_update_v1/);
    const visibleTools = new Set(toolDefinitions({}).map((tool) => tool.function.name));
    assert.ok(visibleTools.has('capability_search'));
    for (const name of ['connection_create_v1', 'connection_update_v1', 'connection_delete_v1', 'connection_test_v1', 'connection_open_v1']) {
        assert.ok(visibleTools.has(name), `${name} must be model-visible`);
    }
});
