import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let ownerCookie;
let guestCookie;
let ownerId;
let proxyId;

async function approve(cookie, confirmationId) {
    return server.api(cookie, 'POST', `/api/ai/confirm/${confirmationId}`, { approve: true });
}

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('proxy-acl-admin-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });

    const owner = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'proxy-owner', password: 'owner-pass', role: 'user' });
    ownerId = owner.body.user.userId;
    const ownerLogin = await server.login('proxy-owner', 'owner-pass');
    await server.api(ownerLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'owner-pass', newPassword: 'owner-real-pass' });
    ownerCookie = ownerLogin.cookie;

    const guest = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'proxy-guest', password: 'guest-pass', role: 'user' });
    const guestLogin = await server.login('proxy-guest', 'guest-pass');
    await server.api(guestLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'guest-pass', newPassword: 'guest-real-pass' });
    guestCookie = guestLogin.cookie;

    const pending = await server.api(ownerCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_create_v1', args: { name: 'owner-only-proxy', host: '10.1.1.1', port: 1080, type: 'socks5' },
    });
    const created = await approve(ownerCookie, pending.body.result.confirmation.id);
    proxyId = created.body.result.data.proxy.id;
});

after(async () => server.cleanup());

test('unshared proxy is neither listed nor readable through AI', async () => {
    const list = await server.api(guestCookie, 'POST', '/api/ai/tools/run', { tool: 'proxy_list_v1', args: {} });
    assert.equal(list.status, 200);
    assert.equal(list.body.result.data.proxies.some((proxy) => proxy.id === proxyId), false);

    const get = await server.api(guestCookie, 'POST', '/api/ai/tools/run', { tool: 'proxy_get_v1', args: { proxyId } });
    assert.equal(get.status, 403);
});

test('shared view proxy remains non-editable and passwordless through AI', async () => {
    const grant = await server.api(ownerCookie, 'PUT', `/api/resources/proxy/${proxyId}/shares`, {
        shares: [{ subjectType: 'user', subjectId: ownerId, capabilities: ['view'] }],
    });
    assert.equal(grant.status, 400, 'owner cannot accidentally self-grant instead of guest');

    const users = await server.api(adminCookie, 'GET', '/api/admin/users');
    const guest = users.body.users.find((user) => user.username === 'proxy-guest');
    const shared = await server.api(ownerCookie, 'PUT', `/api/resources/proxy/${proxyId}/shares`, {
        shares: [{ subjectType: 'user', subjectId: guest.userId, capabilities: ['discover', 'view'] }],
    });
    assert.equal(shared.status, 200);

    const get = await server.api(guestCookie, 'POST', '/api/ai/tools/run', { tool: 'proxy_get_v1', args: { proxyId } });
    assert.equal(get.status, 200);
    assert.equal(Object.hasOwn(get.body.result.data.proxy, 'password'), false);

    const update = await server.api(guestCookie, 'POST', '/api/ai/tools/run', {
        tool: 'proxy_update_v1', args: { proxyId, expectedRevision: get.body.result.data.proxy.revision, name: 'must-not-edit' },
    });
    assert.equal(update.status, 403);
});
