import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const agent = require('../ai-agent-service.js');

test('custom Anthropic-compatible endpoint gets no fabricated Claude catalog', async () => {
  assert.equal(agent.isOfficialAnthropicBase('https://api.anthropic.com'), true);
  assert.equal(agent.isOfficialAnthropicBase('https://api.example.com/anthropic'), false);
  const models = await agent.listProviderModels({ type: 'anthropic', baseUrl: 'https://api.example.com/anthropic', apiKey: '' });
  assert.deepEqual(models, []);
});

test('official Anthropic fallback contains real catalog IDs only', async () => {
  const models = await agent.listProviderModels({ type: 'anthropic', baseUrl: '', apiKey: '' });
  const ids = models.map((model) => String(model.id || ''));
  assert.ok(ids.includes('claude-opus-4-6'));
  assert.ok(ids.every((id) => id.startsWith('claude-')));
  assert.ok(!ids.includes('claude-opus-4-7'));
  assert.ok(!ids.includes('claude-opus-4-8'));
});
