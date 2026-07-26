import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const agent = fs.readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'ai-runtime-bridge.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const goServer = fs.readFileSync(path.join(root, 'zephyr-ai/internal/server/server.go'), 'utf8');
const goLoop = fs.readFileSync(path.join(root, 'zephyr-ai/internal/agent/loop.go'), 'utf8');

test('legacy context budget is model-derived and not message-count based', () => {
  assert.match(agent, /computeContextBudget/);
  assert.match(agent, /systemPrompt, tools/);
  assert.equal(agent.includes('items.length <= clampNumber(limits.keepMessages'), false);
  assert.equal(agent.includes('keepMessages: clampNumber'), false);
});

test('Go runtime receives and persists model context budget', () => {
  assert.match(bridge, /contextWindowTokens/);
  assert.match(server, /contextWindowTokens:/);
  assert.match(goServer, /ContextWindowTokens/);
  assert.match(goLoop, /compact\.ComputeBudget/);
  assert.match(goLoop, /ContextWindowTokens:\s*cfg\.ContextWindowTokens/);
});
