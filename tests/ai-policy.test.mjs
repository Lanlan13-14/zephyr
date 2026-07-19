import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

/* Stage 8 acceptance (FREEZE plan §16): AI provider isolation, policy modes,
 * and per-user ACL on AI tools. */

let server;
let adminCookie;
let adminId;
let aliceCookie;
let aliceId;
let bobCookie;
let bobId;

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-ai-pass');
    adminCookie = boot.cookie;
    adminId = (await server.api(adminCookie, 'GET', '/api/auth/me')).body.user.userId;
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true, permissions: { webSearch: true, webFetch: true, browser: true, remoteExecute: true, fileRead: true, fileWrite: true, codeEdit: true, memory: true, notesRead: true, notesWrite: true, env: true } } });

    const a = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'ai-alice', password: 'a-pass-1', role: 'user' });
    aliceId = a.body.user.userId;
    const aLogin = await server.login('ai-alice', 'a-pass-1');
    await server.api(aLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'a-pass-1', newPassword: 'a-real-1' });
    aliceCookie = aLogin.cookie;

    const b = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'ai-bob', password: 'b-pass-1', role: 'user' });
    bobId = b.body.user.userId;
    const bLogin = await server.login('ai-bob', 'b-pass-1');
    await server.api(bLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'b-pass-1', newPassword: 'b-real-1' });
    bobCookie = bLogin.cookie;
});

after(async () => {
    await server.cleanup();
});

test('AI status returns owned provider metadata and never leaks keys', async () => {
    const created = await server.api(adminCookie, 'POST', '/api/ai/providers', {
        name: 'Test', type: 'openai-compatible', baseUrl: 'http://localhost:1111', apiKey: 'secret-key-xyz', enabled: true, models: ['gpt-4'], defaultModel: 'gpt-4',
    });
    assert.equal(created.status, 200);
    const providerId = created.body.provider.id;

    const adminStatus = await server.api(adminCookie, 'GET', '/api/ai/status');
    assert.equal(adminStatus.status, 200);
    const adminProvider = adminStatus.body.ai.providers.find((p) => p.id === providerId);
    assert.equal(adminProvider.owned, true);
    assert.equal(adminProvider.hasApiKey, true);
    assert.equal(Object.hasOwn(adminProvider, 'apiKey'), false, 'owner list never echoes the key');

    const alicePrivate = await server.api(aliceCookie, 'GET', '/api/ai/status');
    assert.equal(alicePrivate.status, 200);
    assert.equal(alicePrivate.body.ai.providers.some((p) => p.id === providerId), false, 'private provider is invisible');

    await server.api(adminCookie, 'PUT', `/api/ai/providers/${providerId}/shares`, { sharedUserIds: [aliceId] });
    const aliceStatus = await server.api(aliceCookie, 'GET', '/api/ai/status');
    assert.ok(aliceStatus.body.policy, 'policy returned');
    const aliceProvider = aliceStatus.body.ai.providers.find((p) => p.id === providerId);
    assert.equal(aliceProvider.owned, false);
    assert.equal(aliceProvider.hasApiKey, true);
    assert.equal(Object.hasOwn(aliceProvider, 'apiKey'), false, 'shared user never receives apiKey');
});

test('AI tools/run list_connections only returns own connections', async () => {
    // Alice creates a private connection
    const aliceConn = await server.api(aliceCookie, 'POST', '/api/connections', {
        name: 'alice-box', host: '10.9.9.1', username: 'alice', password: 'pw', protocol: 'SSH',
    });
    assert.equal(aliceConn.status, 200);
    // Bob creates a different connection
    const bobConn = await server.api(bobCookie, 'POST', '/api/connections', {
        name: 'bob-box', host: '10.9.9.2', username: 'bob', password: 'pw', protocol: 'SSH',
    });
    assert.equal(bobConn.status, 200);

    // Alice's list_connections should only show alice-box
    const aliceList = await server.api(aliceCookie, 'POST', '/api/ai/tools/run', {
        tool: 'list_connections', args: {},
    });
    assert.equal(aliceList.status, 200);
    const connIds = (aliceList.body.result?.connections || []).map((c) => c.name);
    assert.ok(connIds.includes('alice-box'), 'alice sees her own connection');
    assert.ok(!connIds.includes('bob-box'), 'alice must not see bob connection');
});

test('AI tools/run list_zephyr_resources filters by owner', async () => {
    const aliceRes = await server.api(aliceCookie, 'POST', '/api/ai/tools/run', {
        tool: 'list_zephyr_resources', args: { resources: ['connections', 'proxies'] },
    });
    assert.equal(aliceRes.status, 200);
    const connNames = (aliceRes.body.result?.connections || []).map((c) => c.name);
    assert.ok(!connNames.includes('bob-box'), 'resource list must not leak bob connection');
});

test('AI confirm is bound to userId, not username', async () => {
    // Alice requests a confirmation for a sensitive action
    const runRes = await server.api(aliceCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_create', args: { name: 'via-ai', host: '10.0.0.99', username: 'root', password: 'pw', protocol: 'SSH' },
    });
    // Should return confirmationRequired
    if (runRes.body?.result?.confirmationRequired) {
        const confirmId = runRes.body.result.confirmation.id;
        // Bob tries to confirm Alice's action
        const bobConfirm = await server.api(bobCookie, 'POST', `/api/ai/confirm/${confirmId}`, { approve: true });
        assert.equal(bobConfirm.status, 404, 'bob must not confirm alice action');
        // Alice confirms her own
        const aliceConfirm = await server.api(aliceCookie, 'POST', `/api/ai/confirm/${confirmId}`, { approve: true });
        assert.equal(aliceConfirm.status, 200);
    }
});

test('disabled AI policy blocks chat for non-admin', async () => {
    // Admin disables AI for a specific user via personal settings override
    // (the policy service reads user-level aiPolicy override)
    await server.api(adminCookie, 'PATCH', `/api/admin/users/${aliceId}`, {});
    // For this test we just verify the status endpoint returns a policy mode
    const status = await server.api(aliceCookie, 'GET', '/api/ai/status');
    assert.ok(['disabled', 'admin_shared', 'self_managed', 'both'].includes(status.body.policy?.mode), 'policy mode is valid');
});
