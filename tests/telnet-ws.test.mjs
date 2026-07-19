import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
const { TestServer } = await import('./test-server.mjs');

let server;
let adminCookie;
let listenServer;
let listenPort;
let lastPayload = '';

before(async () => {
    // Minimal "telnet-ish" TCP server: echo printable bytes, drop IAC blobs.
    listenServer = net.createServer((sock) => {
        sock.write(Buffer.from('login: '));
        sock.on('data', (chunk) => {
            lastPayload += chunk.toString('binary');
            // Echo non-IAC bytes so the client sees something.
            let out = '';
            for (let i = 0; i < chunk.length; i++) {
                if (chunk[i] === 255) {
                    // skip IAC cmd (+opt if 3-byte)
                    const cmd = chunk[i + 1];
                    if (cmd === 250 /* SB */) {
                        while (i < chunk.length - 1 && !(chunk[i] === 255 && chunk[i + 1] === 240)) i++;
                        i += 1;
                    } else {
                        i += 2;
                    }
                    continue;
                }
                out += String.fromCharCode(chunk[i]);
            }
            if (out) sock.write(Buffer.from(out, 'binary'));
        });
    });
    await new Promise((r) => listenServer.listen(0, '127.0.0.1', r));
    listenPort = listenServer.address().port;

    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-telnet-ws');
    adminCookie = boot.cookie;
});

after(async () => {
    await server.cleanup();
    await new Promise((r) => listenServer.close(r));
});

function openWs(cookie) {
    const url = server.url('/ssh').replace(/^http/, 'ws');
    return new WebSocket(url, {
        headers: { Cookie: cookie },
    });
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
            } else if (msg.type === 'error') {
                clearTimeout(timer);
                ws.off('message', onMsg);
                reject(new Error(msg.message || 'error'));
            }
        };
        ws.on('message', onMsg);
    });
}

test('WS /ssh connects a TELNET target and pumps data both ways', async () => {
    lastPayload = '';
    const ws = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    const readyP = waitFor(ws, 'ready');
    ws.send(JSON.stringify({
        type: 'connect',
        protocol: 'TELNET',
        host: '127.0.0.1',
        port: listenPort,
        username: '',
        cols: 80,
        rows: 24,
        sessionId: `telnet-ws-${Date.now()}`,
    }));
    const ready = await readyP;
    assert.equal(ready.protocol, 'TELNET');
    assert.match(ready.warning || '', /未加密|unencrypted|cleartext/i);

    // Server should have already sent "login: "
    const loginPrompt = await waitFor(ws, 'data');
    assert.match(loginPrompt.data, /login:/);

    // Client input should reach the TCP peer (after negotiation bytes).
    ws.send(JSON.stringify({ type: 'input', data: 'root\n' }));
    const echoed = await waitFor(ws, 'data');
    assert.match(echoed.data, /root/);

    // Resize should emit NAWS (IAC SB 31 ...)
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(lastPayload.includes(String.fromCharCode(255, 250, 31)) || lastPayload.includes('\xff\xfa\x1f'), 'NAWS should be sent');

    ws.close();
});

test('saved TELNET connection can open through /api/connections + WS', async () => {
    const created = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'saved-telnet',
        host: '127.0.0.1',
        port: listenPort,
        protocol: 'TELNET',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.connection.id;

    const ws = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    const readyP = waitFor(ws, 'ready');
    ws.send(JSON.stringify({
        type: 'connect',
        connectionId: id,
        sessionId: `telnet-saved-${Date.now()}`,
        cols: 80,
        rows: 24,
    }));
    const ready = await readyP;
    assert.equal(ready.protocol, 'TELNET');
    const prompt = await waitFor(ws, 'data');
    assert.match(prompt.data, /login:/);
    ws.close();
});
