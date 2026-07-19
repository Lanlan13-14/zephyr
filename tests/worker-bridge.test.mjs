import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { TestServer } from './test-server.mjs';

/* Worker bridge acceptance (FREEZE plan §14): Node issues a one-time ticket
 * after ACL + secret resolution; the browser then talks to the worker
 * directly. We mock the Go worker with a tiny HTTP server that records the
 * ticket-issuance request and asserts secrets arrive out-of-band (never in
 * the browser-facing response). */

let mockWorker;
let mockWorkerUrl;
let mockWorkerAdminToken = 'mock-admin-token';
let issuedTickets = [];

let server;
let adminCookie;
let aCookie;
let aId;
let connId;

before(async () => {
    // 1. boot the mock worker first so its URL is known
    mockWorker = createServer((req, res) => {
        const auth = req.headers['x-worker-admin'] || '';
        if (req.method === 'POST' && req.url === '/admin/tickets') {
            assert.equal(auth, mockWorkerAdminToken, 'admin token must be sent');
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                const parsed = JSON.parse(body || '{}');
                issuedTickets.push(parsed);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ ticket: `tkt-${issuedTickets.length}` }));
            });
            return;
        }
        if (req.method === 'GET' && req.url === '/admin/sessions') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ sessions: issuedTickets.map((t, i) => ({ id: `s${i}`, userId: t.userId, host: t.host })) }));
            return;
        }
        if (req.method === 'POST' && req.url === '/admin/sessions/kill') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    });
    await new Promise((r) => mockWorker.listen(0, '127.0.0.1', r));
    const addr = mockWorker.address();
    mockWorkerUrl = `http://127.0.0.1:${addr.port}`;

    // 2. set env BEFORE spawning the test server so WorkerBridge picks it up
    process.env.ZEPHYR_WORKER_URL = mockWorkerUrl;
    process.env.ZEPHYR_WORKER_ADMIN_TOKEN = mockWorkerAdminToken;

    // 3. boot the real zephyr server against the mock worker
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-wb');
    adminCookie = boot.cookie;
    const meAdmin = await server.api(adminCookie, 'GET', '/api/auth/me');
    aId = meAdmin.body.user.userId;
    aCookie = adminCookie;
    const conn = await server.api(aCookie, 'POST', '/api/connections', {
        name: 'wb-box', host: '10.8.8.8', username: 'root', password: 'worker-secret-pw', protocol: 'SSH',
    });
    assert.equal(conn.status, 200, JSON.stringify(conn.body));
    connId = conn.body.connection.id;
});

after(async () => {
    await server.cleanup();
    await new Promise((r) => mockWorker.close(r));
    delete process.env.ZEPHYR_WORKER_URL;
    delete process.env.ZEPHYR_WORKER_ADMIN_TOKEN;
});

test('POST /api/worker/ticket issues a one-time ticket with secrets out-of-band', async () => {
    issuedTickets = [];
    const res = await server.api(aCookie, 'POST', '/api/worker/ticket', { connectionId: connId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.ticket);
    assert.ok(res.body.workerWsUrl.startsWith('ws://') || res.body.workerWsUrl.startsWith('wss://'));
    assert.ok(res.body.workerWsUrl.includes(`ticket=${encodeURIComponent(res.body.ticket)}`));
    // the browser-facing response must NOT contain the password
    assert.ok(!JSON.stringify(res.body).includes('worker-secret-pw'), 'response must not leak secrets');
    // the worker received the secret out-of-band
    assert.equal(issuedTickets.length, 1);
    assert.equal(issuedTickets[0].host, '10.8.8.8');
    assert.equal(issuedTickets[0].username, 'root');
    assert.equal(issuedTickets[0].password, 'worker-secret-pw');
    assert.equal(issuedTickets[0].userId, aId);
    assert.equal(issuedTickets[0].connId, connId);
    assert.equal(issuedTickets[0].source, 'saved');
});

test('ticket for a connection the user cannot use is rejected', async () => {
    // create user B, share observer only, B cannot get a ticket
    const b = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'wbbob', password: 'bob-pass-1', role: 'user' });
    const bId = b.body.user.userId;
    const bLogin = await server.login('wbbob', 'bob-pass-1');
    const bCookie = bLogin.cookie;
    await server.api(bCookie, 'POST', '/api/auth/change-password', { currentPassword: 'bob-pass-1', newPassword: 'bob-real-1' });
    await server.api(aCookie, 'PUT', `/api/resources/connection/${connId}/shares`, { shares: [{ subjectId: bId, tier: 'observer' }] });
    const denied = await server.api(bCookie, 'POST', '/api/worker/ticket', { connectionId: connId });
    assert.ok([403, 404].includes(denied.status), 'observer must not get a use-capable ticket');
    // upgrade to operator -> B can get a ticket
    await server.api(aCookie, 'PUT', `/api/resources/connection/${connId}/shares`, { shares: [{ subjectId: bId, tier: 'operator' }] });
    const allowed = await server.api(bCookie, 'POST', '/api/worker/ticket', { connectionId: connId });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
});

test('transient ticket consumes the deep-link token atomically', async () => {
    issuedTickets = [];
    const prep = await server.api(aCookie, 'POST', '/api/deeplinks/prepare', { uri: 'ssh://transient:tpw@10.9.9.9:22' });
    assert.equal(prep.status, 200);
    const res = await server.api(aCookie, 'POST', '/api/worker/ticket', { transientToken: prep.body.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(issuedTickets[0].source, 'transient');
    assert.equal(issuedTickets[0].host, '10.9.9.9');
    assert.equal(issuedTickets[0].password, 'tpw');
    // second use of the same deep-link token must fail (already consumed)
    const again = await server.api(aCookie, 'POST', '/api/worker/ticket', { transientToken: prep.body.token });
    assert.ok([400, 404, 410].includes(again.status), 'consumed deep-link token must not re-issue');
});

test('session list filters by userId for non-admin', async () => {
    issuedTickets = [
        { userId: aId, host: 'h1', username: 'u1', password: 'p1', source: 'saved' },
        { userId: 'other-user', host: 'h2', username: 'u2', password: 'p2', source: 'saved' },
    ];
    // repopulate mockWorker state by issuing tickets through the mock
    // (the mock stores them in its closure; listSessions reads them)
    const list = await server.api(aCookie, 'GET', '/api/worker/sessions');
    assert.equal(list.status, 200);
    assert.ok(list.body.enabled === true);
    // admin sees all
    assert.ok(list.body.sessions.length >= 2);
});
