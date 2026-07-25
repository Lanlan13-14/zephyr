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
let peerWrites = [];

before(async () => {
    listenServer = net.createServer((sock) => {
        // Simple login script: prompt login → wait line → prompt password → wait line → shell
        let stage = 'login';
        let acc = '';
        sock.write(Buffer.from('login: '));
        sock.on('data', (chunk) => {
            peerWrites.push(Buffer.from(chunk));
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
    await server.cleanup();
    await new Promise((r) => listenServer.close(r));
});

function openWs(cookie) {
    return new WebSocket(server.url('/ssh').replace(/^http/, 'ws'), { headers: { Cookie: cookie } });
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
    peerWrites = [];
    const ws = openWs(adminCookie);
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
    assert.equal(ready.protocol, 'TELNET');
    const screen = await dataP;
    assert.match(screen, /login:/i);
    assert.match(screen, /Password:|\$/i);

    // Peer should have received username and password lines (after IAC negotiate).
    const all = Buffer.concat(peerWrites).toString('binary');
    assert.match(all, /root/);
    assert.match(all, /hunter2/);
    ws.close();
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

    peerWrites = [];
    const ws = openWs(adminCookie);
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
    await dataP;
    const all = Buffer.concat(peerWrites).toString('binary');
    assert.match(all, /admin/);
    assert.match(all, /pw-saved/);
    ws.close();
});
