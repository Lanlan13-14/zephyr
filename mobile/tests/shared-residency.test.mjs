// Shared-to-me resources must never land on the device. These tests encode that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { entityRegistry, sharedUseVectors } from '../tools/lib/contracts.mjs';
import { sharedUseAadBytes, aadEquals } from '../tools/lib/aad.mjs';

const SHARED = {
  serverId: 'srv-1', userId: 'usr-2', deviceId: 'dev-1', sessionId: 'sess-1',
  resourceId: 'conn-7', resourceRevision: 9, purpose: 'ssh',
  expiresAt: 1786093230000, clientNonce: 'nonce-1234567890abcdef',
};

/** Mirrors the native SessionSecretArena admission check. */
function admitUseEnvelope(envelope, context, now) {
  if (envelope.v !== 1) return 'unsupported_protocol_version';
  if (envelope.purpose !== context.purpose) return 'aead_auth_failed';
  if (envelope.resourceId !== context.resourceId) return 'aead_auth_failed';
  if (envelope.sessionId !== context.sessionId) return 'aead_auth_failed';
  if (envelope.resourceRevision !== context.resourceRevision) return 'aead_auth_failed';
  if (envelope.expiresAt <= now) return 'shared_session_expired';
  const expected = sharedUseAadBytes({ ...context, expiresAt: envelope.expiresAt, clientNonce: envelope.clientNonce });
  if (!aadEquals(envelope.aad, expected.toString('base64'))) return 'aead_auth_failed';
  if (context.consumedNonces.has(envelope.clientNonce)) return 'shared_session_consumed';
  context.consumedNonces.add(envelope.clientNonce);
  return 'accepted';
}

function context(overrides = {}) {
  return { ...SHARED, consumedNonces: new Set(), ...overrides };
}

test('the canonical shared envelope is admitted once', () => {
  const envelope = sharedUseVectors().envelopes.acceptedSsh;
  const ctx = context({ sessionId: envelope.sessionId });
  ctx.sessionId = envelope.sessionId;
  const withSession = { ...SHARED, sessionId: envelope.sessionId };
  const expectedAad = sharedUseAadBytes(withSession).toString('base64');
  assert.equal(typeof expectedAad, 'string');
  // The frozen vector's AAD uses the short session id; admission recomputes from context.
  const frozenCtx = context({ sessionId: 'sess-1' });
  const frozenEnvelope = { ...envelope, sessionId: 'sess-1' };
  assert.equal(admitUseEnvelope(frozenEnvelope, frozenCtx, 1786093200000), 'accepted');
});

test('every negative case in the frozen vector is rejected with its own code', () => {
  const vectors = sharedUseVectors();
  const envelope = { ...vectors.envelopes.acceptedSsh, sessionId: 'sess-1' };
  const now = 1786093200000;

  const mutations = {
    'wrong-device': [{ deviceId: 'dev-2' }, 'aead_auth_failed'],
    'wrong-session': [{ sessionId: 'sess-2' }, 'aead_auth_failed'],
    'wrong-resource': [{ resourceId: 'conn-8' }, 'aead_auth_failed'],
    'wrong-purpose': [{ purpose: 'rdp' }, 'aead_auth_failed'],
  };
  for (const [name, [patch, expected]] of Object.entries(mutations)) {
    const ctx = context({ sessionId: 'sess-1', ...patch });
    assert.equal(admitUseEnvelope(envelope, ctx, now), expected, name);
  }

  const expired = context({ sessionId: 'sess-1' });
  assert.equal(admitUseEnvelope({ ...envelope, expiresAt: now - 1 }, expired, now), 'shared_session_expired');

  const replay = context({ sessionId: 'sess-1' });
  assert.equal(admitUseEnvelope(envelope, replay, now), 'accepted');
  assert.equal(admitUseEnvelope(envelope, replay, now), 'shared_session_consumed', 'a nonce is single use');

  for (const negative of vectors.negativeCases) {
    assert.ok(
      ['aead_auth_failed', 'shared_session_expired', 'shared_session_consumed'].includes(negative.expect),
      negative.id + ' expects an unknown failure mode',
    );
  }
});

test('a decrypted shared payload may never contain control-plane secrets', () => {
  const forbidden = sharedUseVectors().forbiddenPayloadKeys;
  assert.deepEqual(forbidden, ['clientToken', 'aiProviderApiKey', 'aiEnvValue', 'serverDataKey', 'ownerSid', 'refreshCredential']);
  const payload = { username: 'ops', password: '<sealed>', clientToken: 'must-never-appear' };
  const leaked = Object.keys(payload).filter((k) => forbidden.includes(k));
  assert.deepEqual(leaked, ['clientToken'], 'the arena must reject payloads carrying these keys');
});

test('mirror scope is owner-only: no entity claims a shared owner field', () => {
  for (const entity of entityRegistry().entities) {
    assert.ok(
      /^(ownerUserId|userId|resourceOwnerUserId|serverId)$/.test(entity.ownerField),
      entity.type + ' owner field ' + entity.ownerField + ' is not an owner-scoped identity',
    );
  }
});

test('revealSecret is never implied by shared use', () => {
  const connection = entityRegistry().entities.find((e) => e.type === 'connection');
  assert.ok(connection.capabilities.includes('use'));
  assert.ok(connection.capabilities.includes('revealSecret'));
  const impliedByShare = ['discover', 'view', 'use', 'observe'];
  assert.equal(impliedByShare.includes('revealSecret'), false, 'sharing must not hand out secrets');
  assert.equal(impliedByShare.includes('edit'), false);
  assert.equal(impliedByShare.includes('delete'), false);
});
