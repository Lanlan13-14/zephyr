import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import ssh2 from 'ssh2';
import { TestServer } from './test-server.mjs';

const { Server: SshServer, utils: sshUtils } = ssh2;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/*
 * Direct SSH (connectionMode=direct, no jumpHostIds, no proxy) used to
 * handshake successfully and then crash on `null.name` while composing the
 * route label. createRoutedSSHConnection's catch tore the live client down,
 * so a connection that never configured a jump host could never stay up.
 *
 * These tests drive a real ssh2 server through the live TestServer so a
 * regression cannot hide behind a source-only assertion.
 */

let app;
let cookie;
let sshServer;
let sshPort;
let sshPrivateKey;
const sshClients = new Set();
const sshStreams = new Set();
let acceptedSessions = 0;

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServerBounded(target, label, timeoutMs = 3000) {
    if (!target) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            try { target.closeAllConnections?.(); } catch {}
            finish(new Error(`timeout closing ${label}`));
        }, timeoutMs);
        try { target.close(finish); } catch (error) { finish(error); }
    });
}

function destroyTracked(collection) {
    for (const resource of collection) {
        try { resource.end?.(); } catch {}
        try { resource.close?.(); } catch {}
        try { resource.destroy?.(); } catch {}
    }
    collection.clear();
}

function waitForOpen(ws, timeoutMs = 3000) {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const finish = (error) => {
            clearTimeout(timer);
            ws.off('open', onOpen);
            ws.off('error', onError);
            if (error) reject(error);
            else resolve();
        };
        const onOpen = () => finish();
        const onError = (error) => finish(error);
        const timer = setTimeout(() => finish(new Error('timeout waiting for websocket open')), timeoutMs);
        ws.once('open', onOpen);
        ws.once('error', onError);
    });
}

function waitFor(ws, type, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        const onMessage = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === 'error' && type !== 'error') {
                clearTimeout(timer);
                ws.off('message', onMessage);
                reject(new Error(msg.message || 'websocket error'));
                return;
            }
            if (msg.type !== type) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg);
        };
        ws.on('message', onMessage);
    });
}

function waitForClose(resource, label, timeoutMs = 5000) {
    if (!resource || resource.destroyed || resource.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const done = (error) => {
            clearTimeout(timer);
            resource.off?.('close', onClose);
            if (error) reject(error);
            else resolve();
        };
        const onClose = () => done();
        const timer = setTimeout(() => done(new Error(`timeout waiting for ${label} close`)), timeoutMs);
        resource.once('close', onClose);
    });
}

before(async () => {
    sshPrivateKey = sshUtils.generateKeyPairSync('ed25519').private;
    sshServer = new SshServer({ hostKeys: [sshPrivateKey] }, (client) => {
        sshClients.add(client);
        client.once('close', () => sshClients.delete(client));
        client.on('authentication', (ctx) => {
            if (ctx.method === 'password' && ctx.username === 'direct' && ctx.password === 'direct-pass') {
                ctx.accept();
                return;
            }
            ctx.reject();
        });
        client.on('ready', () => {
            acceptedSessions += 1;
            client.on('session', (accept) => {
                const session = accept();
                session.on('pty', (acceptPty) => acceptPty());
                session.on('shell', (acceptShell) => {
                    const stream = acceptShell();
                    sshStreams.add(stream);
                    stream.once('close', () => sshStreams.delete(stream));
                    stream.write('direct-ssh-ready\n');
                });
                session.on('exec', (acceptExec, rejectExec, info) => {
                    const stream = acceptExec();
                    sshStreams.add(stream);
                    stream.once('close', () => sshStreams.delete(stream));
                    stream.write(`ran:${info.command}\n`);
                    stream.exit(0);
                    stream.close();
                });
            });
        });
    });
    sshPort = await listen(sshServer);

    app = new TestServer();
    await app.start();
    cookie = (await app.bootstrapAdmin('admin-pass-direct-ssh')).cookie;
});

after(async () => {
    const failures = [];
    destroyTracked(sshStreams);
    destroyTracked(sshClients);
    try { await app?.cleanup(); } catch (error) { failures.push(error); }
    try { await closeServerBounded(sshServer, 'direct SSH server'); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'direct ssh fixture cleanup failed');
});

test('source no longer reads firstProxy.name on a missing hop', () => {
    const server = read('server.js');
    assert.match(server, /function describeRoutedPath\(/);
    assert.match(server, /function describeFirstHop\(/);
    assert.match(server, /describeRoutedPath\(plan\.firstProxy, conn\.name \|\| conn\.host\)/);
    // The crash was this unguarded ternary: when firstProxy is null the
    // false branch still evaluated `plan.firstProxy.name`.
    assert.doesNotMatch(
        server,
        /: `代理 \$\{plan\.firstProxy\.name \|\| plan\.firstProxy\.host\}`/,
        'unguarded firstProxy.name label must not return',
    );
    assert.match(read('resource-service.js'), /if \(!jumpIds\.length\) throw new HttpError\(400, 'invalid_dependency', '跳板机不能为空'/);
    const appJs = read('public/app.js');
    assert.match(appJs, /function assertConnectionRouteComplete\(payload\)/);
    assert.match(appJs, /payload\.connectionMode === 'jump' && !\(payload\.jumpHostIds \|\| \[\]\)\.length/);
});

test('describeRoutedPath keeps a direct connection as a bare label', () => {
    const firstHop = (firstProxy) => {
        if (!firstProxy) return '';
        if (firstProxy.type === 'agent') return `Agent 跳板 ${firstProxy.name || firstProxy.agentId}`;
        return `代理 ${firstProxy.name || firstProxy.host}`;
    };
    const routed = (firstProxy, targetLabel) => {
        const prefix = firstHop(firstProxy);
        const label = targetLabel || '';
        return prefix ? `${prefix} -> ${label}` : label;
    };
    assert.equal(routed(null, 'lab-ssh'), 'lab-ssh');
    assert.equal(routed(undefined, 'lab-ssh'), 'lab-ssh');
    assert.equal(routed({ type: 'agent', name: 'phone', agentId: 'a1' }, 'lab-ssh'), 'Agent 跳板 phone -> lab-ssh');
    assert.equal(routed({ type: 'socks5', name: 'office', host: '10.0.0.1' }, 'lab-ssh'), '代理 office -> lab-ssh');
    assert.throws(() => { void (null.name); }, TypeError);
});

test('saving a jump route with no hops is refused', async () => {
    const saved = await app.api(cookie, 'POST', '/api/connections', {
        name: 'empty-jump-refused', host: '10.10.0.21', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'jump', jumpHostIds: [],
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.code, 'invalid_dependency');
    assert.match(String(saved.body.error), /跳板机不能为空/);
});

test('saving a proxy route with no proxy is refused', async () => {
    const saved = await app.api(cookie, 'POST', '/api/connections', {
        name: 'empty-proxy-refused', host: '10.10.0.22', port: 22, protocol: 'SSH',
        username: 'root', password: 'target-pass',
        connectionMode: 'proxy',
    });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.code, 'invalid_dependency');
});

test('direct SSH test succeeds without any jump host', async () => {
    const created = await app.api(cookie, 'POST', '/api/connections', {
        name: 'lab-direct-ssh',
        protocol: 'SSH',
        host: '127.0.0.1',
        port: sshPort,
        username: 'direct',
        password: 'direct-pass',
        connectionMode: 'direct',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.connection.connectionMode, 'direct');
    assert.deepEqual(created.body.connection.jumpHostIds || [], []);

    const tested = await app.api(cookie, 'POST', '/api/connections/test', {
        connectionId: created.body.connection.id,
        timeoutSeconds: 5,
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
    assert.equal(tested.body.code, 'success');
    assert.match(String(tested.body.message), /lab-direct-ssh|连接成功/);
    assert.doesNotMatch(String(tested.body.message), /Cannot read properties of null/);
    assert.doesNotMatch(String(tested.body.message), /未配置跳板机/);
});

test('direct SSH live session reaches ready without a jump host', async () => {
    const created = await app.api(cookie, 'POST', '/api/connections', {
        name: 'lab-direct-live',
        protocol: 'SSH',
        host: '127.0.0.1',
        port: sshPort,
        username: 'direct',
        password: 'direct-pass',
        connectionMode: 'direct',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const before = acceptedSessions;
    const ws = new WebSocket(app.url('/ssh').replace(/^http/, 'ws'), { headers: { Cookie: cookie } });
    try {
        await waitForOpen(ws);
        const readyPending = waitFor(ws, 'ready');
        ws.send(JSON.stringify({
            type: 'connect',
            connectionId: created.body.connection.id,
            sessionId: `direct-live-${Date.now()}`,
            cols: 80,
            rows: 24,
        }));
        const ready = await readyPending;
        assert.equal(ready.type, 'ready');
        assert.ok(ready.sessionId);
        assert.ok(acceptedSessions > before, 'the mock SSH server must have accepted the session');
        ws.send(JSON.stringify({ type: 'disconnect' }));
        await waitForClose(ws, 'direct ssh websocket');
    } finally {
        if (ws.readyState !== WebSocket.CLOSED) {
            try { ws.terminate(); } catch {}
            await waitForClose(ws, 'forced direct ssh websocket', 1000).catch(() => {});
        }
    }
});

test('an unset jumpHostIds field still tests as a direct SSH connection', async () => {
    const tested = await app.api(cookie, 'POST', '/api/connections/test', {
        name: 'draft-direct',
        protocol: 'SSH',
        host: '127.0.0.1',
        port: sshPort,
        username: 'direct',
        password: 'direct-pass',
        connectionMode: 'direct',
        timeoutSeconds: 5,
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
    assert.doesNotMatch(String(tested.body.message), /Cannot read properties of null/);
});
