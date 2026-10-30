import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAiRunRegistry } = require('../ai-run-idempotency.js');
const fs = require('fs');
const path = require('path');

test('retrying the same runId does not execute the tool twice', async () => {
  const runs = createAiRunRegistry();
  let calls = 0;
  const execute = () => {
    calls += 1;
    return { value: calls };
  };
  const first = await runs.dispatch({ runId: 'run-1', tool: 'pwd', input: { cwd: '/' }, execute });
  const second = await runs.dispatch({ runId: 'run-1', tool: 'pwd', input: { cwd: '/' }, execute });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.result, first.result);
});

test('high-risk tool without approval is approval_required', async () => {
  const runs = createAiRunRegistry();
  await assert.rejects(
    () => runs.dispatch({
      runId: 'run-risk',
      tool: 'revealSecret',
      input: { id: 'k1' },
      execute: () => ({ leaked: true }),
    }),
    (err) => err.code === 'approval_required',
  );
});

test('changing the command after approval is approval_stale', async () => {
  const runs = createAiRunRegistry();
  runs.approve({
    runId: 'run-2',
    toolCallId: 'call-approval',
    tool: 'shell.exec',
    input: { cmd: 'ls' },
    confirmationId: 'conf-1',
    expiresAt: Date.now() + 60_000,
  });
  await assert.rejects(
    () => runs.dispatch({
      runId: 'run-2',
      toolCallId: 'call-approval',
      tool: 'shell.exec',
      input: { cmd: 'rm -rf /' },
      execute: () => ({ ran: true }),
      highRisk: true,
    }),
    (err) => err.code === 'approval_stale',
  );
});

test('one run can execute distinct tool calls without cross-talk', async () => {
  const runs = createAiRunRegistry();
  const calls = [];
  for (const [toolCallId, tool] of [['call-1', 'connection_list_v1'], ['call-2', 'capability_search']]) {
    await runs.dispatch({
      userId: 'alice', sessionId: 'session-1', runId: 'run-1', toolCallId, tool,
      input: {}, execute: () => { calls.push(tool); return { tool }; },
    });
  }
  assert.deepEqual(calls, ['connection_list_v1', 'capability_search']);
  const replay = await runs.dispatch({
    userId: 'alice', sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1',
    tool: 'connection_list_v1', input: {}, execute: () => assert.fail('must not execute'),
  });
  assert.equal(replay.replayed, true);
});

test('identical call ids cannot replay another account result', async () => {
  const runs = createAiRunRegistry();
  const executeFor = (userId) => () => ({ owner: userId });
  const base = { sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1', tool: 'connection_list_v1', input: {} };
  const first = await runs.dispatch({ ...base, userId: 'alice', execute: executeFor('alice') });
  const second = await runs.dispatch({ ...base, userId: 'bob', execute: executeFor('bob') });
  assert.equal(first.result.owner, 'alice');
  assert.equal(second.result.owner, 'bob');
  assert.equal(second.replayed, false);
});

test('duplicate in-flight calls and failed calls never double-execute', async () => {
  const runs = createAiRunRegistry();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = { userId: 'alice', sessionId: 's', runId: 'r', toolCallId: 'c', tool: 'pwd', input: {} };
  const first = runs.dispatch({ ...base, execute: async () => { calls += 1; await gate; return 'ok'; } });
  const duplicate = runs.dispatch({ ...base, execute: async () => { calls += 1; return 'wrong'; } });
  release();
  assert.equal((await first).result, 'ok');
  assert.equal((await duplicate).replayed, true);
  assert.equal(calls, 1);
  let failedCalls = 0;
  await assert.rejects(runs.dispatch({ ...base, toolCallId: 'fails', execute: () => { failedCalls += 1; throw new Error('failed after side effect'); } }), /failed after side effect/);
  await assert.rejects(runs.dispatch({ ...base, toolCallId: 'fails', execute: () => { failedCalls += 1; return 'wrong'; } }), /failed after side effect/);
  assert.equal(failedCalls, 1);
});

test('replay re-runs current authorization before reading cached data', async () => {
  const runs = createAiRunRegistry();
  let allowed = true;
  const request = { userId: 'alice', runId: 'r', toolCallId: 'c', tool: 'pwd', input: {}, authorize: () => { if (!allowed) throw new Error('revoked'); } };
  await runs.dispatch({ ...request, execute: () => 'private' });
  allowed = false;
  await assert.rejects(runs.dispatch({ ...request, execute: () => assert.fail('no new execution') }), /revoked/);
});

test('authenticated tool calls require a call id', async () => {
  const runs = createAiRunRegistry();
  await assert.rejects(() => runs.dispatch({ userId: 'alice', runId: 'r', tool: 'pwd', input: {}, execute: () => null }), (err) => err.code === 'invalid_tool_call_id');
});

test('KindAI builtin echo is not registered as execution', () => {
  const node = fs.readFileSync(path.resolve('zephyr-link/internal/link/node.go'), 'utf8');
  assert.match(node, /n\.dispatch\.Register\(codec\.KindAI/);
  assert.match(node, /Acknowledge here; the embedding host may replace/);
  assert.doesNotMatch(node, /executeCanonicalAiTool/);
  const start = node.indexOf('n.dispatch.Register(codec.KindAI');
  const echoBlock = node.slice(start, start + 1600);
  assert.match(echoBlock, /unsupported_operation/);
  assert.match(echoBlock, /does not execute tools/);
  assert.doesNotMatch(echoBlock, /ai-agent-service/);
  assert.doesNotMatch(echoBlock, /executeCanonicalAiTool/);
});


test('same call id with changed input or tool is a conflict', async () => {
  const runs = createAiRunRegistry();
  const base = { userId: 'alice', sessionId: 's', runId: 'r', toolCallId: 'c', tool: 'pwd' };
  await runs.dispatch({ ...base, input: { path: 'one' }, execute: () => 'first' });
  for (const change of [{ input: { path: 'two' } }, { input: { path: 'one' }, tool: 'ls' }]) {
    await assert.rejects(runs.dispatch({ ...base, ...change, execute: () => assert.fail('no new execution') }), (error) => error.code === 'idempotency_conflict');
  }
});

test('bounded registry fails closed instead of evicting side-effect keys', async () => {
  const runs = createAiRunRegistry({ maxEntries: 1 });
  const request = { runId: 'run', tool: 'pwd', input: {}, execute: () => 'first' };
  await runs.dispatch({ ...request, toolCallId: 'one' });
  await assert.rejects(runs.dispatch({ ...request, toolCallId: 'two' }), (error) => error.code === 'idempotency_capacity');
  assert.equal((await runs.dispatch({ ...request, toolCallId: 'one', execute: () => assert.fail('must replay') })).replayed, true);
});

test('revocation while a duplicate waits prevents cached data from escaping', async () => {
  const runs = createAiRunRegistry();
  let allowed = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const request = { userId: 'alice', runId: 'run', toolCallId: 'one', tool: 'pwd', input: {}, authorize() { if (!allowed) throw new Error('revoked'); } };
  const first = runs.dispatch({ ...request, execute: async () => { await gate; return 'private'; } });
  const second = runs.dispatch({ ...request, execute: () => assert.fail('duplicate') });
  const firstDenied = assert.rejects(first, /revoked/);
  const secondDenied = assert.rejects(second, /revoked/);
  allowed = false;
  release();
  await Promise.all([firstDenied, secondDenied]);
});
