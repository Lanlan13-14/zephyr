'use strict';

const crypto = require('crypto');
const {
    PORTABLE_WORKSPACE_IDENTITY_COLLECTION,
    normalizePortableWorkspaceIdentityCollection,
} = require('./webdav-snapshot-policy');

const BACKUP_FORMAT = 'zephyr-webdav-user-backup';
const BACKUP_VERSION = 1;
const MANIFEST_FORMAT = 'zephyr-user-backup-manifest';
const MANIFEST_VERSION = 1;
const PAYLOAD_FORMAT = 'zephyr-user-data';
const PAYLOAD_VERSION = 1;
const BACKUP_CONTENT_TYPE = 'application/x-zephyr-webdav-backup';
const MAGIC = Buffer.from('ZWUBK001', 'ascii');
const HEADER_LENGTH_BYTES = 4;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4096;
const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BACKUP_BYTES = 40 * 1024 * 1024;
const MAX_COLLECTIONS = 128;
const MAX_RECORDS = 100_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 1_000_000;

const FORBIDDEN_COLLECTIONS = new Set([
    'auditevents',
    'authsessions',
    'ipbans',
    'loginevents',
    'meta',
    'passkeys',
    'passwordresetcodes',
    'passwordrollbacktokens',
    'users',
    'webdavsyncconfigs',
]);
const FORBIDDEN_FIELDS = new Set([
    'backupkey',
    'codehash',
    'credentialenc',
    'datakey',
    'dataencryptionkey',
    'encryptionkey',
    'keyencryptionkey',
    'masterkey',
    'mlkemprivatekey',
    'oldpasswordhash',
    'passwordhash',
    'secretcryptokey',
    'secretcryptoprivatekey',
    'tokenhash',
    'totpsecret',
    'webdavbackupkey',
    'webdavpassword',
    'webdavusername',
]);
const OWNERSHIP_FIELDS = new Set([
    'ownerId',
    'ownerUserId',
    'owner_id',
    'owner_user_id',
    'userId',
    'user_id',
]);

const PUBLIC_MESSAGES = Object.freeze({
    webdav_backup_key_invalid: 'WebDAV backup encryption is not configured safely.',
    webdav_backup_config_invalid: 'The WebDAV backup configuration is invalid.',
    webdav_backup_scope_invalid: 'The WebDAV backup data is outside the requested user scope.',
    webdav_backup_too_large: 'The WebDAV backup exceeded the configured size limit.',
    webdav_backup_aborted: 'The WebDAV backup was cancelled.',
    webdav_backup_failed: 'The WebDAV backup failed.',
    webdav_backup_format_invalid: 'The WebDAV backup format is invalid.',
    webdav_backup_verification_failed: 'The WebDAV backup could not be verified.',
    webdav_backup_instance_mismatch: 'The WebDAV backup belongs to a different instance.',
    webdav_backup_user_mismatch: 'The WebDAV backup belongs to a different user.',
});

class WebDavBackupProviderError extends Error {
    constructor(code) {
        super(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.webdav_backup_failed);
        this.name = 'WebDavBackupProviderError';
        this.code = PUBLIC_MESSAGES[code] ? code : 'webdav_backup_failed';
    }
}

function providerError(code) {
    return new WebDavBackupProviderError(code);
}

function publicBackupError(error) {
    const code = error instanceof WebDavBackupProviderError && PUBLIC_MESSAGES[error.code]
        ? error.code
        : 'webdav_backup_failed';
    return { code, message: PUBLIC_MESSAGES[code] };
}

function normalizedLimit(value, fallback) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1024 || number > 1024 * 1024 * 1024) {
        if (value === undefined) return fallback;
        throw providerError('webdav_backup_config_invalid');
    }
    return number;
}

function validateInstanceId(value, errorCode = 'webdav_backup_config_invalid') {
    const instanceId = String(value || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instanceId)) throw providerError(errorCode);
    return instanceId;
}

function validateUserId(value, errorCode = 'webdav_backup_scope_invalid') {
    const userId = typeof value === 'string' ? value : '';
    if (!userId || userId.length > 512 || /[\0-\x1f\x7f]/.test(userId)) throw providerError(errorCode);
    return userId;
}

function normalizedName(value) {
    return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function isUserIdentityField(key) {
    const name = normalizedName(key);
    return name === 'ownerid' || name === 'userid' || name.endsWith('userid');
}

function hasShortPeriod(buffer) {
    for (let period = 1; period <= 8; period += 1) {
        let repeated = true;
        for (let index = period; index < buffer.length; index += 1) {
            if (buffer[index] !== buffer[index % period]) {
                repeated = false;
                break;
            }
        }
        if (repeated) return true;
    }
    return false;
}

function estimatedByteEntropy(buffer) {
    const counts = new Map();
    for (const byte of buffer) counts.set(byte, (counts.get(byte) || 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const probability = count / buffer.length;
        entropy -= probability * Math.log2(probability);
    }
    return entropy;
}

/** Decode a dedicated, high-entropy 256-bit WebDAV backup key. */
function decodeBackupKey(input) {
    let key;
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        key = Buffer.from(input);
    } else {
        if (typeof input !== 'string' || !input || input !== input.trim()) {
            throw providerError('webdav_backup_key_invalid');
        }
        if (/^[0-9a-fA-F]{64}$/.test(input)) {
            key = Buffer.from(input, 'hex');
        } else if (/^[A-Za-z0-9_-]{43}=?$/.test(input)) {
            const unpadded = input.replace(/=$/, '');
            key = Buffer.from(unpadded, 'base64url');
            if (key.toString('base64url') !== unpadded) {
                key.fill(0);
                throw providerError('webdav_backup_key_invalid');
            }
        } else {
            throw providerError('webdav_backup_key_invalid');
        }
    }

    if (key.length !== 32
        || new Set(key).size < 16
        || estimatedByteEntropy(key) < 3.75
        || hasShortPeriod(key)) {
        key.fill(0);
        throw providerError('webdav_backup_key_invalid');
    }
    return key;
}

function keyIdFor(key) {
    return crypto.createHash('sha256').update('zephyr-webdav-backup-key\0').update(key)
        .digest('base64url').slice(0, 22);
}

function userSubject(instanceId, userId) {
    return crypto.createHash('sha256').update(instanceId).update('\0').update(userId).digest('base64url');
}

function timingSafeTextEqual(left, right) {
    const a = Buffer.from(String(left), 'utf8');
    const b = Buffer.from(String(right), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkOperation({ signal, deadlineAt } = {}) {
    if (signal?.aborted || (Number.isFinite(Number(deadlineAt)) && Date.now() >= Number(deadlineAt))) {
        throw providerError('webdav_backup_aborted');
    }
}

function exportedAtFrom(now) {
    let value = '';
    try { value = new Date(now()).toISOString(); } catch {}
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
        throw providerError('webdav_backup_config_invalid');
    }
    return value;
}

function backupBody(input) {
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    throw providerError('webdav_backup_format_invalid');
}

function aadFields(header) {
    return {
        format: header.format,
        version: header.version,
        instanceId: header.instanceId,
        subject: header.subject,
        exportedAt: header.exportedAt,
        keyId: header.keyId,
    };
}

function headerAad(header) {
    return Buffer.from(JSON.stringify(aadFields(header)), 'utf8');
}

function validateHeaderObject(header) {
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
        throw providerError('webdav_backup_format_invalid');
    }
    const keys = Object.keys(header).sort();
    const expectedKeys = ['cipher', 'exportedAt', 'format', 'instanceId', 'keyId', 'nonce', 'subject', 'version'];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw providerError('webdav_backup_format_invalid');
    }
    if (header.format !== BACKUP_FORMAT
        || header.version !== BACKUP_VERSION
        || header.cipher !== 'AES-256-GCM') {
        throw providerError('webdav_backup_format_invalid');
    }
    validateInstanceId(header.instanceId, 'webdav_backup_format_invalid');
    if (typeof header.subject !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(header.subject)) {
        throw providerError('webdav_backup_format_invalid');
    }
    if (typeof header.keyId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(header.keyId)) {
        throw providerError('webdav_backup_format_invalid');
    }
    let canonicalExportedAt = '';
    try { canonicalExportedAt = new Date(header.exportedAt).toISOString(); } catch {}
    if (typeof header.exportedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(header.exportedAt)
        || canonicalExportedAt !== header.exportedAt) {
        throw providerError('webdav_backup_format_invalid');
    }
    if (typeof header.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(header.nonce)) {
        throw providerError('webdav_backup_format_invalid');
    }
    const nonce = Buffer.from(header.nonce, 'base64url');
    if (nonce.length !== NONCE_BYTES || nonce.toString('base64url') !== header.nonce) {
        throw providerError('webdav_backup_format_invalid');
    }
    return nonce;
}

function parseHeader(input) {
    const body = backupBody(input);
    const prefixBytes = MAGIC.length + HEADER_LENGTH_BYTES;
    if (body.length < prefixBytes + 2 + AUTH_TAG_BYTES
        || !crypto.timingSafeEqual(body.subarray(0, MAGIC.length), MAGIC)) {
        throw providerError('webdav_backup_format_invalid');
    }
    const headerLength = body.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES
        || body.length < prefixBytes + headerLength + AUTH_TAG_BYTES + 1) {
        throw providerError('webdav_backup_format_invalid');
    }
    let header;
    try {
        header = JSON.parse(body.subarray(prefixBytes, prefixBytes + headerLength).toString('utf8'));
    } catch {
        throw providerError('webdav_backup_format_invalid');
    }
    const nonce = validateHeaderObject(header);
    const ciphertextOffset = prefixBytes + headerLength;
    return Object.freeze({
        ...header,
        nonceBytes: nonce,
        headerLength,
        ciphertextOffset,
        ciphertextLength: body.length - ciphertextOffset - AUTH_TAG_BYTES,
        authTagOffset: body.length - AUTH_TAG_BYTES,
        authTagLength: AUTH_TAG_BYTES,
        aad: headerAad(header),
    });
}

function keyInputForVerification(options, keyId) {
    if (typeof options.keyResolver === 'function') return options.keyResolver(keyId);
    if (options.backupKeys instanceof Map) return options.backupKeys.get(keyId);
    if (options.backupKeys && typeof options.backupKeys === 'object') return options.backupKeys[keyId];
    if (Object.prototype.hasOwnProperty.call(options, 'backupKey')) return options.backupKey;
    return process.env.WEBDAV_BACKUP_KEY;
}

/** Authenticate/decrypt an archive but deliberately do not restore it. */
function verifyBackup(input, options = {}) {
    if (!options || typeof options !== 'object') throw providerError('webdav_backup_config_invalid');
    const body = backupBody(input);
    const maxBackupBytes = normalizedLimit(options.maxBackupBytes, DEFAULT_MAX_BACKUP_BYTES);
    if (body.length > maxBackupBytes) throw providerError('webdav_backup_too_large');
    const parsed = parseHeader(body);
    const instanceId = validateInstanceId(options.instanceId);
    const userId = validateUserId(options.userId);
    if (!timingSafeTextEqual(parsed.instanceId, instanceId)) {
        throw providerError('webdav_backup_instance_mismatch');
    }
    if (!timingSafeTextEqual(parsed.subject, userSubject(instanceId, userId))) {
        throw providerError('webdav_backup_user_mismatch');
    }

    let key;
    try {
        key = decodeBackupKey(keyInputForVerification(options, parsed.keyId));
        if (!timingSafeTextEqual(keyIdFor(key), parsed.keyId)) {
            throw providerError('webdav_backup_verification_failed');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.nonceBytes);
        decipher.setAAD(parsed.aad);
        decipher.setAuthTag(body.subarray(parsed.authTagOffset));
        const archive = Buffer.concat([
            decipher.update(body.subarray(parsed.ciphertextOffset, parsed.authTagOffset)),
            decipher.final(),
        ]);
        return { header: aadFields(parsed), archive };
    } catch (error) {
        if (error instanceof WebDavBackupProviderError
            && error.code !== 'webdav_backup_key_invalid') throw error;
        throw providerError('webdav_backup_verification_failed');
    } finally {
        key?.fill(0);
    }
}

function validateRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw providerError('webdav_backup_scope_invalid');
    return value;
}

function validateJsonValue(value, userId, state, depth = 0) {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
        throw providerError('webdav_backup_too_large');
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw providerError('webdav_backup_scope_invalid');
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => validateJsonValue(item, userId, state, depth + 1));
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw providerError('webdav_backup_scope_invalid');
    }

    const output = {};
    for (const key of Object.keys(value).sort()) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype'
            || FORBIDDEN_FIELDS.has(normalizedName(key))
            || normalizedName(key).startsWith('webdav')) {
            throw providerError('webdav_backup_scope_invalid');
        }
        if (isUserIdentityField(key) && value[key] !== userId) {
            throw providerError('webdav_backup_scope_invalid');
        }
        output[key] = validateJsonValue(value[key], userId, state, depth + 1);
    }
    return output;
}

function normalizeUserSnapshot(snapshot, expectedUserId, exportedAt, maxSnapshotBytes) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || Object.getPrototypeOf(snapshot) !== Object.prototype) {
        throw providerError('webdav_backup_scope_invalid');
    }
    const rootKeys = Object.keys(snapshot).sort();
    const expectedKeys = ['collections', 'revision', 'userId'];
    if (rootKeys.length !== expectedKeys.length || rootKeys.some((key, index) => key !== expectedKeys[index])) {
        throw providerError('webdav_backup_scope_invalid');
    }
    if (snapshot.userId !== expectedUserId) throw providerError('webdav_backup_scope_invalid');
    const revision = validateRevision(snapshot.revision);
    if (!snapshot.collections || typeof snapshot.collections !== 'object'
        || Array.isArray(snapshot.collections)
        || Object.getPrototypeOf(snapshot.collections) !== Object.prototype) {
        throw providerError('webdav_backup_scope_invalid');
    }
    const collectionNames = Object.keys(snapshot.collections).sort();
    if (collectionNames.length > MAX_COLLECTIONS) throw providerError('webdav_backup_too_large');

    const state = { nodes: 0, records: 0 };
    const collections = {};
    for (const name of collectionNames) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
            || FORBIDDEN_COLLECTIONS.has(normalizedName(name))
            || normalizedName(name).startsWith('webdav')) {
            throw providerError('webdav_backup_scope_invalid');
        }
        const records = snapshot.collections[name];
        if (!Array.isArray(records)) throw providerError('webdav_backup_scope_invalid');
        const portableIdentities = name === PORTABLE_WORKSPACE_IDENTITY_COLLECTION
            ? normalizePortableWorkspaceIdentityCollection(records, expectedUserId)
            : null;
        if (name === PORTABLE_WORKSPACE_IDENTITY_COLLECTION && !portableIdentities) {
            throw providerError('webdav_backup_scope_invalid');
        }
        state.records += records.length;
        if (state.records > MAX_RECORDS) throw providerError('webdav_backup_too_large');
        collections[name] = records.map((record, index) => {
            if (!record || typeof record !== 'object' || Array.isArray(record)
                || Object.getPrototypeOf(record) !== Object.prototype) {
                throw providerError('webdav_backup_scope_invalid');
            }
            const ownership = [...OWNERSHIP_FIELDS].filter((field) => Object.prototype.hasOwnProperty.call(record, field));
            if (!ownership.length || ownership.some((field) => record[field] !== expectedUserId)) {
                throw providerError('webdav_backup_scope_invalid');
            }
            const validated = validateJsonValue(record, expectedUserId, state);
            return portableIdentities ? portableIdentities[index] : validated;
        });
    }

    const payload = {
        format: PAYLOAD_FORMAT,
        version: PAYLOAD_VERSION,
        userId: expectedUserId,
        exportedAt,
        revision,
        collections,
    };
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    if (bytes.length > maxSnapshotBytes) throw providerError('webdav_backup_too_large');
    return bytes;
}

let zipArchiveConstructorPromise;
async function loadZipArchiveConstructor() {
    if (!zipArchiveConstructorPromise) {
        zipArchiveConstructorPromise = import('archiver').then((module) => {
            if (typeof module.ZipArchive !== 'function') throw new Error('ZipArchive unavailable');
            return module.ZipArchive;
        });
    }
    return zipArchiveConstructorPromise;
}

async function createArchive(payload, manifest, exportedAt, maxBytes, operation) {
    const ZipArchive = await loadZipArchiveConstructor();
    checkOperation(operation);
    return new Promise((resolve, reject) => {
        const archive = new ZipArchive({ zlib: { level: 9 } });
        const chunks = [];
        let bytes = 0;
        let settled = false;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            if (operation.signal) operation.signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve(result);
        };
        const onAbort = () => {
            try { archive.abort(); } catch {}
            finish(providerError('webdav_backup_aborted'));
        };
        archive.on('data', (chunk) => {
            if (settled) return;
            try { checkOperation(operation); } catch (error) {
                try { archive.abort(); } catch {}
                finish(error);
                return;
            }
            bytes += chunk.length;
            if (bytes > maxBytes) {
                try { archive.abort(); } catch {}
                finish(providerError('webdav_backup_too_large'));
                return;
            }
            chunks.push(chunk);
        });
        archive.once('error', (error) => finish(error));
        archive.once('end', () => finish(null, Buffer.concat(chunks, bytes)));
        if (operation.signal) {
            operation.signal.addEventListener('abort', onAbort, { once: true });
            if (operation.signal.aborted) {
                onAbort();
                return;
            }
        }

        const entryDate = new Date(exportedAt);
        archive.append(Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'), {
            name: 'manifest.json', mode: 0o600, date: entryDate,
        });
        archive.append(payload, { name: 'user-data.json', mode: 0o600, date: entryDate });
        Promise.resolve(archive.finalize()).catch((error) => finish(error));
    });
}

function encryptArchive(archive, header, key, maxBytes) {
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBytes.length > MAX_HEADER_BYTES) throw providerError('webdav_backup_config_invalid');
    const prefix = Buffer.allocUnsafe(MAGIC.length + HEADER_LENGTH_BYTES);
    MAGIC.copy(prefix, 0);
    prefix.writeUInt32BE(headerBytes.length, MAGIC.length);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'base64url'));
    cipher.setAAD(headerAad(header));
    const ciphertext = Buffer.concat([cipher.update(archive), cipher.final()]);
    const body = Buffer.concat([prefix, headerBytes, ciphertext, cipher.getAuthTag()]);
    if (body.length > maxBytes) throw providerError('webdav_backup_too_large');
    return body;
}

/**
 * Build a WebDavSyncService-compatible provider.
 *
 * snapshotSource is the trusted storage boundary. It must take one consistent
 * read snapshot and return exactly:
 *   { userId, revision, collections: { collectionName: [ownedRecord, ...] } }
 * Every record needs a userId/ownerUserId equivalent. The provider rechecks
 * those ownership markers and rejects system/auth/WebDAV key material before
 * serializing anything.
 */
function createWebDavBackupProvider(options = {}) {
    if (!options || typeof options !== 'object' || typeof options.snapshotSource !== 'function') {
        throw providerError('webdav_backup_config_invalid');
    }
    const snapshotSource = options.snapshotSource;
    const instanceId = validateInstanceId(options.instanceId);
    const maxSnapshotBytes = normalizedLimit(options.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES);
    const maxBackupBytes = normalizedLimit(options.maxBackupBytes, DEFAULT_MAX_BACKUP_BYTES);
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const hasExplicitKey = Object.prototype.hasOwnProperty.call(options, 'backupKey');
    const key = decodeBackupKey(hasExplicitKey ? options.backupKey : process.env.WEBDAV_BACKUP_KEY);
    const inFlightByUser = new Map();
    const closeController = new AbortController();
    let closed = false;
    let closePromise = null;

    const operationWithCloseSignal = (operation) => {
        const controller = new AbortController();
        const relays = [];
        for (const signal of [operation.signal, closeController.signal].filter(Boolean)) {
            const relay = () => controller.abort(signal.reason);
            if (signal.aborted) relay();
            else {
                signal.addEventListener('abort', relay, { once: true });
                relays.push([signal, relay]);
            }
        }
        return {
            operation: { ...operation, signal: controller.signal },
            cleanup() {
                for (const [signal, relay] of relays) signal.removeEventListener('abort', relay);
            },
        };
    };

    const produce = async (operation) => {
        checkOperation(operation);
        const userId = validateUserId(operation.userId);
        try {
            const exportedAt = exportedAtFrom(now);
            const snapshot = await snapshotSource({
                userId,
                target: 'webdav-backup',
                signal: operation.signal,
                deadlineAt: operation.deadlineAt,
            });
            checkOperation(operation);
            const payload = normalizeUserSnapshot(snapshot, userId, exportedAt, maxSnapshotBytes);
            const subject = userSubject(instanceId, userId);
            const manifest = {
                format: MANIFEST_FORMAT,
                version: MANIFEST_VERSION,
                backupFormat: BACKUP_FORMAT,
                backupVersion: BACKUP_VERSION,
                subject,
                exportedAt,
                payload: {
                    path: 'user-data.json',
                    mediaType: 'application/json',
                    bytes: payload.length,
                    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
                },
            };
            const archive = await createArchive(payload, manifest, exportedAt, maxBackupBytes, operation);
            checkOperation(operation);
            const header = {
                format: BACKUP_FORMAT,
                version: BACKUP_VERSION,
                instanceId,
                subject,
                exportedAt,
                keyId: keyIdFor(key),
                cipher: 'AES-256-GCM',
                nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
            };
            const body = encryptArchive(archive, header, key, maxBackupBytes);
            checkOperation(operation);
            return { body, contentType: BACKUP_CONTENT_TYPE };
        } catch (error) {
            if (error instanceof WebDavBackupProviderError) throw error;
            throw providerError('webdav_backup_failed');
        }
    };

    function webDavBackupProvider(operation = {}) {
        if (closed) return Promise.reject(providerError('webdav_backup_failed'));
        let userId;
        try { userId = validateUserId(operation?.userId); } catch (error) { return Promise.reject(error); }
        const existing = inFlightByUser.get(userId);
        if (existing) return existing;
        const linked = operationWithCloseSignal({ ...operation, userId });
        const inFlight = produce(linked.operation).finally(() => {
            linked.cleanup();
            if (inFlightByUser.get(userId) === inFlight) inFlightByUser.delete(userId);
        });
        inFlightByUser.set(userId, inFlight);
        return inFlight;
    }

    webDavBackupProvider.close = () => {
        if (closePromise) return closePromise;
        closed = true;
        closeController.abort(providerError('webdav_backup_failed'));
        closePromise = Promise.allSettled([...inFlightByUser.values()]).then(() => {
            key.fill(0);
        });
        return closePromise;
    };

    return webDavBackupProvider;
}

module.exports = {
    AUTH_TAG_BYTES,
    BACKUP_CONTENT_TYPE,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    DEFAULT_MAX_BACKUP_BYTES,
    DEFAULT_MAX_SNAPSHOT_BYTES,
    MANIFEST_FORMAT,
    MANIFEST_VERSION,
    PAYLOAD_FORMAT,
    PAYLOAD_VERSION,
    WebDavBackupProviderError,
    createWebDavBackupProvider,
    decodeBackupKey,
    parseHeader,
    publicBackupError,
    verifyBackup,
};
