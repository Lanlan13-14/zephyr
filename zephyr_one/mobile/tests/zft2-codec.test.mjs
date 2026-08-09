// ZFT2 must stay byte-compatible with the JS and Dart implementations already in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as zft2 from '../tools/lib/zft2.mjs';
import { zft2Frames } from '../tools/lib/fixtures.mjs';

const require = createRequire(import.meta.url);
const legacy = require('../../../file-transfer-protocol.js');

test('wire constants match the frozen spec', () => {
  assert.equal(zft2.MAGIC.toString('ascii'), 'ZFT2');
  assert.equal(zft2.VERSION, 2);
  assert.equal(zft2.HEADER_BYTES, 20);
  assert.equal(zft2.FLAG_ERROR, 0x0001);
  assert.equal(zft2.FLAG_RESPONSE, 0x0002);
  assert.equal(zft2.MAX_META_BYTES, 256 * 1024);
  assert.equal(zft2.MAX_PAYLOAD_BYTES, 1024 * 1024);
  assert.deepEqual(zft2.OP, {
    OPEN: 0x01, READ: 0x02, WRITE: 0x03, CLOSE: 0x04, STAT: 0x05, LIST: 0x06,
    MKDIR: 0x07, DELETE: 0x08, RENAME: 0x09, TRUNCATE: 0x0a, CANCEL: 0x0b, PING: 0x0c,
  });
});

test('opcodes and header layout agree with the existing Zephyr JS implementation', () => {
  assert.equal(legacy.MAGIC.toString('ascii'), zft2.MAGIC.toString('ascii'));
  assert.equal(legacy.VERSION, zft2.VERSION);
  assert.equal(legacy.HEADER_BYTES, zft2.HEADER_BYTES);
  assert.equal(legacy.FLAG_ERROR, zft2.FLAG_ERROR);
  assert.equal(legacy.FLAG_RESPONSE, zft2.FLAG_RESPONSE);
  assert.deepEqual(legacy.OP, zft2.OP);
});

test('frames encoded here decode identically in the existing JS implementation', () => {
  const frame = zft2.encodeFrame({
    type: zft2.OP.WRITE,
    requestId: 4242,
    flags: 0,
    meta: { handle: 3, offset: 128 },
    payload: Buffer.from('payload-bytes', 'utf8'),
  });
  const decoded = legacy.decodeFrame(frame);
  assert.equal(decoded.type, zft2.OP.WRITE);
  assert.equal(decoded.requestId, 4242);
  assert.deepEqual(decoded.meta, { handle: 3, offset: 128 });
  assert.equal(decoded.payload.toString('utf8'), 'payload-bytes');
});

test('frames encoded by the existing JS implementation decode here', () => {
  const frame = legacy.encodeFrame({
    type: legacy.OP.LIST,
    requestId: 7,
    flags: legacy.FLAG_RESPONSE,
    meta: { entries: [{ name: 'a.txt', size: 12 }] },
    payload: null,
  });
  const decoded = zft2.decodeFrame(frame);
  assert.equal(decoded.type, zft2.OP.LIST);
  assert.equal(zft2.isResponse(decoded), true);
  assert.equal(zft2.isError(decoded), false);
  assert.deepEqual(decoded.meta.entries[0], { name: 'a.txt', size: 12 });
});

test('round trip preserves unicode metadata and binary payloads', () => {
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
  const frame = zft2.encodeFrame({
    type: zft2.OP.READ,
    requestId: 0xffffffff,
    meta: { path: '/\u4e2d\u6587/\u30c6\u30b9\u30c8.txt' },
    payload,
  });
  const decoded = zft2.decodeFrame(frame);
  assert.equal(decoded.requestId, 0xffffffff);
  assert.equal(decoded.meta.path, '/\u4e2d\u6587/\u30c6\u30b9\u30c8.txt');
  assert.deepEqual([...decoded.payload], [...payload]);
});

test('malformed frames fail with specific codes, never generic errors', () => {
  const cases = [
    [Buffer.from('ZFT'), 'truncated_header'],
    [Buffer.concat([Buffer.from('XFT2'), Buffer.alloc(16)]), 'bad_magic'],
  ];
  for (const [raw, code] of cases) {
    assert.throws(() => zft2.decodeFrame(raw), (err) => err.code === code, code);
  }

  const badVersion = Buffer.alloc(zft2.HEADER_BYTES);
  zft2.MAGIC.copy(badVersion, 0);
  badVersion[4] = 3;
  assert.throws(() => zft2.decodeFrame(badVersion), (err) => err.code === 'unsupported_version');

  const truncatedBody = zft2.encodeFrame({ type: zft2.OP.PING, requestId: 1, meta: { a: 1 } });
  assert.throws(
    () => zft2.decodeFrame(truncatedBody.subarray(0, truncatedBody.length - 1)),
    (err) => err.code === 'length_mismatch',
  );
});

test('length bombs are rejected before allocation', () => {
  const bomb = Buffer.alloc(zft2.HEADER_BYTES);
  zft2.MAGIC.copy(bomb, 0);
  bomb[4] = zft2.VERSION;
  bomb[5] = zft2.OP.READ;
  bomb.writeUInt32BE(0xfffffff0, 12);
  assert.throws(() => zft2.decodeFrame(bomb), (err) => err.code === 'metadata_too_large');

  const payloadBomb = Buffer.alloc(zft2.HEADER_BYTES);
  zft2.MAGIC.copy(payloadBomb, 0);
  payloadBomb[4] = zft2.VERSION;
  payloadBomb[5] = zft2.OP.READ;
  payloadBomb.writeUInt32BE(0xfffffff0, 16);
  assert.throws(() => zft2.decodeFrame(payloadBomb), (err) => err.code === 'payload_too_large');

  assert.throws(
    () => zft2.encodeFrame({ type: zft2.OP.WRITE, requestId: 1, payload: Buffer.alloc(zft2.MAX_PAYLOAD_BYTES + 1) }),
    (err) => err.code === 'payload_too_large',
  );
});

test('write opcodes are identified so readOnly providers can reject them', () => {
  for (const op of [zft2.OP.WRITE, zft2.OP.MKDIR, zft2.OP.DELETE, zft2.OP.RENAME, zft2.OP.TRUNCATE]) {
    assert.equal(zft2.isWriteOp(op), true, 'op ' + op + ' must count as a write');
  }
  for (const op of [zft2.OP.OPEN, zft2.OP.READ, zft2.OP.CLOSE, zft2.OP.STAT, zft2.OP.LIST, zft2.OP.CANCEL, zft2.OP.PING]) {
    assert.equal(zft2.isWriteOp(op), false, 'op ' + op + ' must not count as a write');
  }
});

test('inflight clamps to 1..16 and chunk size takes the smaller capability', () => {
  assert.equal(zft2.clampInflight(0), 1);
  assert.equal(zft2.clampInflight(99), 16);
  assert.equal(zft2.clampInflight(8), 8);
  assert.equal(zft2.clampInflight('not-a-number'), zft2.MAX_INFLIGHT_DEFAULT);
  assert.equal(zft2.negotiateChunk(1024, 4096), 1024);
  assert.equal(zft2.negotiateChunk(zft2.MAX_PAYLOAD_BYTES * 4, zft2.MAX_PAYLOAD_BYTES * 2), zft2.MAX_PAYLOAD_BYTES);
});

test('error responses carry the response and error flags plus a stable code', () => {
  const request = { type: zft2.OP.WRITE, requestId: 11 };
  const decoded = zft2.decodeFrame(zft2.encodeError(request, 'read_only_share', 'provider is read only'));
  assert.equal(zft2.isResponse(decoded), true);
  assert.equal(zft2.isError(decoded), true);
  assert.equal(decoded.meta.code, 'read_only_share');
});

test('generated fixtures decode to the values Kotlin and Swift will assert', () => {
  const fixture = zft2Frames();
  for (const frame of fixture.frames) {
    const bytes = Buffer.from(frame.expectedHex, 'hex');
    assert.equal(bytes.length, frame.expectedLength, frame.name);
    const decoded = zft2.decodeFrame(bytes);
    assert.equal(decoded.type, frame.type, frame.name + ' type');
    assert.equal(decoded.requestId, frame.requestId, frame.name + ' requestId');
    assert.equal(decoded.flags, frame.flags, frame.name + ' flags');
    assert.deepEqual(decoded.meta, frame.meta, frame.name + ' meta');
    if (frame.payloadUtf8 != null) assert.equal(decoded.payload.toString('utf8'), frame.payloadUtf8, frame.name + ' payload');
  }
  for (const bad of fixture.rejects) {
    assert.throws(
      () => zft2.decodeFrame(Buffer.from(bad.hex, 'hex')),
      (err) => err.code === bad.expectedCode,
      bad.name + ' expected ' + bad.expectedCode,
    );
  }
});
