import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cdc = require(path.join(root, 'link-v2-cdc.js'));
const cbor = require(path.join(root, 'link-v2-cbor.js'));
const codec = require(path.join(root, 'link-v2-codec.js'));
const zsl = require(path.join(root, 'link-v2-zsl.js'));

test('canonical CBOR is deterministic and round-trips', () => {
  const body = { k: 1, v: 2, nested: { z: 'ok', a: [1, 2, 3] }, bin: Buffer.from('hi') };
  const a = cbor.encode(body);
  const b = cbor.encode(body);
  assert.deepEqual(a, b);
  const decoded = cbor.decode(a);
  assert.equal(decoded.k, 1);
  assert.equal(decoded.nested.z, 'ok');
  assert.equal(Buffer.from(decoded.bin).toString(), 'hi');
});

test('CBOR rejects floats and trailing bytes', () => {
  assert.throws(() => cbor.encode(1.5), /unsupported|integer/);
  const encoded = cbor.encode({ a: 1 });
  assert.throws(() => cbor.decode(Buffer.concat([encoded, Buffer.from([0])])), /trailing/);
});

test('CDC splits on content and keyed IDs are account-scoped', () => {
  const pattern = Buffer.alloc(80_000);
  for (let i = 0; i < pattern.length; i += 1) pattern[i] = (i * 13 + 7) & 0xff;
  const a = Buffer.concat([pattern, Buffer.from('edit-marker-unique'), pattern]);
  const b = Buffer.concat([Buffer.from('prefix-insert'), a]);
  const keyA = Buffer.from('account-a');
  const keyB = Buffer.from('account-b');
  const manA = cdc.buildManifest(a, { accountKey: keyA });
  const manB = cdc.buildManifest(b, { accountKey: keyA });
  assert.ok(manA.chunks.length >= 4);
  assert.equal(manA.merkle.length, 64);
  assert.equal(manA.sha256, cdc.sha256Hex(a));
  const foreign = cdc.buildManifest(a, { accountKey: keyB });
  assert.notEqual(manA.chunks[0].keyedId, foreign.chunks[0].keyedId);
  const missing = cdc.missingChunks(manB, manA.chunks.map((c) => c.keyedId));
  assert.ok(missing.length >= 1);
  assert.ok(missing.length <= manB.chunks.length);
  assert.deepEqual(cdc.buildManifest(a, { accountKey: keyA }), manA);
  const sizes = manA.chunks.map((chunk) => chunk.size);
  assert.ok(sizes.some((size) => size < manA.maxChunk), 'CDC must cut before max on mixed content');
});

test('codec compresses large metadata but never secrets', () => {
  const large = { note: 'x'.repeat(2000), n: 7 };
  const packed = codec.pack({ kind: codec.KIND.SYNC_OP, body: large });
  const frame = cbor.decode(packed);
  assert.equal(frame.f & codec.FLAG_ZSTD, codec.FLAG_ZSTD);
  const unpacked = codec.unpack(packed);
  assert.equal(unpacked.body.n, 7);
  assert.equal(unpacked.body.note.length, 2000);

  const secret = codec.pack({ kind: codec.KIND.SYNC_OP, body: large, secret: true });
  const secretFrame = cbor.decode(secret);
  assert.equal(secretFrame.f & codec.FLAG_ZSTD, 0);
  assert.equal(secretFrame.f & codec.FLAG_SECRET, codec.FLAG_SECRET);
});

test('ZSL/2 hybrid handshake yields a working bidirectional session', () => {
  const initiator = zsl.handshakeInitiator();
  const responder = zsl.handshakeResponder({
    x25519Public: initiator.x25519Public,
    mlkemPublic: initiator.mlkemPublic,
  });
  const client = zsl.handshakeFinish(initiator, responder);
  const server = responder.session;
  assert.deepEqual(client.exporter, server.exporter);

  const sealed = client.seal(Buffer.from('ping'));
  assert.equal(server.open(sealed).toString(), 'ping');
  const reply = server.seal(Buffer.from('pong'));
  assert.equal(client.open(reply).toString(), 'pong');
  assert.throws(() => server.open(sealed), /replay/);
});

test('ZSL/2 + codec: encrypted CBOR frame cannot be opened with the wrong session', () => {
  const aInit = zsl.handshakeInitiator();
  const aResp = zsl.handshakeResponder({ x25519Public: aInit.x25519Public, mlkemPublic: aInit.mlkemPublic });
  const aClient = zsl.handshakeFinish(aInit, aResp);
  const bInit = zsl.handshakeInitiator();
  const bResp = zsl.handshakeResponder({ x25519Public: bInit.x25519Public, mlkemPublic: bInit.mlkemPublic });
  const packed = codec.pack({ kind: codec.KIND.BLOB_MANIFEST, body: { sha256: 'aa', n: 1 } });
  const sealed = aClient.seal(packed);
  assert.throws(() => bResp.session.open(sealed));
  const opened = aResp.session.open(sealed);
  const frame = codec.unpack(opened);
  assert.equal(frame.kind, codec.KIND.BLOB_MANIFEST);
  assert.equal(frame.body.n, 1);
});
