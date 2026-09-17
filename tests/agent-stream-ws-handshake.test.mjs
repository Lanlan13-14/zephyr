import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

/*
 * Production path for the Agent bastion stream:
 *
 *   Agent Go (dialTunnelStream) → Node `ws` at /api/link/v2/stream
 *                               → Node `ws` client → Go handleStream
 *
 * The Go unit tests never leave httptest, so they cannot see what Node's `ws`
 * library actually accepts. The live failure ("session has no live stream")
 * is exactly "the Agent never attached". Two independent RFC 6455 mismatches
 * used to make Node refuse the Agent:
 *
 *   1. Sec-WebSocket-Key was not 16 random bytes, standard base64
 *      (`ws` keyRegex = /^[+/0-9A-Za-z]{22}==$/).
 *   2. Client frames were unmasked (`ws` as a server requires MASK).
 *
 * This file talks to a real `ws` WebSocketServer — the same library Node uses
 * on the public upgrade path — and pins the Go source so the old handshake
 * cannot come back.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function rfcKey() {
    return crypto.randomBytes(16).toString('base64');
}

function goLegacyKey() {
    return `zephyr-link-${Date.now()}000`;
}

function upgrade(port, key) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/link/v2/stream?sessionId=s1',
            method: 'GET',
            headers: {
                Host: '127.0.0.1',
                Upgrade: 'websocket',
                Connection: 'Upgrade',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
            },
        });
        req.on('upgrade', (res, socket) => {
            socket.setTimeout(0);
            resolve({ status: res.statusCode, socket, headers: res.headers });
        });
        req.on('response', (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8'),
                    socket: null,
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function listenWs() {
    return new Promise((resolve) => {
        const httpServer = http.createServer();
        const wss = new WebSocketServer({ noServer: true });
        const clients = [];
        httpServer.on('upgrade', (req, socket, head) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
                clients.push(ws);
                ws.on('message', (data) => ws.send(data));
                ws.on('error', () => {});
            });
        });
        httpServer.listen(0, '127.0.0.1', () => {
            resolve({
                port: httpServer.address().port,
                clients,
                async close() {
                    for (const c of clients) {
                        try { c.close(); } catch {}
                    }
                    await new Promise((r) => wss.close(() => httpServer.close(r)));
                },
            });
        });
    });
}

function maskFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    const hdr = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    return Buffer.concat([hdr, mask, masked]);
}

test('Node ws rejects the Sec-WebSocket-Key Go used to send', async () => {
    const srv = await listenWs();
    try {
        const result = await upgrade(srv.port, goLegacyKey());
        assert.notEqual(result.status, 101, `legacy Go key must not upgrade, got ${result.status}`);
        assert.equal(result.status, 400);
        assert.match(String(result.body || ''), /invalid Sec-WebSocket-Key/i);
        assert.equal(result.socket, null);
    } finally {
        await srv.close();
    }
});

test('Node ws accepts an RFC 6455 Sec-WebSocket-Key', async () => {
    const srv = await listenWs();
    try {
        const result = await upgrade(srv.port, rfcKey());
        assert.equal(result.status, 101, `RFC key must upgrade, got ${result.status} ${result.body || ''}`);
        assert.ok(result.socket);
        result.socket.destroy();
    } finally {
        await srv.close();
    }
});

test('Node ws as a server echoes a masked client frame and not an unmasked one', async () => {
    const srv = await listenWs();
    try {
        const good = await upgrade(srv.port, rfcKey());
        assert.equal(good.status, 101);
        const echoed = new Promise((resolve, reject) => {
            good.socket.once('data', resolve);
            good.socket.once('error', reject);
            setTimeout(() => reject(new Error('no echo for masked frame')), 1500);
        });
        good.socket.write(maskFrame(0x1, Buffer.from('{"k":1}')));
        const data = await echoed;
        assert.ok(data.length > 0, 'server echoed the masked frame');
        good.socket.destroy();
    } finally {
        await srv.close();
    }
});

test('Go stream handshake is RFC 6455 and the Agent client masks frames', () => {
    const stream = read('zephyr-link/internal/link/stream.go');
    const tunnel = read('zephyr-link/internal/link/tunnel.go');

    assert.match(stream, /base64\.StdEncoding\.EncodeToString\(h\[:\]\)/);
    assert.doesNotMatch(stream, /RawURLEncoding\.EncodeToString\(h\[:\]\)/);

    assert.match(stream, /func newWSClientKey\(\) \(string, error\)/);
    assert.match(stream, /raw := make\(\[\]byte, 16\)/);
    assert.match(tunnel, /key, err := newWSClientKey\(\)/);
    assert.doesNotMatch(tunnel, /zephyr-link-%d/);

    assert.match(stream, /func writeClientFrame\(/);
    assert.match(tunnel, /writeClientFrame\(t\.conn, 0x1, env\)/);
    assert.match(tunnel, /writeClientFrame\(t\.conn, 0xA, payload\)/);
    assert.match(tunnel, /writeClientFrame\(t\.conn, 0x8, nil\)/);

    assert.match(stream, /func writeServerFrame\(/);
    assert.match(stream, /return writeServerFrame\(conn, opcode, payload\)/);
});

test('RFC 6455 example Accept is what Go now emits', () => {
    // RFC 6455 §1.3: key "dGhlIHNhbXBsZSBub25jZQ==" → this exact Accept.
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const std = crypto.createHash('sha1').update(key + magic).digest('base64');
    assert.equal(std, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const rawUrl = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    assert.notEqual(std, rawUrl, 'the RFC value differs from RawURLEncoding, so the old Go accept was observably wrong');
});
