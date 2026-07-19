'use strict';
/*
 * deeplink-service.js — parse + one-time credential tokens (FREEZE plan §5).
 *
 * Sensitive payload stays in fragment / server memory; DB stores only a
 * hash of the token and an encrypted credential blob that is wiped on
 * consume / expiry. Tokens are bound to userId.
 */
const crypto = require('crypto');
const { HttpError } = require('./authz');
const secretCrypto = require('./secret-crypto');

const DEFAULT_TTL_MS = 60 * 1000;
const MAX_URI_LEN = 8 * 1024;
const MAX_JMS_JSON = 16 * 1024;

function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function isPort(n) {
    return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Parse ssh:// / telnet:// / jms:// URIs into a draft + optional credential.
 * Never logs the raw URI or password.
 */
function parseDeepLinkUri(rawUri) {
    const uri = String(rawUri || '').trim();
    if (!uri) throw new HttpError(400, 'invalid_uri', 'URI 不能为空');
    if (uri.length > MAX_URI_LEN) throw new HttpError(400, 'uri_too_long', 'URI 过长');

    if (uri.startsWith('jms://')) {
        return parseJms(uri.slice('jms://'.length));
    }

    let url;
    try {
        // URL requires a scheme host; ssh://user@host:22 works.
        url = new URL(uri);
    } catch {
        // Node's URL rejects out-of-range ports (>65535) with a generic
        // parse error; fall back to a permissive regex so we can return a
        // precise "端口无效" code instead.
        const m = uri.match(/^(ssh|telnet):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d{1,6}))?(?:\/|$)/i);
        if (!m) throw new HttpError(400, 'invalid_uri', 'URI 无法解析');
        const protocol = m[1].toLowerCase();
        const username = m[2] ? decodeURIComponent(m[2]) : '';
        const password = m[3] ? decodeURIComponent(m[3]) : '';
        const host = m[4].replace(/^\[|\]$/g, '');
        const port = m[5] ? Number(m[5]) : (protocol === 'telnet' ? 23 : 22);
        if (!isPort(port)) throw new HttpError(400, 'invalid_port', '端口无效');
        const name = username ? `${username}@${host}` : host;
        return {
            source: protocol,
            draft: {
                name,
                protocol: protocol.toUpperCase(),
                host,
                port,
                username,
                hasTransientCredential: !!password,
                autoOpenSftp: false,
                source: protocol,
            },
            credential: password ? { password } : null,
        };
    }
    const protocol = String(url.protocol || '').replace(':', '').toLowerCase();
    if (protocol !== 'ssh' && protocol !== 'telnet') {
        throw new HttpError(400, 'unsupported_protocol', `不支持的协议：${protocol}`);
    }
    const host = url.hostname;
    if (!host) throw new HttpError(400, 'invalid_host', '主机不能为空');
    const port = url.port ? Number(url.port) : (protocol === 'telnet' ? 23 : 22);
    if (!isPort(port)) throw new HttpError(400, 'invalid_port', '端口无效');
    const username = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    const name = username ? `${username}@${host}` : host;
    const draft = {
        name,
        protocol: protocol.toUpperCase(),
        host,
        port,
        username,
        hasTransientCredential: !!password,
        autoOpenSftp: false,
        source: protocol,
    };
    const credential = password ? { password } : null;
    return { source: protocol, draft, credential };
}

function parseJms(payload) {
    let json;
    try {
        // base64url
        const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
        const buf = Buffer.from(padded, 'base64');
        if (buf.length > MAX_JMS_JSON) throw new Error('too large');
        json = JSON.parse(buf.toString('utf8'));
    } catch {
        throw new HttpError(400, 'invalid_jms_payload', 'JumpServer payload 无效');
    }
    const protocol = String(json.protocol || 'ssh').toLowerCase();
    if (!['ssh', 'sftp', 'telnet'].includes(protocol)) {
        throw new HttpError(400, 'unsupported_protocol', `不支持的 JMS 协议：${protocol}`);
    }
    const host = json.endpoint?.host || json.host;
    const port = Number(json.endpoint?.port || json.port || (protocol === 'telnet' ? 23 : 22));
    if (!host || !isPort(port)) throw new HttpError(400, 'invalid_jms_endpoint', 'JumpServer 端点无效');
    const tokenValue = json.token?.value || json.token || '';
    const assetName = json.asset?.name || `${host}`;
    const draft = {
        name: String(assetName).slice(0, 80),
        protocol: protocol === 'sftp' ? 'SSH' : protocol.toUpperCase(),
        host: String(host),
        port,
        username: String(json.token?.id || json.username || 'jms'),
        hasTransientCredential: !!tokenValue,
        autoOpenSftp: protocol === 'sftp',
        source: 'jms',
    };
    const credential = tokenValue ? { password: String(tokenValue), jms: true } : null;
    return { source: 'jms', draft, credential };
}

class DeepLinkService {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {object} [opts]
     * @param {number} [opts.ttlMs]
     * @param {() => number} [opts.now]
     */
    constructor(db, opts = {}) {
        this.db = db;
        this.ttlMs = Math.max(10 * 1000, Number(opts.ttlMs) || DEFAULT_TTL_MS);
        this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
        this.stmtInsert = db.prepare(`INSERT INTO deeplink_tokens
            (token_hash, user_id, source, draft_json, credential_enc, expires_at, consumed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`);
        this.stmtGet = db.prepare('SELECT * FROM deeplink_tokens WHERE token_hash = ?');
        this.stmtConsume = db.prepare('UPDATE deeplink_tokens SET consumed_at = ?, credential_enc = NULL WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?');
        this.stmtTouchTest = db.prepare('SELECT token_hash, user_id, source, draft_json, credential_enc, expires_at, consumed_at FROM deeplink_tokens WHERE token_hash = ?');
        this.stmtGc = db.prepare('DELETE FROM deeplink_tokens WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)');
    }

    prepare(user, uri) {
        const { source, draft, credential } = parseDeepLinkUri(uri);
        const token = crypto.randomBytes(24).toString('base64url');
        const tokenHash = sha256(token);
        const nowTs = this.now();
        let credentialEnc = null;
        if (credential) {
            credentialEnc = secretCrypto.encryptSecret(JSON.stringify(credential), `deeplink:${user.userId}:credential`);
        }
        this.stmtInsert.run(
            tokenHash,
            user.userId,
            source,
            JSON.stringify(draft),
            credentialEnc,
            nowTs + this.ttlMs,
            nowTs,
        );
        return {
            token,
            source,
            draft,
            expiresAt: nowTs + this.ttlMs,
        };
    }

    _loadLive(token, userId) {
        if (!token) throw new HttpError(400, 'invalid_token', 'token 无效');
        const row = this.stmtGet.get(sha256(token));
        if (!row) throw new HttpError(404, 'token_not_found', '临时凭据不存在或已过期');
        if (row.user_id !== userId) throw new HttpError(403, 'token_wrong_user', '临时凭据不属于当前用户');
        if (row.consumed_at) throw new HttpError(410, 'token_consumed', '临时凭据已被使用');
        if (Number(row.expires_at) < this.now()) throw new HttpError(410, 'token_expired', '临时凭据已过期');
        return row;
    }

    peek(user, token) {
        const row = this._loadLive(token, user.userId);
        return {
            source: row.source,
            draft: parseJson(row.draft_json, {}),
            expiresAt: Number(row.expires_at),
            hasCredential: !!row.credential_enc,
        };
    }

    /**
     * Test may re-use the token before expiry but does not extend TTL and
     * does not consume. Returns draft + decrypted credential for server use.
     */
    forTest(user, token, overrides = {}) {
        const row = this._loadLive(token, user.userId);
        const draft = { ...parseJson(row.draft_json, {}), ...sanitizeOverrides(overrides) };
        const credential = decryptCredential(row.credential_enc, user.userId);
        return { draft, credential, source: row.source };
    }

    /**
     * Atomically consume the token for a real connect. Second call fails.
     */
    consume(user, token, overrides = {}) {
        const hash = sha256(token);
        const row = this._loadLive(token, user.userId);
        const nowTs = this.now();
        const result = this.stmtConsume.run(nowTs, hash, nowTs);
        if (result.changes === 0) throw new HttpError(410, 'token_consumed', '临时凭据已被使用或已过期');
        const draft = { ...parseJson(row.draft_json, {}), ...sanitizeOverrides(overrides) };
        const credential = decryptCredential(row.credential_enc, user.userId);
        return { draft, credential, source: row.source };
    }

    gc() {
        const nowTs = this.now();
        return this.stmtGc.run(nowTs, nowTs - 24 * 60 * 60 * 1000).changes;
    }
}

function parseJson(value, fallback) {
    try { return JSON.parse(value || ''); } catch { return fallback; }
}

function decryptCredential(enc, userId) {
    if (!enc) return null;
    try {
        const plain = secretCrypto.decryptSecret(enc, `deeplink:${userId}:credential`);
        return JSON.parse(plain);
    } catch {
        return null;
    }
}

function sanitizeOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') return {};
    const out = {};
    for (const key of ['name', 'host', 'port', 'username', 'protocol']) {
        if (overrides[key] !== undefined) out[key] = overrides[key];
    }
    if (out.port !== undefined) out.port = Number(out.port) || out.port;
    if (out.protocol !== undefined) out.protocol = String(out.protocol).toUpperCase();
    return out;
}

module.exports = {
    DeepLinkService,
    parseDeepLinkUri,
    parseJms,
    sha256,
    DEFAULT_TTL_MS,
};
