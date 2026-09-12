import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { createLinkSyncBridge } = require(path.join(repoRoot, 'link-v2-sync-bridge.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    get() { return undefined; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

function insertDevice(store, ownerUserId, deviceId) {
  store.db.prepare(`INSERT INTO mobile_devices
    (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
     app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
     refresh_generation, enabled, automatic_enabled, sync_interval_sec, config_revision,
     registry_hash, last_acked_cursor, last_sync_at, last_seen_at, created_at,
     revoked_at, revoke_reason)
    VALUES (?, ?, ?, 'link-v2-enrollment', 'Pixel', 'android', '1.0.0', ?, '{}',
            'refresh-hash', 1, 1, 1, 300, 1, ?, 0, NULL, ?, ?, NULL, NULL)`).run(
    deviceId,
    ownerUserId,
    'alice',
    Buffer.alloc(1),
    store.registryHash,
    Date.now(),
    Date.now(),
  );
}

function makeBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-second-round-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  const user = { userId: 'alice', username: 'alice', status: 'active' };
  const api = new MobileV1Api({
    db,
    store,
    entityRegistry: registry,
    storage: { getUserBrief: () => user },
    sessionStore: { resolve: () => null },
    wake: { close() {}, disconnectDevice() {}, publish() {} },
    blobs: { close() {}, ready: Promise.resolve() },
  });
  const adminToken = 'x'.repeat(32);
  const { handle, resolveAuth } = createLinkSyncBridge({
    api,
    storage: { getUserBrief: () => user },
    adminToken,
  });
  insertDevice(store, 'alice', 'dev-1');
  store.appendChange({
    ownerUserId: 'alice',
    entityType: 'note',
    entityId: 'note-1',
    action: 'upsert',
    revision: 1,
    fieldMask: ['title'],
    actorDeviceId: 'dev-1',
  });
  return {
    api,
    store,
    handle,
    resolveAuth,
    adminToken,
    close() {
      api.wake.close();
      api.blobs.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function post(handle, adminToken, body) {
  const res = makeRes();
  handle({
    get(name) { return name.toLowerCase() === 'x-link-admin' ? adminToken : ''; },
    body,
  }, res);
  return res;
}

test('second-round Link changes/ack accept JSON-revived integer cursors', () => {
  const ctx = makeBridge();
  try {
    const latest = ctx.store.latestCursor('alice');
    assert.equal(latest > 0, true);

    for (const sinceCursor of [latest, String(latest), Number(latest)]) {
      const res = post(ctx.handle, ctx.adminToken, {
        deviceId: 'dev-1',
        kind: 1,
        body: { op: 'changes', sinceCursor, limit: 50 },
      });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true);
      assert.equal(res.body.body.fromCursor, Number(sinceCursor));
    }

    const ackRes = post(ctx.handle, ctx.adminToken, {
      deviceId: 'dev-1',
      kind: 1,
      body: { op: 'ack', cursor: String(latest) },
    });
    assert.equal(ackRes.statusCode, 200, JSON.stringify(ackRes.body));
    assert.equal(ackRes.body.ok, true);
    assert.equal(ctx.store.getDeviceRow('dev-1').last_acked_cursor, latest);
  } finally {
    ctx.close();
  }
});

test('Link push strips the op discriminator before frozen push validation', () => {
  const ctx = makeBridge();
  try {
    const res = post(ctx.handle, ctx.adminToken, {
      deviceId: 'dev-1',
      kind: 1,
      body: {
        op: 'push',
        protocolVersion: 1,
        deviceId: 'dev-1',
        batchId: 'batch-empty-1',
        baseCursor: ctx.store.latestCursor('alice'),
        registryHash: ctx.store.registryHash,
        operations: [],
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.body.ok, true);
    assert.deepEqual(res.body.body.results, []);
  } finally {
    ctx.close();
  }
});

test('Node Link CBOR accepts integer cursors and rejects floats', () => {
  const cbor = require(path.join(repoRoot, 'link-v2-cbor.js'));
  const encoded = cbor.encode({ op: 'changes', sinceCursor: 59, limit: 100 });
  assert.deepEqual(cbor.decode(encoded), { op: 'changes', sinceCursor: 59, limit: 100 });
  assert.throws(() => cbor.encode({ op: 'changes', sinceCursor: 59.5 }), /integer is not a safe integer/);
  const float64 = Buffer.alloc(9);
  float64[0] = 0xfb;
  float64.writeDoubleBE(59, 1);
  assert.throws(() => cbor.decode(float64), /unsupported simple\/float CBOR/);
});

test('HTTP changes also coerce query cursors instead of Number()', () => {
  const ctx = makeBridge();
  try {
    const latest = ctx.store.latestCursor('alice');
    ctx.api.requireDevice = () => ctx.resolveAuth('dev-1');
    const res = makeRes();
    ctx.api.handleChanges({
      query: { sinceCursor: String(latest), limit: '10' },
      mobileRequestId: 'r-http-changes',
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.fromCursor, latest);
  } finally {
    ctx.close();
  }
});
