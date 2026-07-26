import test from 'node:test';
import assert from 'node:assert/strict';
import budget from '../ai-context-budget.js';
import aiAgent from '../ai-agent-service.js';

const { compactConversationHistory } = aiAgent;

test('model context windows are inferred or explicitly overridden', () => {
  assert.equal(budget.inferModelWindowTokens({}, 'claude-3-7-sonnet'), 200000);
  assert.equal(budget.inferModelWindowTokens({}, 'gemini-2.5-pro'), 1000000);
  assert.equal(budget.inferModelWindowTokens({}, 'gpt-4'), 8192);
  assert.equal(budget.inferModelWindowTokens({}, 'unknown-model', 64000), 64000);
});

test('dynamic budget subtracts system tools output and safety reserves', () => {
  const small = budget.computeContextBudget({ model: 'gpt-4', systemPrompt: 'x'.repeat(4000), tools: [{ name: 'a', schema: 'y'.repeat(3000) }], requestedOutputTokens: 1024 });
  const large = budget.computeContextBudget({ model: 'claude-3-7-sonnet', systemPrompt: 'x'.repeat(4000), tools: [{ name: 'a' }], requestedOutputTokens: 4096 });
  assert.equal(small.windowTokens, 8192);
  assert.ok(small.historyBudgetTokens < small.windowTokens);
  assert.ok(large.maxInputChars > small.maxInputChars * 10);
});

test('legacy compaction no longer truncates by message count', () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }));
  const result = compactConversationHistory(messages, { maxInputChars: 100000, perMessageChars: 10000, recentChars: 50000, summaryChars: 5000 });
  assert.equal(result.messages.length, 120);
  assert.equal(result.compactedCount, 0);
});
