import test from 'node:test';
import assert from 'node:assert/strict';
import agentTools from '../ai-agent-device-tools.js';

function managerHarness({ owner = 'u1', readOnly = false, text = 'hello agent' } = {}) {
  const calls = [];
  const info = { agentId: 'a1', deviceName: 'phone', platform: 'android', appVersion: '1.2.3', online: true, readOnly, shareName: 'Files', capabilities: { binaryRead: true } };
  return {
    calls,
    info,
    manager: {
      isAgentOwnedByUser(id, user) { return id === 'a1' && (user.userId === owner || user.username === owner); },
      getAgentInfo(id) { return id === 'a1' ? info : null; },
      async callAgent(_id, method, params) {
        calls.push({ method, params });
        if (method === 'stat') return { name: 'x.txt', path: params.path, isDir: false, size: Buffer.byteLength(text), mtime: 10 };
        if (method === 'open') return { handle: 'h1' };
        if (method === 'close') return {};
        return {};
      },
      async callAgentBinaryReadCached() { return Buffer.from(text); },
    },
  };
}

test('agent path normalization stays inside shared root', () => {
  assert.equal(agentTools.normalizeAgentPath('docs/../notes/a.txt'), '/notes/a.txt');
  assert.throws(() => agentTools.normalizeAgentPath('C:\\secret.txt'), (error) => error.code === 'invalid_agent_path');
  assert.throws(() => agentTools.normalizeAgentPath('../../secret.txt'), (error) => error.code === 'invalid_agent_path');
  assert.throws(() => agentTools.normalizeAgentPath('/', { allowRoot: false }), (error) => error.code === 'invalid_agent_path');
});

test('agent ownership is fail-closed and public info omits token data', () => {
  const h = managerHarness();
  const info = agentTools.requireOwnedAgent(h.manager, { userId: 'u1', username: 'alice' }, 'a1');
  const pub = agentTools.publicAgent({ ...info, tokenId: 'secret-token-id', tokenName: 'secret-token-name' });
  assert.equal(pub.appVersion, '1.2.3');
  assert.equal(Object.hasOwn(pub, 'tokenId'), false);
  assert.throws(() => agentTools.requireOwnedAgent(h.manager, { userId: 'u2', username: 'bob' }, 'a1'), (error) => error.status === 404);
});

test('agent text read is bounded and always closes handle', async () => {
  const h = managerHarness({ text: 'hello agent' });
  const result = await agentTools.readText(h.manager, { userId: 'u1', username: 'alice' }, { agentId: 'a1', path: '/x.txt', maxBytes: 20 });
  assert.equal(result.text, 'hello agent');
  assert.equal(result.truncated, false);
  assert.deepEqual(h.calls.map((call) => call.method), ['stat', 'open', 'close']);
});

test('agent writeText uses v2 open/writeBinary/close and rejects readonly', async () => {
  const h = managerHarness({ readOnly: false });
  const v2 = [];
  h.manager.callAgentV2 = (_id, method, params) => {
    v2.push({ method, params });
    if (method === 'open') return { promise: Promise.resolve({ handle: 'hw' }) };
    if (method === 'writeBinary') return { promise: Promise.resolve({ bytesWritten: (params.data || []).length }) };
    if (method === 'close') return { promise: Promise.resolve({}) };
    return { promise: Promise.resolve({}) };
  };
  const result = await agentTools.writeText(h.manager, { userId: 'u1', username: 'alice' }, { agentId: 'a1', path: '/out.txt', content: 'abc' });
  assert.equal(result.bytes, 3);
  assert.deepEqual(v2.map((item) => item.method), ['open', 'writeBinary', 'close']);
  h.info.readOnly = true;
  await assert.rejects(() => agentTools.writeText(h.manager, { userId: 'u1', username: 'alice' }, { agentId: 'a1', path: '/out.txt', content: 'x' }), (error) => error.code === 'agent_read_only');
});
