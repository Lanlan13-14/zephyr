// Store-level blob transfer tests (SYNC_STATE_MACHINE.md section 11).
//
// HTTP mounting is covered by mobile-v1-blob-http.test.mjs; this file pins the
// store semantics the endpoints rely on: resume by stable uploadId, idempotent
// chunk indices, per-chunk and whole-blob hash verification, and owner/device
// isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));

const registry = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'), 'utf8'),
);

const CHUNK = 8; // tiny chunk size so a "two chunk" blob is 12 bytes

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mv1-blob-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry, blobRoot: path.join(dir, 'blobs') });
  return { db, store, dir, cleanup: () => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

function manifestFor(body, chunkBytes = CHUNK) {
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += chunkBytes) {
    chunks.push(crypto.createHash('sha256').update(body.subarray(offset, offset + chunkBytes)).digest('hex'));
  }
  return {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: body.length,
    mime: 'application/octet-stream',
    chunkBytes,
    chunkHashes: chunks,
    encrypted: false,
  };
}

const OWNER = 'user-1';
const DEVICE = 'dev-1';

test('a full upload assembles, verifies and stores the blob', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('hello world!'); // 12 bytes -> 2 chunks of 8
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.equal(created.state, 'receiving');
    assert.deepEqual(created.missing, [0, 1]);
    assert.ok(created.uploadId);

    const afterFirst = ctx.store.recordBlobChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
      index: 0, bytes: body.subarray(0, 8),
    });
    assert.equal(afterFirst.state, 'receiving');
    assert.deepEqual(afterFirst.received, [0]);
    assert.deepEqual(afterFirst.missing, [1]);

    const done = ctx.store.recordBlobChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
      index: 1, bytes: body.subarray(8),
    });
    assert.equal(done.state, 'complete');
    assert.deepEqual(done.missing, []);

    const row = ctx.store.getBlob(OWNER, manifest.sha256);
    assert.ok(row, 'completed blob must be addressable by digest');
    assert.equal(Number(row.size), body.length);
    assert.deepEqual(fs.readFileSync(ctx.store.blobFilePath(row)), body);
  } finally { ctx.cleanup(); }
});

test('re-opening an upload with the same manifest resumes it', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('resume-me-please!!');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    ctx.store.recordBlobChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8),
    });
    const resumed = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.equal(resumed.uploadId, created.uploadId, 'stable uploadId for (owner, device, sha256)');
    assert.deepEqual(resumed.received, [0]);
    assert.equal(resumed.state, 'receiving');
  } finally { ctx.cleanup(); }
});

test('a conflicting manifest for an in-flight digest is a hash error, not a new upload', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('conflict-body-01');
    const manifest = manifestFor(body);
    ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    const tampered = { ...manifest, chunkHashes: manifest.chunkHashes.slice().reverse() };
    assert.throws(
      () => ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...tampered }),
      (err) => err.code === 'blob_hash_mismatch' && err.status === 422,
    );
  } finally { ctx.cleanup(); }
});

test('a chunk whose bytes do not hash to the manifest entry is rejected before disk', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('hash-check-body');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.throws(
      () => ctx.store.recordBlobChunk({
        ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
        index: 0, bytes: Buffer.from('EVILBYTE'),
      }),
      (err) => err.code === 'blob_hash_mismatch' && err.status === 422,
    );
    const status = ctx.store.blobUploadStatus(ctx.store.getBlobUpload(created.uploadId));
    assert.deepEqual(status.received, [], 'a rejected chunk must not be recorded');
    assert.equal(fs.existsSync(path.join(ctx.store.blobRoot, '_uploads', created.uploadId, '0.part')), false);
  } finally { ctx.cleanup(); }
});

test('re-sending an already-acked chunk is accepted without corruption', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('idem-chunk-test');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    const first = ctx.store.recordBlobChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8),
    });
    const again = ctx.store.recordBlobChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8),
    });
    assert.deepEqual(again.received, first.received);
    assert.equal(again.state, 'receiving');
  } finally { ctx.cleanup(); }
});

test('wrong chunk length and out-of-range index are invalid requests', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('len-index-checks');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.throws(
      () => ctx.store.recordBlobChunk({
        ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 4),
      }),
      (err) => err.code === 'invalid_request' && err.status === 400,
    );
    assert.throws(
      () => ctx.store.recordBlobChunk({
        ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 99, bytes: body.subarray(0, 8),
      }),
      (err) => err.code === 'invalid_request' && err.status === 400,
    );
  } finally { ctx.cleanup(); }
});

test('internally inconsistent manifest fails the whole-blob check and drops the upload', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('whole-hash-fail');
    const manifest = manifestFor(body);
    // Chunks hash correctly but the total digest is wrong: a client bug the
    // server must catch at assembly time, not after persisting a bad blob.
    manifest.sha256 = '0'.repeat(64);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    ctx.store.recordBlobChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8),
    });
    assert.throws(
      () => ctx.store.recordBlobChunk({
        ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 1, bytes: body.subarray(8),
      }),
      (err) => err.code === 'blob_hash_mismatch' && err.status === 422,
    );
    assert.equal(ctx.store.getBlobUpload(created.uploadId), null, 'poisoned upload state must be dropped');
    assert.equal(ctx.store.getBlob(OWNER, manifest.sha256), null, 'no blob may persist under a bad digest');
  } finally { ctx.cleanup(); }
});

test('a zero-length blob completes at manifest time', () => {
  const ctx = freshStore();
  try {
    const manifest = manifestFor(Buffer.alloc(0));
    const status = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.equal(status.state, 'complete');
    const row = ctx.store.getBlob(OWNER, manifest.sha256);
    assert.ok(row);
    assert.equal(Number(row.size), 0);
  } finally { ctx.cleanup(); }
});

test('uploads and blobs are invisible across owners and devices', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('isolation-check');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.throws(
      () => ctx.store.recordBlobChunk({
        ownerUserId: 'user-2', deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8),
      }),
      (err) => err.code === 'resource_not_found_or_inaccessible' && err.status === 404,
    );
    assert.throws(
      () => ctx.store.recordBlobChunk({
        ownerUserId: OWNER, deviceId: 'dev-2', uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8),
      }),
      (err) => err.code === 'resource_not_found_or_inaccessible' && err.status === 404,
    );
    assert.equal(ctx.store.getBlob('user-2', manifest.sha256), null);
  } finally { ctx.cleanup(); }
});

test('readBlobRange serves exactly the requested window', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('range-read-body!');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    ctx.store.recordBlobChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8) });
    ctx.store.recordBlobChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 1, bytes: body.subarray(8) });
    const row = ctx.store.getBlob(OWNER, manifest.sha256);
    assert.deepEqual(ctx.store.readBlobRange(row, 0, 8), body.subarray(0, 8));
    assert.deepEqual(ctx.store.readBlobRange(row, 8, 8), body.subarray(8, 16));
    assert.deepEqual(ctx.store.readBlobRange(row, 8, 64), body.subarray(8), 'short final window reads to EOF');
  } finally { ctx.cleanup(); }
});

test('gc drops stale in-flight uploads and their part files', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('gc-me-eventually');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    ctx.store.recordBlobChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8) });
    // Age the row beyond the GC horizon.
    ctx.db.prepare('UPDATE mobile_blob_uploads SET updated_at = ? WHERE upload_id = ?')
      .run(Date.now() - 48 * 3600 * 1000, created.uploadId);
    assert.equal(ctx.store.gcBlobUploads(), 1);
    assert.equal(ctx.store.getBlobUpload(created.uploadId), null);
    assert.equal(fs.existsSync(path.join(ctx.store.blobRoot, '_uploads', created.uploadId)), false);
  } finally { ctx.cleanup(); }
});

test('a completed blob survives upload GC', () => {
  const ctx = freshStore();
  try {
    const body = Buffer.from('gc-keep-me-1234');
    const manifest = manifestFor(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    ctx.store.recordBlobChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 8) });
    ctx.store.recordBlobChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 1, bytes: body.subarray(8) });
    ctx.db.prepare('UPDATE mobile_blob_uploads SET updated_at = ? WHERE upload_id = ?')
      .run(Date.now() - 48 * 3600 * 1000, created.uploadId);
    assert.equal(ctx.store.gcBlobUploads(), 0, 'complete uploads are history, not garbage');
    assert.ok(ctx.store.getBlob(OWNER, manifest.sha256));
  } finally { ctx.cleanup(); }
});
