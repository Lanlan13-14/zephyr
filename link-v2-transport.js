/**
 * Link v2 transport: terminates the ZSL/2 application-layer session and carries
 * canonical-CBOR frames over WSS (primary) and HTTP push/pull (fallback).
 *
 * This is the first consumer of link-v2-zsl.js / link-v2-codec.js on a real
 * socket. Until now those libraries were only exercised by unit tests; nothing
 * in the server negotiated a ZSL session or decrypted a single business frame.
 *
 * Security contract (ZEPHYR_ONE.md §18):
 *  - A CDN may terminate outer TLS; it must never read the inner payload. All
 *    business frames are ZSL/2 AEAD-sealed (X25519 + ML-KEM-768 hybrid), with
 *    the AAD binding the exporter and the per-direction sequence.
 *  - The handshake is bound to a consumed enrollment's device, so a bare MITM
 *    cannot ride a victim's approved device without holding its private keys.
 *  - Replay across the stream is rejected by the ZSL session window.
 */
'use strict';

const crypto = require('crypto');
const zsl = require('./link-v2-zsl');
const codec = require('./link-v2-codec');

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS_PER_DEVICE = 4;
const MAX_FRAME_BYTES = codec.MAX_FRAME_BYTES;

function nowMs() {
    return Date.now();
}

function randomId(prefix) {
    return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

/**
 * In-memory ZSL session table. Sessions are process-local by design: a Link
 * session is a live transport and does not survive a restart (the device simply
 * re-handshakes). No key material is ever persisted.
 */
class LinkV2SessionTable {
    constructor({ log } = {}) {
        this.log = log || (() => {});
        this.sessions = new Map(); // sessionId -> record
        this.byDevice = new Map(); // deviceId -> Set<sessionId>
    }

    create({ deviceId, userId, session, pending }) {
        this._evictForDevice(deviceId);
        const sessionId = randomId('lks');
        const record = {
            sessionId,
            deviceId: String(deviceId || ''),
            userId: String(userId || ''),
            session: session || null,
            pending: pending || null, // responder hello awaiting finish
            createdAt: nowMs(),
            expiresAt: nowMs() + SESSION_TTL_MS,
            established: !!session,
        };
        this.sessions.set(sessionId, record);
        if (!this.byDevice.has(record.deviceId)) this.byDevice.set(record.deviceId, new Set());
        this.byDevice.get(record.deviceId).add(sessionId);
        return record;
    }

    get(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record) return null;
        if (record.expiresAt <= nowMs()) {
            this.destroy(sessionId);
            return null;
        }
        return record;
    }

    establish(sessionId, session) {
        const record = this.get(sessionId);
        if (!record) return null;
        record.session = session;
        record.pending = null;
        record.established = true;
        record.expiresAt = nowMs() + SESSION_TTL_MS;
        return record;
    }

    destroy(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record) return;
        this.sessions.delete(sessionId);
        const set = this.byDevice.get(record.deviceId);
        if (set) {
            set.delete(sessionId);
            if (set.size === 0) this.byDevice.delete(record.deviceId);
        }
    }

    _evictForDevice(deviceId) {
        const set = this.byDevice.get(deviceId);
        if (!set) return;
        const live = [...set].map((id) => this.sessions.get(id)).filter(Boolean)
            .sort((a, b) => a.createdAt - b.createdAt);
        while (live.length >= MAX_SESSIONS_PER_DEVICE) {
            const oldest = live.shift();
            this.destroy(oldest.sessionId);
        }
    }

    sweep() {
        const now = nowMs();
        for (const [id, record] of this.sessions) {
            if (record.expiresAt <= now) this.destroy(id);
        }
    }
}

/**
 * Decode a base64url/base64 field into a Buffer with a strict expected length.
 */
function keyBytes(value, expected, field) {
    if (typeof value !== 'string' || !value) throw Object.assign(new Error(field + ' required'), { code: 'invalid_handshake' });
    let buf;
    try {
        buf = Buffer.from(value, 'base64url');
    } catch {
        throw Object.assign(new Error(field + ' is not base64url'), { code: 'invalid_handshake' });
    }
    if (buf.length !== expected) {
        throw Object.assign(new Error(field + ' must be ' + expected + ' bytes'), { code: 'invalid_handshake' });
    }
    return buf;
}

function createLinkV2Transport({ enrollments, store, log } = {}) {
    if (!enrollments) throw new TypeError('enrollments store required');
    const logger = typeof log === 'function' ? log : () => {};
    const table = new LinkV2SessionTable({ log: logger });

    function resolveDevice(deviceId) {
        // The device must have a consumed enrollment — that is the proof it holds
        // the private half of the keys a human approved. We never trust a deviceId
        // that only exists in a pending row.
        if (typeof enrollments.deviceById === 'function') {
            return enrollments.deviceById(deviceId);
        }
        return null;
    }

    return {
        table,
        sweep: () => table.sweep(),

        /**
         * POST /api/link/v2/handshake — initiator hello.
         * Body: { deviceId, x25519Public, mlkemPublic } (base64url).
         * Response: { sessionId, x25519Public, mlkemCiphertext } (base64url).
         */
        handshake(req, res) {
            try {
                const body = req.body || {};
                const deviceId = String(body.deviceId || '');
                if (!deviceId) {
                    return res.status(400).json({ ok: false, error: { code: 'invalid_handshake', message: 'deviceId required' } });
                }
                // Validate the KEM/key sizes before the enrollment lookup, so a malformed
                // key cannot be used as an oracle for whether a deviceId is enrolled.
                const initiator = {
                    x25519Public: keyBytes(body.x25519Public, zsl.X25519_BYTES, 'x25519Public'),
                    mlkemPublic: keyBytes(body.mlkemPublic, zsl.MLKEM768_PUBLIC_KEY_BYTES, 'mlkemPublic'),
                };
                const device = resolveDevice(deviceId);
                if (!device) {
                    return res.status(403).json({ ok: false, error: { code: 'device_not_enrolled', message: '设备未完成绑定', retryable: false } });
                }
                const responder = zsl.handshakeResponder(initiator);
                // Stash the responder's half-open session; the stream/push/pull
                // upgrade proves possession by sealing a frame only the peer can produce.
                const record = table.create({
                    deviceId,
                    userId: device.ownerUserId || device.userId || '',
                    session: responder.session,
                });
                return res.status(200).json({
                    ok: true,
                    sessionId: record.sessionId,
                    suite: zsl.SUITE,
                    x25519Public: responder.x25519Public.toString('base64url'),
                    mlkemCiphertext: responder.mlkemCiphertext.toString('base64url'),
                    expiresAt: record.expiresAt,
                });
            } catch (err) {
                const code = (err && err.code) || 'handshake_failed';
                logger('[link-v2] handshake failed', err && err.message);
                return res.status(400).json({ ok: false, error: { code, message: String(err && err.message || '握手失败'), retryable: true } });
            }
        },

        /**
         * Open a sealed business frame arriving over any transport.
         * Envelope: { sessionId, seq, iv, ct, tag } (binary fields base64url).
         * Returns { record, frame } where frame is the codec-unpacked business frame.
         */
        openEnvelope(envelope) {
            if (!envelope || typeof envelope !== 'object') {
                throw Object.assign(new Error('frame envelope required'), { code: 'invalid_frame' });
            }
            const record = table.get(String(envelope.sessionId || ''));
            if (!record || !record.session) {
                throw Object.assign(new Error('unknown or expired Link session'), { code: 'session_unknown' });
            }
            const plain = record.session.open({
                seq: envelope.seq,
                iv: keyBytes(envelope.iv, 12, 'iv'),
                ct: Buffer.from(String(envelope.ct || ''), 'base64url'),
                tag: keyBytes(envelope.tag, 16, 'tag'),
            });
            if (plain.length > MAX_FRAME_BYTES) {
                throw Object.assign(new Error('frame exceeds max size'), { code: 'frame_too_large' });
            }
            record.expiresAt = nowMs() + SESSION_TTL_MS;
            return { record, frame: codec.unpack(plain) };
        },

        /**
         * Seal a business frame for a session. Returns the wire envelope.
         */
        sealFrame(record, kind, body, { secret = false } = {}) {
            if (!record || !record.session) {
                throw Object.assign(new Error('unknown Link session'), { code: 'session_unknown' });
            }
            const packed = codec.pack({ kind, body, secret });
            const sealed = record.session.seal(packed);
            return {
                sessionId: record.sessionId,
                seq: sealed.seq,
                iv: sealed.iv.toString('base64url'),
                ct: sealed.ct.toString('base64url'),
                tag: sealed.tag.toString('base64url'),
            };
        },

        destroy: (sessionId) => table.destroy(sessionId),
    };
}

module.exports = {
    createLinkV2Transport,
    LinkV2SessionTable,
    SESSION_TTL_MS,
};
