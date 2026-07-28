import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runtimeModelIds } = require('../ai-model-catalog.js');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const goTypes = readFileSync(new URL('../zephyr-ai/internal/provider/types.go', import.meta.url), 'utf8');

test('Go provider config expects string model ids', () => {
  assert.match(goTypes, /Models\s+\[\]string\s+`json:"models,omitempty"`/);
});

test('runtimeModelIds serializes mixed ModelEntry/string arrays', () => {
  assert.deepEqual(runtimeModelIds([
    { id: 'gpt-4.1', input: { image: true } },
    'gpt-4.1-mini',
    { id: 'gpt-4.1', hidden: true },
    { label: 'invalid without id' },
    '',
  ]), ['gpt-4.1', 'gpt-4.1-mini']);
  assert.deepEqual(runtimeModelIds(null), []);
});

test('runtime provider payload uses runtimeModelIds and never raw models', () => {
  assert.match(server, /const \{ runtimeModelIds \} = require\('\.\/ai-model-catalog'\)/);
  assert.match(server, /const providerModelIds = runtimeModelIds\(provider\.models\)/);
  assert.match(server, /models: providerModelIds/);
  assert.doesNotMatch(server, /models: provider\.models \|\| \[\]/);
});

test('runtime keeps per-model capabilities on Node only', () => {
  assert.match(server, /modelEntry = findModelEntry\(provider\.models, model\)/);
  assert.match(server, /modelEntry\?\.contextWindowTokens/);
  assert.match(server, /modelEntry\?\.maxOutputTokens/);
});
