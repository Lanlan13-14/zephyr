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
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_BYTES = 32;
const GRANT_TTL_SEC = 5 * 60;

function nowMs() {
    return Date.now();
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
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
        `);
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
            lastSyncAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
            lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
            createdAt: Number(row.created_at || 0),
            revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
        };
    }

    /**
     * Binds or re-binds a device, returning fresh credentials.
     *
     * A re-bind of an existing deviceId by the same owner rotates the
     * generation, so credentials issued to a previous install of the same app
     * stop working immediately. A different owner is refused rather than
     * silently taken over (`client_owned_by_other`).
     */
    bindDevice({ ownerUserId, ownerUsername, deviceId, deviceName, platform, appVersion, tokenId, keys, syncIntervalSec }) {
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
        const interval = Math.min(86400, Math.max(30, Number(syncIntervalSec) || 300));
        const existing = this.getDeviceRow(id);
        if (existing && existing.owner_user_id !== ownerUserId) {
            throw new MobileStoreError('client_owned_by_other', 'deviceId 已被其他账号绑定', 409);
        }

        const ts = nowMs();
        const refresh = crypto.randomBytes(REFRESH_BYTES).toString('base64url');
        const generation = existing ? Number(existing.refresh_generation || 1) + 1 : 1;

        if (existing) {
            this.db.prepare(`UPDATE mobile_devices SET
                owner_username_compat = ?, token_id = ?, device_name = ?, platform = ?,
                app_version = ?, encryption_public_key = ?, signing_public_jwk = ?,
                refresh_token_hash = ?, refresh_generation = ?, enabled = 1,
                sync_interval_sec = ?, registry_hash = ?, last_seen_at = ?,
                revoked_at = NULL, revoke_reason = NULL
                WHERE device_id = ?`).run(
                String(ownerUsername || ''), String(tokenId), String(deviceName || 'Zephyr One').slice(0, 120),
                platform, String(appVersion || '').slice(0, 40), encryption,
                JSON.stringify(keys.signing.jwk), sha256(refresh), generation,
                interval, this.registryHash, ts, id,
            );
        } else {
            this.db.prepare(`INSERT INTO mobile_devices
                (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
                 app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
                 refresh_generation, enabled, automatic_enabled, sync_interval_sec, registry_hash,
                 last_acked_cursor, last_sync_at, last_seen_at, created_at, revoked_at, revoke_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 0, NULL, ?, ?, NULL, NULL)`).run(
                id, String(ownerUserId), String(ownerUsername || ''), String(tokenId),
                String(deviceName || 'Zephyr One').slice(0, 120), platform,
                String(appVersion || '').slice(0, 40), encryption,
                JSON.stringify(keys.signing.jwk), sha256(refresh), generation,
                interval, this.registryHash, ts, ts,
            );
        }

        const row = this.getDeviceRow(id);
        return {
            row,
            refreshCredential: refresh,
            ...this.mintAccess(row),
            /* A re-bind still needs a bootstrap: the device's local mirror was
             * dropped by the unbind that preceded it, so a cursor-based catch-up
             * would start from a snapshot that no longer exists locally. */
            bootstrapRequired: true,
        };
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
        const name = patch.deviceName === undefined ? row.device_name : String(patch.deviceName).slice(0, 120);
        const enabled = patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0);
        const automatic = patch.automaticEnabled === undefined
            ? row.automatic_enabled
            : (patch.automaticEnabled ? 1 : 0);
        const interval = patch.syncIntervalSec === undefined
            ? row.sync_interval_sec
            : Math.min(86400, Math.max(30, Number(patch.syncIntervalSec) || 300));
        this.db.prepare(`UPDATE mobile_devices
            SET device_name = ?, enabled = ?, automatic_enabled = ?, sync_interval_sec = ?, last_seen_at = ?
            WHERE device_id = ?`).run(name, enabled, automatic, interval, nowMs(), deviceId);
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
        this.db.prepare(`UPDATE mobile_devices
            SET revoked_at = ?, revoke_reason = ?, enabled = 0,
                refresh_token_hash = NULL, refresh_generation = refresh_generation + 1
            WHERE device_id = ?`).run(nowMs(), String(reason).slice(0, 200), deviceId);
        return true;
    }

    touchDevice(deviceId, { appVersion } = {}) {
        this.db.prepare('UPDATE mobile_devices SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE device_id = ?')
            .run(nowMs(), appVersion ? String(appVersion).slice(0, 40) : null, deviceId);
    }

    markSynced(deviceId, cursor) {
        this.db.prepare('UPDATE mobile_devices SET last_sync_at = ?, last_acked_cursor = ? WHERE device_id = ?')
            .run(nowMs(), Number(cursor) || 0, deviceId);
    }

    // -------------------------------------------------------- change feed ---

    latestCursor(ownerUserId) {
        const row = this.db
            .prepare('SELECT MAX(change_seq) AS seq FROM mobile_sync_changes WHERE owner_user_id = ?')
            .get(String(ownerUserId || ''));
        return Number(row?.seq || 0);
    }

    oldestCursor(ownerUserId) {
        const row = this.db
            .prepare('SELECT MIN(change_seq) AS seq FROM mobile_sync_changes WHERE owner_user_id = ?')
            .get(String(ownerUserId || ''));
        return Number(row?.seq || 0);
    }

    /**
     * Appends one change row. Must be called inside the caller's transaction so
     * the business write and the feed entry commit together.
     */
    appendChange({ ownerUserId, entityType, entityId, action, revision, fieldMask, actorDeviceId, tombstone }) {
        const info = this.db.prepare(`INSERT INTO mobile_sync_changes
            (owner_user_id, entity_type, entity_id, action, revision, field_mask_json,
             actor_device_id, changed_at, tombstone_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            String(ownerUserId), String(entityType), String(entityId), action,
            Number(revision) || 1, JSON.stringify(Array.isArray(fieldMask) ? fieldMask : []),
            actorDeviceId ? String(actorDeviceId) : null, nowMs(),
            tombstone ? JSON.stringify(tombstone) : null,
        );
        return Number(info.lastInsertRowid);
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

    /** Field-level revisions: the data SYNC_STATE_MACHINE.md section 7 merges on. */
    setFieldRevisions({ ownerUserId, entityType, entityId, fields, revision }) {
        const stmt = this.db.prepare(`INSERT INTO mobile_entity_field_revisions
            (owner_user_id, entity_type, entity_id, field_path, revision)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, entity_type, entity_id, field_path)
            DO UPDATE SET revision = excluded.revision`);
        for (const field of fields || []) {
            stmt.run(String(ownerUserId), String(entityType), String(entityId), String(field), Number(revision) || 1);
        }
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

    /**
     * True when a device's cursor points before the oldest change still kept.
     *
     * Such a device cannot be caught up incrementally: the changes it missed are
     * gone, so it must bootstrap again rather than silently skip them and end up
     * with a mirror that disagrees with the server.
     */
    isCursorExpired(ownerUserId, cursor) {
        const from = Number(cursor) || 0;
        // Cursor 0 on an account whose feed starts at 1 is a fresh device, not an
        // expired one, so the floor is the oldest retained seq minus one.
        const oldest = this.oldestCursor(ownerUserId);
        if (!oldest) return false;
        return from < oldest - 1;
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
        const info = this.db
            .prepare('DELETE FROM mobile_sync_changes WHERE owner_user_id = ? AND change_seq < ?')
            .run(String(ownerUserId || ''), Number(beforeSeq) || 0);
        return Number(info.changes || 0);
    }

    // -------------------------------------------------- bootstrap tokens ---

    /*
     * A bootstrap page token is server state the client only echoes back.
     *
     * HMAC-signed rather than stored in a table: the token carries the whole
     * cursor (bootstrapId, snapshot cursor, type index, row offset), so an
     * interrupted bootstrap resumes without the server keeping per-attempt rows
     * that would then need their own GC. Signing is what stops a client from
     * editing the offset to skip pages or from lifting another account's token,
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

    sealBootstrapToken(state) {
        const body = Buffer.from(JSON.stringify({
            bootstrapId: String(state.bootstrapId),
            snapshotCursor: Number(state.snapshotCursor) || 0,
            typeIndex: Number(state.typeIndex) || 0,
            offset: Number(state.offset) || 0,
            ownerUserId: String(state.ownerUserId || ''),
            expiresAt: nowMs() + BOOTSTRAP_TOKEN_TTL_MINUTES * 60000,
        }), 'utf8');
        const mac = crypto.createHmac('sha256', this._key()).update(body).digest();
        return b64url(body) + '.' + b64url(mac);
    }

    /**
     * @param {string} token the pageToken the client sent back
     * @param {string} ownerUserId the account the current request authenticated as
     */
    openBootstrapToken(token, ownerUserId) {
        const parts = String(token || '').split('.');
        if (parts.length !== 2) {
            throw new MobileStoreError('bootstrap_expired', '分页令牌无效', 410);
        }
        const body = Buffer.from(parts[0], 'base64url');
        const expected = crypto.createHmac('sha256', this._key()).update(body).digest();
        const given = Buffer.from(parts[1], 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            throw new MobileStoreError('bootstrap_expired', '分页令牌签名无效', 410);
        }

        let state;
        try {
            state = JSON.parse(body.toString('utf8'));
        } catch {
            throw new MobileStoreError('bootstrap_expired', '分页令牌无法解析', 410);
        }

        if (Number(state.expiresAt) <= nowMs()) {
            throw new MobileStoreError('bootstrap_expired', '分页令牌已过期，请重新开始 bootstrap', 410);
        }
        /* Owner binding, not just signature validity: the signing key is
         * server-wide, so a token minted for one account would otherwise be a
         * valid token for another account's bootstrap. */
        if (ownerUserId && String(state.ownerUserId) !== String(ownerUserId)) {
            throw new MobileStoreError('bootstrap_expired', '分页令牌不属于当前账号', 410);
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
        return sha256(String(action) + '\u0000' + sorted.join('\u0000'));
    }

    createGrant({ ownerUserId, action, targetIds, requestId }) {
        const grant = crypto.randomBytes(32).toString('base64url');
        const expiresAt = nowMs() + GRANT_TTL_SEC * 1000;
        const targetHash = MobileV1Store.targetHash(action, targetIds);
        this.db.prepare(`INSERT INTO mobile_sensitive_grants
            (grant_hash, owner_user_id, action, target_hash, expires_at, consumed_at, created_at, request_id)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`).run(
            sha256(grant), String(ownerUserId), String(action), targetHash,
            expiresAt, nowMs(), String(requestId || ''),
        );
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
        const row = this.db.prepare('SELECT * FROM mobile_sensitive_grants WHERE grant_hash = ?')
            .get(sha256(String(grant || '')));
        if (!row || row.owner_user_id !== ownerUserId) {
            throw new MobileStoreError('sensitive_verification_required', '需要完成敏感操作验证', 403);
        }
        if (row.consumed_at) throw new MobileStoreError('sensitive_grant_consumed', '该验证凭据已被使用', 409);
        if (Number(row.expires_at) <= nowMs()) {
            throw new MobileStoreError('sensitive_grant_expired', '验证凭据已过期', 403);
        }
        if (row.action !== String(action)) {
            throw new MobileStoreError('sensitive_verification_required', '需要完成敏感操作验证', 403);
        }
        if (row.target_hash !== MobileV1Store.targetHash(action, targetIds)) {
            throw new MobileStoreError('sensitive_verification_required', '需要完成敏感操作验证', 403);
        }
        this.db.prepare('UPDATE mobile_sensitive_grants SET consumed_at = ? WHERE grant_hash = ?')
            .run(nowMs(), row.grant_hash);
        return true;
    }

    gcGrants() {
        this.db.prepare('DELETE FROM mobile_sensitive_grants WHERE expires_at < ?').run(nowMs() - 86400000);
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
    HMAC_KEY_FILE,
};
