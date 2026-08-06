/**
 * ZFT2 binary file-transfer framing — port of zephyr_agent file_transfer_protocol.dart
 * and file-transfer-protocol.js (Node).
 */

export const ZFT2_VERSION = 2;
export const ZFT2_HEADER_BYTES = 20;
export const ZFT2_FLAG_ERROR = 0x0001;
export const ZFT2_FLAG_RESPONSE = 0x0002;
export const ZFT2_MAX_META_BYTES = 256 * 1024;
export const ZFT2_MAX_PAYLOAD_BYTES = 1024 * 1024;

export const Zft2Op = Object.freeze({
  open: 0x01,
  read: 0x02,
  write: 0x03,
  close: 0x04,
  stat: 0x05,
  list: 0x06,
  mkdir: 0x07,
  delete: 0x08,
  rename: 0x09,
  truncate: 0x0a,
  cancel: 0x0b,
  ping: 0x0c,
});

const MAGIC = [0x5a, 0x46, 0x54, 0x32]; // ZFT2

function assert(cond, code, message) {
  if (!cond) {
    const err = new Error(message);
    err.code = code;
    throw err;
  }
}

export function encodeZft2Frame({ type, requestId, flags = 0, meta = {}, payload } = {}) {
  assert(type >= 0 && type <= 255, 'invalid_type', 'Invalid ZFT2 frame type');
  assert(
    requestId >= 0 && requestId <= 0xffffffff,
    'invalid_request_id',
    'Invalid ZFT2 request id',
  );
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta ?? {}));
  assert(metaBytes.length <= ZFT2_MAX_META_BYTES, 'metadata_too_large', 'ZFT2 metadata exceeds limit');
  const body = payload
    ? payload instanceof Uint8Array
      ? payload
      : new Uint8ListLike(payload)
    : new Uint8Array(0);
  assert(body.length <= ZFT2_MAX_PAYLOAD_BYTES, 'payload_too_large', 'ZFT2 payload exceeds limit');

  const out = new Uint8Array(ZFT2_HEADER_BYTES + metaBytes.length + body.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = MAGIC[2];
  out[3] = MAGIC[3];
  out[4] = ZFT2_VERSION;
  out[5] = type;
  const view = new DataView(out.buffer);
  view.setUint16(6, flags, false);
  view.setUint32(8, requestId, false);
  view.setUint32(12, metaBytes.length, false);
  view.setUint32(16, body.length, false);
  out.set(metaBytes, ZFT2_HEADER_BYTES);
  out.set(body, ZFT2_HEADER_BYTES + metaBytes.length);
  return out;
}

function Uint8ListLike(payload) {
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return Uint8Array.from(payload);
}

export function decodeZft2Frame(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  assert(bytes.length >= ZFT2_HEADER_BYTES, 'truncated_header', 'Truncated ZFT2 header');
  assert(
    bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1] && bytes[2] === MAGIC[2] && bytes[3] === MAGIC[3],
    'bad_magic',
    'Invalid ZFT2 magic',
  );
  assert(bytes[4] === ZFT2_VERSION, 'unsupported_version', `Unsupported ZFT2 version ${bytes[4]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLength = view.getUint32(12, false);
  const payloadLength = view.getUint32(16, false);
  assert(metaLength <= ZFT2_MAX_META_BYTES, 'metadata_too_large', 'ZFT2 metadata exceeds limit');
  assert(payloadLength <= ZFT2_MAX_PAYLOAD_BYTES, 'payload_too_large', 'ZFT2 payload exceeds limit');
  const expected = ZFT2_HEADER_BYTES + metaLength + payloadLength;
  assert(bytes.length === expected, 'length_mismatch', `ZFT2 frame length mismatch: expected ${expected}, got ${bytes.length}`);

  let meta = {};
  if (metaLength > 0) {
    const text = new TextDecoder().decode(bytes.subarray(ZFT2_HEADER_BYTES, ZFT2_HEADER_BYTES + metaLength));
    const decoded = JSON.parse(text);
    assert(decoded && typeof decoded === 'object' && !Array.isArray(decoded), 'invalid_metadata', 'ZFT2 metadata must be an object');
    meta = decoded;
  }
  return {
    type: bytes[5],
    requestId: view.getUint32(8, false),
    flags: view.getUint16(6, false),
    meta,
    payload: bytes.subarray(ZFT2_HEADER_BYTES + metaLength),
    get isResponse() {
      return (this.flags & ZFT2_FLAG_RESPONSE) !== 0;
    },
    get isError() {
      return (this.flags & ZFT2_FLAG_ERROR) !== 0;
    },
  };
}

export function encodeZft2Response(request, { meta = {}, payload } = {}) {
  return encodeZft2Frame({
    type: request.type,
    requestId: request.requestId,
    flags: ZFT2_FLAG_RESPONSE,
    meta,
    payload,
  });
}

export function encodeZft2Error(request, code, message, { retryable = false } = {}) {
  return encodeZft2Frame({
    type: request.type,
    requestId: request.requestId,
    flags: ZFT2_FLAG_RESPONSE | ZFT2_FLAG_ERROR,
    meta: { code, message, retryable },
  });
}

export function isZft2Bytes(raw) {
  const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null;
  if (!bytes || bytes.length < 4) return false;
  return bytes[0] === MAGIC[0] && bytes[1] === MAGIC[1] && bytes[2] === MAGIC[2] && bytes[3] === MAGIC[3];
}
