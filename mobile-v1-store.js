/**
 * Zephyr One mobile v1: persistence for devices, credentials, the change feed
 * and replay protection.
 *
 * Scope of this module: it owns the tables frozen by DATA_AND_MIGRATION.md
 * section 2 and nothing else. It deliberately does **not** write business rows.
 * SYNC_STATE_MACHINE.md section 6 is explicit that mobile sync may not bypass
 * the canonical Zephyr services, so the push path calls resource-service /
 * notes-service and then records the resulting revision here, inside the same
 * SQLite transaction.
 *
 * Two design points worth stating, because both are easy to get wrong:
 *
 *  - **Access credentials are stateless.** The frozen DDL gives mobile_devices a
 *    `refresh_token_hash` and a `refresh_generation` but defines no access-token
 *    table, and the freeze forbids inventing one. So an access credential is an
 *    HMAC over (deviceId, expiry, generation) rather than a stored row. Bumping
 *    `refresh_generation` therefore invalidates every access credential minted
 *    for the previous generation at once, which is what device revoke and
 *    refresh rotation need.
 *  - **The refresh credential is single-use.** Only its hash is stored, and a
 *    successful refresh replaces the hash and bumps the generation in the same
 *    transaction. Presenting a consumed refresh credential is reported as
 *    `refresh_replayed` rather than a generic 401, because the client has to
 *    stop retrying and rebind instead.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ZEPHYR_DATA_DIR
    ? path.resolve(process.env.ZEPHYR_DATA_DIR)
    : path.join(__dirname, 'data');

/** Signing key for stateless access credentials. Same 0600 handling as secret-crypto.js. */
const HMAC_KEY_FILE = path.join(DATA_DIR, 'crypto', 'mobile-v1-access.key');

/** Frozen by SyncContract: retention for replay protection and tombstones. */
const APPLIED_OP_RETENTION_DAYS = 180;
/** SyncContract.BOOTSTRAP_PAGE_TOKEN_TTL_MINUTES. */
const BOOTSTRAP_TOKEN_TTL_MINUTES = 30;
const BOOTSTRAP_TOKEN_VERSION = 2;
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_BYTES = 32;
const GRANT_TTL_SEC = 5 * 60;
const BIND_ATTEMPT_TTL_SEC = GRANT_TTL_SEC;
const SENSITIVE_VERIFY_WINDOW_MS = 5 * 60 * 1000;
const SENSITIVE_VERIFY_MAX_ATTEMPTS = 10;
const PROOF_NONCE_BYTES = 32;
const PROOF_CHALLENGE_TTL_SEC = 30;
const PROOF_MAX_ACTIVE_PER_DEVICE = 16;
const PROOF_MAX_ISSUES_PER_MINUTE = 120;
const PROOF_RATE_WINDOW_MS = 60 * 1000;

function nowMs() {
    return Date.now();
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function revisionOfDeviceConfig(row, { deviceName, interval, enabled }) {
    const current = Math.max(1, Number(row?.config_revision || 1));
    const changed = String(row?.device_name || '') !== String(deviceName || '')
        || Number(row?.sync_interval_sec || 300) !== Number(interval)
        || (!!row?.enabled && row?.revoked_at == null) !== !!enabled;
    return changed ? current + 1 : current;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

/** Constant-work equality for request-binding fields of different lengths. */
function timingSafeTextEqual(left, right) {
    const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();
    return crypto.timingSafeEqual(digest(left), digest(right));
}

/**
 * Canonical JSON, so a registry hash is stable across key insertion order.
 *
 * The client compares this string on every push (`registry_mismatch`), so an
 * unstable serialisation would spuriously invalidate every bound device.
 */
function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

class MobileStoreError extends Error {
    constructor(code, message, status = 400, extra = {}) {
        super(message);
        this.code = code;
        this.status = status;
        Object.assign(this, extra);
    }
}

class MobileV1Store {
    /**
     * @param {object} opts
     * @param {object} opts.db raw SQLite handle from storage.rawDb()
     * @param {object} opts.entityRegistry parsed contracts/registries/entity-registry.json
     * @param {Function} [opts.log]
     */
    constructor(opts) {
        this.db = opts.db;
        this.entityRegistry = opts.entityRegistry;
        this.log = opts.log || (() => {});
        /* Blob bodies live on the filesystem, not in SQLite. Set the root
         * before schema recovery so legacy upload rows can be reconciled by
         * the async blob manager immediately after construction. */
        this.blobRoot = opts.blobRoot || path.join(DATA_DIR, 'mobile-blobs');
        this.blobLimits = opts.blobLimits || null;
        this._fileSyncConfigService = null;
        this._ensureSchema();
        this._hmacKey = null;
        this.registryHash = sha256(canonicalJson(this.entityRegistry));
    }

    /**
     * Creates the tables from DATA_AND_MIGRATION.md section 2 verbatim.
     *
     * IF NOT EXISTS rather than a numbered migration runner: this product has no
     * migration framework yet, and the spec's own note about not stacking
     * unnumbered addColumnIfMissing calls is about the *business* tables. These
     * are new tables with no legacy shape to reconcile, so creation is
     * idempotent and there is nothing to alter.
     */
    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mobile_devices (
                device_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                owner_username_compat TEXT NOT NULL,
                token_id TEXT NOT NULL,
                device_name TEXT NOT NULL,
                platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
                app_version TEXT NOT NULL,
                encryption_public_key BLOB NOT NULL,
                signing_public_jwk TEXT NOT NULL,
                refresh_token_hash TEXT,
                refresh_generation INTEGER NOT NULL DEFAULT 1,
                enabled INTEGER NOT NULL DEFAULT 1,
                automatic_enabled INTEGER NOT NULL DEFAULT 1,
                sync_interval_sec INTEGER NOT NULL DEFAULT 300,
                config_revision INTEGER NOT NULL DEFAULT 1,
                binding_revision INTEGER NOT NULL DEFAULT 1,
                registry_hash TEXT NOT NULL,
                last_acked_cursor INTEGER NOT NULL DEFAULT 0,
                last_sync_at INTEGER,
                last_seen_at INTEGER,
                created_at INTEGER NOT NULL,
                revoked_at INTEGER,
                revoke_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_devices_owner
                ON mobile_devices(owner_user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_mobile_devices_token
                ON mobile_devices(token_id, revoked_at);

            CREATE TABLE IF NOT EXISTS mobile_device_proof_challenges (
                nonce_hash TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                method TEXT NOT NULL,
                canonical_path TEXT NOT NULL,
                body_sha256 TEXT NOT NULL,
                usage TEXT NOT NULL,
                proof_timestamp INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                consumed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_proof_challenges_device
                ON mobile_device_proof_challenges(device_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_mobile_proof_challenges_expiry
                ON mobile_device_proof_challenges(expires_at, consumed_at);

            CREATE TABLE IF NOT EXISTS mobile_entity_versions (
                owner_user_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                deleted_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(owner_user_id, entity_type, entity_id)
            );

            CREATE TABLE IF NOT EXISTS mobile_entity_field_revisions (
                owner_user_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                field_path TEXT NOT NULL,
                revision INTEGER NOT NULL,
                changed_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(owner_user_id, entity_type, entity_id, field_path)
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_field_revision_entity
                ON mobile_entity_field_revisions(owner_user_id, entity_type, entity_id, revision);

            CREATE TABLE IF NOT EXISTS mobile_sync_changes (
                change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
                revision INTEGER NOT NULL,
                field_mask_json TEXT NOT NULL DEFAULT '[]',
                actor_device_id TEXT,
                changed_at INTEGER NOT NULL,
                tombstone_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_changes_owner_seq
                ON mobile_sync_changes(owner_user_id, change_seq);
            CREATE INDEX IF NOT EXISTS idx_mobile_changes_entity
                ON mobile_sync_changes(owner_user_id, entity_type, entity_id, revision);

            /* The feed cursor is globally monotonic, but retention is scoped to
             * one owner. Keep only the greatest row actually pruned for each
             * owner so foreign sequence gaps can never make a cursor expire. */
            CREATE TABLE IF NOT EXISTS mobile_change_retention (
                owner_user_id TEXT PRIMARY KEY,
                pruned_through_cursor INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            /* Durable, payload-free handoff for a future APNs/FCM wake worker.
             * The worker only needs to know which account advanced to which
             * cursor; entity identifiers and payload fields stay in the sync
             * feed and never enter notification infrastructure. */
            CREATE TABLE IF NOT EXISTS mobile_change_outbox (
                outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
                change_seq INTEGER NOT NULL UNIQUE,
                owner_user_id TEXT NOT NULL,
                through_cursor INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                delivered_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_change_outbox_pending
                ON mobile_change_outbox(delivered_at, outbox_id);

            CREATE TABLE IF NOT EXISTS mobile_applied_ops (
                owner_user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                op_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                result_json TEXT NOT NULL,
                applied_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY(owner_user_id, device_id, op_id)
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_applied_ops_expiry
                ON mobile_applied_ops(expires_at);

            CREATE TABLE IF NOT EXISTS mobile_sync_runs (
                run_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                trigger TEXT NOT NULL,
                state TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                from_cursor INTEGER NOT NULL,
                to_cursor INTEGER,
                pushed INTEGER NOT NULL DEFAULT 0,
                pulled INTEGER NOT NULL DEFAULT 0,
                conflicts INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                request_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_sync_runs_device
                ON mobile_sync_runs(device_id, started_at DESC);

            CREATE TABLE IF NOT EXISTS mobile_sensitive_grants (
                grant_hash TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                target_hash TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                consumed_at INTEGER,
                created_at INTEGER NOT NULL,
                request_id TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_sensitive_grants_expiry
                ON mobile_sensitive_grants(expires_at, consumed_at);

            /* One bind authority is fenced to the credential state that was
             * current when sensitive verification began. Only the nonce hash
             * is durable; the raw receipt never enters SQLite or the feed. */
            CREATE TABLE IF NOT EXISTS mobile_device_bind_attempts (
                attempt_hash TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                token_id TEXT NOT NULL,
                expected_binding_revision INTEGER NOT NULL,
                expected_refresh_generation INTEGER NOT NULL,
                grant_hash TEXT UNIQUE,
                request_fingerprint TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                completed_at INTEGER,
                replay_expires_at INTEGER,
                result_binding_revision INTEGER,
                result_refresh_generation INTEGER,
                request_id TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_bind_attempts_owner_device
                ON mobile_device_bind_attempts(owner_user_id, device_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_mobile_bind_attempts_expiry
                ON mobile_device_bind_attempts(expires_at, replay_expires_at);

            /* Durable per-account limiter for password/TOTP verification. A
             * process restart must not reset an online guessing budget. */
            CREATE TABLE IF NOT EXISTS mobile_sensitive_attempts (
                owner_user_id TEXT PRIMARY KEY,
                window_started_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS mobile_blob_uploads (
                upload_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                size INTEGER NOT NULL,
                mime TEXT NOT NULL,
                chunk_bytes INTEGER NOT NULL,
                chunk_hashes_json TEXT NOT NULL,
                encrypted INTEGER NOT NULL DEFAULT 0,
                received_json TEXT NOT NULL DEFAULT '[]',
                state TEXT NOT NULL CHECK(state IN ('receiving','complete')),
                received_bytes INTEGER NOT NULL DEFAULT 0,
                finalizing_at INTEGER,
                finalize_attempts INTEGER NOT NULL DEFAULT 0,
                failed_at INTEGER,
                failure_code TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_blob_uploads_owner
                ON mobile_blob_uploads(owner_user_id, device_id, sha256);

            CREATE TABLE IF NOT EXISTS mobile_blobs (
                owner_user_id TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                size INTEGER NOT NULL,
                mime TEXT NOT NULL,
                chunk_bytes INTEGER NOT NULL,
                chunk_count INTEGER NOT NULL,
                encrypted INTEGER NOT NULL DEFAULT 0,
                created_by_device_id TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(owner_user_id, sha256)
            );

            /* SQLite deletion and filesystem deletion cannot share one atomic
             * transaction. Keep a payload-free, durable descriptor so blob
             * cleanup is retried after a crash without retaining account data. */
            CREATE TABLE IF NOT EXISTS mobile_user_cleanup_jobs (
                owner_user_id TEXT PRIMARY KEY,
                cleanup_id TEXT NOT NULL UNIQUE,
                upload_ids_json TEXT NOT NULL,
                legacy_files_json TEXT NOT NULL DEFAULT '[]',
                state TEXT NOT NULL CHECK(state IN ('pending','running')),
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error_code TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_user_cleanup_jobs_state
                ON mobile_user_cleanup_jobs(state, updated_at);
        `);
        this._ensureBlobSchemaColumns();
    }

    /** Idempotent upgrade for databases created before blob resource limits. */
    _ensureBlobSchemaColumns() {
        const ensure = (table, column, definition) => {
            const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
            if (!columns.some((candidate) => candidate.name === column)) {
                this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            }
        };
        ensure('mobile_devices', 'config_revision', 'INTEGER NOT NULL DEFAULT 1');
        ensure('mobile_devices', 'binding_revision', 'INTEGER NOT NULL DEFAULT 1');
        ensure('mobile_entity_field_revisions', 'changed_at', 'INTEGER NOT NULL DEFAULT 0');
        ensure('mobile_blob_uploads', 'received_bytes', 'INTEGER NOT NULL DEFAULT 0');
        ensure('mobile_blob_uploads', 'finalizing_at', 'INTEGER');
        ensure('mobile_blob_uploads', 'finalize_attempts', 'INTEGER NOT NULL DEFAULT 0');
        ensure('mobile_blob_uploads', 'failed_at', 'INTEGER');
        ensure('mobile_blob_uploads', 'failure_code', 'TEXT');
        ensure('mobile_blobs', 'created_by_device_id', 'TEXT');
        ensure('mobile_blob_uploads', 'chunk_sizes_json', "TEXT NOT NULL DEFAULT '[]'");
        ensure('mobile_blob_uploads', 'keyed_ids_json', "TEXT NOT NULL DEFAULT '[]'");
        ensure('mobile_blob_uploads', 'chunk_algorithm', "TEXT NOT NULL DEFAULT 'fixed'");
        ensure('mobile_blobs', 'chunk_sizes_json', "TEXT NOT NULL DEFAULT '[]'");
        ensure('mobile_blobs', 'keyed_ids_json', "TEXT NOT NULL DEFAULT '[]'");
        ensure('mobile_blobs', 'chunk_algorithm', "TEXT NOT NULL DEFAULT 'fixed'");
        ensure('mobile_blobs', 'merkle', 'TEXT');
        ensure('mobile_user_cleanup_jobs', 'legacy_files_json', "TEXT NOT NULL DEFAULT '[]'");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mobile_blob_chunks (
                owner_user_id TEXT NOT NULL,
                keyed_id TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(owner_user_id, keyed_id)
            );
            CREATE INDEX IF NOT EXISTS idx_mobile_blob_chunks_owner
                ON mobile_blob_chunks(owner_user_id, sha256);
        `);
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_mobile_blob_uploads_active_owner
                ON mobile_blob_uploads(owner_user_id, state, failed_at, updated_at);
            CREATE INDEX IF NOT EXISTS idx_mobile_blob_uploads_active_device
                ON mobile_blob_uploads(device_id, state, failed_at, updated_at);
            CREATE INDEX IF NOT EXISTS idx_mobile_blobs_creator
                ON mobile_blobs(created_by_device_id, created_at);
        `);

        /* Older rows only recorded indices. Backfill their physical byte count
         * once so disk reservation math does not double-reserve received parts. */
        const legacy = this.db.prepare(`SELECT upload_id, size, chunk_bytes,
            chunk_hashes_json, received_json FROM mobile_blob_uploads
            WHERE received_bytes = 0 AND received_json <> '[]'`).all();
        const update = this.db.prepare('UPDATE mobile_blob_uploads SET received_bytes = ? WHERE upload_id = ?');
        for (const row of legacy) {
            let hashes;
            let received;
            try {
                hashes = JSON.parse(row.chunk_hashes_json);
                received = JSON.parse(row.received_json);
            } catch {
                continue;
            }
            let bytes = 0;
            for (const value of received) {
                const index = Number(value);
                if (!Number.isInteger(index) || index < 0 || index >= hashes.length) continue;
                bytes += index === hashes.length - 1
                    ? Number(row.size) - Number(row.chunk_bytes) * (hashes.length - 1)
                    : Number(row.chunk_bytes);
            }
            update.run(Math.max(0, bytes), row.upload_id);
        }
        this.db.exec(`UPDATE mobile_blobs SET created_by_device_id = (
            SELECT device_id FROM mobile_blob_uploads
            WHERE mobile_blob_uploads.owner_user_id = mobile_blobs.owner_user_id
              AND mobile_blob_uploads.sha256 = mobile_blobs.sha256
              AND mobile_blob_uploads.state = 'complete'
            ORDER BY mobile_blob_uploads.updated_at ASC LIMIT 1
        ) WHERE created_by_device_id IS NULL`);
    }

    // ---------------------------------------------------------------- keys ---

    /**
     * Loads or creates the access-credential signing key.
     *
     * Lazily rather than in the constructor so importing this module never
     * writes to disk; a test that only needs the schema does not create a key.
     */
    _key() {
        if (this._hmacKey) return this._hmacKey;
        const fromEnv = process.env.ZEPHYR_MOBILE_V1_ACCESS_KEY_B64;
        if (fromEnv) {
            this._hmacKey = Buffer.from(fromEnv, 'base64');
            if (this._hmacKey.length < 32) throw new Error('ZEPHYR_MOBILE_V1_ACCESS_KEY_B64 must be >= 32 bytes');
            return this._hmacKey;
        }
        try {
            const raw = JSON.parse(fs.readFileSync(HMAC_KEY_FILE, 'utf8'));
            const key = Buffer.from(String(raw.key || ''), 'base64');
            if (key.length >= 32) {
                this._hmacKey = key;
                return this._hmacKey;
            }
        } catch { /* fall through to generate */ }
        const key = crypto.randomBytes(32);
        fs.mkdirSync(path.dirname(HMAC_KEY_FILE), { recursive: true });
        fs.writeFileSync(
            HMAC_KEY_FILE,
            JSON.stringify({ alg: 'HMAC-SHA256', key: key.toString('base64') }, null, 2) + '\n',
            { mode: 0o600 },
        );
        try { fs.chmodSync(HMAC_KEY_FILE, 0o600); } catch {}
        this._hmacKey = key;
        return key;
    }

    // ------------------------------------------------------------- devices ---

    /** Lazily avoids a module cycle while both account APIs share one writer. */
    _fileSyncConfigs() {
        if (!this._fileSyncConfigService) {
            const { FileSyncConfigService } = require('./file-sync-config-service');
            this._fileSyncConfigService = new FileSyncConfigService({ db: this.db, store: this });
        }
        return this._fileSyncConfigService;
    }

    getDeviceRow(deviceId) {
        return this.db.prepare('SELECT * FROM mobile_devices WHERE device_id = ?').get(String(deviceId || '')) || null;
    }

    listDeviceRows(ownerUserId) {
        return this.db
            .prepare('SELECT * FROM mobile_devices WHERE owner_user_id = ? ORDER BY created_at DESC')
            .all(String(ownerUserId || ''));
    }

    /** Wire shape for the Device schema. Never includes a credential or a key. */
    devicePublic(row) {
        if (!row) return null;
        return {
            deviceId: row.device_id,
            ownerUserId: row.owner_user_id,
            deviceName: row.device_name || '',
            platform: row.platform,
            appVersion: row.app_version || '',
            tokenId: row.token_id,
            enabled: !!row.enabled && !row.revoked_at,
            automaticEnabled: !!row.automatic_enabled,
            syncIntervalSec: Number(row.sync_interval_sec || 300),
            bindingRevision: Number(row.binding_revision || 1),
            lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
            lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
            createdAt: Number(row.created_at || 0),
            revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
        };
    }

    /** Hashes only public bind material; tokenSecret is intentionally absent. */
    static bindRequestFingerprint(input = {}) {
        return sha256(canonicalJson({
            deviceId: String(input.deviceId || '').trim(),
            deviceName: String(input.deviceName || ''),
            platform: String(input.platform || ''),
            appVersion: String(input.appVersion || ''),
            tokenId: String(input.tokenId || '').trim(),
            keys: input.keys || null,
            syncIntervalSec: Number(input.syncIntervalSec),
        }));
    }

    /**
     * Starts a durable, one-time CAS attempt before credential verification.
     * A foreign owner's row is treated as absent here so the receipt cannot be
     * used to discover its revision or credential generation.
     */
    beginBindAttempt({ ownerUserId, deviceId, tokenId, requestId }) {
        const owner = String(ownerUserId || '');
        const id = String(deviceId || '').trim();
        const token = String(tokenId || '').trim();
        if (!owner || id.length < 16 || id.length > 80 || !token || token.length > 256) {
            throw new MobileStoreError('invalid_request', 'bind attempt target is invalid', 400);
        }
        const current = this.getDeviceRow(id);
        const owned = current && timingSafeTextEqual(current.owner_user_id, owner) ? current : null;
        const receipt = crypto.randomBytes(32).toString('base64url');
        const attemptHash = sha256(receipt);
        const createdAt = nowMs();
        const expiresAt = createdAt + BIND_ATTEMPT_TTL_SEC * 1000;
        const expectedBindingRevision = owned ? Number(owned.binding_revision || 1) : 0;
        const expectedRefreshGeneration = owned ? Number(owned.refresh_generation || 1) : 0;
        this.db.prepare(`INSERT INTO mobile_device_bind_attempts
            (attempt_hash, owner_user_id, device_id, token_id, expected_binding_revision,
             expected_refresh_generation, grant_hash, request_fingerprint, created_at, expires_at,
             completed_at, replay_expires_at, result_binding_revision, result_refresh_generation,
             request_id)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)`).run(
            attemptHash, owner, id, token, expectedBindingRevision, expectedRefreshGeneration,
            createdAt, expiresAt, String(requestId || ''),
        );
        return {
            receipt,
            attemptHash,
            ownerUserId: owner,
            deviceId: id,
            tokenId: token,
            expectedBindingRevision,
            expectedRefreshGeneration,
            expiresAt,
        };
    }

    cancelBindAttempt(ownerUserId, attemptHash) {
        this.db.prepare(`DELETE FROM mobile_device_bind_attempts
            WHERE owner_user_id = ? AND attempt_hash = ? AND grant_hash IS NULL AND completed_at IS NULL`)
            .run(String(ownerUserId || ''), String(attemptHash || ''));
    }

    _bindRefreshCredential(attemptHash) {
        return crypto.createHmac('sha256', this._key())
            .update('zephyr-one-bind-refresh-v2\0' + String(attemptHash), 'utf8')
            .digest('base64url');
    }

    _bindingToken(attemptHash, bindingRevision) {
        return crypto.createHmac('sha256', this._key())
            .update(`zephyr-one-binding-token-v2\0${String(attemptHash)}\0${Number(bindingRevision)}`, 'utf8')
            .digest('base64url');
    }

    _bindResult(row, attempt) {
        const bindingRevision = Number(attempt.result_binding_revision || row.binding_revision || 1);
        return {
            row,
            refreshCredential: this._bindRefreshCredential(attempt.attempt_hash),
            ...this.mintAccess(row),
            bindingProtocolVersion: 2,
            bindingRevision,
            bindingToken: this._bindingToken(attempt.attempt_hash, bindingRevision),
            bootstrapRequired: true,
        };
    }

    /** Claims a verified grant and returns either its fresh CAS or prior result. */
    claimBindAttempt({ ownerUserId, deviceId, tokenId, grant, receipt, requestFingerprint }) {
        if (this.db.inTransaction !== true && this.db.isTransaction !== true) {
            throw new Error('claimBindAttempt requires an active SQL transaction');
        }
        const grantHash = sha256(String(grant || ''));
        const owner = String(ownerUserId || '');
        const id = String(deviceId || '');
        const token = String(tokenId || '');
        const targetHash = MobileV1Store.targetHash('device.bind', [token, id]);
        const ts = nowMs();
        if (!/^[0-9a-f]{64}$/.test(String(requestFingerprint || ''))) {
            throw new MobileStoreError('invalid_request', 'bind request fingerprint is invalid', 400);
        }
        const attempt = this.db.prepare(`SELECT a.*,
                g.owner_user_id AS grant_owner_user_id, g.action AS grant_action,
                g.target_hash AS grant_target_hash, g.expires_at AS grant_expires_at,
                g.consumed_at AS grant_consumed_at
            FROM mobile_device_bind_attempts a
            JOIN mobile_sensitive_grants g ON g.grant_hash = a.grant_hash
            WHERE a.grant_hash = ?`).get(grantHash);
        const receiptMatches = !receipt || timingSafeTextEqual(sha256(String(receipt)), attempt?.attempt_hash || '');
        if (!attempt || !receiptMatches
            || !timingSafeTextEqual(attempt.owner_user_id, owner)
            || !timingSafeTextEqual(attempt.device_id, id)
            || !timingSafeTextEqual(attempt.token_id, token)
            || !timingSafeTextEqual(attempt.grant_owner_user_id, owner)
            || attempt.grant_action !== 'device.bind'
            || attempt.grant_target_hash !== targetHash) {
            throw new MobileStoreError('sensitive_verification_required', 'bind verification is required', 403);
        }

        if (attempt.completed_at !== null) {
            if (Number(attempt.replay_expires_at || 0) <= ts) {
                throw new MobileStoreError('sensitive_grant_expired', 'bind receipt has expired', 403);
            }
            if (!timingSafeTextEqual(attempt.request_fingerprint || '', requestFingerprint || '')) {
                throw new MobileStoreError('revision_conflict', 'bind receipt does not match the original request', 409, {
                    details: { reason: 'bind_receipt_mismatch' },
                });
            }
            const row = this.getDeviceRow(id);
            if (!row || row.owner_user_id !== owner
                || Number(row.binding_revision || 1) !== Number(attempt.result_binding_revision)
                || Number(row.refresh_generation || 1) !== Number(attempt.result_refresh_generation)) {
                throw new MobileStoreError('revision_conflict', 'bind attempt was superseded', 409, {
                    details: {
                        reason: 'bind_attempt_stale',
                        expectedBindingRevision: Number(attempt.result_binding_revision || 0),
                        currentBindingRevision: Number(row?.binding_revision || 0),
                        expectedRefreshGeneration: Number(attempt.result_refresh_generation || 0),
                        currentRefreshGeneration: Number(row?.refresh_generation || 0),
                    },
                });
            }
            return { replay: true, attempt, row };
        }

        if (Number(attempt.expires_at) <= ts || Number(attempt.grant_expires_at) <= ts) {
            throw new MobileStoreError('sensitive_grant_expired', 'bind verification has expired', 403);
        }
        if (attempt.grant_consumed_at !== null) {
            throw new MobileStoreError('sensitive_grant_consumed', 'bind verification was already used', 409);
        }
        const consumed = this.db.prepare(`UPDATE mobile_sensitive_grants SET consumed_at = ?
            WHERE grant_hash = ? AND owner_user_id = ? AND action = 'device.bind'
              AND target_hash = ? AND consumed_at IS NULL AND expires_at > ?`).run(
            ts, grantHash, owner, targetHash, ts,
        );
        if (Number(consumed.changes || 0) !== 1) {
            throw new MobileStoreError('sensitive_grant_consumed', 'bind verification was already used', 409);
        }
        const fingerprinted = this.db.prepare(`UPDATE mobile_device_bind_attempts
            SET request_fingerprint = ?
            WHERE attempt_hash = ? AND request_fingerprint IS NULL AND completed_at IS NULL
              AND expires_at > ?`).run(String(requestFingerprint || ''), attempt.attempt_hash, ts);
        if (Number(fingerprinted.changes || 0) !== 1) {
            throw new MobileStoreError('revision_conflict', 'bind attempt changed concurrently', 409, {
                details: { reason: 'bind_attempt_stale' },
            });
        }
        attempt.request_fingerprint = String(requestFingerprint || '');
        return { replay: false, attempt };
    }

    replayBindAttempt(claimed) {
        return this._bindResult(claimed.row, claimed.attempt);
    }

    /**
     * Binds only if the live device row still matches the verified attempt.
     * The conditional UPDATE is the credential boundary: a stale scene can no
     * longer overwrite a newer token, JWK, ML-KEM key or generation.
     */
    bindDevice({ ownerUserId, ownerUsername, deviceId, deviceName, platform, appVersion, tokenId, keys, syncIntervalSec, attempt, requestFingerprint }) {
        if (this.db.inTransaction !== true && this.db.isTransaction !== true) {
            throw new Error('bindDevice requires an active SQL transaction');
        }
        const id = String(deviceId || '').trim();
        if (id.length < 16 || id.length > 80) {
            throw new MobileStoreError('invalid_request', 'deviceId 长度必须在 16..80 字符之间', 400);
        }
        if (platform !== 'android' && platform !== 'ios') {
            throw new MobileStoreError('invalid_request', 'platform 必须为 android 或 ios', 400);
        }
        const encryption = Buffer.from(String(keys?.encryption?.publicKey || ''), 'base64');
        if (encryption.length !== 1184) {
            throw new MobileStoreError('invalid_request', 'ML-KEM-768 公钥必须为 1184 字节', 400);
        }
        if (keys?.signing?.alg !== 'ES256' || !keys?.signing?.jwk) {
            throw new MobileStoreError('invalid_request', 'signing 必须为 ES256 JWK', 400);
        }
        if (!/^[0-9a-f]{64}$/.test(String(requestFingerprint || attempt?.request_fingerprint || ''))) {
            throw new MobileStoreError('invalid_request', 'bind request fingerprint is invalid', 400);
        }
        const owner = String(ownerUserId || '');
        const token = String(tokenId || '');
        if (!attempt || !timingSafeTextEqual(attempt.owner_user_id || attempt.ownerUserId, owner)
            || !timingSafeTextEqual(attempt.device_id || attempt.deviceId, id)
            || !timingSafeTextEqual(attempt.token_id || attempt.tokenId, token)) {
            throw new MobileStoreError('sensitive_verification_required', 'bind attempt is invalid', 403);
        }
        const attemptHash = String(attempt.attempt_hash || attempt.attemptHash || '');
        const expectedBindingRevision = Number(
            attempt.expected_binding_revision ?? attempt.expectedBindingRevision,
        );
        const expectedRefreshGeneration = Number(
            attempt.expected_refresh_generation ?? attempt.expectedRefreshGeneration,
        );
        if (!/^[0-9a-f]{64}$/.test(attemptHash)
            || !Number.isSafeInteger(expectedBindingRevision) || expectedBindingRevision < 0
            || !Number.isSafeInteger(expectedRefreshGeneration) || expectedRefreshGeneration < 0) {
            throw new MobileStoreError('sensitive_verification_required', 'bind attempt is invalid', 403);
        }

        const interval = Math.min(86400, Math.max(30, Number(syncIntervalSec) || 300));
        const existing = this.getDeviceRow(id);
        if (existing && existing.owner_user_id !== owner) {
            throw new MobileStoreError('client_owned_by_other', 'deviceId 已被其他账号绑定', 409);
        }

        const ts = nowMs();
        if (Number(attempt.expires_at || attempt.expiresAt || 0) <= ts) {
            throw new MobileStoreError('sensitive_grant_expired', 'bind attempt has expired', 403);
        }
        const refresh = this._bindRefreshCredential(attemptHash);
        const generation = expectedRefreshGeneration + 1;
        const bindingRevision = expectedBindingRevision + 1;

        const nextDeviceName = String(deviceName || existing?.device_name || 'Zephyr One').slice(0, 120);
        const configRevision = existing
            ? revisionOfDeviceConfig(existing, { deviceName: nextDeviceName, interval, enabled: true })
            : 1;
        this._fileSyncConfigs().runBindingMutation({ ownerUserId: owner, clientId: id }, () => {
            if (existing) {
                const updated = this.db.prepare(`UPDATE mobile_devices SET
                    owner_username_compat = ?, token_id = ?, device_name = ?, platform = ?,
                    app_version = ?, encryption_public_key = ?, signing_public_jwk = ?,
                    refresh_token_hash = ?, refresh_generation = ?, enabled = 1,
                    sync_interval_sec = ?, config_revision = ?, binding_revision = ?,
                    registry_hash = ?, last_seen_at = ?,
                    revoked_at = NULL, revoke_reason = NULL
                    WHERE device_id = ? AND owner_user_id = ?
                      AND binding_revision = ? AND refresh_generation = ?`).run(
                    String(ownerUsername || ''), String(tokenId), nextDeviceName,
                    platform, String(appVersion || '').slice(0, 40), encryption,
                    JSON.stringify(keys.signing.jwk), sha256(refresh), generation,
                    interval, configRevision, bindingRevision, this.registryHash, ts, id,
                    owner, expectedBindingRevision, expectedRefreshGeneration,
                );
                if (Number(updated.changes || 0) !== 1) {
                    const current = this.getDeviceRow(id);
                    throw new MobileStoreError('revision_conflict', 'bind attempt was superseded', 409, {
                        details: {
                            reason: 'bind_attempt_stale',
                            expectedBindingRevision,
                            currentBindingRevision: Number(current?.binding_revision || 0),
                            expectedRefreshGeneration,
                            currentRefreshGeneration: Number(current?.refresh_generation || 0),
                        },
                    });
                }
            } else {
                if (expectedBindingRevision !== 0 || expectedRefreshGeneration !== 0) {
                    throw new MobileStoreError('revision_conflict', 'bind attempt was superseded', 409, {
                        details: {
                            reason: 'bind_attempt_stale',
                            expectedBindingRevision,
                            currentBindingRevision: 0,
                            expectedRefreshGeneration,
                            currentRefreshGeneration: 0,
                        },
                    });
                }
                try {
                    this.db.prepare(`INSERT INTO mobile_devices
                    (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
                     app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
                     refresh_generation, enabled, automatic_enabled, sync_interval_sec, config_revision,
                     binding_revision, registry_hash, last_acked_cursor, last_sync_at, last_seen_at, created_at,
                     revoked_at, revoke_reason)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, ?, 0, NULL, ?, ?, NULL, NULL)`).run(
                    id, owner, String(ownerUsername || ''), String(tokenId),
                    nextDeviceName, platform, String(appVersion || '').slice(0, 40), encryption,
                    JSON.stringify(keys.signing.jwk), sha256(refresh), generation,
                    interval, bindingRevision, this.registryHash, ts, ts,
                    );
                } catch (err) {
                    if (!this.getDeviceRow(id)) throw err;
                    throw new MobileStoreError('revision_conflict', 'bind attempt was superseded', 409, {
                        details: {
                            reason: 'bind_attempt_stale',
                            expectedBindingRevision: 0,
                            currentBindingRevision: Number(this.getDeviceRow(id)?.binding_revision || 0),
                            expectedRefreshGeneration: 0,
                            currentRefreshGeneration: Number(this.getDeviceRow(id)?.refresh_generation || 0),
                        },
                    });
                }
            }
        });

        const row = this.getDeviceRow(id);
        const completed = this.db.prepare(`UPDATE mobile_device_bind_attempts SET
                request_fingerprint = COALESCE(request_fingerprint, ?), completed_at = ?,
                replay_expires_at = ?, result_binding_revision = ?, result_refresh_generation = ?
            WHERE attempt_hash = ? AND owner_user_id = ? AND device_id = ? AND token_id = ?
              AND completed_at IS NULL AND expires_at > ?
              AND expected_binding_revision = ? AND expected_refresh_generation = ?`).run(
            String(requestFingerprint || attempt.request_fingerprint || ''), ts,
            Number(attempt.expires_at || attempt.expiresAt), bindingRevision, generation,
            attemptHash, owner, id, token, ts, expectedBindingRevision, expectedRefreshGeneration,
        );
        if (Number(completed.changes || 0) !== 1) {
            throw new MobileStoreError('revision_conflict', 'bind attempt changed concurrently', 409, {
                details: { reason: 'bind_attempt_stale' },
            });
        }
        return this._bindResult(row, {
            ...attempt,
            attempt_hash: attemptHash,
            result_binding_revision: bindingRevision,
            result_refresh_generation: generation,
        });
    }

    /** Stateless access credential: deviceId.expiresAt.generation.hmac */
    mintAccess(row) {
        const expiresAt = nowMs() + ACCESS_TTL_SEC * 1000;
        const generation = Number(row.refresh_generation || 1);
        const head = [b64url(row.device_id), String(expiresAt), String(generation)].join('.');
        const mac = crypto.createHmac('sha256', this._key()).update(head, 'utf8').digest();
        return { accessCredential: head + '.' + b64url(mac), accessExpiresAt: expiresAt };
    }

    /**
     * Verifies an access credential and returns the live device row.
     *
     * Order matters: the MAC is checked before the database is touched, so an
     * unsigned guess cannot be used to probe which deviceIds exist.
     */
    resolveAccess(credential) {
        const parts = String(credential || '').split('.');
        if (parts.length !== 4) throw new MobileStoreError('app_session_expired', '访问凭据格式无效', 401);
        const head = parts.slice(0, 3).join('.');
        const expected = crypto.createHmac('sha256', this._key()).update(head, 'utf8').digest();
        const given = Buffer.from(parts[3], 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            throw new MobileStoreError('app_session_expired', '访问凭据无效', 401);
        }
        if (Number(parts[1]) <= nowMs()) {
            throw new MobileStoreError('app_session_expired', '访问凭据已过期', 401);
        }
        const deviceId = Buffer.from(parts[0], 'base64url').toString('utf8');
        const row = this.getDeviceRow(deviceId);
        if (!row) throw new MobileStoreError('client_not_found', '设备不存在', 404);
        if (row.revoked_at) throw new MobileStoreError('client_revoked', '设备已被吊销', 403);
        if (!row.enabled) throw new MobileStoreError('client_disabled', '设备同步已禁用', 403);
        /* Generation mismatch means a newer refresh or a rebind has happened, so
         * this credential belongs to a superseded generation. */
        if (Number(parts[2]) !== Number(row.refresh_generation || 1)) {
            throw new MobileStoreError('token_rotated', '关联 Token 已删除，请重新绑定', 401);
        }
        return row;
    }

    /**
     * Single-use refresh. Rotates both the stored hash and the generation.
     *
     * A syntactically valid credential that does not match the stored hash is
     * `refresh_replayed`, not a generic failure: the client must rebind rather
     * than retry, and conflating the two is how a device ends up in a refresh
     * loop that can never succeed.
     */
    rotateRefresh(deviceId, refreshCredential) {
        const row = this.getDeviceRow(deviceId);
        if (!row) throw new MobileStoreError('client_not_found', '设备不存在', 404);
        if (row.revoked_at) throw new MobileStoreError('client_revoked', '设备已被吊销', 403);
        if (!row.enabled) throw new MobileStoreError('client_disabled', '设备同步已禁用', 403);
        const presented = sha256(String(refreshCredential || ''));
        if (!row.refresh_token_hash || presented !== row.refresh_token_hash) {
            throw new MobileStoreError('refresh_replayed', '刷新凭据已被使用，可能存在重放，请重新绑定', 401);
        }
        const next = crypto.randomBytes(REFRESH_BYTES).toString('base64url');
        this.db.prepare(`UPDATE mobile_devices
            SET refresh_token_hash = ?, refresh_generation = refresh_generation + 1, last_seen_at = ?
            WHERE device_id = ?`).run(sha256(next), nowMs(), deviceId);
        const updated = this.getDeviceRow(deviceId);
        return { row: updated, refreshCredential: next, ...this.mintAccess(updated) };
    }

    patchDevice(ownerUserId, deviceId, patch = {}) {
        const row = this.getDeviceRow(deviceId);
        if (!row || row.owner_user_id !== ownerUserId) {
            throw new MobileStoreError('client_not_found', '设备不存在', 404);
        }
        if (row.revoked_at) throw new MobileStoreError('client_revoked', '设备已被吊销', 403);
        this._fileSyncConfigs().update(ownerUserId, deviceId, patch, {
            expectedRevision: patch.expectedRevision ?? patch.baseRevision,
        });
        return this.getDeviceRow(deviceId);
    }

    /**
     * Revokes a device.
     *
     * The refresh hash is cleared and the generation bumped in the same
     * statement, which is what makes every outstanding access credential for
     * this device stop verifying immediately rather than at its own expiry.
     */
    revokeDevice(ownerUserId, deviceId, reason = 'revoked_by_user') {
        const row = this.getDeviceRow(deviceId);
        if (!row || row.owner_user_id !== ownerUserId) {
            throw new MobileStoreError('client_not_found', '设备不存在', 404);
        }
        this._fileSyncConfigs().revoke(ownerUserId, deviceId, reason);
        return true;
    }

    touchDevice(deviceId, { appVersion } = {}) {
        this.db.prepare('UPDATE mobile_devices SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE device_id = ?')
            .run(nowMs(), appVersion ? String(appVersion).slice(0, 40) : null, deviceId);
    }

    // ------------------------------------------------------ device proof ---

    /**
     * Issues a server-generated request challenge bound to one device and one
     * exact data-plane request. Only the nonce hash is persisted.
     */
    issueProofChallenge({ ownerUserId, deviceId, method, canonicalPath, bodySha256, usage }) {
        const createdAt = nowMs();
        const expiresAt = createdAt + PROOF_CHALLENGE_TTL_SEC * 1000;
        const timestamp = Math.floor(createdAt / 1000);
        const nonce = crypto.randomBytes(PROOF_NONCE_BYTES).toString('base64url');
        const nonceHash = sha256(nonce);

        const tx = this.db.transaction(() => {
            this.gcProofChallenges(createdAt);
            const active = this.db.prepare(`SELECT COUNT(*) AS count
                FROM mobile_device_proof_challenges
                WHERE device_id = ? AND consumed_at IS NULL AND expires_at >= ?`)
                .get(String(deviceId), createdAt);
            const recent = this.db.prepare(`SELECT COUNT(*) AS count
                FROM mobile_device_proof_challenges
                WHERE device_id = ? AND created_at >= ?`)
                .get(String(deviceId), createdAt - PROOF_RATE_WINDOW_MS);
            if (Number(active?.count || 0) >= PROOF_MAX_ACTIVE_PER_DEVICE
                || Number(recent?.count || 0) >= PROOF_MAX_ISSUES_PER_MINUTE) {
                throw new MobileStoreError('rate_limited', '设备证明 challenge 请求过于频繁', 429, {
                    retryable: true,
                });
            }
            this.db.prepare(`INSERT INTO mobile_device_proof_challenges
                (nonce_hash, owner_user_id, device_id, method, canonical_path,
                 body_sha256, usage, proof_timestamp, created_at, expires_at, consumed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
                nonceHash,
                String(ownerUserId),
                String(deviceId),
                String(method),
                String(canonicalPath),
                String(bodySha256),
                String(usage),
                timestamp,
                createdAt,
                expiresAt,
            );
        });
        tx();
        return { nonce, timestamp, expiresAt };
    }

    /**
     * Atomically spends a challenge only when every server-derived binding
     * matches. Concurrent copies race on one conditional UPDATE; exactly one
     * can observe a changed row.
     */
    consumeProofChallenge({ nonce, ownerUserId, deviceId, method, canonicalPath, bodySha256, usage, timestamp }) {
        const consumedAt = nowMs();
        const nonceHash = sha256(String(nonce || ''));
        const tx = this.db.transaction(() => {
            const row = this.db.prepare(`SELECT * FROM mobile_device_proof_challenges
                WHERE nonce_hash = ?`).get(nonceHash);
            const candidate = row || {
                owner_user_id: '', device_id: '', method: '', canonical_path: '',
                body_sha256: '', usage: '', proof_timestamp: -1,
            };
            const matches = [
                timingSafeTextEqual(candidate.owner_user_id, ownerUserId),
                timingSafeTextEqual(candidate.device_id, deviceId),
                timingSafeTextEqual(candidate.method, method),
                timingSafeTextEqual(candidate.canonical_path, canonicalPath),
                timingSafeTextEqual(candidate.body_sha256, bodySha256),
                timingSafeTextEqual(candidate.usage, usage),
                timingSafeTextEqual(candidate.proof_timestamp, timestamp),
            ].every(Boolean);
            if (!row || !matches || Number(row.expires_at) < consumedAt || row.consumed_at != null) {
                return false;
            }
            const result = this.db.prepare(`UPDATE mobile_device_proof_challenges
                SET consumed_at = ?
                WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at >= ?`)
                .run(consumedAt, nonceHash, consumedAt);
            return Number(result.changes || 0) === 1;
        });
        return tx();
    }

    /** Opportunistic bounded-retention cleanup used by every issuance. */
    gcProofChallenges(referenceTime = nowMs()) {
        const cutoff = Number(referenceTime) - PROOF_RATE_WINDOW_MS;
        const result = this.db.prepare(`DELETE FROM mobile_device_proof_challenges
            WHERE created_at < ? AND (consumed_at IS NOT NULL OR expires_at < ?)`)
            .run(cutoff, Number(referenceTime));
        return Number(result.changes || 0);
    }

    markSynced(deviceId, cursor) {
        this.db.prepare('UPDATE mobile_devices SET last_sync_at = ?, last_acked_cursor = ? WHERE device_id = ?')
            .run(nowMs(), Number(cursor) || 0, deviceId);
    }

    // -------------------------------------------------------- change feed ---

    latestCursor(ownerUserId) {
        const owner = String(ownerUserId || '');
        const row = this.db
            .prepare('SELECT MAX(change_seq) AS seq FROM mobile_sync_changes WHERE owner_user_id = ?')
            .get(owner);
        return Math.max(Number(row?.seq || 0), this.prunedThroughCursor(owner));
    }

    oldestCursor(ownerUserId) {
        const row = this.db
            .prepare('SELECT MIN(change_seq) AS seq FROM mobile_sync_changes WHERE owner_user_id = ?')
            .get(String(ownerUserId || ''));
        return Number(row?.seq || 0);
    }

    prunedThroughCursor(ownerUserId) {
        const row = this.db.prepare(`SELECT pruned_through_cursor AS seq
            FROM mobile_change_retention WHERE owner_user_id = ?`)
            .get(String(ownerUserId || ''));
        return Number(row?.seq || 0);
    }

    /**
     * Appends one change row. Must be called inside the caller's transaction so
     * the business write and the feed entry commit together.
     */
    appendChange({ ownerUserId, entityType, entityId, action, revision, fieldMask, actorDeviceId, tombstone }) {
        const owner = String(ownerUserId);
        const type = String(entityType);
        const id = String(entityId);
        const logicalRevision = Number(revision) || 1;
        const existing = this.db.prepare(`SELECT * FROM mobile_sync_changes
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?
              AND action = ? AND revision = ?
            ORDER BY change_seq DESC LIMIT 1`).get(owner, type, id, action, logicalRevision);
        if (existing) {
            /* Re-delivery inside the same owner partition may enrich the same
             * logical revision with its device actor and exact field mask.
             * The owner-scoped lookup and owner+sequence UPDATE are both
             * required: ids and revisions are not globally unique. */
            const nextMask = action === 'upsert' && Array.isArray(fieldMask)
                ? JSON.stringify(fieldMask.map(String))
                : existing.field_mask_json;
            const nextActor = actorDeviceId ? String(actorDeviceId) : existing.actor_device_id;
            const nextTombstone = tombstone ? JSON.stringify(tombstone) : existing.tombstone_json;
            this.db.prepare(`UPDATE mobile_sync_changes
                SET field_mask_json = ?, actor_device_id = ?, tombstone_json = ?
                WHERE owner_user_id = ? AND change_seq = ?`).run(
                nextMask,
                nextActor || null,
                nextTombstone || null,
                owner,
                Number(existing.change_seq),
            );
            this._enqueueWake(owner, Number(existing.change_seq));
            return Number(existing.change_seq);
        }
        const info = this.db.prepare(`INSERT INTO mobile_sync_changes
            (owner_user_id, entity_type, entity_id, action, revision, field_mask_json,
             actor_device_id, changed_at, tombstone_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            owner, type, id, action,
            logicalRevision, JSON.stringify(Array.isArray(fieldMask) ? fieldMask.map(String) : []),
            actorDeviceId ? String(actorDeviceId) : null, nowMs(),
            tombstone ? JSON.stringify(tombstone) : null,
        );
        const changeSeq = Number(info.lastInsertRowid);
        this._enqueueWake(owner, changeSeq);
        return changeSeq;
    }

    _enqueueWake(ownerUserId, changeSeq) {
        this.db.prepare(`INSERT INTO mobile_change_outbox
            (change_seq, owner_user_id, through_cursor, created_at, delivered_at)
            VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(change_seq) DO NOTHING`).run(
            Number(changeSeq), String(ownerUserId), Number(changeSeq), nowMs(),
        );
    }

    /**
     * Payload-free events for a future wake transport. No entity type, entity
     * id, field mask, tombstone or user content crosses this boundary.
     */
    wakeOutboxPage(limit = 100) {
        const size = Math.max(1, Math.min(1000, Number(limit) || 100));
        return this.db.prepare(`SELECT outbox_id, owner_user_id, through_cursor, created_at
            FROM mobile_change_outbox WHERE delivered_at IS NULL
            ORDER BY outbox_id ASC LIMIT ?`).all(size).map((row) => ({
            outboxId: Number(row.outbox_id),
            ownerUserId: row.owner_user_id,
            throughCursor: Number(row.through_cursor),
            createdAt: Number(row.created_at),
        }));
    }

    ackWakeOutbox(outboxIds) {
        const ids = [...new Set((outboxIds || []).map(Number).filter(Number.isSafeInteger))];
        if (!ids.length) return 0;
        const stmt = this.db.prepare(`UPDATE mobile_change_outbox
            SET delivered_at = ? WHERE outbox_id = ? AND delivered_at IS NULL`);
        let changed = 0;
        const tx = this.db.transaction(() => {
            for (const id of ids) changed += Number(stmt.run(nowMs(), id).changes || 0);
        });
        tx();
        return changed;
    }

    setEntityVersion({ ownerUserId, entityType, entityId, revision, deletedAt = null }) {
        this.db.prepare(`INSERT INTO mobile_entity_versions
            (owner_user_id, entity_type, entity_id, revision, deleted_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, entity_type, entity_id)
            DO UPDATE SET revision = excluded.revision, deleted_at = excluded.deleted_at,
                          updated_at = excluded.updated_at`).run(
            String(ownerUserId), String(entityType), String(entityId),
            Number(revision) || 1, deletedAt, nowMs(),
        );
    }

    getEntityVersion(ownerUserId, entityType, entityId) {
        return this.db.prepare(`SELECT * FROM mobile_entity_versions
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?`)
            .get(String(ownerUserId), String(entityType), String(entityId)) || null;
    }

    /**
     * Last revision that actually mutated this field. Envelope AAD is bound to
     * that number, not the entity revision: a later name/host edit must not
     * reseal the password under a new AAD or One cannot open it.
     */
    fieldRevision(ownerUserId, entityType, entityId, fieldPath) {
        const row = this.db.prepare(`SELECT revision FROM mobile_entity_field_revisions
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND field_path = ?`)
            .get(String(ownerUserId), String(entityType), String(entityId), String(fieldPath));
        const revision = row && Number(row.revision);
        return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
    }

    /** Field-level revisions: the data SYNC_STATE_MACHINE.md section 7 merges on. */
    setFieldRevisions({ ownerUserId, entityType, entityId, fields, revision, changedAt }) {
        const writtenAt = Number(changedAt);
        const stampedAt = Number.isSafeInteger(writtenAt) && writtenAt > 0 ? writtenAt : nowMs();
        const stmt = this.db.prepare(`INSERT INTO mobile_entity_field_revisions
            (owner_user_id, entity_type, entity_id, field_path, revision, changed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, entity_type, entity_id, field_path)
            DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at`);
        for (const field of fields || []) {
            stmt.run(
                String(ownerUserId),
                String(entityType),
                String(entityId),
                String(field),
                Number(revision) || 1,
                stampedAt,
            );
        }
    }

    /**
     * Wall-clock write times for last-write-wins on overlapping fields.
     *
     * Revision numbers only order writes that already serialized on this
     * server. Concurrent edits from two devices share no such order, so the
     * later `clientModifiedAt` / canonical `changedAt` has to break the tie.
     */
    fieldWriteTimes(ownerUserId, entityType, entityId) {
        const rows = this.db.prepare(`SELECT field_path, changed_at FROM mobile_entity_field_revisions
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?`)
            .all(String(ownerUserId), String(entityType), String(entityId));
        const times = new Map();
        for (const row of rows) times.set(String(row.field_path), Number(row.changed_at) || 0);
        return times;
    }

    fieldRevisions(ownerUserId, entityType, entityId) {
        const rows = this.db.prepare(`SELECT field_path, revision FROM mobile_entity_field_revisions
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?`)
            .all(String(ownerUserId), String(entityType), String(entityId));
        const map = new Map();
        for (const row of rows) map.set(row.field_path, Number(row.revision) || 0);
        return map;
    }

    /**
     * Decodes change rows into the wire shape the client parses.
     *
     * Kept here rather than in the route so the tombstone/payload split is
     * decided in one place: a delete must never carry a payload, and an upsert
     * must always carry a fieldMask, which is what SyncChange's schema requires.
     * Secret material is deliberately absent - envelopes are produced per
     * target device by the caller, never stored in the feed.
     */
    decodeChange(row) {
        const change = {
            changeSeq: Number(row.change_seq),
            entityType: row.entity_type,
            entityId: row.entity_id,
            action: row.action,
            revision: Number(row.revision) || 1,
            actorDeviceId: row.actor_device_id || null,
            changedAt: Number(row.changed_at) || 0,
        };
        if (row.action === 'delete') {
            try {
                change.tombstone = row.tombstone_json ? JSON.parse(row.tombstone_json) : null;
            } catch {
                change.tombstone = null;
            }
        } else {
            try {
                change.fieldMask = JSON.parse(row.field_mask_json || '[]');
            } catch {
                change.fieldMask = [];
            }
        }
        return change;
    }

    /**
     * One page of the change feed, already decoded.
     *
     * `hasMore` is computed by asking for one row beyond the limit rather than
     * by comparing against MAX(change_seq): a concurrent write between the two
     * queries would otherwise report hasMore=false and strand the device until
     * its next scheduled round.
     */
    changePage(ownerUserId, sinceCursor, limit) {
        const size = Math.max(1, Math.min(1000, Number(limit) || 200));
        const from = Number(sinceCursor) || 0;
        const rows = this.db.prepare(`SELECT * FROM mobile_sync_changes
            WHERE owner_user_id = ? AND change_seq > ?
            ORDER BY change_seq ASC LIMIT ?`)
            .all(String(ownerUserId || ''), from, size + 1);
        const hasMore = rows.length > size;
        const page = hasMore ? rows.slice(0, size) : rows;
        return {
            fromCursor: from,
            nextCursor: page.length ? Number(page[page.length - 1].change_seq) : from,
            hasMore,
            changes: page.map((row) => this.decodeChange(row)),
        };
    }

    /**
     * Field-level overlap test from SYNC_STATE_MACHINE.md section 7.
     *
     * An incoming edit conflicts when any field it names has moved *after* the
     * revision the client based its edit on. Comparing whole-entity revisions
     * instead would reject every concurrent edit to a different field, which is
     * precisely the false conflict field revisions exist to avoid.
     */
    hasOverlap(ownerUserId, entityType, entityId, baseRevision, fieldMask) {
        const revisions = this.fieldRevisions(ownerUserId, entityType, entityId);
        const base = Number(baseRevision) || 0;
        for (const field of fieldMask || []) {
            if ((revisions.get(String(field)) || 0) > base) return true;
        }
        return false;
    }

    /** True when this owner had an unseen change that retention removed. */
    isCursorExpired(ownerUserId, cursor) {
        const from = Number(cursor) || 0;
        const prunedThrough = this.prunedThroughCursor(ownerUserId);
        return prunedThrough > 0 && from < prunedThrough;
    }

    /**
     * Retention GC for the change feed (section 10, frozen at 180 days).
     *
     * Deliberately not bounded by any device's acked cursor: a device that has
     * been offline past the retention window is told to bootstrap by
     * [isCursorExpired], which is a recoverable state, whereas holding the feed
     * forever for one dead device is not.
     */
    pruneChangesBefore(ownerUserId, beforeSeq) {
        const owner = String(ownerUserId || '');
        const before = Number(beforeSeq) || 0;
        const prune = this.db.transaction(() => {
            const doomed = this.db.prepare(`SELECT MAX(change_seq) AS seq
                FROM mobile_sync_changes WHERE owner_user_id = ? AND change_seq < ?`)
                .get(owner, before);
            const prunedThrough = Number(doomed?.seq || 0);
            if (!prunedThrough) return 0;

            const info = this.db.prepare(`DELETE FROM mobile_sync_changes
                WHERE owner_user_id = ? AND change_seq < ?`).run(owner, before);
            this.db.prepare(`INSERT INTO mobile_change_retention
                (owner_user_id, pruned_through_cursor, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(owner_user_id) DO UPDATE SET
                    pruned_through_cursor = MAX(
                        mobile_change_retention.pruned_through_cursor,
                        excluded.pruned_through_cursor
                    ),
                    updated_at = excluded.updated_at`).run(owner, prunedThrough, nowMs());
            return Number(info.changes || 0);
        });
        return prune();
    }

    // -------------------------------------------------- bootstrap tokens ---

    /*
     * A bootstrap page token is server state the client only echoes back.
     *
     * HMAC-signed rather than stored in a table: the token carries the whole
     * cursor (bootstrapId, snapshot cursor, type order, per-type upper bounds
     * and the last stable entity id), so an
     * interrupted bootstrap resumes without the server keeping per-attempt rows
     * that would then need their own GC. Signing is what stops a client from
     * editing the keyset cursor to skip pages or from lifting another account's token,
     * and the TTL is what stops a token from outliving the snapshot it names.
     */
    /**
     * Signs an arbitrary short-lived payload under a namespace.
     *
     * Generic on purpose: the shared-resource plane needs a relay credential
     * that is bound to one session and one device and expires on its own, and
     * inventing a second ad-hoc signing scheme for it would be a second place
     * to get constant-time comparison and expiry wrong. The namespace is inside
     * the MAC input, so a token minted for one purpose cannot be presented for
     * another even though both use the same server key.
     */
    // ------------------------------------------------------------- blobs ---

    /**
     * Blob transfers (SYNC_STATE_MACHINE.md section 11).
     *
     * Entities never carry large bodies in their JSON payload; they carry a
     * content-addressed manifest (sha256, size, mime, per-chunk hashes) and the
     * bytes move through these methods instead. Uploads are resumable by
     * construction: the uploadId is stable for (owner, device, sha256), chunk
     * indices are idempotent, and a reconnect re-asks for the missing set
     * rather than starting over.
     */
    _blobFile(ownerUserId, digest) {
        const value = String(digest || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(value)) throw new MobileStoreError('invalid_request', 'invalid blob digest', 400);
        return path.join(this.blobOwnerDirectory(ownerUserId), value + '.blob');
    }

    _uploadChunkDir(uploadId) {
        const value = String(uploadId || '');
        if (!/^upl_[0-9a-f]{32}$/.test(value)) throw new MobileStoreError('invalid_request', 'invalid upload id', 400);
        return path.join(this.blobRoot, '_uploads', value);
    }

    blobFilePath(row) {
        return this._blobFile(row.owner_user_id, row.sha256);
    }

    uploadChunkDir(uploadId) {
        return this._uploadChunkDir(uploadId);
    }

    blobOwnerDirectory(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner || owner.length > 256) {
            throw new MobileStoreError('invalid_request', 'invalid blob owner', 400);
        }
        /* A digest avoids case folding, trailing-dot/space and Unicode
         * normalization collisions on Windows and macOS filesystems. */
        const segment = 'u-' + crypto.createHash('sha256').update(owner, 'utf8').digest('hex');
        const root = path.resolve(this.blobRoot);
        const directory = path.resolve(root, segment);
        if (path.dirname(directory) !== root) {
            throw new MobileStoreError('invalid_request', 'invalid blob owner', 400);
        }
        return directory;
    }

    legacyBlobOwnerDirectory(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner || owner.length > 256) return null;
        const segment = encodeURIComponent(owner);
        if (!segment || segment === '.' || segment === '..'
            || ['_uploads', '_cleanup'].includes(segment.toLowerCase())
            || /[\\/]/.test(segment)) return null;
        const root = path.resolve(this.blobRoot);
        const directory = path.resolve(root, segment);
        return path.dirname(directory) === root ? directory : null;
    }

    listBlobsForLegacyMigration() {
        return this.db.prepare(`SELECT owner_user_id, sha256, size FROM mobile_blobs
            ORDER BY owner_user_id, sha256`).all();
    }

    _readBlobFile(row) {
        const current = this._blobFile(row.owner_user_id, row.sha256);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isFile() && !stat.isSymbolicLink()) return current;
        } catch {}
        const legacyDirectory = this.legacyBlobOwnerDirectory(row.owner_user_id);
        if (!legacyDirectory) return current;
        try {
            const directoryStat = fs.lstatSync(legacyDirectory);
            const legacy = path.join(legacyDirectory, String(row.sha256).toLowerCase() + '.blob');
            const fileStat = fs.lstatSync(legacy);
            if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
                && fileStat.isFile() && !fileStat.isSymbolicLink()) return legacy;
        } catch {}
        return current;
    }

    /**
     * Removes all Mobile V1 authority and sync state for one immutable user id.
     * The caller may already own a wider account-deletion transaction; when it
     * does not, this method supplies its own transaction.
     */
    deleteUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner || owner.length > 256) throw new TypeError('mobile cleanup owner is required');
        /* Validate the future disk descriptor before touching credentials. */
        this.blobOwnerDirectory(owner);
        const execute = () => {
            const uploads = this.db.prepare(`SELECT upload_id FROM mobile_blob_uploads
                WHERE owner_user_id = ? ORDER BY upload_id ASC`).all(owner)
                .map((row) => String(row.upload_id));
            if (uploads.some((uploadId) => !/^upl_[0-9a-f]{32}$/.test(uploadId))) {
                throw new Error('mobile cleanup descriptor is invalid');
            }
            const legacyFiles = [
                ...this.db.prepare(`SELECT sha256 FROM mobile_blobs
                    WHERE owner_user_id = ? ORDER BY sha256`).all(owner)
                    .map((row) => String(row.sha256).toLowerCase() + '.blob'),
                ...this.db.prepare(`SELECT sha256, upload_id FROM mobile_blob_uploads
                    WHERE owner_user_id = ? ORDER BY upload_id`).all(owner)
                    .map((row) => `${String(row.sha256).toLowerCase()}.blob.tmp-${String(row.upload_id)}`),
            ];
            const validLegacyFile = /^[0-9a-f]{64}\.blob(?:\.tmp-upl_[0-9a-f]{32})?$/;
            if (legacyFiles.some((file) => !validLegacyFile.test(file))) {
                throw new Error('mobile cleanup descriptor is invalid');
            }
            const previous = this.db.prepare(`SELECT cleanup_id, upload_ids_json, legacy_files_json
                FROM mobile_user_cleanup_jobs WHERE owner_user_id = ?`).get(owner);
            let previousUploads = [];
            let previousLegacyFiles = [];
            if (previous) {
                if (!/^del_[0-9a-f]{32}$/.test(String(previous.cleanup_id || ''))) {
                    throw new Error('mobile cleanup descriptor is invalid');
                }
                try { previousUploads = JSON.parse(previous.upload_ids_json); } catch {
                    throw new Error('mobile cleanup descriptor is invalid');
                }
                if (!Array.isArray(previousUploads)
                    || previousUploads.some((uploadId) => !/^upl_[0-9a-f]{32}$/.test(String(uploadId)))) {
                    throw new Error('mobile cleanup descriptor is invalid');
                }
                try { previousLegacyFiles = JSON.parse(previous.legacy_files_json); } catch {
                    throw new Error('mobile cleanup descriptor is invalid');
                }
                if (!Array.isArray(previousLegacyFiles)
                    || previousLegacyFiles.some((file) => !validLegacyFile.test(String(file)))) {
                    throw new Error('mobile cleanup descriptor is invalid');
                }
            }
            const uploadIds = [...new Set([...previousUploads, ...uploads]
                .map(String).filter((uploadId) => /^upl_[0-9a-f]{32}$/.test(uploadId)))].sort();
            const legacyCleanupFiles = [...new Set([...previousLegacyFiles, ...legacyFiles].map(String))].sort();
            const cleanupId = /^del_[0-9a-f]{32}$/.test(String(previous?.cleanup_id || ''))
                ? String(previous.cleanup_id)
                : 'del_' + crypto.randomBytes(16).toString('hex');
            const timestamp = nowMs();

            /* Delete credentials first. A transaction failure rolls every row
             * back, so an account is never left partly revoked and usable. */
            for (const table of [
                'mobile_device_proof_challenges',
                'mobile_device_bind_attempts',
                'mobile_devices',
                'mobile_sensitive_grants',
                'mobile_sensitive_attempts',
                'mobile_applied_ops',
                'mobile_sync_runs',
                'mobile_entity_field_revisions',
                'mobile_entity_versions',
                'mobile_change_outbox',
                'mobile_sync_changes',
                'mobile_change_retention',
                'mobile_blob_uploads',
                'mobile_blobs',
            ]) {
                this.db.prepare(`DELETE FROM ${table} WHERE owner_user_id = ?`).run(owner);
            }
            const hasLegacyClients = this.db.prepare(`SELECT 1 AS present FROM sqlite_master
                WHERE type = 'table' AND name = 'one_clients'`).get();
            if (hasLegacyClients) {
                this.db.prepare('DELETE FROM one_clients WHERE owner_user_id = ?').run(owner);
            }
            this.db.prepare(`INSERT INTO mobile_user_cleanup_jobs
                (owner_user_id, cleanup_id, upload_ids_json, legacy_files_json, state, attempts,
                 last_error_code, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
                ON CONFLICT(owner_user_id) DO UPDATE SET
                    cleanup_id = excluded.cleanup_id,
                    upload_ids_json = excluded.upload_ids_json,
                    legacy_files_json = excluded.legacy_files_json,
                    state = 'pending',
                    last_error_code = NULL,
                    updated_at = excluded.updated_at`).run(
                    owner, cleanupId, JSON.stringify(uploadIds), JSON.stringify(legacyCleanupFiles),
                    timestamp, timestamp,
                );
            return { ownerUserId: owner, cleanupId, uploadIds, legacyFiles: legacyCleanupFiles };
        };
        return this.db.inTransaction ? execute() : this.db.transaction(execute)();
    }

    listUserCleanupJobs(ownerUserId = null) {
        const rows = ownerUserId == null
            ? this.db.prepare(`SELECT * FROM mobile_user_cleanup_jobs
                ORDER BY created_at ASC`).all()
            : this.db.prepare(`SELECT * FROM mobile_user_cleanup_jobs
                WHERE owner_user_id = ? ORDER BY created_at ASC`).all(String(ownerUserId));
        return rows.map((row) => {
            let uploadIds = [];
            let legacyFiles = [];
            let invalidDescriptor = false;
            try { uploadIds = JSON.parse(row.upload_ids_json); } catch { invalidDescriptor = true; }
            try { legacyFiles = JSON.parse(row.legacy_files_json); } catch { invalidDescriptor = true; }
            if (!Array.isArray(uploadIds)
                || uploadIds.some((value) => !/^upl_[0-9a-f]{32}$/.test(String(value)))) {
                invalidDescriptor = true;
            }
            if (!Array.isArray(legacyFiles)
                || legacyFiles.some((value) => !/^[0-9a-f]{64}\.blob(?:\.tmp-upl_[0-9a-f]{32})?$/.test(String(value)))) {
                invalidDescriptor = true;
            }
            if (!/^del_[0-9a-f]{32}$/.test(String(row.cleanup_id || ''))) invalidDescriptor = true;
            return {
                ownerUserId: String(row.owner_user_id),
                cleanupId: String(row.cleanup_id),
                uploadIds: Array.isArray(uploadIds)
                    ? uploadIds.map(String)
                    : [],
                legacyFiles: Array.isArray(legacyFiles) ? legacyFiles.map(String) : [],
                invalidDescriptor,
                state: String(row.state),
                attempts: Number(row.attempts || 0),
                lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
            };
        });
    }

    beginUserCleanupJob(cleanupId) {
        return Number(this.db.prepare(`UPDATE mobile_user_cleanup_jobs
            SET state = 'running', attempts = attempts + 1, updated_at = ?
            WHERE cleanup_id = ?`).run(nowMs(), String(cleanupId)).changes || 0);
    }

    deferUserCleanupJob(cleanupId, code = 'server_unavailable') {
        const safeCode = ['invalid_cleanup_descriptor', 'awaiting_cleanup_confirmation'].includes(code)
            ? code
            : 'server_unavailable';
        return Number(this.db.prepare(`UPDATE mobile_user_cleanup_jobs
            SET state = 'pending', last_error_code = ?, updated_at = ?
            WHERE cleanup_id = ?`).run(
                safeCode,
                nowMs(),
                String(cleanupId),
            ).changes || 0);
    }

    completeUserCleanupJob(cleanupId) {
        return Number(this.db.prepare('DELETE FROM mobile_user_cleanup_jobs WHERE cleanup_id = ?')
            .run(String(cleanupId)).changes || 0);
    }

    getBlob(ownerUserId, digest) {
        return this.db.prepare('SELECT * FROM mobile_blobs WHERE owner_user_id = ? AND sha256 = ?')
            .get(String(ownerUserId), String(digest)) || null;
    }

    getBlobUpload(uploadId) {
        return this.db.prepare('SELECT * FROM mobile_blob_uploads WHERE upload_id = ?')
            .get(String(uploadId || '')) || null;
    }

    findResumableBlobUpload(ownerUserId, deviceId, digest) {
        return this.db.prepare(`SELECT * FROM mobile_blob_uploads
            WHERE owner_user_id = ? AND device_id = ? AND sha256 = ?
              AND state = 'receiving' AND failed_at IS NULL
            ORDER BY created_at DESC LIMIT 1`).get(
            String(ownerUserId), String(deviceId), String(digest),
        ) || null;
    }

    parseBlobChunkSizes(row) {
        try {
            const sizes = JSON.parse(row.chunk_sizes_json || '[]');
            if (Array.isArray(sizes) && sizes.length) return sizes.map(Number);
        } catch { /* fall through to fixed-size reconstruction */ }
        const hashes = JSON.parse(row.chunk_hashes_json);
        const chunkBytes = Number(row.chunk_bytes);
        return hashes.map((_, index) => (
            index === hashes.length - 1
                ? Number(row.size) - chunkBytes * (hashes.length - 1)
                : chunkBytes
        ));
    }

    knownKeyedChunkIds(ownerUserId, keyedIds) {
        const ids = [...new Set((keyedIds || []).map(String).filter(Boolean))];
        if (!ids.length) return new Set();
        const found = new Set();
        const stmt = this.db.prepare(
            'SELECT keyed_id FROM mobile_blob_chunks WHERE owner_user_id = ? AND keyed_id = ?',
        );
        for (const id of ids) {
            const row = stmt.get(String(ownerUserId), id);
            if (row) found.add(id);
        }
        return found;
    }

    rememberKeyedChunks(ownerUserId, chunks) {
        const now = nowMs();
        const stmt = this.db.prepare(`INSERT OR IGNORE INTO mobile_blob_chunks
            (owner_user_id, keyed_id, sha256, size, created_at) VALUES (?, ?, ?, ?, ?)`);
        for (const chunk of chunks || []) {
            if (!chunk?.keyedId || !chunk?.sha256) continue;
            stmt.run(String(ownerUserId), String(chunk.keyedId), String(chunk.sha256), Number(chunk.size) || 0, now);
        }
    }

    /** The status shape every blob endpoint speaks: received/missing indices. */
    blobUploadStatus(row) {
        const chunkHashes = JSON.parse(row.chunk_hashes_json);
        const received = JSON.parse(row.received_json).map(Number);
        const have = new Set(received);
        const missing = [];
        for (let index = 0; index < chunkHashes.length; index += 1) {
            if (!have.has(index)) missing.push(index);
        }
        const state = row.state === 'complete'
            ? 'complete'
            : row.failed_at != null
                ? 'failed'
                : row.finalizing_at != null
                    ? 'finalizing'
                    : 'receiving';
        const status = {
            uploadId: row.upload_id,
            sha256: row.sha256,
            size: Number(row.size),
            mime: row.mime,
            encrypted: !!row.encrypted,
            chunkBytes: Number(row.chunk_bytes),
            chunkCount: chunkHashes.length,
            received: received.slice().sort((a, b) => a - b),
            missing,
            state,
        };
        if (state === 'failed') {
            status.error = { code: row.failure_code === 'blob_hash_mismatch' ? 'blob_hash_mismatch' : 'server_unavailable' };
        }
        return status;
    }

    /** Completed plus reserved in-flight usage for both security scopes. */
    blobQuotaUsage(ownerUserId, deviceId) {
        const owner = String(ownerUserId);
        const device = String(deviceId);
        const completedOwner = this.db.prepare(`SELECT COUNT(*) AS count,
            COALESCE(SUM(size), 0) AS bytes FROM mobile_blobs WHERE owner_user_id = ?`).get(owner);
        const completedDevice = this.db.prepare(`SELECT COUNT(*) AS count,
            COALESCE(SUM(size), 0) AS bytes FROM mobile_blobs
            WHERE owner_user_id = ? AND created_by_device_id = ?`).get(owner, device);
        const inflightOwner = this.db.prepare(`SELECT COUNT(*) AS count,
            COALESCE(SUM(size), 0) AS bytes FROM mobile_blob_uploads
            WHERE owner_user_id = ? AND state = 'receiving' AND failed_at IS NULL`).get(owner);
        const inflightDevice = this.db.prepare(`SELECT COUNT(*) AS count,
            COALESCE(SUM(size), 0) AS bytes FROM mobile_blob_uploads
            WHERE owner_user_id = ? AND device_id = ?
              AND state = 'receiving' AND failed_at IS NULL`).get(owner, device);
        return {
            accountBytes: Number(completedOwner.bytes || 0) + Number(inflightOwner.bytes || 0),
            accountCount: Number(completedOwner.count || 0) + Number(inflightOwner.count || 0),
            deviceBytes: Number(completedDevice.bytes || 0) + Number(inflightDevice.bytes || 0),
            deviceCount: Number(completedDevice.count || 0) + Number(inflightDevice.count || 0),
            inflightAccountCount: Number(inflightOwner.count || 0),
            inflightDeviceCount: Number(inflightDevice.count || 0),
        };
    }

    /** Future physical writes reserved by all active uploads. */
    blobPendingDiskBytes() {
        const row = this.db.prepare(`SELECT COALESCE(SUM(
            CASE WHEN finalizing_at IS NULL
                THEN MAX(0, size - received_bytes) + size
                ELSE size END
        ), 0) AS bytes FROM mobile_blob_uploads
        WHERE state = 'receiving' AND failed_at IS NULL`).get();
        return Math.max(0, Number(row?.bytes || 0));
    }

    /**
     * Opens or resumes an upload for a manifest.
     *
     * Three idempotent outcomes: the blob already exists (complete, no
     * uploadId), a matching in-flight upload exists (returned as-is so the
     * client resumes with its missing set), or a fresh upload is created. A
     * different manifest under a digest already in flight is a hash error, not
     * a new upload: continuing would assemble a corrupt blob.
     */
    createBlobUpload({ ownerUserId, deviceId, sha256: digest, size, mime, chunkBytes, chunkHashes, encrypted, chunkSizes, keyedIds, chunkAlgorithm, merkle }, limits = this.blobLimits) {
        const owner = String(ownerUserId);
        const device = String(deviceId);
        const blobDigest = String(digest || '').toLowerCase();
        const algorithm = String(chunkAlgorithm || 'fixed');
        const sizes = Array.isArray(chunkSizes) ? chunkSizes.map(Number) : [];
        const keys = Array.isArray(keyedIds) ? keyedIds.map(String) : [];
        if (!/^[0-9a-f]{64}$/.test(blobDigest)
            || !Number.isSafeInteger(Number(size)) || Number(size) < 0
            || !Array.isArray(chunkHashes)) {
            throw new MobileStoreError('invalid_request', 'invalid blob manifest', 400);
        }
        if (algorithm === 'fastcdc-gear-v1') {
            if (!sizes.length || sizes.length !== chunkHashes.length || sizes.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
                throw new MobileStoreError('invalid_request', 'invalid CDC chunk sizes', 400);
            }
            if (sizes.reduce((sum, value) => sum + value, 0) !== Number(size)) {
                throw new MobileStoreError('invalid_request', 'CDC chunk sizes do not sum to blob size', 400);
            }
            if (keys.length && keys.length !== chunkHashes.length) {
                throw new MobileStoreError('invalid_request', 'keyed chunk id count does not match manifest', 400);
            }
            if (Number(chunkBytes) <= 0) chunkBytes = Math.max(...sizes);
        } else {
            if (!Number.isSafeInteger(Number(chunkBytes)) || Number(chunkBytes) <= 0) {
                throw new MobileStoreError('invalid_request', 'invalid blob manifest', 400);
            }
            const expectedChunks = Number(size) === 0 ? 0 : Math.ceil(Number(size) / Number(chunkBytes));
            if (chunkHashes.length !== expectedChunks) {
                throw new MobileStoreError('invalid_request', 'invalid blob chunk manifest', 400);
            }
        }
        if (chunkHashes.some((hash) => !/^[0-9a-f]{64}$/.test(String(hash)))) {
            throw new MobileStoreError('invalid_request', 'invalid blob chunk manifest', 400);
        }
        const contentType = String(mime || 'application/octet-stream');
        if (contentType.length > 200 || /[\0\r\n]/.test(contentType)) {
            throw new MobileStoreError('invalid_request', 'invalid blob content type', 400);
        }
        const completed = this.getBlob(owner, blobDigest);
        if (completed) {
            return {
                uploadId: null,
                sha256: blobDigest,
                size: Number(completed.size),
                mime: completed.mime,
                encrypted: !!completed.encrypted,
                chunkBytes: Number(completed.chunk_bytes),
                chunkCount: Number(completed.chunk_count),
                received: Array.from({ length: Number(completed.chunk_count) }, (_, index) => index),
                missing: [],
                state: 'complete',
            };
        }

        const prior = this.findResumableBlobUpload(owner, device, blobDigest);
        if (prior) {
            const sameManifest = Number(prior.size) === Number(size)
                && Number(prior.chunk_bytes) === Number(chunkBytes)
                && prior.chunk_hashes_json === JSON.stringify(chunkHashes)
                && prior.mime === String(mime)
                && !!prior.encrypted === !!encrypted;
            if (!sameManifest) {
                throw new MobileStoreError('blob_hash_mismatch', 'blob manifest \u4e0e\u8fdb\u884c\u4e2d\u7684\u4e0a\u4f20\u4e0d\u4e00\u81f3', 422, { retryable: true });
            }
            return this.blobUploadStatus(prior);
        }

        let uploadId;
        const transaction = this.db.transaction(() => {
            const usage = this.blobQuotaUsage(owner, device);
            const nextBytes = Number(size);
            const configured = limits || {};
            const exceeds = usage.accountBytes + nextBytes > Number(configured.maxAccountBytes ?? Number.MAX_SAFE_INTEGER)
                || usage.accountCount + 1 > Number(configured.maxAccountBlobs ?? Number.MAX_SAFE_INTEGER)
                || usage.deviceBytes + nextBytes > Number(configured.maxDeviceBytes ?? Number.MAX_SAFE_INTEGER)
                || usage.deviceCount + 1 > Number(configured.maxDeviceBlobs ?? Number.MAX_SAFE_INTEGER);
            if (exceeds) {
                throw new MobileStoreError('payload_too_large', 'blob storage quota exceeded', 413, {
                    details: {
                        maxAccountBytes: Number(configured.maxAccountBytes ?? Number.MAX_SAFE_INTEGER),
                        maxAccountBlobs: Number(configured.maxAccountBlobs ?? Number.MAX_SAFE_INTEGER),
                        maxDeviceBytes: Number(configured.maxDeviceBytes ?? Number.MAX_SAFE_INTEGER),
                        maxDeviceBlobs: Number(configured.maxDeviceBlobs ?? Number.MAX_SAFE_INTEGER),
                    },
                });
            }
            if (usage.inflightAccountCount >= Number(configured.maxInflightAccountUploads ?? Number.MAX_SAFE_INTEGER)
                || usage.inflightDeviceCount >= Number(configured.maxInflightDeviceUploads ?? Number.MAX_SAFE_INTEGER)) {
                throw new MobileStoreError('rate_limited', 'too many in-flight blob uploads', 429, {
                    retryable: true,
                    retryAfterSec: 5,
                });
            }

            uploadId = 'upl_' + crypto.randomBytes(16).toString('hex');
            const now = nowMs();
            this.db.prepare(`INSERT INTO mobile_blob_uploads
                (upload_id, owner_user_id, device_id, sha256, size, mime, chunk_bytes,
                 chunk_hashes_json, encrypted, received_json, state, received_bytes,
                 finalizing_at, finalize_attempts, failed_at, failure_code, created_at, updated_at,
                 chunk_sizes_json, keyed_ids_json, chunk_algorithm)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'receiving', 0,
                        NULL, 0, NULL, NULL, ?, ?, ?, ?, ?)`)
                .run(uploadId, owner, device, blobDigest,
                    Number(size), String(mime), Number(chunkBytes), JSON.stringify(chunkHashes),
                    encrypted ? 1 : 0, now, now,
                    JSON.stringify(sizes), JSON.stringify(keys), algorithm);
        });
        transaction();
        return this.blobUploadStatus(this.getBlobUpload(uploadId));
    }

    /** Validates a chunk before the async manager writes any bytes. */
    prepareBlobChunk({ ownerUserId, deviceId, uploadId, index, bytes }) {
        const row = this.getBlobUpload(uploadId);
        /* Same 404 for "no such upload" and "another device owns it": the id
         * is unguessable, and a distinguishing error would confirm existence. */
        if (!row || String(row.owner_user_id) !== String(ownerUserId) || String(row.device_id) !== String(deviceId)) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '\u4e0a\u4f20\u4f1a\u8bdd\u4e0d\u5b58\u5728', 404);
        }
        if (row.state !== 'receiving' || row.failed_at != null) {
            throw new MobileStoreError('invalid_request', '\u4e0a\u4f20\u5df2\u5b8c\u6210', 409);
        }
        if (row.finalizing_at != null) {
            throw new MobileStoreError('invalid_request', 'blob is already finalizing', 409);
        }
        const chunkHashes = JSON.parse(row.chunk_hashes_json);
        const count = chunkHashes.length;
        if (!Number.isInteger(index) || index < 0 || index >= count) {
            throw new MobileStoreError('invalid_request', 'chunk index \u8d8a\u754c', 400, { details: { index, chunkCount: count } });
        }
        const sizes = this.parseBlobChunkSizes(row);
        const expectedBytes = Number(sizes[index]);
        if (!Buffer.isBuffer(bytes) || bytes.length !== expectedBytes) {
            throw new MobileStoreError('invalid_request', 'chunk \u957f\u5ea6\u4e0e manifest \u4e0d\u7b26', 400, {
                details: { index, expectedBytes, actualBytes: Buffer.isBuffer(bytes) ? bytes.length : 0 },
            });
        }
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== chunkHashes[index]) {
            throw new MobileStoreError('blob_hash_mismatch', 'chunk \u6821\u9a8c\u5931\u8d25', 422, { retryable: true, details: { index } });
        }
        return { row, index, expectedBytes, digest };
    }

    /** Commits only metadata after the manager atomically publishes the part. */
    commitBlobChunk({ ownerUserId, deviceId, uploadId, index, byteLength }) {
        const transaction = this.db.transaction(() => {
            const row = this.getBlobUpload(uploadId);
            if (!row || String(row.owner_user_id) !== String(ownerUserId) || String(row.device_id) !== String(deviceId)) {
                throw new MobileStoreError('resource_not_found_or_inaccessible', 'upload session not found', 404);
            }
            if (row.state !== 'receiving' || row.failed_at != null || row.finalizing_at != null) {
                throw new MobileStoreError('invalid_request', 'upload is not receiving chunks', 409);
            }
            const hashes = JSON.parse(row.chunk_hashes_json);
            const sizes = this.parseBlobChunkSizes(row);
            const received = new Set(JSON.parse(row.received_json).map(Number));
            if (!received.has(Number(index))) received.add(Number(index));
            let receivedBytes = 0;
            for (const receivedIndex of received) {
                receivedBytes += Number(sizes[receivedIndex]) || 0;
            }
            if (received.has(Number(index)) && Number(byteLength) <= 0 && Number(row.size) > 0) {
                throw new MobileStoreError('invalid_request', 'empty blob chunk', 400);
            }
            const finalizingAt = received.size === hashes.length ? nowMs() : null;
            this.db.prepare(`UPDATE mobile_blob_uploads SET received_json = ?, received_bytes = ?,
                finalizing_at = ?, updated_at = ? WHERE upload_id = ?`).run(
                JSON.stringify([...received].sort((a, b) => a - b)),
                receivedBytes,
                finalizingAt,
                nowMs(),
                row.upload_id,
            );
            return this.getBlobUpload(uploadId);
        });
        return transaction();
    }

    markBlobFinalizing(uploadId) {
        const row = this.getBlobUpload(uploadId);
        if (!row || row.state === 'complete' || row.failed_at != null) return row;
        const hashes = JSON.parse(row.chunk_hashes_json);
        const received = new Set(JSON.parse(row.received_json).map(Number));
        if (received.size !== hashes.length) return row;
        this.db.prepare(`UPDATE mobile_blob_uploads SET finalizing_at = COALESCE(finalizing_at, ?),
            updated_at = ? WHERE upload_id = ?`).run(nowMs(), nowMs(), row.upload_id);
        return this.getBlobUpload(row.upload_id);
    }

    clearBlobFinalizing(uploadId) {
        this.db.prepare(`UPDATE mobile_blob_uploads SET finalizing_at = NULL, updated_at = ?
            WHERE upload_id = ? AND state = 'receiving'`).run(nowMs(), String(uploadId));
        return this.getBlobUpload(uploadId);
    }

    reconcileBlobUpload(uploadId, validIndices) {
        const row = this.getBlobUpload(uploadId);
        if (!row || row.state === 'complete') return row;
        const hashes = JSON.parse(row.chunk_hashes_json);
        const received = [...new Set((validIndices || []).map(Number))]
            .filter((index) => Number.isInteger(index) && index >= 0 && index < hashes.length)
            .sort((a, b) => a - b);
        const sizes = this.parseBlobChunkSizes(row);
        let bytes = 0;
        for (const index of received) {
            bytes += Number(sizes[index]) || 0;
        }
        this.db.prepare(`UPDATE mobile_blob_uploads SET received_json = ?, received_bytes = ?,
            finalizing_at = CASE WHEN ? = ? THEN finalizing_at ELSE NULL END,
            updated_at = ? WHERE upload_id = ?`).run(
                JSON.stringify(received), bytes, received.length, hashes.length, nowMs(), row.upload_id,
            );
        return this.getBlobUpload(row.upload_id);
    }

    completeBlobUpload(row) {
        const count = JSON.parse(row.chunk_hashes_json).length;
        const timestamp = nowMs();
        const transaction = this.db.transaction(() => {
            this.db.prepare(`INSERT INTO mobile_blobs
                (owner_user_id, sha256, size, mime, chunk_bytes, chunk_count,
                 encrypted, created_by_device_id, created_at, chunk_sizes_json, keyed_ids_json, chunk_algorithm)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner_user_id, sha256) DO NOTHING`).run(
                row.owner_user_id, row.sha256, Number(row.size), row.mime,
                Number(row.chunk_bytes), count, Number(row.encrypted) ? 1 : 0,
                row.device_id, timestamp,
                row.chunk_sizes_json || '[]',
                row.keyed_ids_json || '[]',
                row.chunk_algorithm || 'fixed',
            );
            try {
                const hashes = JSON.parse(row.chunk_hashes_json);
                const sizes = this.parseBlobChunkSizes(row);
                const keyed = JSON.parse(row.keyed_ids_json || '[]');
                this.rememberKeyedChunks(row.owner_user_id, hashes.map((sha256, index) => ({
                    keyedId: keyed[index],
                    sha256,
                    size: sizes[index],
                })));
            } catch { /* keyed index is advisory; the blob row is canonical */ }
            this.db.prepare(`UPDATE mobile_blob_uploads SET state = 'complete',
                received_bytes = size, finalizing_at = NULL, failed_at = NULL,
                failure_code = NULL, updated_at = ? WHERE upload_id = ?`).run(timestamp, row.upload_id);
        });
        transaction();
        return this.getBlobUpload(row.upload_id);
    }

    markBlobFailed(uploadId, code) {
        this.db.prepare(`UPDATE mobile_blob_uploads SET failed_at = ?, failure_code = ?,
            finalizing_at = NULL, received_json = '[]', received_bytes = 0, updated_at = ?
            WHERE upload_id = ? AND state = 'receiving'`).run(
                nowMs(), code === 'blob_hash_mismatch' ? code : 'server_unavailable', nowMs(), String(uploadId),
            );
        return this.getBlobUpload(uploadId);
    }

    deferBlobFinalization(uploadId) {
        this.db.prepare(`UPDATE mobile_blob_uploads SET finalize_attempts = finalize_attempts + 1,
            updated_at = ? WHERE upload_id = ? AND state = 'receiving'`).run(nowMs(), String(uploadId));
        return this.getBlobUpload(uploadId);
    }

    reopenCompletedBlobUpload(uploadId) {
        const row = this.getBlobUpload(uploadId);
        if (!row || row.state !== 'complete') return row;
        const transaction = this.db.transaction(() => {
            this.db.prepare('DELETE FROM mobile_blobs WHERE owner_user_id = ? AND sha256 = ?')
                .run(row.owner_user_id, row.sha256);
            this.db.prepare(`UPDATE mobile_blob_uploads SET state = 'receiving',
                finalizing_at = NULL, failed_at = NULL, failure_code = NULL,
                updated_at = ? WHERE upload_id = ?`).run(nowMs(), row.upload_id);
        });
        transaction();
        return this.getBlobUpload(row.upload_id);
    }

    createBlobReadStream(row, options) {
        return fs.createReadStream(this._readBlobFile(row), options);
    }

    listBlobUploadsForRecovery() {
        return this.db.prepare(`SELECT * FROM mobile_blob_uploads
            WHERE state IN ('receiving','complete') ORDER BY created_at ASC`).all();
    }

    listBlobUploadIds() {
        return this.db.prepare('SELECT upload_id FROM mobile_blob_uploads').all()
            .map((row) => String(row.upload_id));
    }

    claimStaleBlobUploads({ referenceTime = nowMs(), staleUploadMs, failedUploadMs }) {
        const staleCutoff = Number(referenceTime) - Math.max(1000, Number(staleUploadMs) || 0);
        const failedCutoff = Number(referenceTime) - Math.max(1000, Number(failedUploadMs) || 0);
        const transaction = this.db.transaction(() => {
            const rows = this.db.prepare(`SELECT * FROM mobile_blob_uploads
                WHERE (state = 'receiving'
                  AND ((failed_at IS NULL AND finalizing_at IS NULL AND updated_at < ?)
                    OR (failed_at IS NOT NULL AND failed_at < ?)))
                   OR (state = 'complete' AND updated_at < ?)`).all(staleCutoff, failedCutoff, staleCutoff);
            const remove = this.db.prepare('DELETE FROM mobile_blob_uploads WHERE upload_id = ?');
            for (const row of rows) remove.run(row.upload_id);
            return rows;
        });
        return transaction();
    }

    signBlob(namespace, payload, ttlMs) {
        const body = Buffer.from(JSON.stringify({
            ns: String(namespace),
            payload,
            expiresAt: nowMs() + Math.max(1000, Number(ttlMs) || 1000),
        }), 'utf8');
        const mac = crypto.createHmac('sha256', this._key()).update(body).digest();
        return b64url(body) + '.' + b64url(mac);
    }

    /**
     * Verifies and opens a token produced by signBlob.
     *
     * Throws rather than returning null: every failure here is either tampering
     * or expiry, and both need a distinct registered error code at the edge.
     */
    openBlob(namespace, token, { code = 'invalid_request', status = 400 } = {}) {
        const parts = String(token || '').split('.');
        if (parts.length !== 2) {
            throw new MobileStoreError(code, '\u51ed\u636e\u683c\u5f0f\u65e0\u6548', status);
        }
        const body = Buffer.from(parts[0], 'base64url');
        const expected = crypto.createHmac('sha256', this._key()).update(body).digest();
        const given = Buffer.from(parts[1], 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            throw new MobileStoreError(code, '\u51ed\u636e\u7b7e\u540d\u65e0\u6548', status);
        }
        let opened;
        try {
            opened = JSON.parse(body.toString('utf8'));
        } catch {
            throw new MobileStoreError(code, '\u51ed\u636e\u65e0\u6cd5\u89e3\u6790', status);
        }
        /* Namespace check before expiry: a token from another namespace is not
         * "expired", it is the wrong kind of token entirely. */
        if (String(opened.ns) !== String(namespace)) {
            throw new MobileStoreError(code, '\u51ed\u636e\u7c7b\u578b\u4e0d\u5339\u914d', status);
        }
        if (Number(opened.expiresAt) <= nowMs()) {
            throw new MobileStoreError(code, '\u51ed\u636e\u5df2\u8fc7\u671f', status);
        }
        return opened.payload;
    }

    _bootstrapExpired(message = '\u5206\u9875\u4ee4\u724c\u65e0\u6548') {
        return new MobileStoreError('bootstrap_expired', message, 410);
    }

    _bootstrapSnapshotIdentity(state) {
        return sha256(canonicalJson({
            version: BOOTSTRAP_TOKEN_VERSION,
            bootstrapId: state.bootstrapId,
            snapshotCursor: state.snapshotCursor,
            typeOrder: state.typeOrder,
            upperBounds: state.upperBounds,
            ownerUserId: state.ownerUserId,
            deviceId: state.deviceId,
            generation: state.generation,
            registryHash: state.registryHash,
            expiresAt: state.expiresAt,
        }));
    }

    _normalizeBootstrapState(input, { requireIdentity = true } = {}) {
        const state = input && typeof input === 'object' ? input : {};
        const normalized = {
            version: Number(state.version),
            bootstrapId: String(state.bootstrapId || ''),
            snapshotCursor: Number(state.snapshotCursor),
            typeOrder: Array.isArray(state.typeOrder) ? state.typeOrder.map(String) : [],
            upperBounds: Array.isArray(state.upperBounds)
                ? state.upperBounds.map((value) => value == null ? null : String(value))
                : [],
            typeIndex: Number(state.typeIndex),
            afterEntityId: state.afterEntityId == null ? null : String(state.afterEntityId),
            ownerUserId: String(state.ownerUserId || ''),
            deviceId: String(state.deviceId || ''),
            generation: Number(state.generation),
            registryHash: String(state.registryHash || ''),
            expiresAt: Number(state.expiresAt),
            snapshotIdentity: String(state.snapshotIdentity || ''),
        };
        const typesAreValid = normalized.typeOrder.length <= 500
            && new Set(normalized.typeOrder).size === normalized.typeOrder.length
            && normalized.typeOrder.every((value) => value.length > 0 && value.length <= 200);
        const boundsAreValid = normalized.upperBounds.length === normalized.typeOrder.length
            && normalized.upperBounds.every((value) => value == null || (value.length > 0 && value.length <= 2048));
        const cursorIsValid = Number.isSafeInteger(normalized.snapshotCursor) && normalized.snapshotCursor >= 0;
        const indexIsValid = Number.isSafeInteger(normalized.typeIndex)
            && normalized.typeIndex >= 0
            && normalized.typeIndex <= normalized.typeOrder.length;
        const bindingIsValid = normalized.ownerUserId.length > 0
            && normalized.deviceId.length > 0
            && Number.isSafeInteger(normalized.generation)
            && normalized.generation >= 1
            && /^[0-9a-f]{64}$/.test(normalized.registryHash);
        const expiryIsValid = Number.isSafeInteger(normalized.expiresAt) && normalized.expiresAt > 0;
        const pageCursorIsValid = normalized.afterEntityId == null
            ? true
            : normalized.typeIndex < normalized.typeOrder.length
                && normalized.upperBounds[normalized.typeIndex] != null
                && normalized.afterEntityId <= normalized.upperBounds[normalized.typeIndex];
        if (normalized.version !== BOOTSTRAP_TOKEN_VERSION
            || normalized.bootstrapId.length < 8
            || normalized.bootstrapId.length > 200
            || !typesAreValid
            || !boundsAreValid
            || !cursorIsValid
            || !indexIsValid
            || !bindingIsValid
            || !expiryIsValid
            || !pageCursorIsValid
            || (normalized.afterEntityId != null
                && (normalized.afterEntityId.length === 0 || normalized.afterEntityId.length > 2048))) {
            throw this._bootstrapExpired();
        }
        const expectedIdentity = this._bootstrapSnapshotIdentity(normalized);
        if (requireIdentity && !timingSafeTextEqual(normalized.snapshotIdentity, expectedIdentity)) {
            throw this._bootstrapExpired();
        }
        normalized.snapshotIdentity = expectedIdentity;
        return normalized;
    }

    beginBootstrapSnapshot({
        bootstrapId,
        snapshotCursor,
        typeOrder,
        upperBounds,
        ownerUserId,
        deviceId,
        generation,
    }) {
        return this._normalizeBootstrapState({
            version: BOOTSTRAP_TOKEN_VERSION,
            bootstrapId,
            snapshotCursor,
            typeOrder,
            upperBounds,
            typeIndex: 0,
            afterEntityId: null,
            ownerUserId,
            deviceId,
            generation,
            registryHash: this.registryHash,
            expiresAt: nowMs() + BOOTSTRAP_TOKEN_TTL_MINUTES * 60000,
        }, { requireIdentity: false });
    }

    sealBootstrapToken(state) {
        const normalized = this._normalizeBootstrapState(state);
        if (normalized.expiresAt <= nowMs()) {
            throw this._bootstrapExpired('\u5206\u9875\u4ee4\u724c\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u5f00\u59cb bootstrap');
        }
        const body = Buffer.from(JSON.stringify(normalized), 'utf8');
        const mac = crypto.createHmac('sha256', this._key()).update(body).digest();
        return b64url(body) + '.' + b64url(mac);
    }

    /**
     * @param {string} token the pageToken the client sent back
     * @param {object} binding the current account/device/generation/registry binding
     */
    openBootstrapToken(token, binding) {
        const parts = String(token || '').split('.');
        if (parts.length !== 2) {
            throw this._bootstrapExpired();
        }
        const body = Buffer.from(parts[0], 'base64url');
        const expected = crypto.createHmac('sha256', this._key()).update(body).digest();
        const given = Buffer.from(parts[1], 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            throw this._bootstrapExpired('\u5206\u9875\u4ee4\u724c\u7b7e\u540d\u65e0\u6548');
        }

        let state;
        try {
            state = JSON.parse(body.toString('utf8'));
        } catch {
            throw this._bootstrapExpired('\u5206\u9875\u4ee4\u724c\u65e0\u6cd5\u89e3\u6790');
        }
        state = this._normalizeBootstrapState(state);
        if (state.expiresAt <= nowMs()) {
            throw this._bootstrapExpired('\u5206\u9875\u4ee4\u724c\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u5f00\u59cb bootstrap');
        }

        const current = binding && typeof binding === 'object' ? binding : {};
        const currentTypes = Array.isArray(current.typeOrder) ? current.typeOrder.map(String) : [];
        const matches = [
            timingSafeTextEqual(state.ownerUserId, current.ownerUserId || ''),
            timingSafeTextEqual(state.deviceId, current.deviceId || ''),
            Number(state.generation) === Number(current.generation),
            timingSafeTextEqual(state.registryHash, current.registryHash || ''),
            timingSafeTextEqual(canonicalJson(state.typeOrder), canonicalJson(currentTypes)),
        ].every(Boolean);
        if (!matches) {
            throw this._bootstrapExpired('\u5206\u9875\u4ee4\u724c\u4e0e\u5f53\u524d\u8bbe\u5907\u7ed1\u5b9a\u4e0d\u5339\u914d');
        }
        return state;
    }

    // --------------------------------------------------- server identity ---

    /**
     * Stable per-install server id.
     *
     * The envelope AAD binds ciphertext to (serverId, userId, deviceId, ...), so
     * this value must outlive a restart: regenerating it would silently make
     * every previously sealed secret unopenable. Persisted in the same settings
     * table the rest of the product uses, created once on first read.
     *
     * Published through /capabilities so the device uses the server's value
     * rather than a locally invented one - the AAD only matches if both sides
     * agree on the exact string.
     */
    serverId() {
        const row = this.db
            .prepare("SELECT value FROM settings WHERE key = 'mobileV1ServerId'")
            .get();
        if (row && row.value) return String(row.value);
        const generated = 'srv-' + crypto.randomUUID();
        this.db
            .prepare("INSERT INTO settings (key, value) VALUES ('mobileV1ServerId', ?) ON CONFLICT(key) DO NOTHING")
            .run(generated);
        const after = this.db
            .prepare("SELECT value FROM settings WHERE key = 'mobileV1ServerId'")
            .get();
        return String((after && after.value) || generated);
    }

    // ------------------------------------------------------- replay guard ---

    findAppliedOp(ownerUserId, deviceId, opId) {
        const row = this.db.prepare(`SELECT * FROM mobile_applied_ops
            WHERE owner_user_id = ? AND device_id = ? AND op_id = ?`)
            .get(String(ownerUserId), String(deviceId), String(opId));
        if (!row) return null;
        try {
            return JSON.parse(row.result_json);
        } catch {
            return null;
        }
    }

    recordAppliedOp({ ownerUserId, deviceId, opId, batchId, result }) {
        const ts = nowMs();
        this.db.prepare(`INSERT INTO mobile_applied_ops
            (owner_user_id, device_id, op_id, batch_id, result_json, applied_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, device_id, op_id) DO NOTHING`).run(
            String(ownerUserId), String(deviceId), String(opId), String(batchId),
            JSON.stringify(result), ts, ts + APPLIED_OP_RETENTION_DAYS * 86400000,
        );
    }

    gcAppliedOps() {
        this.db.prepare('DELETE FROM mobile_applied_ops WHERE expires_at < ?').run(nowMs());
    }

    // ----------------------------------------------------------- grants ----

    /** targetHash binds a grant to the exact target list it was approved for. */
    static targetHash(action, targetIds) {
        const sorted = (targetIds || []).map(String).slice().sort();
        return sha256(canonicalJson({ action: String(action), targetIds: sorted }));
    }

    /** Claims one password/TOTP verification attempt from a durable window. */
    takeSensitiveVerificationAttempt(ownerUserId, referenceTime = nowMs()) {
        const owner = String(ownerUserId || '');
        const ts = Number(referenceTime);
        if (!owner || !Number.isSafeInteger(ts) || ts <= 0) {
            throw new MobileStoreError('invalid_request', 'sensitive verification context is invalid', 400);
        }

        const tx = this.db.transaction(() => {
            const row = this.db.prepare(
                'SELECT window_started_at, attempts FROM mobile_sensitive_attempts WHERE owner_user_id = ?',
            ).get(owner);
            if (!row || Number(row.window_started_at) + SENSITIVE_VERIFY_WINDOW_MS <= ts) {
                this.db.prepare(`INSERT INTO mobile_sensitive_attempts
                    (owner_user_id, window_started_at, attempts) VALUES (?, ?, 1)
                    ON CONFLICT(owner_user_id) DO UPDATE SET
                        window_started_at = excluded.window_started_at,
                        attempts = excluded.attempts`).run(owner, ts);
                return { remaining: SENSITIVE_VERIFY_MAX_ATTEMPTS - 1, retryAfterSec: 0 };
            }

            const attempts = Number(row.attempts || 0);
            const retryAfterSec = Math.max(1, Math.ceil(
                (Number(row.window_started_at) + SENSITIVE_VERIFY_WINDOW_MS - ts) / 1000,
            ));
            if (attempts >= SENSITIVE_VERIFY_MAX_ATTEMPTS) {
                throw new MobileStoreError('rate_limited', 'sensitive verification rate limit exceeded', 429, {
                    retryable: true,
                    retryAfterSec,
                    details: { retryAfterSec },
                });
            }
            this.db.prepare(`UPDATE mobile_sensitive_attempts
                SET attempts = attempts + 1 WHERE owner_user_id = ?`).run(owner);
            return {
                remaining: SENSITIVE_VERIFY_MAX_ATTEMPTS - attempts - 1,
                retryAfterSec,
            };
        });
        return tx();
    }

    createGrant({ ownerUserId, action, targetIds, requestId, bindAttemptHash = null }) {
        const grant = crypto.randomBytes(32).toString('base64url');
        const grantHash = sha256(grant);
        const expiresAt = nowMs() + GRANT_TTL_SEC * 1000;
        const targetHash = MobileV1Store.targetHash(action, targetIds);
        const owner = String(ownerUserId);
        const requestedAction = String(action);
        const createdAt = nowMs();
        const execute = () => {
            this.db.prepare(`INSERT INTO mobile_sensitive_grants
                (grant_hash, owner_user_id, action, target_hash, expires_at, consumed_at, created_at, request_id)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`).run(
                grantHash, owner, requestedAction, targetHash,
                expiresAt, createdAt, String(requestId || ''),
            );
            if (requestedAction === 'device.bind') {
                const linked = this.db.prepare(`UPDATE mobile_device_bind_attempts
                    SET grant_hash = ?
                    WHERE attempt_hash = ? AND owner_user_id = ? AND grant_hash IS NULL
                      AND completed_at IS NULL AND expires_at > ?`).run(
                    grantHash, String(bindAttemptHash || ''), owner, createdAt,
                );
                if (Number(linked.changes || 0) !== 1) {
                    throw new MobileStoreError('revision_conflict', 'bind attempt changed concurrently', 409, {
                        details: { reason: 'bind_attempt_stale' },
                    });
                }
            }
        };
        if (this.db.inTransaction) execute();
        else this.db.transaction(execute)();
        return { grant, expiresAt, targetHash };
    }

    /**
     * Consumes a grant, or explains precisely why it cannot be.
     *
     * Expired and already-consumed are distinct codes because they need
     * different client behaviour: re-verify versus stop and report a possible
     * replay.
     */
    consumeGrant({ ownerUserId, action, targetIds, grant }) {
        const grantHash = sha256(String(grant || ''));
        const owner = String(ownerUserId || '');
        const requestedAction = String(action || '');
        const targetHash = MobileV1Store.targetHash(requestedAction, targetIds);
        const consumedAt = nowMs();

        /* Validation and state transition are one statement, so concurrent
         * consumers cannot both claim the same grant. */
        const result = this.db.prepare(`UPDATE mobile_sensitive_grants
            SET consumed_at = ?
            WHERE grant_hash = ? AND owner_user_id = ? AND action = ? AND target_hash = ?
              AND consumed_at IS NULL AND expires_at > ?`).run(
            consumedAt, grantHash, owner, requestedAction, targetHash, consumedAt,
        );
        if (Number(result.changes || 0) === 1) return true;

        const row = this.db.prepare('SELECT * FROM mobile_sensitive_grants WHERE grant_hash = ?')
            .get(grantHash);
        if (!row || row.owner_user_id !== owner || row.action !== requestedAction
            || row.target_hash !== targetHash) {
            throw new MobileStoreError('sensitive_verification_required', '需要完成敏感操作验证', 403);
        }
        if (row.consumed_at !== null) {
            throw new MobileStoreError('sensitive_grant_consumed', '该验证凭据已被使用', 409);
        }
        if (Number(row.expires_at) <= consumedAt) {
            throw new MobileStoreError('sensitive_grant_expired', '验证凭据已过期', 403);
        }
        throw new MobileStoreError('sensitive_verification_required', '需要完成敏感操作验证', 403);
    }

    gcGrants() {
        this.db.prepare('DELETE FROM mobile_sensitive_grants WHERE expires_at < ?').run(nowMs() - 86400000);
        this.db.prepare(`DELETE FROM mobile_device_bind_attempts
            WHERE (completed_at IS NULL AND expires_at < ?)
               OR (completed_at IS NOT NULL AND replay_expires_at < ?)`).run(nowMs(), nowMs());
        this.db.prepare('DELETE FROM mobile_sensitive_attempts WHERE window_started_at < ?')
            .run(nowMs() - SENSITIVE_VERIFY_WINDOW_MS * 2);
    }

    // ------------------------------------------------------------- runs ----

    startRun({ ownerUserId, deviceId, trigger, fromCursor, requestId }) {
        const runId = 'run-' + crypto.randomUUID();
        this.db.prepare(`INSERT INTO mobile_sync_runs
            (run_id, owner_user_id, device_id, trigger, state, started_at, completed_at,
             from_cursor, to_cursor, pushed, pulled, conflicts, error_code, request_id)
            VALUES (?, ?, ?, ?, 'running', ?, NULL, ?, NULL, 0, 0, 0, NULL, ?)`).run(
            runId, String(ownerUserId), String(deviceId), String(trigger), nowMs(),
            Number(fromCursor) || 0, String(requestId || ''),
        );
        return runId;
    }

    finishRun(runId, { state, toCursor, pushed = 0, pulled = 0, conflicts = 0, errorCode = null }) {
        this.db.prepare(`UPDATE mobile_sync_runs
            SET state = ?, completed_at = ?, to_cursor = ?, pushed = ?, pulled = ?, conflicts = ?, error_code = ?
            WHERE run_id = ?`).run(
            String(state), nowMs(), toCursor == null ? null : Number(toCursor),
            Number(pushed) || 0, Number(pulled) || 0, Number(conflicts) || 0,
            errorCode ? String(errorCode) : null, runId,
        );
    }

    lastRun(deviceId) {
        return this.db.prepare('SELECT * FROM mobile_sync_runs WHERE device_id = ? ORDER BY started_at DESC LIMIT 1')
            .get(String(deviceId)) || null;
    }
}

module.exports = {
    MobileV1Store,
    MobileStoreError,
    canonicalJson,
    APPLIED_OP_RETENTION_DAYS,
    BOOTSTRAP_TOKEN_TTL_MINUTES,
    ACCESS_TTL_SEC,
    GRANT_TTL_SEC,
    BIND_ATTEMPT_TTL_SEC,
    SENSITIVE_VERIFY_WINDOW_MS,
    SENSITIVE_VERIFY_MAX_ATTEMPTS,
    PROOF_NONCE_BYTES,
    PROOF_CHALLENGE_TTL_SEC,
    PROOF_MAX_ACTIVE_PER_DEVICE,
    PROOF_MAX_ISSUES_PER_MINUTE,
    HMAC_KEY_FILE,
};
