import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let listenServer;
let listenPort;

before(async () => {
    listenServer = net.createServer((sock) => {
        // Accept TCP and ignore payload — enough for connectivity test.
        sock.on('data', () => {});
    });
    await new Promise((r) => listenServer.listen(0, '127.0.0.1', r));
    listenPort = listenServer.address().port;

    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-telnet');
    adminCookie = boot.cookie;
});

after(async () => {
    await server.cleanup();
    await new Promise((r) => listenServer.close(r));
});

test('POST /api/connections accepts TELNET with default port 23', async () => {
    const res = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'router-console',
        host: '10.0.0.1',
        protocol: 'TELNET',
        // no username — allowed for Telnet
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.connection.protocol, 'TELNET');
    assert.equal(res.body.connection.port, 23);
    assert.equal(res.body.connection.connectionMode, 'direct');
    assert.equal(res.body.connection.password || '', '');
    assert.equal(res.body.connection.privateKey || '', '');
});

test('POST /api/connections/test succeeds against a local Telnet-like TCP port', async () => {
    const res = await server.api(adminCookie, 'POST', '/api/connections/test', {
        name: 'local-telnet',
        host: '127.0.0.1',
        port: listenPort,
        protocol: 'TELNET',
        timeoutSeconds: 3,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.match(res.body.message || '', /Telnet|可达|success/i);
});

test('deeplink prepare + test for telnet:// works', async () => {
    const prep = await server.api(adminCookie, 'POST', '/api/deeplinks/prepare', {
        uri: `telnet://127.0.0.1:${listenPort}`,
    });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.equal(prep.body.draft.protocol, 'TELNET');
    assert.equal(prep.body.draft.port, listenPort);

    const testRes = await server.api(adminCookie, 'POST', `/api/deeplinks/${encodeURIComponent(prep.body.token)}/test`, {
        overrides: {},
        timeoutSeconds: 3,
    });
    assert.equal(testRes.status, 200, JSON.stringify(testRes.body));
    assert.equal(testRes.body.ok, true);
});

test('PUT forces TELNET connections back to direct; keeps password, clears privateKey/route', async () => {
    const created = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'telnet-edit',
        host: '10.1.1.1',
        protocol: 'SSH',
        username: 'root',
        password: 'should-clear',
        port: 22,
    });
    assert.equal(created.status, 200);
    const id = created.body.connection.id;
    const updated = await server.api(adminCookie, 'PUT', `/api/connections/${id}`, {
        protocol: 'TELNET',
        host: '10.1.1.1',
        name: 'telnet-edit',
        username: 'admin',
        password: 'inband-secret',
        privateKey: '-----BEGIN FAKE-----',
        connectionMode: 'proxy',
        proxyId: 'whatever',
        encoding: 'gbk',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.connection.protocol, 'TELNET');
    assert.equal(updated.body.connection.connectionMode, 'direct');
    // Password is stored (masked in API response as ****** or hasPassword).
    assert.ok(
        updated.body.connection.hasPassword === true
        || updated.body.connection.password === '******'
        || updated.body.connection.password === 'inband-secret',
        'password should be kept for in-band auto-login',
    );
    assert.equal(updated.body.connection.privateKey || '', '');
    assert.equal(updated.body.connection.encoding || 'utf-8', 'gbk');
});

test('POST /api/connections stores TELNET password for auto-login', async () => {
    const res = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'telnet-with-creds',
        host: '10.2.2.2',
        protocol: 'TELNET',
        username: 'root',
        password: 'plain-but-stored',
        encoding: 'utf-8',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(
        res.body.connection.hasPassword === true
        || res.body.connection.password === '******'
        || res.body.connection.password === 'plain-but-stored',
    );
});
