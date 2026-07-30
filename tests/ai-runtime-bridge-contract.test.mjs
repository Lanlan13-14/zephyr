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
    assert.ok(compose.skills.some((s) => s.prompt === 'FULL_BODY_XYZ'));
    // all built-in guidance must be merged into one full body
    const def = compose.skills.find((s) => s.id === 'zephyr-unified-operator');
    assert.ok(def, 'unified default skill present');
    assert.ok((def.prompt || '').includes('Zephyr 全能力内置规程'), 'unified skill full body');
    assert.ok(compose.envVars.some((e) => e.name === 'E1' && e.value === 'secret'));
});

test('listToolCatalog exposes platform tools with risk flags', () => {
    const catalog = listToolCatalog({ permissions: { notesRead: true, notesWrite: true, browser: true, memory: true, webSearch: true, webFetch: true, remoteExecute: true, fileRead: true, fileWrite: true } });
    assert.ok(catalog.length >= 15);
    const names = new Set(catalog.map((t) => t.name));
    for (const n of ['connection_list_v1', 'remote_execute', 'note_search', 'ui_action']) {
        assert.ok(names.has(n), `missing ${n}`);
    }
    const remote = catalog.find((t) => t.name === 'remote_execute');
    assert.equal(remote.readOnly, false);
    assert.equal(remote.risk, 'R2');
    assert.equal(remote.confirmation, 'always');
    const list = catalog.find((t) => t.name === 'connection_list_v1');
    assert.equal(list.readOnly, true);
    assert.equal(list.risk, 'R0');
    assert.equal(list.confirmation, 'never');
});

test('STATIC_PLATFORM_CATALOG fails closed instead of exposing stale legacy tools', () => {
    assert.deepEqual(STATIC_PLATFORM_CATALOG, []);
});

test('listPlatformToolCatalog prefers dynamic catalog', () => {
    const tools = listPlatformToolCatalog({ storage: { getSettings: () => ({ ai: { permissions: {} } }) } });
    assert.ok(tools.length >= 10);
});

test('runtime catalog applies per-user notes.enabled when identity is present', () => {
    const deps = {
        storage: {
            getSettings: () => ({ ai: { permissions: { notesRead: true, notesWrite: true } } }),
            getUserById: (userId) => ({ userId, role: 'user' }),
        },
        userSettingsService: {
            effective: (user) => ({ notes: { enabled: user.userId === 'enabled-user' } }),
        },
    };
    const disabled = listPlatformToolCatalog(deps, { userId: 'disabled-user' });
    assert.ok(disabled.length > 0);
    assert.equal(disabled.some((tool) => tool.name.startsWith('note_')), false);
    const enabled = listPlatformToolCatalog(deps, { userId: 'enabled-user' });
    assert.equal(enabled.some((tool) => tool.name === 'note_get'), true);
});

test('executeAiToolForHost requires deps', async () => {
    await assert.rejects(() => executeAiToolForHost('connection_list_v1', {}, {}), /deps required/);
});
