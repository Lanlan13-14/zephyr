import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

delete process.env.WEBDAV_BACKUP_KEY;

const {
  generateBackupSecret,
  requireStrongBackupSecret,
} = require('../backup-encryption.js');
const {
  WebDavVaultPasswordError,
  detectVaultEnvelope,
  isPasswordWrappedVault,
  unwrapVaultArchive,
  wrapVaultArchive,
} = require('../webdav-vault-password.js');

const LEGACY_SERVER_KEY_MAGIC = Buffer.from('ZWUBK001', 'ascii');

function strongVaultPassword() {
  const secret = generateBackupSecret();
  requireStrongBackupSecret(secret);
  return secret;
}

function zipBytes() {
  return crypto.randomBytes(128);
}

function assertVaultPasswordInvalid(fn) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'expected unwrap to fail closed');
  assert.equal(thrown.code, 'webdav_vault_password_invalid');
  assert.equal(thrown.name, 'WebDavVaultPasswordError');
  assert.equal(thrown instanceof WebDavVaultPasswordError, true);
  assert.equal(thrown.message, 'The vault password is incorrect or the archive is corrupted.');
  assert.equal(/authenticate|openssl|decipher|bad decrypt|tamper|wrong password/i.test(thrown.message), false);
  return thrown;
}

test('strong vault password wrap/unwrap roundtrips zip bytes without WEBDAV_BACKUP_KEY', () => {
  assert.equal(process.env.WEBDAV_BACKUP_KEY, undefined);
  const zip = zipBytes();
  assert.ok(zip.length > 100);
  const password = strongVaultPassword();
  const outer = wrapVaultArchive(zip, password);
  assert.equal(Buffer.isBuffer(outer), true);
  const opened = unwrapVaultArchive(outer, password);
  assert.equal(Buffer.isBuffer(opened), true);
  assert.equal(opened.equals(zip), true);
});

test('wrong vault password fails with webdav_vault_password_invalid and does not return zip', () => {
  const zip = zipBytes();
  const outer = wrapVaultArchive(zip, strongVaultPassword());
  let opened;
  assertVaultPasswordInvalid(() => {
    opened = unwrapVaultArchive(outer, strongVaultPassword());
  });
  assert.equal(opened, undefined);
});

test('flipping the last ciphertext byte fails with webdav_vault_password_invalid', () => {
  const password = strongVaultPassword();
  const outer = wrapVaultArchive(zipBytes(), password);
  const tampered = Buffer.from(outer);
  tampered[tampered.length - 1] ^= 0x01;
  assertVaultPasswordInvalid(() => unwrapVaultArchive(tampered, password));
});

test('detectVaultEnvelope classifies password-wrapped archives', () => {
  const outer = wrapVaultArchive(zipBytes(), strongVaultPassword());
  assert.equal(detectVaultEnvelope(outer), 'password-wrapped');
  assert.equal(isPasswordWrappedVault(outer), true);
});

test('detectVaultEnvelope classifies random bytes as unknown', () => {
  const random = crypto.randomBytes(256);
  assert.equal(detectVaultEnvelope(random), 'unknown');
  assert.equal(isPasswordWrappedVault(random), false);
});

test('detectVaultEnvelope classifies webdav-backup-provider inner magic as legacy-server-key', () => {
  const legacy = Buffer.concat([LEGACY_SERVER_KEY_MAGIC, crypto.randomBytes(48)]);
  assert.equal(detectVaultEnvelope(legacy), 'legacy-server-key');
  assert.equal(isPasswordWrappedVault(legacy), false);
});

test('weak vault passwords are rejected by wrap', () => {
  const zip = zipBytes();
  assert.throws(() => wrapVaultArchive(zip, 'password'), { code: 'webdav_vault_password_required' });
});

test('wrapVaultArchive result isPasswordWrappedVault', () => {
  const outer = wrapVaultArchive(zipBytes(), strongVaultPassword());
  assert.equal(isPasswordWrappedVault(outer), true);
});
