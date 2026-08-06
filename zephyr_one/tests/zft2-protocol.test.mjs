import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Zft2Op,
  encodeZft2Frame,
  decodeZft2Frame,
  encodeZft2Response,
  encodeZft2Error,
  isZft2Bytes,
  ZFT2_FLAG_RESPONSE,
  ZFT2_FLAG_ERROR,
} from '../src/js/agent/zft2.js';

test('encode/decode roundtrip with meta and payload', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeZft2Frame({
    type: Zft2Op.read,
    requestId: 42,
    flags: 0,
    meta: { handle: 'h1', offset: 0, length: 5 },
    payload,
  });
  assert.equal(frame[0], 0x5a);
  assert.equal(frame[1], 0x46);
  assert.equal(frame[2], 0x54);
  assert.equal(frame[3], 0x32);
  assert.ok(isZft2Bytes(frame));

  const decoded = decodeZft2Frame(frame);
  assert.equal(decoded.type, Zft2Op.read);
  assert.equal(decoded.requestId, 42);
  assert.equal(decoded.meta.handle, 'h1');
  assert.equal(decoded.payload.length, 5);
  assert.deepEqual([...decoded.payload], [1, 2, 3, 4, 5]);
  assert.equal(decoded.isResponse, false);
  assert.equal(decoded.isError, false);
});

test('response and error flags', () => {
  const req = { type: Zft2Op.stat, requestId: 7, flags: 0, meta: {}, payload: new Uint8Array() };
  const resp = decodeZft2Frame(encodeZft2Response(req, { meta: { size: 10 } }));
  assert.ok(resp.flags & ZFT2_FLAG_RESPONSE);
  assert.equal(resp.meta.size, 10);

  const err = decodeZft2Frame(encodeZft2Error(req, 'not_found', 'missing'));
  assert.ok(err.flags & ZFT2_FLAG_RESPONSE);
  assert.ok(err.flags & ZFT2_FLAG_ERROR);
  assert.equal(err.meta.code, 'not_found');
});

test('rejects bad magic', () => {
  const bad = new Uint8Array(20);
  assert.throws(() => decodeZft2Frame(bad), /magic/i);
});

test('rejects length mismatch', () => {
  const frame = encodeZft2Frame({ type: Zft2Op.ping, requestId: 1, meta: { a: 1 } });
  const truncated = frame.subarray(0, frame.length - 1);
  assert.throws(() => decodeZft2Frame(truncated), /length|Truncated|mismatch/i);
});
