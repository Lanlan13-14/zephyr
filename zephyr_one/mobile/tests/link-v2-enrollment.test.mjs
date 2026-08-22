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
const {
  LinkV2EnrollmentStore,
  createLinkV2EnrollmentApi,
  proofPayload,
  SENTINEL_TOKEN_ID,
  sha256,
} = require(path.join(repoRoot, 'link-v2-enrollment.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-link-enroll-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  const store = new MobileV1Store({ db, entityRegistry: registry });
  store._hmacKey = crypto.randomBytes(32);
  const enrollments = new LinkV2EnrollmentStore({ db });
  return { dir, db, store, enrollments };
}

function generateSigningKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
}

function deviceKeys(signingJwk, fill = 9) {
  return {
    encryption: { alg: 'ML-KEM-768', publicKey: Buffer.alloc(1184, fill).toString('base64') },
    signing: { alg: 'ES256', jwk: signingJwk },
  };
}

function signProof(privateKey, payload) {
  return crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

function createPending(enrollments, keys, extras = {}) {
  return enrollments.create({
    deviceId: extras.deviceId || 'device-android-0001',
    deviceName: extras.deviceName || 'Pixel Test',
    platform: extras.platform || 'android',
    appVersion: extras.appVersion || '1.0.0pre29',
    keys,
    origin: 'https://zephyr.example',
    serverId: extras.serverId || 'srv-test',
    ip: extras.ip || '127.0.0.1',
  });
}

test('enrollment does not require a Client Token', () => {
  const { enrollments } = openStore();
  const { jwk } = generateSigningKey();
  const created = createPending(enrollments, deviceKeys(jwk));
  assert.equal(created.userCode.includes('-'), true);
  assert.equal(created.enrollmentSecret.length >= 32, true);
  assert.equal(created.sas.split('-').length, 4);
  assert.equal(created.fingerprint.length, 64);
  const row = enrollments.get(created.bindId);
  assert.equal(row.status, 'pending');
  assert.equal(row.owner_user_id, null);
});

test('wrong userCode cannot read enrollment status', () => {
  const { enrollments } = openStore();
  const { jwk } = generateSigningKey();
  const created = createPending(enrollments, deviceKeys(jwk));
  assert.throws(
    () => enrollments.statusForDevice({ bindId: created.bindId, userCode: 'AAAA-AAAA', ip: '1.1.1.1' }),
    (err) => err.code === 'resource_not_found_or_inaccessible' && err.status === 404,
  );
});

test('consume before approve is rejected and consume after deny stays denied', () => {
  const { enrollments, store } = openStore();
  const signing = generateSigningKey();
  const keys = deviceKeys(signing.jwk);
  const created = createPending(enrollments, keys);
  const payload = proofPayload({
    bindId: created.bindId,
    deviceId: created.deviceId,
    userCode: created.userCode,
    sas: created.sas,
    secretHash: sha256(created.enrollmentSecret),
    serverId: created.serverId,
  });
  const proof = signProof(signing.privateKey, payload);
  assert.throws(
    () => enrollments.consume({
      bindId: created.bindId,
      userCode: created.userCode,
      enrollmentSecret: created.enrollmentSecret,
      proof,
      keys,
      store,
      bindDevice() { throw new Error('must not bind'); },
    }),
    (err) => err.code === 'enrollment_not_approved',
  );
  enrollments.deny({
    bindId: created.bindId,
    userCode: created.userCode,
    user: { userId: 'u1', username: 'alice' },
    ip: '127.0.0.1',
  });
  assert.throws(
    () => enrollments.consume({
      bindId: created.bindId,
      userCode: created.userCode,
      enrollmentSecret: created.enrollmentSecret,
      proof,
      keys,
      store,
      bindDevice() { throw new Error('must not bind'); },
    }),
    (err) => err.code === 'enrollment_denied',
  );
});

test('approved enrollment consumes once and binds without a real Client Token', () => {
  const { enrollments, store, db } = openStore();
  const signing = generateSigningKey();
  const keys = deviceKeys(signing.jwk, 11);
  const created = createPending(enrollments, keys);
  enrollments.approve({
    bindId: created.bindId,
    userCode: created.userCode,
    user: { userId: 'user-1', username: 'alice' },
    ip: '10.0.0.8',
  });
  const payload = proofPayload({
    bindId: created.bindId,
    deviceId: created.deviceId,
    userCode: created.userCode,
    sas: created.sas,
    secretHash: sha256(created.enrollmentSecret),
    serverId: created.serverId,
  });
  const proof = signProof(signing.privateKey, payload);
  const result = db.transaction(() => enrollments.consume({
    bindId: created.bindId,
    userCode: created.userCode,
    enrollmentSecret: created.enrollmentSecret,
    proof,
    keys,
    store,
    bindDevice({ ownerUserId, ownerUsername, deviceId, deviceName, platform, appVersion, tokenId, keys: deviceKeys }) {
      const attempt = store.beginBindAttempt({
        ownerUserId,
        deviceId,
        tokenId,
        requestId: 'req-1',
      });
      return store.bindDevice({
        ownerUserId,
        ownerUsername,
        deviceId,
        deviceName,
        platform,
        appVersion,
        tokenId,
        keys: deviceKeys,
        syncIntervalSec: 300,
        attempt,
        requestFingerprint: MobileV1Store.bindRequestFingerprint({
          deviceId,
          deviceName,
          platform,
          appVersion,
          tokenId,
          keys: deviceKeys,
          syncIntervalSec: 300,
        }),
      });
    },
  }))();
  assert.equal(result.enrollment.status, 'consumed');
  assert.equal(result.bound.row.token_id, SENTINEL_TOKEN_ID);
  assert.equal(result.bound.row.owner_user_id, 'user-1');
  assert.ok(result.bound.accessCredential);
  assert.ok(result.bound.refreshCredential);
  assert.throws(
    () => enrollments.consume({
      bindId: created.bindId,
      userCode: created.userCode,
      enrollmentSecret: created.enrollmentSecret,
      proof,
      keys,
      store,
      bindDevice() { throw new Error('second consume must not bind'); },
    }),
    (err) => err.code === 'enrollment_consumed',
  );
});

test('stolen enrollment secret without the device private key cannot consume', () => {
  const { enrollments, store } = openStore();
  const signing = generateSigningKey();
  const attacker = generateSigningKey();
  const keys = deviceKeys(signing.jwk, 3);
  const created = createPending(enrollments, keys);
  enrollments.approve({
    bindId: created.bindId,
    userCode: created.userCode,
    user: { userId: 'user-1', username: 'alice' },
    ip: '10.0.0.8',
  });
  const payload = proofPayload({
    bindId: created.bindId,
    deviceId: created.deviceId,
    userCode: created.userCode,
    sas: created.sas,
    secretHash: sha256(created.enrollmentSecret),
    serverId: created.serverId,
  });
  const forged = signProof(attacker.privateKey, payload);
  assert.throws(
    () => enrollments.consume({
      bindId: created.bindId,
      userCode: created.userCode,
      enrollmentSecret: created.enrollmentSecret,
      proof: forged,
      keys,
      store,
      bindDevice() { throw new Error('forged proof must not bind'); },
    }),
    (err) => err.code === 'device_proof_invalid',
  );
});

test('HTTP enrollment create, browser approval, consume, and logout redirect', async (t) => {
  const { enrollments, store } = openStore();
  const sessions = new Map([
    ['sid-alice', { userId: 'user-1', username: 'alice' }],
  ]);
  const api = createLinkV2EnrollmentApi({
    enrollments,
    store,
    resolveSession: (req) => {
      const cookie = String(req.headers.cookie || '');
      const match = /zephyr_sid=([^;]+)/.exec(cookie);
      return match ? sessions.get(decodeURIComponent(match[1])) : null;
    },
    publicOrigin: () => 'https://zephyr.example',
    qrcode: { toDataURL: async (text) => 'data:image/png;base64,' + Buffer.from(String(text)).toString('base64') },
  });
  const app = express();
  app.use(express.json());
  app.use('/link/approve', express.urlencoded({ extended: false }));
  api.mount(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signing = generateSigningKey();
  const keys = deviceKeys(signing.jwk, 21);

  const createdRes = await fetch(`${base}/api/link/v2/enrollments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'device-android-http01',
      deviceName: 'Pixel HTTP',
      platform: 'android',
      appVersion: '1.0.0',
      keys,
    }),
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  assert.equal(created.ok, true);
  assert.equal(created.verificationUri, `https://zephyr.example/link/approve?bindId=${created.bindId}`);
  assert.ok(created.qrDataUrl.startsWith('data:image/png;base64,'));
  assert.ok(!JSON.stringify(created).includes('clientToken'));

  const anonApprove = await fetch(`${base}/link/approve?bindId=${created.bindId}`, { redirect: 'manual' });
  assert.equal(anonApprove.status, 302);
  assert.equal(
    anonApprove.headers.get('location'),
    `/?returnTo=${encodeURIComponent('/link/approve?bindId=' + created.bindId)}`,
  );

  const approvePage = await fetch(`${base}/link/approve?bindId=${created.bindId}`, {
    headers: { cookie: 'zephyr_sid=sid-alice' },
  });
  assert.equal(approvePage.status, 200);
  const html = await approvePage.text();
  assert.match(html, /批准这台设备/);
  assert.match(html, new RegExp(created.sas));
  assert.match(html, /Pixel HTTP/);

  const approve = await fetch(`${base}/link/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'zephyr_sid=sid-alice',
    },
    body: new URLSearchParams({
      bindId: created.bindId,
      userCode: created.userCode,
      decision: 'approve',
    }),
  });
  assert.equal(approve.status, 200);
  assert.match(await approve.text(), /已批准该设备/);

  const status = await fetch(
    `${base}/api/link/v2/enrollments/${created.bindId}?userCode=${encodeURIComponent(created.userCode)}`,
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status, 'approved');

  const payload = proofPayload({
    bindId: created.bindId,
    deviceId: created.deviceId,
    userCode: created.userCode,
    sas: created.sas,
    secretHash: sha256(created.enrollmentSecret),
    serverId: created.serverId,
  });
  const consume = await fetch(`${base}/api/link/v2/enrollments/${created.bindId}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userCode: created.userCode,
      enrollmentSecret: created.enrollmentSecret,
      proof: signProof(signing.privateKey, payload),
      keys,
      syncIntervalSec: 300,
    }),
  });
  assert.equal(consume.status, 200, await consume.clone().text());
  const bundle = await consume.json();
  assert.equal(bundle.ok, true);
  assert.equal(bundle.device.tokenId, SENTINEL_TOKEN_ID);
  assert.equal(bundle.bootstrapRequired, true);
  assert.ok(bundle.accessCredential);
  assert.ok(bundle.refreshCredential);

  const replay = await fetch(`${base}/api/link/v2/enrollments/${created.bindId}/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userCode: created.userCode,
      enrollmentSecret: created.enrollmentSecret,
      proof: signProof(signing.privateKey, payload),
      keys,
    }),
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'enrollment_consumed');
});
