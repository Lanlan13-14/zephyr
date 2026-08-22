import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SharedResourceApi,
  SharedSessionRegistry,
  RELAY_NAMESPACE,
} = require('../mobile-v1-shared.js');

function makeHarness({ capabilities } = {}) {
  let caps = new Set(capabilities || ['discover', 'view', 'use', 'control', 'execute']);
  let userStatus = 'active';
  let ownerStatus = 'active';
  let tokenIds = new Set(['tok-1']);
  const connection = {
    id: 'conn-1',
    ownerUserId: 'owner-1',
    name: 'Owner SSH',
    host: 'host.invalid',
    port: 22,
    protocol: 'SSH',
    username: 'ops',
    password: 'owner-plaintext-secret',
    revision: 7,
  };
  const device = {
    device_id: 'device-borrower-1',
    owner_user_id: 'borrower-1',
    refresh_generation: 4,
    token_id: 'tok-1',
    enabled: 1,
    revoked_at: null,
    encryption_public_key: Buffer.alloc(1184),
  };
  const borrower = { userId: 'borrower-1', username: 'borrower', role: 'user', status: 'active' };

  const encode = (namespace, payload) => Buffer.from(JSON.stringify({ namespace, payload }), 'utf8').toString('base64url');
  const decode = (namespace, credential) => {
    let opened;
    try { opened = JSON.parse(Buffer.from(String(credential), 'base64url').toString('utf8')); } catch {}
    if (!opened || opened.namespace !== namespace) {
      const err = new Error('invalid credential');
      err.code = 'shared_session_expired';
      err.status = 410;
      throw err;
    }
    return opened.payload;
  };

  const authz = {
    effectiveCapabilities() { return new Set(caps); },
    audit() {},
    revoke() { return true; },
    grant() { return [...caps]; },
    revokeAllForResource() { return 1; },
  };
  const store = {
    signBlob: encode,
    openBlob: decode,
    getDeviceRow() { return device; },
    serverId() { return 'server-1'; },
    revokeDevice(_ownerUserId, deviceId) {
      if (deviceId !== device.device_id) return false;
      device.revoked_at = Date.now();
      device.enabled = 0;
      device.refresh_generation += 1;
      return true;
    },
    rotateRefresh(deviceId) {
      if (deviceId !== device.device_id) return null;
      device.refresh_generation += 1;
      return { row: device };
    },
    bindDevice(input) {
      device.refresh_generation += 1;
      return { row: device, input };
    },
    patchDevice(_ownerUserId, _deviceId, patch) {
      if (patch.enabled === false) device.enabled = 0;
      return device;
    },
  };
  const storage = {
    getConnectionById(id) { return id === connection.id ? connection : null; },
    getUserBrief(id) {
      if (id === borrower.userId) return { ...borrower, status: userStatus };
      if (id === connection.ownerUserId) {
        return { userId: connection.ownerUserId, username: 'owner', role: 'user', status: ownerStatus };
      }
      return null;
    },
    getUserById(id) { return id === connection.ownerUserId ? { username: 'owner' } : null; },
    updateUserById(id, patch) {
      if (id === borrower.userId) {
        if (patch.status) userStatus = patch.status;
        return { ...borrower, status: userStatus };
      }
      if (id === connection.ownerUserId) {
        if (patch.status) ownerStatus = patch.status;
        return { userId: id, username: 'owner', status: ownerStatus };
      }
      return null;
    },
  };
  const fileAgentManager = {
    listTokens(ownerName) {
      return ownerName === borrower.username ? [...tokenIds].map((id) => ({ id })) : [];
    },
    deleteToken(_ownerName, tokenId) { tokenIds.delete(tokenId); return true; },
    regenerateTokenRecord(_ownerName, tokenId) { tokenIds.delete(tokenId); return { id: tokenId }; },
    regenerateToken(ownerName) { tokenIds.clear(); return ownerName; },
    createToken(_ownerName) { tokenIds.add('tok-new'); return { id: 'tok-new' }; },
  };
  const resourceService = {
    resolveForConnect() { return { ...connection }; },
    _resolveDependencySecrets() { return { ...connection }; },
  };
  const sharingService = {
    setRevocationHook(hook) { this.hook = hook; },
  };
  const api = new SharedResourceApi({
    storage,
    authz,
    resourceService,
    notesService: null,
    sharingService,
    fileAgentManager,
    store,
    serverEncryptionKey: () => Buffer.alloc(32, 1),
    relayMount: '/api/mobile/v1/shared/relay',
  });

  const open = () => api.openConnectionSession(borrower, device, connection.id, {
    clientSessionNonce: 'nonce-long-enough-for-shared-session',
    requestedChannels: ['terminal'],
    deviceKeyVersion: 1,
  });

  return {
    api, authz, store, storage, fileAgentManager, connection, device, borrower, open,
    setCaps(next) { caps = new Set(next); },
    setTokenIds(next) { tokenIds = new Set(next); },
    setUserStatus(next) { userStatus = next; },
    setOwnerStatus(next) { ownerStatus = next; },
    decodeCredential(credential) { return decode(RELAY_NAMESPACE, credential); },
    signClaim(claim) { return encode(RELAY_NAMESPACE, claim); },
  };
}

test('shared sessions stay relay-strict even when revealSecret is granted', () => {
  const control = makeHarness({ capabilities: ['view', 'use', 'control', 'execute'] });
  const denied = control.open();
  assert.equal(denied.mode, 'relay-strict');
  assert.equal(denied.useEnvelope, undefined);
  assert.ok(!JSON.stringify(denied).includes('owner-plaintext-secret'));

  const reveal = makeHarness({
    capabilities: ['view', 'use', 'control', 'execute', 'revealSecret'],
  });
  const opened = reveal.open();
  assert.equal(opened.mode, 'relay-strict');
  assert.equal(opened.useEnvelope, undefined);
  assert.ok(opened.relay);
  assert.ok(!JSON.stringify(opened).includes('owner-plaintext-secret'));
});

test('relay descriptor keeps credentials out of URLs and uses a one-time jti', () => {
  const h = makeHarness();
  const opened = h.open();
  assert.ok(opened.relay.credential);
  assert.ok(!opened.relay.websocketUrl.includes('credential'));
  assert.ok(!JSON.stringify(h.api.sessions.get(opened.sessionId)).includes('owner-plaintext-secret'));
  assert.ok(!JSON.stringify(h.decodeCredential(opened.relay.credential)).includes('owner-plaintext-secret'));

  const attached = h.api.authorizeRelay({ sessionId: opened.sessionId, credential: opened.relay.credential });
  assert.ok(attached.attachId);
  h.api.releaseRelayAttach(opened.sessionId, attached.attachId);
  assert.throws(
    () => h.api.authorizeRelay({ sessionId: opened.sessionId, credential: opened.relay.credential }),
    (err) => err.code === 'shared_session_consumed',
  );
});

test('refresh invalidates the old attach credential and cross-account claims fail', () => {
  const h = makeHarness();
  const first = h.open();
  const refreshed = h.api.refreshSession(
    h.borrower,
    h.device,
    first.sessionId,
    'fresh-nonce-long-enough-for-refresh',
  );
  assert.throws(
    () => h.api.authorizeRelay({ sessionId: first.sessionId, credential: first.relay.credential }),
    (err) => err.code === 'shared_session_consumed',
  );

  const claim = h.decodeCredential(refreshed.relay.credential);
  const crossed = h.signClaim({ ...claim, userId: 'other-account' });
  assert.throws(
    () => h.api.authorizeRelay({ sessionId: first.sessionId, credential: crossed }),
    (err) => err.code === 'shared_session_expired',
  );

  const proper = h.api.authorizeRelay({ sessionId: first.sessionId, credential: refreshed.relay.credential });
  h.api.releaseRelayAttach(first.sessionId, proper.attachId);
});

test('relay attach consume and per-session concurrency limit are atomic', () => {
  const registry = new SharedSessionRegistry();
  const sessionId = registry.create({ sessionExpiresAt: Date.now() + 60_000 });
  const minted = registry.mintRelayClaim(sessionId);
  const first = registry.reserveRelayAttach(sessionId, minted.jti, minted.attachGeneration, 1);
  assert.equal(first.ok, true);

  const capped = registry.reserveRelayAttach(sessionId, 'second-jti', minted.attachGeneration, 1);
  assert.equal(capped.ok, false);
  assert.equal(capped.code, 'shared_session_consumed');

  registry.releaseRelayAttach(sessionId, first.attachId);
  assert.equal(registry.reserveRelayAttach(sessionId, 'second-jti', minted.attachGeneration, 1).ok, true);
  assert.equal(registry.reserveRelayAttach(sessionId, minted.jti, minted.attachGeneration, 1).ok, false);
});

test('a refreshed attach credential cannot exceed the live session socket limit', () => {
  const h = makeHarness();
  const opened = h.open();
  const first = h.api.authorizeRelay({ sessionId: opened.sessionId, credential: opened.relay.credential });
  const refreshed = h.api.refreshSession(
    h.borrower,
    h.device,
    opened.sessionId,
    'another-fresh-nonce-for-concurrency',
  );
  assert.throws(
    () => h.api.authorizeRelay({ sessionId: opened.sessionId, credential: refreshed.relay.credential }),
    (err) => err.code === 'shared_session_consumed',
  );
  h.api.releaseRelayAttach(opened.sessionId, first.attachId);
  const second = h.api.authorizeRelay({ sessionId: opened.sessionId, credential: refreshed.relay.credential });
  h.api.releaseRelayAttach(opened.sessionId, second.attachId);
});

test('device, token, ACL and account mutations immediately drop live relay sessions', () => {
  const cases = [
    {
      name: 'device',
      mutate(h) { h.store.revokeDevice(h.borrower.userId, h.device.device_id); },
    },
    {
      name: 'token',
      mutate(h) { h.fileAgentManager.deleteToken(h.borrower.username, h.device.token_id); },
    },
    {
      name: 'ACL',
      mutate(h) {
        h.authz.revoke({ resourceType: 'connection', resourceId: h.connection.id, subjectId: h.borrower.userId });
      },
    },
    {
      name: 'dependency ACL',
      prepare(h) { h.connection.sshKeyId = 'key-1'; },
      mutate(h) {
        h.authz.revoke({ resourceType: 'sshKey', resourceId: 'key-1', subjectId: h.borrower.userId });
      },
    },
    {
      name: 'account',
      mutate(h) { h.storage.updateUserById(h.borrower.userId, { status: 'suspended' }); },
    },
    {
      name: 'owner account',
      mutate(h) { h.storage.updateUserById(h.connection.ownerUserId, { status: 'suspended' }); },
    },
  ];

  for (const entry of cases) {
    const h = makeHarness();
    entry.prepare?.(h);
    const opened = h.open();
    const notices = [];
    h.api.subscribeSessionRevocation(opened.sessionId, (event) => notices.push(event));
    entry.mutate(h);
    assert.equal(h.api.sessions.get(opened.sessionId), null, entry.name + ' revoke left the session alive');
    assert.equal(notices.length, 1, entry.name + ' revoke did not notify the live relay');
  }
});

test('watchdog validation rechecks generation, backing token and ACL without a hook', () => {
  const generation = makeHarness();
  const generationSession = generation.open();
  generation.device.refresh_generation += 1;
  assert.equal(generation.api.validateRelaySession(generationSession.sessionId, '').ok, false);

  const token = makeHarness();
  const tokenSession = token.open();
  token.setTokenIds([]);
  assert.equal(token.api.validateRelaySession(tokenSession.sessionId, '').ok, false);

  const acl = makeHarness();
  const aclSession = acl.open();
  acl.setCaps(['view']);
  assert.equal(acl.api.validateRelaySession(aclSession.sessionId, '').ok, false);
});
