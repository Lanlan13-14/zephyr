// The FREEZE directory is the product spec archive; mobile/contracts is the working source of truth.
// These tests fail loudly if the two drift apart or if a field escapes classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MOBILE_ROOT, REPO_ROOT, CONTRACTS_ROOT, entityRegistry, errorRegistry, pushOrderedEntityTypes } from '../tools/lib/contracts.mjs';

const FREEZE_ROOT = path.join(REPO_ROOT, 'FREEZE', 'zephyr one for mobile');
const parity = JSON.parse(fs.readFileSync(path.join(CONTRACTS_ROOT, 'FREEZE_PARITY.json'), 'utf8'));

// Frozen delete modes. entity-registry.json is the source; this list only guards against new,
// unreviewed modes appearing without a sync rule.
const DELETE_MODES = [
  'append-only', 'job-retention', 'reset-to-default',
  'revocation-tombstone', 'revoke', 'soft-delete-then-tombstone', 'tombstone',
];

/**
 * Line endings are normalised before hashing.
 *
 * Not a convenience: hashing raw bytes made this gate depend on the contributor's git config.
 * With core.autocrlf=true a Windows checkout stores these JSON and SVG files with CRLF, so the
 * recorded hashes were CRLF hashes and every one of them failed on the ubuntu runner, where git
 * checks out the LF blob. The question this test means to ask is whether the mirrored contract
 * still has the same content as the frozen original, and a newline convention is not content.
 */
const normalise = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');

const sha256 = (buf) => crypto.createHash('sha256').update(normalise(buf)).digest('hex');

/** Size is compared on the same normalised bytes, or it contradicts the hash on Windows. */
const sizeOf = (buf) => normalise(buf).length;

test('every mirrored contract matches its FREEZE original byte for byte', () => {
  assert.ok(Array.isArray(parity.files), 'FREEZE_PARITY.json must list files as an array');
  assert.ok(parity.files.length >= 11, 'expected the full contract set to be mirrored');
  for (const meta of parity.files) {
    const mirrored = path.join(MOBILE_ROOT, meta.path);
    const original = path.join(REPO_ROOT, meta.freezePath);
    assert.ok(fs.existsSync(mirrored), meta.path + ' is missing from mobile/');
    assert.ok(fs.existsSync(original), meta.freezePath + ' is missing from FREEZE/');
    const mirroredBytes = fs.readFileSync(mirrored);
    assert.equal(sha256(mirroredBytes), meta.sha256, meta.path + ' drifted from its recorded hash');
    assert.equal(sizeOf(mirroredBytes), meta.bytes, meta.path + ' changed size');
    assert.equal(sha256(fs.readFileSync(original)), meta.sha256, meta.freezePath + ' changed; re-sync mobile/contracts');
  }
});

test('FREEZE parity covers every contract and branding source actually shipped', () => {
  const tracked = new Set(parity.files.map((f) => f.path.split(path.sep).join('/')));
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(path.join(MOBILE_ROOT, dir), { withFileTypes: true })) {
      const rel = prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith('.json') || entry.name.endsWith('.svg')) {
        if (rel.includes('/generated/') || rel.endsWith('FREEZE_PARITY.json') || rel.endsWith('GENERATED_MANIFEST.json')) continue;
        assert.ok(tracked.has(rel), rel + ' is not covered by FREEZE_PARITY.json');
      }
    }
  };
  walk('contracts', 'contracts');
  walk('branding', 'branding');
});
test('entity registry classifies every field it names', () => {
  const registry = entityRegistry();
  assert.deepEqual([...registry.classification].sort(), ['deviceLocal', 'editableSync', 'opaquePreserve', 'serverOnly']);

  for (const entity of registry.entities) {
    const all = [
      entity.editableFields ?? [],
      entity.secretFields ?? [],
      entity.serverAuthorityFields ?? [],
      entity.opaquePreserveFields ?? [],
      entity.deviceLocalFields ?? [],
    ].flat();
    assert.equal(new Set(all).size, all.length, entity.type + ' lists a field in two classifications');
    assert.ok(entity.idField, entity.type + ' has no idField');
    assert.ok(entity.ownerField, entity.type + ' has no ownerField');
    assert.ok(
      DELETE_MODES.includes(entity.deleteMode),
      entity.type + ' has an unfrozen deleteMode: ' + entity.deleteMode,
    );
  }
});

test('excluded scopes never appear as an editable entity type', () => {
  const registry = entityRegistry();
  const types = new Set(registry.entities.map((e) => e.type));
  for (const scope of registry.excludedEditableScopes) {
    assert.equal(types.has(scope), false, scope + ' must not be a One-editable entity');
  }
  for (const scope of ['accountSecurity', 'smtp', 'captcha', 'ipPolicy', 'beian', 'customCssJs', 'multiUserAdmin']) {
    assert.ok(registry.excludedEditableScopes.includes(scope), scope + ' must stay excluded');
  }
});

test('push order puts dependencies before the entities that reference them', () => {
  const order = pushOrderedEntityTypes();
  const at = (type) => order.indexOf(type);
  assert.ok(at('sshKey') < at('jumpHost'), 'ssh keys must push before jump hosts');
  assert.ok(at('proxy') < at('jumpHost'), 'proxies must push before jump hosts');
  assert.ok(at('jumpHost') < at('connection'), 'jump hosts must push before connections');
  assert.ok(at('connection') < at('note'), 'connections must push before note links');
  assert.ok(at('clientToken') <= at('connection'), 'client tokens carry no dependencies');
});

test('error registry codes are unique, mapped and actionable', () => {
  const seen = new Set();
  for (const spec of errorRegistry().errors) {
    assert.equal(seen.has(spec.code), false, 'duplicate error code ' + spec.code);
    seen.add(spec.code);
    assert.match(spec.code, /^[a-z][A-Za-z0-9_]*$/, spec.code + ' is not a stable machine code');
    assert.ok(spec.httpStatus >= 200 && spec.httpStatus < 600, spec.code + ' has an impossible status');
    assert.equal(typeof spec.retryable, 'boolean', spec.code + ' has no retryable flag');
    assert.ok(spec.clientAction && spec.clientAction.length > 0, spec.code + ' has no client action');
  }
  for (const required of [
    'cursor_expired', 'bootstrap_expired', 'dependency_missing', 'sync_conflict', 'duplicate_operation',
    'device_proof_invalid', 'client_revoked', 'token_rotated', 'sensitive_verification_required',
    'shared_residency_violation', 'shared_session_consumed', 'shared_session_expired',
    'shared_direct_forbidden', 'shared_relay_unavailable', 'blob_hash_mismatch', 'unsupported_protocol_version',
  ]) {
    assert.ok(seen.has(required), 'error registry is missing ' + required);
  }
});

test('gone resources are never marked retryable', () => {
  for (const spec of errorRegistry().errors) {
    if (spec.httpStatus === 410) {
      assert.equal(spec.retryable, false, spec.code + ' is gone; retrying cannot help');
    }
  }
});
