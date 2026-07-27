import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let cookie;
let providerId;

before(async () => {
  server = new TestServer();
  await server.start();
  ({ cookie } = await server.bootstrapAdmin('provider-options-pass-1'));
});

after(async () => { await server?.cleanup(); });

test('provider API persists and returns all editable config fields', async () => {
  const created = await server.api(cookie, 'POST', '/api/ai/providers', {
    name: 'Persistence Provider',
    type: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    apiMode: 'responses',
    models: ['model-a'],
    defaultModel: 'model-a',
    organization: 'proj_123',
    extraHeaders: '{"X-Test":"1"}',
    modelUserAgents: 'model-a=Zephyr-Test/1',
    options: {
      temperature: 0.4,
      top_p: 0.8,
      max_tokens: 8192,
      max_output_tokens: 8192,
      reasoning_effort: 'high',
      vision: true,
      use_previous_response_id: true,
      context: { windowTokens: 196608 },
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      extraJson: '{"service_tier":"flex"}',
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  providerId = created.body.provider.id;

  const listed = await server.api(cookie, 'GET', '/api/ai/providers');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const provider = listed.body.providers.find((item) => item.id === providerId);
  assert.ok(provider, JSON.stringify(listed.body));
  assert.equal(provider.config.apiMode, 'responses');
  assert.equal(provider.config.organization, 'proj_123');
  assert.equal(provider.config.extraHeaders, '{"X-Test":"1"}');
  assert.equal(provider.config.modelUserAgents, 'model-a=Zephyr-Test/1');
  assert.equal(provider.config.options.reasoning_effort, 'high');
  assert.equal(provider.config.options.vision, true);
  assert.equal(provider.config.options.use_previous_response_id, true);
  assert.equal(provider.config.options.context.windowTokens, 196608);
});

test('provider PATCH keeps updated model parameters after reload', async () => {
  const patched = await server.api(cookie, 'PATCH', `/api/ai/providers/${providerId}`, {
    apiMode: 'chat',
    options: {
      temperature: -1,
      top_p: -1,
      max_tokens: 12288,
      max_output_tokens: 12288,
      reasoning_effort: 'minimal',
      vision: false,
      use_previous_response_id: false,
      context: { windowTokens: 262144 },
      presence_penalty: 0,
      frequency_penalty: 0,
      extraJson: '{"parallel_tool_calls":false}',
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const listed = await server.api(cookie, 'GET', '/api/ai/providers');
  const provider = listed.body.providers.find((item) => item.id === providerId);
  assert.equal(provider.config.apiMode, 'chat');
  assert.equal(provider.config.options.reasoning_effort, 'minimal');
  assert.equal(provider.config.options.vision, false);
  assert.equal(provider.config.options.use_previous_response_id, false);
  assert.equal(provider.config.options.context.windowTokens, 262144);
  assert.equal(provider.config.options.max_tokens, 12288);
});
