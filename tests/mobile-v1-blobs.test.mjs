// Blob store/worker semantics (SYNC_STATE_MACHINE.md sections 11-12).
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
const { MobileV1BlobManager } = require(path.join(repoRoot, 'mobile-v1-blob-manager.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const CHUNK = 8;
const OWNER = 'user-1';
const DEVICE = 'dev-1';

function freshContext(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-mv1-blob-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry, blobRoot: path.join(dir, 'blobs') });
  const manager = new MobileV1BlobManager({
    store,
    availableDiskBytes: options.availableDiskBytes || (() => Number.MAX_SAFE_INTEGER),
    limits: { minFreeDiskBytes: 1, gcIntervalMs: 60_000, ...options.limits },
    now: options.now,
  });
  return {
    db, store, manager, dir,
    async cleanup() {
      manager.close();
      await manager.waitForIdle(null, 2000).catch(() => {});
      try { db.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function manifestFor(body, chunkBytes = CHUNK) {
  const chunkHashes = [];
  for (let offset = 0; offset < body.length; offset += chunkBytes) {
    chunkHashes.push(crypto.createHash('sha256').update(body.subarray(offset, offset + chunkBytes)).digest('hex'));
  }
  return {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: body.length,
    mime: 'application/octet-stream',
    chunkBytes,
    chunkHashes,
    encrypted: false,
  };
}

async function uploadAll(ctx, body, manifest = manifestFor(body), identity = {}) {
  const ownerUserId = identity.ownerUserId || OWNER;
  const deviceId = identity.deviceId || DEVICE;
  const created = await ctx.manager.createUpload({ ownerUserId, deviceId, ...manifest });
  for (let index = 0; index < manifest.chunkHashes.length; index += 1) {
    await ctx.manager.uploadChunk({
      ownerUserId,
      deviceId,
      uploadId: created.uploadId,
      index,
      bytes: body.subarray(index * manifest.chunkBytes, (index + 1) * manifest.chunkBytes),
    });
  }
  await ctx.manager.waitForIdle(created.uploadId);
  return { created, status: ctx.store.blobUploadStatus(ctx.store.getBlobUpload(created.uploadId)) };
}

test('streaming worker verifies and atomically publishes a complete blob', async () => {
  const ctx = freshContext();
  try {
    const body = Buffer.from('hello world!');
    const manifest = manifestFor(body);
    const { created, status } = await uploadAll(ctx, body, manifest);
    assert.deepEqual(created.missing, [0, 1]);
    assert.equal(status.state, 'complete');
    const row = ctx.store.getBlob(OWNER, manifest.sha256);
    assert.ok(row);
    assert.deepEqual(fs.readFileSync(ctx.store.blobFilePath(row)), body);
    assert.equal(fs.existsSync(ctx.store.uploadChunkDir(created.uploadId)), false);
  } finally { await ctx.cleanup(); }
});

test('matching manifests resume by stable upload id and chunks are idempotent', async () => {
  const ctx = freshContext();
  try {
    const body = Buffer.from('idem-chunk-test');
    const manifest = manifestFor(body);
    const created = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    const first = await ctx.manager.uploadChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
      index: 0, bytes: body.subarray(0, CHUNK),
    });
    const resumed = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    const replay = await ctx.manager.uploadChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
      index: 0, bytes: body.subarray(0, CHUNK),
    });
    assert.equal(resumed.uploadId, created.uploadId);
    assert.deepEqual(first.received, [0]);
    assert.deepEqual(replay.received, [0]);
  } finally { await ctx.cleanup(); }
});

test('conflicting manifests and bad chunk bytes are rejected before persistence', async () => {
  const ctx = freshContext();
  try {
    const body = Buffer.from('hash-check-body');
    const manifest = manifestFor(body);
    const created = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    const conflicting = { ...manifest, chunkHashes: manifest.chunkHashes.slice().reverse() };
    await assert.rejects(
      ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...conflicting }),
      (error) => error.code === 'blob_hash_mismatch' && error.status === 422,
    );
    await assert.rejects(
      ctx.manager.uploadChunk({
        ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
        index: 0, bytes: Buffer.alloc(CHUNK, 7),
      }),
      (error) => error.code === 'blob_hash_mismatch' && error.status === 422,
    );
    assert.deepEqual(ctx.store.blobUploadStatus(ctx.store.getBlobUpload(created.uploadId)).received, []);
    assert.equal(fs.existsSync(path.join(ctx.store.uploadChunkDir(created.uploadId), '0.part')), false);
  } finally { await ctx.cleanup(); }
});

test('wrong chunk length, index and cross-device access use safe typed errors', async () => {
  const ctx = freshContext();
  try {
    const body = Buffer.from('length-and-owner');
    const manifest = manifestFor(body);
    const created = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    await assert.rejects(
      ctx.manager.uploadChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 0, bytes: body.subarray(0, 4) }),
      (error) => error.code === 'invalid_request' && error.status === 400,
    );
    await assert.rejects(
      ctx.manager.uploadChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index: 99, bytes: body.subarray(0, 8) }),
      (error) => error.code === 'invalid_request' && error.status === 400,
    );
    await assert.rejects(
      ctx.manager.getUploadStatus({ ownerUserId: OWNER, deviceId: 'other-device', uploadId: created.uploadId }),
      (error) => error.code === 'resource_not_found_or_inaccessible' && error.status === 404,
    );
  } finally { await ctx.cleanup(); }
});

test('whole-blob hash mismatch removes all temporary bytes and exposes no blob', async () => {
  const ctx = freshContext();
  try {
    const body = Buffer.from('whole-hash-fail');
    const manifest = { ...manifestFor(body), sha256: '0'.repeat(64) };
    const { created, status } = await uploadAll(ctx, body, manifest);
    assert.equal(status.state, 'failed');
    assert.equal(status.error.code, 'blob_hash_mismatch');
    assert.equal(ctx.store.getBlob(OWNER, manifest.sha256), null);
    assert.equal(fs.existsSync(ctx.store.uploadChunkDir(created.uploadId)), false);
    assert.equal(fs.existsSync(ctx.store._blobFile(OWNER, manifest.sha256) + '.tmp-' + created.uploadId), false);
  } finally { await ctx.cleanup(); }
});

test('zero-byte blobs follow the same recoverable finalization path', async () => {
  const ctx = freshContext();
  try {
    const manifest = manifestFor(Buffer.alloc(0));
    const created = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.ok(['finalizing', 'complete'].includes(created.state));
    await ctx.manager.waitForIdle(created.uploadId);
    const row = ctx.store.getBlob(OWNER, manifest.sha256);
    assert.ok(row);
    assert.equal(Number(row.size), 0);
    assert.equal(fs.statSync(ctx.store.blobFilePath(row)).size, 0);
  } finally { await ctx.cleanup(); }
});

test('re-posting a completed manifest does not reserve a second upload', async () => {
  const ctx = freshContext();
  try {
    const body = Buffer.from('already-complete');
    const manifest = manifestFor(body);
    await uploadAll(ctx, body, manifest);
    const repeated = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest });
    assert.equal(repeated.state, 'complete');
    assert.equal(repeated.uploadId, null);
  } finally { await ctx.cleanup(); }
});
