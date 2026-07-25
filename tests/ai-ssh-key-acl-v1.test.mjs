import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let ownerCookie;
let guestCookie;
let guestId;
let keyId;

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('sshkey-acl-admin-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });
    const owner = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'key-owner', password: 'owner-pass', role: 'user' });
    const ownerLogin = await server.login('key-owner', 'owner-pass');
    await server.api(ownerLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'owner-pass', newPassword: 'owner-real-pass' });
    ownerCookie = ownerLogin.cookie;
    const guest = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'key-guest', password: 'guest-pass', role: 'user' });
    guestId = guest.body.user.userId;
    const guestLogin = await server.login('key-guest', 'guest-pass');
    await server.api(guestLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'guest-pass', newPassword: 'guest-real-pass' });
    guestCookie = guestLogin.cookie;
    const key = await server.api(ownerCookie, 'POST', '/api/ssh-keys', {
        name: 'private-owner-key', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nmaterial\n-----END RSA PRIVATE KEY-----', passphrase: 'pass',
    });
    keyId = key.body.sshKey.id;
});

after(async () => server.cleanup());

test('unshared SSH key cannot be discovered or read by another user', async () => {
    const list = await server.api(guestCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_list_v1', args: {} });
    assert.equal(list.status, 200);
    assert.equal(list.body.result.data.sshKeys.some((item) => item.id === keyId), false);
    const get = await server.api(guestCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_get_v1', args: { sshKeyId: keyId } });
    assert.equal(get.status, 403);
});

test('shared view SSH key has no secret and cannot be modified', async () => {
    const shared = await server.api(ownerCookie, 'PUT', `/api/resources/sshKey/${keyId}/shares`, {
        shares: [{ subjectType: 'user', subjectId: guestId, capabilities: ['discover', 'view'] }],
    });
    assert.equal(shared.status, 200);
    const get = await server.api(guestCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_get_v1', args: { sshKeyId: keyId } });
    assert.equal(get.status, 200);
    assert.equal(Object.hasOwn(get.body.result.data.sshKey, 'privateKey'), false);
    assert.equal(Object.hasOwn(get.body.result.data.sshKey, 'passphrase'), false);
    const update = await server.api(guestCookie, 'POST', '/api/ai/tools/run', {
        tool: 'ssh_key_rename_v1', args: { sshKeyId: keyId, expectedRevision: get.body.result.data.sshKey.revision, name: 'no-edit' },
    });
    assert.equal(update.status, 403);
});
