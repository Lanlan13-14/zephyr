import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OP, FLAG_ERROR, FLAG_RESPONSE, MAX_PAYLOAD_BYTES,
  Zft2ProtocolError, encodeFrame, decodeFrame, responseFrame, errorFrame,
} from '../file-transfer-protocol.js';
import { mapRequest } from '../file-transfer-operations.js';

test('ZFT2 round-trips metadata and binary payload', () => {
  const frame = encodeFrame({
    type: OP.WRITE,
    requestId: 0xfeedbeef,
    meta: { handle: 'h1', offset: 0x100000000, mode: 'write' },
    payload: Buffer.from([0, 1, 2, 253, 254, 255]),
  });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, OP.WRITE);
  assert.equal(decoded.requestId, 0xfeedbeef);
  assert.deepEqual(decoded.meta, { handle: 'h1', offset: 0x100000000, mode: 'write' });
  assert.deepEqual([...decoded.payload], [0, 1, 2, 253, 254, 255]);
});

test('ZFT2 rejects truncation, bad magic, duplicate lengths, and oversized payloads', () => {
  assert.throws(() => decodeFrame(Buffer.alloc(3)), (error) => error instanceof Zft2ProtocolError && error.code === 'truncated_header');
  assert.throws(() => decodeFrame(Buffer.alloc(20)), (error) => error instanceof Zft2ProtocolError && error.code === 'bad_magic');
  const frame = encodeFrame({ type: OP.READ, requestId: 1, meta: { length: 3 } });
  const broken = Buffer.from(frame);
  broken.writeUInt32BE(4, 16);
  assert.throws(() => decodeFrame(broken), (error) => error instanceof Zft2ProtocolError && error.code === 'length_mismatch');
  assert.throws(() => encodeFrame({ type: OP.WRITE, requestId: 1, payload: Buffer.alloc(MAX_PAYLOAD_BYTES + 1) }), /payload exceeds limit/);
});

test('ZFT2 response and error frames preserve direction flags', () => {
  const request = decodeFrame(encodeFrame({ type: OP.READ, requestId: 9, meta: { length: 2 } }));
  const response = decodeFrame(responseFrame(request, { bytesRead: 2 }, Buffer.from('ok')));
  assert.equal(response.flags, FLAG_RESPONSE);
  assert.deepEqual([...response.payload], [...Buffer.from('ok')]);
  const error = decodeFrame(errorFrame(request, 'timeout', 'slow', true));
  assert.equal(error.flags, FLAG_RESPONSE | FLAG_ERROR);
  assert.deepEqual(error.meta, { code: 'timeout', message: 'slow', retryable: true });
});

test('ZFT2 operation mapping keeps content binary and metadata structured', () => {
  const read = mapRequest({ type: OP.READ, requestId: 1, meta: { handle: 'h', offset: 17, length: 4096 }, payload: Buffer.alloc(0) });
  assert.equal(read.method, 'readBinary');
  assert.deepEqual(read.params, { handle: 'h', offset: 17, length: 4096 });
  const write = mapRequest({ type: OP.WRITE, requestId: 2, meta: { handle: 'h', offset: 17 }, payload: Buffer.from([1, 2]) });
  assert.equal(write.method, 'writeBinary');
  assert.deepEqual([...write.params.data], [1, 2]);
  assert.throws(() => mapRequest({ type: 0xff, requestId: 3, meta: {}, payload: Buffer.alloc(0) }), /Unsupported ZFT2/);
});
