import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const errors = require('../ai-contract-errors.js');

test('DNS failures classify retryable, auth failures terminal', () => {
  assert.equal(errors.classifyUpstreamError(new Error('getaddrinfo EAI_AGAIN api.openai.com')), 'ai_dns_failed');
  assert.equal(errors.isRetryableAIError('ai_dns_failed'), true);
  assert.equal(errors.classifyUpstreamError(new Error('401 incorrect api key')), 'ai_auth_failed');
  assert.equal(errors.isRetryableAIError('ai_auth_failed'), false);
});

test('toContractError preserves known codes and fills the envelope', () => {
  const known = errors.toContractError(Object.assign(new Error('slow'), { code: 'ai_rate_limited' }));
  assert.equal(known.code, 'ai_rate_limited');
  assert.equal(known.httpStatus, 429);
  assert.equal(known.retryable, true);
  const mapped = errors.toContractError(new Error('tls: certificate mismatch'));
  assert.equal(mapped.code, 'ai_tls_hostname_mismatch');
  assert.equal(mapped.retryable, false);
});

test('taxonomy order matches the generated contract', async () => {
  const generated = await import('../src/generated/ai-contract-v2.js');
  assert.deepEqual(
    errors.AI_ERROR_TAXONOMY.errors.map((item) => item.code),
    generated.AI_ERROR_TAXONOMY.errors.map((item) => item.code),
  );
});
