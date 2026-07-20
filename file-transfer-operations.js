'use strict';

const {
    OP, MAX_PAYLOAD_BYTES, Zft2ProtocolError,
} = require('./file-transfer-protocol');

function asString(value, max = 4096) {
    return String(value == null ? '' : value).slice(0, max);
}

function asSafeInteger(value, fallback = 0) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function mapRequest(frame) {
    const meta = frame.meta || {};
    switch (frame.type) {
        case OP.OPEN: return { method: 'open', params: { path: asString(meta.path), mode: asString(meta.mode, 32) || 'read' } };
        case OP.READ: return { method: 'readBinary', binaryRead: true, params: { handle: asString(meta.handle, 256), offset: asSafeInteger(meta.offset), length: Math.min(MAX_PAYLOAD_BYTES, asSafeInteger(meta.length)) } };
        case OP.WRITE: return { method: 'writeBinary', binaryWrite: true, params: { handle: asString(meta.handle, 256), offset: asSafeInteger(meta.offset), data: frame.payload } };
        case OP.CLOSE: return { method: 'close', params: { handle: asString(meta.handle, 256) } };
        case OP.STAT: return { method: 'stat', params: { path: asString(meta.path) } };
        case OP.LIST: return { method: 'list', params: { path: asString(meta.path) || '/' } };
        case OP.MKDIR: return { method: 'mkdir', params: { path: asString(meta.path) } };
        case OP.DELETE: return { method: 'delete', params: { path: asString(meta.path), recursive: !!meta.recursive } };
        case OP.RENAME: return { method: 'rename', params: { oldPath: asString(meta.oldPath), newPath: asString(meta.newPath) } };
        case OP.TRUNCATE: return { method: 'truncate', params: { path: asString(meta.path), size: asSafeInteger(meta.size) } };
        case OP.PING: return { method: 'ping', local: true, params: {} };
        default: throw new Zft2ProtocolError('unsupported_operation', `Unsupported ZFT2 operation ${frame.type}`);
    }
}

module.exports = { asString, asSafeInteger, mapRequest };
