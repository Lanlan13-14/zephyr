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

function proofHeaders(privateKey, deviceId, challenge, override = {}, dsaEncoding = 'ieee-p1363') {
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
      dsaEncoding,
    }).toString('base64'),
    'x-zephyr-proof-timestamp': String(challenge.timestamp),
    'x-zephyr-server-nonce': challenge.nonce,
  };
}

test('canonical binding is deterministic and DER signatures are rejected', () => {
  assert.equal(
    proofProtocol.canonicalPath('/api/mobile/v1/sync/changes?z=2&a=1'),
    '/api/mobile/v1/sync/changes?a=1&z=2',
  );
  assert.equal(proofProtocol.canonicalPath('/api/mobile/v1/sync/changes?a=1&a=2'), null);
  assert.equal(proofProtocol.canonicalPath('https://evil.example/api/mobile/v1/sync/status'), null);
  assert.equal(proofProtocol.proofUsage('GET', '/api/mobile/v1/sync/status'), 'sync.status');
  assert.equal(proofProtocol.proofUsage('POST', '/api/mobile/v1/devices/proof-challenge'), null);

  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = proofProtocol.signedProofPayload({
    deviceId: 'device-1', method: 'GET', canonicalPath: '/api/mobile/v1/sync/status',
    bodySha256: proofProtocol.EMPTY_BODY_SHA256, usage: 'sync.status',
    timestamp: 1770000000, nonce: crypto.randomBytes(32).toString('base64url'),
  });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const p1363 = crypto.sign('sha256', payload, {
    key: pair.privateKey, dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  const der = crypto.sign('sha256', payload, {
    key: pair.privateKey, dsaEncoding: 'der',
  }).toString('base64');
  assert.equal(proofProtocol.verifyP1363({ jwk, payload, proof: p1363 }), true);
  assert.equal(proofProtocol.verifyP1363({ jwk, payload, proof: der }), false);
});

test('all device data-plane routes require Bearer AND a one-time ES256 proof', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-proof-http-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  const pair1 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pair2 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const device = (id, pair) => ({
    device_id: id,
    owner_user_id: id === 'device-1' ? 'owner-1' : 'owner-2',
    token_id: id === 'device-1' ? 'token-1' : 'token-2',
    signing_public_jwk: JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
    enabled: 1,
    revoked_at: null,
    last_acked_cursor: 0,
  });
  const device1 = device('device-1', pair1);
  const device2 = device('device-2', pair2);
  store.resolveAccess = (credential) => {
    if (credential === 'access-1') return device1;
    if (credential === 'access-2') return device2;
    throw Object.assign(new Error('bad access'), { code: 'app_session_expired', status: 401 });
  };
  store.touchDevice = () => {};

  const users = new Map([
    ['owner-1', { userId: 'owner-1', username: 'alice', status: 'active' }],
    ['owner-2', { userId: 'owner-2', username: 'bob', status: 'active' }],
  ]);
  const api = new MobileV1Api({
    db, store, entityRegistry: registry, shared: {},
    storage: { getUserBrief: (id) => users.get(id) || null },
    sessionStore: { resolve: () => ({ userId: 'owner-1' }) },
    resourceService: {}, notesService: {}, userSettingsService: {}, authz: {},
    fileAgentManager: {
      listTokens(username) {
        return username === 'alice' ? [{ id: 'token-1' }] : [{ id: 'token-2' }];
      },
    },
  });
  api.serverEncryptionKey = () => null;
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
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const challengeFor = async ({
    credential = 'access-1', method = 'GET', target = '/api/mobile/v1/sync/status',
    body = Buffer.alloc(0), usage,
  } = {}) => {
    const response = await fetch(base + '/api/mobile/v1/devices/proof-challenge', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
      body: JSON.stringify({
        method,
        path: target,
        bodySha256: proofProtocol.bodySha256(body),
        ...(usage ? { usage } : {}),
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).challenge;
  };

  const guarded = [
    ['GET', '/api/mobile/v1/sync/bootstrap'],
    ['GET', '/api/mobile/v1/sync/changes?sinceCursor=0'],
    ['GET', '/api/mobile/v1/sync/wake'],
    ['POST', '/api/mobile/v1/sync/push'],
    ['POST', '/api/mobile/v1/sync/ack'],
    ['POST', '/api/mobile/v1/sync/now'],
    ['GET', '/api/mobile/v1/sync/status'],
    ['POST', '/api/mobile/v1/blobs/uploads'],
    ['GET', '/api/mobile/v1/blobs/uploads/upload-1'],
    ['PUT', '/api/mobile/v1/blobs/uploads/upload-1/chunks/0'],
    ['GET', '/api/mobile/v1/blobs/' + 'a'.repeat(64) + '/chunks/0'],
    ['GET', '/api/mobile/v1/blobs/' + 'a'.repeat(64)],
    ['GET', '/api/mobile/v1/shared'],
    ['GET', '/api/mobile/v1/shared/connection/c1'],
    ['POST', '/api/mobile/v1/shared/connection/c1/invoke'],
    ['POST', '/api/mobile/v1/shared/connections/c1/sessions'],
    ['POST', '/api/mobile/v1/shared/sessions/s1/refresh'],
    ['DELETE', '/api/mobile/v1/shared/sessions/s1'],
    ['POST', '/api/mobile/v1/file-bridge/lease'],
  ];
  for (const [method, route] of guarded) {
    let response;
    try {
      response = await fetch(base + route, {
        method,
        headers: { authorization: 'Bearer access-1', 'content-type': 'application/json' },
        body: ['GET', 'DELETE'].includes(method) ? undefined : '{}',
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new Error(`${method} ${route} did not complete`, { cause: error });
    }
    assert.equal(response.status, 401, method + ' ' + route + ' accepted access without proof');
    assert.equal((await response.json()).error.code, 'device_proof_invalid');
  }

  const sidOnly = await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { 'x-zephyr-sid': 'valid-sid' },
  });
  assert.equal(sidOnly.status, 401, 'SID must not be a device data-plane alternative');

  const valid = await challengeFor();
  const validResponse = await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair1.privateKey, 'device-1', valid) },
  });
  assert.equal(validResponse.status, 200);

  const replay = await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair1.privateKey, 'device-1', valid) },
  });
  assert.equal(replay.status, 401);

  const missingTimestamp = await challengeFor();
  const withoutTimestamp = proofHeaders(pair1.privateKey, 'device-1', missingTimestamp);
  delete withoutTimestamp['x-zephyr-proof-timestamp'];
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...withoutTimestamp },
  })).status, 401);

  const shiftedTimestamp = await challengeFor();
  const shiftedHeaders = proofHeaders(pair1.privateKey, 'device-1', {
    ...shiftedTimestamp,
    timestamp: shiftedTimestamp.timestamp + 1,
  });
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...shiftedHeaders },
  })).status, 401, 'v2 proof timestamps must exactly match the server-issued challenge');

  const crossRoute = await challengeFor({ target: '/api/mobile/v1/sync/changes?sinceCursor=0' });
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: {
      authorization: 'Bearer access-1',
      ...proofHeaders(pair1.privateKey, 'device-1', crossRoute, {
        method: 'GET', canonicalPath: '/api/mobile/v1/sync/status',
        bodySha256: proofProtocol.EMPTY_BODY_SHA256, usage: 'sync.status',
      }),
    },
  })).status, 401);

  const ackBody = Buffer.from('{"cursor":0}', 'utf8');
  const crossBody = await challengeFor({ method: 'POST', target: '/api/mobile/v1/sync/ack', body: Buffer.from('{}') });
  assert.equal((await fetch(base + '/api/mobile/v1/sync/ack', {
    method: 'POST',
    headers: { authorization: 'Bearer access-1', 'content-type': 'application/json', ...proofHeaders(pair1.privateKey, 'device-1', crossBody, { bodySha256: proofProtocol.bodySha256(ackBody) }) },
    body: ackBody,
  })).status, 401);

  const crossDevice = await challengeFor();
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-2', ...proofHeaders(pair2.privateKey, 'device-2', crossDevice) },
  })).status, 401);

  const derChallenge = await challengeFor();
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair1.privateKey, 'device-1', derChallenge, {}, 'der') },
  })).status, 401);

  const selfChosen = { ...await challengeFor(), nonce: crypto.randomBytes(32).toString('base64url') };
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair1.privateKey, 'device-1', selfChosen) },
  })).status, 401);

  const expired = await challengeFor();
  db.prepare('UPDATE mobile_device_proof_challenges SET expires_at = 0 WHERE nonce_hash = ?')
    .run(crypto.createHash('sha256').update(expired.nonce, 'utf8').digest('hex'));
  assert.equal((await fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair1.privateKey, 'device-1', expired) },
  })).status, 401);

  const parallel = await Promise.all(Array.from({ length: 8 }, () => challengeFor()));
  const parallelResponses = await Promise.all(parallel.map((challenge) => fetch(base + '/api/mobile/v1/sync/status', {
    headers: { authorization: 'Bearer access-1', ...proofHeaders(pair1.privateKey, 'device-1', challenge) },
  })));
  assert.deepEqual(parallelResponses.map((response) => response.status), Array(8).fill(200));
});

test('OpenAPI declares challenge access-only and every data operation as access AND proof', () => {
  const spec = JSON.parse(fs.readFileSync(
    path.join(here, '..', 'contracts', 'openapi-mobile-v1.json'),
    'utf8',
  ));
  assert.deepEqual(
    spec.paths['/api/mobile/v1/devices/proof-challenge'].post.security,
    [{ DeviceAccess: [] }],
  );
  assert.deepEqual(spec.paths['/api/mobile/v1/devices/refresh'].post.security, []);
  for (const [route, item] of Object.entries(spec.paths)) {
    if (!/^\/api\/mobile\/v1\/(sync|blobs|shared|file-bridge\/lease)/.test(route)) continue;
    for (const operation of Object.values(item)) {
      assert.deepEqual(operation.security, [{ DeviceAccess: [], DeviceProof: [] }], route);
    }
  }
});
