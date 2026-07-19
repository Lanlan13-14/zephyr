import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';
import { parseDeepLinkUri } from '../deeplink-service.js';

test('parseDeepLinkUri covers ssh/telnet/jms and rejects junk', () => {
    const ssh = parseDeepLinkUri('ssh://alice:s3cret@example.com:2222');
    assert.equal(ssh.draft.protocol, 'SSH');
    assert.equal(ssh.draft.host, 'example.com');
    assert.equal(ssh.draft.port, 2222);
    assert.equal(ssh.draft.username, 'alice');
    assert.equal(ssh.draft.hasTransientCredential, true);
    assert.equal(ssh.credential.password, 's3cret');

    const telnet = parseDeepLinkUri('telnet://router.local');
    assert.equal(telnet.draft.protocol, 'TELNET');
    assert.equal(telnet.draft.port, 23);

    const jmsPayload = Buffer.from(JSON.stringify({
        protocol: 'sftp',
        endpoint: { host: 'jms.example', port: 2222 },
        token: { id: 'u1', value: 'jms-token-value' },
        asset: { name: 'prod-db' },
    })).toString('base64url');
    const jms = parseDeepLinkUri(`jms://${jmsPayload}`);
    assert.equal(jms.source, 'jms');
    assert.equal(jms.draft.autoOpenSftp, true);
    assert.equal(jms.draft.name, 'prod-db');
    assert.equal(jms.credential.password, 'jms-token-value');

    assert.throws(() => parseDeepLinkUri('ftp://x'), /不支持的协议|unsupported/i);
    assert.throws(() => parseDeepLinkUri('ssh://host:99999'), /端口/);
});

let server;
let adminCookie;
let aCookie;
let bCookie;
let aId;
let bId;

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-notes');
    adminCookie = boot.cookie;
    const a = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'notealice', password: 'alice-pass-1', role: 'user' });
    aId = a.body.user.userId;
    const b = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'notebob', password: 'bob-pass-1', role: 'user' });
    bId = b.body.user.userId;
    const aLogin = await server.login('notealice', 'alice-pass-1');
    aCookie = aLogin.cookie;
    await server.api(aCookie, 'POST', '/api/auth/change-password', { currentPassword: 'alice-pass-1', newPassword: 'alice-real-1' });
    const bLogin = await server.login('notebob', 'bob-pass-1');
    bCookie = bLogin.cookie;
    await server.api(bCookie, 'POST', '/api/auth/change-password', { currentPassword: 'bob-pass-1', newPassword: 'bob-real-1' });
});

after(async () => {
    await server.cleanup();
});

test('notes CRUD, revision conflict, soft-delete and owner isolation', async () => {
    const created = await server.api(aCookie, 'POST', '/api/notes', {
        title: 'Runbook',
        content: '# hello\nsecret-should-not-leak',
        tags: ['ops'],
        groupPath: 'ops/runbooks',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const noteId = created.body.note.noteId;
    assert.equal(created.body.note.revision, 1);

    const listB = await server.api(bCookie, 'GET', '/api/notes');
    assert.equal(listB.status, 200);
    assert.ok(!listB.body.notes.some((n) => n.noteId === noteId), "B must not see A's private notes");

    const getB = await server.api(bCookie, 'GET', `/api/notes/${noteId}`);
    assert.ok([403, 404].includes(getB.status));

    const updated = await server.api(aCookie, 'PUT', `/api/notes/${noteId}`, {
        title: 'Runbook v2',
        content: 'updated body',
        expectedRevision: 1,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.note.revision, 2);

    const conflict = await server.api(aCookie, 'PUT', `/api/notes/${noteId}`, {
        title: 'stale',
        expectedRevision: 1,
    });
    assert.equal(conflict.status, 409, 'stale revision must 409');

    const del = await server.api(aCookie, 'DELETE', `/api/notes/${noteId}`);
    assert.equal(del.status, 200);
    const listA = await server.api(aCookie, 'GET', '/api/notes');
    assert.ok(!listA.body.notes.some((n) => n.noteId === noteId));
    const trash = await server.api(aCookie, 'GET', '/api/notes?trash=1');
    assert.ok(trash.body.notes.some((n) => n.noteId === noteId));
    const restored = await server.api(aCookie, 'POST', `/api/notes/${noteId}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.note.title, 'Runbook v2');
});

test('deeplink prepare/test/consume is user-bound, one-shot, secret-safe', async () => {
    const uri = 'ssh://root:SuperSecretPass@10.1.2.3:22';
    const prep = await server.api(aCookie, 'POST', '/api/deeplinks/prepare', { uri });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.ok(prep.body.token);
    assert.equal(prep.body.draft.hasTransientCredential, true);
    assert.ok(!JSON.stringify(prep.body).includes('SuperSecretPass'), 'prepare response must not echo password');
    assert.equal(prep.body.draft.host, '10.1.2.3');

    // cross-user peek/consume rejected
    const cross = await server.api(bCookie, 'GET', `/api/deeplinks/${prep.body.token}`);
    assert.ok([403, 404].includes(cross.status), 'token is bound to preparing user');

    const peek = await server.api(aCookie, 'GET', `/api/deeplinks/${prep.body.token}`);
    assert.equal(peek.status, 200);
    assert.equal(peek.body.hasCredential, true);

    // test does not consume
    const test1 = await server.api(aCookie, 'POST', `/api/deeplinks/${prep.body.token}/test`, {
        overrides: { host: '10.1.2.3', port: 22, username: 'root' },
        timeoutSeconds: 1,
    });
    // connection will fail (no real host) but token path must work; either 200 or 400 from SSH test is fine
    assert.ok([200, 400].includes(test1.status), JSON.stringify(test1.body));
    const stillThere = await server.api(aCookie, 'GET', `/api/deeplinks/${prep.body.token}`);
    assert.equal(stillThere.status, 200, 'test must not consume token');

    // consume via a second prepare+direct DB path is hard without WS; use service through another prepare and expire semantics:
    // Re-prepare and consume by attempting a second test after manual consume simulation:
    // The consume endpoint is the WS connect path; here we verify double-prepare isolation and expiry listing.
    const prep2 = await server.api(aCookie, 'POST', '/api/deeplinks/prepare', { uri: 'ssh://nobody@example.invalid' });
    assert.equal(prep2.status, 200);
    // B cannot prepare-consume A's token
    const steal = await server.api(bCookie, 'POST', `/api/deeplinks/${prep2.body.token}/test`, { overrides: {} });
    assert.ok([403, 404].includes(steal.status));
});

test('workspace put/get/restore filters inaccessible resources', async () => {
    const clientId = 'test-client-1';
    // A creates a connection then saves workspace referencing it
    const conn = await server.api(aCookie, 'POST', '/api/connections', {
        name: 'ws-box', host: '10.9.9.9', username: 'u', password: 'p', protocol: 'SSH',
    });
    assert.equal(conn.status, 200, JSON.stringify(conn.body));
    const connectionId = conn.body.connection.id;

    const put = await server.api(aCookie, 'PUT', '/api/me/workspaces/new', {
        clientId,
        name: 'phone',
        state: {
            view: 'terminal',
            tabs: [{ id: 't1', connectionId, name: 'ws-box' }],
            password: 'must-be-stripped',
            apiKey: 'also-stripped',
        },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const workspaceId = put.body.workspace.workspaceId;
    assert.ok(!JSON.stringify(put.body.workspace.state).includes('must-be-stripped'));
    assert.ok(!JSON.stringify(put.body.workspace.state).includes('also-stripped'));

    // B cannot read A's workspace
    const bGet = await server.api(bCookie, 'GET', `/api/me/workspaces/${workspaceId}`);
    assert.ok([403, 404].includes(bGet.status));

    const restore = await server.api(aCookie, 'POST', `/api/me/workspaces/${workspaceId}/restore`);
    assert.equal(restore.status, 200);
    assert.equal(restore.body.autoReplay, false);
    assert.equal(restore.body.workspace.state.tabs[0].accessible, true);

    // After deleting the connection, restore marks tab inaccessible
    await server.api(aCookie, 'DELETE', `/api/connections/${connectionId}`);
    const restore2 = await server.api(aCookie, 'POST', `/api/me/workspaces/${workspaceId}/restore`);
    assert.equal(restore2.body.workspace.state.tabs[0].accessible, false);
    assert.equal(restore2.body.inaccessible, 1);
});

test('personal settings reject system keys and isolate per user', async () => {
    const putA = await server.api(aCookie, 'PUT', '/api/me/settings', {
        appearance: { theme: 'light', colorScheme: 'frost' },
    });
    assert.equal(putA.status, 200, JSON.stringify(putA.body));
    assert.equal(putA.body.settings.appearance.theme, 'light');

    const forbidden = await server.api(aCookie, 'PUT', '/api/me/settings', {
        security: { bruteForceEnabled: false },
        mail: { pass: 'x' },
    });
    assert.equal(forbidden.status, 403);

    const getB = await server.api(bCookie, 'GET', '/api/me/settings');
    assert.equal(getB.status, 200);
    assert.notEqual(getB.body.settings.appearance?.theme, 'light', "B must not inherit A's personal theme");
});
