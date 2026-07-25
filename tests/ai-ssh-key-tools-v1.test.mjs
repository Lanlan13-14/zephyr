import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let keyId;

async function approve(id) {
    return server.api(adminCookie, 'POST', `/api/ai/confirm/${id}`, { approve: true });
}

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('sshkey-tools-v1-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });
    const created = await server.api(adminCookie, 'POST', '/api/ssh-keys', {
        name: 'canonical-key',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-private-material\n-----END OPENSSH PRIVATE KEY-----',
        passphrase: 'test-passphrase', remark: 'test key metadata',
    });
    assert.equal(created.status, 200);
    keyId = created.body.sshKey.id;
});

after(async () => server.cleanup());

test('canonical SSH key metadata tools never return private material', async () => {
    const list = await server.api(adminCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_list_v1', args: { query: 'canonical' } });
    assert.equal(list.status, 200);
    const row = list.body.result.data.sshKeys.find((item) => item.id === keyId);
    assert.ok(row);
    assert.equal(Object.hasOwn(row, 'privateKey'), false);
    assert.equal(Object.hasOwn(row, 'passphrase'), false);
    assert.equal(row.hasPrivateKey, true);
    assert.equal(row.hasPassphrase, true);
    assert.equal(row.fingerprint, '', 'list intentionally avoids reading private material');

    const get = await server.api(adminCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_get_v1', args: { sshKeyId: keyId } });
    assert.equal(get.status, 200);
    const key = get.body.result.data.sshKey;
    assert.match(key.fingerprint, /^SHA256:/);
    assert.equal(key.algorithm, 'openssh');
    assert.equal(Object.hasOwn(key, 'privateKey'), false);
    assert.equal(Object.hasOwn(key, 'passphrase'), false);

    const validate = await server.api(adminCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_validate_v1', args: { sshKeyId: keyId } });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.result.data.validation.valid, true);
    assert.match(validate.body.result.data.validation.fingerprint, /^SHA256:/);
});

test('canonical SSH key metadata writes use confirmation and revision', async () => {
    const read = await server.api(adminCookie, 'POST', '/api/ai/tools/run', { tool: 'ssh_key_get_v1', args: { sshKeyId: keyId } });
    const revision = read.body.result.data.sshKey.revision;

    const pendingRename = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'ssh_key_rename_v1', args: { sshKeyId: keyId, expectedRevision: revision, name: 'canonical-key-renamed' },
    });
    const renamed = await approve(pendingRename.body.result.confirmation.id);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.result.data.sshKey.revision, revision + 1);

    const pendingRemark = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'ssh_key_update_metadata_v1', args: { sshKeyId: keyId, expectedRevision: revision + 1, remark: 'updated only metadata' },
    });
    const remarked = await approve(pendingRemark.body.result.confirmation.id);
    assert.equal(remarked.status, 200);
    assert.equal(remarked.body.result.data.sshKey.remark, 'updated only metadata');
    assert.equal(remarked.body.result.data.sshKey.revision, revision + 2);

    const secretRejected = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'ssh_key_update_metadata_v1', args: { sshKeyId: keyId, expectedRevision: revision + 2, privateKey: 'must-not-pass' },
    });
    assert.equal(secretRejected.status, 400);
    assert.equal(secretRejected.body.code, 'invalid_tool_arguments');

    const staleDelete = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'ssh_key_delete_v1', args: { sshKeyId: keyId, expectedRevision: revision },
    });
    const stale = await approve(staleDelete.body.result.confirmation.id);
    assert.equal(stale.status, 409);

    const pendingDelete = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'ssh_key_delete_v1', args: { sshKeyId: keyId, expectedRevision: revision + 2 },
    });
    const deleted = await approve(pendingDelete.body.result.confirmation.id);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.result.data.deleted, true);
});
