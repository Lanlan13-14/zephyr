import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';
import aiAgentModule from '../ai-agent-service.js';

let server;
let cookie;
let sshConnectionId;
let jumpHostId;
let snippetId;

async function approve(id) {
  return server.api(cookie, 'POST', `/api/ai/confirm/${id}`, { approve: true });
}

before(async () => {
  server = new TestServer();
  await server.start();
  ({ cookie } = await server.bootstrapAdmin('jump-snippet-v1-pass'));
  await server.api(cookie, 'PUT', '/api/settings', { ai: { enabled: true } });
  const pending = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'connection_create_v1',
    args: { name: 'jump-base', protocol: 'SSH', host: '10.0.0.5', port: 22, username: 'ops' },
  });
  const created = await approve(pending.body.result.confirmation.id);
  sshConnectionId = created.body.result.data.connection.id;
});

after(async () => server.cleanup());

test('canonical jump-host lifecycle uses SSH dependency and revision', async () => {
  const pending = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'jump_host_create_v1', args: { name: 'prod-bastion', connectionId: sshConnectionId },
  });
  assert.equal(pending.body.result.confirmationRequired, true);
  const created = await approve(pending.body.result.confirmation.id);
  assert.equal(created.status, 200);
  const jump = created.body.result.data.jumpHost;
  jumpHostId = jump.id;
  assert.equal(jump.connection.protocol, 'SSH');
  assert.equal(jump.revision, 1);

  const listed = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool: 'jump_host_list_v1', args: { query: 'bastion' } });
  assert.equal(listed.body.result.data.jumpHosts[0].id, jumpHostId);

  const pendingUpdate = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'jump_host_update_v1', args: { jumpHostId, expectedRevision: 1, name: 'prod-bastion-2' },
  });
  const updated = await approve(pendingUpdate.body.result.confirmation.id);
  assert.equal(updated.body.result.data.jumpHost.revision, 2);

  const staleDelete = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'jump_host_delete_v1', args: { jumpHostId, expectedRevision: 1 },
  });
  const stale = await approve(staleDelete.body.result.confirmation.id);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'revision_conflict');
});

test('canonical snippets are personal, confirmed, and revision protected', async () => {
  const pending = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'snippet_create_v1', args: { name: 'health', command: 'uptime', group: 'ops', autoRun: false },
  });
  assert.equal(pending.body.result.confirmationRequired, true);
  const created = await approve(pending.body.result.confirmation.id);
  assert.equal(created.status, 200);
  const snippet = created.body.result.data.snippet;
  snippetId = snippet.id;
  assert.equal(snippet.revision, 1);

  const read = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool: 'snippet_get_v1', args: { snippetId } });
  assert.equal(read.body.result.data.snippet.command, 'uptime');

  const pendingUpdate = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'snippet_update_v1', args: { snippetId, expectedRevision: 1, command: 'uptime -p' },
  });
  const updated = await approve(pendingUpdate.body.result.confirmation.id);
  assert.equal(updated.body.result.data.snippet.revision, 2);

  const stale = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'snippet_delete_v1', args: { snippetId, expectedRevision: 1 },
  });
  const staleResult = await approve(stale.body.result.confirmation.id);
  assert.equal(staleResult.status, 409);
  assert.equal(staleResult.body.code, 'revision_conflict');

  const pendingDelete = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'snippet_delete_v1', args: { snippetId, expectedRevision: 2 },
  });
  const deleted = await approve(pendingDelete.body.result.confirmation.id);
  assert.equal(deleted.body.result.data.deleted, true);
});

test('model catalog does not expose legacy credential-bearing asset tools', () => {
  const names = new Set(aiAgentModule.listToolCatalog({}).map((tool) => tool.name));
  for (const name of ['connection_create', 'connection_update', 'proxy_save', 'ssh_key_save', 'jump_host_save', 'snippet_save']) {
    assert.equal(names.has(name), false, `${name} must not be exposed to the model`);
  }
});
