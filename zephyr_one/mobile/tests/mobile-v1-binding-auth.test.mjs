import test from 'node:test';
import assert from 'node:assert/strict';
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

const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function bindBody(tokenId, deviceId, overrides = {}) {
  return {
    deviceId,
    deviceName: 'Binding Security Test',
    platform: 'android',
    appVersion: '0.1.0',
    tokenId,
    keys: {
      encryption: { alg: 'ML-KEM-768', publicKey: Buffer.alloc(1184, 7).toString('base64') },
      signing: { alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
    },
    syncIntervalSec: 300,
    ...overrides,
  };
}

test('binding requires password-ready SID plus target-bound one-shot authority', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-bind-auth-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry });
  store.mintAccess = () => ({ accessCredential: 'access-test', accessExpiresAt: Date.now() + 60_000 });

  const users = new Map([
    ['alice', { userId: 'alice', username: 'alice', status: 'active', defaultPassword: false }],
    ['forced-session', { userId: 'forced-session', username: 'forced-session', status: 'active', defaultPassword: false }],
    ['forced-user', { userId: 'forced-user', username: 'forced-user', status: 'active', defaultPassword: true }],
    ['rate-user', { userId: 'rate-user', username: 'rate-user', status: 'active', defaultPassword: false }],
  ]);
  const sessions = new Map([
    ['sid-stolen', { userId: 'alice', username: 'alice', createdAt: 2_000, mustChangePassword: false }],
    ['sid-forced-session', { userId: 'forced-session', username: 'forced-session', createdAt: 2_000, mustChangePassword: true }],
    ['sid-forced-user', { userId: 'forced-user', username: 'forced-user', createdAt: 2_000, mustChangePassword: false }],
    ['sid-rate', { userId: 'rate-user', username: 'rate-user', createdAt: 2_000, mustChangePassword: false }],
  ]);
  const tokens = new Map([
    ['alice', [
      { id: 'tok_old', name: 'old', token: 'old-token-secret', createdAt: 1_000 },
      { id: 'tok_new', name: 'new', token: 'new-token-secret', createdAt: 3_000 },
    ]],
  ]);
  let verificationCalls = 0;
  const api = new MobileV1Api({
    db,
    store,
    entityRegistry: registry,
    shared: {},
    storage: { getUserBrief: (id) => users.get(id) || null },
    sessionStore: { resolve: (sid) => sessions.get(sid) || null },
    resourceService: {},
    notesService: {},
    userSettingsService: {},
    authz: {},
    fileAgentManager: {
      listTokens(username, { includeToken = false } = {}) {
        return (tokens.get(username) || []).map((token) => ({
          ...token,
          token: includeToken ? token.token : undefined,
        }));
      },
    },
    verifySensitive(_user, secret) {
      verificationCalls += 1;
      if (secret !== 'correct-password') throw new Error('credential rejected');
      return { method: 'password' };
    },
  });
  api.serverEncryptionKey = () => null;

  const app = express();
  app.use(express.json());
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

  const post = (pathname, sid, body, extraHeaders = {}) => fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zephyr-sid': sid, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const errorCode = async (response) => (await response.json()).error.code;

  const targetDevice = 'device-bind-auth-0001';
  const otherDevice = 'device-bind-auth-0002';

  const forcedVerify = await post('/api/mobile/v1/sensitive/verify', 'sid-forced-session', {
    action: 'device.bind', secret: 'correct-password', targetIds: ['tok_old', targetDevice],
  });
  assert.equal(forcedVerify.status, 403);
  assert.equal(await errorCode(forcedVerify), 'must_change_password');
  assert.equal(verificationCalls, 0, 'a forced-password session must never reach the verifier');

  const forcedBind = await post('/api/mobile/v1/devices/bind', 'sid-forced-user',
    bindBody('tok_old', targetDevice));
  assert.equal(forcedBind.status, 403);
  assert.equal(await errorCode(forcedBind), 'must_change_password');

  const stolenSid = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', targetDevice));
  assert.equal(stolenSid.status, 403);
  assert.equal(await errorCode(stolenSid), 'sensitive_verification_required');

  const sidMintedToken = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_new', targetDevice, { tokenSecret: 'new-token-secret' }));
  assert.equal(sidMintedToken.status, 403,
    'a token created after the stolen session is not an independent binding proof');
  assert.equal(await errorCode(sidMintedToken), 'sensitive_verification_required');

  const wrongSecret = await post('/api/mobile/v1/sensitive/verify', 'sid-stolen', {
    action: 'device.bind', secret: 'wrong-password', targetIds: ['tok_old', targetDevice],
  });
  assert.equal(wrongSecret.status, 403);
  assert.equal(await errorCode(wrongSecret), 'sensitive_verification_failed');

  const verified = await post('/api/mobile/v1/sensitive/verify', 'sid-stolen', {
    action: 'device.bind', secret: 'correct-password', targetIds: ['tok_old', targetDevice],
  });
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  const grant = verifiedBody.grant;
  assert.match(grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifiedBody.bindingProtocolVersion, 2);
  assert.match(verifiedBody.bindAttempt.receipt, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifiedBody.bindAttempt.expectedBindingRevision, 0);

  const crossTarget = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', otherDevice), { 'x-zephyr-sensitive-grant': grant });
  assert.equal(crossTarget.status, 403);
  assert.equal(await errorCode(crossTarget), 'sensitive_verification_required');
  assert.equal(store.getDeviceRow(otherDevice), null);

  const failedBusinessWrite = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', targetDevice, { keys: {} }), { 'x-zephyr-sensitive-grant': grant });
  assert.equal(failedBusinessWrite.status, 400);
  assert.equal(await errorCode(failedBusinessWrite), 'invalid_request');
  assert.equal(store.getDeviceRow(targetDevice), null);

  const bound = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', targetDevice), { 'x-zephyr-sensitive-grant': grant });
  assert.equal(bound.status, 200, 'bind failure must roll grant consumption back with the device write');
  const boundBody = await bound.json();
  assert.equal(boundBody.device.deviceId, targetDevice);
  assert.equal(boundBody.bindingProtocolVersion, 2);

  const replay = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', targetDevice, {
      bindingProtocolVersion: 2,
      bindReceipt: verifiedBody.bindAttempt.receipt,
    }), { 'x-zephyr-sensitive-grant': grant });
  assert.equal(replay.status, 200, 'the same bind receipt is an idempotent transport replay');
  const replayBody = await replay.json();
  assert.equal(replayBody.bindingRevision, boundBody.bindingRevision);
  assert.equal(replayBody.bindingToken, boundBody.bindingToken);
  assert.equal(replayBody.refreshCredential, boundBody.refreshCredential);
  assert.equal(Number(store.getDeviceRow(targetDevice).refresh_generation), 1,
    'receipt replay must not rotate an existing binding');

  const lateTokenProof = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', targetDevice, {
      tokenSecret: 'old-token-secret',
      keys: {
        encryption: { alg: 'ML-KEM-768', publicKey: Buffer.alloc(1184, 9).toString('base64') },
        signing: { alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: 'late', y: 'late' } },
      },
    }));
  assert.equal(lateTokenProof.status, 403,
    'legacy token proof remains initial-bind compatible but cannot perform an unfenced rebind');
  assert.equal(await errorCode(lateTokenProof), 'sensitive_verification_required');
  assert.equal(JSON.parse(store.getDeviceRow(targetDevice).signing_public_jwk).x, 'x');

  const verifyA = await post('/api/mobile/v1/sensitive/verify', 'sid-stolen', {
    action: 'device.bind', secret: 'correct-password', targetIds: ['tok_old', targetDevice],
  });
  const verifyB = await post('/api/mobile/v1/sensitive/verify', 'sid-stolen', {
    action: 'device.bind', secret: 'correct-password', targetIds: ['tok_old', targetDevice],
  });
  const attemptA = await verifyA.json();
  const attemptB = await verifyB.json();
  assert.equal(attemptA.bindAttempt.expectedBindingRevision, 1);
  assert.equal(attemptA.bindAttempt.expectedRefreshGeneration, 1);
  assert.equal(attemptB.bindAttempt.expectedBindingRevision, 1);

  const raceBody = (marker) => bindBody('tok_old', targetDevice, {
    deviceName: `Race ${marker}`,
    keys: {
      encryption: { alg: 'ML-KEM-768', publicKey: Buffer.alloc(1184, marker.charCodeAt(0)).toString('base64') },
      signing: { alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: `x-${marker}`, y: `y-${marker}` } },
    },
  });
  const winnerB = await post('/api/mobile/v1/devices/bind', 'sid-stolen', raceBody('B'), {
    'x-zephyr-sensitive-grant': attemptB.grant,
  });
  assert.equal(winnerB.status, 200);
  assert.equal((await winnerB.json()).bindingRevision, 2);

  const staleA = await post('/api/mobile/v1/devices/bind', 'sid-stolen', raceBody('A'), {
    'x-zephyr-sensitive-grant': attemptA.grant,
  });
  assert.equal(staleA.status, 409);
  const staleError = (await staleA.json()).error;
  assert.equal(staleError.code, 'revision_conflict');
  assert.deepEqual(staleError.details, {
    reason: 'bind_attempt_stale',
    expectedBindingRevision: 1,
    currentBindingRevision: 2,
    expectedRefreshGeneration: 1,
    currentRefreshGeneration: 2,
  });
  assert.equal(JSON.parse(store.getDeviceRow(targetDevice).signing_public_jwk).x, 'x-B');

  const legacyDevice = 'device-bind-auth-0003';
  const tokenProof = await post('/api/mobile/v1/devices/bind', 'sid-stolen',
    bindBody('tok_old', legacyDevice, { tokenSecret: 'old-token-secret' }));
  assert.equal(tokenProof.status, 200, 'a pre-session Client Token secret remains a valid proof');

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await post('/api/mobile/v1/sensitive/verify', 'sid-rate', {
      action: 'device.revoke', secret: 'wrong-password', targetIds: ['device-rate-test'],
    });
    assert.equal(response.status, 403);
  }
  const limited = await post('/api/mobile/v1/sensitive/verify', 'sid-rate', {
    action: 'device.revoke', secret: 'wrong-password', targetIds: ['device-rate-test'],
  });
  assert.equal(limited.status, 429);
  assert.equal(await errorCode(limited), 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
