'use strict';

const crypto = require('crypto');

const BUCKET_TYPES = Object.freeze(['account', 'session', 'ip']);
const DEFAULT_CLEANUP_BATCH_SIZE = 256;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const HASH_DOMAIN = 'zephyr-webdav-sensitive-rate-limit-v1';

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
}

function boundedIdentity(value, maxLength, name) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.length > maxLength) throw new Error(`${name} is invalid`);
    return normalized;
}

function digest(parts) {
    const hash = crypto.createHash('sha256');
    hash.update(HASH_DOMAIN);
    for (const part of parts) hash.update('\0').update(String(part));
    return hash.digest('base64url');
}

function ownerHash(userId) {
    return digest(['owner', boundedIdentity(userId, 512, 'userId')]);
}

function makeBucketDescriptors({ userId, sessionId, clientIp }) {
    const user = boundedIdentity(userId, 512, 'userId');
    const session = boundedIdentity(sessionId, 512, 'sessionId');
    const ip = boundedIdentity(clientIp, 256, 'clientIp');
    const owner = ownerHash(user);
    return [
        { type: 'account', hash: digest(['account', user]), ownerHash: owner },
        // The session bucket intentionally excludes the client IP. Rotating an
        // address must not grant the same authenticated session a fresh budget.
        { type: 'session', hash: digest(['session', user, session]), ownerHash: owner },
        // IP is a global additional budget. It can only make the limit stricter.
        { type: 'ip', hash: digest(['ip', ip]), ownerHash: null },
    ];
}

function ensureWebDavSensitiveAttemptSchema(db) {
    if (!db || typeof db.exec !== 'function') throw new Error('database is unavailable');
    db.exec(`
        CREATE TABLE IF NOT EXISTS webdav_sensitive_attempt_buckets (
            bucket_type TEXT NOT NULL CHECK (bucket_type IN ('account', 'session', 'ip')),
            bucket_hash TEXT NOT NULL,
            owner_hash TEXT,
            window_start INTEGER NOT NULL,
            attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
            expires_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (bucket_type, bucket_hash)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_webdav_sensitive_attempt_expiry
            ON webdav_sensitive_attempt_buckets(expires_at);
        CREATE INDEX IF NOT EXISTS idx_webdav_sensitive_attempt_owner
            ON webdav_sensitive_attempt_buckets(owner_hash)
            WHERE owner_hash IS NOT NULL;
    `);
}

function createBinding(db, { maxAttempts, maxEntries, cleanupBatchSize, busyTimeoutMs }) {
    try { db.pragma?.(`busy_timeout = ${busyTimeoutMs}`); } catch {}
    ensureWebDavSensitiveAttemptSchema(db);

    const statements = {
        cleanupExpired: db.prepare(`
            DELETE FROM webdav_sensitive_attempt_buckets
             WHERE (bucket_type, bucket_hash) IN (
                SELECT bucket_type, bucket_hash
                  FROM webdav_sensitive_attempt_buckets
                 WHERE expires_at <= ?
                 ORDER BY expires_at, bucket_type, bucket_hash
                 LIMIT ?
             )
        `),
        select: db.prepare(`
            SELECT window_start, attempt_count, expires_at
              FROM webdav_sensitive_attempt_buckets
             WHERE bucket_type = ? AND bucket_hash = ?
        `),
        count: db.prepare('SELECT COUNT(*) AS count FROM webdav_sensitive_attempt_buckets'),
        insert: db.prepare(`
            INSERT INTO webdav_sensitive_attempt_buckets
                (bucket_type, bucket_hash, owner_hash, window_start, attempt_count, expires_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
        `),
        increment: db.prepare(`
            UPDATE webdav_sensitive_attempt_buckets
               SET attempt_count = attempt_count + 1, updated_at = ?
             WHERE bucket_type = ? AND bucket_hash = ?
               AND expires_at > ? AND attempt_count < ?
        `),
        reset: db.prepare(`
            UPDATE webdav_sensitive_attempt_buckets
               SET owner_hash = ?, window_start = ?, attempt_count = 1,
                   expires_at = ?, updated_at = ?
             WHERE bucket_type = ? AND bucket_hash = ? AND expires_at <= ?
        `),
        deleteOwner: db.prepare(`
            DELETE FROM webdav_sensitive_attempt_buckets WHERE owner_hash = ?
        `),
    };

    statements.consume = db.transaction(({ descriptors, timestamp, windowStart, expiresAt }) => {
        statements.cleanupExpired.run(timestamp, cleanupBatchSize);

        const rows = descriptors.map((descriptor) => ({
            descriptor,
            row: statements.select.get(descriptor.type, descriptor.hash) || null,
        }));

        // A row remains active until its persisted expiry even if a process
        // restarts with a changed window setting or the wall clock moves back.
        if (rows.some(({ row }) => row
            && Number(row.expires_at) > timestamp
            && Number(row.attempt_count) >= maxAttempts)) {
            return false;
        }

        const missing = rows.reduce((count, { row }) => count + (row ? 0 : 1), 0);
        const entryCount = Number(statements.count.get()?.count) || 0;
        if (entryCount + missing > maxEntries) return false;

        for (const { descriptor, row } of rows) {
            if (!row) {
                statements.insert.run(
                    descriptor.type,
                    descriptor.hash,
                    descriptor.ownerHash,
                    windowStart,
                    expiresAt,
                    timestamp,
                );
                continue;
            }
            if (Number(row.expires_at) <= timestamp) {
                const reset = statements.reset.run(
                    descriptor.ownerHash,
                    windowStart,
                    expiresAt,
                    timestamp,
                    descriptor.type,
                    descriptor.hash,
                    timestamp,
                );
                if (reset.changes !== 1) throw new Error('rate limit bucket reset lost atomicity');
                continue;
            }
            const incremented = statements.increment.run(
                timestamp,
                descriptor.type,
                descriptor.hash,
                timestamp,
                maxAttempts,
            );
            if (incremented.changes !== 1) throw new Error('rate limit bucket increment lost atomicity');
        }
        return true;
    });

    return statements;
}

function createWebDavSensitiveAttemptStore({
    database,
    getDatabase,
    windowMs,
    maxAttempts,
    maxEntries,
    cleanupBatchSize = DEFAULT_CLEANUP_BATCH_SIZE,
    busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
} = {}) {
    if (!database && typeof getDatabase !== 'function') {
        throw new Error('createWebDavSensitiveAttemptStore requires database or getDatabase');
    }
    const resolveDatabase = typeof getDatabase === 'function' ? getDatabase : () => database;
    const safeWindowMs = positiveInteger(windowMs, 'windowMs');
    const safeMaxAttempts = positiveInteger(maxAttempts, 'maxAttempts');
    const safeMaxEntries = positiveInteger(maxEntries, 'maxEntries');
    const safeCleanupBatchSize = positiveInteger(cleanupBatchSize, 'cleanupBatchSize');
    const safeBusyTimeoutMs = positiveInteger(busyTimeoutMs, 'busyTimeoutMs');
    let boundDatabase = null;
    let statements = null;

    function binding(explicitDatabase) {
        const current = explicitDatabase || resolveDatabase();
        if (!current || typeof current.prepare !== 'function' || typeof current.transaction !== 'function') {
            throw new Error('database is unavailable');
        }
        if (current !== boundDatabase) {
            statements = createBinding(current, {
                maxAttempts: safeMaxAttempts,
                maxEntries: safeMaxEntries,
                cleanupBatchSize: safeCleanupBatchSize,
                busyTimeoutMs: safeBusyTimeoutMs,
            });
            boundDatabase = current;
        }
        return statements;
    }

    function consume({ userId, sessionId, clientIp, timestamp }) {
        const safeTimestamp = Number(timestamp);
        if (!Number.isFinite(safeTimestamp) || safeTimestamp < 0) throw new Error('timestamp is invalid');
        const windowStart = Math.floor(safeTimestamp / safeWindowMs) * safeWindowMs;
        return binding().consume({
            descriptors: makeBucketDescriptors({ userId, sessionId, clientIp }),
            timestamp: safeTimestamp,
            windowStart,
            expiresAt: windowStart + safeWindowMs,
        });
    }

    function deleteUserState(userId, { database: explicitDatabase } = {}) {
        const hash = ownerHash(userId);
        return binding(explicitDatabase).deleteOwner.run(hash).changes;
    }

    function entryCount({ timestamp = Date.now() } = {}) {
        const safeTimestamp = Number(timestamp);
        if (!Number.isFinite(safeTimestamp) || safeTimestamp < 0) throw new Error('timestamp is invalid');
        const current = binding();
        current.cleanupExpired.run(safeTimestamp, safeCleanupBatchSize);
        return Number(current.count.get()?.count) || 0;
    }

    return Object.freeze({ consume, deleteUserState, entryCount });
}

module.exports = {
    BUCKET_TYPES,
    DEFAULT_BUSY_TIMEOUT_MS,
    DEFAULT_CLEANUP_BATCH_SIZE,
    createWebDavSensitiveAttemptStore,
    ensureWebDavSensitiveAttemptSchema,
    makeBucketDescriptors,
    ownerHash,
};
