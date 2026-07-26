import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let cookie;
let keyId;

async function approve(id) { return server.api(cookie, 'POST', `/api/ai/confirm/${id}`, { approve: true }); }

before(async () => {
  server = new TestServer();
  await server.start();
  ({ cookie } = await server.bootstrapAdmin('secret-ref-binding-pass'));
  await server.api(cookie, 'PUT', '/api/settings', { ai: { enabled: true } });
  const created = await server.api(cookie, 'POST', '/api/ssh-keys', { name: 'bind-key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----', passphrase: 'not-for-model', remark: 'integration' });
  assert.equal(created.status, 200);
  keyId = created.body.sshKey.id;
});

after(async () => server.cleanup());

test('secret_ref_list_v1 never returns private material', async () => {
  const listed = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool: 'secret_ref_list_v1', args: { kind: 'ssh_key', query: 'bind-key' } });
  assert.equal(listed.status, 200);
  const refs = listed.body.result.data.secretRefs;
  assert.equal(refs.length, 1);
  assert.equal(refs[0].resourceId, keyId);
  const text = JSON.stringify(listed.body);
  assert.equal(text.includes('OPENSSH PRIVATE KEY'), false);
  assert.equal(text.includes('not-for-model'), false);
});

test('connection create binds saved SSH key through opaque secretRef', async () => {
  const listed = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool: 'secret_ref_list_v1', args: { kind: 'ssh_key', query: 'bind-key' } });
  const secretRef = listed.body.result.data.secretRefs[0].secretRef;
  const pending = await server.api(cookie, 'POST', '/api/ai/tools/run', {
    tool: 'connection_create_v1',
    args: { name: 'ref-bound-ssh', protocol: 'SSH', host: '10.0.0.33', port: 22, username: 'ops', sshKeySecretRef: secretRef },
  });
  assert.equal(pending.body.result.confirmationRequired, true);
  const created = await approve(pending.body.result.confirmation.id);
  assert.equal(created.status, 200);
  assert.equal(created.body.result.data.connection.hasSshKey, true);
  assert.equal(Object.hasOwn(created.body.result.data.connection, 'sshKeyId'), false);
  assert.equal(JSON.stringify(created.body).includes(secretRef), false);
});

test('secretRef cannot cross users or accept private material', async () => {
  const createdUser = await server.api(cookie, 'POST', '/api/admin/users', { username: 'ref-other', password: 'ref-other-pass-1', role: 'user' });
  assert.equal(createdUser.status, 200);
  const other = await server.login('ref-other', 'ref-other-pass-1');
  const changed = await server.api(other.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'ref-other-pass-1', newPassword: 'ref-other-pass-2' });
  assert.equal(changed.status, 200);
  const listed = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool: 'secret_ref_list_v1', args: { kind: 'ssh_key' } });
  const secretRef = listed.body.result.data.secretRefs[0].secretRef;
  const cross = await server.api(other.cookie, 'POST', '/api/ai/tools/run', { tool: 'connection_create_v1', args: { name: 'bad', protocol: 'SSH', host: '10.0.0.9', username: 'ops', sshKeySecretRef: secretRef } });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.code, 'secret_ref_forbidden');
  const rawSecret = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool: 'connection_create_v1', args: { name: 'bad-secret', protocol: 'SSH', host: '10.0.0.9', username: 'ops', privateKey: 'secret' } });
  assert.equal(rawSecret.status, 400);
  assert.equal(rawSecret.body.code, 'invalid_tool_arguments');
});
