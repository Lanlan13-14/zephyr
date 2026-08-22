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
const cdc = require(path.join(repoRoot, 'link-v2-cdc.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-cdc-blob-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry, blobRoot: path.join(dir, 'blobs') });
  const manager = new MobileV1BlobManager({
    store,
    availableDiskBytes: () => Number.MAX_SAFE_INTEGER,
    limits: { minFreeDiskBytes: 1, gcIntervalMs: 60_000 },
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

test('CDC manifest uploads only missing chunks and stays account-scoped', async () => {
  const ctx = fresh();
  try {
    const body = crypto.randomBytes(48_000);
    const accountKey = Buffer.from('acct-one');
    const otherKey = Buffer.from('acct-two');
    const manifest = cdc.buildManifest(body, { accountKey });
    const created = await ctx.manager.createUpload({
      ownerUserId: 'user-1',
      deviceId: 'dev-1',
      sha256: manifest.sha256,
      size: manifest.size,
      mime: 'application/octet-stream',
      chunkBytes: Math.max(...manifest.chunks.map((c) => c.size)),
      chunkHashes: manifest.chunks.map((c) => c.sha256),
      chunkSizes: manifest.chunks.map((c) => c.size),
      keyedIds: manifest.chunks.map((c) => c.keyedId),
      chunkAlgorithm: 'fastcdc-gear-v1',
      encrypted: false,
    });
    assert.equal(created.state, 'receiving');
    const parts = cdc.chunkBuffer(body);
    for (let index = 0; index < parts.length; index += 1) {
      await ctx.manager.uploadChunk({
        ownerUserId: 'user-1',
        deviceId: 'dev-1',
        uploadId: created.uploadId,
        index,
        bytes: parts[index],
      });
    }
    await ctx.manager.waitForIdle(created.uploadId);
    const done = ctx.store.getBlob('user-1', manifest.sha256);
    assert.ok(done);
    assert.equal(done.chunk_algorithm, 'fastcdc-gear-v1');
    const upload = ctx.store.getBlobUpload(created.uploadId);
    assert.equal(JSON.parse(upload.keyed_ids_json || '[]').length, manifest.chunks.length);
    const known = ctx.store.knownKeyedChunkIds('user-1', manifest.chunks.map((c) => c.keyedId));
    assert.equal(known.size, manifest.chunks.length);
    const foreign = ctx.store.knownKeyedChunkIds('user-2', manifest.chunks.map((c) => c.keyedId));
    assert.equal(foreign.size, 0);
    const other = cdc.buildManifest(body, { accountKey: otherKey });
    assert.notEqual(other.chunks[0].keyedId, manifest.chunks[0].keyedId);
  } finally {
    await ctx.cleanup();
  }
});
