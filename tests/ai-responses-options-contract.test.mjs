import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, openAiApiMode } from '../ai-agent-service.js';

// Guards the OpenAI Responses API 400 InvalidParameter regression: the Go
// Runtime path must not forward Chat-Completions-only sampling fields to
// /v1/responses. provider.options historically carried presence_penalty,
// frequency_penalty, max_completion_tokens, reasoning_effort (top-level),
// response_format, stop, n - all rejected by the Responses endpoint.
test('normalizeOptions responses mode strips chat-only params', () => {
    const provider = {
        type: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiMode: 'responses',
        options: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 4096,
            max_output_tokens: 2048,
            max_completion_tokens: 4096,
            presence_penalty: 0.5,
            frequency_penalty: 0.3,
            reasoning_effort: 'high',
            response_format: { type: 'json_object' },
            stop: 'END',
            n: 1,
            seed: 42,
        },
    };
    const out = normalizeOptions({ ...provider, _selectedModel: 'gpt-5' }, {}, 'responses');

    // Allowed on Responses.
    assert.equal(out.temperature, 0.7);
    assert.equal(out.top_p, 0.9);
    assert.equal(out.max_output_tokens, 2048);
    assert.equal(out.seed, 42);

    // Rejected by Responses API - must be absent.
    for (const key of ['max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'reasoning_effort', 'response_format', 'stop', 'n']) {
        assert.equal(out[key], undefined, `chat-only param ${key} leaked into responses options`);
    }

    // reasoning must be the object form {effort}, never a top-level string.
    assert.ok(out.reasoning && typeof out.reasoning === 'object', 'reasoning object missing');
    assert.equal(out.reasoning.effort, 'high');
});

test('normalizeOptions chat mode keeps chat-only params and aliases max_output_tokens', () => {
    const provider = {
        type: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiMode: 'chat',
        options: {
            max_tokens: 1000,
            max_output_tokens: 2000,
            reasoning_effort: 'high',
            presence_penalty: 0.1,
        },
    };
    // gpt-5 is a reasoning-capable family so reasoning_effort is preserved.
    const out = normalizeOptions({ ...provider, _selectedModel: 'gpt-5' }, {}, 'chat');
    // Chat uses max_tokens; max_output_tokens is not a chat field.
    assert.equal(out.max_tokens, 1000);
    assert.equal(out.max_output_tokens, undefined);
    assert.equal(out.reasoning_effort, 'high');
    assert.equal(out.presence_penalty, 0.1);
    assert.equal(out.reasoning, undefined);
});

test('normalizeOptions drops -1 / empty sampling values', () => {
    const provider = {
        type: 'openai-compatible',
        apiMode: 'chat',
        options: { temperature: -1, top_p: '', reasoning_effort: '' },
    };
    const out = normalizeOptions({ ...provider, _selectedModel: 'gpt-4o' }, {}, 'chat');
    assert.equal(out.temperature, undefined);
    assert.equal(out.top_p, undefined);
    assert.equal(out.reasoning_effort, undefined);
});

test('openAiApiMode detects responses from base url or apiMode', () => {
    assert.equal(openAiApiMode({ apiMode: 'responses' }), 'responses');
    assert.equal(openAiApiMode({ baseUrl: 'https://x/v1/responses' }), 'responses');
    assert.equal(openAiApiMode({ apiMode: 'chat' }), 'chat');
    assert.equal(openAiApiMode({ baseUrl: 'https://x/v1/chat/completions' }), 'chat');
    assert.equal(openAiApiMode({ apiMode: 'auto' }), 'chat');
    assert.equal(openAiApiMode({}), 'chat');
});
