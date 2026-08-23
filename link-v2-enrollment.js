/**
 * Zephyr Link v2 device enrollment.
 *
 * Client Token is not a bind prerequisite. One creates a pending enrollment
 * with its device identity; the human approves the exact public keys in a
 * system browser (password / TOTP / Passkey / MFA / SSO — whatever the
 * current account policy requires); the device then proves possession of
 * the enrollment secret and ES256 key to consume a bind bundle.
 *
 * Status is one-way: pending → approved → consumed. Concurrent consume is
 * a SQL compare-and-swap; only one caller receives credentials.
 */
'use strict';

const crypto = require('crypto');
const { MobileStoreError, MobileV1Store } = require('./mobile-v1-store');
const mobileProof = require('./mobile-v1-proof');

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const STATUS_POLL_MIN_MS = 800;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;
const SAS_GROUPS = 4;
const SAS_GROUP_LEN = 4;
const MAX_PENDING_PER_DEVICE = 3;
const MAX_CREATE_PER_IP_PER_HOUR = 30;
const MAX_STATUS_PER_IP_PER_MIN = 60;
const MAX_LOOKUP_PER_IP_PER_MIN = 20;
const SENTINEL_TOKEN_ID = 'link-v2-enrollment';
const PROOF_PREFIX = 'zephyr-link-enrollment-v2';

function nowMs() {
    return Date.now();
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function randomSecret() {
    return crypto.randomBytes(32).toString('base64url');
}

function randomUserCode() {
    const bytes = crypto.randomBytes(USER_CODE_LENGTH);
    let out = '';
    for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
        out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
    }
    return out.slice(0, 4) + '-' + out.slice(4);
}

function normalizeUserCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function deviceFingerprint({ deviceId, platform, encryptionPublicKey, signingJwk }) {
    return sha256(JSON.stringify({
        deviceId: String(deviceId || ''),
        platform: String(platform || ''),
        encryption: String(encryptionPublicKey || ''),
        signing: signingJwk || null,
    }));
}

function sasFromFingerprint(fingerprint) {
    const bytes = Buffer.from(String(fingerprint || ''), 'hex');
    let raw = '';
    for (let i = 0; i < SAS_GROUPS * SAS_GROUP_LEN; i += 1) {
        raw += USER_CODE_ALPHABET[bytes[i % bytes.length] % USER_CODE_ALPHABET.length];
    }
    const groups = [];
    for (let i = 0; i < SAS_GROUPS; i += 1) {
        groups.push(raw.slice(i * SAS_GROUP_LEN, (i + 1) * SAS_GROUP_LEN));
    }
    return groups.join('-');
}

function proofPayload({ bindId, deviceId, userCode, sas, secretHash, serverId }) {
    return Buffer.from([
        PROOF_PREFIX,
        String(bindId),
        String(deviceId),
        normalizeUserCode(userCode),
        String(sas),
        String(secretHash),
        String(serverId),
    ].join('\u0000'), 'utf8');
}

class LinkV2EnrollmentStore {
    constructor({ db, log } = {}) {
        if (!db) throw new Error('LinkV2EnrollmentStore requires db');
        this.db = db;
        this.log = log || (() => {});
        this._ensureSchema();
        this._purgeExpiredStmt = this.db.prepare(
            `UPDATE link_enrollments SET status = 'expired'
             WHERE status IN ('pending','approved') AND expires_at <= ?`,
        );
        this._insert = this.db.prepare(`INSERT INTO link_enrollments
            (bind_id, user_code, user_code_norm, enrollment_secret_hash, device_id, device_name,
             platform, app_version, encryption_public_key, signing_public_jwk, device_fingerprint,
             sas, verification_origin, server_id, status, expires_at, created_at, last_seen_ip)
            VALUES (@bindId, @userCode, @userCodeNorm, @secretHash, @deviceId, @deviceName,
             @platform, @appVersion, @encryption, @signingJwk, @fingerprint,
             @sas, @origin, @serverId, 'pending', @expiresAt, @createdAt, @ip)`);
        this._get = this.db.prepare('SELECT * FROM link_enrollments WHERE bind_id = ?');
        this._getConsumedByDevice = this.db.prepare(
            `SELECT * FROM link_enrollments
             WHERE device_id = ? AND status = 'consumed'
             ORDER BY consumed_at DESC LIMIT 1`,
        );
        this._countPendingDevice = this.db.prepare(
            `SELECT COUNT(*) AS n FROM link_enrollments
             WHERE device_id = ? AND status IN ('pending','approved') AND expires_at > ?`,
        );
        this._hit = this.db.prepare(`INSERT INTO link_enrollment_hits
            (hit_key, created_at) VALUES (?, ?)`);
        this._countHits = this.db.prepare(
            `SELECT COUNT(*) AS n FROM link_enrollment_hits WHERE hit_key = ? AND created_at > ?`,
        );
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS link_enrollments (
                bind_id TEXT PRIMARY KEY,
                user_code TEXT NOT NULL,
                user_code_norm TEXT NOT NULL,
                enrollment_secret_hash TEXT NOT NULL,
                device_id TEXT NOT NULL,
                device_name TEXT,
                platform TEXT NOT NULL,
                app_version TEXT,
                encryption_public_key BLOB NOT NULL,
                signing_public_jwk TEXT NOT NULL,
                device_fingerprint TEXT NOT NULL,
                sas TEXT NOT NULL,
                verification_origin TEXT NOT NULL,
                server_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','approved','consumed','denied','expired')),
                owner_user_id TEXT,
                owner_username TEXT,
                approved_at INTEGER,
                consumed_at INTEGER,
                denied_at INTEGER,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_seen_ip TEXT,
                consume_attempt_hash TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_link_enrollments_code_pending
                ON link_enrollments(user_code_norm) WHERE status = 'pending';
            CREATE INDEX IF NOT EXISTS idx_link_enrollments_device
                ON link_enrollments(device_id, status, expires_at);
            CREATE INDEX IF NOT EXISTS idx_link_enrollments_expiry
                ON link_enrollments(expires_at, status);

            CREATE TABLE IF NOT EXISTS link_enrollment_hits (
                hit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                hit_key TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_link_enrollment_hits_key
                ON link_enrollment_hits(hit_key, created_at);
        `);
    }

    purgeExpired(ts = nowMs()) {
        this._purgeExpiredStmt.run(ts);
        this.db.prepare('DELETE FROM link_enrollment_hits WHERE created_at < ?')
            .run(ts - 24 * 3600 * 1000);
    }

    assertRate(key, windowMs, limit) {
        const ts = nowMs();
        const n = Number(this._countHits.get(key, ts - windowMs)?.n || 0);
        if (n >= limit) {
            throw new MobileStoreError('rate_limited', '请求过于频繁，请稍后再试', 429, { retryable: true });
        }
        this._hit.run(key, ts);
    }

    create({
        deviceId,
        deviceName,
        platform,
        appVersion,
        keys,
        origin,
        serverId,
        ip,
    }) {
        this.purgeExpired();
        this.assertRate('create:' + String(ip || 'unknown'), 60 * 60 * 1000, MAX_CREATE_PER_IP_PER_HOUR);
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
        const pending = Number(this._countPendingDevice.get(id, nowMs())?.n || 0);
        if (pending >= MAX_PENDING_PER_DEVICE) {
            throw new MobileStoreError('rate_limited', '该设备已有未完成的绑定，请先完成或等待过期', 429, { retryable: true });
        }
        const fingerprint = deviceFingerprint({
            deviceId: id,
            platform,
            encryptionPublicKey: String(keys.encryption.publicKey),
            signingJwk: keys.signing.jwk,
        });
        const sas = sasFromFingerprint(fingerprint);
        const secret = randomSecret();
        const bindId = crypto.randomBytes(16).toString('hex');
        const ts = nowMs();
        let userCode = randomUserCode();
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                this._insert.run({
                    bindId,
                    userCode,
                    userCodeNorm: normalizeUserCode(userCode),
                    secretHash: sha256(secret),
                    deviceId: id,
                    deviceName: String(deviceName || 'Zephyr One').slice(0, 120),
                    platform,
                    appVersion: String(appVersion || '').slice(0, 40),
                    encryption,
                    signingJwk: JSON.stringify(keys.signing.jwk),
                    fingerprint,
                    sas,
                    origin: String(origin || '').replace(/\/+$/, ''),
                    serverId: String(serverId || ''),
                    expiresAt: ts + ENROLLMENT_TTL_MS,
                    createdAt: ts,
                    ip: String(ip || '').slice(0, 64),
                });
                return {
                    bindId,
                    userCode,
                    enrollmentSecret: secret,
                    sas,
                    fingerprint,
                    expiresAt: ts + ENROLLMENT_TTL_MS,
                    verificationPath: '/link/approve?bindId=' + encodeURIComponent(bindId),
                    serverId: String(serverId || ''),
                    deviceId: id,
                    deviceName: String(deviceName || 'Zephyr One').slice(0, 120),
                    platform,
                };
            } catch (err) {
                if (String(err && err.code) !== 'SQLITE_CONSTRAINT_UNIQUE'
                    && !String(err && err.message || '').includes('UNIQUE')) {
                    throw err;
                }
                userCode = randomUserCode();
            }
        }
        throw new MobileStoreError('server_unavailable', '无法分配绑定短码', 503, { retryable: true });
    }

    get(bindId) {
        this.purgeExpired();
        return this._get.get(String(bindId || '')) || null;
    }

    /**
     * Resolve a device that has completed enrollment (status consumed). A Link v2
     * transport session is only ever anchored to such a device — a pending row
     * proves nothing about key possession.
     */
    deviceById(deviceId) {
        this.purgeExpired();
        const row = this._getConsumedByDevice.get(String(deviceId || ''));
        if (!row) return null;
        return {
            deviceId: row.device_id,
            deviceName: row.device_name,
            platform: row.platform,
            ownerUserId: row.owner_user_id,
            ownerUsername: row.owner_username,
            fingerprint: row.device_fingerprint,
            consumedAt: Number(row.consumed_at || 0),
        };
    }

    publicStatus(row) {
        if (!row) return null;
        return {
            ok: true,
            bindId: row.bind_id,
            status: row.status,
            userCode: row.user_code,
            sas: row.sas,
            fingerprint: row.device_fingerprint,
            deviceName: row.device_name,
            platform: row.platform,
            expiresAt: Number(row.expires_at),
            serverId: row.server_id,
        };
    }

    lookupPending(bindId, userCode, ip) {
        this.purgeExpired();
        this.assertRate('lookup:' + String(ip || 'unknown'), 60 * 1000, MAX_LOOKUP_PER_IP_PER_MIN);
        const row = this.get(bindId);
        if (!row || (row.status !== 'pending' && row.status !== 'approved' && row.status !== 'denied')) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '绑定请求不存在或已失效', 404);
        }
        if (row.status === 'pending' && normalizeUserCode(userCode) &&
            normalizeUserCode(userCode) !== String(row.user_code_norm || '')) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '绑定请求不存在或已失效', 404);
        }
        if (row.status === 'pending' && Number(row.expires_at) <= nowMs()) {
            throw new MobileStoreError('enrollment_expired', '绑定请求已过期', 410);
        }
        return row;
    }

    statusForDevice({ bindId, userCode, ip }) {
        this.purgeExpired();
        this.assertRate('status:' + String(ip || 'unknown'), 60 * 1000, MAX_STATUS_PER_IP_PER_MIN);
        const row = this.get(bindId);
        if (!row) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '绑定请求不存在或已失效', 404);
        }
        if (normalizeUserCode(userCode) !== String(row.user_code_norm || '')) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '绑定请求不存在或已失效', 404);
        }
        return row;
    }

    approve({ bindId, userCode, user, ip }) {
        this.purgeExpired();
        const row = this.lookupPending(bindId, userCode, ip);
        if (row.status === 'approved' || row.status === 'denied') return row;
        const ts = nowMs();
        const updated = this.db.prepare(`UPDATE link_enrollments
            SET status = 'approved', owner_user_id = ?, owner_username = ?, approved_at = ?, last_seen_ip = ?
            WHERE bind_id = ? AND status = 'pending' AND expires_at > ?`).run(
            user.userId,
            user.username,
            ts,
            String(ip || '').slice(0, 64),
            row.bind_id,
            ts,
        );
        if (Number(updated.changes || 0) !== 1) {
            throw new MobileStoreError('revision_conflict', '绑定请求已被处理', 409);
        }
        return this.get(bindId);
    }

    deny({ bindId, userCode, user, ip }) {
        this.purgeExpired();
        const row = this.lookupPending(bindId, userCode, ip);
        if (row.status === 'denied') return row;
        const ts = nowMs();
        const updated = this.db.prepare(`UPDATE link_enrollments
            SET status = 'denied', owner_user_id = ?, owner_username = ?, denied_at = ?, last_seen_ip = ?
            WHERE bind_id = ? AND status = 'pending' AND expires_at > ?`).run(
            user.userId,
            user.username,
            ts,
            String(ip || '').slice(0, 64),
            row.bind_id,
            ts,
        );
        if (Number(updated.changes || 0) !== 1) {
            throw new MobileStoreError('revision_conflict', '绑定请求已被处理', 409);
        }
        return this.get(bindId);
    }

    consume({ bindId, userCode, enrollmentSecret, proof, keys, store, bindDevice }) {
        this.purgeExpired();
        const row = this.get(bindId);
        if (!row) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '绑定请求不存在或已失效', 404);
        }
        if (normalizeUserCode(userCode) !== String(row.user_code_norm || '')) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', '绑定请求不存在或已失效', 404);
        }
        if (row.status === 'consumed') {
            throw new MobileStoreError('enrollment_consumed', '绑定凭证已被兑换', 409);
        }
        if (row.status === 'denied') {
            throw new MobileStoreError('enrollment_denied', '绑定请求已被拒绝', 403);
        }
        if (row.status !== 'approved' || Number(row.expires_at) <= nowMs()) {
            throw new MobileStoreError(
                row.status === 'pending' ? 'enrollment_not_approved' : 'enrollment_expired',
                row.status === 'pending' ? '绑定请求尚未批准' : '绑定请求已过期',
                row.status === 'pending' ? 403 : 410,
            );
        }
        const secretHash = sha256(String(enrollmentSecret || ''));
        const expectedHash = Buffer.from(String(row.enrollment_secret_hash || ''), 'utf8');
        const givenHash = Buffer.from(secretHash, 'utf8');
        if (expectedHash.length !== givenHash.length
            || !crypto.timingSafeEqual(expectedHash, givenHash)) {
            throw new MobileStoreError('enrollment_secret_invalid', '设备凭证无效', 403);
        }
        let signingJwk;
        try {
            signingJwk = JSON.parse(row.signing_public_jwk);
        } catch {
            throw new MobileStoreError('invalid_request', '设备签名公钥无效', 400);
        }
        const payload = proofPayload({
            bindId: row.bind_id,
            deviceId: row.device_id,
            userCode: row.user_code,
            sas: row.sas,
            secretHash,
            serverId: row.server_id,
        });
        if (!mobileProof.verifyP1363({ jwk: signingJwk, payload, proof })) {
            throw new MobileStoreError('device_proof_invalid', '设备所有权证明无效', 403);
        }
        const storedEnc = Buffer.from(row.encryption_public_key || []);
        const presentedEnc = Buffer.from(String(keys?.encryption?.publicKey || ''), 'base64');
        if (!presentedEnc.length || presentedEnc.length !== storedEnc.length
            || !crypto.timingSafeEqual(presentedEnc, storedEnc)) {
            throw new MobileStoreError('device_proof_invalid', '设备公钥与批准记录不一致', 403);
        }

        const ts = nowMs();
        const consumeAttemptHash = sha256(row.bind_id + ':' + ts + ':' + randomSecret());
        const claimed = this.db.prepare(`UPDATE link_enrollments
            SET status = 'consumed', consumed_at = ?, consume_attempt_hash = ?
            WHERE bind_id = ? AND status = 'approved' AND consumed_at IS NULL AND expires_at > ?`).run(
            ts,
            consumeAttemptHash,
            row.bind_id,
            ts,
        );
        if (Number(claimed.changes || 0) !== 1) {
            throw new MobileStoreError('enrollment_consumed', '绑定凭证已被兑换', 409);
        }

        const bound = bindDevice({
            ownerUserId: row.owner_user_id,
            ownerUsername: row.owner_username,
            deviceId: row.device_id,
            deviceName: row.device_name,
            platform: row.platform,
            appVersion: row.app_version,
            tokenId: SENTINEL_TOKEN_ID,
            keys: {
                encryption: {
                    alg: 'ML-KEM-768',
                    publicKey: Buffer.from(row.encryption_public_key).toString('base64'),
                },
                signing: { alg: 'ES256', jwk: signingJwk },
            },
            store,
        });
        return {
            enrollment: this.get(bindId),
            bound,
        };
    }
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function approvalPage({ row, origin, error, done }) {
    const title = done === 'approved' ? '已批准该设备'
        : done === 'denied' ? '已拒绝该设备'
            : '批准 Zephyr One 设备';
    const sas = escapeHtml(row.sas);
    const code = escapeHtml(row.user_code);
    const name = escapeHtml(row.device_name || 'Zephyr One');
    const platform = escapeHtml(row.platform);
    const fp = escapeHtml(row.device_fingerprint);
    const deviceId = escapeHtml(row.device_id);
    const username = escapeHtml(row.owner_username || '');
    const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
    const actions = done ? `<p class="ok">${escapeHtml(title)}。可以关闭此页面，回到 One 完成绑定。</p>` : `
        <form method="post" action="${escapeHtml(origin)}/link/approve">
            <input type="hidden" name="bindId" value="${escapeHtml(row.bind_id)}">
            <input type="hidden" name="userCode" value="${escapeHtml(row.user_code)}">
            <button class="ok" type="submit" name="decision" value="approve">批准这台设备</button>
            <button class="no" type="submit" name="decision" value="deny">拒绝</button>
        </form>`;
    return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background:#0e1116; color:#e8eaed; }
  main { max-width: 28rem; margin: 0 auto; padding: 2.2rem 1.25rem 3rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.4rem; }
  .sub { color:#9aa3af; margin-bottom: 1.2rem; }
  .card { background:#171b22; border:1px solid #2a3140; border-radius:16px; padding:1.1rem 1.15rem; }
  .k { color:#9aa3af; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .v { font-weight:600; margin:0.15rem 0 0.85rem; word-break:break-all; }
  .sas { font-variant-numeric: tabular-nums; font-size:1.35rem; letter-spacing:.08em; }
  .code { font-variant-numeric: tabular-nums; font-size:1.5rem; letter-spacing:.16em; }
  form { display:flex; gap:.7rem; margin-top:1.1rem; }
  button { flex:1; border:0; border-radius:12px; padding:.85rem .6rem; font-weight:700; font-size:15px; }
  button.ok { background:#3dd68c; color:#062016; }
  button.no { background:#2a3140; color:#e8eaed; }
  button:active { transform: scale(0.97); }
  .err { color:#ff8b8b; }
  .ok { color:#8ee7b8; }
</style>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">只批准你正在操作的那台设备。核对短码和安全码，它们必须与 One 屏幕上显示的一致。</p>
  ${err}
  <div class="card">
    <div class="k">账号</div><div class="v">${username || '登录后显示'}</div>
    <div class="k">设备</div><div class="v">${name} · ${platform}</div>
    <div class="k">短码</div><div class="v code">${code}</div>
    <div class="k">安全码 SAS</div><div class="v sas">${sas}</div>
    <div class="k">设备指纹</div><div class="v">${fp}</div>
    <div class="k">设备公钥 ID</div><div class="v">${deviceId}</div>
    ${actions}
  </div>
</main>
</html>`;
}

function createLinkV2EnrollmentApi({
    enrollments,
    store,
    resolveSession,
    publicOrigin,
    qrcode,
    log,
}) {
    async function qrDataUrl(text) {
        if (!qrcode || typeof qrcode.toDataURL !== 'function') return null;
        try {
            return await qrcode.toDataURL(String(text), {
                errorCorrectionLevel: 'M',
                margin: 1,
                width: 320,
                color: { dark: '#0e1116', light: '#ffffff' },
            });
        } catch {
            return null;
        }
    }

    function currentUser(req) {
        if (typeof resolveSession === 'function') {
            try { return resolveSession(req) || null; } catch { return null; }
        }
        return null;
    }

    function sendStoreError(res, err) {
        const status = Number(err && err.status) || 400;
        const code = String(err && err.code || 'invalid_request');
        const message = String(err && err.message || '请求失败');
        res.status(status).json({
            ok: false,
            error: { code, message, retryable: err && err.retryable === true },
        });
    }

    function originOf(req) {
        if (typeof publicOrigin === 'function') return String(publicOrigin(req) || '').replace(/\/+$/, '');
        return String(publicOrigin || '').replace(/\/+$/, '');
    }

    function mount(app) {
        app.post('/api/link/v2/enrollments', async (req, res) => {
            try {
                const origin = originOf(req);
                const created = enrollments.create({
                    deviceId: req.body && req.body.deviceId,
                    deviceName: req.body && req.body.deviceName,
                    platform: req.body && req.body.platform,
                    appVersion: req.body && req.body.appVersion,
                    keys: req.body && req.body.keys,
                    origin,
                    serverId: store.serverId(),
                    ip: req.ip || req.headers['x-forwarded-for'] || '',
                });
                const verificationUri = origin + created.verificationPath;
                const qr = await qrDataUrl(verificationUri);
                res.status(201).json({
                    ok: true,
                    bindId: created.bindId,
                    userCode: created.userCode,
                    enrollmentSecret: created.enrollmentSecret,
                    verificationUri,
                    sas: created.sas,
                    fingerprint: created.fingerprint,
                    expiresAt: created.expiresAt,
                    serverId: created.serverId,
                    pollMinIntervalMs: STATUS_POLL_MIN_MS,
                    qrDataUrl: qr,
                    deviceId: created.deviceId,
                    deviceName: created.deviceName,
                    platform: created.platform,
                });
            } catch (err) {
                if (log) log('[link-v2]', err && err.message);
                return sendStoreError(res, err);
            }
            return undefined;
        });

        app.get('/api/link/v2/enrollments/:bindId', (req, res) => {
            try {
                const row = enrollments.statusForDevice({
                    bindId: req.params.bindId,
                    userCode: req.query.userCode,
                    ip: req.ip || req.headers['x-forwarded-for'] || '',
                });
                res.json(enrollments.publicStatus(row));
            } catch (err) {
                return sendStoreError(res, err);
            }
            return undefined;
        });

        app.post('/api/link/v2/enrollments/:bindId/consume', (req, res) => {
            try {
                const body = req.body || {};
                const result = store.db.transaction(() => enrollments.consume({
                    bindId: req.params.bindId,
                    userCode: body.userCode,
                    enrollmentSecret: body.enrollmentSecret,
                    proof: body.proof,
                    keys: body.keys,
                    store,
                    bindDevice: ({
                        ownerUserId, ownerUsername, deviceId, deviceName, platform, appVersion, tokenId, keys: deviceKeys,
                    }) => {
                        const attempt = store.beginBindAttempt({
                            ownerUserId,
                            deviceId,
                            tokenId,
                            requestId: req.headers['x-zephyr-request-id'] || '',
                        });
                        const interval = Number(body.syncIntervalSec) || 300;
                        return store.bindDevice({
                            ownerUserId,
                            ownerUsername,
                            deviceId,
                            deviceName,
                            platform,
                            appVersion,
                            tokenId,
                            keys: deviceKeys,
                            syncIntervalSec: interval,
                            attempt,
                            requestFingerprint: MobileV1Store.bindRequestFingerprint({
                                deviceId,
                                deviceName,
                                platform,
                                appVersion,
                                tokenId,
                                keys: deviceKeys,
                                syncIntervalSec: interval,
                            }),
                        });
                    },
                }))();
                const bound = result.bound;
                res.json({
                    ok: true,
                    device: store.devicePublic(bound.row),
                    accessCredential: bound.accessCredential,
                    accessExpiresAt: bound.accessExpiresAt,
                    refreshCredential: bound.refreshCredential,
                    registryHash: store.registryHash,
                    bindingProtocolVersion: bound.bindingProtocolVersion,
                    bindingRevision: bound.bindingRevision,
                    bindingToken: bound.bindingToken,
                    bootstrapRequired: true,
                    username: result.enrollment && result.enrollment.owner_username,
                    userId: result.enrollment && result.enrollment.owner_user_id,
                });
            } catch (err) {
                if (log) log('[link-v2-consume]', err && err.message);
                return sendStoreError(res, err);
            }
            return undefined;
        });

        app.get('/link/approve', (req, res) => {
            const origin = originOf(req);
            const bindId = String(req.query.bindId || '').trim();
            const user = currentUser(req);
            if (!user) {
                const next = '/link/approve?bindId=' + encodeURIComponent(bindId);
                res.redirect('/?returnTo=' + encodeURIComponent(next));
                return;
            }
            const empty = {
                bind_id: bindId,
                user_code: '',
                sas: '',
                device_fingerprint: '',
                device_name: '',
                platform: '',
                device_id: '',
                owner_username: user.username,
            };
            try {
                const row = enrollments.get(bindId);
                if (!row || (row.status !== 'pending' && row.status !== 'approved' && row.status !== 'denied')) {
                    res.status(404).type('html').send(approvalPage({
                        row: empty,
                        origin,
                        error: '绑定请求不存在或已失效',
                        done: 'denied',
                    }));
                    return;
                }
                const done = row.status === 'pending' ? '' : row.status;
                res.type('html').send(approvalPage({
                    row: { ...row, owner_username: row.owner_username || user.username },
                    origin,
                    done,
                }));
            } catch (err) {
                res.status(400).type('html').send(approvalPage({
                    row: empty,
                    origin,
                    error: err.message || '无法打开绑定页',
                    done: 'denied',
                }));
            }
        });

        app.post('/link/approve', (req, res) => {
            const origin = originOf(req);
            const user = currentUser(req);
            if (!user) {
                res.redirect('/');
                return;
            }
            const bindId = String((req.body && req.body.bindId) || '').trim();
            const userCode = String((req.body && req.body.userCode) || '').trim();
            const decision = String((req.body && req.body.decision) || '').trim();
            try {
                const row = decision === 'deny'
                    ? enrollments.deny({ bindId, userCode, user, ip: req.ip })
                    : enrollments.approve({ bindId, userCode, user, ip: req.ip });
                res.type('html').send(approvalPage({
                    row,
                    origin,
                    done: row.status,
                }));
            } catch (err) {
                const row = enrollments.get(bindId) || {
                    bind_id: bindId,
                    user_code: userCode,
                    sas: '',
                    device_fingerprint: '',
                    device_name: '',
                    platform: '',
                    device_id: '',
                    owner_username: user.username,
                };
                res.status(400).type('html').send(approvalPage({
                    row,
                    origin,
                    error: err.message || '无法完成审批',
                    done: row.status === 'pending' ? '' : row.status,
                }));
            }
        });
    }

    return { mount, SENTINEL_TOKEN_ID, proofPayload, sha256 };
}

module.exports = {
    LinkV2EnrollmentStore,
    createLinkV2EnrollmentApi,
    proofPayload,
    deviceFingerprint,
    sasFromFingerprint,
    normalizeUserCode,
    SENTINEL_TOKEN_ID,
    ENROLLMENT_TTL_MS,
    PROOF_PREFIX,
    sha256,
};
