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
const telnetPeers = new Map();
const telnetPeerHistory = new Set();
const webSocketErrors = new WeakMap();

function trackTelnetPeer(socket) {
    const peer = {
        socket,
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
        const timer = setTimeout(() => finish(new Error('timeout waiting for TELNET websocket open')), timeoutMs);
        ws.once('open', onOpen);
        ws.once('error', onError);
    });
}

async function disconnectAndWait(ws, peer) {
    const failures = [];
    if (peer) peer.expectedPeerReset = true;

    const closed = Promise.all([waitForClose(ws, 'TELNET websocket'), waitForPeerClose(peer)]);
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
        try {
            ws?.terminate();
        } catch {}
        try {
            peer?.socket.destroy();
        } catch {}
    }

    try {
        throwPeerErrors(peer);
    } catch (error) {
        failures.push(error);
    }
    try {
        throwWebSocketErrors(ws);
    } catch (error) {
        failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'TELNET websocket cleanup failed');
}

before(async () => {
    // Minimal "telnet-ish" TCP server: echo printable bytes, drop IAC blobs.
    listenServer = net.createServer((sock) => {
        trackTelnetPeer(sock);
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
    const failures = [];
    const remainingPeers = [...telnetPeers.values()];
    for (const peer of remainingPeers) peer.expectedPeerReset = true;
    try {
        await server.cleanup();
    } catch (error) {
        failures.push(error);
    }
    for (const peer of remainingPeers) {
        try {
            await waitForPeerClose(peer);
        } catch (error) {
            failures.push(error);
        }
    }
    for (const peer of telnetPeerHistory) {
        try {
            throwPeerErrors(peer);
        } catch (error) {
            failures.push(error);
        }
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
    if (failures.length) throw new AggregateError(failures, 'TELNET websocket fixture cleanup failed');
});

function openWs(cookie) {
    const url = server.url('/ssh').replace(/^http/, 'ws');
    const ws = new WebSocket(url, {
        headers: { Cookie: cookie },
    });
    const errors = [];
    webSocketErrors.set(ws, errors);
    ws.on('error', (error) => errors.push(error));
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

/** Wait for ready and any early data frames that raced ahead of the await. */
function waitReadyAndMaybeData(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let ready = null;
        let data = null;
        const timer = setTimeout(() => {
            ws.off('message', onMsg);
            if (ready) resolve({ ready, data });
            else reject(new Error('timeout waiting for ready'));
        }, timeoutMs);
        const onMsg = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === 'error') {
                clearTimeout(timer);
                ws.off('message', onMsg);
                reject(new Error(msg.message || 'error'));
                return;
            }
            if (msg.type === 'ready') ready = msg;
            if (msg.type === 'data' && !data) data = msg;
            if (ready) {
                // Give a short grace window for a concurrent banner frame.
                clearTimeout(timer);
                setTimeout(() => {
                    ws.off('message', onMsg);
                    resolve({ ready, data });
                }, 40);
            }
        };
        ws.on('message', onMsg);
    });
}

test('WS /ssh connects a TELNET target and pumps data both ways', async () => {
    lastPayload = '';
    const ws = openWs(adminCookie);
    let peer;
    try {
        await waitForOpen(ws);
        // Attach collector BEFORE connect so a fast banner cannot race past us.
        const readyBag = waitReadyAndMaybeData(ws);
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
        const { ready, data: earlyData } = await readyBag;
        peer = activeTelnetPeer();
        assert.equal(ready.protocol, 'TELNET');
        assert.match(ready.warning || '', /未加密|unencrypted|cleartext/i);

        // Server should have already sent "login: " (may have arrived with ready).
        const loginPrompt = earlyData || await waitFor(ws, 'data');
        assert.match(loginPrompt.data, /login:/);

        // Client input should reach the TCP peer (after negotiation bytes).
        ws.send(JSON.stringify({ type: 'input', data: 'root\n' }));
        const echoed = await waitFor(ws, 'data');
        assert.match(echoed.data, /root/);

        // Resize should emit NAWS (IAC SB 31 ...)
        ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
        await new Promise((r) => setTimeout(r, 80));
        assert.ok(lastPayload.includes(String.fromCharCode(255, 250, 31)) || lastPayload.includes('\xff\xfa\x1f'), 'NAWS should be sent');
    } finally {
        await disconnectAndWait(ws, peer);
    }
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
    let peer;
    try {
        await waitForOpen(ws);
        const readyBag = waitReadyAndMaybeData(ws);
        ws.send(JSON.stringify({
            type: 'connect',
            connectionId: id,
            sessionId: `telnet-saved-${Date.now()}`,
            cols: 80,
            rows: 24,
        }));
        const { ready, data: earlyData } = await readyBag;
        peer = activeTelnetPeer();
        assert.equal(ready.protocol, 'TELNET');
        const prompt = earlyData || await waitFor(ws, 'data');
        assert.match(prompt.data, /login:/);
    } finally {
        await disconnectAndWait(ws, peer);
    }
});
