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
  const ctx = { runId: 'run-exec-1', runRegistry };
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
