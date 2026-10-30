import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const token = 'test-link-host-call-identity';
process.env.ZEPHYR_AI_PLATFORM_HOST_TOKEN = token;
const express = require('express');
const { registerAiHostRoutes } = require('../ai-runtime-bridge.js');

test('Node Host requires call id and supports independent tools in one run', async () => {
  let authorizationChecks = 0;
  let live = true;
  const app = express();
  app.use(express.json());
  registerAiHostRoutes(app, {
    storage: { getSettings: () => ({ ai: {} }), getUserById: (userId) => ({ userId, role: 'user' }) },
    resources: { listConnections: () => [] },
    runtimeBridge: { beginHostCall() {
      const release = () => {};
      release.assertLive = () => {
        authorizationChecks += 1;
        if (!live) { const error = new Error('revoked'); error.status = 403; error.code = 'run_revoked'; throw error; }
      };
      release.assertLive();
      return release;
    } },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = (extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/internal/ai-host/v1/call`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-host-admin': token },
    body: JSON.stringify({ tool: 'capability_search', args: {}, userId: 'alice', sessionId: 's', runId: 'r', databaseGeneration: 'g', runNonce: 'n', ...extra }),
  });
  try {
    const missing = await call();
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'invalid_tool_call_id');
    const first = await call({ callId: 'provider-1' });
    assert.equal(first.status, 200, await first.text());
    const second = await call({ callId: 'provider-2', tool: 'connection_list_v1' });
    assert.equal(second.status, 200, await second.text());
    const before = authorizationChecks;
    const replay = await call({ callId: 'provider-1' });
    assert.equal(replay.status, 200, await replay.text());
    assert.ok(authorizationChecks > before);
    live = false;
    const revoked = await call({ callId: 'provider-1' });
    assert.equal(revoked.status, 403);
    assert.equal((await revoked.json()).code, 'run_revoked');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
