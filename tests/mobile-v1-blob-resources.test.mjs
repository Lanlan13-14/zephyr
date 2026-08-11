// Resource-safety and crash-recovery tests for mobile-v1 blob storage.
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
const root = path.resolve(here, '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(root, 'mobile-v1-store.js'));
const { MobileV1BlobManager } = require(path.join(root, 'mobile-v1-blob-manager.js'));
const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'), 'utf8',
));

const OWNER = 'quota-owner';
const DEVICE = 'quota-device';

function manifest(body, chunkBytes = 4) {
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

function context(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-blob-resource-'));
  const db = createDatabase(path.join(dir, 'db.sqlite'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry, blobRoot: path.join(dir, 'blobs') });
  const manager = new MobileV1BlobManager({
    store,
    limits: { minFreeDiskBytes: 1, gcIntervalMs: 60_000, ...options.limits },
    availableDiskBytes: options.availableDiskBytes || (() => 1_000_000),
    now: options.now,
  });
  return {
    dir, db, store, manager,
    async close() {
      manager.close();
      await manager.waitForIdle(null, 2000).catch(() => {});
      try { db.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function putAll(ctx, body, identity = {}) {
  const spec = manifest(body, identity.chunkBytes || 4);
  const ownerUserId = identity.ownerUserId || OWNER;
  const deviceId = identity.deviceId || DEVICE;
  const created = await ctx.manager.createUpload({ ownerUserId, deviceId, ...spec });
  for (let index = 0; index < spec.chunkHashes.length; index += 1) {
    await ctx.manager.uploadChunk({
      ownerUserId, deviceId, uploadId: created.uploadId, index,
      bytes: body.subarray(index * spec.chunkBytes, (index + 1) * spec.chunkBytes),
    });
  }
  await ctx.manager.waitForIdle(created.uploadId);
  return { spec, created };
}

test('account and device byte/count quotas include completed and in-flight blobs', async () => {
  const ctx = context({ limits: {
    maxAccountBytes: 12, maxAccountBlobs: 2,
    maxDeviceBytes: 12, maxDeviceBlobs: 2,
  } });
  try {
    const first = Buffer.from('12345678');
    await putAll(ctx, first);
    const second = Buffer.from('abcdef');
    await assert.rejects(
      ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest(second) }),
      (error) => error.code === 'payload_too_large' && error.status === 413,
    );

    const otherDevice = 'other-device';
    const pending = Buffer.from('abc');
    await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: otherDevice, ...manifest(pending) });
    await assert.rejects(
      ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: otherDevice, ...manifest(Buffer.from('xy')) }),
      (error) => error.code === 'payload_too_large' && error.status === 413,
    );
  } finally { await ctx.close(); }
});

test('disk reservation accounts for parts plus final assembly before accepting a manifest', async () => {
  const ctx = context({
    availableDiskBytes: () => 20,
    limits: { minFreeDiskBytes: 10 },
  });
  try {
    await assert.rejects(
      ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest(Buffer.from('123456')) }),
      (error) => error.code === 'server_unavailable' && error.status === 503,
    );
    assert.equal(ctx.store.listBlobUploadIds().length, 0, 'capacity failure must not reserve metadata');
  } finally { await ctx.close(); }
});

test('request concurrency and sliding-window limits return 429 with Retry-After data', async () => {
  let releaseDisk;
  let diskCalls = 0;
  const gate = new Promise((resolve) => { releaseDisk = resolve; });
  const ctx = context({
    availableDiskBytes: async () => {
      diskCalls += 1;
      if (diskCalls === 1) await gate;
      return 1_000_000;
    },
    limits: { maxConcurrentDeviceRequests: 1, createRatePerMinute: 1 },
  });
  try {
    const first = ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest(Buffer.from('first')) });
    while (diskCalls === 0) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest(Buffer.from('second')) }),
      (error) => error.code === 'rate_limited' && error.status === 429 && error.retryAfterSec === 1,
    );
    releaseDisk();
    await first;
    await assert.rejects(
      ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...manifest(Buffer.from('third')) }),
      (error) => error.code === 'rate_limited' && error.status === 429 && error.retryAfterSec >= 1,
    );
  } finally {
    releaseDisk();
    await ctx.close();
  }
});

test('opportunistic GC releases abandoned upload quota and removes part files', async () => {
  let clock = Date.now();
  const ctx = context({ now: () => clock, limits: { staleUploadMs: 1_000 } });
  try {
    const body = Buffer.from('abandoned');
    const spec = manifest(body);
    const created = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...spec });
    await ctx.manager.uploadChunk({
      ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId,
      index: 0, bytes: body.subarray(0, 4),
    });
    clock += 2_000;
    ctx.db.prepare('UPDATE mobile_blob_uploads SET updated_at = ? WHERE upload_id = ?')
      .run(clock - 2_000, created.uploadId);
    assert.equal(await ctx.manager.gc(), 1);
    assert.equal(ctx.store.getBlobUpload(created.uploadId), null);
    assert.equal(fs.existsSync(ctx.store.uploadChunkDir(created.uploadId)), false);
  } finally { await ctx.close(); }
});

test('restart recovery completes a crash after all chunks were committed', async () => {
  const ctx = context();
  try {
    await ctx.manager.ready;
    ctx.manager.close();
    const body = Buffer.from('restart-recovery');
    const spec = manifest(body);
    const created = ctx.store.createBlobUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...spec });
    fs.mkdirSync(ctx.store.uploadChunkDir(created.uploadId), { recursive: true });
    for (let index = 0; index < spec.chunkHashes.length; index += 1) {
      const bytes = body.subarray(index * spec.chunkBytes, (index + 1) * spec.chunkBytes);
      fs.writeFileSync(path.join(ctx.store.uploadChunkDir(created.uploadId), index + '.part'), bytes);
      ctx.store.commitBlobChunk({ ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index, byteLength: bytes.length });
    }
    const recovered = new MobileV1BlobManager({
      store: ctx.store,
      limits: { minFreeDiskBytes: 1, gcIntervalMs: 60_000 },
      availableDiskBytes: () => 1_000_000,
    });
    ctx.manager = recovered;
    await recovered.ready;
    await recovered.waitForIdle(created.uploadId);
    assert.equal(ctx.store.blobUploadStatus(ctx.store.getBlobUpload(created.uploadId)).state, 'complete');
    assert.deepEqual(fs.readFileSync(ctx.store.blobFilePath(ctx.store.getBlob(OWNER, spec.sha256))), body);
  } finally { await ctx.close(); }
});

test('stream finalization yields to the event loop and never concatenates the blob in memory', async () => {
  const ctx = context({ availableDiskBytes: () => 100_000_000 });
  try {
    const body = crypto.randomBytes(4 * 1024 * 1024);
    const spec = manifest(body, 512 * 1024);
    const created = await ctx.manager.createUpload({ ownerUserId: OWNER, deviceId: DEVICE, ...spec });
    for (let index = 0; index < spec.chunkHashes.length; index += 1) {
      await ctx.manager.uploadChunk({
        ownerUserId: OWNER, deviceId: DEVICE, uploadId: created.uploadId, index,
        bytes: body.subarray(index * spec.chunkBytes, (index + 1) * spec.chunkBytes),
      });
    }
    let immediateRan = false;
    await new Promise((resolve) => setImmediate(() => { immediateRan = true; resolve(); }));
    assert.equal(immediateRan, true, 'finalization must not monopolize the event loop');
    const implementation = fs.readFileSync(path.join(root, 'mobile-v1-blob-manager.js'), 'utf8');
    assert.doesNotMatch(implementation, /readFileSync|Buffer\.concat/, 'worker must stream instead of buffering the final blob');
    await ctx.manager.waitForIdle(created.uploadId, 10_000);
    assert.equal(ctx.store.blobUploadStatus(ctx.store.getBlobUpload(created.uploadId)).state, 'complete');
  } finally { await ctx.close(); }
});
