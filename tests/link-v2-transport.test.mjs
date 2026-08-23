import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { createDatabase } = require(path.join(repo, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repo, 'mobile-v1-store.js'));
const { LinkV2EnrollmentStore } = require(path.join(repo, 'link-v2-enrollment.js'));
const { createLinkV2Transport } = require(path.join(repo, 'link-v2-transport.js'));
const zsl = require(path.join(repo, 'link-v2-zsl.js'));
const codec = require(path.join(repo, 'link-v2-codec.js'));

const registry = JSON.parse(fs.readFileSync(
    path.join(repo, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
    'utf8',
));

function b64(buf) { return Buffer.from(buf).toString('base64url'); }

function fresh() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-link-transport-'));
    const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
    const store = new MobileV1Store({ db, entityRegistry: registry, blobRoot: path.join(dir, 'blobs') });
    const enrollments = new LinkV2EnrollmentStore({ db });
    const transport = createLinkV2Transport({ enrollments, store });
    return {
        dir, db, store, enrollments, transport,
        cleanup() { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); },
    };
}

function deviceId(tag) { return 'dev-' + tag + '-' + crypto.randomBytes(12).toString('hex'); }

/** Drive a device all the way to a consumed enrollment. */
function enrollDevice(env, id) {
    const created = env.enrollments.create({
        deviceId: id,
        deviceName: 'Test Pixel',
        platform: 'android',
        appVersion: '1.0.0',
        keys: {
            // The store decodes this field with plain base64 and demands 1184 bytes.
            encryption: { publicKey: crypto.randomBytes(1184).toString('base64') },
            signing: { alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: b64(crypto.randomBytes(32)), y: b64(crypto.randomBytes(32)) } },
        },
        origin: 'https://z.example',
        serverId: 'srv-1',
        ip: '127.0.0.1',
    });
    // approve + consume mutate the row through the same store the route uses.
    env.db.prepare(`UPDATE link_enrollments SET status='approved', owner_user_id='u1', owner_username='alice' WHERE bind_id=?`).run(created.bindId);
    env.db.prepare(`UPDATE link_enrollments SET status='consumed', consumed_at=? WHERE bind_id=?`).run(Date.now(), created.bindId);
    return created;
}

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

test('ZSL handshake then sealed frame round-trips through the transport', () => {
    const env = fresh();
    try {
        const ID_A = deviceId('A'); enrollDevice(env, ID_A);
        // Device side: build the initiator hello.
        const init = zsl.handshakeInitiator();
        const res = mockRes();
        env.transport.handshake({
            body: { deviceId: ID_A, x25519Public: b64(init.x25519Public), mlkemPublic: b64(init.mlkemPublic) },
        }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.ok, true);
        assert.equal(res.body.suite, zsl.SUITE);
        const sessionId = res.body.sessionId;

        // Device finishes the handshake → its own session.
        const deviceSession = zsl.handshakeFinish(init, {
            x25519Public: Buffer.from(res.body.x25519Public, 'base64url'),
            mlkemCiphertext: Buffer.from(res.body.mlkemCiphertext, 'base64url'),
        });

        // Device seals a SYNC_OP business frame (CBOR body via codec).
        const packed = codec.pack({ kind: codec.KIND.SYNC_OP, body: { op: 'upsert', entity: 'note', id: 'n1' } });
        const sealed = deviceSession.seal(packed);
        const { record, frame } = env.transport.openEnvelope({
            sessionId, seq: sealed.seq,
            iv: b64(sealed.iv), ct: b64(sealed.ct), tag: b64(sealed.tag),
        });
        assert.equal(frame.kind, codec.KIND.SYNC_OP);
        assert.deepEqual(frame.body, { op: 'upsert', entity: 'note', id: 'n1' });
        assert.equal(record.deviceId, ID_A);
        assert.equal(record.userId, 'u1');

        // Server seals a SYNC_ACK back; the device opens it with its session.
        const reply = env.transport.sealFrame(record, codec.KIND.SYNC_ACK, { appliedCursor: 42 });
        const replyPlain = deviceSession.open({
            seq: reply.seq,
            iv: Buffer.from(reply.iv, 'base64url'),
            ct: Buffer.from(reply.ct, 'base64url'),
            tag: Buffer.from(reply.tag, 'base64url'),
        });
        const replyFrame = codec.unpack(replyPlain);
        assert.equal(replyFrame.kind, codec.KIND.SYNC_ACK);
        assert.deepEqual(replyFrame.body, { appliedCursor: 42 });
    } finally {
        env.cleanup();
    }
});

test('handshake rejects a device that never completed enrollment', () => {
    const env = fresh();
    try {
        const init = zsl.handshakeInitiator();
        const res = mockRes();
        env.transport.handshake({
            body: { deviceId: 'ghost', x25519Public: b64(init.x25519Public), mlkemPublic: b64(init.mlkemPublic) },
        }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.error.code, 'device_not_enrolled');
    } finally {
        env.cleanup();
    }
});

test('handshake fails closed on a malformed KEM public key', () => {
    const env = fresh();
    try {
        const ID_B = deviceId('B'); enrollDevice(env, ID_B);
        const res = mockRes();
        env.transport.handshake({
            body: { deviceId: ID_B, x25519Public: b64(crypto.randomBytes(32)), mlkemPublic: b64(crypto.randomBytes(10)) },
        }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error.code, 'invalid_handshake');
    } finally {
        env.cleanup();
    }
});

test('opening a frame for an unknown session is rejected', () => {
    const env = fresh();
    try {
        assert.throws(() => env.transport.openEnvelope({
            sessionId: 'lks_missing', seq: 0, iv: b64(crypto.randomBytes(12)), ct: b64(crypto.randomBytes(8)), tag: b64(crypto.randomBytes(16)),
        }), /unknown or expired Link session/);
    } finally {
        env.cleanup();
    }
});

test('a replayed frame sequence is rejected by the session window', () => {
    const env = fresh();
    try {
        const ID_C = deviceId('C'); enrollDevice(env, ID_C);
        const init = zsl.handshakeInitiator();
        const res = mockRes();
        env.transport.handshake({
            body: { deviceId: ID_C, x25519Public: b64(init.x25519Public), mlkemPublic: b64(init.mlkemPublic) },
        }, res);
        const sessionId = res.body.sessionId;
        const deviceSession = zsl.handshakeFinish(init, {
            x25519Public: Buffer.from(res.body.x25519Public, 'base64url'),
            mlkemCiphertext: Buffer.from(res.body.mlkemCiphertext, 'base64url'),
        });
        const packed = codec.pack({ kind: codec.KIND.WAKE, body: { cursor: 1 } });
        const sealed = deviceSession.seal(packed);
        const envelope = { sessionId, seq: sealed.seq, iv: b64(sealed.iv), ct: b64(sealed.ct), tag: b64(sealed.tag) };
        env.transport.openEnvelope(envelope);
        // Replaying the exact same sealed frame must fail.
        assert.throws(() => env.transport.openEnvelope(envelope), /replay/);
    } finally {
        env.cleanup();
    }
});

test('large frames are compressed before encryption and inflate within limits', () => {
    const env = fresh();
    try {
        const ID_D = deviceId('D'); enrollDevice(env, ID_D);
        const init = zsl.handshakeInitiator();
        const res = mockRes();
        env.transport.handshake({
            body: { deviceId: ID_D, x25519Public: b64(init.x25519Public), mlkemPublic: b64(init.mlkemPublic) },
        }, res);
        const sessionId = res.body.sessionId;
        const deviceSession = zsl.handshakeFinish(init, {
            x25519Public: Buffer.from(res.body.x25519Public, 'base64url'),
            mlkemCiphertext: Buffer.from(res.body.mlkemCiphertext, 'base64url'),
        });
        // Random 64KB stays above the decompression-ratio guard and round-trips exactly.
        const big = crypto.randomBytes(64 * 1024).toString('base64');
        const packed = codec.pack({ kind: codec.KIND.SYNC_OP, body: { blob: big } });
        const sealed = deviceSession.seal(packed);
        const { frame } = env.transport.openEnvelope({
            sessionId, seq: sealed.seq, iv: b64(sealed.iv), ct: b64(sealed.ct), tag: b64(sealed.tag),
        });
        assert.equal(frame.body.blob, big);

        // A >256x decompression bomb is rejected before it inflates.
        const bombPacked = codec.pack({ kind: codec.KIND.SYNC_OP, body: { blob: 'x'.repeat(64 * 1024) } });
        const bombSealed = deviceSession.seal(bombPacked);
        assert.throws(() => env.transport.openEnvelope({
            sessionId, seq: bombSealed.seq, iv: b64(bombSealed.iv), ct: b64(bombSealed.ct), tag: b64(bombSealed.tag),
        }), /decompression ratio|max size/);
    } finally {
        env.cleanup();
    }
});
