'use strict';

const crypto = require('crypto');
const { createWebDavSensitiveAttemptStore } = require('./webdav-sensitive-attempt-store');

const SENSITIVE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const SENSITIVE_RATE_LIMIT_MAX_ATTEMPTS = 5;
const SENSITIVE_RATE_LIMIT_MAX_ENTRIES = 10_000;

const RATE_LIMIT_RESPONSE = Object.freeze({
    ok: false,
    error: Object.freeze({
        code: 'webdav_sensitive_rate_limited',
        message: 'Too many sensitive verification attempts. Try again later.',
        retryable: true,
    }),
});

function defaultGetUserId(req) {
    return req.user?.userId
        || req.auth?.userId
        || req.authUser?.userId
        || req.session?.userId
        || '';
}

function defaultGetSessionId(req) {
    return req.session?.sid
        || req.session?.tokenHash
        || req.session?.id
        || req.auth?.sessionId
        || req.authSession?.sid
        || req.authSession?.tokenHash
        || '';
}

function defaultGetClientIp(req) {
    return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

function boundedString(value, maxLength) {
    const normalized = String(value || '').trim();
    return normalized.length > 0 && normalized.length <= maxLength ? normalized : '';
}

function makeRateLimitKey({ userId, sessionId }) {
    const user = boundedString(userId, 512);
    const session = boundedString(sessionId, 512);
    if (!user || !session) return '';
    // Compatibility helper for callers that need the session identity. The IP
    // is deliberately excluded; the durable store maintains it as a separate,
    // additional bucket.
    return crypto.createHash('sha256')
        .update(user).update('\0').update(session)
        .digest('base64url');
}

/**
 * Limits sensitive verification attempts before the WebDAV service operation
 * gate. All attempts consume a slot: a successful verification intentionally
 * does not reset the counter, so an attacker cannot probe a credential and
 * then erase its failed-attempt history by succeeding once.
 */
function createWebDavSensitiveRateLimiter({
    getUserId = defaultGetUserId,
    getSessionId = defaultGetSessionId,
    getClientIp = defaultGetClientIp,
    now = () => Date.now(),
    windowMs = SENSITIVE_RATE_LIMIT_WINDOW_MS,
    maxAttempts = SENSITIVE_RATE_LIMIT_MAX_ATTEMPTS,
    maxEntries = SENSITIVE_RATE_LIMIT_MAX_ENTRIES,
    cleanupBatchSize,
    busyTimeoutMs,
    database,
    getDatabase,
    attemptStore,
} = {}) {
    if (typeof getUserId !== 'function') throw new Error('getUserId must be a function');
    if (typeof getSessionId !== 'function') throw new Error('getSessionId must be a function');
    if (typeof getClientIp !== 'function') throw new Error('getClientIp must be a function');
    if (typeof now !== 'function') throw new Error('now must be a function');
    const store = attemptStore || createWebDavSensitiveAttemptStore({
        database,
        getDatabase,
        windowMs,
        maxAttempts,
        maxEntries,
        cleanupBatchSize,
        busyTimeoutMs,
    });
    if (!store || typeof store.consume !== 'function') throw new Error('attemptStore must provide consume()');

    function middleware(req, res, next) {
        const timestamp = Number(now());
        const safeTimestamp = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
        try {
            const allowed = store.consume({
                userId: getUserId(req),
                sessionId: getSessionId(req),
                clientIp: getClientIp(req),
                timestamp: safeTimestamp,
            });
            if (!allowed) return res.status(429).json(RATE_LIMIT_RESPONSE);
            return next();
        } catch {
            // SQLite contention, a closed/reopening handle, and malformed
            // identity all fail closed with the same non-enumerating response.
            return res.status(429).json(RATE_LIMIT_RESPONSE);
        }
    }

    // Introspection supports deterministic tests and operational health checks.
    middleware.entryCount = (options) => store.entryCount?.(options);
    middleware.deleteUserState = (userId, options) => store.deleteUserState(userId, options);
    return middleware;
}

module.exports = {
    RATE_LIMIT_RESPONSE,
    SENSITIVE_RATE_LIMIT_MAX_ATTEMPTS,
    SENSITIVE_RATE_LIMIT_MAX_ENTRIES,
    SENSITIVE_RATE_LIMIT_WINDOW_MS,
    createWebDavSensitiveRateLimiter,
    defaultGetClientIp,
    defaultGetSessionId,
    defaultGetUserId,
    makeRateLimitKey,
};
