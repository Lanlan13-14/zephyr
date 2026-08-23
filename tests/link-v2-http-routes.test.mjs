import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const zsl = require(path.join(here, '..', 'link-v2-zsl.js'));
const { stopLinkV2Go } = require(path.join(here, '..', 'link-v2-go-proxy.js'));
const { TestServer } = await import('./test-server.mjs');

let server;

before(async () => {
    server = await new TestServer().start();
});

after(async () => {
    // Stop the supervised Go Link child too, otherwise it leaks across the run and
    // keeps the node process alive after the tests finish.
    try { stopLinkV2Go(); } catch {}
    if (server) await server.stop();
});

function b64(buf) { return Buffer.from(buf).toString('base64url'); }

test('POST /api/link/v2/handshake is mounted and rejects an unenrolled device', async () => {
    const init = zsl.handshakeInitiator();
    const r = await fetch(server.url('/api/link/v2/handshake'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            deviceId: 'ghost-device-never-enrolled-0000',
            x25519Public: b64(init.x25519Public),
            mlkemPublic: b64(init.mlkemPublic),
        }),
    });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'device_not_enrolled');
});

test('POST /api/link/v2/handshake fails closed on a malformed KEM key', async () => {
    const r = await fetch(server.url('/api/link/v2/handshake'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            deviceId: 'any-device-id-000000000000',
            x25519Public: b64(crypto.randomBytes(32)),
            mlkemPublic: b64(crypto.randomBytes(8)),
        }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, 'invalid_handshake');
});

test('GET /api/link/v2/state requires an established session', async () => {
    const r = await fetch(server.url('/api/link/v2/state?sessionId=lks_missing'));
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, 'session_unknown');
});

test('POST /api/link/v2/push rejects an unknown session envelope', async () => {
    const r = await fetch(server.url('/api/link/v2/push'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            sessionId: 'lks_missing',
            seq: 0,
            iv: b64(crypto.randomBytes(12)),
            ct: b64(crypto.randomBytes(8)),
            tag: b64(crypto.randomBytes(16)),
        }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.ok, false);
});
