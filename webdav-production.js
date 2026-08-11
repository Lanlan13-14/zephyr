'use strict';

const crypto = require('crypto');
const {
    DEFAULT_MAX_SNAPSHOT_BYTES,
    createWebDavBackupProvider,
    decodeBackupKey,
} = require('./webdav-backup-provider');
const { WebDavSyncError, WebDavSyncService } = require('./webdav-sync-service');
const {
    MAX_PORTABLE_WORKSPACE_IDENTITIES,
    PORTABLE_WORKSPACE_IDENTITY_COLLECTION,
    PORTABLE_WORKSPACE_IDENTITY_VERSION,
    USER_SETTING_SQL_PARAMS,
    USER_SETTING_SQL_SCOPE,
    isBackupEligibleUserSettingKey,
    normalizePortableWorkspaceIdentityCollection,
    normalizePortableWorkspaceIdentityRecord,
} = require('./webdav-snapshot-policy');

const CREDENTIAL_FORMAT = 'wdc1';
const CREDENTIAL_NONCE_BYTES = 12;
const CREDENTIAL_TAG_BYTES = 16;
const INSTANCE_META_KEY = 'webdavBackupInstanceId';
const DEFAULT_MAX_RECORDS = 100_000;

class WebDavProductionError extends Error {
    constructor(code) {
        super(code === 'webdav_keys_must_differ'
            ? 'WebDAV backup and credential keys must be independent.'
            : 'WebDAV production keys are unavailable.');
        this.name = 'WebDavProductionError';
        this.code = code === 'webdav_keys_must_differ'
            ? code
            : 'webdav_keys_unavailable';
    }
}

function productionError(code) {
    return new WebDavProductionError(code);
}

function safeJson(value, fallback) {
    try { return JSON.parse(String(value)); } catch { return fallback; }
}

function finiteInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : fallback;
}

function rawRowUtf8Bytes(row) {
    let bytes = 2;
    for (const [key, value] of Object.entries(row || {})) {
        bytes += Buffer.byteLength(key, 'utf8') + 4;
        if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
        else if (Buffer.isBuffer(value) || value instanceof Uint8Array) bytes += value.byteLength;
        else bytes += Buffer.byteLength(String(value), 'utf8');
    }
    return bytes;
}

function checkSnapshotOperation(operation = {}) {
    if (operation.signal?.aborted) {
        if (operation.signal.reason instanceof WebDavSyncError) throw operation.signal.reason;
        throw new WebDavSyncError(499, 'webdav_request_aborted', true);
    }
    if (Number.isFinite(Number(operation.deadlineAt)) && Date.now() >= Number(operation.deadlineAt)) {
        throw new WebDavSyncError(504, 'webdav_timeout', true);
    }
}

function tableExists(db, table) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(String(table));
}

function persistentBackupInstanceId(db) {
    if (!db?.prepare) throw productionError('webdav_keys_unavailable');
    const existing = db.prepare('SELECT value FROM meta WHERE key=?').get(INSTANCE_META_KEY)?.value;
    if (typeof existing === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(existing)) {
        return existing;
    }
    const generated = `zephyr-${crypto.randomUUID()}`;
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(INSTANCE_META_KEY, generated);
    return generated;
}

function decodeProductionKeys({ backupKey, credentialKey, encryptionKey } = {}) {
    let backup;
    let credential;
    let ordinary;
    try {
        backup = decodeBackupKey(backupKey);
        credential = decodeBackupKey(credentialKey);
    } catch {
        backup?.fill(0);
        credential?.fill(0);
        throw productionError('webdav_keys_unavailable');
    }
    try { ordinary = decodeBackupKey(encryptionKey); } catch {}
    const reused = crypto.timingSafeEqual(backup, credential)
        || (ordinary && (crypto.timingSafeEqual(backup, ordinary)
            || crypto.timingSafeEqual(credential, ordinary)));
    ordinary?.fill(0);
    if (reused) {
        backup.fill(0);
        credential.fill(0);
        throw productionError('webdav_keys_must_differ');
    }
    return { backup, credential };
}

function createCredentialCrypto(keyInput) {
    const key = Buffer.from(keyInput || []);
    if (key.length !== 32) {
        key.fill(0);
        throw productionError('webdav_keys_unavailable');
    }
    let closed = false;

    function activeKey() {
        if (closed) throw productionError('webdav_keys_unavailable');
        return key;
    }

    return {
        encryptSecret(value, aad = '') {
            const plaintext = Buffer.from(String(value || ''), 'utf8');
            if (!plaintext.length) return '';
            const nonce = crypto.randomBytes(CREDENTIAL_NONCE_BYTES);
            try {
                const cipher = crypto.createCipheriv('aes-256-gcm', activeKey(), nonce);
                cipher.setAAD(Buffer.from(String(aad), 'utf8'));
                const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
                const tag = cipher.getAuthTag();
                return [
                    CREDENTIAL_FORMAT,
                    nonce.toString('base64url'),
                    tag.toString('base64url'),
                    ciphertext.toString('base64url'),
                ].join('.');
            } finally {
                plaintext.fill(0);
                nonce.fill(0);
            }
        },

        decryptSecret(envelope, aad = '') {
            if (!envelope) return '';
            const parts = String(envelope).split('.');
            if (parts.length !== 4 || parts[0] !== CREDENTIAL_FORMAT) {
                throw productionError('webdav_keys_unavailable');
            }
            let nonce;
            let tag;
            let ciphertext;
            let plaintext;
            try {
                nonce = Buffer.from(parts[1], 'base64url');
                tag = Buffer.from(parts[2], 'base64url');
                ciphertext = Buffer.from(parts[3], 'base64url');
                if (nonce.length !== CREDENTIAL_NONCE_BYTES
                    || tag.length !== CREDENTIAL_TAG_BYTES
                    || nonce.toString('base64url') !== parts[1]
                    || tag.toString('base64url') !== parts[2]
                    || ciphertext.toString('base64url') !== parts[3]) {
                    throw productionError('webdav_keys_unavailable');
                }
                const decipher = crypto.createDecipheriv('aes-256-gcm', activeKey(), nonce);
                decipher.setAAD(Buffer.from(String(aad), 'utf8'));
                decipher.setAuthTag(tag);
                plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                return plaintext.toString('utf8');
            } catch {
                throw productionError('webdav_keys_unavailable');
            } finally {
                nonce?.fill(0);
                tag?.fill(0);
                ciphertext?.fill(0);
                plaintext?.fill(0);
            }
        },

        close() {
            if (closed) return;
            closed = true;
            key.fill(0);
        },
    };
}

function ownedRecord(record, userId, fields) {
    if (!record || String(record.ownerUserId || record.owner_user_id || '') !== userId) {
        throw new WebDavSyncError(500, 'webdav_backup_failed');
    }
    const output = { ownerUserId: userId };
    for (const field of fields) output[field] = record[field] === undefined ? null : record[field];
    return output;
}

const SNAPSHOT_COLLECTION_NAMES = Object.freeze([
    'connections', 'jumpHosts', 'notes', 'proxies', 'sshKeys', 'userSettings', 'workspaces',
    PORTABLE_WORKSPACE_IDENTITY_COLLECTION,
]);

function createUserScopedSnapshotSource({
    storage,
    maxRecords = DEFAULT_MAX_RECORDS,
    maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
} = {}) {
    if (!storage?.rawDb || !storage?.getConnectionById || !storage?.getProxyRaw || !storage?.getSshKeyRaw) {
        throw new TypeError('A live Zephyr storage adapter is required');
    }
    const recordLimit = Math.max(1, Math.min(DEFAULT_MAX_RECORDS, finiteInteger(maxRecords, DEFAULT_MAX_RECORDS)));
    const byteLimit = Math.max(1024, finiteInteger(maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES));

    return async function userScopedSnapshot(operation = {}) {
        checkSnapshotOperation(operation);
        const userId = String(operation.userId || '');
        if (!userId || userId.length > 512 || /[\0-\x1f\x7f]/.test(userId)) {
            throw new WebDavSyncError(401, 'webdav_unauthorized');
        }
        const db = storage.rawDb();
        if (!db?.transaction) throw new WebDavSyncError(503, 'webdav_unavailable', true);

        const readSnapshot = db.transaction(() => {
            checkSnapshotOperation(operation);
            const user = db.prepare("SELECT userId,status FROM users WHERE userId=? AND status='active'").get(userId);
            if (!user || user.userId !== userId) throw new WebDavSyncError(401, 'webdav_unauthorized');

            let snapshotRevision = 0;
            let totalRecords = 0;
            const collectionSizes = new Map(SNAPSHOT_COLLECTION_NAMES.map((name) => [name, 0]));
            let snapshotBytes = Buffer.byteLength(JSON.stringify({
                format: 'zephyr-user-data',
                version: 1,
                userId,
                exportedAt: '0000-00-00T00:00:00.000Z',
                revision: Number.MAX_SAFE_INTEGER,
                collections: Object.fromEntries(SNAPSHOT_COLLECTION_NAMES.map((name) => [name, []])),
            }), 'utf8') + 1;
            const collect = (name, statement, params, normalize) => {
                const records = [];
                for (const row of statement.iterate(...params)) {
                    checkSnapshotOperation(operation);
                    totalRecords += 1;
                    if (totalRecords > recordLimit) {
                        throw new WebDavSyncError(413, 'webdav_backup_too_large');
                    }
                    if (snapshotBytes + rawRowUtf8Bytes(row) > byteLimit) {
                        throw new WebDavSyncError(413, 'webdav_backup_too_large');
                    }
                    const record = normalize(row);
                    const serialized = JSON.stringify(record);
                    snapshotBytes += Buffer.byteLength(serialized, 'utf8')
                        + (collectionSizes.get(name) > 0 ? 1 : 0);
                    if (snapshotBytes > byteLimit) {
                        throw new WebDavSyncError(413, 'webdav_backup_too_large');
                    }
                    collectionSizes.set(name, collectionSizes.get(name) + 1);
                    records.push(record);
                }
                return records;
            };
            const noteRevision = (record) => {
                snapshotRevision = Math.max(
                    snapshotRevision,
                    finiteInteger(record?.revision),
                    finiteInteger(record?.updatedAt),
                    finiteInteger(record?.updated_at),
                );
                return record;
            };

            const connections = collect('connections', db.prepare(`SELECT id FROM connections
                WHERE ownerUserId=? AND COALESCE(ephemeral,0)=0 ORDER BY id LIMIT ?`),
            [userId, recordLimit + 1], ({ id }) => {
                const row = noteRevision(storage.getConnectionById(id));
                return ownedRecord(row, userId, [
                    'id', 'name', 'host', 'port', 'protocol', 'username', 'password', 'privateKey',
                    'remark', 'tags', 'connectionMode', 'proxyId', 'jumpHostId', 'jumpHostIds', 'sshKeyId',
                    'rdpSoundMode', 'rdpClipboard', 'rdpMicrophone', 'rdpCamera', 'rdpStorage', 'rdpLocation',
                    'rdpResolution', 'rdpQuality', 'rdpFps', 'rdpPipeline', 'rdpTouchMode',
                    'rdpTouchSensitivity', 'rdpDomain', 'encoding', 'visibility', 'createdAt', 'updatedAt',
                    'revision', 'lastConnectedAt',
                ]);
            });

            const proxies = collect('proxies',
                db.prepare('SELECT id FROM proxies WHERE ownerUserId=? ORDER BY id LIMIT ?'),
                [userId, recordLimit + 1], ({ id }) => {
                const row = noteRevision(storage.getProxyRaw(id));
                return ownedRecord(row, userId, [
                    'id', 'name', 'host', 'port', 'type', 'username', 'password', 'visibility',
                    'createdAt', 'updatedAt', 'revision',
                ]);
            });

            const sshKeys = collect('sshKeys',
                db.prepare('SELECT id FROM ssh_keys WHERE ownerUserId=? ORDER BY id LIMIT ?'),
                [userId, recordLimit + 1], ({ id }) => {
                const row = noteRevision(storage.getSshKeyRaw(id));
                return ownedRecord(row, userId, [
                    'id', 'name', 'privateKey', 'passphrase', 'remark', 'visibility',
                    'createdAt', 'updatedAt', 'revision',
                ]);
            });

            const jumpHosts = collect('jumpHosts', db.prepare(`SELECT id,name,connectionId,createdAt,updatedAt,revision,ownerUserId,visibility
                FROM jump_hosts WHERE ownerUserId=? ORDER BY id LIMIT ?`),
            [userId, recordLimit + 1], (row) => ownedRecord(noteRevision(row), userId, [
                'id', 'name', 'connectionId', 'visibility', 'createdAt', 'updatedAt', 'revision',
            ]));

            const notes = collect('notes', db.prepare(`SELECT note_id,owner_user_id,title,content,group_path,tags_json,
                linked_connection_ids_json,sort_order,revision,created_at,updated_at,deleted_at,visibility,
                share_with_users,share_with_admins,allow_ai,allow_ai_read,allow_ai_write
                FROM notes WHERE owner_user_id=? ORDER BY note_id LIMIT ?`),
            [userId, recordLimit + 1], (row) => {
                noteRevision(row);
                return {
                    ownerUserId: userId,
                    noteId: row.note_id,
                    title: row.title,
                    content: row.content,
                    groupPath: row.group_path,
                    tags: safeJson(row.tags_json, []),
                    linkedConnectionIds: safeJson(row.linked_connection_ids_json, []),
                    sortOrder: row.sort_order,
                    revision: finiteInteger(row.revision, 1),
                    createdAt: finiteInteger(row.created_at),
                    updatedAt: finiteInteger(row.updated_at),
                    deletedAt: row.deleted_at == null ? null : finiteInteger(row.deleted_at),
                    visibility: row.visibility || 'private',
                    shareWithUsers: !!row.share_with_users,
                    shareWithAdmins: !!row.share_with_admins,
                    allowAi: !!row.allow_ai,
                    allowAiRead: !!row.allow_ai_read,
                    allowAiWrite: !!row.allow_ai_write,
                };
            });

            const userSettings = collect('userSettings', db.prepare(`SELECT key,value,updated_at FROM user_settings
                WHERE user_id=? AND (${USER_SETTING_SQL_SCOPE}) ORDER BY key LIMIT ?`),
            [userId, ...USER_SETTING_SQL_PARAMS, recordLimit + 1], (row) => {
                if (!isBackupEligibleUserSettingKey(row.key)) {
                    throw new WebDavSyncError(500, 'webdav_backup_failed');
                }
                noteRevision(row);
                return {
                    userId,
                    key: row.key,
                    value: safeJson(row.value, null),
                    updatedAt: finiteInteger(row.updated_at),
                };
            });

            const workspaces = collect('workspaces', db.prepare(`SELECT workspace_id,user_id,client_id,name,state_json,revision,updated_at
                FROM workspaces WHERE user_id=? ORDER BY client_id,workspace_id LIMIT ?`),
            [userId, recordLimit + 1], (row) => {
                noteRevision(row);
                return {
                    userId,
                    workspaceId: row.workspace_id,
                    clientId: row.client_id,
                    name: row.name,
                    state: safeJson(row.state_json, {}),
                    revision: finiteInteger(row.revision, 1),
                    updatedAt: finiteInteger(row.updated_at),
                };
            });

            /* Legacy databases predate the identity table.  An empty V1
             * collection is compatible with them; assigning new ids would not
             * be.  New databases select only identity columns and revalidate
             * ownership after the owner-scoped SQL predicate. */
            const workspacePortableIdentities = tableExists(db, 'workspace_portable_identities')
                ? collect(PORTABLE_WORKSPACE_IDENTITY_COLLECTION, db.prepare(`SELECT owner_user_id,
                    source_client_id,source_workspace_id,portable_id FROM workspace_portable_identities
                    WHERE owner_user_id=? ORDER BY source_client_id,source_workspace_id LIMIT ?`),
                [userId, Math.min(recordLimit, MAX_PORTABLE_WORKSPACE_IDENTITIES) + 1], (row) => {
                    const identity = normalizePortableWorkspaceIdentityRecord({
                        mappingVersion: PORTABLE_WORKSPACE_IDENTITY_VERSION,
                        ownerUserId: row.owner_user_id,
                        sourceClientId: row.source_client_id,
                        sourceWorkspaceId: row.source_workspace_id,
                        portableId: row.portable_id,
                    }, userId);
                    if (!identity) throw new WebDavSyncError(500, 'webdav_backup_failed');
                    return identity;
                })
                : [];
            if (workspacePortableIdentities.length > MAX_PORTABLE_WORKSPACE_IDENTITIES) {
                throw new WebDavSyncError(413, 'webdav_backup_too_large');
            }
            if (!normalizePortableWorkspaceIdentityCollection(workspacePortableIdentities, userId)) {
                throw new WebDavSyncError(500, 'webdav_backup_failed');
            }

            checkSnapshotOperation(operation);
            return {
                userId,
                revision: snapshotRevision,
                collections: {
                    connections,
                    jumpHosts,
                    notes,
                    proxies,
                    sshKeys,
                    userSettings,
                    workspaces,
                    [PORTABLE_WORKSPACE_IDENTITY_COLLECTION]: workspacePortableIdentities,
                },
            };
        });

        return readSnapshot();
    };
}

function deleteUserWebDavState(db, userId, service = null) {
    const key = String(userId || '');
    if (!key) return false;
    if (service?.db === db && typeof service.deleteConfig === 'function') return service.deleteConfig(key);
    if (!db?.prepare || !tableExists(db, 'webdav_sync_configs')) return false;
    return !!db.prepare('DELETE FROM webdav_sync_configs WHERE user_id=?').run(key).changes;
}

function createUnavailableProxy(getService) {
    const proxy = {};
    for (const method of ['getConfig', 'patchConfig', 'testConnection', 'syncNow', 'deleteConfigAndDrain']) {
        proxy[method] = (...args) => {
            const service = getService();
            if (!service) throw new WebDavSyncError(503, 'webdav_unavailable', true);
            return service[method](...args);
        };
    }
    return proxy;
}

function consumeProductionKeys(env) {
    const backupKeyInput = env.WEBDAV_BACKUP_KEY;
    const credentialKeyInput = env.WEBDAV_CREDENTIAL_KEY;
    delete env.WEBDAV_BACKUP_KEY;
    delete env.WEBDAV_CREDENTIAL_KEY;
    try {
        return decodeProductionKeys({
            backupKey: backupKeyInput,
            credentialKey: credentialKeyInput,
            encryptionKey: env.ENCRYPTION_KEY,
        });
    } finally {
        if (Buffer.isBuffer(backupKeyInput)) backupKeyInput.fill(0);
        if (Buffer.isBuffer(credentialKeyInput)) credentialKeyInput.fill(0);
    }
}

function createWebDavProductionManager({ storage, env = process.env, serviceOptions = {}, providerOptions = {} } = {}) {
    if (!storage?.rawDb) throw new TypeError('WebDAV production manager requires storage');
    let backupKey = null;
    let credentialCrypto = null;
    let unavailableCode = null;
    let decodedKeys = null;
    try {
        decodedKeys = consumeProductionKeys(env);
        credentialCrypto = createCredentialCrypto(decodedKeys.credential);
        decodedKeys.credential.fill(0);
        backupKey = decodedKeys.backup;
        decodedKeys = null;
    } catch (error) {
        decodedKeys?.backup?.fill(0);
        decodedKeys?.credential?.fill(0);
        unavailableCode = error?.code || 'webdav_keys_unavailable';
    }

    let active = null;
    let closed = false;
    let managerClosePromise = null;
    const retiring = new Set();

    const closeLifecycle = (lifecycle) => {
        if (!lifecycle) return Promise.resolve();
        let serviceDrain;
        let providerDrain;
        try { serviceDrain = lifecycle.service?.close?.(); } catch {}
        try { providerDrain = lifecycle.backupProvider?.close?.(); } catch {}
        return Promise.allSettled([serviceDrain, providerDrain]);
    };

    const trackRetirement = (drain) => {
        const tracked = Promise.resolve(drain).finally(() => retiring.delete(tracked));
        retiring.add(tracked);
        return tracked;
    };

    const retireActive = () => {
        const lifecycle = active;
        active = null;
        if (!lifecycle) return Promise.resolve();
        return trackRetirement(closeLifecycle(lifecycle));
    };

    const manager = {
        service: createUnavailableProxy(() => active?.service),
        get available() { return !!active?.service && !closed; },
        get unavailableCode() { return unavailableCode; },

        rebuild() {
            if (closed || !backupKey || !credentialCrypto) return false;
            void retireActive();
            const db = storage.rawDb();
            const instanceId = persistentBackupInstanceId(db);
            const snapshotSource = createUserScopedSnapshotSource({
                storage,
                maxRecords: providerOptions.maxRecords,
                maxSnapshotBytes: providerOptions.maxSnapshotBytes,
            });
            const backupProvider = createWebDavBackupProvider({
                snapshotSource,
                instanceId,
                backupKey,
                maxSnapshotBytes: providerOptions.maxSnapshotBytes,
                maxBackupBytes: providerOptions.maxBackupBytes,
            });
            let service;
            try {
                service = new WebDavSyncService({
                    db,
                    secretCrypto: credentialCrypto,
                    backupProvider,
                    ...serviceOptions,
                });
            } catch (error) {
                void trackRetirement(backupProvider.close());
                throw error;
            }
            active = { service, backupProvider };
            unavailableCode = null;
            return true;
        },

        async beforeStorageClose() {
            await retireActive();
        },

        deleteUserState({ db = storage.rawDb(), userId } = {}) {
            return deleteUserWebDavState(db, userId, active?.service);
        },

        close() {
            if (managerClosePromise) return managerClosePromise;
            closed = true;
            managerClosePromise = (async () => {
                await retireActive();
                await Promise.allSettled([...retiring]);
                credentialCrypto?.close?.();
                credentialCrypto = null;
                backupKey?.fill(0);
                backupKey = null;
            })();
            return managerClosePromise;
        },
    };

    if (backupKey && credentialCrypto) {
        try { manager.rebuild(); } catch {
            unavailableCode = 'webdav_initialization_failed';
            void retireActive();
        }
    }
    return manager;
}

module.exports = {
    CREDENTIAL_FORMAT,
    INSTANCE_META_KEY,
    WebDavProductionError,
    createCredentialCrypto,
    createUserScopedSnapshotSource,
    createWebDavProductionManager,
    decodeProductionKeys,
    deleteUserWebDavState,
    persistentBackupInstanceId,
};
