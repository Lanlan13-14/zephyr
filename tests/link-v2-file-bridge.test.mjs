import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLinkFileBridge } from '../link-v2-file-bridge.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request(body, token = 'bridge-secret-123456') {
  return { body, get(name) { return name === 'X-Link-Admin' ? token : ''; } };
}

test('Link file bridge rejects unauthenticated loopback calls', async () => {
  const bridge = createLinkFileBridge({
    fileAgentManager: { listAllAgents() { throw new Error('must not inspect agents'); } },
    storage: {}, adminToken: 'bridge-secret-123456',
  });
  const res = response();
  await bridge.handle(request({}, 'wrong-token'), res);
  assert.equal(res.statusCode, 401);
});

test('Link file bridge refuses agents without the Link capability', async () => {
  const bridge = createLinkFileBridge({
    fileAgentManager: {
      listAllAgents() { return [{ agentId: 'a1', deviceId: 'd1', online: true, capabilities: { binary: true } }]; },
      callAgentV2() { throw new Error('legacy Agent RPC must not be called'); },
    },
    storage: {}, adminToken: 'bridge-secret-123456',
  });
  const res = response();
  await bridge.handle(request({ deviceId: 'd1', op: 'stat', params: {} }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'agent_link_required');
});

test('Link file bridge only accepts an online binary Link endpoint', async () => {
  let called = false;
  const bridge = createLinkFileBridge({
    fileAgentManager: {
      listAllAgents() { return [{ agentId: 'a1', deviceId: 'd1', online: true, capabilities: { binary: true, linkFileBridge: true } }]; },
      callLinkFileBridge() { called = true; return { promise: Promise.resolve({ ok: true }) }; },
    },
    storage: {}, adminToken: 'bridge-secret-123456',
  });
  const res = response();
  await bridge.handle(request({ deviceId: 'd1', op: 'stat', params: {} }), res);
  assert.equal(called, true);
  assert.equal(res.body.ok, true);
});
