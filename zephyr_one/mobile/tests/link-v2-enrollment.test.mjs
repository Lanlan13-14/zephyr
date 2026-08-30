import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProofClient } from './mobile-v1-proof-client.mjs';

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
const zsl = require(path.join(repoRoot, 'link-v2-zsl.js'));
const codec = require(path.join(repoRoot, 'link-v2-codec.js'));
const { stopLinkV2Go } = require(path.join(repoRoot, 'link-v2-go-proxy.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function assertAndroidSyncChange(change) {
  const spec = registry.entities.find((entry) => entry.type === change.entityType);
  assert.ok(spec, `unknown entity type ${change.entityType}`);
  assert.ok(Number.isSafeInteger(change.changeSeq) && change.changeSeq >= 0,
    `${change.entityType} has invalid changeSeq ${change.changeSeq}`);
  assert.ok(typeof change.entityId === 'string' && change.entityId.length > 0,
    `${change.entityType} has a blank entityId`);
  assert.ok(change.action === 'upsert' || change.action === 'delete',
    `${change.entityType} has invalid action ${change.action}`);
  assert.ok(Number.isSafeInteger(change.revision) && change.revision > 0,
    `${change.entityType} has invalid revision ${change.revision}`);
  assert.ok(Number.isSafeInteger(change.changedAt) && change.changedAt > 0,
    `${change.entityType} has invalid changedAt ${change.changedAt}`);
  const editable = new Set(spec.editableFields || []);
  const forbidden = new Set([
    ...(spec.secretFields || []), ...(spec.serverAuthorityFields || []),
    ...(spec.opaquePreserveFields || []), ...(spec.deviceLocalFields || []),
  ]);
  const accepted = new Set();
  for (const field of change.fieldMask || []) {
    const root = String(field).split(/[.[]/, 1)[0];
    assert.ok(!forbidden.has(root) && !forbidden.has(field),
      `${change.entityType} fieldMask contains forbidden ${field}`);
    assert.ok(editable.has(root) || editable.has(field),
      `${change.entityType} fieldMask contains unknown ${field}`);
    assert.ok(!accepted.has(field), `${change.entityType} fieldMask duplicates ${field}`);
    accepted.add(field);
  }
  const payload = change.payload || {};
  for (const secret of spec.secretFields || []) {
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, secret),
      `${change.entityType} payload exposes secret ${secret}`);
  }
  if (change.action === 'delete') assert.deepEqual(payload, {});
}

function buildCurrentGoLinkServer(t) {
  const output = path.join(os.tmpdir(), `zephyr-link-server-${process.pid}-${Date.now()}`);
  const go = fs.existsSync('/usr/local/go126/bin/go') ? '/usr/local/go126/bin/go' : 'go';
  const built = spawnSync(go, ['build', '-trimpath', '-o', output, './cmd/zephyr-link-server'], {
    cwd: path.join(repoRoot, 'zephyr-link'),
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  t.after(() => fs.rmSync(output, { force: true }));
  return output;
}

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

test('real server closes enrollment -> device list -> Go handshake -> SYNC_ACK loop', async (t) => {
  process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = '1';
  process.env.ZEPHYR_LINK_GO_BIN = buildCurrentGoLinkServer(t);
  const { TestServer } = await import(pathToFileURL(path.join(repoRoot, 'tests', 'test-server.mjs')).href);
  const server = await new TestServer().start();
  t.after(async () => {
    try { stopLinkV2Go(); } catch {}
    await server.cleanup();
  });

  const signing = generateSigningKey();
  const keys = deviceKeys(signing.jwk, 31);
  const deviceId = 'device-android-loop-0001';
  const create = await fetch(server.url('/api/link/v2/enrollments'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      deviceName: 'Pixel Loop',
      platform: 'android',
      appVersion: 'pre45',
      keys,
    }),
  });
  assert.equal(create.status, 201, await create.clone().text());
  const created = await create.json();

  const login = await server.bootstrapAdmin();
  const approve = await fetch(server.url('/link/approve'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookie },
    body: new URLSearchParams({
      bindId: created.bindId,
      userCode: created.userCode,
      decision: 'approve',
    }),
  });
  assert.equal(approve.status, 200, await approve.clone().text());

  const payload = proofPayload({
    bindId: created.bindId,
    deviceId,
    userCode: created.userCode,
    sas: created.sas,
    secretHash: sha256(created.enrollmentSecret),
    serverId: created.serverId,
  });
  const consume = await fetch(server.url(`/api/link/v2/enrollments/${created.bindId}/consume`), {
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
  const binding = await consume.json();
  const serverNote = await server.api(login.cookie, 'POST', '/api/notes', {
    title: 'server-to-device',
    content: 'must arrive in bootstrap',
  });
  assert.equal(serverNote.status, 200);
  const serverNoteId = serverNote.body.note.noteId;
  const proofFetch = createProofClient({
    base: server.url(''),
    access: binding.accessCredential,
    deviceId,
    privateKey: signing.privateKey,
  });
  let pageToken = null;
  let snapshot = null;
  const bootstrapEntities = [];
  do {
    const pathname = '/api/mobile/v1/sync/bootstrap?pageSize=50' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const bootstrap = await proofFetch(pathname);
    assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
    const page = await bootstrap.json();
    assert.equal(page.ok, true);
    if (snapshot === null) snapshot = page;
    else assert.equal(page.snapshotCursor, snapshot.snapshotCursor);
    bootstrapEntities.push(...page.entities);
    pageToken = page.complete ? null : page.nextPageToken;
    assert.ok(page.complete || pageToken);
  } while (pageToken);
  assert.ok(Number.isSafeInteger(snapshot.snapshotCursor));
  bootstrapEntities.forEach(assertAndroidSyncChange);
  assert.ok(bootstrapEntities.some((change) =>
    change.entityType === 'note' && change.entityId === serverNoteId && change.payload.title === 'server-to-device'
  ));

  const devices = await server.api(login.cookie, 'GET', '/api/one/clients');
  assert.equal(devices.status, 200);
  assert.ok(devices.body.clients.some((client) => client.clientId === deviceId));

  const init = zsl.handshakeInitiator();
  const handshake = await fetch(server.url('/api/link/v2/handshake'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      x25519Public: Buffer.from(init.x25519Public).toString('base64url'),
      mlkemPublic: Buffer.from(init.mlkemPublic).toString('base64url'),
    }),
  });
  assert.equal(handshake.status, 200, await handshake.clone().text());
  const hello = await handshake.json();
  const session = zsl.handshakeFinish(init, {
    x25519Public: Buffer.from(hello.x25519Public, 'base64url'),
    mlkemCiphertext: Buffer.from(hello.mlkemCiphertext, 'base64url'),
  });
  async function syncOp(body) {
    const sealed = session.seal(codec.pack({ kind: codec.KIND.SYNC_OP, body }));
    const push = await fetch(server.url('/api/link/v2/push'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: hello.sessionId,
        seq: sealed.seq,
        iv: Buffer.from(sealed.iv).toString('base64url'),
        ct: Buffer.from(sealed.ct).toString('base64url'),
        tag: Buffer.from(sealed.tag).toString('base64url'),
      }),
    });
    assert.equal(push.status, 200, await push.clone().text());
    const ack = await push.json();
    const unpacked = codec.unpack(session.open({
      seq: ack.seq,
      iv: Buffer.from(ack.iv, 'base64url'),
      ct: Buffer.from(ack.ct, 'base64url'),
      tag: Buffer.from(ack.tag, 'base64url'),
    }));
    assert.equal(unpacked.kind, codec.KIND.SYNC_ACK);
    return unpacked.body;
  }

  const deviceNoteId = 'note-device-upstream-0001';
  const pushed = await syncOp({
    op: 'push',
    protocolVersion: 1,
    deviceId,
    batchId: 'batch-device-upstream-1',
    baseCursor: snapshot.snapshotCursor,
    registryHash: binding.registryHash,
    operations: [{
      opId: 'op-device-upstream-1',
      entityType: 'note',
      entityId: deviceNoteId,
      action: 'upsert',
      baseRevision: 0,
      clientModifiedAt: Date.now(),
      fieldMask: ['title', 'content'],
      payload: { title: 'device-to-server', content: 'must arrive on main end' },
    }],
  });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.results[0].status, 'accepted', JSON.stringify(pushed));
  const upstream = await server.api(login.cookie, 'GET', `/api/notes/${deviceNoteId}`);
  assert.equal(upstream.status, 200);
  assert.equal(upstream.body.note.title, 'device-to-server');

  const mainAfterSnapshot = await server.api(login.cookie, 'POST', '/api/notes', {
    title: 'server-after-bootstrap',
    content: 'must arrive through changes',
  });
  assert.equal(mainAfterSnapshot.status, 200);
  const changedNoteId = mainAfterSnapshot.body.note.noteId;

  const changes = await syncOp({ op: 'changes', sinceCursor: snapshot.snapshotCursor, limit: 50 });
  assert.equal(changes.ok, true);
  assert.equal(changes.fromCursor, snapshot.snapshotCursor);
  assert.ok(changes.nextCursor > snapshot.snapshotCursor);
  changes.changes.forEach(assertAndroidSyncChange);
  assert.ok(changes.changes.some((change) =>
    change.entityType === 'note' && change.entityId === changedNoteId && change.payload.title === 'server-after-bootstrap'
  ));

  const acknowledged = await syncOp({ op: 'ack', cursor: changes.nextCursor, appliedOpIds: ['op-device-upstream-1'] });
  assert.equal(acknowledged.ok, true);

  const status = await syncOp({ op: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.state, 'IDLE', JSON.stringify(status));
  assert.equal(status.cursor, changes.nextCursor);
});
