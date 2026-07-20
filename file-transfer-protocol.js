'use strict';

const MAGIC = Buffer.from('ZFT2');
const VERSION = 2;
const HEADER_BYTES = 20;
const FLAG_ERROR = 0x0001;
const FLAG_RESPONSE = 0x0002;
const MAX_META_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const OP = Object.freeze({
    OPEN: 0x01,
    READ: 0x02,
    WRITE: 0x03,
    CLOSE: 0x04,
    STAT: 0x05,
    LIST: 0x06,
    MKDIR: 0x07,
    DELETE: 0x08,
    RENAME: 0x09,
    TRUNCATE: 0x0a,
    CANCEL: 0x0b,
    PING: 0x0c,
});

class Zft2ProtocolError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function encodeFrame({ type, requestId, flags = 0, meta = {}, payload = null }) {
    const op = Number(type);
    const id = Number(requestId);
    if (!Number.isInteger(op) || op < 0 || op > 255) throw new Zft2ProtocolError('invalid_type', 'Invalid ZFT2 frame type');
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Zft2ProtocolError('invalid_request_id', 'Invalid ZFT2 request id');
    const metaBytes = Buffer.from(JSON.stringify(meta || {}), 'utf8');
    const payloadBytes = payload == null ? Buffer.alloc(0) : Buffer.from(payload);
    if (metaBytes.length > MAX_META_BYTES) throw new Zft2ProtocolError('metadata_too_large', 'ZFT2 metadata exceeds limit');
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw new Zft2ProtocolError('payload_too_large', 'ZFT2 payload exceeds limit');
    const out = Buffer.allocUnsafe(HEADER_BYTES + metaBytes.length + payloadBytes.length);
    MAGIC.copy(out, 0);
    out[4] = VERSION;
    out[5] = op;
    out.writeUInt16BE(Number(flags) & 0xffff, 6);
    out.writeUInt32BE(id >>> 0, 8);
    out.writeUInt32BE(metaBytes.length, 12);
    out.writeUInt32BE(payloadBytes.length, 16);
    metaBytes.copy(out, HEADER_BYTES);
    payloadBytes.copy(out, HEADER_BYTES + metaBytes.length);
    return out;
}

function decodeFrame(raw, limits = {}) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
    if (buf.length < HEADER_BYTES) throw new Zft2ProtocolError('truncated_header', 'Truncated ZFT2 header');
    if (!buf.subarray(0, 4).equals(MAGIC)) throw new Zft2ProtocolError('bad_magic', 'Invalid ZFT2 magic');
    if (buf[4] !== VERSION) throw new Zft2ProtocolError('unsupported_version', `Unsupported ZFT2 version ${buf[4]}`);
    const metaLength = buf.readUInt32BE(12);
    const payloadLength = buf.readUInt32BE(16);
    const maxMeta = Number(limits.maxMetaBytes || MAX_META_BYTES);
    const maxPayload = Number(limits.maxPayloadBytes || MAX_PAYLOAD_BYTES);
    if (metaLength > maxMeta) throw new Zft2ProtocolError('metadata_too_large', 'ZFT2 metadata exceeds limit');
    if (payloadLength > maxPayload) throw new Zft2ProtocolError('payload_too_large', 'ZFT2 payload exceeds limit');
    const expected = HEADER_BYTES + metaLength + payloadLength;
    if (buf.length !== expected) throw new Zft2ProtocolError('length_mismatch', `ZFT2 frame length mismatch: expected ${expected}, got ${buf.length}`);
    let meta = {};
    if (metaLength) {
        try {
            meta = JSON.parse(buf.subarray(HEADER_BYTES, HEADER_BYTES + metaLength).toString('utf8'));
        } catch {
            throw new Zft2ProtocolError('invalid_metadata', 'Invalid ZFT2 metadata JSON');
        }
        if (!meta || Array.isArray(meta) || typeof meta !== 'object') throw new Zft2ProtocolError('invalid_metadata', 'ZFT2 metadata must be an object');
    }
    return {
        version: buf[4],
        type: buf[5],
        flags: buf.readUInt16BE(6),
        requestId: buf.readUInt32BE(8),
        meta,
        payload: buf.subarray(HEADER_BYTES + metaLength),
    };
}

function responseFrame(request, meta = {}, payload = null) {
    return encodeFrame({ type: request.type, requestId: request.requestId, flags: FLAG_RESPONSE, meta, payload });
}

function errorFrame(request, code, message, retryable = false) {
    return encodeFrame({
        type: request?.type || 0,
        requestId: request?.requestId || 0,
        flags: FLAG_RESPONSE | FLAG_ERROR,
        meta: { code: String(code || 'internal_error'), message: String(message || 'File transfer failed'), retryable: !!retryable },
    });
}

module.exports = {
    MAGIC, VERSION, HEADER_BYTES, FLAG_ERROR, FLAG_RESPONSE,
    MAX_META_BYTES, MAX_PAYLOAD_BYTES, OP,
    Zft2ProtocolError, encodeFrame, decodeFrame, responseFrame, errorFrame,
};
