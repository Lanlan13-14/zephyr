import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AiRuntimeBridge,
    STATIC_PLATFORM_CATALOG,
    listPlatformToolCatalog,
} from '../ai-runtime-bridge.js';
import {
    listToolCatalog,
    normalizeAiSettingsInput,
    executeAiToolForHost,
} from '../ai-agent-service.js';
import { DEFAULT_ZEPHYR_SYSTEM_PROMPT } from '../ai-defaults.js';

test('buildSystemCompose keeps full skill body and timestamp fields', () => {
    const bridge = new AiRuntimeBridge();
    const ai = normalizeAiSettingsInput({}, {
        enabled: true,
        assistantName: 'T',
        systemPrompt: 'CUSTOM',
        skills: [{ id: 's1', name: 'S', description: 'd', prompt: 'FULL_BODY_XYZ', enabled: true }],
        memories: [{ id: 'm1', title: 'M', content: 'mem-content', enabled: true }],
        envVars: [{ id: 'e1', name: 'E1', value: 'secret', visibleToAi: true, valueVisibleToAi: true, enabled: true }],
    });
    const compose = bridge.buildSystemCompose(ai, 'CTX_BLOCK', ai.memories || []);
    assert.equal(compose.assistantName, 'T');
    assert.ok(String(compose.defaultSystemPrompt || DEFAULT_ZEPHYR_SYSTEM_PROMPT).length > 100);
    assert.equal(compose.customSystemPrompt, 'CUSTOM');
    assert.equal(compose.contextText, 'CTX_BLOCK');
    assert.ok(compose.skills.some((s) => s.prompt === 'FULL_BODY_XYZ' || (s.id === 'zephyr-local-operator' && s.prompt)));
    // default skill must be merged in with full prompt when missing
    const def = compose.skills.find((s) => s.id === 'zephyr-local-operator');
    assert.ok(def, 'default skill present');
    assert.ok((def.prompt || '').includes('Zephyr'), 'default skill full body');
    assert.ok(compose.envVars.some((e) => e.name === 'E1' && e.value === 'secret'));
});

test('listToolCatalog exposes platform tools with risk flags', () => {
    const catalog = listToolCatalog({ permissions: { notesRead: true, notesWrite: true, browser: true, memory: true, webSearch: true, webFetch: true, remoteExecute: true, fileRead: true, fileWrite: true } });
    assert.ok(catalog.length >= 15);
    const names = new Set(catalog.map((t) => t.name));
    for (const n of ['list_connections', 'remote_execute', 'note_search', 'ui_action']) {
        assert.ok(names.has(n), `missing ${n}`);
    }
    const remote = catalog.find((t) => t.name === 'remote_execute');
    assert.equal(remote.readOnly, false);
    assert.ok(remote.risk === 'high' || remote.risk === 'destructive');
    const list = catalog.find((t) => t.name === 'list_connections');
    assert.equal(list.readOnly, true);
    assert.equal(list.risk, 'low');
});

test('STATIC_PLATFORM_CATALOG names are unique', () => {
    const names = STATIC_PLATFORM_CATALOG.map((t) => t.name);
    assert.equal(names.length, new Set(names).size);
});

test('listPlatformToolCatalog prefers dynamic catalog', () => {
    const tools = listPlatformToolCatalog({ storage: { getSettings: () => ({ ai: { permissions: {} } }) } });
    assert.ok(tools.length >= 10);
});

test('executeAiToolForHost requires deps', async () => {
    await assert.rejects(() => executeAiToolForHost('list_connections', {}, {}), /deps required/);
});
