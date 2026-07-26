import test from 'node:test';
import assert from 'node:assert/strict';
import secretRefs from '../ai-secret-refs.js';

process.env.ENCRYPTION_KEY ||= 'secret-ref-unit-key';

const user = { userId: 'u1', username: 'alice' };

function serviceHarness() {
  const key = { id: 'key-1', name: 'prod-key', ownerUserId: 'u1', privateKey: 'PRIVATE', passphrase: 'PASS' };
  const proxy = { id: 'proxy-1', name: 'prod-proxy', ownerUserId: 'u1', password: 'PASSWORD', host: '10.0.0.8' };
  return {
    authz: { can() { return false; } },
    listOwned(_user, type) { return type === 'sshKey' ? [{ id: key.id, name: key.name }] : [{ id: proxy.id, name: proxy.name, host: proxy.host }]; },
    _rawResource(type, id) { if (type === 'sshKey' && id === key.id) return key; if (type === 'proxy' && id === proxy.id) return proxy; return null; },
  };
}

test('secretRef is opaque signed and user-bound', () => {
  const ref = secretRefs.issueSecretRef(user, 'ssh_key', 'key-1');
  assert.match(ref, /^sref_v1_/);
  assert.equal(ref.includes('PRIVATE'), false);
  assert.equal(ref.includes('key-1'), false);
  const parsed = secretRefs.parseSecretRef(ref, user, 'ssh_key');
  assert.equal(parsed.resourceId, 'key-1');
  assert.throws(() => secretRefs.parseSecretRef(ref, { userId: 'u2' }, 'ssh_key'), (error) => error.code === 'secret_ref_forbidden');
  assert.throws(() => secretRefs.parseSecretRef(ref.slice(0, -1) + 'x', user, 'ssh_key'), (error) => error.code === 'invalid_secret_ref');
});

test('secretRef discovery returns references but never secret values', () => {
  const refs = secretRefs.listSecretRefs(user, {}, serviceHarness());
  assert.equal(refs.length, 2);
  const serialized = JSON.stringify(refs);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('PASSWORD'), false);
  assert.ok(refs.every((item) => item.secretRef.startsWith('sref_v1_')));
});

test('secretRef resolves only a usable expected resource kind', () => {
  const service = serviceHarness();
  const ref = secretRefs.issueSecretRef(user, 'ssh_key', 'key-1');
  assert.equal(secretRefs.resolveResourceId(ref, user, 'ssh_key', service), 'key-1');
  assert.throws(() => secretRefs.resolveResourceId(ref, user, 'proxy', service), (error) => error.code === 'secret_ref_kind_mismatch');
});
