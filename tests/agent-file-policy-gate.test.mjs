import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAgentManager, AgentError } = require('../file-agent-manager.js');

function allowContext(overrides = {}) {
  return {
    subject: 'user:alice',
    channel: 'file-bridge',
    share: 'projects',
    localEffect: 'allow',
    localOperations: ['read', 'list', 'stat'],
    localShares: ['projects'],
    localChannels: ['file-bridge'],
    localSubjects: ['user:alice'],
    primaryOperations: ['read', 'list', 'stat', 'write'],
    primaryChannels: ['file-bridge'],
    primaryShares: ['projects'],
    systemOperations: ['read', 'list', 'stat', 'write'],
    systemChannels: ['file-bridge'],
    systemShares: ['projects'],
    generation: 1,
    sessionGeneration: 1,
    riskLevel: 'low',
    now: 1,
    ...overrides,
  };
}

function fakeConn({ readOnly = false, policyContext = null } = {}) {
  const calls = [];
  return {
    online: true,
    share: { name: 'projects', readOnly, root: '/tmp/zephyr-agent-shares/projects' },
    policyContext,
    capabilities: { read: true, write: true, mkdir: true, delete: true, rename: true, truncate: true },
    callRpc: async (method, params) => {
      calls.push({ method, params });
      return { ok: true, method, params };
    },
    calls,
  };
}

function managerWith(conn, id = 'agent-1') {
  const manager = new FileAgentManager({
    tokenStore: {
      listLinkIdentities() { return []; },
      metadataSyncContract: {},
      ensureReady() { return this; },
      close() {},
    },
    tokenFile: '/tmp/zephyr-agent-tokens-test.json',
    log() {},
  });
  manager.agents.set(id, conn);
  return manager;
}

test('local read-only policy blocks write even when primary allows it', async () => {
  const conn = fakeConn({ policyContext: allowContext() });
  const manager = managerWith(conn);
  await assert.rejects(
    () => manager.callAgent('agent-1', 'write', { path: 'a.txt' }),
    (err) => err && err.code === 'agent_local_policy_denied',
  );
  assert.equal(conn.calls.length, 0);
});

test('intersected allow still forwards list', async () => {
  const conn = fakeConn({ policyContext: allowContext() });
  const manager = managerWith(conn);
  const result = await manager.callAgent('agent-1', 'list', { path: 'docs' });
  assert.equal(result.ok, true);
  assert.equal(conn.calls.length, 1);
  assert.equal(conn.calls[0].method, 'list');
});

test('without policyContext, readOnly share still uses the old read_only error', async () => {
  const conn = fakeConn({ readOnly: true, policyContext: null });
  const manager = managerWith(conn);
  await assert.rejects(
    () => manager.callAgent('agent-1', 'write', { path: 'a.txt' }),
    (err) => err && err.code === 'read_only',
  );
  assert.equal(conn.calls.length, 0);
});

test('dotdot path is path_escape before RPC', async () => {
  const conn = fakeConn({
    policyContext: allowContext({
      localOperations: ['read', 'list', 'stat', 'write'],
      primaryOperations: ['read', 'list', 'stat', 'write'],
      systemOperations: ['read', 'list', 'stat', 'write'],
    }),
  });
  const manager = managerWith(conn);
  await assert.rejects(
    () => manager.callAgent('agent-1', 'write', { path: '../etc/passwd' }),
    (err) => err && err.code === 'path_escape',
  );
  assert.equal(conn.calls.length, 0);
});


test('real escaping parent symlink is rejected before legacy and v2 RPC', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-agent-jail-'));
  const root = path.join(dir, 'share');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
  const conn = fakeConn();
  conn.share.root = root;
  conn.wireVersion = 2;
  conn.supportsV2 = true;
  conn.callBinaryV2 = () => { assert.fail('must not reach v2 RPC'); };
  const manager = managerWith(conn);
  try {
    await assert.rejects(manager.callAgent('agent-1', 'write', { path: 'escape/new-file' }), (error) => error.code === 'path_escape');
    await assert.rejects(manager.callAgentV2('agent-1', 'mkdir', { path: 'escape/new-dir' }).promise, (error) => error.code === 'path_escape');
    assert.equal(conn.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
