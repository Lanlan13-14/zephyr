// ZFT2 reference codec. Byte-compatible with ../../file-transfer-protocol.js and
// ../../zephyr_agent/lib/agent/file_transfer_protocol.dart.
// Frozen by ZEPHYR_PARITY.md 10.2: magic ZFT2, version 2, 20-byte big-endian header.

export const MAGIC = Buffer.from('ZFT2', 'ascii');
export const VERSION = 2;
export const HEADER_BYTES = 20;
export const FLAG_ERROR = 0x0001;
export const FLAG_RESPONSE = 0x0002;
export const MAX_META_BYTES = 256 * 1024;
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_INFLIGHT_MIN = 1;
export const MAX_INFLIGHT_MAX = 16;
export const MAX_INFLIGHT_DEFAULT = 8;

export const OP = Object.freeze({
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

/** Write operations a readOnly provider must reject at the provider layer, not only in UI. */
export const WRITE_OPS = Object.freeze([OP.WRITE, OP.MKDIR, OP.DELETE, OP.RENAME, OP.TRUNCATE]);

export class Zft2Error extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function encodeFrame({ type, requestId, flags = 0, meta = {}, payload = null }) {
  const op = Number(type);
  const id = Number(requestId);
  if (!Number.isInteger(op) || op < 0 || op > 0xff) throw new Zft2Error('invalid_type', 'Invalid ZFT2 frame type');
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new Zft2Error('invalid_request_id', 'Invalid ZFT2 request id');
  const metaBytes = Buffer.from(JSON.stringify(meta ?? {}), 'utf8');
  const payloadBytes = payload == null ? Buffer.alloc(0) : Buffer.from(payload);
  if (metaBytes.length > MAX_META_BYTES) throw new Zft2Error('metadata_too_large', 'ZFT2 metadata exceeds limit');
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw new Zft2Error('payload_too_large', 'ZFT2 payload exceeds limit');
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

export function decodeFrame(raw, limits = {}) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? []);
  if (buf.length < HEADER_BYTES) throw new Zft2Error('truncated_header', 'Truncated ZFT2 header');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Zft2Error('bad_magic', 'Invalid ZFT2 magic');
  if (buf[4] !== VERSION) throw new Zft2Error('unsupported_version', `Unsupported ZFT2 version ${buf[4]}`);
  const metaLength = buf.readUInt32BE(12);
  const payloadLength = buf.readUInt32BE(16);
  const maxMeta = Number(limits.maxMetaBytes ?? MAX_META_BYTES);
  const maxPayload = Number(limits.maxPayloadBytes ?? MAX_PAYLOAD_BYTES);
  if (metaLength > maxMeta) throw new Zft2Error('metadata_too_large', 'ZFT2 metadata exceeds limit');
  if (payloadLength > maxPayload) throw new Zft2Error('payload_too_large', 'ZFT2 payload exceeds limit');
  const expected = HEADER_BYTES + metaLength + payloadLength;
  if (buf.length !== expected) throw new Zft2Error('length_mismatch', 'ZFT2 frame length mismatch');
  let meta;
  try {
    meta = metaLength === 0 ? {} : JSON.parse(buf.subarray(HEADER_BYTES, HEADER_BYTES + metaLength).toString('utf8'));
  } catch {
    throw new Zft2Error('bad_metadata', 'ZFT2 metadata is not valid JSON');
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

export const isResponse = (frame) => (frame.flags & FLAG_RESPONSE) !== 0;
export const isError = (frame) => (frame.flags & FLAG_ERROR) !== 0;
export const isWriteOp = (type) => WRITE_OPS.includes(Number(type));

export function clampInflight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_INFLIGHT_DEFAULT;
  return Math.min(MAX_INFLIGHT_MAX, Math.max(MAX_INFLIGHT_MIN, Math.trunc(n)));
}

/** Negotiated chunk size is the minimum of both peers' capability. */
export function negotiateChunk(localMax, remoteMax) {
  const local = Number(localMax ?? MAX_PAYLOAD_BYTES);
  const remote = Number(remoteMax ?? MAX_PAYLOAD_BYTES);
  return Math.max(1, Math.min(MAX_PAYLOAD_BYTES, local, remote));
}

export function encodeResponse(request, meta = {}, payload = null) {
  return encodeFrame({ type: request.type, requestId: request.requestId, flags: FLAG_RESPONSE, meta, payload });
}

export function encodeError(request, code, message) {
  return encodeFrame({
    type: request.type,
    requestId: request.requestId,
    flags: FLAG_RESPONSE | FLAG_ERROR,
    meta: { code, message },
  });
}
