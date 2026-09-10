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
const repoRoot = path.resolve(here, '..', '..', '..');
const express = require('express');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const proofProtocol = require(path.join(repoRoot, 'mobile-v1-proof.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function proofHeaders(privateKey, deviceId, challenge, override = {}) {
  const binding = {
    method: challenge.method,
    canonicalPath: challenge.canonicalPath,
    bodySha256: challenge.bodySha256,
    usage: challenge.usage,
    ...override,
  };
  const payload = proofProtocol.signedProofPayload({
    deviceId,
    ...binding,
    timestamp: challenge.timestamp,
    nonce: challenge.nonce,
  });
  return {
    'x-zephyr-device-proof': crypto.sign('sha256', payload, {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64'),
    'x-zephyr-proof-timestamp': String(challenge.timestamp),
    'x-zephyr-server-nonce': challenge.nonce,
  };
}

test('proof usage covers One device management routes', () => {
  assert.equal(proofProtocol.proofUsage('GET', '/api/mobile/v1/devices'), 'devices.list');
  assert.equal(proofProtocol.proofUsage('PATCH', '/api/mobile/v1/devices/abc'), 'devices.patch');
  assert.equal(proofProtocol.proofUsage('DELETE', '/api/mobile/v1/devices/abc'), 'devices.revoke');
  assert.equal(proofProtocol.proofUsage('POST', '/api/mobile/v1/sensitive/verify'), 'sensitive.verify');
});

test('GET /devices accepts DeviceAccess+proof or ZephyrSid and lists the bound device', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-devices-auth-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const device = {
    device_id: 'device-1',
    owner_user_id: 'alice',
    token_id: 'link-v2-enrollment',
    signing_public_jwk: JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
    enabled: 1,
    revoked_at: null,
    last_acked_cursor: 0,
  };
  store.resolveAccess = (credential) => {
    if (credential === 'access-1') return device;
    throw Object.assign(new Error('bad access'), { code: 'app_session_expired', status: 401 });
  };
  store.touchDevice = () => {};
  db.prepare(`INSERT INTO mobile_devices
    (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
     app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
     refresh_generation, enabled, automatic_enabled, sync_interval_sec, config_revision,
     registry_hash, last_acked_cursor, last_sync_at, last_seen_at, created_at,
     revoked_at, revoke_reason)
    VALUES ('device-1', 'alice', 'alice', 'link-v2-enrollment', 'Pixel 8', 'android',
            '1.0.0', ?, ?, 'refresh-hash', 1, 1, 1, 300, 1, ?, 0, NULL, ?, ?, NULL, NULL)`).run(
    Buffer.alloc(1),
    JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
    store.registryHash,
    Date.now(),
    Date.now(),
  );

  const api = new MobileV1Api({
    db,
    store,
    entityRegistry: registry,
    storage: {
      getUserBrief: (id) => (id === 'alice' ? { userId: 'alice', username: 'alice', status: 'active' } : null),
    },
    sessionStore: {
      resolve: (sid) => (sid === 'sid-alice' ? { userId: 'alice' } : null),
    },
    fileAgentManager: { listTokens() { return []; } },
    wake: { close() {}, disconnectDevice() {}, publish() {} },
    blobs: { close() {}, ready: Promise.resolve() },
  });
  const app = express();
  app.use(express.json({
    verify(req, _res, buffer) {
      if (req.url.startsWith('/api/mobile/v1')) req.rawBody = buffer;
    },
  }));
  api.mountRoutes(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    api.wake.close();
    api.blobs.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const empty = await fetch(base + '/api/mobile/v1/devices');
  assert.equal(empty.status, 401);

  const bearerOnly = await fetch(base + '/api/mobile/v1/devices', {
    headers: { authorization: 'Bearer access-1' },
  });
  assert.equal(bearerOnly.status, 401, 'DeviceAccess without proof must not list devices');
  assert.equal((await bearerOnly.json()).error.code, 'device_proof_invalid');

  const challengeRes = await fetch(base + '/api/mobile/v1/devices/proof-challenge', {
    method: 'POST',
    headers: { authorization: 'Bearer access-1', 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'GET',
      path: '/api/mobile/v1/devices',
      bodySha256: proofProtocol.EMPTY_BODY_SHA256,
      usage: 'devices.list',
    }),
  });
  assert.equal(challengeRes.status, 200, JSON.stringify(await challengeRes.clone().json()));
  const challenge = (await challengeRes.json()).challenge;
  const listed = await fetch(base + '/api/mobile/v1/devices', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair.privateKey, 'device-1', challenge) },
  });
  assert.equal(listed.status, 200, JSON.stringify(await listed.clone().json()));
  const listedBody = await listed.json();
  assert.equal(listedBody.ok, true);
  assert.equal(listedBody.devices.length, 1);
  assert.equal(listedBody.devices[0].deviceId, 'device-1');
  assert.equal(listedBody.devices[0].deviceName, 'Pixel 8');

  const sidListed = await fetch(base + '/api/mobile/v1/devices', {
    headers: { 'x-zephyr-sid': 'sid-alice' },
  });
  assert.equal(sidListed.status, 200, JSON.stringify(await sidListed.clone().json()));
  const sidBody = await sidListed.json();
  assert.equal(sidBody.ok, true);
  assert.equal(sidBody.devices[0].deviceId, 'device-1');
});
