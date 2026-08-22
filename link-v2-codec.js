/**
 * Link v2 wire codec: CBOR + optional stateless zstd, then ZSL/2 AEAD.
 *
 * Compression happens before encryption. Secrets and attacker-controlled
 * reflection data never share a compression context with ordinary metadata.
 * Frames under MIN_COMPRESS_BYTES stay uncompressed.
 */
'use strict';

const zlib = require('zlib');
const { encode, decode } = require('./link-v2-cbor');

const MIN_COMPRESS_BYTES = 256;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_DECOMPRESS_RATIO = 256;

const KIND = Object.freeze({
    SYNC_OP: 1,
    SYNC_ACK: 2,
    BLOB_MANIFEST: 3,
    BLOB_CHUNK: 4,
    BLOB_HAVE: 5,
    WAKE: 6,
    RELAY: 7,
});

const FLAG_ZSTD = 0x01;
const FLAG_SECRET = 0x02;

function shouldCompress(bytes, flags) {
    if (flags & FLAG_SECRET) return false;
    return bytes.length >= MIN_COMPRESS_BYTES;
}

function compress(bytes) {
    return zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
}

function decompress(bytes, originalSizeHint) {
    if (originalSizeHint && originalSizeHint > MAX_FRAME_BYTES) {
        throw new Error('decompressed frame exceeds max size');
    }
    const out = zlib.zstdDecompressSync(bytes);
    if (out.length > MAX_FRAME_BYTES) throw new Error('decompressed frame exceeds max size');
    if (bytes.length > 0 && out.length / bytes.length > MAX_DECOMPRESS_RATIO) {
        throw new Error('decompression ratio exceeds hard limit');
    }
    return out;
}

function pack({ kind, body, secret = false }) {
    if (!Number.isInteger(kind) || kind < 1) throw new TypeError('kind must be a registry integer');
    const payload = encode(body);
    if (payload.length > MAX_FRAME_BYTES) throw new Error('frame exceeds max size');
    let flags = secret ? FLAG_SECRET : 0;
    let data = payload;
    if (shouldCompress(payload, flags)) {
        const compressed = compress(payload);
        if (compressed.length < payload.length) {
            flags |= FLAG_ZSTD;
            data = compressed;
        }
    }
    return encode({
        v: 2,
        k: kind,
        f: flags,
        n: payload.length,
        d: data,
    });
}

function unpack(bytes) {
    const frame = decode(bytes);
    if (!frame || Number(frame.v) !== 2) throw new Error('unsupported Link frame version');
    const kind = Number(frame.k);
    const flags = Number(frame.f) || 0;
    const original = Number(frame.n) || 0;
    if (original > MAX_FRAME_BYTES) throw new Error('frame exceeds max size');
    let payload = Buffer.isBuffer(frame.d) ? frame.d : Buffer.from(frame.d || []);
    if (flags & FLAG_ZSTD) payload = decompress(payload, original);
    if (payload.length !== original) throw new Error('frame length mismatch');
    return {
        kind,
        flags,
        secret: !!(flags & FLAG_SECRET),
        body: decode(payload),
    };
}

module.exports = {
    KIND,
    FLAG_ZSTD,
    FLAG_SECRET,
    MIN_COMPRESS_BYTES,
    MAX_FRAME_BYTES,
    MAX_DECOMPRESS_RATIO,
    pack,
    unpack,
    compress,
    decompress,
    shouldCompress,
};
