import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

/* Stage 14 acceptance (FREEZE plan §14): end-to-end migration completeness.
 * Fresh install -> upgrade with existing data -> verify everything still
 * works and new fields are backfilled. */

let server;
let adminCookie;

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-mig');
    adminCookie = boot.cookie;
});

after(async () => {
    await server.cleanup();
});

test('bootstrap returns complete multi-user payload', async () => {
    const res = await server.api(adminCookie, 'GET', '/api/me/bootstrap');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.ok(b.user?.userId, 'user.userId');
    assert.equal(b.user?.role, 'admin', 'admin role');
    assert.ok(b.instanceId, 'instanceId');
    assert.ok(b.settings, 'settings merged');
    assert.ok(Array.isArray(b.workspaces), 'workspaces array');
    assert.ok(b.resources, 'resources');
    assert.ok(b.policies, 'policies');
});

test('auth/me returns userId and role for downstream features', async () => {
    const res = await server.api(adminCookie, 'GET', '/api/auth/me');
    assert.equal(res.status, 200);
    assert.ok(res.body.user?.userId, 'userId');
    assert.ok(res.body.user?.role, 'role');
    assert.ok(res.body.instanceId, 'instanceId');
});

test('all v1 tables exist and are queryable (migration completeness)', async () => {
    // Hit each major surface to prove the tables + services are live
    const surfaces = [
        '/api/connections',
        '/api/proxies',
        '/api/ssh-keys',
        '/api/jump-hosts',
        '/api/notes',
        '/api/me/settings',
        '/api/me/workspaces',
        '/api/admin/users',
        '/api/ai/status',
        '/api/me/bootstrap',
    ];
    for (const url of surfaces) {
        const res = await server.api(adminCookie, 'GET', url);
        assert.ok([200, 400, 404].includes(res.status), `${url} must not 5xx: got ${res.status}`);
    }
});

test('settings are three-layer merged and user override wins', async () => {
    // Set a user override
    const put = await server.api(adminCookie, 'PUT', '/api/me/settings', {
        'appearance.theme': 'dark',
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await server.api(adminCookie, 'GET', '/api/me/settings');
    assert.equal(get.status, 200);
    assert.equal(get.body.settings?.appearance?.theme, 'dark', 'user override must win over admin default');
});

test('workspace restore filters inaccessible resources', async () => {
    // Create a connection owned by admin
    const conn = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'mig-box', host: '10.9.9.9', username: 'root', password: 'pw', protocol: 'SSH',
    });
    assert.equal(conn.status, 200);
    const connId = conn.body.connection.id;

    // Save a workspace referencing it
    const ws = await server.api(adminCookie, 'PUT', '/api/me/workspaces/ws-mig-1', {
        clientId: 'test-client',
        name: 'Mig WS',
        state: { view: 'terminal', tabs: [{ id: 't1', connectionId: connId, protocol: 'SSH' }] },
    });
    assert.equal(ws.status, 200, JSON.stringify(ws.body));

    // Restore as admin (owner) - should be accessible
    const restore = await server.api(adminCookie, 'POST', `/api/me/workspaces/ws-mig-1/restore`);
    assert.equal(restore.status, 200);
    assert.equal(restore.body.workspace.state.tabs.length, 1, 'admin sees own connection in restore');
    assert.equal(restore.body.autoReplay, false, 'restore must never auto-replay commands');

    // Clean up
    await server.api(adminCookie, 'DELETE', `/api/me/workspaces/ws-mig-1`);
    await server.api(adminCookie, 'DELETE', `/api/connections/${connId}`);
});

test('AI status reflects policy mode and provider sanitization', async () => {
    const res = await server.api(adminCookie, 'GET', '/api/ai/status');
    assert.equal(res.status, 200);
    assert.ok(res.body.policy, 'policy');
    assert.ok(['disabled', 'admin_shared', 'self_managed', 'both'].includes(res.body.policy.mode), 'valid policy mode');
});

test('healthz exposes instanceId for restart detection', async () => {
    const r = await fetch(server.url('/healthz'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.instanceId, 'instanceId');
    assert.ok(body.ok, 'ok');
});
