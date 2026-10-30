import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeCanonicalTool } = require('../ai-tool-executor.js');
const { createAiRunRegistry } = require('../ai-run-idempotency.js');

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string' } },
};

test('canonical tool with the same runId executes once', async () => {
  const runRegistry = createAiRunRegistry();
  let calls = 0;
  const ctx = { runId: 'run-exec-1', toolCallId: 'call-1', user: { userId: 'alice' }, sessionId: 'session-1', runRegistry };
  const first = await executeCanonicalTool({
    toolId: 'connection_get_v1',
    schema,
    args: { name: 'box' },
    ctx,
    authorize: async () => {},
    execute: async () => {
      calls += 1;
      return { name: 'box', n: calls };
    },
    policy: { capabilityId: 'connection.read', risk: 'low' },
  });
  const second = await executeCanonicalTool({
    toolId: 'connection_get_v1',
    schema,
    args: { name: 'box' },
    ctx,
    authorize: async () => {},
    execute: async () => {
      calls += 1;
      return { name: 'box', n: calls };
    },
    policy: { capabilityId: 'connection.read', risk: 'low' },
  });
  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
});

test('canonical tools in one run use independent call ids', async () => {
  const runRegistry = createAiRunRegistry();
  const calls = [];
  for (const [toolId, toolCallId] of [['connection_get_v1', 'call-1'], ['capability_search', 'call-2']]) {
    await executeCanonicalTool({
      toolId, schema: { type: 'object' }, args: {},
      ctx: { user: { userId: 'alice' }, sessionId: 's', runId: 'r', toolCallId, runRegistry },
      policy: { capabilityId: toolId, risk: 'low' },
      execute: async () => { calls.push(toolId); return toolId; },
    });
  }
  assert.deepEqual(calls, ['connection_get_v1', 'capability_search']);
});

test('canonical tool requires call id when run id is present', async () => {
  await assert.rejects(executeCanonicalTool({
    toolId: 'connection_get_v1', schema, args: {}, ctx: { runId: 'r', user: { userId: 'alice' } },
    policy: { capabilityId: 'connection.read', risk: 'low' }, execute: async () => null,
  }), (err) => err.code === 'invalid_tool_call_id');
});

test('canonical tool without runId still executes every time', async () => {
  let calls = 0;
  const run = () => executeCanonicalTool({
    toolId: 'connection_get_v1',
    schema,
    args: {},
    ctx: {},
    authorize: async () => {},
    execute: async () => {
      calls += 1;
      return { n: calls };
    },
    policy: { capabilityId: 'connection.read', risk: 'low' },
  });
  await run();
  await run();
  assert.equal(calls, 2);
});
