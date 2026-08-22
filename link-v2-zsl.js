/**
 * ZSL/2 session: X25519 + ML-KEM-768 hybrid KEM, AES-256-GCM AEAD.
 *
 * Each direction has its own key and 64-bit counter. AAD binds the exporter,
 * direction, and sequence so a captured ciphertext cannot be replayed on the
 * other direction or another session. Replay of an old sequence is rejected.
 */
'use strict';

const crypto = require('crypto');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');

const SUITE = 'ZSL/2-X25519+ML-KEM-768-HKDF-SHA256-AES-256-GCM';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const X25519_BYTES = 32;
const MLKEM768_PUBLIC_KEY_BYTES = 1184;
const MLKEM768_CIPHERTEXT_BYTES = 1088;
const HKDF_SALT_INPUT = 'zephyr-zsl2-v1';
const MAX_SKIP = 64;

function hkdfSalt() {
    return crypto.createHash('sha256').update(HKDF_SALT_INPUT, 'utf8').digest();
}

function derive(ikm, info, length = KEY_BYTES) {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, hkdfSalt(), Buffer.from(info, 'utf8'), length));
}

function generateX25519() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return {
        publicKey: Buffer.from(der.subarray(der.length - X25519_BYTES)),
        privateKey,
    };
}

function x25519Shared(privateKey, peerPublicRaw) {
    const peer = crypto.createPublicKey({
        key: Buffer.concat([
            Buffer.from('302a300506032b656e032100', 'hex'),
            Buffer.from(peerPublicRaw),
        ]),
        format: 'der',
        type: 'spki',
    });
    return crypto.diffieHellman({ privateKey, publicKey: peer });
}

function handshakeInitiator() {
    const x = generateX25519();
    const pq = ml_kem768.keygen();
    return {
        x25519Public: x.publicKey,
        x25519Private: x.privateKey,
        mlkemPublic: Buffer.from(pq.publicKey),
        mlkemPrivate: Buffer.from(pq.secretKey || pq.privateKey),
    };
}

function handshakeResponder(initiator) {
    const x = generateX25519();
    const peerMlkem = Buffer.from(initiator.mlkemPublic);
    if (peerMlkem.length !== MLKEM768_PUBLIC_KEY_BYTES) {
        throw new TypeError('ML-KEM-768 public key must be ' + MLKEM768_PUBLIC_KEY_BYTES + ' bytes');
    }
    const encapsulated = ml_kem768.encapsulate(peerMlkem);
    const kemCiphertext = Buffer.from(encapsulated.cipherText || encapsulated.ciphertext);
    const pqShared = Buffer.from(encapsulated.sharedSecret);
    const xShared = x25519Shared(x.privateKey, initiator.x25519Public);
    const master = derive(Buffer.concat([xShared, pqShared]), 'zsl2-master');
    return {
        x25519Public: x.publicKey,
        mlkemCiphertext: kemCiphertext,
        session: openSession(master, 'responder'),
    };
}

function handshakeFinish(local, responder) {
    const xShared = x25519Shared(local.x25519Private, responder.x25519Public);
    const ct = Buffer.from(responder.mlkemCiphertext);
    if (ct.length !== MLKEM768_CIPHERTEXT_BYTES) {
        throw new TypeError('ML-KEM-768 ciphertext must be ' + MLKEM768_CIPHERTEXT_BYTES + ' bytes');
    }
    const pqShared = Buffer.from(ml_kem768.decapsulate(ct, local.mlkemPrivate));
    const master = derive(Buffer.concat([xShared, pqShared]), 'zsl2-master');
    return openSession(master, 'initiator');
}

function openSession(master, role) {
    const sendLabel = role === 'initiator' ? 'zsl2-send-i' : 'zsl2-send-r';
    const recvLabel = role === 'initiator' ? 'zsl2-send-r' : 'zsl2-send-i';
    return new Zsl2Session({
        role,
        sendKey: derive(master, sendLabel),
        recvKey: derive(master, recvLabel),
        exporter: derive(master, 'zsl2-exporter'),
    });
}

class Zsl2Session {
    constructor({ role, sendKey, recvKey, exporter }) {
        this.role = role;
        this.sendKey = sendKey;
        this.recvKey = recvKey;
        this.exporter = exporter;
        this.sendSeq = 0n;
        this.recvSeq = 0n;
        this.seen = new Set();
    }

    _aad(direction, seq) {
        return Buffer.concat([
            Buffer.from('zsl2-aad-v1', 'utf8'),
            this.exporter,
            Buffer.from(direction, 'utf8'),
            Buffer.from(seq.toString().padStart(20, '0'), 'utf8'),
        ]);
    }

    seal(plaintext) {
        const seq = this.sendSeq;
        this.sendSeq += 1n;
        const iv = crypto.randomBytes(IV_BYTES);
        const aad = this._aad('s', seq);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(aad);
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        return { seq: Number(seq), iv, ct, tag };
    }

    open({ seq, iv, ct, tag }) {
        const sequence = BigInt(seq);
        if (sequence < this.recvSeq && this.recvSeq - sequence > BigInt(MAX_SKIP)) {
            throw new Error('ZSL/2 replay rejected');
        }
        const key = sequence.toString();
        if (this.seen.has(key)) throw new Error('ZSL/2 replay rejected');
        const aad = this._aad('s', sequence);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
        this.seen.add(key);
        if (sequence >= this.recvSeq) this.recvSeq = sequence + 1n;
        if (this.seen.size > MAX_SKIP * 4) {
            const min = this.recvSeq - BigInt(MAX_SKIP);
            for (const item of this.seen) {
                if (BigInt(item) < min) this.seen.delete(item);
            }
        }
        return plain;
    }
}

module.exports = {
    SUITE,
    handshakeInitiator,
    handshakeResponder,
    handshakeFinish,
    Zsl2Session,
    MLKEM768_PUBLIC_KEY_BYTES,
    X25519_BYTES,
};
