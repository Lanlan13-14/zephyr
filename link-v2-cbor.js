/**
 * Canonical CBOR encoder/decoder for Link v2 frames.
 *
 * JSON is rejected on the hot path: integer registry IDs, not string type
 * names. Encoding is deterministic (sorted map keys, shortest integer form)
 * so two equal values produce identical bytes for hashing and compression.
 *
 * Only the types we actually put on the wire are accepted: unsigned/negative
 * integers, byte strings, UTF-8 text, arrays, maps with string or integer
 * keys, booleans, null. Floats, tags, indefinite lengths and bignums fail
 * closed — a future type must be added here, not inferred.
 */
'use strict';

class CborError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CborError';
        this.code = 'invalid_cbor';
    }
}

function encodeUnsigned(major, value) {
    if (value < 24) return Buffer.from([(major << 5) | value]);
    if (value < 256) return Buffer.from([(major << 5) | 24, value]);
    if (value < 65536) {
        const buf = Buffer.alloc(3);
        buf[0] = (major << 5) | 25;
        buf.writeUInt16BE(value, 1);
        return buf;
    }
    if (value <= 0xffffffff) {
        const buf = Buffer.alloc(5);
        buf[0] = (major << 5) | 26;
        buf.writeUInt32BE(value, 1);
        return buf;
    }
    const buf = Buffer.alloc(9);
    buf[0] = (major << 5) | 27;
    buf.writeBigUInt64BE(BigInt(value), 1);
    return buf;
}

function encodeInteger(value) {
    if (!Number.isSafeInteger(value)) throw new CborError('integer is not a safe integer');
    if (value >= 0) return encodeUnsigned(0, value);
    return encodeUnsigned(1, -1 - value);
}

function keySort(a, b) {
    const aBuf = encode(a);
    const bBuf = encode(b);
    const n = Math.min(aBuf.length, bBuf.length);
    for (let i = 0; i < n; i += 1) {
        if (aBuf[i] !== bBuf[i]) return aBuf[i] - bBuf[i];
    }
    return aBuf.length - bBuf.length;
}

function encode(value) {
    if (value === null) return Buffer.from([0xf6]);
    if (value === true) return Buffer.from([0xf5]);
    if (value === false) return Buffer.from([0xf4]);
    if (typeof value === 'number') return encodeInteger(value);
    if (typeof value === 'string') {
        const text = Buffer.from(value, 'utf8');
        return Buffer.concat([encodeUnsigned(3, text.length), text]);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return Buffer.concat([encodeUnsigned(2, bytes.length), bytes]);
    }
    if (Array.isArray(value)) {
        const parts = [encodeUnsigned(4, value.length)];
        for (const item of value) parts.push(encode(item));
        return Buffer.concat(parts);
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort(keySort);
        const parts = [encodeUnsigned(5, keys.length)];
        for (const key of keys) {
            const numeric = /^(0|[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key));
            parts.push(encode(numeric ? Number(key) : key));
            parts.push(encode(value[key]));
        }
        return Buffer.concat(parts);
    }
    throw new CborError('unsupported CBOR value type: ' + typeof value);
}

function readLength(buf, offset, additional) {
    if (additional < 24) return { value: additional, offset };
    if (additional === 24) {
        if (offset >= buf.length) throw new CborError('truncated CBOR');
        return { value: buf[offset], offset: offset + 1 };
    }
    if (additional === 25) {
        if (offset + 2 > buf.length) throw new CborError('truncated CBOR');
        return { value: buf.readUInt16BE(offset), offset: offset + 2 };
    }
    if (additional === 26) {
        if (offset + 4 > buf.length) throw new CborError('truncated CBOR');
        return { value: buf.readUInt32BE(offset), offset: offset + 4 };
    }
    if (additional === 27) {
        if (offset + 8 > buf.length) throw new CborError('truncated CBOR');
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR integer exceeds safe integer');
        return { value: Number(big), offset: offset + 8 };
    }
    throw new CborError('indefinite CBOR is not allowed');
}

function decodeAt(buf, offset) {
    if (offset >= buf.length) throw new CborError('truncated CBOR');
    const initial = buf[offset];
    offset += 1;
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (major === 7) {
        if (additional === 20) return { value: false, offset };
        if (additional === 21) return { value: true, offset };
        if (additional === 22) return { value: null, offset };
        throw new CborError('unsupported simple/float CBOR');
    }
    const length = readLength(buf, offset, additional);
    offset = length.offset;
    if (major === 0) return { value: length.value, offset };
    if (major === 1) return { value: -1 - length.value, offset };
    if (major === 2) {
        const end = offset + length.value;
        if (end > buf.length) throw new CborError('truncated byte string');
        return { value: Buffer.from(buf.subarray(offset, end)), offset: end };
    }
    if (major === 3) {
        const end = offset + length.value;
        if (end > buf.length) throw new CborError('truncated text string');
        return { value: buf.subarray(offset, end).toString('utf8'), offset: end };
    }
    if (major === 4) {
        const items = [];
        for (let i = 0; i < length.value; i += 1) {
            const next = decodeAt(buf, offset);
            items.push(next.value);
            offset = next.offset;
        }
        return { value: items, offset };
    }
    if (major === 5) {
        const object = {};
        for (let i = 0; i < length.value; i += 1) {
            const key = decodeAt(buf, offset);
            const val = decodeAt(buf, key.offset);
            object[String(key.value)] = val.value;
            offset = val.offset;
        }
        return { value: object, offset };
    }
    throw new CborError('unsupported CBOR major type ' + major);
}

function decode(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const result = decodeAt(buf, 0);
    if (result.offset !== buf.length) throw new CborError('trailing CBOR bytes');
    return result.value;
}

module.exports = { encode, decode, CborError };
