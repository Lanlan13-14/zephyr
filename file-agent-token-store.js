'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createDatabase } = require('./sqlite-driver');
const { createClientTokenKeyring } = require('./storage');

const ENVELOPE_PREFIX = 'ZEPHYR_CLIENT_TOKEN_V1:';
const ENVELOPE_ALGORITHM = 'AES-256-GCM';
const METADATA_SYNC_CONTRACT = Object.freeze({
    version: 1,
    storage: 'encrypted-sqlite',
    secretsEncrypted: true,
});

class TokenStoreError extends Error {
    constructor(code, message, cause = null) {
        super(message);
        this.code = code;
        if (cause) this.cause = cause;
    }
}

function positiveRevision(value) {
    return Math.max(1, Number(value) || 1);
}

function storedDigest(value) {
    return value instanceof Uint8Array && value.byteLength === 32 ? Buffer.from(value) : null;
}

function safeName(value, fallback = 'Zephyr Agent Token') {
    return String(value || '').trim().slice(0, 80) || fallback;
}

function aadFor(ownerUserId, tokenId, revision) {
    return `zephyr-client-token:v1:${ownerUserId}:${tokenId}:${positiveRevision(revision)}`;
}

function deriveKey(master, purpose) {
    return Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.from(master),
        Buffer.from('zephyr-client-token-key-v1', 'utf8'),
        Buffer.from(String(purpose), 'utf8'),
        32,
    ));
}

function digestSecret(secret, keyEntry) {
    const digestKey = deriveKey(keyEntry.key, `lookup:${keyEntry.id}`);
    try {
        return crypto.createHmac('sha256', digestKey).update(String(secret), 'utf8').digest();
    } finally {
        digestKey.fill(0);
    }
}

class AgentTokenStore {
    constructor(filePath, options = {}) {
        this.legacyFilePath = path.resolve(filePath);
        this.filePath = this.legacyFilePath;
        this.fs = options.fs || fs;
        this.getDb = typeof options.getDb === 'function' ? options.getDb : null;
        this.providedDb = options.db || null;
        this.ownedDb = null;
        this.readyDb = null;
        this.resolveOwner = typeof options.resolveOwner === 'function' ? options.resolveOwner : null;
        this.now = options.now || Date.now;
        this.randomBytes = options.randomBytes || crypto.randomBytes;
        this.metadataSyncContract = METADATA_SYNC_CONTRACT;
        this.keyring = options.keyring || createClientTokenKeyring({
            filePath: options.keyFile || path.join(path.dirname(this.legacyFilePath), 'crypto', 'client-token-keys.json'),
            fs: this.fs,
            now: this.now,
            randomBytes: this.randomBytes,
        });
        this.databaseFile = path.resolve(options.databaseFile || path.join(path.dirname(this.legacyFilePath), 'zephyr.db'));
    }

    get db() {
        return this._database(false);
    }

    _database(createStandalone = true) {
        let database = this.getDb ? this.getDb() : this.providedDb;
        if (!database && this.ownedDb) database = this.ownedDb;
        if (!database && createStandalone && !this.getDb) {
            if (!this.ownedDb) this.ownedDb = createDatabase(this.databaseFile, { forceBuiltin: true });
            database = this.ownedDb;
        }
        if (database !== this.readyDb) this.readyDb = null;
        return database || null;
    }

    _ensureSchema(database) {
        database.exec(`
            CREATE TABLE IF NOT EXISTS encrypted_client_tokens (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                secret_ciphertext TEXT NOT NULL,
                secret_digest BLOB,
                key_id TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_used_at INTEGER,
                deleted_at INTEGER,
                CHECK (revision >= 1),
                CHECK (length(name) BETWEEN 1 AND 80)
            );
            CREATE INDEX IF NOT EXISTS idx_encrypted_client_tokens_owner
                ON encrypted_client_tokens(owner_user_id, deleted_at, updated_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_encrypted_client_tokens_active_digest
                ON encrypted_client_tokens(secret_digest) WHERE deleted_at IS NULL;
        `);
    }

    _wrap(error, code = 'token_store_unavailable') {
        if (error instanceof TokenStoreError) return error;
        return new TokenStoreError(code, 'Encrypted Client Token storage is unavailable', error);
    }

    ensureReady(options = {}) {
        const database = this._database(true);
        if (!database) throw new TokenStoreError('token_store_unavailable', 'Encrypted Client Token database is unavailable');
        if (this.readyDb === database) return this;
        try {
            this.keyring.ensure();
            this._ensureSchema(database);
            this._migrateLegacy(database, options.resolveOwner || this.resolveOwner);
            this._verifyActiveRows(database);
            this.readyDb = database;
            return this;
        } catch (error) {
            this.readyDb = null;
            throw this._wrap(error);
        }
    }

    _readLegacy() {
        this._discardInterruptedWrites();
        if (!this.fs.existsSync(this.legacyFilePath)) return null;
        let parsed;
        try {
            parsed = JSON.parse(this.fs.readFileSync(this.legacyFilePath, 'utf8'));
        } catch (error) {
            return { malformed: true, records: [], error };
        }
        const records = [];
        if (Array.isArray(parsed?.tokens)) {
            for (const item of parsed.tokens) {
                if (!item || typeof item.token !== 'string' || typeof item.ownerId !== 'string') continue;
                records.push({
                    id: String(item.id || ''),
                    ownerId: String(item.ownerId || ''),
                    ownerUsername: String(item.ownerUsername || ''),
                    name: safeName(item.name),
                    token: item.token,
                    createdAt: Number(item.createdAt || this.now()),
                    updatedAt: Number(item.updatedAt || item.createdAt || this.now()),
                    lastUsedAt: item.lastUsedAt ? Number(item.lastUsedAt) : null,
                });
            }
        } else if (parsed && typeof parsed === 'object') {
            for (const [token, ownerId] of Object.entries(parsed)) {
                if (!token || typeof ownerId !== 'string') continue;
                records.push({
                    id: '', ownerId, ownerUsername: '', name: 'Default Token', token,
                    createdAt: Number(this.now()), updatedAt: Number(this.now()), lastUsedAt: null,
                });
            }
        }
        return { malformed: false, records };
    }

    _proveLegacyOwner(item, resolveOwner) {
        if (typeof resolveOwner !== 'function') return null;
        let resolved;
        try {
            resolved = resolveOwner({
                userId: item.ownerId,
                username: item.ownerUsername || item.ownerId,
                legacy: !item.ownerUsername,
            });
        } catch {
            return null;
        }
        if (!resolved || resolved.status !== 'active' || !resolved.userId || !resolved.username) return null;
        if (String(resolved.userId) === item.ownerId) return resolved;
        if (!item.ownerUsername && resolved.legacyOwnerAllowed === true) return resolved;
        return null;
    }

    _stableLegacyId(item, ownerUserId) {
        const supplied = String(item.id || '');
        if (/^[A-Za-z0-9_.:-]{1,128}$/.test(supplied)) return supplied;
        return `tok_${crypto.createHash('sha256')
            .update(`${ownerUserId}\0${item.token}`, 'utf8')
            .digest('hex').slice(0, 24)}`;
    }

    _migrateLegacy(database, resolveOwner) {
        const legacy = this._readLegacy();
        if (!legacy) return;
        const insert = database.prepare(`INSERT INTO encrypted_client_tokens
            (id, owner_user_id, name, secret_ciphertext, secret_digest, key_id, revision,
             created_at, updated_at, last_used_at, deleted_at)
            VALUES (@id, @ownerUserId, @name, @ciphertext, @digest, @keyId, 1,
                    @createdAt, @updatedAt, @lastUsedAt, NULL)`);
        const getById = database.prepare('SELECT owner_user_id, secret_digest FROM encrypted_client_tokens WHERE id = ?');
        const getByDigest = database.prepare('SELECT id FROM encrypted_client_tokens WHERE secret_digest = ? AND deleted_at IS NULL');
        const migrate = database.transaction(() => {
            for (const item of legacy.records) {
                if (typeof item.token !== 'string' || item.token.length < 16 || item.token.length > 512) continue;
                const owner = this._proveLegacyOwner(item, resolveOwner);
                if (!owner) continue;
                const id = this._stableLegacyId(item, String(owner.userId));
                const existing = getById.get(id);
                const encrypted = this._encrypt(item.token, String(owner.userId), id, 1);
                try {
                    if (existing) {
                        const sameOwner = String(existing.owner_user_id) === String(owner.userId);
                        const currentDigest = storedDigest(existing.secret_digest);
                        const sameDigest = currentDigest
                            && crypto.timingSafeEqual(currentDigest, encrypted.digest);
                        if (!sameOwner || !sameDigest) continue;
                    } else if (!getByDigest.get(encrypted.digest)) {
                        insert.run({
                            id,
                            ownerUserId: String(owner.userId),
                            name: safeName(item.name),
                            ciphertext: encrypted.ciphertext,
                            digest: encrypted.digest,
                            keyId: encrypted.keyId,
                            createdAt: Math.max(1, Number(item.createdAt || this.now())),
                            updatedAt: Math.max(Number(item.createdAt || 1), Number(item.updatedAt || this.now())),
                            lastUsedAt: item.lastUsedAt ? Number(item.lastUsedAt) : null,
                        });
                    }
                } finally {
                    encrypted.digest.fill(0);
                }
            }
        });
        migrate();
        try { database.pragma('wal_checkpoint(FULL)'); } catch {}
        this._secureArchiveLegacy();
    }

    _secureArchiveLegacy() {
        if (!this.fs.existsSync(this.legacyFilePath)) return;
        let descriptor = null;
        try {
            descriptor = this.fs.openSync(this.legacyFilePath, 'r+');
            const size = Number(this.fs.fstatSync(descriptor).size || 0);
            const zeros = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
            for (let offset = 0; offset < size; offset += zeros.length) {
                this.fs.writeSync(descriptor, zeros, 0, Math.min(zeros.length, size - offset), offset);
            }
            this.fs.ftruncateSync(descriptor, 0);
            this.fs.fsyncSync(descriptor);
            this.fs.closeSync(descriptor);
            descriptor = null;
            const archived = `${this.legacyFilePath}.migrated`;
            try { this.fs.unlinkSync(archived); } catch {}
            this.fs.renameSync(this.legacyFilePath, archived);
            try { this.fs.chmodSync(archived, 0o600); } catch {}
            this._syncDirectory(path.dirname(this.legacyFilePath));
        } catch (error) {
            if (descriptor !== null) {
                try { this.fs.closeSync(descriptor); } catch {}
            }
            throw new TokenStoreError('legacy_token_cleanup_failed', 'Legacy Client Token file could not be securely cleared', error);
        }
    }

    _discardInterruptedWrites() {
        const directory = path.dirname(this.legacyFilePath);
        if (!this.fs.existsSync(directory)) return;
        const prefix = `.${path.basename(this.legacyFilePath)}.tmp-`;
        let entries;
        try { entries = this.fs.readdirSync(directory); } catch { return; }
        for (const entry of entries) {
            if (!entry.startsWith(prefix)) continue;
            const target = path.join(directory, entry);
            let descriptor = null;
            try {
                descriptor = this.fs.openSync(target, 'r+');
                const size = Number(this.fs.fstatSync(descriptor).size || 0);
                const zeros = Buffer.alloc(64 * 1024);
                for (let offset = 0; offset < size; offset += zeros.length) {
                    this.fs.writeSync(descriptor, zeros, 0, Math.min(zeros.length, size - offset), offset);
                }
                this.fs.fsyncSync(descriptor);
                this.fs.closeSync(descriptor);
                descriptor = null;
                this.fs.unlinkSync(target);
            } catch {
                if (descriptor !== null) {
                    try { this.fs.closeSync(descriptor); } catch {}
                }
            }
        }
    }

    _syncDirectory(directory) {
        let descriptor = null;
        try {
            descriptor = this.fs.openSync(directory, 'r');
            this.fs.fsyncSync(descriptor);
        } catch {
            // Directory fsync is not supported on every Windows filesystem.
        } finally {
            if (descriptor !== null) {
                try { this.fs.closeSync(descriptor); } catch {}
            }
        }
    }

    _encrypt(secret, ownerUserId, tokenId, revision, keyEntry = this.keyring.current()) {
        const iv = this.randomBytes(12);
        const aad = aadFor(ownerUserId, tokenId, revision);
        const contentKey = deriveKey(keyEntry.key, `aead:${keyEntry.id}`);
        try {
            const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
            cipher.setAAD(Buffer.from(aad, 'utf8'));
            const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
            const envelope = {
                version: 1,
                algorithm: ENVELOPE_ALGORITHM,
                keyId: keyEntry.id,
                iv: iv.toString('base64url'),
                tag: cipher.getAuthTag().toString('base64url'),
                ciphertext: ciphertext.toString('base64url'),
            };
            return {
                keyId: keyEntry.id,
                ciphertext: ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url'),
                digest: digestSecret(secret, keyEntry),
            };
        } finally {
            contentKey.fill(0);
        }
    }

    _decrypt(row) {
        const text = String(row?.secret_ciphertext || '');
        if (!text.startsWith(ENVELOPE_PREFIX)) throw new TokenStoreError('token_ciphertext_invalid', 'Client Token ciphertext is invalid');
        let envelope;
        try {
            envelope = JSON.parse(Buffer.from(text.slice(ENVELOPE_PREFIX.length), 'base64url').toString('utf8'));
        } catch (error) {
            throw new TokenStoreError('token_ciphertext_invalid', 'Client Token ciphertext is invalid', error);
        }
        if (envelope.version !== 1 || envelope.algorithm !== ENVELOPE_ALGORITHM
            || envelope.keyId !== row.key_id) {
            throw new TokenStoreError('token_ciphertext_invalid', 'Client Token ciphertext metadata is invalid');
        }
        const keyEntry = this.keyring.get(envelope.keyId);
        if (!keyEntry) throw new TokenStoreError('token_key_unavailable', 'Client Token encryption key is unavailable');
        const contentKey = deriveKey(keyEntry.key, `aead:${keyEntry.id}`);
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64url'));
            decipher.setAAD(Buffer.from(aadFor(row.owner_user_id, row.id, row.revision), 'utf8'));
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
            return Buffer.concat([
                decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
                decipher.final(),
            ]).toString('utf8');
        } catch (error) {
            throw new TokenStoreError('token_decryption_failed', 'Client Token decryption failed', error);
        } finally {
            contentKey.fill(0);
        }
    }

    _verifyActiveRows(database) {
        const rows = database.prepare('SELECT * FROM encrypted_client_tokens WHERE deleted_at IS NULL').all();
        for (const row of rows) {
            const currentDigest = storedDigest(row.secret_digest);
            if (!currentDigest) {
                throw new TokenStoreError('token_digest_invalid', 'Client Token verification digest is invalid');
            }
            const secret = this._decrypt(row);
            const keyEntry = this.keyring.get(row.key_id);
            if (!keyEntry) throw new TokenStoreError('token_key_unavailable', 'Client Token encryption key is unavailable');
            const expected = digestSecret(secret, keyEntry);
            try {
                if (!crypto.timingSafeEqual(expected, currentDigest)) {
                    throw new TokenStoreError('token_digest_invalid', 'Client Token verification digest does not match ciphertext');
                }
            } finally {
                expected.fill(0);
            }
        }
    }

    _row(row, includeSecret = false) {
        if (!row) return null;
        const record = {
            id: String(row.id),
            ownerId: String(row.owner_user_id),
            ownerUserId: String(row.owner_user_id),
            name: String(row.name),
            revision: positiveRevision(row.revision),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
            deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
        };
        if (includeSecret && !record.deletedAt) record.token = this._decrypt(row);
        return record;
    }

    list(ownerUserId, { includeSecret = false, includeDeleted = false } = {}) {
        this.ensureReady();
        const rows = this.db.prepare(`SELECT * FROM encrypted_client_tokens
            WHERE owner_user_id = ? AND (? = 1 OR deleted_at IS NULL)
            ORDER BY created_at DESC, id`).all(String(ownerUserId || ''), includeDeleted ? 1 : 0);
        return rows.map((row) => this._row(row, includeSecret));
    }

    read(ownerUserId, tokenId, { includeSecret = false, includeDeleted = false } = {}) {
        this.ensureReady();
        const row = this.db.prepare(`SELECT * FROM encrypted_client_tokens
            WHERE owner_user_id = ? AND id = ? AND (? = 1 OR deleted_at IS NULL)`)
            .get(String(ownerUserId || ''), String(tokenId || ''), includeDeleted ? 1 : 0);
        return this._row(row, includeSecret);
    }

    create({ id, ownerUserId, name, secret, createdAt } = {}) {
        this.ensureReady();
        const owner = String(ownerUserId || '');
        const tokenId = String(id || `tok_${this.randomBytes(12).toString('hex')}`);
        if (!owner || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tokenId)) {
            throw new TokenStoreError('invalid_token_record', 'Client Token identity is invalid');
        }
        if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512) {
            throw new TokenStoreError('invalid_token_secret', 'Client Token secret is invalid');
        }
        const timestamp = Math.max(1, Number(createdAt || this.now()));
        const encrypted = this._encrypt(secret, owner, tokenId, 1);
        try {
            this.db.prepare(`INSERT INTO encrypted_client_tokens
                (id, owner_user_id, name, secret_ciphertext, secret_digest, key_id, revision,
                 created_at, updated_at, last_used_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)`)
                .run(tokenId, owner, safeName(name), encrypted.ciphertext, encrypted.digest, encrypted.keyId, timestamp, timestamp);
        } catch (error) {
            throw this._wrap(error, 'token_store_write_failed');
        } finally {
            encrypted.digest.fill(0);
        }
        return this.read(owner, tokenId, { includeSecret: true });
    }

    rename(ownerUserId, tokenId, name, { expectedRevision } = {}) {
        this.ensureReady();
        const owner = String(ownerUserId || '');
        const id = String(tokenId || '');
        return this.db.transaction(() => {
            const row = this.db.prepare(`SELECT * FROM encrypted_client_tokens
                WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL`).get(owner, id);
            if (!row) throw new TokenStoreError('not_found', 'Client Token not found');
            if (expectedRevision != null && Number(expectedRevision) !== positiveRevision(row.revision)) {
                throw new TokenStoreError('revision_conflict', 'Client Token revision does not match');
            }
            const revision = positiveRevision(row.revision) + 1;
            const timestamp = Math.max(Number(row.updated_at) + 1, Number(this.now()));
            const encrypted = this._encrypt(this._decrypt(row), owner, id, revision);
            try {
                const result = this.db.prepare(`UPDATE encrypted_client_tokens SET
                    name = ?, secret_ciphertext = ?, secret_digest = ?, key_id = ?, revision = ?, updated_at = ?
                    WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`)
                    .run(safeName(name, row.name), encrypted.ciphertext, encrypted.digest, encrypted.keyId,
                        revision, timestamp, owner, id, positiveRevision(row.revision));
                if (!result.changes) throw new TokenStoreError('revision_conflict', 'Client Token revision does not match');
            } finally {
                encrypted.digest.fill(0);
            }
            return this.read(owner, id, { includeSecret: true });
        })();
    }

    rotateSecret(ownerUserId, tokenId, secret, { expectedRevision } = {}) {
        this.ensureReady();
        const owner = String(ownerUserId || '');
        const id = String(tokenId || '');
        return this.db.transaction(() => {
            const row = this.db.prepare(`SELECT * FROM encrypted_client_tokens
                WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL`).get(owner, id);
            if (!row) throw new TokenStoreError('not_found', 'Client Token not found');
            if (expectedRevision != null && Number(expectedRevision) !== positiveRevision(row.revision)) {
                throw new TokenStoreError('revision_conflict', 'Client Token revision does not match');
            }
            const revision = positiveRevision(row.revision) + 1;
            const timestamp = Math.max(Number(row.updated_at) + 1, Number(this.now()));
            const encrypted = this._encrypt(secret, owner, id, revision);
            try {
                const result = this.db.prepare(`UPDATE encrypted_client_tokens SET
                    secret_ciphertext = ?, secret_digest = ?, key_id = ?, revision = ?, updated_at = ?, last_used_at = NULL
                    WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`)
                    .run(encrypted.ciphertext, encrypted.digest, encrypted.keyId, revision, timestamp,
                        owner, id, positiveRevision(row.revision));
                if (!result.changes) throw new TokenStoreError('revision_conflict', 'Client Token revision does not match');
            } finally {
                encrypted.digest.fill(0);
            }
            return this.read(owner, id, { includeSecret: true });
        })();
    }

    _revokeRow(row, timestamp = Number(this.now())) {
        if (!row || row.deleted_at != null) return false;
        const revision = positiveRevision(row.revision) + 1;
        const deletedAt = Math.max(Number(row.updated_at) + 1, Number(timestamp));
        const scrub = this.randomBytes(32).toString('base64url');
        const encrypted = this._encrypt(scrub, row.owner_user_id, row.id, revision);
        try {
            const result = this.db.prepare(`UPDATE encrypted_client_tokens SET
                secret_ciphertext = ?, secret_digest = NULL, key_id = ?, revision = ?,
                updated_at = ?, deleted_at = ?, last_used_at = NULL
                WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`)
                .run(encrypted.ciphertext, encrypted.keyId, revision, deletedAt, deletedAt,
                    row.owner_user_id, row.id, positiveRevision(row.revision));
            return result.changes > 0;
        } finally {
            encrypted.digest.fill(0);
        }
    }

    revoke(ownerUserId, tokenId, { expectedRevision } = {}) {
        this.ensureReady();
        const owner = String(ownerUserId || '');
        const id = String(tokenId || '');
        return this.db.transaction(() => {
            const row = this.db.prepare('SELECT * FROM encrypted_client_tokens WHERE owner_user_id = ? AND id = ?').get(owner, id);
            if (!row || row.deleted_at != null) throw new TokenStoreError('not_found', 'Client Token not found');
            if (expectedRevision != null && Number(expectedRevision) !== positiveRevision(row.revision)) {
                throw new TokenStoreError('revision_conflict', 'Client Token revision does not match');
            }
            if (!this._revokeRow(row)) throw new TokenStoreError('revision_conflict', 'Client Token revision does not match');
            return true;
        })();
    }

    revokeOwners(ownerUserIds) {
        this.ensureReady();
        const owners = [...new Set((ownerUserIds || []).map(String).filter(Boolean))];
        if (!owners.length) return 0;
        return this.db.transaction(() => {
            let changed = 0;
            for (const owner of owners) {
                const rows = this.db.prepare(`SELECT * FROM encrypted_client_tokens
                    WHERE owner_user_id = ? AND deleted_at IS NULL`).all(owner);
                for (const row of rows) changed += this._revokeRow(row) ? 1 : 0;
            }
            return changed;
        })();
    }

    replaceOwnerTokens({ ownerUserId, name, secret } = {}) {
        this.ensureReady();
        const owner = String(ownerUserId || '');
        return this.db.transaction(() => {
            const rows = this.db.prepare(`SELECT * FROM encrypted_client_tokens
                WHERE owner_user_id = ? AND deleted_at IS NULL`).all(owner);
            for (const row of rows) this._revokeRow(row);
            return this.create({ ownerUserId: owner, name, secret });
        })();
    }

    validate(secret) {
        this.ensureReady();
        if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512) return null;
        const suppliedHash = crypto.createHash('sha256').update(secret, 'utf8').digest();
        try {
            for (const keyEntry of this.keyring.all()) {
                const digest = digestSecret(secret, keyEntry);
                try {
                    const row = this.db.prepare(`SELECT * FROM encrypted_client_tokens
                        WHERE secret_digest = ? AND key_id = ? AND deleted_at IS NULL`).get(digest, keyEntry.id);
                    const currentDigest = storedDigest(row?.secret_digest);
                    if (!row || !currentDigest || !crypto.timingSafeEqual(currentDigest, digest)) continue;
                    const decrypted = this._decrypt(row);
                    const decryptedHash = crypto.createHash('sha256').update(decrypted, 'utf8').digest();
                    const valid = crypto.timingSafeEqual(suppliedHash, decryptedHash);
                    decryptedHash.fill(0);
                    if (!valid) continue;
                    const timestamp = Math.max(Number(row.last_used_at || 0) + 1, Number(this.now()));
                    const touched = this.db.prepare(`UPDATE encrypted_client_tokens SET last_used_at = ?
                        WHERE id = ? AND owner_user_id = ? AND revision = ? AND deleted_at IS NULL`)
                        .run(timestamp, row.id, row.owner_user_id, positiveRevision(row.revision));
                    if (!touched.changes) return null;
                    row.last_used_at = timestamp;
                    return this._row(row, true);
                } finally {
                    digest.fill(0);
                }
            }
            return null;
        } finally {
            suppliedHash.fill(0);
        }
    }

    rotateEncryptionKey() {
        this.ensureReady();
        const keyEntry = this.keyring.rotate();
        const rotated = this.db.transaction(() => {
            const rows = this.db.prepare('SELECT * FROM encrypted_client_tokens').all();
            let count = 0;
            for (const row of rows) {
                const secret = this._decrypt(row);
                const encrypted = this._encrypt(secret, row.owner_user_id, row.id, row.revision, keyEntry);
                try {
                    const digest = row.deleted_at == null ? encrypted.digest : null;
                    this.db.prepare(`UPDATE encrypted_client_tokens SET
                        secret_ciphertext = ?, secret_digest = ?, key_id = ? WHERE id = ?`)
                        .run(encrypted.ciphertext, digest, encrypted.keyId, row.id);
                    count += 1;
                } finally {
                    encrypted.digest.fill(0);
                }
            }
            return count;
        })();
        this.readyDb = null;
        this.ensureReady();
        return { keyId: keyEntry.id, rotated };
    }

    listTokenMetadata(ownerUserId) {
        return this.list(ownerUserId, { includeSecret: false });
    }

    readTokenMetadata(ownerUserId, tokenId, { includeDeleted = false } = {}) {
        return this.read(ownerUserId, tokenId, { includeSecret: false, includeDeleted });
    }

    renameTokenMetadata(ownerUserId, tokenId, name, options = {}) {
        const row = this.rename(ownerUserId, tokenId, name, options);
        delete row.token;
        return row;
    }

    revokeTokenMetadata(ownerUserId, tokenId, options = {}) {
        return this.revoke(ownerUserId, tokenId, options);
    }

    close() {
        if (this.ownedDb) {
            try { this.ownedDb.close(); } finally { this.ownedDb = null; }
        }
        this.readyDb = null;
    }

    // Read-only compatibility seam for migration diagnostics.
    load() {
        const legacy = this._readLegacy();
        if (!legacy) return null;
        return { version: 3, tokens: legacy.records };
    }
}

module.exports = {
    AgentTokenStore,
    ENVELOPE_ALGORITHM,
    ENVELOPE_PREFIX,
    METADATA_SYNC_CONTRACT,
    TokenStoreError,
    aadFor,
};
