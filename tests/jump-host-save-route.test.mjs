import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

/*
 * Saving a jump route must succeed for every hop id the UI can actually
 * produce, and must fail with a readable server message otherwise.
 *
 * The connection editor offers every SSH connection as a hop, so the ids it
 * posts in jumpHostIds are bare connection ids. The save-time validator used
 * to accept only jump_hosts record ids, so any route built in the UI came back
 * 400 "选择的跳板机不存在" while the runtime resolver and the connection-test
 * resolver both accepted the same id happily. The browser had no catch on the
 * save path, so that 400 surfaced as the generic "前端异步错误" toast.
 */

let app;
let ownerCookie;
let otherCookie;
let hopId;
let jumpHostId;
let rdpHopId;

before(async () => {
    app = new TestServer();
    await app.start();
    ownerCookie = (await app.bootstrapAdmin('jump-save-owner-pass')).cookie;

    const created = await app.api(ownerCookie, 'POST', '/api/admin/users', {
        username: 'jump-save-other', password: 'jump-save-temp-pass', role: 'user',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    otherCookie = (await app.login('jump-save-other', 'jump-save-temp-pass')).cookie;
    const changed = await app.api(otherCookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'jump-save-temp-pass', newPassword: 'jump-save-other-pass',
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const hop = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'bastion-hop', host: '10.10.0.1', port: 22, protocol: 'SSH',
        username: 'root', password: 'hop-pass',
    });
    assert.equal(hop.status, 200, JSON.stringify(hop.body));
    hopId = hop.body.connection.id;

    const named = await app.api(ownerCookie, 'POST', '/api/jump-hosts', {
        name: 'named-hop', connectionId: hopId,
    });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    jumpHostId = named.body.jumpHost.id;

    const rdp = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'rdp-not-a-hop', host: '10.10.0.9', port: 3389, protocol: 'RDP', username: 'admin',
    });
    assert.equal(rdp.status, 200, JSON.stringify(rdp.body));
    rdpHopId = rdp.body.connection.id;
});

after(async () => {
    await app?.cleanup();
});

test('saving a jump route addressed by SSH connection id succeeds', async () => {
    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-by-connection-id', host: '10.10.0.2', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: hopId, jumpHostIds: [hopId],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.connection.jumpHostIds, [hopId]);
    assert.equal(saved.body.connection.connectionMode, 'jump');
});

test('saving a jump route addressed by jump_hosts record id still succeeds', async () => {
    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-by-jump-host-id', host: '10.10.0.3', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: jumpHostId, jumpHostIds: [jumpHostId],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.connection.jumpHostIds, [jumpHostId]);
});

test('editing a connection onto a jump route succeeds', async () => {
    const created = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-direct-then-jump', host: '10.10.0.4', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.connection.id;

    const edited = await app.api(ownerCookie, 'PUT', `/api/connections/${id}`, {
        connectionMode: 'jump', jumpHostId: hopId, jumpHostIds: [hopId],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.connection.jumpHostIds, [hopId]);
});

test('a multi-hop chain of connection ids saves in order', async () => {
    const second = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'bastion-hop-2', host: '10.10.0.5', port: 22, protocol: 'SSH',
        username: 'root', password: 'hop2-pass',
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const secondId = second.body.connection.id;

    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-two-hops', host: '10.10.0.6', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: hopId, jumpHostIds: [hopId, secondId],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.connection.jumpHostIds, [hopId, secondId]);
});

test('a non-SSH hop is refused with a readable message', async () => {
    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-rdp-hop', host: '10.10.0.7', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: rdpHopId, jumpHostIds: [rdpHopId],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.code, 'invalid_dependency');
    assert.match(String(saved.body.error), /SSH/);
});

test('an unknown hop id is refused, not saved silently', async () => {
    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-ghost-hop', host: '10.10.0.8', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: 'no-such-hop', jumpHostIds: ['no-such-hop'],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.code, 'invalid_dependency');
});

test('an offline Agent bastion is refused with its own message', async () => {
    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-offline-agent', host: '10.10.0.11', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: 'agent:absent', jumpHostIds: ['agent:absent'],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.code, 'invalid_dependency');
    assert.match(String(saved.body.error), /Agent/);
});

test('a hop owned by another user is refused', async () => {
    const foreign = await app.api(otherCookie, 'POST', '/api/connections', {
        name: 'foreign-hop', host: '10.10.0.12', port: 22, protocol: 'SSH',
        username: 'root', password: 'foreign-pass',
    });
    assert.equal(foreign.status, 200, JSON.stringify(foreign.body));
    const foreignId = foreign.body.connection.id;

    const saved = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-foreign-hop', host: '10.10.0.13', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostId: foreignId, jumpHostIds: [foreignId],
    });
    assert.ok(saved.status === 400 || saved.status === 403, `expected a refusal, got ${saved.status} ${JSON.stringify(saved.body)}`);
});

test('a connection cannot use itself as its own hop', async () => {
    const created = await app.api(ownerCookie, 'POST', '/api/connections', {
        name: 'target-self-hop', host: '10.10.0.14', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.connection.id;

    const edited = await app.api(ownerCookie, 'PUT', `/api/connections/${id}`, {
        connectionMode: 'jump', jumpHostId: id, jumpHostIds: [id],
    });
    assert.equal(edited.status, 400, JSON.stringify(edited.body));
    assert.equal(edited.body.code, 'invalid_dependency');
});

test('creating an Agent bastion proxy fails validation instead of crashing', async () => {
    const created = await app.api(ownerCookie, 'POST', '/api/proxies', {
        name: 'agent-bastion-proxy', type: 'agent', agentId: 'absent-agent',
    });
    // The Agent is not connected, so this must be a 400 with a readable
    // message — never a 500 from calling a method that does not exist.
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.notEqual(created.body.code, 'internal_error');
    assert.doesNotMatch(String(created.body.error || ''), /is not a function/);
});

test('an Agent bastion proxy without an agentId is rejected', async () => {
    const created = await app.api(ownerCookie, 'POST', '/api/proxies', {
        name: 'agent-bastion-no-id', type: 'agent',
    });
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.notEqual(created.body.code, 'internal_error');
});

test('ordinary proxies still save and edit normally', async () => {
    const created = await app.api(ownerCookie, 'POST', '/api/proxies', {
        name: 'socks-proxy', type: 'socks5', host: '127.0.0.1', port: 1080,
        username: 'u', password: 'p',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.proxy.id;

    const edited = await app.api(ownerCookie, 'PUT', `/api/proxies/${id}`, {
        name: 'socks-proxy-renamed', type: 'socks5', host: '127.0.0.1', port: 1081,
        username: 'u', password: '******',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.proxy.name, 'socks-proxy-renamed');
    assert.equal(edited.body.proxy.port, 1081);
});
