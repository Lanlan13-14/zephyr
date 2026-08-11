/**
 * Phase 2: Telnet in-band auto-login.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import {
    createTelnetAutoLogin,
} from '../telnet-transport.js';
const { TestServer } = await import('./test-server.mjs');

test('createTelnetAutoLogin feeds username then password on prompts', () => {
    const written = [];
    const al = createTelnetAutoLogin({
        write: (s) => written.push(String(s)),
        username: 'admin',
        password: 's3cret',
        timeoutMs: 2000,
    });
    al.feed('Welcome\r\nlogin: ');
    assert.deepEqual(written, ['admin\r\n']);
    assert.equal(al.state, 'wait-password');
    al.feed('Password: ');
    assert.deepEqual(written, ['admin\r\n', 's3cret\r\n']);
    assert.equal(al.state, 'ok');
});

test('createTelnetAutoLogin matches prompts across chunks', () => {
    const written = [];
    const al = createTelnetAutoLogin({
        write: (s) => written.push(String(s)),
        username: 'u',
        password: 'p',
        timeoutMs: 2000,
    });
    al.feed('use');
    al.feed('rname: ');
    assert.deepEqual(written, ['u\r\n']);
    al.feed('pass');
    al.feed('word: ');
    assert.deepEqual(written, ['u\r\n', 'p\r\n']);
});

test('createTelnetAutoLogin is idle without credentials', () => {
    const written = [];
    const al = createTelnetAutoLogin({ write: (s) => written.push(s), username: '', password: '' });
    al.feed('login: ');
    assert.equal(written.length, 0);
    assert.equal(al.state, 'idle');
});

test('createTelnetAutoLogin times out without prompt', async () => {
    let done = null;
    const al = createTelnetAutoLogin({
        write: () => {},
        username: 'x',
        password: 'y',
        timeoutMs: 40,
        onDone: (r) => { done = r; },
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(done, 'timeout');
    assert.equal(al.state, 'timeout');
});

// ------------------------- live integration -------------------------

let server;
let adminCookie;
let listenServer;
let listenPort;
const telnetPeers = new Map();
const telnetPeerHistory = new Set();
const webSockets = new Set();
const webSocketErrors = new WeakMap();

function trackTelnetPeer(socket) {
    const peer = {
        socket,
        writes: [],
        closed: false,
        expectedPeerReset: false,
        errors: [],
        checkedErrors: 0,
    };
    telnetPeers.set(socket, peer);
    telnetPeerHistory.add(peer);
    socket.on('error', (error) => {
        peer.errors.push({
            error,
            expected: peer.expectedPeerReset && error?.code === 'ECONNRESET',
        });
    });
    socket.once('close', () => {
        peer.closed = true;
        telnetPeers.delete(socket);
    });
    return peer;
}

function activeTelnetPeer() {
    assert.equal(telnetPeers.size, 1, 'exactly one TELNET fixture peer should be active');
    return telnetPeers.values().next().value;
}

function waitForClose(resource, label, timeoutMs = 3000) {
    if (!resource || resource.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resource.off?.('close', onClose);
            if (error) reject(error);
            else resolve();
        };
        const onClose = () => finish();
        const timer = setTimeout(() => finish(new Error(`timeout waiting for ${label} close`)), timeoutMs);
        resource.once('close', onClose);
    });
}

function waitForPeerClose(peer, timeoutMs = 3000) {
    if (!peer || peer.closed) return Promise.resolve();
    return waitForClose(peer.socket, 'TELNET fixture peer', timeoutMs);
}

function throwPeerErrors(peer) {
    if (!peer) return;
    const unchecked = peer.errors.slice(peer.checkedErrors);
    peer.checkedErrors = peer.errors.length;
    const unexpected = unchecked.filter((entry) => !entry.expected).map((entry) => entry.error);
    if (unexpected.length) throw new AggregateError(unexpected, 'TELNET fixture peer failed');
}

function throwWebSocketErrors(ws) {
    const errors = webSocketErrors.get(ws) || [];
    if (errors.length) throw new AggregateError(errors, 'TELNET websocket failed');
}

function peerText(peer) {
    return Buffer.concat(peer?.writes || []).toString('binary');
}

function waitForPeerText(peer, pattern, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            peer.socket.off('data', onData);
            peer.socket.off('close', onClose);
            if (error) reject(error);
            else resolve(value);
        };
        const check = () => {
            const value = peerText(peer);
            if (pattern.test(value)) finish(null, value);
        };
        const onData = () => check();
        const onClose = () => finish(new Error(`TELNET fixture peer closed before receiving ${pattern}`));
        const timer = setTimeout(
            () => finish(new Error(`timeout waiting for TELNET fixture peer to receive ${pattern}`)),
            timeoutMs,
        );
        peer.socket.on('data', onData);
        peer.socket.once('close', onClose);
        check();
    });
}

async function disconnectAndWait(ws, peer) {
    const failures = [];
    if (peer) peer.expectedPeerReset = true;
    const closed = Promise.all([
        waitForClose(ws, 'TELNET websocket'),
        waitForPeerClose(peer),
    ]);

    try {
        if (ws?.readyState === WebSocket.OPEN) {
            await new Promise((resolve, reject) => {
                ws.send(JSON.stringify({ type: 'disconnect' }), (error) => (error ? reject(error) : resolve()));
            });
        } else if (ws && ws.readyState !== WebSocket.CLOSED) {
            ws.terminate();
        }
        await closed;
    } catch (error) {
        closed.catch(() => {});
        failures.push(error);
        try { ws?.terminate(); } catch {}
        try { peer?.socket.destroy(); } catch {}
    }

    try { throwPeerErrors(peer); } catch (error) { failures.push(error); }
    try { throwWebSocketErrors(ws); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'TELNET auto-login cleanup failed');
}

before(async () => {
    listenServer = net.createServer((sock) => {
        const peer = trackTelnetPeer(sock);
        // Simple login script: prompt login → wait line → prompt password → wait line → shell
        let stage = 'login';
        let acc = '';
        sock.write(Buffer.from('login: '));
        sock.on('data', (chunk) => {
            peer.writes.push(Buffer.from(chunk));
            // strip IAC for stage machine simplicity
            let text = '';
            for (let i = 0; i < chunk.length; i++) {
                if (chunk[i] === 255) {
                    const cmd = chunk[i + 1];
                    if (cmd === 250) {
                        while (i < chunk.length - 1 && !(chunk[i] === 255 && chunk[i + 1] === 240)) i++;
                        i += 1;
                    } else i += 2;
                    continue;
                }
                text += String.fromCharCode(chunk[i]);
            }
            acc += text;
            if (stage === 'login' && acc.includes('\n')) {
                acc = '';
                stage = 'password';
                sock.write(Buffer.from('Password: '));
            } else if (stage === 'password' && acc.includes('\n')) {
                acc = '';
                stage = 'shell';
                sock.write(Buffer.from('\r\n$ '));
            } else if (stage === 'shell') {
                // echo
                if (text) sock.write(Buffer.from(text, 'binary'));
            }
        });
    });
    await new Promise((r) => listenServer.listen(0, '127.0.0.1', r));
    listenPort = listenServer.address().port;

    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-autologin');
    adminCookie = boot.cookie;
});

after(async () => {
    const failures = [];
    const remainingPeers = [...telnetPeers.values()];
    for (const peer of remainingPeers) peer.expectedPeerReset = true;
    for (const ws of [...webSockets]) {
        try {
            await disconnectAndWait(ws, remainingPeers.length === 1 ? remainingPeers[0] : undefined);
        } catch (error) {
            failures.push(error);
        }
    }
    try { await server.cleanup(); } catch (error) { failures.push(error); }
    for (const peer of remainingPeers) {
        try { await waitForPeerClose(peer); } catch (error) { failures.push(error); }
    }
    for (const peer of telnetPeerHistory) {
        try { throwPeerErrors(peer); } catch (error) { failures.push(error); }
    }
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout closing TELNET fixture server')), 3000);
            listenServer.close((error) => {
                clearTimeout(timer);
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                else resolve();
            });
        });
    } catch (error) {
        failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'TELNET auto-login fixture cleanup failed');
});

function openWs(cookie) {
    const ws = new WebSocket(server.url('/ssh').replace(/^http/, 'ws'), { headers: { Cookie: cookie } });
    const errors = [];
    webSockets.add(ws);
    webSocketErrors.set(ws, errors);
    ws.on('error', (error) => errors.push(error));
    ws.once('close', () => webSockets.delete(ws));
    return ws;
}

function waitFor(ws, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        const onMsg = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === type) {
                clearTimeout(timer);
                ws.off('message', onMsg);
                resolve(msg);
            } else if (msg.type === 'error' && type !== 'error') {
                clearTimeout(timer);
                ws.off('message', onMsg);
                reject(new Error(msg.message || 'error'));
            }
        };
        ws.on('message', onMsg);
    });
}

function collectData(ws, ms = 600) {
    return new Promise((resolve) => {
        const bag = [];
        const onMsg = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === 'data') bag.push(msg.data);
        };
        ws.on('message', onMsg);
        setTimeout(() => {
            ws.off('message', onMsg);
            resolve(bag.join(''));
        }, ms);
    });
}

test('WS auto-login sends username+password into telnet peer', async () => {
    const ws = openWs(adminCookie);
    let peer;
    try {
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const dataP = collectData(ws, 800);
        const readyP = waitFor(ws, 'ready');
        ws.send(JSON.stringify({
            type: 'connect',
            protocol: 'TELNET',
            host: '127.0.0.1',
            port: listenPort,
            username: 'root',
            password: 'hunter2',
            cols: 80,
            rows: 24,
            sessionId: `autologin-${Date.now()}`,
        }));
        const ready = await readyP;
        peer = activeTelnetPeer();
        assert.equal(ready.protocol, 'TELNET');
        const screen = await dataP;
        assert.match(screen, /login:/i);
        assert.match(screen, /Password:|\$/i);

        // Peer should have received username and password lines (after IAC negotiate).
        const all = await waitForPeerText(peer, /hunter2/);
        assert.match(all, /root/);
    } finally {
        await disconnectAndWait(ws, peer);
    }
});

test('saved TELNET connection keeps password for auto-login', async () => {
    const created = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'telnet-with-pass',
        host: '127.0.0.1',
        port: listenPort,
        protocol: 'TELNET',
        username: 'admin',
        password: 'pw-saved',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    // API masks password in response but hasPassword should be true if field exists.
    const id = created.body.connection.id;
    assert.ok(id);

    const ws = openWs(adminCookie);
    let peer;
    try {
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const dataP = collectData(ws, 900);
        ws.send(JSON.stringify({
            type: 'connect',
            connectionId: id,
            sessionId: `autologin-saved-${Date.now()}`,
            cols: 80,
            rows: 24,
        }));
        await waitFor(ws, 'ready');
        peer = activeTelnetPeer();
        await dataP;
        const all = await waitForPeerText(peer, /pw-saved/);
        assert.match(all, /admin/);
    } finally {
        await disconnectAndWait(ws, peer);
    }
});
