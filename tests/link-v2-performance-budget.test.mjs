import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codec = require(path.join(root, 'link-v2-codec.js'));
const zsl = require(path.join(root, 'link-v2-zsl.js'));
const cdc = require(path.join(root, 'link-v2-cdc.js'));

function percentile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function time(fn, n) {
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples;
}

test('small metadata frames pack/unpack well under the 300ms sync budget', () => {
  const body = { op: 1, entity: 4, id: 'note-1', rev: 12, splice: 'hello world' };
  const samples = time(() => {
    const packed = codec.pack({ kind: codec.KIND.SYNC_OP, body });
    codec.unpack(packed);
  }, 200);
  assert.ok(percentile(samples, 95) < 5, `pack/unpack p95=${percentile(samples, 95).toFixed(3)}ms`);
});

test('ZSL/2 seal+open of a small frame stays in the local 16ms input budget', () => {
  const initiator = zsl.handshakeInitiator();
  const responder = zsl.handshakeResponder({
    x25519Public: initiator.x25519Public,
    mlkemPublic: initiator.mlkemPublic,
  });
  const client = zsl.handshakeFinish(initiator, responder);
  const server = responder.session;
  const packed = codec.pack({ kind: codec.KIND.SYNC_OP, body: { k: 1, n: 2 } });
  const samples = time(() => {
    const sealed = client.seal(packed);
    server.open(sealed);
  }, 80);
  assert.ok(percentile(samples, 95) < 16, `seal/open p95=${percentile(samples, 95).toFixed(3)}ms`);
});

test('CDC manifest of a 256KiB blob stays well under one sync interval', () => {
  const body = Buffer.alloc(256 * 1024);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 17 + 3) & 0xff;
  const key = Buffer.from('perf-account');
  const samples = time(() => cdc.buildManifest(body, { accountKey: key }), 20);
  assert.ok(percentile(samples, 95) < 300, `cdc p95=${percentile(samples, 95).toFixed(3)}ms`);
});
