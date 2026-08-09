import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Device secret envelope: the server half of DATA_AND_MIGRATION.md 5.2.
 *
 * The client half (core-security/DeviceEnvelopeCrypto.kt) cannot be executed here, so the
 * binding between the two is asserted structurally instead: the AAD bytes are checked against
 * the frozen vectors both sides generate from, and the envelope field names / suite constants
 * are checked against the generated SecretEnvelopeContract the Kotlin side compiles against.
 * An envelope that passes these cannot be rejected by the client for a contract reason.
 */

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const mv1 = require_(path.join(repoRoot, 'mobile-v1-crypto.js'));

const vectors = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'contracts', 'generated', 'aad-vectors.json'), 'utf8'),
);

/* ML-KEM is a declared root dependency, but this test must not fail merely because a
 * checkout has no node_modules yet: the AAD assertions are pure and always run. */
let mlKem = null;
try { mlKem = require_('@noble/post-quantum/ml-kem.js').ml_kem768; } catch { mlKem = null; }

test('AAD bytes match every frozen vector', () => {
  assert.ok(vectors.cases.length > 0, 'generated vectors must exist');
  for (const item of vectors.cases) {
    const bytes = item.kind === 'secret'
      ? mv1.secretAadBytes(item.input)
      : mv1.sharedUseAadBytes(item.input);
    assert.equal(bytes.toString('hex'), item.expectedHex, item.name + ' hex');
    assert.equal(bytes.toString('base64'), item.expectedBase64, item.name + ' base64');
    assert.equal(bytes.length, item.expectedLength, item.name + ' length');
  }
});

test('AAD construction rejects every frozen negative vector', () => {
  /* These are the encodings that would let one field be shifted into its neighbour:
   * a leading-zero integer, an empty part. Accepting any of them would make two
   * different (entity, field, revision) triples produce identical AAD. */
  assert.ok(vectors.rejects.length > 0, 'negative vectors must exist');
  for (const item of vectors.rejects) {
    assert.throws(
      () => (item.kind === 'secret' ? mv1.secretAadBytes(item.input) : mv1.sharedUseAadBytes(item.input)),
      item.name + ' must be rejected',
    );
  }
});

test('envelope suite constants match the generated Kotlin contract', () => {
  /* The Kotlin side compiles against SecretEnvelopeContract; if the server drifts from it the
   * client rejects every envelope before decrypting, which looks like a crypto failure. */
  const kt = fs.readFileSync(
    path.join(
      here, '..', 'android', 'core-contracts', 'src', 'main', 'kotlin',
      'one', 'zephyr', 'mobile', 'contracts', 'SecretEnvelopeContract.kt',
    ),
    'utf8',
  );
  const ktConst = (name) => {
    const m = kt.match(new RegExp('const val ' + name + ': \\w+ = (.+)'));
    assert.ok(m, name + ' must exist in the generated contract');
    return m[1].trim().replace(/^["]|["]$/g, '');
  };
  assert.equal(String(mv1.ENVELOPE_VERSION), ktConst('VERSION'));
  assert.equal(mv1.ALG, ktConst('ALG'));
  assert.equal(mv1.KEM, ktConst('KEM'));
  assert.equal(mv1.AEAD, ktConst('AEAD'));
  assert.equal(String(mv1.IV_BYTES), ktConst('IV_BYTES'));
  assert.equal(String(mv1.TAG_BYTES), ktConst('TAG_BYTES'));
  assert.equal(String(mv1.DERIVED_KEY_BYTES), ktConst('DERIVED_KEY_BYTES'));
  assert.equal(mv1.HKDF_SALT_INPUT, ktConst('HKDF_SALT_INPUT'));
  assert.equal(mv1.SECRET_AAD_PREFIX, ktConst('SECRET_AAD_PREFIX'));
  assert.equal(mv1.SHARED_AAD_PREFIX, ktConst('SHARED_AAD_PREFIX'));
});

test('a sealed envelope round-trips and carries the wire shape the client parses', (t) => {
  if (!mlKem) return t.skip('@noble/post-quantum not installed');
  const pair = mlKem.keygen();
  const input = {
    serverId: 'srv-1', userId: 'usr-1', deviceId: 'dev-1',
    entityType: 'connection', entityId: 'conn-1', fieldName: 'password',
    entityRevision: 8, keyVersion: 1,
  };
  const aad = mv1.secretAadBytes(input);
  const plaintext = Buffer.from('correct horse battery staple', 'utf8');

  const envelope = mv1.sealEnvelope({
    plaintext, publicKey: pair.publicKey, aad, keyVersion: 1, entityRevision: 8,
  });

  // Exactly the required properties of MobileSecretEnvelopeV1, which is additionalProperties:false.
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ['aad', 'aead', 'alg', 'ct', 'data', 'entityRevision', 'iv', 'kem', 'keyVersion', 'tag', 'v'],
  );
  assert.equal(Buffer.from(envelope.ct, 'base64').length, mv1.MLKEM768_CIPHERTEXT_BYTES);
  assert.equal(Buffer.from(envelope.iv, 'base64').length, mv1.IV_BYTES);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, mv1.TAG_BYTES);
  assert.ok(Buffer.from(envelope.aad, 'base64').equals(aad), 'aad must be echoed verbatim');

  const opened = mv1.openEnvelope({ envelope, expectedAad: aad, privateKey: pair.secretKey });
  assert.equal(opened.toString('utf8'), plaintext.toString('utf8'));
});

test('an envelope bound to another device, field or revision cannot be opened', (t) => {
  if (!mlKem) return t.skip('@noble/post-quantum not installed');
  const pair = mlKem.keygen();
  const input = {
    serverId: 'srv-1', userId: 'usr-1', deviceId: 'dev-1',
    entityType: 'connection', entityId: 'conn-1', fieldName: 'password',
    entityRevision: 8, keyVersion: 1,
  };
  const aad = mv1.secretAadBytes(input);
  const envelope = mv1.sealEnvelope({
    plaintext: Buffer.from('secret', 'utf8'),
    publicKey: pair.publicKey, aad, keyVersion: 1, entityRevision: 8,
  });

  /* The AAD is the whole point of the design: the same ciphertext must be undecryptable
   * once any bound field changes, because the derived key is HKDF(info = AAD). */
  for (const [label, patch] of [
    ['another device', { deviceId: 'dev-2' }],
    ['another user', { userId: 'usr-2' }],
    ['another entity', { entityId: 'conn-2' }],
    ['another field', { fieldName: 'privateKey' }],
    ['another revision', { entityRevision: 9 }],
    ['another key version', { keyVersion: 2 }],
  ]) {
    const wrong = mv1.secretAadBytes({ ...input, ...patch });
    assert.throws(
      () => mv1.openEnvelope({ envelope, expectedAad: wrong, privateKey: pair.secretKey }),
      'envelope must not open under the AAD of ' + label,
    );
  }
});

test('tampering with any envelope field is detected', (t) => {
  if (!mlKem) return t.skip('@noble/post-quantum not installed');
  const pair = mlKem.keygen();
  const input = {
    serverId: 'srv-1', userId: 'usr-1', deviceId: 'dev-1',
    entityType: 'connection', entityId: 'conn-1', fieldName: 'password',
    entityRevision: 8, keyVersion: 1,
  };
  const aad = mv1.secretAadBytes(input);
  const envelope = mv1.sealEnvelope({
    plaintext: Buffer.from('secret', 'utf8'),
    publicKey: pair.publicKey, aad, keyVersion: 1, entityRevision: 8,
  });

  const bump = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] = (buf[0] + 1) % 256;
    return buf.toString('base64');
  };

  for (const [label, mutate] of [
    ['ciphertext body', (e) => { e.data = bump(e.data); }],
    ['auth tag', (e) => { e.tag = bump(e.tag); }],
    ['KEM ciphertext', (e) => { e.ct = bump(e.ct); }],
    ['iv', (e) => { e.iv = bump(e.iv); }],
    ['declared suite', (e) => { e.alg = 'AES-128-GCM'; }],
    ['declared version', (e) => { e.v = 2; }],
  ]) {
    const copy = JSON.parse(JSON.stringify(envelope));
    mutate(copy);
    assert.throws(
      () => mv1.openEnvelope({ envelope: copy, expectedAad: aad, privateKey: pair.secretKey }),
      'tampered ' + label + ' must be rejected',
    );
  }
});
