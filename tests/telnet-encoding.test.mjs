/**
 * Phase 3: Telnet encoding (iconv-lite) — GBK / UTF-8 streaming.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import iconv from 'iconv-lite';
import { createTelnetDecoder } from '../telnet-transport.js';
const { TestServer } = await import('./test-server.mjs');

test('createTelnetDecoder utf-8 default', () => {
    const d = createTelnetDecoder('utf-8');
    assert.equal(d.decode(Buffer.from('hello')), 'hello');
    assert.deepEqual([...d.encode('hi')], [...Buffer.from('hi')]);
});

test('createTelnetDecoder gbk round-trip', () => {
    const d = createTelnetDecoder('gbk');
    assert.equal(d.encoding, 'gbk');
    const raw = iconv.encode('你好世界', 'gbk');
    assert.equal(d.decode(raw), '你好世界');
    assert.deepEqual([...d.encode('你好')], [...iconv.encode('你好', 'gbk')]);
});

test('createTelnetDecoder gbk split multi-byte across chunks', () => {
    const d = createTelnetDecoder('gbk');
    const raw = iconv.encode('中文', 'gbk');
    // Feed one byte at a time — hangover should reassemble.
    let out = '';
    for (const b of raw) out += d.decode(Buffer.from([b]));
    out += d.flush();
    assert.equal(out, '中文');
});

test('createTelnetDecoder utf-8 incomplete sequence hangover', () => {
    const d = createTelnetDecoder('utf-8');
    // "你" = E4 BD A0
    const a = d.decode(Buffer.from([0xe4, 0xbd]));
    assert.equal(a, '');
    const b = d.decode(Buffer.from([0xa0, 0x21]));
    assert.equal(b, '你!');
});

// ------------------------- live integration -------------------------

let server;
let adminCookie;
let listenServer;
let listenPort;
let lastClientPayload = Buffer.alloc(0);
const telnetPeers = new Map();
const telnetPeerHistory = new Set();
const webSockets = new Set();
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
    assert.equal(telnetPeers.size, 1, 'exactly one TELNET encoding peer should be active');
    return telnetPeers.values().next().value;
}

function waitForClose(resource, label, timeoutMs = 3000) {
    if (!resource || resource.closed === true || resource.readyState === WebSocket.CLOSED) {
        return Promise.resolve();
    }
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

function throwPeerErrors(peer) {
    if (!peer) return;
    const unchecked = peer.errors.slice(peer.checkedErrors);
    peer.checkedErrors = peer.errors.length;
    const unexpected = unchecked.filter((entry) => !entry.expected).map((entry) => entry.error);
    if (unexpected.length) throw new AggregateError(unexpected, 'TELNET encoding peer failed');
}

function throwWebSocketErrors(ws) {
    const errors = webSocketErrors.get(ws) || [];
    if (errors.length) throw new AggregateError(errors, 'TELNET encoding websocket failed');
}

async function disconnectAndWait(ws, peer) {
    const failures = [];
    if (peer) peer.expectedPeerReset = true;

    const closed = Promise.all([
        waitForClose(ws, 'TELNET encoding websocket'),
        waitForClose(peer?.socket, 'TELNET encoding peer'),
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
    if (failures.length) throw new AggregateError(failures, 'TELNET encoding cleanup failed');
}

function closeServerBounded(targetServer, label, timeoutMs = 3000) {
    if (!targetServer?.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error(`timeout closing ${label}`)), timeoutMs);
        try { targetServer.close(finish); } catch (error) { finish(error); }
    });
}

before(async () => {
    listenServer = net.createServer((sock) => {
        trackTelnetPeer(sock);
        // Send a GBK banner: "欢迎" + prompt
        sock.write(iconv.encode('欢迎\r\nlogin: ', 'gbk'));
        sock.on('data', (chunk) => {
            lastClientPayload = Buffer.concat([lastClientPayload, chunk]);
        });
    });
    await new Promise((r) => listenServer.listen(0, '127.0.0.1', r));
    listenPort = listenServer.address().port;

    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-encoding');
    adminCookie = boot.cookie;
});

after(async () => {
    const failures = [];
    const remainingPeers = [...telnetPeers.values()];
    for (const peer of remainingPeers) peer.expectedPeerReset = true;
    for (const ws of webSockets) {
        try { await disconnectAndWait(ws, remainingPeers.length === 1 ? remainingPeers[0] : null); }
        catch (error) { failures.push(error); }
    }
    try { await server.cleanup(); } catch (error) { failures.push(error); }
    for (const peer of [...telnetPeers.values()]) {
        try {
            peer.socket.destroy();
            await waitForClose(peer.socket, 'remaining TELNET encoding peer');
        } catch (error) {
            failures.push(error);
        }
    }
    for (const peer of telnetPeerHistory) {
        try { throwPeerErrors(peer); } catch (error) { failures.push(error); }
    }
    try { await closeServerBounded(listenServer, 'TELNET encoding fixture server'); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'TELNET encoding fixture cleanup failed');
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
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws.off('message', onMsg);
            ws.off('close', onClose);
            if (error) reject(error);
            else resolve(value);
        };
        const onMsg = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === type) {
                finish(null, msg);
            } else if (msg.type === 'error' && type !== 'error') {
                finish(new Error(msg.message || 'error'));
            }
        };
        const onClose = () => finish(new Error(`websocket closed while waiting for ${type}`));
        const timer = setTimeout(() => finish(new Error(`timeout waiting for ${type}`)), timeoutMs);
        ws.on('message', onMsg);
        ws.once('close', onClose);
    });
}

test('WS telnet with encoding=gbk decodes peer banner and encodes input', async (t) => {
    lastClientPayload = Buffer.alloc(0);
    const ws = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    // Arm collectors before connect.
    let screen = '';
    const onMsg = (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'data') screen += msg.data;
    };
    ws.on('message', onMsg);
    let peer;
    t.after(async () => {
        ws.off('message', onMsg);
        await disconnectAndWait(ws, peer);
    });
    const readyP = waitFor(ws, 'ready');
    ws.send(JSON.stringify({
        type: 'connect',
        protocol: 'TELNET',
        host: '127.0.0.1',
        port: listenPort,
        encoding: 'gbk',
        cols: 80,
        rows: 24,
        sessionId: `enc-gbk-${Date.now()}`,
    }));
    const ready = await readyP;
    peer = activeTelnetPeer();
    assert.equal(ready.protocol, 'TELNET');
    assert.equal(ready.encoding, 'gbk');
    await new Promise((r) => setTimeout(r, 150));
    assert.match(screen, /欢迎/);
    assert.match(screen, /login:/);

    // Input Chinese — must arrive as GBK on the peer.
    ws.send(JSON.stringify({ type: 'input', data: '测试' }));
    await new Promise((r) => setTimeout(r, 100));
    // Strip IAC from lastClientPayload then decode as gbk
    const cleaned = [];
    const buf = lastClientPayload;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 255) {
            const cmd = buf[i + 1];
            if (cmd === 250) {
                while (i < buf.length - 1 && !(buf[i] === 255 && buf[i + 1] === 240)) i++;
                i += 1;
            } else i += 2;
            continue;
        }
        cleaned.push(buf[i]);
    }
    const peerText = iconv.decode(Buffer.from(cleaned), 'gbk');
    assert.match(peerText, /测试/);
});
