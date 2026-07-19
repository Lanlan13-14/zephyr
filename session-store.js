'use strict';
/*
 * session-store.js — SQLite-backed persistent app sessions.
 *
 * Design contract (FREEZE/TERMINAL_DEEPLINK_NOTES_PLAN.md §4.6, §18.1):
 * - Cookie carries a random SID; the database only stores SHA-256(SID).
 * - Sliding idle TTL + hard absolute TTL; remember-me gets longer limits.
 * - last_seen_at is persisted at most once per TOUCH_INTERVAL_MS per session.
 * - The in-memory Map is only a cache; SQLite is the authoritative source,
 *   so sessions survive process restarts and multi-replica routing.
 * - Revocation (logout, password change, suspend, admin action) wins over
 *   any cached entry.
 */
const crypto = require('crypto');

const TOUCH_INTERVAL_MS = 60 * 1000;

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function ipPrefixOf(ip) {
    const raw = String(ip || '').trim();
    if (!raw) return '';
    if (raw.includes('.')) return raw.split('.').slice(0, 3).join('.') + '.0/24';
    if (raw.includes(':')) return raw.split(':').slice(0, 4).join(':') + '::/64';
    return '';
}

class SessionStore {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {object} opts
     * @param {number} opts.idleTtlMs          sliding idle TTL for normal sessions
     * @param {number} opts.absoluteTtlMs      hard cap for normal sessions
     * @param {number} opts.rememberIdleTtlMs  sliding idle TTL for remember-me sessions
     * @param {number} opts.rememberAbsoluteTtlMs hard cap for remember-me sessions
     * @param {() => number} [opts.now]        clock injection for tests
     */
    constructor(db, opts) {
        if (!db) throw new Error('session store requires a database');
        this.db = db;
        this.idleTtlMs = Math.max(60 * 1000, Number(opts?.idleTtlMs) || 24 * 60 * 60 * 1000);
        this.absoluteTtlMs = Math.max(this.idleTtlMs, Number(opts?.absoluteTtlMs) || 7 * 24 * 60 * 60 * 1000);
        this.rememberIdleTtlMs = Math.max(this.idleTtlMs, Number(opts?.rememberIdleTtlMs) || 30 * 24 * 60 * 60 * 1000);
        this.rememberAbsoluteTtlMs = Math.max(this.rememberIdleTtlMs, Number(opts?.rememberAbsoluteTtlMs) || 90 * 24 * 60 * 60 * 1000);
        this.now = typeof opts?.now === 'function' ? opts.now : () => Date.now();
        /** @type {Map<string, object>} sid → cached session object */
        this.cache = new Map();

        this.stmtSelect = db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?');
        this.stmtInsert = db.prepare(`INSERT INTO auth_sessions
            (token_hash, user_id, username, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
             remember, must_change_password, revoked_at, revoke_reason, user_agent_hash, ip_prefix)
            VALUES (@tokenHash, @userId, @username, @createdAt, @lastSeenAt, @idleExpiresAt, @absoluteExpiresAt,
             @remember, @mustChangePassword, NULL, NULL, @userAgentHash, @ipPrefix)`);
        this.stmtTouch = db.prepare('UPDATE auth_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ? AND revoked_at IS NULL');
        this.stmtRevoke = db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE token_hash = ? AND revoked_at IS NULL');
        this.stmtRevokeAll = db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?');
        this.stmtListForUser = db.prepare('SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC');
        this.stmtClearMustChange = db.prepare('UPDATE auth_sessions SET must_change_password = ? WHERE user_id = ? AND revoked_at IS NULL');
        this.stmtRename = db.prepare('UPDATE auth_sessions SET username = ? WHERE user_id = ?');
        this.stmtGc = db.prepare('DELETE FROM auth_sessions WHERE revoked_at IS NOT NULL OR idle_expires_at < ? OR absolute_expires_at < ?');
    }

    _rowToSession(row) {
        if (!row) return null;
        return {
            sid: null, // filled by caller; never persisted
            tokenHash: row.token_hash,
            userId: row.user_id,
            username: row.username,
            createdAt: Number(row.created_at),
            lastSeenAt: Number(row.last_seen_at),
            idleExpiresAt: Number(row.idle_expires_at),
            absoluteExpiresAt: Number(row.absolute_expires_at),
            remember: !!row.remember,
            mustChangePassword: !!row.must_change_password,
            revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
            revokeReason: row.revoke_reason || null,
            persisted: true,
        };
    }

    _isLive(session, nowTs) {
        if (!session) return false;
        if (session.revokedAt) return false;
        if (nowTs > session.idleExpiresAt) return false;
        if (nowTs > session.absoluteExpiresAt) return false;
        return true;
    }

    /**
     * Create a new persistent session. Returns { sid, session }.
     * The sid is returned exactly once (to be placed in the cookie);
     * only its hash is kept in the database and cache index.
     */
    create({ userId, username, remember = false, mustChangePassword = false, userAgent = '', ip = '' }) {
        const sid = crypto.randomBytes(32).toString('base64url');
        const tokenHash = sha256(sid);
        const nowTs = this.now();
        const idleTtl = remember ? this.rememberIdleTtlMs : this.idleTtlMs;
        const absoluteTtl = remember ? this.rememberAbsoluteTtlMs : this.absoluteTtlMs;
        const record = {
            tokenHash,
            userId: String(userId),
            username: String(username),
            createdAt: nowTs,
            lastSeenAt: nowTs,
            idleExpiresAt: nowTs + idleTtl,
            absoluteExpiresAt: nowTs + absoluteTtl,
            remember: remember ? 1 : 0,
            mustChangePassword: mustChangePassword ? 1 : 0,
            userAgentHash: userAgent ? sha256(userAgent) : '',
            ipPrefix: ipPrefixOf(ip),
        };
        this.stmtInsert.run(record);
        const session = this._rowToSession({
            token_hash: record.tokenHash,
            user_id: record.userId,
            username: record.username,
            created_at: record.createdAt,
            last_seen_at: record.lastSeenAt,
            idle_expires_at: record.idleExpiresAt,
            absolute_expires_at: record.absoluteExpiresAt,
            remember: record.remember,
            must_change_password: record.mustChangePassword,
            revoked_at: null,
            revoke_reason: null,
        });
        session.sid = sid;
        this.cache.set(sid, session);
        return { sid, session };
    }

    /**
     * Resolve a sid from the cookie into a live session object, or null.
     * Slides the idle expiry forward, persisting at most once per minute.
     */
    resolve(sid, { touch = true } = {}) {
        if (!sid || typeof sid !== 'string') return null;
        const nowTs = this.now();
        let session = this.cache.get(sid) || null;
        if (!session) {
            const row = this.stmtSelect.get(sha256(sid));
            session = this._rowToSession(row);
            if (session) {
                session.sid = sid;
                this.cache.set(sid, session);
            }
        }
        if (!this._isLive(session, nowTs)) {
            if (session) this.cache.delete(sid);
            return null;
        }
        if (touch && nowTs - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
            const idleTtl = session.remember ? this.rememberIdleTtlMs : this.idleTtlMs;
            session.lastSeenAt = nowTs;
            session.idleExpiresAt = Math.min(nowTs + idleTtl, session.absoluteExpiresAt);
            this.stmtTouch.run(session.lastSeenAt, session.idleExpiresAt, session.tokenHash);
        }
        return session;
    }

    /** Resolve without any cache mutation; used for read-only checks. */
    peek(sid) {
        return this.resolve(sid, { touch: false });
    }

    revoke(sid, reason = 'logout') {
        if (!sid) return false;
        const tokenHash = sha256(sid);
        const session = this.cache.get(sid);
        if (session) {
            session.revokedAt = this.now();
            session.revokeReason = reason;
            this.cache.delete(sid);
        }
        return this.stmtRevoke.run(this.now(), String(reason).slice(0, 80), tokenHash).changes > 0;
    }

    /** Revoke every live session of a user. Returns number of revoked sessions. */
    revokeAllForUser(userId, reason = 'revoked', { exceptSid = '' } = {}) {
        const exceptHash = exceptSid ? sha256(exceptSid) : '';
        const nowTs = this.now();
        for (const [sid, session] of [...this.cache.entries()]) {
            if (session.userId === userId && sid !== exceptSid) {
                session.revokedAt = nowTs;
                session.revokeReason = reason;
                this.cache.delete(sid);
            }
        }
        return this.stmtRevokeAll.run(nowTs, String(reason).slice(0, 80), String(userId), exceptHash).changes;
    }

    /** List live sessions for a user (for /api/me/sessions). The token *hash*
     * is exposed as `id` — it is not usable as a credential but uniquely
     * identifies the session row for revocation. */
    listForUser(userId) {
        return this.stmtListForUser.all(String(userId)).map((row) => {
            const s = this._rowToSession(row);
            s.id = s.tokenHash;
            delete s.tokenHash;
            delete s.sid;
            return s;
        }).filter((s) => this._isLive(s, this.now()));
    }

    /** Revoke a specific session row belonging to a user (by token hash prefix id). */
    revokeForUser(userId, tokenHash, reason = 'user-revoked') {
        for (const [sid, session] of [...this.cache.entries()]) {
            if (session.tokenHash === tokenHash) {
                session.revokedAt = this.now();
                session.revokeReason = reason;
                this.cache.delete(sid);
            }
        }
        const row = this.stmtSelect.get(tokenHash);
        if (!row || row.user_id !== userId) return false;
        return this.stmtRevoke.run(this.now(), reason, tokenHash).changes > 0;
    }

    setMustChangePassword(userId, flag) {
        this.stmtClearMustChange.run(flag ? 1 : 0, String(userId));
        for (const session of this.cache.values()) {
            if (session.userId === userId) session.mustChangePassword = !!flag;
        }
    }

    renameUser(userId, newUsername) {
        this.stmtRename.run(String(newUsername), String(userId));
        for (const session of this.cache.values()) {
            if (session.userId === userId) session.username = String(newUsername);
        }
    }

    /** Drop expired/revoked rows. Returns deleted count. */
    gc() {
        const nowTs = this.now();
        for (const [sid, session] of [...this.cache.entries()]) {
            if (!this._isLive(session, nowTs)) this.cache.delete(sid);
        }
        return this.stmtGc.run(nowTs, nowTs).changes;
    }
}

module.exports = { SessionStore, sha256, ipPrefixOf, TOUCH_INTERVAL_MS };
