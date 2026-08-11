import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TestServer } from './test-server.mjs';

let app;
let probeServer;
let rdpServer;
let probePort;
let rdpPort;
let ownerCookie;
let sharedCookie;
let sharedUserId;
let targetId;
let ownerProxyId;
let ownerJumpId;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

before(async () => {
    probeServer = net.createServer((socket) => socket.end());
    rdpServer = net.createServer((socket) => {
        socket.once('data', () => socket.end(Buffer.from([
            0x03, 0x00, 0x00, 0x0b,
            0x06, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])));
    });
    [probePort, rdpPort] = await Promise.all([listen(probeServer), listen(rdpServer)]);

    app = new TestServer();
    await app.start();
    ownerCookie = (await app.bootstrapAdmin('connection-test-owner-pass')).cookie;
    const createdUser = await app.api(ownerCookie, 'POST', '/api/admin/users', {
        username: 'connection-test-shared', password: 'connection-test-temp-pass', role: 'user',
    });
    assert.equal(createdUser.status, 200, JSON.stringify(createdUser.body));
    sharedUserId = createdUser.body.user.userId;
    sharedCookie = (await app.login('connection-test-shared', 'connection-test-temp-pass')).cookie;
    const changed = await app.api(sharedCookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'connection-test-temp-pass', newPassword: 'connection-test-shared-pass',
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const proxy = await app.api(ownerCookie, 'POST', '/api/proxies', {
        name: 'owner-only-proxy', host: '127.0.0.1', port: probePort, type: 'socks5',
        username: 'owner-proxy-user', password: 'owner-proxy-password',
    });
    assert.equal(proxy.status, 200, JSON.stringify(proxy.body));
    ownerProxyId = proxy.body.proxy.id;

    const hop = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'owner-hop', host: '127.0.0.1', port: 22, protocol: 'SSH',
        username: 'root', password: 'owner-hop-password', connectionMode: 'direct',
    });
    assert.equal(hop.status, 200, JSON.stringify(hop.body));
    const jump = await app.api(ownerCookie, 'POST', '/api/jump-hosts', {
        name: 'owner-only-jump', connectionId: hop.body.connection.id,
    });
    assert.equal(jump.status, 200, JSON.stringify(jump.body));
    ownerJumpId = jump.body.jumpHost.id;

    const target = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'shared-telnet-target', host: '127.0.0.1', port: probePort,
        protocol: 'TELNET', connectionMode: 'direct', password: 'owner-target-password',
    });
    assert.equal(target.status, 200, JSON.stringify(target.body));
    targetId = target.body.connection.id;
    const share = await app.api(ownerCookie, 'PUT', `/api/resources/connection/${targetId}/shares`, {
        shares: [{ subjectId: sharedUserId, tier: 'operator' }],
    });
    assert.equal(share.status, 200, JSON.stringify(share.body));
});

after(async () => {
    await app?.cleanup();
    await Promise.all([close(probeServer), close(rdpServer)]);
});

test('shared-use API rejects target, proxy and jump overrides before network access', async () => {
    const attempts = [
        { host: 'localhost', port: probePort },
        { connectionMode: 'proxy', proxyId: ownerProxyId },
        { connectionMode: 'jump', jumpHostId: ownerJumpId, jumpHostIds: [ownerJumpId] },
    ];
    for (const override of attempts) {
        const response = await app.api(sharedCookie, 'POST', '/api/connections/test', {
            connectionId: targetId,
            ...override,
        });
        assert.equal(response.status, 403, JSON.stringify(response.body));
        assert.equal(response.body.code, 'connection_test_override_forbidden');
    }
});

test('shared-use API still tests the unchanged saved endpoint', async () => {
    const response = await app.api(sharedCookie, 'POST', '/api/connections/test', {
        connectionId: targetId,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.code, 'success');
});

test('owner can preview a changed saved target', async () => {
    const response = await app.api(ownerCookie, 'POST', '/api/connections/test', {
        connectionId: targetId,
        host: '127.0.0.1',
        port: rdpPort,
        protocol: 'RDP',
        connectionMode: 'direct',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.code, 'success');
});

test('draft dependency errors do not reveal foreign versus missing proxy existence', async () => {
    const attempts = [ownerProxyId, '00000000-0000-4000-8000-000000000000'];
    const responses = [];
    for (const proxyId of attempts) {
        responses.push(await app.api(sharedCookie, 'POST', '/api/connections/test', {
            host: '127.0.0.1', port: probePort, protocol: 'TELNET',
            connectionMode: 'proxy', proxyId,
        }));
    }
    assert.deepEqual(
        responses.map((response) => ({ status: response.status, code: response.body.code, error: response.body.error })),
        [0, 1].map(() => ({
            status: 403,
            code: 'connection_test_dependency_unavailable',
            error: 'A connection test dependency is unavailable',
        })),
    );
});

test('non-Telnet draft RDP test keeps the existing protocol probe path', async () => {
    const response = await app.api(sharedCookie, 'POST', '/api/connections/test', {
        host: '127.0.0.1', port: rdpPort, protocol: 'RDP', connectionMode: 'direct',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.code, 'success');
});
