'use strict';

/**
 * Independent vault-password wrapping for WebDAV disaster recovery.
 *
 * Spec §6.1: restore from vault URL + user password without WEBDAV_BACKUP_KEY.
 * The outer envelope reuses the ZEPHYR4 layout (scrypt + AES-256-GCM) from
 * backup-encryption.js. 32-byte operator secrets go through encryptBackup;
 * user passphrases (≥32 UTF-8 bytes, same strength as legacy backup passwords)
 * use the same header/KDF with the passphrase as the scrypt secret.
 */

const crypto = require('crypto');
const {
    AUTH_TAG_BYTES,
    CURRENT_MAGIC,
    BackupEncryptionError,
    SCRYPT_PARAMS,
    decryptBackup,
    encryptBackup,
    parseCurrentEnvelope,
    requireLegacyBackupPassword,
    requireStrongBackupSecret,
} = require('./backup-encryption');

const LEGACY_SERVER_KEY_MAGIC = Buffer.from('ZWUBK001', 'ascii');
const HEADER_LENGTH_BYTES = 4;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

const PUBLIC_MESSAGES = Object.freeze({
    webdav_vault_password_invalid: 'The vault password is incorrect or the archive is corrupted.',
    webdav_vault_password_required: 'A strong vault password is required.',
    webdav_vault_format_invalid: 'The vault archive format is invalid.',
});

class WebDavVaultPasswordError extends Error {
    constructor(code, status = 400) {
        super(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.webdav_vault_password_invalid);
        this.name = 'WebDavVaultPasswordError';
        this.code = PUBLIC_MESSAGES[code] ? code : 'webdav_vault_password_invalid';
        this.status = status;
        this.retryable = false;
    }
}

function vaultError(code, status) {
    return new WebDavVaultPasswordError(code, status);
}

function asBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof Uint8Array) return Buffer.from(input);
    throw vaultError('webdav_vault_format_invalid');
}

function classifySecret(input) {
    if (typeof input !== 'string') throw vaultError('webdav_vault_password_required');
    try {
        return { kind: 'operator', secret: requireStrongBackupSecret(input) };
    } catch (error) {
        if (!(error instanceof BackupEncryptionError)) throw error;
    }
    try {
        return { kind: 'passphrase', secret: requireLegacyBackupPassword(input) };
    } catch (error) {
        if (error instanceof BackupEncryptionError) throw vaultError('webdav_vault_password_required');
        throw error;
    }
}

function deriveScryptKey(secret, salt) {
    return crypto.scryptSync(secret, salt, SCRYPT_PARAMS.keyLength, {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        maxmem: SCRYPT_MAXMEM,
    });
}

function encodePassphraseHeader(salt, iv) {
    return Buffer.from(JSON.stringify({
        version: 4,
        kdf: {
            name: 'scrypt',
            N: SCRYPT_PARAMS.N,
            r: SCRYPT_PARAMS.r,
            p: SCRYPT_PARAMS.p,
            keyLength: SCRYPT_PARAMS.keyLength,
            salt: salt.toString('base64url'),
        },
        cipher: {
            name: 'AES-256-GCM',
            iv: iv.toString('base64url'),
            tagLength: AUTH_TAG_BYTES,
        },
    }), 'utf8');
}

function wrapWithPassphrase(zip, secret) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const headerBytes = encodePassphraseHeader(salt, iv);
    const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
    headerLength.writeUInt32BE(headerBytes.length, 0);
    const aad = Buffer.concat([CURRENT_MAGIC, headerLength, headerBytes]);
    const key = deriveScryptKey(secret, salt);
    try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(zip), cipher.final()]);
        return Buffer.concat([aad, cipher.getAuthTag(), ciphertext]);
    } finally {
        key.fill(0);
        salt.fill(0);
    }
}

function unwrapWithPassphrase(body, secret) {
    const envelope = parseCurrentEnvelope(body);
    const key = deriveScryptKey(secret, envelope.salt);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
        const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
        headerLength.writeUInt32BE(envelope.headerBytes.length, 0);
        decipher.setAAD(Buffer.concat([CURRENT_MAGIC, headerLength, envelope.headerBytes]));
        decipher.setAuthTag(envelope.tag);
        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
        throw vaultError('webdav_vault_password_invalid');
    } finally {
        key.fill(0);
        envelope.salt.fill(0);
    }
}

function isPasswordWrappedVault(input) {
    try {
        const body = asBuffer(input);
        return body.length >= CURRENT_MAGIC.length && body.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC);
    } catch {
        return false;
    }
}

function isLegacyServerKeyArchive(input) {
    try {
        const body = asBuffer(input);
        return body.length >= LEGACY_SERVER_KEY_MAGIC.length
            && body.subarray(0, LEGACY_SERVER_KEY_MAGIC.length).equals(LEGACY_SERVER_KEY_MAGIC);
    } catch {
        return false;
    }
}

function detectVaultEnvelope(input) {
    if (isPasswordWrappedVault(input)) return 'password-wrapped';
    if (isLegacyServerKeyArchive(input)) return 'legacy-server-key';
    return 'unknown';
}

function assertVaultPassword(input) {
    return classifySecret(input).secret;
}

function wrapVaultArchive(zipBuffer, vaultPassword) {
    const zip = asBuffer(zipBuffer);
    if (!zip.length) throw vaultError('webdav_vault_format_invalid');
    const classified = classifySecret(vaultPassword);
    if (classified.kind === 'operator') return encryptBackup(zip, classified.secret);
    return wrapWithPassphrase(zip, classified.secret);
}

function unwrapVaultArchive(outerBuffer, vaultPassword) {
    const body = asBuffer(outerBuffer);
    if (!isPasswordWrappedVault(body)) throw vaultError('webdav_vault_password_invalid');
    let classified;
    try {
        classified = classifySecret(vaultPassword);
    } catch (error) {
        if (error instanceof WebDavVaultPasswordError) throw vaultError('webdav_vault_password_invalid');
        throw error;
    }
    try {
        if (classified.kind === 'operator') return decryptBackup(body, classified.secret);
        return unwrapWithPassphrase(body, classified.secret);
    } catch (error) {
        if (error instanceof WebDavVaultPasswordError) throw error;
        throw vaultError('webdav_vault_password_invalid');
    }
}

module.exports = {
    LEGACY_SERVER_KEY_MAGIC,
    PUBLIC_MESSAGES,
    WebDavVaultPasswordError,
    detectVaultEnvelope,
    isLegacyServerKeyArchive,
    isPasswordWrappedVault,
    unwrapVaultArchive,
    wrapVaultArchive,
    assertVaultPassword,
};
