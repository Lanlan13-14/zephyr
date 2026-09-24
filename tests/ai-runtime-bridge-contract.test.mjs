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

test('_consumeHistoryEvents consumes streamnorm frames and feeds historyController', async () => {
    const observedFrames = [];
    const observedEvents = [];
    const mockController = {
        observeFrame: (runId, frame) => observedFrames.push({ runId, frame }),
        observeEvent: (runId, event) => observedEvents.push({ runId, event }),
    };

    const bridge = new AiRuntimeBridge({ baseUrl: 'http://127.0.0.1:9999', adminToken: 'test' });
    bridge.setHistoryController(mockController);

    // Mock fetchImpl to return /frames SSE stream
    const sseLines = [
        'id: 0\nevent: start\ndata: {"schemaVersion":2,"type":"start","runId":"r1","sequence":0}\n\n',
        'id: 1\nevent: text_start\ndata: {"schemaVersion":2,"type":"text_start","runId":"r1","sequence":1}\n\n',
        'id: 2\nevent: text_delta\ndata: {"schemaVersion":2,"type":"text_delta","runId":"r1","sequence":2,"text":"Hello "}\n\n',
        'id: 3\nevent: text_delta\ndata: {"schemaVersion":2,"type":"text_delta","runId":"r1","sequence":3,"text":"world!"}\n\n',
        'id: 4\nevent: done\ndata: {"schemaVersion":2,"type":"done","runId":"r1","sequence":4,"stopReason":"stop"}\n\n',
    ];

    bridge.fetchImpl = async (url) => {
        if (url.includes('/frames')) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    for (const line of sseLines) {
                        controller.enqueue(encoder.encode(line));
                    }
                    controller.close();
                },
            });
            return {
                ok: true,
                status: 200,
                body: stream,
            };
        }
        return { ok: false, status: 404 };
    };

    const result = await bridge._consumeHistoryEvents('r1', 'tkt1', new AbortController().signal);
    assert.equal(result, true);
    assert.equal(observedFrames.length, 5);
    assert.equal(observedFrames[0].frame.type, 'start');
    assert.equal(observedFrames[4].frame.type, 'done');

    // Verify converted events
    const msgCompleted = observedEvents.find((e) => e.event.type === 'message.completed');
    assert.ok(msgCompleted);
    assert.equal(msgCompleted.event.data.content, 'Hello world!');

    const runCompleted = observedEvents.find((e) => e.event.type === 'run.completed');
    assert.ok(runCompleted);
    assert.equal(runCompleted.event.data.stopReason, 'stop');
});

test('_consumeHistoryEvents propagates observeFrame failures instead of swallowing them', async () => {
    const bridge = new AiRuntimeBridge({ baseUrl: 'http://127.0.0.1:9999', adminToken: 'test' });
    bridge.setHistoryController({
        observeFrame: () => { throw new Error('history persistence failed'); },
        observeEvent: () => {},
    });

    const sseLines = [
        'id: 0\nevent: start\ndata: {"schemaVersion":2,"type":"start","runId":"r1","sequence":0}\n\n',
        'id: 1\nevent: done\ndata: {"schemaVersion":2,"type":"done","runId":"r1","sequence":1,"stopReason":"stop"}\n\n',
    ];

    bridge.fetchImpl = async (url) => {
        if (url.includes('/frames')) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    for (const line of sseLines) controller.enqueue(encoder.encode(line));
                    controller.close();
                },
            });
            return { ok: true, status: 200, body: stream };
        }
        return { ok: false, status: 404 };
    };

    await assert.rejects(
        () => bridge._consumeHistoryEvents('r1', 'tkt1', new AbortController().signal),
        /history persistence failed/,
    );
});

test('_consumeHistoryEvents falls back to legacy events on 405, but not on network errors', async () => {
    const observedEvents = [];
    const bridge = new AiRuntimeBridge({ baseUrl: 'http://127.0.0.1:9999', adminToken: 'test' });
    bridge.setHistoryController({
        observeEvent: (runId, event) => observedEvents.push({ runId, event }),
    });

    bridge.fetchImpl = async (url) => {
        if (url.includes('/frames')) {
            return { ok: false, status: 405 };
        }
        if (url.includes('/events')) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('id: 1\nevent: run.completed\ndata: {"type":"run.completed"}\n\n'));
                    controller.close();
                },
            });
            return { ok: true, status: 200, body: stream };
        }
        return { ok: false, status: 404 };
    };

    const result = await bridge._consumeHistoryEvents('r1', 'tkt1', new AbortController().signal);
    assert.equal(result, true);
    assert.ok(observedEvents.some((e) => e.event.type === 'run.completed'));
});

test('_consumeHistoryEvents does not fall back on non-availability errors', async () => {
    const bridge = new AiRuntimeBridge({ baseUrl: 'http://127.0.0.1:9999', adminToken: 'test' });
    bridge.setHistoryController({});

    bridge.fetchImpl = async () => ({ ok: false, status: 500 });

    await assert.rejects(
        () => bridge._consumeHistoryEvents('r1', 'tkt1', new AbortController().signal),
        (err) => err.code === 'ai_runtime_history_monitor_failed',
    );
});

test('_fetchUnchecked normalizes network error via toContractError', async () => {
    const bridge = new AiRuntimeBridge({ baseUrl: 'http://127.0.0.1:9999', adminToken: 'test' });
    bridge.fetchImpl = async () => {
        const err = new Error('getaddrinfo ENOTFOUND api.openai.com');
        err.code = 'ENOTFOUND';
        throw err;
    };

    try {
        await bridge._fetchUnchecked('/v1/test');
        assert.fail('should have thrown');
    } catch (err) {
        assert.equal(err.code, 'ai_dns_failed');
        assert.equal(err.retryable, true);
    }
});
