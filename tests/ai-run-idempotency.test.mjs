import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAiRunRegistry } = require('../ai-run-idempotency.js');
const fs = require('fs');
const path = require('path');

test('retrying the same runId does not execute the tool twice', () => {
  const runs = createAiRunRegistry();
  let calls = 0;
  const execute = () => {
    calls += 1;
    return { value: calls };
  };
  const first = runs.dispatch({ runId: 'run-1', tool: 'pwd', input: { cwd: '/' }, execute });
  const second = runs.dispatch({ runId: 'run-1', tool: 'pwd', input: { cwd: '/' }, execute });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.result, first.result);
});

test('high-risk tool without approval is approval_required', () => {
  const runs = createAiRunRegistry();
  assert.throws(
    () => runs.dispatch({
      runId: 'run-risk',
      tool: 'revealSecret',
      input: { id: 'k1' },
      execute: () => ({ leaked: true }),
    }),
    (err) => err.code === 'approval_required',
  );
});

test('changing the command after approval is approval_stale', () => {
  const runs = createAiRunRegistry();
  runs.approve({
    runId: 'run-2',
    tool: 'shell.exec',
    input: { cmd: 'ls' },
    confirmationId: 'conf-1',
    expiresAt: Date.now() + 60_000,
  });
  assert.throws(
    () => runs.dispatch({
      runId: 'run-2',
      tool: 'shell.exec',
      input: { cmd: 'rm -rf /' },
      execute: () => ({ ran: true }),
      highRisk: true,
    }),
    (err) => err.code === 'approval_stale',
  );
});

test('KindAI builtin echo is not registered as execution', () => {
  const node = fs.readFileSync(path.resolve('zephyr-link/internal/link/node.go'), 'utf8');
  assert.match(node, /n\.dispatch\.Register\(codec\.KindAI/);
  assert.match(node, /Acknowledge here; the embedding host may replace/);
  assert.doesNotMatch(node, /executeCanonicalAiTool/);
  const start = node.indexOf('n.dispatch.Register(codec.KindAI');
  const echoBlock = node.slice(start, start + 900);
  assert.match(echoBlock, /"ok":\s+true/);
  assert.match(echoBlock, /"op":\s+op/);
  assert.doesNotMatch(echoBlock, /ai-agent-service/);
});
