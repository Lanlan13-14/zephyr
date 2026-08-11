/**
 * Device envelope + AAD construction for the mobile v1 sync plane.
 *
 * Every byte here is dictated by a frozen contract, so the reasoning is recorded
 * next to the choice rather than in a commit message:
 *
 *  - The suite is `ML-KEM-768 + HKDF-SHA256 + AES-256-GCM`, fixed by
 *    DATA_AND_MIGRATION.md 5.2 and asserted by the generated
 *    `SecretEnvelopeContract`. It is deliberately the same KEM the existing
 *    server-side `secret-crypto.js` uses for at-rest fields, so the process
 *    already ships one post-quantum implementation rather than two.
 *  - The AAD is a NUL-joined field list, not JSON. JSON would let a field be
 *    shifted into its neighbour ("ab"+"c" vs "a"+"bc") and still produce the
 *    same bytes; a NUL separator with non-empty parts cannot. `mobile/tools/lib/
 *    aad.mjs` is the generator-side twin of this function and
 *    `contracts/generated/aad-vectors.json` freezes the expected output, so the
 *    two are checked against each other rather than trusted.
 *  - The GCM tag is *detached* on the wire. Node's `cipher.getAuthTag()` returns
 *    it separately and the JCE expects it appended; the client re-appends before
 *    decrypting. Keeping it detached matches the frozen envelope schema, so the
 *    conversion happens on the client side where the JCE requires it.
 *
 * Nothing here touches the database or Express. It is pure so the wire format can
 * be tested against the frozen vectors without a server.
 */
'use strict';

const crypto = require('crypto');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');

/** Frozen by contracts/schemas/secret-envelope.schema.json. */
const ENVELOPE_VERSION = 1;
const ALG = 'ML-KEM-768+HKDF-SHA256+AES-256-GCM';
const KEM = 'ML-KEM-768';
const AEAD = 'AES-256-GCM';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

const HKDF_SALT_INPUT = 'zephyr-mobile-envelope-v1';
const SECRET_AAD_PREFIX = 'zephyr-mobile-secret-v1';
const SHARED_AAD_PREFIX = 'shared-use-v1';

/** ML-KEM-768 sizes, used to fail closed before any cipher is constructed. */
const MLKEM768_PUBLIC_KEY_BYTES = 1184;
const MLKEM768_CIPHERTEXT_BYTES = 1088;

/**
 * Decimal ASCII with no leading zeros.
 *
 * `08` and `8` must not produce the same AAD, or a revision could be restated to
 * make one envelope verify against another entity state.
 */
function decimalAscii(value, field) {
    if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError(field + ' must be a non-negative integer');
        }
        return String(value);
    }
    const text = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
        throw new TypeError(field + ' must be decimal ASCII without leading zeros');
    }
    return text;
}

/**
 * NUL-joins parts, rejecting empty ones.
 *
 * An empty part would make the separator ambiguous: ("a", "", "b") and
 * ("a", "b") would differ only by a trailing NUL, which is exactly the kind of
 * near-collision the separator exists to prevent.
 */
function joinNul(parts) {
    const buffers = [];
    parts.forEach((part, index) => {
        if (part === undefined || part === null || part === '') {
            throw new TypeError('AAD parts must be non-empty');
        }
        const text = String(part);
        if (!text || text.includes('\u0000')) {
            throw new TypeError('AAD parts must be non-empty and must not contain NUL');
        }
        if (index > 0) buffers.push(Buffer.from([0x00]));
        buffers.push(Buffer.from(text, 'utf8'));
    });
    return Buffer.concat(buffers);
}

/** AAD for a per-field device secret envelope. */
function secretAadBytes(input) {
    return joinNul([
        SECRET_AAD_PREFIX,
        input.serverId,
        input.userId,
        input.deviceId,
        input.entityType,
        input.entityId,
        input.fieldName,
        decimalAscii(input.entityRevision, 'entityRevision'),
        decimalAscii(input.keyVersion, 'keyVersion'),
    ]);
}

/** AAD for a single-use shared-resource envelope. */
function sharedUseAadBytes(input) {
    return joinNul([
        SHARED_AAD_PREFIX,
        input.serverId,
        input.userId,
        input.deviceId,
        input.sessionId,
        input.resourceId,
        decimalAscii(input.resourceRevision, 'resourceRevision'),
        input.purpose,
        decimalAscii(input.expiresAt, 'expiresAt'),
        input.clientNonce,
    ]);
}

/**
 * HKDF salt.
 *
 * A hash of a fixed string rather than the string itself, so the salt is a full
 * 32 bytes and matches `MobileAad.hkdfSalt()` on the client.
 */
function hkdfSalt() {
    return crypto.createHash('sha256').update(HKDF_SALT_INPUT, 'utf8').digest();
}

/** HKDF-SHA256 with the AAD as `info`, binding the key to the context. */
function deriveKey(sharedSecret, aad) {
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, hkdfSalt(), aad, DERIVED_KEY_BYTES));
}

/**
 * Seals `plaintext` for one device public key.
 *
 * @param {Buffer|Uint8Array} plaintext
 * @param {Buffer|Uint8Array} publicKey raw ML-KEM-768 public key
 * @param {Buffer} aad output of {@link secretAadBytes} or {@link sharedUseAadBytes}
 * @param {number} keyVersion
 * @param {number} entityRevision
 */
function sealEnvelope({ plaintext, publicKey, aad, keyVersion, entityRevision }) {
    const pub = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey);
    if (pub.length !== MLKEM768_PUBLIC_KEY_BYTES) {
        throw new TypeError('ML-KEM-768 public key must be ' + MLKEM768_PUBLIC_KEY_BYTES + ' bytes');
    }

    const encapsulated = ml_kem768.encapsulate(pub);
    // @noble returns { cipherText, sharedSecret }; older builds spelled it
    // `ciphertext`. Accept both rather than pinning a minor version.
    const kemCiphertext = Buffer.from(encapsulated.cipherText || encapsulated.ciphertext);
    const sharedSecret = Buffer.from(encapsulated.sharedSecret);

    const key = deriveKey(sharedSecret, aad);
    try {
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(aad);
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
            v: ENVELOPE_VERSION,
            alg: ALG,
            kem: KEM,
            aead: AEAD,
            ct: kemCiphertext.toString('base64'),
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            data: body.toString('base64'),
            aad: aad.toString('base64'),
            keyVersion,
            entityRevision,
        };
    } finally {
        key.fill(0);
        sharedSecret.fill(0);
    }
}

/**
 * Opens an envelope. Used by the push path for client-supplied secret material
 * and by the round-trip tests.
 *
 * The AAD is recomputed by the caller and compared here before any key material
 * is derived, so an envelope bound to another entity, field or revision is
 * rejected without reaching a cipher.
 */
function openEnvelope({ envelope, privateKey, expectedAad }) {
    if (!envelope || typeof envelope !== 'object') throw new TypeError('envelope required');
    if (Number(envelope.v) !== ENVELOPE_VERSION) throw new Error('unsupported envelope version');
    if (envelope.alg !== ALG || envelope.kem !== KEM || envelope.aead !== AEAD) {
        throw new Error('unsupported envelope suite');
    }

    const aad = Buffer.from(String(envelope.aad || ''), 'base64');
    if (!aadEquals(aad, expectedAad)) throw new Error('envelope AAD does not match the expected context');

    const kemCiphertext = Buffer.from(String(envelope.ct || ''), 'base64');
    if (kemCiphertext.length !== MLKEM768_CIPHERTEXT_BYTES) {
        throw new Error('ML-KEM-768 ciphertext must be ' + MLKEM768_CIPHERTEXT_BYTES + ' bytes');
    }

    const sharedSecret = Buffer.from(ml_kem768.decapsulate(kemCiphertext, privateKey));
    const key = deriveKey(sharedSecret, aad);
    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(String(envelope.iv || ''), 'base64'),
            { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(String(envelope.data || ''), 'base64')),
            decipher.final(),
        ]);
    } finally {
        key.fill(0);
        sharedSecret.fill(0);
    }
}

/** Constant-time compare, so a mismatch does not leak where it diverged. */
function aadEquals(a, b) {
    const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'base64');
    const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'base64');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

module.exports = {
    ENVELOPE_VERSION,
    ALG,
    KEM,
    AEAD,
    IV_BYTES,
    TAG_BYTES,
    DERIVED_KEY_BYTES,
    HKDF_SALT_INPUT,
    SECRET_AAD_PREFIX,
    SHARED_AAD_PREFIX,
    MLKEM768_PUBLIC_KEY_BYTES,
    MLKEM768_CIPHERTEXT_BYTES,
    secretAadBytes,
    sharedUseAadBytes,
    hkdfSalt,
    deriveKey,
    sealEnvelope,
    openEnvelope,
    aadEquals,
};
