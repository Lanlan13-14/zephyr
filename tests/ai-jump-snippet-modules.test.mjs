import test from 'node:test';
import assert from 'node:assert/strict';
import jumpTools from '../ai-jump-host-tools.js';
import snippetTools from '../ai-snippet-tools.js';

function jumpHarness() {
  const user = { userId: 'u1' };
  const rows = new Map();
  const connections = new Map([
    ['ssh-1', { id: 'ssh-1', name: 'bastion', protocol: 'SSH', host: '10.0.0.1', port: 22, username: 'ops', capabilities: ['view', 'use'] }],
    ['rdp-1', { id: 'rdp-1', name: 'desktop', protocol: 'RDP', host: '10.0.0.2', port: 3389, capabilities: ['view', 'use'] }],
  ]);
  const service = {
    getConnection(_user, id) {
      const item = connections.get(id);
      if (!item) throw new Error('not found');
      return { ...item };
    },
    createOwned(_user, type, data) {
      assert.equal(type, 'jumpHost');
      rows.set(data.id, { ...data });
      return { ...data };
    },
    getRawAuthorized(_user, type, id) {
      assert.equal(type, 'jumpHost');
      const item = rows.get(id);
      if (!item) throw new Error('not found');
      return { ...item };
    },
    updateOwned(_user, type, id, patch) {
      assert.equal(type, 'jumpHost');
      const old = rows.get(id);
      const next = { ...old, ...patch, revision: old.revision + 1 };
      rows.set(id, next);
      return { ...next };
    },
    deleteOwned(_user, type, id) {
      assert.equal(type, 'jumpHost');
      rows.delete(id);
    },
  };
  return { user, rows, service };
}

test('jump-host module enforces SSH dependency and revision', () => {
  const { user, rows, service } = jumpHarness();
  assert.throws(() => jumpTools.createJumpHost(user, { name: 'bad', connectionId: 'rdp-1' }, service), /SSH/);
  const created = jumpTools.createJumpHost(user, { name: 'prod-hop', connectionId: 'ssh-1' }, service);
  assert.equal(created.revision, 1);
  assert.equal(created.connection.protocol, 'SSH');
  assert.throws(() => jumpTools.updateJumpHost(user, { jumpHostId: created.id, expectedRevision: 9, name: 'stale' }, service), (error) => error.code === 'revision_conflict');
  const updated = jumpTools.updateJumpHost(user, { jumpHostId: created.id, expectedRevision: 1, name: 'prod-hop-2' }, service);
  assert.equal(updated.revision, 2);
  const deleted = jumpTools.deleteJumpHost(user, { jumpHostId: created.id, expectedRevision: 2 }, service);
  assert.equal(deleted.deleted, true);
  assert.equal(rows.has(created.id), false);
});

function snippetHarness() {
  const state = new Map();
  const service = {
    getUserOverrides(userId) { return state.get(userId) || {}; },
    putUserOverrides(userId, patch) {
      state.set(userId, { ...(state.get(userId) || {}), ...patch });
      return state.get(userId);
    },
  };
  return { state, service, user: { userId: 'u1' } };
}

test('snippet module is per-user and revision protected', () => {
  const { state, service, user } = snippetHarness();
  const created = snippetTools.createSnippet(user, { name: 'uptime', command: 'uptime', group: 'ops', autoRun: true }, service);
  assert.equal(created.revision, 1);
  assert.equal(snippetTools.listSnippets(user, { group: 'ops' }, service).length, 1);
  assert.equal(snippetTools.listSnippets({ userId: 'u2' }, {}, service).length, 0);
  assert.throws(() => snippetTools.updateSnippet(user, { snippetId: created.id, expectedRevision: 3, name: 'bad' }, service), (error) => error.code === 'revision_conflict');
  const updated = snippetTools.updateSnippet(user, { snippetId: created.id, expectedRevision: 1, command: 'uptime -p' }, service);
  assert.equal(updated.revision, 2);
  assert.equal(updated.command, 'uptime -p');
  const deleted = snippetTools.deleteSnippet(user, { snippetId: created.id, expectedRevision: 2 }, service);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(state.get(user.userId).snippets, []);
});
