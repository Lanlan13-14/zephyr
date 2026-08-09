// AAD is the only thing standing between a stolen ciphertext and a transplanted credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secretAadBytes, secretAadHex, sharedUseAadBytes, sharedUseAadHex, aadEquals, SECRET_AAD_FIELDS, SHARED_AAD_FIELDS } from '../tools/lib/aad.mjs';
import { syncVectors, sharedUseVectors } from '../tools/lib/contracts.mjs';
import { aadVectors } from '../tools/lib/fixtures.mjs';

const SECRET = {
  serverId: 'srv-1', userId: 'usr-1', deviceId: 'dev-1',
  entityType: 'connection', entityId: 'conn-1', fieldName: 'password',
  entityRevision: 8, keyVersion: 1,
};

const SHARED = {
  serverId: 'srv-1', userId: 'usr-2', deviceId: 'dev-1', sessionId: 'sess-1',
  resourceId: 'conn-7', resourceRevision: 9, purpose: 'ssh',
  expiresAt: 1786093230000, clientNonce: 'nonce-1234567890abcdef',
};

test('secret AAD matches the frozen contract vector', () => {
  assert.equal(secretAadHex(SECRET), syncVectors().aad.hex);
  assert.deepEqual([...SECRET_AAD_FIELDS], syncVectors().aad.fields);
});

test('shared use AAD matches the frozen contract vector', () => {
  const frozen = sharedUseVectors().aad;
  assert.equal(sharedUseAadHex(SHARED), frozen.hex);
  assert.equal(sharedUseAadBytes(SHARED).toString('base64'), frozen.base64);
  assert.deepEqual([...SHARED_AAD_FIELDS], frozen.fields);
});

test('fields are NUL separated with no separator inside the payload', () => {
  const bytes = secretAadBytes(SECRET);
  const separators = [...bytes].filter((b) => b === 0x00).length;
  assert.equal(separators, SECRET_AAD_FIELDS.length - 1, 'exactly one NUL between each field');
});

test('changing any secret AAD field changes the bytes', () => {
  const base = secretAadHex(SECRET);
  const mutations = {
    serverId: 'srv-2', userId: 'usr-9', deviceId: 'dev-2', entityType: 'sshKey',
    entityId: 'conn-2', fieldName: 'privateKey', entityRevision: 9, keyVersion: 2,
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(secretAadHex({ ...SECRET, [field]: value }), base, field + ' does not bind the ciphertext');
  }
});

test('changing any shared AAD field changes the bytes', () => {
  const base = sharedUseAadHex(SHARED);
  const mutations = {
    deviceId: 'dev-2', sessionId: 'sess-2', resourceId: 'conn-8', resourceRevision: 10,
    purpose: 'rdp', expiresAt: 1786093230001, clientNonce: 'nonce-fedcba0987654321',
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(sharedUseAadHex({ ...SHARED, [field]: value }), base, field + ' is replayable');
  }
});

test('integers must be decimal ASCII without leading zeros', () => {
  assert.throws(() => secretAadBytes({ ...SECRET, entityRevision: '08' }), /leading zeros/);
  assert.throws(() => secretAadBytes({ ...SECRET, keyVersion: -1 }), /non-negative integer/);
  assert.throws(() => secretAadBytes({ ...SECRET, entityRevision: 1.5 }), /non-negative integer/);
});

test('empty AAD parts are rejected instead of collapsing separators', () => {
  assert.throws(() => secretAadBytes({ ...SECRET, fieldName: '' }), /non-empty/);
  assert.throws(() => sharedUseAadBytes({ ...SHARED, sessionId: '' }), /non-empty/);
});

test('constant-time compare accepts equal and rejects near-miss AAD', () => {
  const a = secretAadBytes(SECRET);
  assert.equal(aadEquals(a, secretAadBytes(SECRET)), true);
  assert.equal(aadEquals(a, secretAadBytes({ ...SECRET, keyVersion: 2 })), false);
  assert.equal(aadEquals(a.toString('base64'), a.toString('base64')), true);
});

test('generated fixtures cover every AAD field and stay self-consistent', () => {
  const fixture = aadVectors();
  for (const entry of fixture.cases) {
    const bytes = entry.kind === 'secret' ? secretAadBytes(entry.input) : sharedUseAadBytes(entry.input);
    assert.equal(bytes.toString('hex'), entry.expectedHex, entry.name);
    assert.equal(bytes.length, entry.expectedLength, entry.name);
  }
  for (const field of SECRET_AAD_FIELDS.filter((f) => f !== 'prefix')) {
    assert.ok(fixture.cases.some((c) => c.name === 'secret-mutated-' + field), 'no fixture mutates ' + field);
  }
  for (const entry of fixture.rejects) {
    assert.throws(() => (entry.kind === 'secret' ? secretAadBytes(entry.input) : sharedUseAadBytes(entry.input)), entry.name);
  }
});
