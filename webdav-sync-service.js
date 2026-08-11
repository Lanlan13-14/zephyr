'use strict';

const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const ipaddr = require('ipaddr.js');
const defaultSecretCrypto = require('./secret-crypto');

const BACKUP_FILE = 'zephyr-backup.bin';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const RETRYABLE_METHODS = new Set(['OPTIONS', 'PROPFIND', 'GET']);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
    'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);

const PUBLIC_MESSAGES = Object.freeze({
    webdav_not_configured: 'WebDAV backup is not configured.',
    webdav_disabled: 'WebDAV backup is disabled.',
    webdav_invalid_config: 'The WebDAV configuration is invalid.',
    webdav_insecure_url: 'WebDAV requires HTTPS.',
    webdav_ssrf_blocked: 'The WebDAV host is not allowed.',
    webdav_dns_failed: 'The WebDAV host could not be resolved.',
    webdav_timeout: 'The WebDAV server timed out.',
    webdav_unavailable: 'The WebDAV server is unavailable.',
    webdav_auth_failed: 'WebDAV authentication failed.',
    webdav_forbidden: 'The WebDAV operation was denied.',
    webdav_not_found: 'The WebDAV resource was not found.',
    webdav_conflict: 'The remote backup changed. No data was overwritten.',
    webdav_protocol_error: 'The WebDAV server returned an invalid response.',
    webdav_response_too_large: 'The WebDAV response exceeded the safety limit.',
    webdav_backup_too_large: 'The backup exceeded the configured size limit.',
    webdav_sync_in_progress: 'A WebDAV backup is already in progress.',
    webdav_backup_failed: 'The WebDAV backup failed.',
    webdav_unauthorized: 'Authentication is required.',
    webdav_rate_limited: 'Too many WebDAV operations are in progress. Try again later.',
    webdav_config_changed: 'The WebDAV configuration changed during the backup.',
    webdav_request_aborted: 'The WebDAV request was cancelled.',
    webdav_sync_unknown: 'The WebDAV backup may have completed. Verify the remote backup before retrying.',
});

class WebDavSyncError extends Error {
    constructor(status, code, retryable = false) {
        super(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.webdav_backup_failed);
        this.name = 'WebDavSyncError';
        this.status = Number(status) || 500;
        this.code = code || 'webdav_backup_failed';
        this.retryable = !!retryable;
    }
}

function fail(status, code, retryable = false) {
    throw new WebDavSyncError(status, code, retryable);
}

function abortError(signal) {
    if (signal?.reason instanceof WebDavSyncError) return signal.reason;
    return new WebDavSyncError(499, 'webdav_request_aborted', true);
}

function publicWebDavError(error) {
    if (error instanceof WebDavSyncError) {
        return {
            status: error.status,
            code: error.code,
            message: PUBLIC_MESSAGES[error.code] || PUBLIC_MESSAGES.webdav_backup_failed,
            retryable: !!error.retryable,
        };
    }
    return { status: 500, code: 'webdav_backup_failed', message: PUBLIC_MESSAGES.webdav_backup_failed, retryable: false };
}

function decodeSegment(raw) {
    let value = String(raw);
    let stable = false;
    for (let i = 0; i < 512; i += 1) {
        let next;
        try { next = decodeURIComponent(value); } catch { fail(400, 'webdav_invalid_config'); }
        if (next === value) {
            stable = true;
            break;
        }
        value = next;
    }
    if (!stable) fail(400, 'webdav_invalid_config');
    if (!value || value === '.' || value === '..' || /[\\/\0-\x1f\x7f]/.test(value)) {
        fail(400, 'webdav_invalid_config');
    }
    if (value.length > 180) fail(400, 'webdav_invalid_config');
    return value.normalize('NFC');
}

function canonicalPath(rawPath, { allowEmpty = true } = {}) {
    if (rawPath === undefined || rawPath === null) return allowEmpty ? '' : fail(400, 'webdav_invalid_config');
    const input = String(rawPath).trim();
    if (!input) return allowEmpty ? '' : fail(400, 'webdav_invalid_config');
    if (input.length > 1024 || /[\\?#\0-\x1f\x7f]/.test(input)) fail(400, 'webdav_invalid_config');
    const stripped = input.replace(/^\/+|\/+$/g, '');
    if (!stripped) return allowEmpty ? '' : fail(400, 'webdav_invalid_config');
    const rawSegments = stripped.split('/');
    if (rawSegments.some((segment) => !segment)) fail(400, 'webdav_invalid_config');
    return rawSegments.map((segment) => encodeURIComponent(decodeSegment(segment))).join('/');
}

function rawUrlPath(input) {
    const match = String(input).match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/);
    return match?.[1] || '/';
}

function validateBaseUrl(input, { allowHttpLoopback = false } = {}) {
    const raw = String(input || '');
    if (!raw || raw !== raw.trim() || raw.length > 2048 || /[\0-\x20\x7f\\]/.test(raw)) {
        fail(400, 'webdav_invalid_config');
    }
    let parsed;
    try { parsed = new URL(raw); } catch { fail(400, 'webdav_invalid_config'); }
    if (!['https:', 'http:'].includes(parsed.protocol)) fail(400, 'webdav_invalid_config');
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
        fail(400, 'webdav_invalid_config');
    }
    if (parsed.port && Number(parsed.port) < 1) fail(400, 'webdav_invalid_config');
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (parsed.protocol === 'http:' && !(allowHttpLoopback && isLoopbackHostname(hostname))) {
        fail(400, 'webdav_insecure_url');
    }
    const path = canonicalPath(rawUrlPath(raw), { allowEmpty: true });
    parsed.pathname = path ? `/${path}/` : '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
}

function canonicalOrigin(baseUrl) {
    try { return new URL(String(baseUrl || '')).origin; } catch { fail(400, 'webdav_invalid_config'); }
}

function isLoopbackHostname(hostname) {
    const value = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (value === 'localhost' || value.endsWith('.localhost')) return true;
    if (!net.isIP(value)) return false;
    try { return ipaddr.process(value).range() === 'loopback'; } catch { return false; }
}

function validateAddress(address, { allowLoopback = false } = {}) {
    let parsed;
    try { parsed = ipaddr.process(String(address).split('%')[0]); } catch { fail(400, 'webdav_ssrf_blocked'); }
    const range = parsed.range();
    if (range === 'unicast') return String(parsed);
    if (range === 'loopback' && allowLoopback) return String(parsed);
    fail(400, 'webdav_ssrf_blocked');
}

function userNamespace(userId) {
    const id = String(userId || '');
    if (!id || id.length > 512 || /[\0-\x1f\x7f]/.test(id)) fail(401, 'webdav_invalid_config');
    return `u-${crypto.createHash('sha256').update(id).digest('base64url').slice(0, 32)}`;
}

function normalizeEtag(value) {
    const etag = String(value || '').trim();
    if (!etag || etag.length > 256 || /[\0-\x1f\x7f]/.test(etag)) return '';
    if (!/^"[^"\r\n]*"$/.test(etag)) return '';
    return etag;
}

function contentTypeHeader(value) {
    const type = String(value || 'application/octet-stream');
    if (type !== type.trim() || type.length > 255 || !/^[\x20-\x7e]+$/.test(type)) {
        fail(400, 'webdav_invalid_config');
    }
    return type;
}

function conditionalHeaders(input = {}) {
    const output = {};
    for (const [name, rawValue] of Object.entries(input || {})) {
        const lower = String(name).toLowerCase();
        if (lower !== 'if-match' && lower !== 'if-none-match') fail(400, 'webdav_invalid_config');
        const value = String(rawValue || '').trim();
        if (value !== '*' && !normalizeEtag(value)) fail(400, 'webdav_invalid_config');
        output[lower === 'if-match' ? 'If-Match' : 'If-None-Match'] = value;
    }
    return output;
}

function extractDavEtag(body) {
    const xml = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail(502, 'webdav_protocol_error');
    const match = xml.match(/<(?:[A-Za-z_][\w.-]*:)?getetag\b[^>]*>([^<]{1,512})<\/(?:[A-Za-z_][\w.-]*:)?getetag\s*>/i);
    if (!match) return '';
    const value = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    return normalizeEtag(value);
}

function responseHeaders(headers) {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(headers || {})) {
        if (value !== undefined) out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return out;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class OperationGate {
    constructor({
        maxConcurrentGlobal = 4,
        maxConcurrentPerUser = 1,
        rateWindowMs = 60_000,
        maxOperationsGlobal = 100,
        maxOperationsPerUser = 10,
    } = {}) {
        this.maxConcurrentGlobal = Math.max(1, Math.min(64, Number(maxConcurrentGlobal) || 4));
        this.maxConcurrentPerUser = Math.max(1, Math.min(8, Number(maxConcurrentPerUser) || 1));
        this.rateWindowMs = Math.max(100, Math.min(60 * 60_000, Number(rateWindowMs) || 60_000));
        this.maxOperationsGlobal = Math.max(1, Math.min(10_000, Number(maxOperationsGlobal) || 100));
        this.maxOperationsPerUser = Math.max(1, Math.min(1_000, Number(maxOperationsPerUser) || 10));
        this.activeGlobal = 0;
        this.activeUsers = new Map();
        this.globalStarts = [];
        this.userStarts = new Map();
    }

    acquire(userId) {
        const key = String(userId);
        const timestamp = Date.now();
        const cutoff = timestamp - this.rateWindowMs;
        this.globalStarts = this.globalStarts.filter((value) => value > cutoff);
        if (this.userStarts.size > 10_000) {
            for (const [id, starts] of this.userStarts) {
                if (!starts.length || starts[starts.length - 1] <= cutoff) this.userStarts.delete(id);
            }
        }
        const userStarts = (this.userStarts.get(key) || []).filter((value) => value > cutoff);
        if (this.activeGlobal >= this.maxConcurrentGlobal
            || (this.activeUsers.get(key) || 0) >= this.maxConcurrentPerUser
            || this.globalStarts.length >= this.maxOperationsGlobal
            || userStarts.length >= this.maxOperationsPerUser) {
            fail(429, 'webdav_rate_limited', true);
        }
        this.globalStarts.push(timestamp);
        userStarts.push(timestamp);
        this.userStarts.set(key, userStarts);
        this.activeGlobal += 1;
        this.activeUsers.set(key, (this.activeUsers.get(key) || 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.activeGlobal = Math.max(0, this.activeGlobal - 1);
            const remaining = Math.max(0, (this.activeUsers.get(key) || 1) - 1);
            if (remaining) this.activeUsers.set(key, remaining);
            else this.activeUsers.delete(key);
        };
    }
}

class WebDavSyncService {
    constructor({
        db,
        secretCrypto = defaultSecretCrypto,
        backupProvider,
        now = () => Date.now(),
        lookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true }),
        allowHttpLoopback = false,
        allowLoopback = false,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxRetries = 2,
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        maxBackupBytes = DEFAULT_MAX_BACKUP_BYTES,
        retryDelay = sleep,
        operationDeadlineMs = 120_000,
        operationLimits,
    } = {}) {
        if (!db?.prepare || !db?.exec) throw new Error('WebDavSyncService requires a database');
        if (!secretCrypto?.encryptSecret || !secretCrypto?.decryptSecret) throw new Error('WebDavSyncService requires secret crypto');
        this.db = db;
        this.secretCrypto = secretCrypto;
        this.backupProvider = backupProvider;
        this.now = now;
        this.lookup = lookup;
        this.allowHttpLoopback = !!allowHttpLoopback;
        this.allowLoopback = !!allowLoopback || !!allowHttpLoopback;
        this.timeoutMs = Math.max(50, Math.min(120_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
        this.maxRetries = Math.max(0, Math.min(3, Number(maxRetries) || 0));
        this.maxResponseBytes = Math.max(1024, Math.min(8 * 1024 * 1024, Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES));
        this.maxBackupBytes = Math.max(1024, Math.min(1024 * 1024 * 1024, Number(maxBackupBytes) || DEFAULT_MAX_BACKUP_BYTES));
        this.retryDelay = retryDelay;
        this.operationDeadlineMs = Math.max(50, Math.min(10 * 60_000, Number(operationDeadlineMs) || 120_000));
        this.operationGate = new OperationGate(operationLimits);
        this.activeOperations = new Map();
        this.activeCompletions = new Set();
        this.activeCompletionsByUser = new Map();
        this.closed = false;
        this._schema();
    }

    _schema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS webdav_sync_configs (
                user_id TEXT PRIMARY KEY,
                base_url TEXT NOT NULL,
                remote_path TEXT NOT NULL DEFAULT '',
                username_enc TEXT,
                password_enc TEXT,
                credential_origin TEXT,
                enabled INTEGER NOT NULL DEFAULT 0,
                config_version INTEGER NOT NULL DEFAULT 1,
                config_epoch TEXT NOT NULL,
                last_etag TEXT,
                last_synced_at INTEGER,
                last_error_code TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        const columns = new Set(this.db.prepare('PRAGMA table_info(webdav_sync_configs)').all().map((column) => column.name));
        if (!columns.has('credential_origin')) this.db.exec('ALTER TABLE webdav_sync_configs ADD COLUMN credential_origin TEXT');
        if (!columns.has('config_version')) this.db.exec('ALTER TABLE webdav_sync_configs ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1');
        if (!columns.has('config_epoch')) this.db.exec('ALTER TABLE webdav_sync_configs ADD COLUMN config_epoch TEXT');
        this.db.prepare('UPDATE webdav_sync_configs SET config_version=1 WHERE config_version IS NULL OR config_version < 1').run();
        this.db.prepare("UPDATE webdav_sync_configs SET config_epoch=lower(hex(randomblob(16))) WHERE config_epoch IS NULL OR config_epoch='' ").run();
    }

    _aad(userId, origin, field) { return `webdav-sync:${userId}:${origin}:${field}`; }
    _encrypt(userId, origin, field, value) {
        if (!value) return null;
        return this.secretCrypto.encryptSecret(String(value), this._aad(userId, origin, field));
    }
    _decrypt(userId, origin, field, value) {
        if (!value) return '';
        return this.secretCrypto.decryptSecret(value, this._aad(userId, origin, field));
    }
    _row(userId) {
        return this.db.prepare('SELECT * FROM webdav_sync_configs WHERE user_id=?').get(String(userId));
    }
    _credentialOrigin(row) {
        if (!row?.credential_origin) return '';
        try {
            const origin = canonicalOrigin(validateBaseUrl(row.base_url, { allowHttpLoopback: this.allowHttpLoopback }));
            return row.credential_origin === origin ? origin : '';
        } catch {
            return '';
        }
    }
    _publicRow(row) {
        if (!row) {
            return {
                configured: false, enabled: false, baseUrl: '', remotePath: '', username: '',
                hasPassword: false, version: 0, lastEtag: null, lastSyncedAt: null, lastErrorCode: null,
            };
        }
        const credentialOrigin = this._credentialOrigin(row);
        return {
            configured: true,
            enabled: !!row.enabled,
            baseUrl: row.base_url,
            remotePath: row.remote_path,
            username: credentialOrigin ? this._decrypt(row.user_id, credentialOrigin, 'username', row.username_enc) : '',
            hasPassword: !!credentialOrigin && !!row.password_enc,
            version: Math.max(1, Number(row.config_version) || 1),
            lastEtag: normalizeEtag(row.last_etag) || null,
            lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
            lastErrorCode: row.last_error_code || null,
            updatedAt: Number(row.updated_at),
        };
    }

    getConfig(userId) {
        userNamespace(userId);
        return this._publicRow(this._row(userId));
    }

    patchConfig(userId, patch = {}, operation = {}) {
        userNamespace(userId);
        this._assertOperation(operation);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'webdav_invalid_config');
        const allowed = new Set(['baseUrl', 'remotePath', 'username', 'password', 'enabled']);
        if (Object.keys(patch).some((key) => !allowed.has(key))) fail(400, 'webdav_invalid_config');
        const current = this._row(userId);
        const baseUrl = validateBaseUrl(
            patch.baseUrl === undefined ? current?.base_url : patch.baseUrl,
            { allowHttpLoopback: this.allowHttpLoopback },
        );
        const remotePath = canonicalPath(
            patch.remotePath === undefined ? current?.remote_path || '' : patch.remotePath,
            { allowEmpty: true },
        );
        const origin = canonicalOrigin(baseUrl);
        const currentOrigin = this._credentialOrigin(current);
        const originChanged = !!current && origin !== canonicalOrigin(current.base_url);
        const canInheritCredentials = !!currentOrigin && currentOrigin === origin && !originChanged;
        const currentUsername = canInheritCredentials
            ? this._decrypt(userId, currentOrigin, 'username', current.username_enc)
            : '';
        const username = patch.username === undefined ? currentUsername : String(patch.username || '');
        if (username.length > 512 || /[\0\r\n]/.test(username)) fail(400, 'webdav_invalid_config');
        let passwordEnc = canInheritCredentials ? current?.password_enc || null : null;
        if (patch.password !== undefined) {
            const password = String(patch.password || '');
            if (password.length > 4096 || /[\0\r\n]/.test(password)) fail(400, 'webdav_invalid_config');
            passwordEnc = this._encrypt(userId, origin, 'password', password);
        }
        const usernameEnc = this._encrypt(userId, origin, 'username', username);
        const enabled = patch.enabled === undefined ? !!current?.enabled : patch.enabled === true;
        const targetChanged = !!current && (current.base_url !== baseUrl || current.remote_path !== remotePath);
        const configVersion = current ? Math.max(1, Number(current.config_version) || 1) + 1 : 1;
        const configEpoch = crypto.randomUUID();
        const timestamp = this.now();
        this._assertOperation(operation);
        this.db.prepare(`INSERT INTO webdav_sync_configs
            (user_id,base_url,remote_path,username_enc,password_enc,credential_origin,enabled,config_version,config_epoch,last_etag,last_synced_at,last_error_code,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
                base_url=excluded.base_url,remote_path=excluded.remote_path,username_enc=excluded.username_enc,
                password_enc=excluded.password_enc,credential_origin=excluded.credential_origin,
                enabled=excluded.enabled,config_version=excluded.config_version,config_epoch=excluded.config_epoch,last_etag=excluded.last_etag,
                last_synced_at=excluded.last_synced_at,last_error_code=excluded.last_error_code,
                updated_at=excluded.updated_at`
        ).run(
            String(userId), baseUrl, remotePath, usernameEnc, passwordEnc, origin, enabled ? 1 : 0, configVersion, configEpoch,
            targetChanged ? null : current?.last_etag || null,
            targetChanged ? null : current?.last_synced_at || null,
            targetChanged ? null : current?.last_error_code || null,
            current?.created_at || timestamp, timestamp,
        );
        if (current) this._abortActiveOperations(userId, new WebDavSyncError(409, 'webdav_config_changed'));
        return this.getConfig(userId);
    }

    _privateConfig(userId, overrides = null) {
        const row = this._row(userId);
        if (!row && !overrides) fail(400, 'webdav_not_configured');
        const input = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
        const allowed = new Set(['baseUrl', 'remotePath', 'username', 'password']);
        if (Object.keys(input).some((key) => !allowed.has(key))) fail(400, 'webdav_invalid_config');
        const baseUrl = validateBaseUrl(
            input.baseUrl === undefined ? row?.base_url : input.baseUrl,
            { allowHttpLoopback: this.allowHttpLoopback },
        );
        const remotePath = canonicalPath(input.remotePath === undefined ? row?.remote_path || '' : input.remotePath);
        const origin = canonicalOrigin(baseUrl);
        const storedOrigin = this._credentialOrigin(row);
        const canInheritCredentials = !!storedOrigin && storedOrigin === origin;
        const username = input.username === undefined
            ? (canInheritCredentials ? this._decrypt(userId, storedOrigin, 'username', row.username_enc) : '')
            : String(input.username || '');
        const password = input.password === undefined
            ? (canInheritCredentials ? this._decrypt(userId, storedOrigin, 'password', row.password_enc) : '')
            : String(input.password || '');
        if (username.length > 512 || password.length > 4096 || /[\0\r\n]/.test(username) || /[\0\r\n]/.test(password)) {
            fail(400, 'webdav_invalid_config');
        }
        return { baseUrl, remotePath, username, password, row };
    }

    _assertOperation(operation) {
        if (operation?.signal?.aborted) {
            throw abortError(operation.signal);
        }
        if (operation?.deadlineAt && Date.now() >= operation.deadlineAt) {
            fail(504, 'webdav_timeout', true);
        }
    }

    _operationTimeout(operation) {
        this._assertOperation(operation);
        if (!operation?.deadlineAt) return this.timeoutMs;
        return Math.max(1, Math.min(this.timeoutMs, operation.deadlineAt - Date.now()));
    }

    async _withActiveOperation(userId, name, work, callerOperation = {}) {
        if (this.closed) fail(503, 'webdav_unavailable', true);
        const key = String(userId);
        const release = this.operationGate.acquire(key);
        const controller = new AbortController();
        const operation = { name, signal: controller.signal, deadlineAt: Date.now() + this.operationDeadlineMs };
        let onCallerAbort;
        const callerSignal = callerOperation?.signal;
        if (callerSignal && typeof callerSignal.addEventListener === 'function') {
            onCallerAbort = () => controller.abort(abortError(callerSignal));
            if (callerSignal.aborted) onCallerAbort();
            else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }
        const active = this.activeOperations.get(key) || new Set();
        active.add(controller);
        this.activeOperations.set(key, active);
        const workPromise = Promise.resolve().then(() => {
            this._assertOperation(operation);
            return work(operation);
        });
        const completion = workPromise.then(() => undefined, () => undefined);
        this.activeCompletions.add(completion);
        const completions = this.activeCompletionsByUser.get(key) || new Set();
        completions.add(completion);
        this.activeCompletionsByUser.set(key, completions);
        completion.finally(() => {
            this.activeCompletions.delete(completion);
            completions.delete(completion);
            if (!completions.size) this.activeCompletionsByUser.delete(key);
        });
        let timer;
        let onAbort;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const reason = new WebDavSyncError(504, 'webdav_timeout', true);
                controller.abort(reason);
                if (!operation.publishStarted) reject(reason);
            }, this.operationDeadlineMs);
        });
        const aborted = new Promise((_, reject) => {
            onAbort = () => {
                if (!operation.publishStarted) reject(abortError(controller.signal));
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
        });
        try {
            return await Promise.race([workPromise, deadline, aborted]);
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', onAbort);
            if (onCallerAbort) callerSignal.removeEventListener('abort', onCallerAbort);
            controller.abort();
            active.delete(controller);
            if (!active.size) this.activeOperations.delete(key);
            release();
        }
    }

    deleteConfig(userId, operation = {}) {
        const key = String(userId);
        userNamespace(key);
        this._assertOperation(operation);
        this._abortActiveOperations(key, new WebDavSyncError(409, 'webdav_config_changed'));
        this._assertOperation(operation);
        const result = this.db.prepare('DELETE FROM webdav_sync_configs WHERE user_id=?').run(key);
        return !!result.changes;
    }

    /**
     * Delete credentials immediately, then wait for aborted work to run its
     * captured-target cleanup. HTTP callers use this before acknowledging a
     * removal; account lifecycle hooks retain the synchronous deleteConfig()
     * form because they execute inside a SQLite transaction.
     */
    async deleteConfigAndDrain(userId, operation = {}) {
        const key = String(userId);
        userNamespace(key);
        this._assertOperation(operation);
        const completions = [...(this.activeCompletionsByUser.get(key) || [])];
        const deleted = this.deleteConfig(key, operation);
        await Promise.allSettled(completions);
        return deleted;
    }

    _abortActiveOperations(userId, reason) {
        for (const controller of this.activeOperations.get(String(userId)) || []) controller.abort(reason);
    }

    close() {
        if (this.closed) return Promise.allSettled([...this.activeCompletions]);
        this.closed = true;
        const reason = new WebDavSyncError(503, 'webdav_unavailable', true);
        for (const controllers of this.activeOperations.values()) {
            for (const controller of controllers) controller.abort(reason);
        }
        return Promise.allSettled([...this.activeCompletions]);
    }

    async _resolve(url, operation) {
        this._assertOperation(operation);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        let records;
        if (net.isIP(hostname)) {
            records = [{ address: hostname, family: net.isIP(hostname) }];
        } else {
            let timer;
            let onAbort;
            try {
                records = await Promise.race([
                    Promise.resolve().then(() => this.lookup(hostname)),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new WebDavSyncError(504, 'webdav_timeout', true)), this._operationTimeout(operation));
                    }),
                    new Promise((_, reject) => {
                        if (!operation?.signal) return;
                        onAbort = () => reject(abortError(operation.signal));
                        operation.signal.addEventListener('abort', onAbort, { once: true });
                    }),
                ]);
            } catch (error) {
                if (error instanceof WebDavSyncError) throw error;
                fail(400, 'webdav_dns_failed');
            } finally {
                clearTimeout(timer);
                if (onAbort) operation.signal.removeEventListener('abort', onAbort);
            }
        }
        if (!Array.isArray(records)) records = [records];
        const valid = records.map((record) => {
            const address = typeof record === 'string' ? record : record?.address;
            const normalized = validateAddress(address, { allowLoopback: this.allowLoopback });
            return { address: normalized, family: net.isIP(normalized) };
        });
        if (!valid.length) fail(400, 'webdav_dns_failed');
        return valid;
    }

    _rootUrl(config, userId) {
        const url = new URL(config.baseUrl);
        const parts = [url.pathname.replace(/^\/+|\/+$/g, ''), config.remotePath, userNamespace(userId)].filter(Boolean);
        url.pathname = `/${parts.join('/')}/`;
        return url;
    }

    _relativeUrl(config, userId, relativePath = '', { collection = false } = {}) {
        const url = this._rootUrl(config, userId);
        const relative = canonicalPath(relativePath, { allowEmpty: true });
        if (relative) url.pathname += relative;
        if (collection && !url.pathname.endsWith('/')) url.pathname += '/';
        return url;
    }

    _collectionUrls(config, userId) {
        const base = new URL(config.baseUrl);
        const baseParts = base.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
        const parts = [...baseParts, ...config.remotePath.split('/').filter(Boolean), userNamespace(userId)];
        const urls = [];
        for (let count = baseParts.length + 1; count <= parts.length; count += 1) {
            const url = new URL(config.baseUrl);
            url.pathname = `/${parts.slice(0, count).join('/')}/`;
            urls.push(url);
        }
        return urls;
    }

    async _once(config, url, method, {
        body = null,
        headers = {},
        maxResponseBytes,
        allowBackupResponse = false,
        operation,
    } = {}) {
        const addresses = await this._resolve(url, operation);
        this._assertOperation(operation);
        const transport = url.protocol === 'https:' ? https : http;
        const requestTimeout = this._operationTimeout(operation);
        const responseCeiling = allowBackupResponse ? this.maxBackupBytes : this.maxResponseBytes;
        const limit = Math.max(0, Math.min(responseCeiling, Number(maxResponseBytes) || responseCeiling));
        const payload = body === null || body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
        const requestHeaders = {
            Accept: '*/*',
            'Accept-Encoding': 'identity',
            'User-Agent': 'Zephyr-WebDAV-Backup/1',
            ...headers,
        };
        if (config.username || config.password) {
            requestHeaders.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
        }
        if (payload && requestHeaders['Content-Length'] === undefined && requestHeaders['content-length'] === undefined) {
            requestHeaders['Content-Length'] = String(payload.length);
        }
        return new Promise((resolve, reject) => {
            let timedOut = false;
            let hardTimer;
            let onAbort;
            let settled = false;
            const safeResolve = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimer);
                if (onAbort) operation.signal.removeEventListener('abort', onAbort);
                resolve(value);
            };
            const safeReject = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimer);
                if (onAbort) operation.signal.removeEventListener('abort', onAbort);
                reject(error);
            };
            const req = transport.request(url, {
                method,
                headers: requestHeaders,
                agent: false,
                lookup: (_hostname, options, callback) => {
                    const selected = addresses[0];
                    if (options?.all) callback(null, addresses);
                    else callback(null, selected.address, selected.family);
                },
            }, (res) => {
                if (settled) {
                    res.destroy();
                    return;
                }
                const chunks = [];
                let size = 0;
                let responseLimited = false;
                const declaredLength = Number(res.headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > limit) {
                    responseLimited = true;
                    safeReject(new WebDavSyncError(502, 'webdav_response_too_large'));
                    res.destroy();
                    req.destroy();
                    return;
                }
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > limit) {
                        if (!responseLimited) {
                            responseLimited = true;
                            safeReject(new WebDavSyncError(502, 'webdav_response_too_large'));
                            res.destroy();
                            req.destroy();
                        }
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (!responseLimited) {
                        safeResolve({
                            status: Number(res.statusCode) || 0,
                            headers: responseHeaders(res.headers),
                            body: Buffer.concat(chunks),
                        });
                    }
                });
            });
            req.setTimeout(requestTimeout, () => {
                timedOut = true;
                req.destroy(Object.assign(new Error('timeout'), { code: 'ZEPHYR_TIMEOUT' }));
            });
            req.on('error', (error) => {
                if (timedOut || error?.code === 'ZEPHYR_TIMEOUT') return safeReject(new WebDavSyncError(504, 'webdav_timeout', true));
                return safeReject(new WebDavSyncError(502, 'webdav_unavailable', TRANSIENT_CODES.has(error?.code)));
            });
            if (operation?.signal) {
                onAbort = () => {
                    timedOut = true;
                    safeReject(abortError(operation.signal));
                    req.destroy();
                };
                operation.signal.addEventListener('abort', onAbort, { once: true });
                if (operation.signal.aborted) {
                    onAbort();
                    return;
                }
            }
            hardTimer = setTimeout(() => {
                timedOut = true;
                safeReject(new WebDavSyncError(504, 'webdav_timeout', true));
                req.destroy();
            }, requestTimeout);
            try {
                this._assertOperation(operation);
            } catch (error) {
                safeReject(error);
                req.destroy();
                return;
            }
            if (payload) req.end(payload);
            else req.end();
        });
    }

    async _request(config, url, method, options = {}) {
        const upper = String(method).toUpperCase();
        const retries = RETRYABLE_METHODS.has(upper) ? this.maxRetries : 0;
        for (let attempt = 0; ; attempt += 1) {
            this._assertOperation(options.operation);
            try {
                const response = await this._once(config, url, upper, options);
                this._assertOperation(options.operation);
                if (attempt < retries && RETRYABLE_STATUSES.has(response.status)) {
                    await this._retryDelay(Math.min(500, 50 * (2 ** attempt)), options.operation);
                    continue;
                }
                return response;
            } catch (error) {
                if (attempt < retries && error instanceof WebDavSyncError && error.retryable) {
                    await this._retryDelay(Math.min(500, 50 * (2 ** attempt)), options.operation);
                    continue;
                }
                throw error;
            }
        }
    }

    async _retryDelay(delayMs, operation) {
        this._assertOperation(operation);
        if (!operation?.signal) {
            await this.retryDelay(delayMs);
            return;
        }
        let onAbort;
        try {
            await Promise.race([
                this.retryDelay(delayMs),
                new Promise((_, reject) => {
                    onAbort = () => reject(abortError(operation.signal));
                    operation.signal.addEventListener('abort', onAbort, { once: true });
                }),
            ]);
        } finally {
            if (onAbort) operation.signal.removeEventListener('abort', onAbort);
        }
        this._assertOperation(operation);
    }

    _expect(response, statuses) {
        if (statuses.includes(response.status)) return response;
        if ([301, 302, 303, 307, 308].includes(response.status)) fail(502, 'webdav_protocol_error');
        if (response.status === 401) fail(401, 'webdav_auth_failed');
        if (response.status === 403) fail(403, 'webdav_forbidden');
        if (response.status === 404) fail(404, 'webdav_not_found');
        if ([409, 412, 423].includes(response.status)) fail(409, 'webdav_conflict');
        if (RETRYABLE_STATUSES.has(response.status)) fail(503, 'webdav_unavailable', true);
        fail(502, 'webdav_protocol_error');
    }

    async _primitive(userId, method, relativePath, options = {}) {
        const config = this._privateConfig(userId);
        const url = this._relativeUrl(config, userId, relativePath, { collection: !!options.collection });
        return this._request(config, url, method, options);
    }

    options(userId, relativePath = '') {
        return this._primitive(userId, 'OPTIONS', relativePath, { maxResponseBytes: 64 * 1024 });
    }
    async propfind(userId, relativePath = '', { depth = 0, headers = {} } = {}) {
        if (![0, 1].includes(Number(depth))) fail(400, 'webdav_invalid_config');
        const response = await this._primitive(userId, 'PROPFIND', relativePath, {
            collection: !relativePath,
            headers: {
                Depth: String(depth),
                'Content-Type': 'application/xml; charset=utf-8',
                ...conditionalHeaders(headers),
            },
            body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>',
        });
        if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(response.body.toString('utf8'))) fail(502, 'webdav_protocol_error');
        return response;
    }
    mkcol(userId, relativePath) {
        return this._primitive(userId, 'MKCOL', relativePath, { collection: true, maxResponseBytes: 64 * 1024 });
    }
    get(userId, relativePath) { return this._primitive(userId, 'GET', relativePath); }
    put(userId, relativePath, body, { etag = null, contentType = 'application/octet-stream', createOnly = false, operation } = {}) {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
        if (payload.length > this.maxBackupBytes) fail(413, 'webdav_backup_too_large');
        const match = etag === null ? '' : normalizeEtag(etag);
        if (etag !== null && !match) fail(400, 'webdav_invalid_config');
        return this._primitive(userId, 'PUT', relativePath, {
            body: payload,
            headers: {
                'Content-Type': contentTypeHeader(contentType),
                ...(createOnly ? { 'If-None-Match': '*' } : {}),
                ...(match ? { 'If-Match': match } : {}),
            },
            maxResponseBytes: 64 * 1024,
            operation,
        });
    }
    async move(userId, sourcePath, destinationPath, { overwrite = false, sourceEtag = null, destinationEtag = null, operation } = {}) {
        const config = this._privateConfig(userId);
        const source = this._relativeUrl(config, userId, sourcePath);
        const destination = this._relativeUrl(config, userId, destinationPath);
        const sourceMatch = sourceEtag === null ? '' : normalizeEtag(sourceEtag);
        const destinationMatch = destinationEtag === null ? '' : normalizeEtag(destinationEtag);
        if ((sourceEtag !== null && !sourceMatch) || (destinationEtag !== null && !destinationMatch)) {
            fail(400, 'webdav_invalid_config');
        }
        return this._request(config, source, 'MOVE', {
            headers: {
                Destination: destination.toString(),
                Overwrite: overwrite ? 'T' : 'F',
                ...(sourceMatch ? { 'If-Match': sourceMatch } : {}),
                ...(destinationMatch ? { If: `<${destination.toString()}> ([${destinationMatch}])` } : {}),
            },
            maxResponseBytes: 64 * 1024,
            operation,
        });
    }
    delete(userId, relativePath, { etag = null, operation } = {}) {
        const match = etag === null ? '' : normalizeEtag(etag);
        if (etag !== null && !match) fail(400, 'webdav_invalid_config');
        return this._primitive(userId, 'DELETE', relativePath, {
            headers: match ? { 'If-Match': match } : {},
            maxResponseBytes: 64 * 1024,
            operation,
        });
    }

    async _ensureCollections(config, userId, operation) {
        for (const url of this._collectionUrls(config, userId)) {
            const response = await this._request(config, url, 'MKCOL', { maxResponseBytes: 64 * 1024, operation });
            if (![200, 201, 204, 405].includes(response.status)) this._expect(response, [200, 201, 204, 405]);
        }
    }

    async testConnection(userId, overrides = {}, callerOperation = {}) {
        userNamespace(userId);
        return this._withActiveOperation(userId, 'test', async (operation) => {
            const config = this._privateConfig(userId, overrides);
            const root = this._rootUrl(config, userId);
            const options = this._expect(await this._request(
                config,
                root,
                'OPTIONS',
                { maxResponseBytes: 64 * 1024, operation },
            ), [200, 204]);
            const allow = String(options.headers.allow || '').toUpperCase();
            const dav = String(options.headers.dav || '');
            if (!dav && !allow.includes('PROPFIND')) fail(502, 'webdav_protocol_error');
            if (allow) {
                const methods = new Set(allow.split(',').map((method) => method.trim()));
                if (['OPTIONS', 'PROPFIND', 'MKCOL', 'GET', 'PUT', 'MOVE', 'DELETE'].some((method) => !methods.has(method))) {
                    fail(502, 'webdav_protocol_error');
                }
            }
            const probe = await this._request(config, root, 'PROPFIND', {
                headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
                body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
                operation,
            });
            if (![200, 207, 404].includes(probe.status)) this._expect(probe, [200, 207, 404]);
            if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(probe.body.toString('utf8'))) fail(502, 'webdav_protocol_error');
            return { ok: true, reachable: true, namespaceExists: probe.status !== 404, dav: dav || null };
        }, callerOperation);
    }

    async _readRemoteEtag(config, userId, relativePath, headers = {}, operation) {
        const url = this._relativeUrl(config, userId, relativePath);
        const response = await this._request(config, url, 'PROPFIND', {
            headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', ...headers },
            body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
            operation,
        });
        return { response, etag: normalizeEtag(response.headers.etag) || extractDavEtag(response.body) };
    }

    async _verifyRemoteBackup(config, userId, relativePath, expectedBody, operation) {
        const url = this._relativeUrl(config, userId, relativePath);
        const response = await this._request(config, url, 'GET', {
            maxResponseBytes: this.maxBackupBytes,
            allowBackupResponse: true,
            operation,
        });
        this._expect(response, [200]);
        const etag = normalizeEtag(response.headers.etag);
        if (!etag) fail(502, 'webdav_protocol_error');
        if (response.body.length !== expectedBody.length
            || !crypto.timingSafeEqual(response.body, expectedBody)) {
            fail(409, 'webdav_conflict');
        }
        return etag;
    }

    _configStillCurrent(userId, configVersion, configEpoch) {
        const row = this._row(userId);
        return Number(row?.config_version) === configVersion && String(row?.config_epoch || '') === configEpoch;
    }

    _recordFailure(userId, configVersion, configEpoch, code) {
        this.db.prepare(`UPDATE webdav_sync_configs SET last_error_code=?,updated_at=?
            WHERE user_id=? AND config_version=? AND config_epoch=?`)
            .run(PUBLIC_MESSAGES[code] ? code : 'webdav_backup_failed', this.now(), String(userId), configVersion, configEpoch);
    }

    _isPublishUncertain(error) {
        return error instanceof WebDavSyncError
            && ['webdav_request_aborted', 'webdav_timeout', 'webdav_unavailable'].includes(error.code);
    }

    async syncNow(userId, callerOperation = {}) {
        userNamespace(userId);
        return this._withActiveOperation(userId, 'sync', (operation) => this._syncNow(userId, operation), callerOperation);
    }

    async _syncNow(userId, operation) {
        const row = this._row(userId);
        if (!row) fail(400, 'webdav_not_configured');
        if (!row.enabled) fail(409, 'webdav_disabled');
        if (typeof this.backupProvider !== 'function') throw new Error('WebDavSyncService requires backupProvider for syncNow');
        const key = String(userId);
        const configVersion = Math.max(1, Number(row.config_version) || 1);
        const configEpoch = String(row.config_epoch || '');
        let tempPath = '';
        let config = null;
        let publishStarted = false;
        try {
            config = this._privateConfig(userId);
            const produced = await this.backupProvider({
                userId: key,
                target: 'webdav-backup',
                signal: operation.signal,
                deadlineAt: operation.deadlineAt,
            });
            this._assertOperation(operation);
            const bodyValue = produced?.body === undefined ? produced : produced.body;
            const body = Buffer.isBuffer(bodyValue) ? bodyValue : Buffer.from(bodyValue || '');
            if (body.length > this.maxBackupBytes) fail(413, 'webdav_backup_too_large');
            const contentType = contentTypeHeader(produced?.contentType || 'application/octet-stream');
            await this._ensureCollections(config, userId, operation);
            this._assertOperation(operation);
            if (!this._configStillCurrent(userId, configVersion, configEpoch)) fail(409, 'webdav_config_changed');

            const expectedEtag = normalizeEtag(row.last_etag);
            if (expectedEtag) {
                const current = await this._readRemoteEtag(config, userId, BACKUP_FILE, { 'If-Match': expectedEtag }, operation);
                if (current.response.status === 412 || current.response.status === 404 || current.etag !== expectedEtag) {
                    fail(409, 'webdav_conflict');
                }
                this._expect(current.response, [200, 207]);
            }

            tempPath = `.zephyr-upload-${crypto.randomUUID()}.tmp`;
            const putResponse = await this.put(userId, tempPath, body, { contentType, createOnly: true, operation });
            this._expect(putResponse, [200, 201, 204]);
            const tempEtag = normalizeEtag(putResponse.headers.etag) || null;
            this._assertOperation(operation);
            if (!this._configStillCurrent(userId, configVersion, configEpoch)) fail(409, 'webdav_config_changed');
            /* Once MOVE is sent, a broken client connection cannot prove
             * whether the remote server committed it. */
            publishStarted = true;
            operation.publishStarted = true;
            const moveResponse = await this.move(userId, tempPath, BACKUP_FILE, {
                overwrite: !!expectedEtag,
                sourceEtag: tempEtag,
                destinationEtag: expectedEtag || null,
                operation,
            });
            this._expect(moveResponse, [200, 201, 204]);
            tempPath = '';
            this._assertOperation(operation);

            let nextEtag = normalizeEtag(moveResponse.headers.etag);
            if (!nextEtag) {
                /* Some compliant servers omit ETag on MOVE. A metadata-only
                 * read can accidentally adopt a concurrent writer's ETag, so
                 * bind the fallback ETag to the exact encrypted body first. */
                nextEtag = await this._verifyRemoteBackup(config, userId, BACKUP_FILE, body, operation);
            }
            if (!nextEtag) fail(502, 'webdav_protocol_error');
            this._assertOperation(operation);
            const completedAt = this.now();
            const committed = this.db.prepare(`UPDATE webdav_sync_configs
                SET last_etag=?,last_synced_at=?,last_error_code=NULL,updated_at=?
                WHERE user_id=? AND config_version=? AND config_epoch=?`
            ).run(nextEtag, completedAt, completedAt, key, configVersion, configEpoch);
            if (!committed.changes) fail(409, 'webdav_config_changed');
            return { ok: true, status: 'completed', mode: 'backup', bytes: body.length, etag: nextEtag, syncedAt: completedAt };
        } catch (caught) {
            const error = operation?.signal?.aborted ? abortError(operation.signal) : caught;
            if (tempPath && config) {
                /* The main operation is already aborted here, and resolving
                 * through the current row could target a replacement origin.
                 * Clean up only the captured old target under a short,
                 * independent deadline before close()/config replacement
                 * finishes draining the operation. */
                const cleanupOperation = { deadlineAt: Date.now() + Math.min(2_000, this.timeoutMs) };
                try {
                    const cleanupUrl = this._relativeUrl(config, userId, tempPath);
                    await this._request(config, cleanupUrl, 'DELETE', {
                        maxResponseBytes: 64 * 1024,
                        operation: cleanupOperation,
                    });
                } catch {}
            }
            const finalError = publishStarted && this._isPublishUncertain(error)
                ? new WebDavSyncError(503, 'webdav_sync_unknown')
                : error;
            const safe = publicWebDavError(finalError);
            /* A disconnect before publishing has no state to persist.  Once
             * publication started, retain an explicit uncertain outcome so
             * later callers never infer that the remote object is unchanged. */
            if (safe.code !== 'webdav_request_aborted') {
                this._recordFailure(userId, configVersion, configEpoch, safe.code);
            }
            throw finalError;
        }
    }
}

module.exports = {
    BACKUP_FILE,
    WebDavSyncError,
    WebDavSyncService,
    canonicalOrigin,
    canonicalPath,
    extractDavEtag,
    publicWebDavError,
    userNamespace,
    validateAddress,
    validateBaseUrl,
};
