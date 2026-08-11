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
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function openStore(databasePath, key, logs) {
  const db = createDatabase(databasePath, { forceBuiltin: true });
  const store = new MobileV1Store({ db, entityRegistry: registry, log: (...args) => logs.push(args) });
  // The production key is durable on disk. Keeping the same key across these
  // two store instances models a process restart without touching global state.
  store._hmacKey = key;
  return { db, store };
}

function request(tokenId, deviceId, marker) {
  return {
    deviceId,
    deviceName: `CAS ${marker}`,
    platform: 'ios',
    appVersion: `2.0.${marker.charCodeAt(0)}`,
    tokenId,
    keys: {
      encryption: {
        alg: 'ML-KEM-768',
        publicKey: Buffer.alloc(1184, marker.charCodeAt(0)).toString('base64'),
      },
      signing: {
        alg: 'ES256',
        jwk: { kty: 'EC', crv: 'P-256', x: `x-${marker}`, y: `y-${marker}` },
      },
    },
    syncIntervalSec: 300,
  };
}

function authorize(store, ownerUserId, bindRequest, requestId) {
  const attempt = store.beginBindAttempt({
    ownerUserId,
    deviceId: bindRequest.deviceId,
    tokenId: bindRequest.tokenId,
    requestId,
  });
  const grant = store.createGrant({
    ownerUserId,
    action: 'device.bind',
    targetIds: [bindRequest.tokenId, bindRequest.deviceId],
    requestId,
    bindAttemptHash: attempt.attemptHash,
  });
  return { attempt, ...grant };
}

function commit(db, store, ownerUserId, ownerUsername, bindRequest, authority) {
  const requestFingerprint = MobileV1Store.bindRequestFingerprint(bindRequest);
  return db.transaction(() => {
    const claimed = store.claimBindAttempt({
      ownerUserId,
      deviceId: bindRequest.deviceId,
      tokenId: bindRequest.tokenId,
      grant: authority.grant,
      receipt: authority.attempt.receipt,
      requestFingerprint,
    });
    if (claimed.replay) return store.replayBindAttempt(claimed);
    return store.bindDevice({
      ownerUserId,
      ownerUsername,
      ...bindRequest,
      attempt: claimed.attempt,
      requestFingerprint,
    });
  })();
}

test('bind attempts fence late scenes, survive restart, replay idempotently and redact receipts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-bind-cas-'));
  const databasePath = path.join(dir, 'mobile.db');
  const key = Buffer.alloc(32, 91);
  const logs = [];
  const owner = 'bind-cas-owner';
  const deviceId = 'device-bind-cas-0001';
  let current = openStore(databasePath, key, logs);

  try {
    const requestA = request('token-A', deviceId, 'A');
    const requestB = request('token-B', deviceId, 'B');
    const tokenSecret = 'legacy-token-secret-must-not-persist';
    assert.equal(
      MobileV1Store.bindRequestFingerprint(requestB),
      MobileV1Store.bindRequestFingerprint({ ...requestB, tokenSecret }),
      'tokenSecret must not enter the durable request fingerprint',
    );
    const authorityA = authorize(current.store, owner, requestA, 'attempt-A');
    const authorityB = authorize(current.store, owner, requestB, 'attempt-B');
    assert.equal(authorityA.attempt.expectedBindingRevision, 0);
    assert.equal(authorityB.attempt.expectedBindingRevision, 0);
    assert.notEqual(authorityA.attempt.receipt, authorityB.attempt.receipt);

    const winnerB = commit(current.db, current.store, owner, 'alice', requestB, authorityB);
    assert.equal(winnerB.bindingRevision, 1);
    assert.equal(Number(winnerB.row.refresh_generation), 1);

    assert.throws(
      () => commit(current.db, current.store, owner, 'alice', requestA, authorityA),
      (error) => error.code === 'revision_conflict'
        && error.details?.reason === 'bind_attempt_stale',
      'attempt A must not overwrite winner B after observing the same prior revision',
    );
    const liveAfterA = current.store.getDeviceRow(deviceId);
    assert.equal(liveAfterA.token_id, 'token-B');
    assert.equal(JSON.parse(liveAfterA.signing_public_jwk).y, 'y-B');
    assert.equal(Buffer.from(liveAfterA.encryption_public_key)[0], 'B'.charCodeAt(0));
    assert.equal(current.db.prepare(`SELECT consumed_at FROM mobile_sensitive_grants
      WHERE grant_hash = ?`).get(
      require('crypto').createHash('sha256').update(authorityA.grant).digest('hex'),
    ).consumed_at, null, 'the stale CAS rolls grant consumption back atomically');

    const replayB = commit(current.db, current.store, owner, 'alice', requestB, authorityB);
    assert.equal(replayB.bindingRevision, winnerB.bindingRevision);
    assert.equal(replayB.bindingToken, winnerB.bindingToken);
    assert.equal(replayB.refreshCredential, winnerB.refreshCredential);
    assert.equal(Number(current.store.getDeviceRow(deviceId).refresh_generation), 1);

    const changedReplay = request('token-B', deviceId, 'X');
    assert.throws(
      () => commit(current.db, current.store, owner, 'alice', changedReplay, authorityB),
      (error) => error.code === 'revision_conflict'
        && error.details?.reason === 'bind_receipt_mismatch',
      'one receipt cannot authorize different JWK or ML-KEM material',
    );
    assert.throws(
      () => current.db.transaction(() => current.store.claimBindAttempt({
          ownerUserId: 'other-owner', deviceId, tokenId: 'token-B', grant: authorityB.grant,
          receipt: authorityB.attempt.receipt,
          requestFingerprint: MobileV1Store.bindRequestFingerprint(requestB),
        }))(),
      (error) => error.code === 'sensitive_verification_required',
    );
    assert.throws(
      () => current.db.transaction(() => current.store.claimBindAttempt({
          ownerUserId: owner, deviceId: 'device-bind-cas-9999', tokenId: 'token-B',
          grant: authorityB.grant, receipt: authorityB.attempt.receipt,
          requestFingerprint: MobileV1Store.bindRequestFingerprint(requestB),
        }))(),
      (error) => error.code === 'sensitive_verification_required',
    );

    const persistedSecrets = [
      authorityA.attempt.receipt,
      authorityB.attempt.receipt,
      authorityA.grant,
      authorityB.grant,
      winnerB.refreshCredential,
      winnerB.bindingToken,
      tokenSecret,
    ];
    const databaseText = JSON.stringify({
      attempts: current.db.prepare('SELECT * FROM mobile_device_bind_attempts').all(),
      grants: current.db.prepare('SELECT * FROM mobile_sensitive_grants').all(),
      changes: current.db.prepare('SELECT * FROM mobile_sync_changes').all(),
    });
    for (const secret of persistedSecrets) {
      assert.equal(databaseText.includes(secret), false, 'raw bind authorities must not enter SQLite/feed');
      assert.equal(JSON.stringify(logs).includes(secret), false, 'raw bind authorities must not enter logs');
    }

    current.db.close();
    current = openStore(databasePath, key, logs);
    const replayAfterRestart = commit(current.db, current.store, owner, 'alice', requestB, authorityB);
    assert.equal(replayAfterRestart.bindingRevision, winnerB.bindingRevision);
    assert.equal(replayAfterRestart.bindingToken, winnerB.bindingToken);
    assert.equal(replayAfterRestart.refreshCredential, winnerB.refreshCredential);

    const replayExpiryRequest = request('token-replay-expiry', 'device-bind-cas-0002', 'R');
    const replayExpiry = authorize(current.store, owner, replayExpiryRequest, 'attempt-replay-expiry');
    commit(current.db, current.store, owner, 'alice', replayExpiryRequest, replayExpiry);
    current.db.prepare(`UPDATE mobile_device_bind_attempts SET replay_expires_at = 0
      WHERE attempt_hash = ?`).run(replayExpiry.attempt.attemptHash);
    assert.throws(
      () => commit(current.db, current.store, owner, 'alice', replayExpiryRequest, replayExpiry),
      (error) => error.code === 'sensitive_grant_expired',
      'a completed receipt is idempotent only inside its original expiry window',
    );

    const requestC = request('token-C', deviceId, 'C');
    const authorityC = authorize(current.store, owner, requestC, 'attempt-C');
    assert.equal(authorityC.attempt.expectedBindingRevision, 1);
    assert.equal(authorityC.attempt.expectedRefreshGeneration, 1);
    const winnerC = commit(current.db, current.store, owner, 'alice', requestC, authorityC);
    assert.equal(winnerC.bindingRevision, 2);
    assert.equal(Number(winnerC.row.refresh_generation), 2);
    assert.throws(
      () => commit(current.db, current.store, owner, 'alice', requestB, authorityB),
      (error) => error.code === 'revision_conflict'
        && error.details?.reason === 'bind_attempt_stale',
      'a completed old receipt cannot be replayed after a newer rebind',
    );

    const generationRequest = request('token-generation', deviceId, 'G');
    const generationAttempt = authorize(current.store, owner, generationRequest, 'attempt-generation');
    assert.equal(generationAttempt.attempt.expectedBindingRevision, 2);
    assert.equal(generationAttempt.attempt.expectedRefreshGeneration, 2);
    current.store.rotateRefresh(deviceId, winnerC.refreshCredential);
    assert.throws(
      () => commit(current.db, current.store, owner, 'alice', generationRequest, generationAttempt),
      (error) => error.code === 'revision_conflict'
        && error.details?.reason === 'bind_attempt_stale'
        && error.details?.expectedBindingRevision === 2
        && error.details?.currentBindingRevision === 2
        && error.details?.expectedRefreshGeneration === 2
        && error.details?.currentRefreshGeneration === 3,
      'refresh rotation after attempt issuance invalidates its credential-generation CAS',
    );
    assert.equal(Number(current.store.getDeviceRow(deviceId).refresh_generation), 3);

    const expiredRequest = request('token-expired', deviceId, 'E');
    const expired = authorize(current.store, owner, expiredRequest, 'attempt-expired');
    current.db.prepare(`UPDATE mobile_device_bind_attempts SET expires_at = 0
      WHERE attempt_hash = ?`).run(expired.attempt.attemptHash);
    assert.throws(
      () => commit(current.db, current.store, owner, 'alice', expiredRequest, expired),
      (error) => error.code === 'sensitive_grant_expired',
    );

    const pendingRequest = request('token-cleanup', deviceId, 'D');
    const pending = authorize(current.store, owner, pendingRequest, 'attempt-cleanup');
    current.store.deleteUserState(owner);
    assert.equal(current.store.getDeviceRow(deviceId), null);
    assert.throws(
      () => current.db.transaction(() => current.store.claimBindAttempt({
          ownerUserId: owner,
          deviceId,
          tokenId: pendingRequest.tokenId,
          grant: pending.grant,
          receipt: pending.attempt.receipt,
          requestFingerprint: MobileV1Store.bindRequestFingerprint(pendingRequest),
        }))(),
      (error) => error.code === 'sensitive_verification_required',
      'account cleanup removes both the grant and its bind attempt',
    );
  } finally {
    try { current.db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
