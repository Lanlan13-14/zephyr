import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let proxyId;

async function approve(confirmationId) {
    return server.api(adminCookie, 'POST', `/api/ai/confirm/${confirmationId}`, { approve: true });
}

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('proxy-tools-v1-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });
});

after(async () => server.cleanup());

test('canonical proxy interface rejects password and creates metadata-only proxy', async () => {
    const secretRejected = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_create_v1', args: { name: 'bad-secret', host: '127.0.0.1', port: 1080, password: 'not-model-visible' },
    });
    assert.equal(secretRejected.status, 400);
    assert.equal(secretRejected.body.code, 'invalid_tool_arguments');

    const pending = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_create_v1', args: { name: 'canonical-proxy', host: '10.0.0.2', port: 1080, type: 'socks5', username: 'ops' },
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.result.confirmationRequired, true);
    const created = await approve(pending.body.result.confirmation.id);
    assert.equal(created.status, 200);
    const proxy = created.body.result.data.proxy;
    proxyId = proxy.id;
    assert.equal(proxy.revision, 1);
    assert.equal(proxy.hasPassword, false);
    assert.equal(Object.hasOwn(proxy, 'password'), false);

    const listed = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_list_v1', args: { query: 'canonical' },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.data.proxies[0].id, proxyId);
});

test('canonical proxy update and delete enforce revision protection', async () => {
    const read = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_get_v1', args: { proxyId },
    });
    assert.equal(read.status, 200);
    const revision = read.body.result.data.proxy.revision;

    const pendingUpdate = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_update_v1', args: { proxyId, expectedRevision: revision, name: 'canonical-proxy-updated', type: 'http' },
    });
    const updated = await approve(pendingUpdate.body.result.confirmation.id);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.result.data.proxy.name, 'canonical-proxy-updated');
    assert.equal(updated.body.result.data.proxy.type, 'http');
    assert.equal(updated.body.result.data.proxy.revision, revision + 1);

    const staleDelete = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_delete_v1', args: { proxyId, expectedRevision: revision },
    });
    const stale = await approve(staleDelete.body.result.confirmation.id);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'revision_conflict');

    const current = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_get_v1', args: { proxyId },
    });
    const pendingDelete = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_delete_v1', args: { proxyId, expectedRevision: current.body.result.data.proxy.revision },
    });
    const deleted = await approve(pendingDelete.body.result.confirmation.id);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.result.data.deleted, true);

    const absent = await server.api(adminCookie, 'POST', '/api/ai/tools/run', { tool: 'proxy_get_v1', args: { proxyId } });
    assert.equal(absent.status, 404);
});
