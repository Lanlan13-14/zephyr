// End-to-end Agent device enrollment against a real server.
//
// Exercises the exact production path Zephyr Agent takes:
//   1. POST /api/link/v2/enrollments        (create, platform=agent)
//   2. POST /link/approve                   (admin approves in-session)
//   3. POST /api/link/v2/enrollments/:id/consume  (ES256 proof + ML-KEM keys)
//   4. /agent/files WebSocket hello with the access credential (no token)
//
// The client-side keys are generated the same way the Android host does:
// ML-KEM-768 via the shared zsl module, ES256 via Node crypto.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const zsl = require(path.join(repo, 'link-v2-zsl.js'));
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');
const { stopLinkV2Go } = require(path.join(repo, 'link-v2-go-proxy.js'));
const { TestServer } = await import('./test-server.mjs');

function buildCurrentGoLinkServer() {
    const output = path.join(os.tmpdir(), `zephyr-link-server-e2e-${process.pid}`);
    const go = fs.existsSync('/usr/local/go126/bin/go') ? '/usr/local/go126/bin/go' : 'go';
    const built = spawnSync(go, ['build', '-trimpath', '-o', output, './cmd/zephyr-link-server'], {
        cwd: path.join(repo, 'zephyr-link'),
        encoding: 'utf8',
    });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    return output;
}

const goBin = buildCurrentGoLinkServer();
process.env.ZEPHYR_LINK_GO_BIN = goBin;

let server;
let admin;

before(async () => {
    server = await new TestServer().start();
    admin = await server.bootstrapAdmin();
});

after(async () => {
    try { stopLinkV2Go(); } catch {}
    if (server) await server.stop();
    try { fs.rmSync(goBin, { force: true }); } catch {}
});

function b64(buf) { return Buffer.from(buf).toString('base64url'); }

function generateSigningJwk() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { jwk, privateKey };
}

function p1363Sign(privateKey, payload) {
    const sig = crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return sig.toString('base64');
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function enrollDevice({ deviceName, platform }) {
    const deviceId = crypto.randomUUID();
    const { jwk, privateKey } = generateSigningJwk();
    const { publicKey: mlkemPublic } = ml_kem768.keygen();
    assert.ok(mlkemPublic, 'ML-KEM keypair generation unavailable');

    const created = await server.api(null, 'POST', '/api/link/v2/enrollments', {
        deviceId,
        deviceName,
        platform,
        appVersion: 'agent-e2e',
        keys: {
            encryption: { alg: 'ML-KEM-768', publicKey: Buffer.from(mlkemPublic).toString('base64') },
            signing: { alg: 'ES256', jwk },
        },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.platform, platform);

    const approved = await server.fetch('/link/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ bindId: created.body.bindId, userCode: created.body.userCode, decision: 'approve' }),
    });
    assert.equal(approved.status, 200, `approve failed: ${await approved.text()}`);

    const payload = Buffer.from([
        'zephyr-link-enrollment-v2',
        created.body.bindId,
        deviceId,
        created.body.userCode.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        created.body.sas,
        sha256Hex(created.body.enrollmentSecret),
        created.body.serverId,
    ].join('\u0000'), 'utf8');

    const consumed = await server.api(null, 'POST',
        `/api/link/v2/enrollments/${created.body.bindId}/consume`,
        {
            userCode: created.body.userCode,
            enrollmentSecret: created.body.enrollmentSecret,
            proof: p1363Sign(privateKey, payload),
            keys: {
                encryption: { alg: 'ML-KEM-768', publicKey: Buffer.from(mlkemPublic).toString('base64') },
                signing: { alg: 'ES256', jwk },
            },
        });
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
    assert.ok(consumed.body.accessCredential, 'no access credential');
    assert.ok(consumed.body.refreshCredential, 'no refresh credential');
    return { deviceId, deviceName, accessCredential: consumed.body.accessCredential };
}

function agentHello(ws, { deviceId, accessCredential }) {
    ws.send(JSON.stringify({
        type: 'hello',
        protocolVersion: 2,
        token: '',
        accessCredential,
        deviceId,
        deviceName: 'E2E Agent',
        platform: 'agent-linux',
        appVersion: 'agent-e2e',
        capabilities: { read: true, binary: true, maxInflight: 2 },
        share: { readOnly: true },
    }));
}

function nextJson(ws) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('agent hello ack timeout')), 10000);
        ws.on('message', (frame) => {
            clearTimeout(timer);
            try { resolve(JSON.parse(frame.toString())); } catch (e) { reject(e); }
        });
        ws.on('error', reject);
    });
}

test('agent platform enrolls, consumes, and authenticates /agent/files without a token', async () => {
    const enrolled = await enrollDevice({ deviceName: 'E2E Agent Desktop', platform: 'agent-linux' });

    const wsUrl = `ws://127.0.0.1:${server.port}/agent/files`;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    agentHello(ws, enrolled);
    const ack = await nextJson(ws);

    assert.equal(ack.type, 'hello_ack');
    assert.equal(ack.ok, true);
    assert.match(ack.agentId, /^agent_/);
    ws.close();
});

test('enrollment rejects a wrong-platform create up front', async () => {
    const deviceId = crypto.randomUUID();
    const { jwk } = generateSigningJwk();
    const { publicKey: mlkemPublic } = ml_kem768.keygen();
    const res = await server.api(null, 'POST', '/api/link/v2/enrollments', {
        deviceId,
        deviceName: 'Bad Platform',
        platform: 'windows-phone',
        appVersion: 'agent-e2e',
        keys: {
            encryption: { alg: 'ML-KEM-768', publicKey: Buffer.from(mlkemPublic).toString('base64') },
            signing: { alg: 'ES256', jwk },
        },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_request');
});

test('credential bound to another deviceId is rejected by the gateway', async () => {
    const enrolled = await enrollDevice({ deviceName: 'E2E Agent A', platform: 'agent-linux' });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/agent/files`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({
        type: 'hello',
        protocolVersion: 2,
        token: '',
        accessCredential: enrolled.accessCredential,
        deviceId: crypto.randomUUID(),
        deviceName: 'Impostor',
        platform: 'agent-linux',
        appVersion: 'agent-e2e',
        capabilities: { read: true },
        share: { readOnly: true },
    }));
    const ack = await nextJson(ws);
    assert.equal(ack.ok, false);
    ws.close();
});