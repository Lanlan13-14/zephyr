// Schema gates for anything that crosses the wire. A malformed operation must fail here, not on the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid } from '../tools/lib/json-schema.mjs';
import { schema, syncVectors, sharedUseVectors, openapi } from '../tools/lib/contracts.mjs';

const operationSchema = schema('sync-operation.schema.json');
const changeSchema = schema('sync-change.schema.json');
const secretSchema = schema('secret-envelope.schema.json');
const sharedSchema = schema('shared-use-envelope.schema.json');
const errorSchema = schema('error.schema.json');

test('the frozen accepted upsert vector validates', () => {
  assertValid(operationSchema, syncVectors().operations.acceptedUpsert, 'acceptedUpsert');
});

test('an upsert without a fieldMask is rejected', () => {
  const result = validate(operationSchema, syncVectors().operations.invalidMissingMask);
  assert.equal(result.valid, false, 'a maskless upsert would overwrite unknown fields');
});

test('upsert requires a non-empty mask; delete and restore require an empty one', () => {
  const base = { opId: 'op-1', entityType: 'note', entityId: 'n1', baseRevision: 1 };
  assert.equal(validate(operationSchema, { ...base, action: 'upsert', fieldMask: [], payload: {} }).valid, false);
  assert.equal(validate(operationSchema, { ...base, action: 'upsert', fieldMask: ['title'], payload: { title: 't' } }).valid, true);
  assert.equal(validate(operationSchema, { ...base, action: 'delete', fieldMask: [], payload: {} }).valid, true);
  assert.equal(validate(operationSchema, { ...base, action: 'delete', fieldMask: ['title'], payload: {} }).valid, false);
  assert.equal(validate(operationSchema, { ...base, action: 'delete', fieldMask: [], payload: { title: 't' } }).valid, false);
  assert.equal(validate(operationSchema, { ...base, action: 'restore', fieldMask: [], payload: {} }).valid, true);
  assert.equal(validate(operationSchema, { ...base, action: 'archive', fieldMask: [], payload: {} }).valid, false);
});

test('operations reject unknown top-level properties', () => {
  const op = { ...syncVectors().operations.acceptedUpsert, sneaky: true };
  assert.equal(validate(operationSchema, op).valid, false, 'additionalProperties must stay closed');
});

test('field mask entries must be plain field paths', () => {
  const base = { opId: 'op-1', entityType: 'note', entityId: 'n1', action: 'upsert', baseRevision: 1, payload: { title: 't' } };
  assert.equal(validate(operationSchema, { ...base, fieldMask: ['title'] }).valid, true);
  assert.equal(validate(operationSchema, { ...base, fieldMask: ['tags[0]'] }).valid, true);
  assert.equal(validate(operationSchema, { ...base, fieldMask: ['group.path'] }).valid, true);
  assert.equal(validate(operationSchema, { ...base, fieldMask: ['../etc/passwd'] }).valid, false);
  assert.equal(validate(operationSchema, { ...base, fieldMask: ['title', 'title'] }).valid, false, 'duplicates are ambiguous');
});

test('a change page entry carries payload for upsert and a tombstone for delete', () => {
  const upsert = {
    changeSeq: 4824, entityType: 'connection', entityId: 'c1', action: 'upsert',
    revision: 8, changedAt: 1786093200400, fieldMask: ['name'], payload: { name: 'Office' },
  };
  assertValid(changeSchema, upsert, 'upsert change');

  const del = {
    changeSeq: 4825, entityType: 'connection', entityId: 'c1', action: 'delete',
    revision: 9, changedAt: 1786093200500,
    tombstone: { deletedAt: 1786093200500, deletedBy: 'usr-1', lastKnownName: 'Office' },
  };
  assertValid(changeSchema, del, 'delete change');
  assert.equal(validate(changeSchema, { ...del, tombstone: undefined }).valid, false, 'a delete without a tombstone cannot be applied');
  assert.equal(validate(changeSchema, { ...upsert, payload: undefined }).valid, false);
  assert.equal(validate(changeSchema, { ...upsert, changeSeq: 0 }).valid, false, 'changeSeq is 1-based and monotonic');
});

test('secret envelopes pin algorithm, revision and key version', () => {
  const envelope = {
    v: 1,
    alg: 'ML-KEM-768+HKDF-SHA256+AES-256-GCM',
    kem: 'ML-KEM-768',
    aead: 'AES-256-GCM',
    ct: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    iv: 'AAECAwQFBgcICQoL',
    tag: 'AAECAwQFBgcICQoLDA0ODw==',
    data: 'eyJwYXNzd29yZCI6IjxzZWFsZWQ+In0=',
    aad: 'emVwaHly',
    keyVersion: 1,
    entityRevision: 8,
  };
  assertValid(secretSchema, envelope, 'secret envelope');
  assert.equal(validate(secretSchema, { ...envelope, alg: 'AES-256-GCM' }).valid, false, 'algorithm is not negotiable');
  assert.equal(validate(secretSchema, { ...envelope, kem: 'X25519' }).valid, false);
  assert.equal(validate(secretSchema, { ...envelope, entityRevision: 0 }).valid, false);
  assert.equal(validate(secretSchema, { ...envelope, keyVersion: 0 }).valid, false);
  assert.equal(validate(secretSchema, { ...envelope, plaintext: 'oops' }).valid, false, 'no plaintext field may exist');
});

test('shared use envelopes bind session, resource, purpose and expiry', () => {
  const accepted = sharedUseVectors().envelopes.acceptedSsh;
  assertValid(sharedSchema, accepted, 'accepted shared envelope');

  assert.equal(
    validate(sharedSchema, sharedUseVectors().envelopes.invalidPurpose).valid,
    false,
    'sftp is not a session purpose; only ssh/telnet/rdp/vnc are',
  );
  assert.equal(
    validate(sharedSchema, sharedUseVectors().envelopes.forbiddenControlPlaneField).valid,
    false,
    'a client token must never ride inside a use envelope',
  );
  assert.equal(validate(sharedSchema, { ...accepted, sessionId: 'short' }).valid, false, 'session ids must be unguessable');
  assert.equal(validate(sharedSchema, { ...accepted, clientNonce: 'tiny' }).valid, false);
  assert.equal(validate(sharedSchema, { ...accepted, expiresAt: 0 }).valid, false);
});

test('error envelopes always carry code, retryable and requestId', () => {
  const err = { ok: false, error: { code: 'sync_conflict', message: 'changed elsewhere', retryable: false, requestId: 'srv_1' } };
  assertValid(errorSchema, err, 'error envelope');
  assert.equal(validate(errorSchema, { ok: true, error: err.error }).valid, false);
  assert.equal(validate(errorSchema, { ok: false, error: { code: 'x', message: 'm', retryable: false } }).valid, false, 'requestId is required for support');
  assert.equal(validate(errorSchema, { ok: false, error: { ...err.error, secret: 'leak' } }).valid, false);
});

test('openapi describes every mobile v1 endpoint the client needs', () => {
  const paths = Object.keys(openapi().paths);
  for (const required of [
    '/api/auth/login',
    '/api/auth/totp/verify',
    '/api/mobile/v1/capabilities',
    '/api/mobile/v1/devices/bind',
    '/api/mobile/v1/devices/refresh',
    '/api/mobile/v1/sync/bootstrap',
    '/api/mobile/v1/sync/changes',
    '/api/mobile/v1/sync/push',
    '/api/mobile/v1/sync/ack',
    '/api/mobile/v1/sync/now',
    '/api/mobile/v1/sync/status',
    '/api/mobile/v1/sensitive/verify',
    '/api/mobile/v1/file-bridge/lease',
    '/api/mobile/v1/shared',
  ]) {
    assert.ok(paths.includes(required), 'openapi is missing ' + required);
  }
});
