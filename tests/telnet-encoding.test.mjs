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

before(async () => {
    listenServer = net.createServer((sock) => {
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

test('WS telnet with encoding=gbk decodes peer banner and encodes input', async () => {
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
    ws.off('message', onMsg);
    ws.close();
});
