'use strict';

/**
 * Zephyr One desktop Link sync.
 *
 * Aligns the embedded desktop core with Zephyr One Android:
 *   - bind via Link v2 enrollment (system browser approval, no password/TOTP/Client Token)
 *   - pull via /api/mobile/v1/sync/bootstrap + changes (device proof + access credential)
 *   - push local writes the same way Android's SyncActor does
 *   - apply remote pages through the same canonical ResourceService / NotesService adapters
 *
 * The local account is the embedded core's auto-adopted user. Remote secrets
 * travel as ML-KEM envelopes bound to this device; they are opened here and
 * written through the canonical services so SSH/RDP/VNC on the local UI see
 * the same rows the Web product would.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');
const mobileCrypto = require('./mobile-v1-crypto');
const mobileProof = require('./mobile-v1-proof');
const { proofPayload: enrollmentProofPayload } = require('./link-v2-enrollment');
const { extractSecrets, presenceFlag } = require('./mobile-v1-entities');
function normalizeFieldMask(fieldMask) {
    if (!Array.isArray(fieldMask)) return [];
    const out = [];
    const seen = new Set();
    for (const field of fieldMask) {
        const name = String(field || '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

const BINDING_FILE = 'one-link-binding.json';
const KEYS_FILE = 'one-link-device-keys.json';
const STATE_FILE = 'one-link-sync-state.json';
const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 86400;
const ACCESS_SKEW_MS = 30 * 1000;
const DEFAULT_INTERVAL_SEC = 300;
const WRITE_DEBOUNCE_MS = 1500;
const PAGE_SIZE = 100;
const CHANGE_LIMIT = 200;
/* Android SyncActor.MAX_PAGES_PER_ROUND is 512; desktop stays well under the
 * proof-challenge budget (120 issues / minute). A round that hits this cap
 * persists the page token and continues on the next trigger instead of
 * restarting the snapshot — restarting is what burned the rate limit. */
const MAX_PAGES_PER_ROUND = 24;
const MAX_BOOTSTRAP_PAGES = 200;
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000;
const CAPABILITIES_TTL_MS = 60 * 1000;
const RATE_LIMIT_DEFAULT_SEC = 5;
const RATE_LIMIT_MAX_WAIT_MS = 15 * 1000;
const LINK_TOKEN_ID = 'link-v2-enrollment';
const MIRROR_TYPES = new Set(['connection', 'proxy', 'sshKey', 'jumpHost', 'note']);

function clampInterval(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_INTERVAL_SEC;
    return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.floor(number)));
}

function nowMs() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function headerValue(headers, name) {
    if (!headers) return '';
    const raw = headers[name] || headers[String(name).toLowerCase()];
    if (Array.isArray(raw)) return String(raw[0] || '');
    return raw == null ? '' : String(raw);
}

function pushedKey(entityType, entityId) {
    return `${entityType}:${entityId}`;
}

function accountKeyOf(binding) {
    if (!binding) return '';
    return [binding.serverId || '', binding.userId || '', binding.deviceId || ''].join(':');
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* windows */ }
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function p1363Sign(privateKeyPem, payload) {
    return crypto.sign('sha256', payload, {
        key: privateKeyPem,
        dsaEncoding: 'ieee-p1363',
    }).toString('base64');
}

function generateDeviceKeys() {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const { publicKey: signingPub, privateKey: signingPriv } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });
    return {
        encryption: {
            alg: 'ML-KEM-768',
            publicKey: Buffer.from(publicKey).toString('base64'),
            privateKey: Buffer.from(secretKey).toString('base64'),
        },
        signing: {
            alg: 'ES256',
            jwk: signingPub.export({ format: 'jwk' }),
            privateKeyPem: signingPriv.export({ type: 'pkcs8', format: 'pem' }),
        },
    };
}

function publicKeysOf(keys) {
    return {
        encryption: { alg: keys.encryption.alg, publicKey: keys.encryption.publicKey },
        signing: { alg: keys.signing.alg, jwk: keys.signing.jwk },
    };
}

function detectDesktopPlatform() {
    const plat = process.platform;
    if (plat === 'darwin') return 'macos';
    if (plat === 'win32') return 'windows';
    if (plat === 'linux') return 'linux';
    return 'desktop';
}

function defaultDeviceName() {
    const host = os.hostname() || 'desktop';
    return `Zephyr One (${host})`.slice(0, 120);
}

function applyQuery(url, query) {
    if (!query || typeof query !== 'object') return url;
    for (const [key, value] of Object.entries(query)) {
        if (value == null || value === '') continue;
        url.searchParams.set(key, String(value));
    }
    return url;
}

function canonicalRequestPath(pathname, query) {
    const encoded = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const url = new URL(encoded, 'https://mobile.invalid');
    applyQuery(url, query);
    /* Must match requestJson's on-the-wire origin-form. URLSearchParams(object)
     * stringifies undefined as "undefined", which made bootstrap sign
     * ?pageToken=undefined while the GET dropped the key — the main then
     * rejected every proof as 设备签名无效. */
    return mobileProof.canonicalPath(url.pathname + url.search);
}

function requestJson(baseUrl, {
    method = 'GET',
    path: pathname,
    query,
    body,
    headers = {},
    timeoutMs = 30000,
    allowInsecureTls = false,
} = {}) {
    const url = new URL(pathname, String(baseUrl).replace(/\/+$/, '') + '/');
    applyQuery(url, query);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqHeaders = {
        Accept: 'application/json',
        'X-Zephyr-One-Client': '1',
        ...headers,
    };
    if (payload) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
        const req = lib.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: reqHeaders,
            timeout: timeoutMs,
            rejectUnauthorized: isHttps ? !allowInsecureTls : undefined,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    data,
                    ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
                });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('request_timeout'));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function httpError(response, fallback) {
    const err = new Error(
        response?.data?.error?.message
        || response?.data?.message
        || fallback
        || `HTTP ${response?.status || 0}`,
    );
    err.status = response?.status || 0;
    err.code = response?.data?.error?.code || response?.data?.code || `http_${err.status}`;
    err.data = response?.data;
    const retryAfter = Number(headerValue(response?.headers, 'retry-after'))
        || Number(response?.data?.error?.retryAfterSec)
        || 0;
    err.retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : (err.status === 429 ? RATE_LIMIT_DEFAULT_SEC : 0);
    err.retryable = response?.data?.error?.retryable === true || err.status === 429;
    return err;
}

class ZephyrOneLinkSync {
    constructor({
        dataDir,
        storage,
        resourceService,
        notesService,
        userSettingsService,
        mobileV1Api,
        log = console.log,
        now = nowMs,
        httpRequest = requestJson,
        sleepFn = sleep,
    } = {}) {
        if (!dataDir) throw new Error('ZephyrOneLinkSync requires dataDir');
        this.dataDir = path.resolve(dataDir);
        this.storage = storage;
        this.resourceService = resourceService;
        this.notesService = notesService;
        this.userSettingsService = userSettingsService;
        this.mobileV1Api = mobileV1Api;
        this.log = typeof log === 'function' ? log : () => {};
        this.now = now;
        this._http = typeof httpRequest === 'function' ? httpRequest : requestJson;
        this._sleep = typeof sleepFn === 'function' ? sleepFn : sleep;
        this.bindingPath = path.join(this.dataDir, BINDING_FILE);
        this.keysPath = path.join(this.dataDir, KEYS_FILE);
        this.statePath = path.join(this.dataDir, STATE_FILE);
        this._timer = null;
        this._debounce = null;
        this._running = false;
        this._rerun = false;
        this._pendingEnrollment = null;
        this._listeners = new Set();
        this._capabilitiesCache = null;
        this._rateLimitedUntil = 0;
        this.state = this._loadState();
        this.binding = this._loadBinding();
        this.keys = this._loadKeys();
    }

    onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit() {
        const snapshot = this.publicState();
        for (const listener of this._listeners) {
            try { listener(snapshot); } catch { /* ignore UI listener errors */ }
        }
    }

    _loadState() {
        const saved = readJson(this.statePath, null) || {};
        return {
            automaticEnabled: saved.automaticEnabled !== false,
            intervalSec: clampInterval(saved.intervalSec),
            networkPolicy: saved.networkPolicy === 'wifiOnly' ? 'wifiOnly' : 'any',
            appliedCursor: Number(saved.appliedCursor) || 0,
            ackedCursor: Number(saved.ackedCursor) || 0,
            snapshotCursor: Number(saved.snapshotCursor) || 0,
            lastSuccessAt: saved.lastSuccessAt || null,
            lastError: saved.lastError || null,
            lastErrorCode: saved.lastErrorCode || null,
            pendingCount: Number(saved.pendingCount) || 0,
            conflictCount: Number(saved.conflictCount) || 0,
            bootstrapComplete: saved.bootstrapComplete === true,
            registryHash: saved.registryHash || '',
            bootstrapPageToken: saved.bootstrapPageToken || null,
            bootstrapId: saved.bootstrapId || '',
            bootstrapPagesFetched: Number(saved.bootstrapPagesFetched) || 0,
            bootstrapTokenExpiresAt: Number(saved.bootstrapTokenExpiresAt) || 0,
            lastPushedRevisions: (saved.lastPushedRevisions && typeof saved.lastPushedRevisions === 'object')
                ? saved.lastPushedRevisions
                : {},
            confirmedBaseRevisions: (saved.confirmedBaseRevisions && typeof saved.confirmedBaseRevisions === 'object')
                ? saved.confirmedBaseRevisions
                : {},
            outbox: Array.isArray(saved.outbox) ? saved.outbox : [],
            conflicts: Array.isArray(saved.conflicts) ? saved.conflicts : [],
            accountKey: saved.accountKey || '',
        };
    }

    _loadBinding() {
        const saved = readJson(this.bindingPath, null);
        if (!saved || !saved.deviceId || !saved.accessCredential) return null;
        return saved;
    }

    _loadKeys() {
        const saved = readJson(this.keysPath, null);
        if (!saved?.encryption?.privateKey || !saved?.signing?.privateKeyPem) return null;
        return saved;
    }

    _saveState() {
        atomicWriteJson(this.statePath, this.state);
    }

    _saveBinding() {
        if (!this.binding) {
            try { fs.unlinkSync(this.bindingPath); } catch { /* absent */ }
            return;
        }
        atomicWriteJson(this.bindingPath, this.binding);
    }

    _saveKeys() {
        if (!this.keys) {
            try { fs.unlinkSync(this.keysPath); } catch { /* absent */ }
            return;
        }
        atomicWriteJson(this.keysPath, this.keys);
    }

    _localUser() {
        return this.storage.getFirstUser();
    }

    _ensureKeys() {
        if (this.keys) return this.keys;
        this.keys = generateDeviceKeys();
        this._saveKeys();
        return this.keys;
    }

    publicState() {
        const binding = this.binding;
        return {
            ok: true,
            bound: !!(binding && binding.accessCredential),
            localMode: !(binding && binding.accessCredential),
            username: binding?.username || '',
            userId: binding?.userId || '',
            deviceId: binding?.deviceId || '',
            deviceName: binding?.deviceName || '',
            platform: binding?.platform || detectDesktopPlatform(),
            serverUrl: binding?.serverUrl || '',
            automaticEnabled: this.state.automaticEnabled,
            intervalSec: this.state.intervalSec,
            networkPolicy: this.state.networkPolicy,
            lastSuccessAt: this.state.lastSuccessAt,
            lastError: this.state.lastError,
            lastErrorCode: this.state.lastErrorCode,
            pendingCount: this.state.pendingCount,
            conflictCount: this.state.conflictCount,
            appliedCursor: this.state.appliedCursor,
            snapshotCursor: this.state.snapshotCursor,
            bootstrapComplete: this.state.bootstrapComplete === true,
            bootstrapResume: !!(this.state.bootstrapPageToken && !this.state.bootstrapComplete),
            running: this._running,
            enrollment: this._pendingEnrollment
                ? {
                    bindId: this._pendingEnrollment.bindId,
                    userCode: this._pendingEnrollment.userCode,
                    sas: this._pendingEnrollment.sas,
                    fingerprint: this._pendingEnrollment.fingerprint,
                    verificationUri: this._pendingEnrollment.verificationUri,
                    qrDataUrl: this._pendingEnrollment.qrDataUrl || null,
                    expiresAt: this._pendingEnrollment.expiresAt,
                    status: this._pendingEnrollment.status || 'pending',
                }
                : null,
        };
    }

    start() {
        this.stop();
        if (!this.state.automaticEnabled || !this.binding) return;
        const ms = this.state.intervalSec * 1000;
        this._timer = setInterval(() => {
            this.syncNow({ trigger: 'interval', respectPolicy: true }).catch((err) => {
                this.log('[one-link] interval sync failed', err && err.message);
            });
        }, ms);
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        if (this._debounce) clearTimeout(this._debounce);
        this._debounce = null;
    }

    noteLocalWrite() {
        if (!this.binding || !this.state.automaticEnabled) return;
        if (this._debounce) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
            this.syncNow({ trigger: 'local-write', respectPolicy: true }).catch(() => {});
        }, WRITE_DEBOUNCE_MS);
        if (typeof this._debounce.unref === 'function') this._debounce.unref();
    }

    patchSettings({ automaticEnabled, intervalSec, networkPolicy } = {}) {
        if (automaticEnabled !== undefined) this.state.automaticEnabled = !!automaticEnabled;
        if (intervalSec !== undefined) this.state.intervalSec = clampInterval(intervalSec);
        if (networkPolicy !== undefined) {
            this.state.networkPolicy = networkPolicy === 'wifiOnly' ? 'wifiOnly' : 'any';
        }
        this._saveState();
        this.start();
        this._emit();
        return this.publicState();
    }

    async startEnrollment({
        serverUrl,
        deviceName,
        allowInsecureTls = false,
        intervalSec = DEFAULT_INTERVAL_SEC,
    } = {}) {
        const url = String(serverUrl || '').trim().replace(/\/+$/, '');
        if (!url.startsWith('https://') && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
            const err = new Error('只接受 https:// 地址（本机调试可用 http://127.0.0.1）');
            err.code = 'invalid_request';
            err.status = 400;
            throw err;
        }
        const keys = this._ensureKeys();
        const deviceId = crypto.randomUUID();
        const platform = detectDesktopPlatform();
        const created = await this._http(url, {
            method: 'POST',
            path: '/api/link/v2/enrollments',
            allowInsecureTls,
            body: {
                deviceId,
                deviceName: String(deviceName || defaultDeviceName()).slice(0, 120),
                platform,
                appVersion: process.env.ZEPHYR_VERSION || '0.1.0',
                keys: publicKeysOf(keys),
            },
        });
        if (!created.ok) throw httpError(created, '创建绑定失败');
        this._pendingEnrollment = {
            serverUrl: url,
            allowInsecureTls: !!allowInsecureTls,
            intervalSec: clampInterval(intervalSec),
            deviceId,
            deviceName: created.data.deviceName || deviceName || defaultDeviceName(),
            platform,
            bindId: created.data.bindId,
            userCode: created.data.userCode,
            enrollmentSecret: created.data.enrollmentSecret,
            sas: created.data.sas,
            fingerprint: created.data.fingerprint,
            verificationUri: created.data.verificationUri,
            qrDataUrl: created.data.qrDataUrl || null,
            expiresAt: created.data.expiresAt,
            serverId: created.data.serverId,
            pollMinIntervalMs: Number(created.data.pollMinIntervalMs) || 800,
            status: 'pending',
        };
        this._emit();
        return this.publicState();
    }

    async pollEnrollment() {
        const pending = this._pendingEnrollment;
        if (!pending) return this.publicState();
        const status = await this._http(pending.serverUrl, {
            method: 'GET',
            path: `/api/link/v2/enrollments/${encodeURIComponent(pending.bindId)}`,
            query: { userCode: pending.userCode },
            allowInsecureTls: pending.allowInsecureTls,
        });
        if (!status.ok) throw httpError(status, '查询绑定状态失败');
        pending.status = status.data.status;
        if (status.data.status === 'approved') {
            await this._consumeEnrollment(pending);
        } else if (status.data.status === 'denied' || status.data.status === 'expired' || status.data.status === 'consumed') {
            this._pendingEnrollment = null;
            this.state.lastError = status.data.status === 'denied' ? '主端拒绝了这台设备' : '绑定请求已失效';
            this.state.lastErrorCode = status.data.status;
            this._saveState();
        }
        this._emit();
        return this.publicState();
    }

    async _consumeEnrollment(pending) {
        const keys = this._ensureKeys();
        const payload = enrollmentProofPayload({
            bindId: pending.bindId,
            deviceId: pending.deviceId,
            userCode: pending.userCode,
            sas: pending.sas,
            secretHash: sha256Hex(pending.enrollmentSecret),
            serverId: pending.serverId,
        });
        const proof = p1363Sign(keys.signing.privateKeyPem, payload);
        const consumed = await this._http(pending.serverUrl, {
            method: 'POST',
            path: `/api/link/v2/enrollments/${encodeURIComponent(pending.bindId)}/consume`,
            allowInsecureTls: pending.allowInsecureTls,
            body: {
                userCode: pending.userCode,
                enrollmentSecret: pending.enrollmentSecret,
                proof,
                keys: publicKeysOf(keys),
                syncIntervalSec: pending.intervalSec,
            },
        });
        if (!consumed.ok) {
            if (consumed.data?.error?.code === 'enrollment_not_approved') return;
            throw httpError(consumed, '完成绑定失败');
        }
        const nextBinding = {
            serverUrl: pending.serverUrl,
            allowInsecureTls: pending.allowInsecureTls,
            serverId: pending.serverId || consumed.data.serverId || '',
            deviceId: consumed.data.device?.deviceId || pending.deviceId,
            deviceName: consumed.data.device?.deviceName || pending.deviceName,
            platform: pending.platform,
            userId: consumed.data.userId,
            username: consumed.data.username,
            tokenId: consumed.data.device?.tokenId || LINK_TOKEN_ID,
            accessCredential: consumed.data.accessCredential,
            accessExpiresAt: consumed.data.accessExpiresAt,
            refreshCredential: consumed.data.refreshCredential,
            registryHash: consumed.data.registryHash,
            bindingToken: consumed.data.bindingToken,
            boundAt: nowMs(),
        };
        const previousKey = accountKeyOf(this.binding);
        const nextKey = accountKeyOf(nextBinding);
        if (previousKey && previousKey !== nextKey) {
            this._archiveAccountDomain();
        }
        this.binding = nextBinding;
        this.state.registryHash = consumed.data.registryHash || '';
        this.state.bootstrapComplete = false;
        this.state.appliedCursor = 0;
        this.state.ackedCursor = 0;
        this.state.snapshotCursor = 0;
        this.state.bootstrapPageToken = null;
        this.state.bootstrapId = '';
        this.state.bootstrapPagesFetched = 0;
        this.state.bootstrapTokenExpiresAt = 0;
        this.state.lastPushedRevisions = {};
        this.state.confirmedBaseRevisions = {};
        this.state.outbox = [];
        this.state.conflicts = [];
        this.state.pendingCount = 0;
        this.state.conflictCount = 0;
        this.state.accountKey = accountKeyOf(this.binding);
        this.state.lastError = null;
        this.state.lastErrorCode = null;
        this._saveBinding();
        this._saveState();
        this._pendingEnrollment = null;
        this.start();
        try {
            await this.syncNow({ trigger: 'bind-complete', respectPolicy: false });
        } catch (err) {
            this.state.lastError = err.message;
            this.state.lastErrorCode = err.code || 'bootstrap_failed';
            this._saveState();
        }
    }

    unbind() {
        this.stop();
        this._archiveAccountDomain();
        this.binding = null;
        this._pendingEnrollment = null;
        this.state.bootstrapComplete = false;
        this.state.appliedCursor = 0;
        this.state.ackedCursor = 0;
        this.state.snapshotCursor = 0;
        this.state.bootstrapPageToken = null;
        this.state.bootstrapId = '';
        this.state.bootstrapPagesFetched = 0;
        this.state.bootstrapTokenExpiresAt = 0;
        this.state.lastPushedRevisions = {};
        this.state.confirmedBaseRevisions = {};
        this.state.outbox = [];
        this.state.conflicts = [];
        this.state.pendingCount = 0;
        this.state.conflictCount = 0;
        this.state.accountKey = '';
        this.state.lastError = null;
        this.state.lastErrorCode = null;
        this._saveBinding();
        this._saveState();
        this._emit();
        return this.publicState();
    }

    /**
     * Rebind/unbind must not let the next account inherit this account's
     * cursors, outbox or mirrored rows. The previous domain is archived
     * verbatim and the live mirror rows are removed; Local data that is not
     * part of the Link mirror is left untouched.
     */
    _archiveAccountDomain() {
        const userId = this.binding?.userId;
        const deviceId = this.binding?.deviceId;
        const serverId = this.binding?.serverId;
        if (!userId || !deviceId) return;
        const archiveDir = path.join(
            this.dataDir,
            'accounts',
            String(serverId || '_'),
            String(userId),
            String(deviceId),
        );
        fs.mkdirSync(archiveDir, { recursive: true });
        atomicWriteJson(path.join(archiveDir, 'one-link-sync-state.json'), this.state);
        if (this.binding) {
            atomicWriteJson(path.join(archiveDir, 'one-link-binding.json'), this.binding);
        }
        const snapshot = {};
        const api = this.mobileV1Api;
        const user = this._localUser();
        if (api && user) {
            for (const type of MIRROR_TYPES) {
                const adapter = api.adapters.get(type);
                if (!adapter || typeof adapter.list !== 'function') continue;
                let rows = [];
                try { rows = adapter.list(user) || []; } catch { rows = []; }
                snapshot[type] = rows;
                if (typeof adapter.remove === 'function') {
                    for (const row of rows) {
                        const id = String(typeof adapter.idOf === 'function' ? adapter.idOf(row) : (row.id || row.noteId || ''));
                        if (!id) continue;
                        try { adapter.remove(user, id, { actorDeviceId: deviceId }); } catch { /* already gone */ }
                    }
                }
            }
        }
        atomicWriteJson(path.join(archiveDir, 'mirror-snapshot.json'), snapshot);
    }

    async _waitOutRateLimit() {
        const wait = this._rateLimitedUntil - nowMs();
        if (wait <= 0) return;
        await this._sleep(Math.min(wait, RATE_LIMIT_MAX_WAIT_MS));
    }

    _markRateLimited(err) {
        const sec = Number(err?.retryAfterSec) || RATE_LIMIT_DEFAULT_SEC;
        this._rateLimitedUntil = Math.max(this._rateLimitedUntil, nowMs() + sec * 1000);
    }

    async _issueProofChallenge({ method, target, digest, usage }) {
        await this._waitOutRateLimit();
        const challenge = await this._http(this.binding.serverUrl, {
            method: 'POST',
            path: '/api/mobile/v1/devices/proof-challenge',
            allowInsecureTls: this.binding.allowInsecureTls,
            headers: { Authorization: `Bearer ${this.binding.accessCredential}` },
            body: { method: method.toUpperCase(), path: target, bodySha256: digest, usage },
        });
        if (challenge.ok) return challenge.data.challenge;
        const err = httpError(challenge, 'device proof challenge failed');
        if (err.status === 429 || err.code === 'rate_limited') {
            this._markRateLimited(err);
            const waitMs = Math.min((err.retryAfterSec || RATE_LIMIT_DEFAULT_SEC) * 1000, RATE_LIMIT_MAX_WAIT_MS);
            await this._sleep(waitMs);
            const retry = await this._http(this.binding.serverUrl, {
                method: 'POST',
                path: '/api/mobile/v1/devices/proof-challenge',
                allowInsecureTls: this.binding.allowInsecureTls,
                headers: { Authorization: `Bearer ${this.binding.accessCredential}` },
                body: { method: method.toUpperCase(), path: target, bodySha256: digest, usage },
            });
            if (retry.ok) return retry.data.challenge;
            const retryErr = httpError(retry, 'device proof challenge failed');
            this._markRateLimited(retryErr);
            throw retryErr;
        }
        throw err;
    }

    async _authorizedRequest({ method, path: pathname, query, body, timeoutMs, _retried401 = false }) {
        if (!this.binding) {
            const err = new Error('尚未绑定主端');
            err.code = 'unbound';
            err.status = 401;
            throw err;
        }
        await this._ensureAccess();
        const keys = this._ensureKeys();
        const bodyBuffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
        const digest = mobileProof.bodySha256(bodyBuffer);
        const target = canonicalRequestPath(pathname, query);
        if (!target) {
            const err = new Error('invalid proof path');
            err.code = 'invalid_request';
            throw err;
        }
        const usage = mobileProof.proofUsage(method, target);
        if (!usage) {
            const err = new Error('this path is not device-proofed');
            err.code = 'device_proof_not_supported';
            throw err;
        }
        const issued = await this._issueProofChallenge({ method, target, digest, usage });
        const payload = mobileProof.signedProofPayload({
            deviceId: this.binding.deviceId,
            method: issued.method,
            canonicalPath: issued.canonicalPath,
            bodySha256: issued.bodySha256,
            usage: issued.usage,
            timestamp: issued.timestamp,
            nonce: issued.nonce,
        });
        const proof = p1363Sign(keys.signing.privateKeyPem, payload);
        const response = await this._http(this.binding.serverUrl, {
            method,
            path: pathname,
            query,
            body,
            timeoutMs,
            allowInsecureTls: this.binding.allowInsecureTls,
            headers: {
                Authorization: `Bearer ${this.binding.accessCredential}`,
                'X-Zephyr-Device-Proof': proof,
                'X-Zephyr-Server-Nonce': issued.nonce,
                'X-Zephyr-Proof-Timestamp': String(issued.timestamp),
            },
        });
        if (response.status === 401 && !_retried401) {
            const err = httpError(response, `${method} ${pathname} failed`);
            /* Android maps device_proof_invalid to re-auth. Refreshing the
             * bearer cannot fix a mismatched signed path, and a retry would
             * burn another challenge. */
            if (err.code === 'device_proof_invalid') throw err;
            const refreshed = await this._refreshAccess();
            if (refreshed) {
                return this._authorizedRequest({
                    method, path: pathname, query, body, timeoutMs, _retried401: true,
                });
            }
        }
        if (response.status === 429) {
            const err = httpError(response, `${method} ${pathname} failed`);
            this._markRateLimited(err);
            throw err;
        }
        if (!response.ok) throw httpError(response, `${method} ${pathname} failed`);
        return response.data;
    }

    async _ensureAccess() {
        const expiresAt = Number(this.binding?.accessExpiresAt) || 0;
        if (expiresAt && expiresAt - ACCESS_SKEW_MS <= nowMs()) {
            await this._refreshAccess();
        }
    }

    async _refreshAccess() {
        if (!this.binding?.refreshCredential) return false;
        const response = await this._http(this.binding.serverUrl, {
            method: 'POST',
            path: '/api/mobile/v1/devices/refresh',
            allowInsecureTls: this.binding.allowInsecureTls,
            body: {
                deviceId: this.binding.deviceId,
                refreshCredential: this.binding.refreshCredential,
            },
        });
        if (!response.ok) {
            if (response.data?.error?.code === 'refresh_replayed' || response.status === 401) {
                this.state.lastError = '绑定已失效，请重新绑定主端';
                this.state.lastErrorCode = response.data?.error?.code || 'reauth_required';
                this._saveState();
                this._emit();
            }
            return false;
        }
        this.binding.accessCredential = response.data.accessCredential;
        this.binding.accessExpiresAt = response.data.accessExpiresAt;
        if (response.data.refreshCredential) this.binding.refreshCredential = response.data.refreshCredential;
        this._saveBinding();
        return true;
    }

    /** List the owner's online Agent bastions from the bound main end, the
     * same device-proof route Android uses (/api/mobile/v1/agent-bastions).
     * Desktop One has no locally connected Agents, so this is the only
     * source of `agent:<id>` jump candidates. */
    async agentBastions() {
        const data = await this._authorizedRequest({
            method: 'GET',
            path: '/api/mobile/v1/agent-bastions',
        });
        if (!Array.isArray(data?.agents)) {
            throw new Error('主端未返回 Agent 跳板列表');
        }
        return data.agents.map((agent) => ({
            agentId: String(agent.agentId || ''),
            deviceName: String(agent.deviceName || ''),
            tokenName: String(agent.tokenName || ''),
            online: agent.online === true,
            bastionEnabled: agent.bastionEnabled === true,
        })).filter((agent) => agent.agentId);
    }

    async syncNow({ trigger = 'manual', respectPolicy = false } = {}) {
        if (!this.binding) {
            const err = new Error('尚未绑定主端');
            err.code = 'unbound';
            throw err;
        }
        if (this._running) {
            this._rerun = true;
            return this.publicState();
        }
        this._running = true;
        this._emit();
        try {
            if (!this.state.bootstrapComplete) {
                await this._bootstrapAll();
            } else {
                await this._pushPending();
                await this._pullChanges();
            }
            this.state.lastSuccessAt = nowMs();
            this.state.lastError = null;
            this.state.lastErrorCode = null;
            this._saveState();
            return this.publicState();
        } catch (err) {
            this.state.lastError = err.message || String(err);
            this.state.lastErrorCode = err.code || 'sync_failed';
            this._saveState();
            throw err;
        } finally {
            this._running = false;
            this._emit();
            if (this._rerun) {
                this._rerun = false;
                setTimeout(() => {
                    this.syncNow({ trigger: 'coalesced', respectPolicy }).catch(() => {});
                }, 50).unref?.();
            }
        }
    }

    _liveBootstrapToken() {
        const token = this.state.bootstrapPageToken;
        const expiresAt = Number(this.state.bootstrapTokenExpiresAt) || 0;
        if (!token) return null;
        if (expiresAt && expiresAt <= nowMs()) {
            this.state.bootstrapPageToken = null;
            this.state.bootstrapId = '';
            this.state.bootstrapPagesFetched = 0;
            this.state.bootstrapTokenExpiresAt = 0;
            return null;
        }
        return token;
    }

    async _fetchCapabilities({ force = false } = {}) {
        const cached = this._capabilitiesCache;
        if (!force && cached && (nowMs() - cached.at) < CAPABILITIES_TTL_MS) return cached.data;
        const response = await this._http(this.binding.serverUrl, {
            method: 'GET',
            path: '/api/mobile/v1/capabilities',
            allowInsecureTls: this.binding.allowInsecureTls,
        });
        if (!response.ok) throw httpError(response, 'capabilities failed');
        this._capabilitiesCache = { at: nowMs(), data: response.data };
        if (response.data.serverId) {
            this.binding.serverId = response.data.serverId;
            this._saveBinding();
        }
        if (response.data.registryHash) this.state.registryHash = response.data.registryHash;
        return response.data;
    }

    async _bootstrapAll() {
        let pageToken = this._liveBootstrapToken();
        let pagesThisRound = 0;
        if (!this.binding.serverId) await this._fetchCapabilities();
        for (let i = 0; i < MAX_BOOTSTRAP_PAGES; i += 1) {
            if (pagesThisRound >= MAX_PAGES_PER_ROUND) {
                this._saveState();
                this._rerun = true;
                return;
            }
            let page;
            try {
                page = await this._authorizedRequest({
                    method: 'GET',
                    path: '/api/mobile/v1/sync/bootstrap',
                    query: {
                        pageToken: pageToken || undefined,
                        pageSize: String(PAGE_SIZE),
                    },
                });
            } catch (err) {
                if (err.code === 'bootstrap_expired' && pageToken) {
                    pageToken = null;
                    this.state.bootstrapPageToken = null;
                    this.state.bootstrapId = '';
                    this.state.bootstrapPagesFetched = 0;
                    this.state.bootstrapTokenExpiresAt = 0;
                    continue;
                }
                throw err;
            }
            const entities = Array.isArray(page.entities) ? page.entities : [];
            for (const entity of entities) await this._applyRemoteChange(entity);
            this.state.snapshotCursor = Number(page.snapshotCursor) || this.state.snapshotCursor;
            this.state.appliedCursor = this.state.snapshotCursor;
            this.state.bootstrapId = page.bootstrapId || this.state.bootstrapId;
            this.state.bootstrapPagesFetched = (Number(this.state.bootstrapPagesFetched) || 0) + 1;
            pagesThisRound += 1;
            pageToken = page.nextPageToken || null;
            if (page.complete || !pageToken) {
                this.state.bootstrapComplete = true;
                this.state.bootstrapPageToken = null;
                this.state.bootstrapTokenExpiresAt = 0;
                this.state.ackedCursor = this.state.appliedCursor;
                this._saveState();
                if (this.state.appliedCursor > 0) {
                    await this._ack(this.state.appliedCursor, []);
                }
                return;
            }
            this.state.bootstrapPageToken = pageToken;
            this.state.bootstrapTokenExpiresAt = nowMs() + PAGE_TOKEN_TTL_MS;
            this._saveState();
        }
        const err = new Error('bootstrap exceeded page budget');
        err.code = 'bootstrap_incomplete';
        throw err;
    }

    async _pullChanges() {
        let cursor = this.state.appliedCursor;
        for (let i = 0; i < MAX_PAGES_PER_ROUND; i += 1) {
            const page = await this._authorizedRequest({
                method: 'GET',
                path: '/api/mobile/v1/sync/changes',
                query: {
                    sinceCursor: String(cursor),
                    limit: String(CHANGE_LIMIT),
                },
            });
            const changes = Array.isArray(page.changes) ? page.changes : [];
            for (const change of changes) await this._applyRemoteChange(change);
            cursor = Number(page.nextCursor) || cursor;
            this.state.appliedCursor = cursor;
            if (changes.length) {
                await this._ack(cursor, changes.map((item) => item.opId).filter(Boolean));
                this.state.ackedCursor = cursor;
            }
            this._saveState();
            if (!page.hasMore) return;
        }
        this._rerun = true;
    }

    async _ack(cursor, appliedOpIds) {
        await this._authorizedRequest({
            method: 'POST',
            path: '/api/mobile/v1/sync/ack',
            body: {
                deviceId: this.binding.deviceId,
                cursor,
                appliedOpIds: appliedOpIds || [],
            },
        });
    }

    _confirmedBase(entityType, entityId, row) {
        const key = pushedKey(entityType, entityId);
        if (row && Object.prototype.hasOwnProperty.call(row, 'confirmedBaseRevision')) {
            const explicit = Number(row.confirmedBaseRevision);
            if (Number.isFinite(explicit) && explicit >= 0) return explicit;
        }
        if (this.state.confirmedBaseRevisions && Object.prototype.hasOwnProperty.call(this.state.confirmedBaseRevisions, key)) {
            return Number(this.state.confirmedBaseRevisions[key]) || 0;
        }
        /* A live row the server has never confirmed was created here. Its
         * local revision is a display counter, not a canonical base. */
        return 0;
    }

    _rememberConfirmed(entityType, entityId, revision) {
        if (!this.state.confirmedBaseRevisions) this.state.confirmedBaseRevisions = {};
        this.state.confirmedBaseRevisions[pushedKey(entityType, entityId)] = Number(revision) || 0;
    }

    _forgetConfirmed(entityType, entityId) {
        if (this.state.confirmedBaseRevisions) {
            delete this.state.confirmedBaseRevisions[pushedKey(entityType, entityId)];
        }
        if (this.state.lastPushedRevisions) {
            delete this.state.lastPushedRevisions[pushedKey(entityType, entityId)];
        }
    }

    _refreshPendingCount() {
        this.state.pendingCount = (this.state.outbox || []).filter((row) => row.status === 'pending').length;
        this.state.conflictCount = Array.isArray(this.state.conflicts)
            ? this.state.conflicts.length
            : (this.state.outbox || []).filter((row) => row.status === 'conflict').length;
    }

    /**
     * Public entry for canonical service writes. server.js wires
     * ResourceService/NotesService `onOwnedMutation` here so a local create,
     * update or delete lands in the outbox in the same turn as the row.
     * Remote-applied merges must not re-enqueue (caller filters remoteMerge).
     */
    recordLocalMutation({
        entityType,
        entityId,
        action,
        fieldMask,
        baseRevision,
        remoteMerge,
    } = {}) {
        if (remoteMerge === true) return null;
        const type = String(entityType || '');
        const id = String(entityId || '');
        if (!MIRROR_TYPES.has(type) || !id) return null;
        if (!this.binding) return null;
        const resolvedAction = action === 'delete' ? 'delete' : 'upsert';
        const confirmed = Number.isFinite(Number(baseRevision))
            ? Number(baseRevision)
            : this._confirmedBase(type, id, null);
        if (resolvedAction === 'delete') {
            return this._enqueueDelete(type, id, confirmed);
        }
        return this._enqueueUpsert(type, id, fieldMask, confirmed);
    }

    _enqueueUpsert(entityType, entityId, fieldMask, baseRevision) {
        return this._enqueue({
            entityType,
            entityId,
            action: 'upsert',
            fieldMask,
            baseRevision: Number.isFinite(Number(baseRevision))
                ? Number(baseRevision)
                : this._confirmedBase(entityType, entityId, null),
        });
    }

    _enqueueDelete(entityType, entityId, baseRevision) {
        return this._enqueue({
            entityType,
            entityId,
            action: 'delete',
            baseRevision: Number.isFinite(Number(baseRevision))
                ? Number(baseRevision)
                : this._confirmedBase(entityType, entityId, null),
        });
    }

    _enqueue({ entityType, entityId, action, baseRevision, fieldMask }) {
        if (!MIRROR_TYPES.has(entityType)) return null;
        if (!Array.isArray(this.state.outbox)) this.state.outbox = [];
        const id = String(entityId);
        const nextAction = action === 'delete' ? 'delete' : 'upsert';
        const mask = nextAction === 'delete' ? [] : normalizeFieldMask(fieldMask);
        const existing = this.state.outbox.find((op) => (
            op.entityType === entityType && op.entityId === id && op.status === 'pending'
        ));
        if (existing) {
            if (existing.action === nextAction) {
                if (nextAction === 'upsert' && mask.length) {
                    const merged = new Set(normalizeFieldMask(existing.fieldMask));
                    for (const field of mask) merged.add(field);
                    existing.fieldMask = [...merged];
                }
                if (Number.isFinite(Number(baseRevision))) {
                    existing.baseRevision = Number(baseRevision);
                }
                this._refreshPendingCount();
                this._saveState();
                return existing;
            }
            /* Switching upsert ↔ delete must not leave both pending (a later
             * upsert would resurrect a local delete). Close the previous op
             * and mint a new opId so an in-flight retry cannot change the
             * meaning of a server-idempotent id. */
            existing.status = 'superseded';
        }
        const op = {
            opId: `local-${entityType}-${id}-${nextAction}-${crypto.randomUUID()}`,
            entityType,
            entityId: id,
            action: nextAction,
            baseRevision: Number(baseRevision) || 0,
            fieldMask: mask,
            status: 'pending',
            enqueuedAt: nowMs(),
        };
        this.state.outbox.push(op);
        this._refreshPendingCount();
        this._saveState();
        return op;
    }

    _captureDirtyRows(user) {
        const api = this.mobileV1Api;
        if (!api || !user) return;
        for (const type of MIRROR_TYPES) {
            const adapter = api.adapters.get(type);
            if (!adapter || typeof adapter.list !== 'function') continue;
            const rows = adapter.list(user) || [];
            const liveIds = new Set();
            for (const row of rows) {
                const id = String(adapter.idOf(row));
                liveIds.add(id);
                const revision = Number(adapter.revisionOf(row)) || 0;
                const confirmed = this._confirmedBase(type, id, row);
                const pushed = Number((this.state.lastPushedRevisions || {})[pushedKey(type, id)] || 0);
                const blocked = (this.state.outbox || []).find((op) => (
                    op.entityType === type && op.entityId === id && op.status === 'conflict'
                ));
                if (blocked) continue;
                /* lastPushedRevisions is a local display watermark. CAS still
                 * uses confirmedBase; comparing against confirmed here would
                 * hide a local edit whose display revision is below the server
                 * baseline (SYNC-CAS-002). */
                if (revision > pushed) {
                    const mask = Array.isArray(row.localFieldMask) && row.localFieldMask.length
                        ? row.localFieldMask
                        : [...(api.entityByType.get(type)?.editableFields || [])];
                    this._enqueueUpsert(type, id, mask, confirmed);
                }
            }
            /* A confirmed entity that vanished from the live list is a local
             * delete that never reached the outbox (SYNC-OUT-004). Enqueue it
             * so push does not depend on the row still being listable. */
            for (const key of Object.keys(this.state.confirmedBaseRevisions || {})) {
                const prefix = `${type}:`;
                if (!key.startsWith(prefix)) continue;
                const id = key.slice(prefix.length);
                if (!id || liveIds.has(id)) continue;
                const pending = (this.state.outbox || []).find((op) => (
                    op.entityType === type && op.entityId === id && op.status === 'pending'
                ));
                if (pending && pending.action === 'delete') continue;
                this._enqueueDelete(type, id, Number(this.state.confirmedBaseRevisions[key]) || 0);
            }
        }
    }

    async _pushPending() {
        const api = this.mobileV1Api;
        if (!api || !this.binding) return;
        const user = this._localUser();
        if (!user) return;
        this._captureDirtyRows(user);
        const pending = (this.state.outbox || []).filter((op) => op.status === 'pending');
        if (!pending.length) {
            this._refreshPendingCount();
            this._saveState();
            return;
        }
        const capabilities = await this._fetchCapabilities();
        const serverKey = capabilities?.serverEncryption || null;
        const registryHash = (capabilities && capabilities.registryHash) || this.binding.registryHash;
        const operations = [];
        for (const op of pending) {
            const adapter = api.adapters.get(op.entityType);
            const spec = api.entityByType.get(op.entityType);
            if (!adapter || !spec) continue;
            if (op.action === 'delete') {
                operations.push({
                    opId: op.opId,
                    entityType: op.entityType,
                    entityId: op.entityId,
                    action: 'delete',
                    baseRevision: Number(op.baseRevision) || this._confirmedBase(op.entityType, op.entityId, null),
                    fieldMask: [],
                    payload: {},
                });
                continue;
            }
            const row = typeof adapter.read === 'function' ? adapter.read(user, op.entityId) : null;
            if (!row) {
                /* Do not silently drop a pending upsert. A confirmed entity
                 * that disappeared locally is a delete; an unconfirmed local
                 * create that vanished never reached the server. */
                const confirmed = this._confirmedBase(op.entityType, op.entityId, null);
                if (confirmed > 0) {
                    op.action = 'delete';
                    op.fieldMask = [];
                    op.baseRevision = confirmed;
                    operations.push({
                        opId: op.opId,
                        entityType: op.entityType,
                        entityId: op.entityId,
                        action: 'delete',
                        baseRevision: confirmed,
                        fieldMask: [],
                        payload: {},
                    });
                } else {
                    op.status = 'cancelled';
                }
                continue;
            }
            const baseRevision = this._confirmedBase(op.entityType, op.entityId, row);
            op.baseRevision = baseRevision;
            const secrets = extractSecrets(spec, row);
            if (Object.keys(secrets).length && !serverKey?.publicKey) {
                /* SYNC-SEC-005: defer rather than upload envelope-less secrets. */
                continue;
            }
            let envelopes = {};
            if (Object.keys(secrets).length) {
                try {
                    envelopes = this._sealSecrets({
                        spec,
                        row,
                        entityType: op.entityType,
                        entityId: op.entityId,
                        entityRevision: baseRevision + 1,
                        serverId: capabilities.serverId || this.binding.serverId,
                        serverKey,
                    });
                } catch (cause) {
                    const err = new Error(`secret envelope seal failed: ${cause && cause.message ? cause.message : 'seal failed'}`);
                    err.code = 'secret_envelope_invalid';
                    err.cause = cause;
                    throw err;
                }
            }
            const mask = normalizeFieldMask(op.fieldMask).length
                ? normalizeFieldMask(op.fieldMask)
                : [...(spec.editableFields || [])];
            operations.push({
                opId: op.opId,
                entityType: op.entityType,
                entityId: op.entityId,
                action: 'upsert',
                baseRevision,
                fieldMask: mask,
                payload: this._pushPayload(spec, row, mask),
                secretEnvelopes: Object.keys(envelopes).length ? envelopes : undefined,
            });
        }
        this.state.outbox = (this.state.outbox || []).filter((op) => op.status !== 'cancelled' && op.status !== 'superseded' && op.status !== 'done');
        this._refreshPendingCount();
        if (!operations.length) {
            this._saveState();
            return;
        }
        this.state.pendingCount = operations.length;
        const result = await this._authorizedRequest({
            method: 'POST',
            path: '/api/mobile/v1/sync/push',
            body: {
                protocolVersion: 1,
                deviceId: this.binding.deviceId,
                batchId: `batch-${crypto.randomUUID()}`,
                baseCursor: this.state.appliedCursor,
                registryHash,
                operations,
            },
        });
        const byId = new Map(operations.map((op) => [op.opId, op]));
        if (!Array.isArray(this.state.conflicts)) this.state.conflicts = [];
        for (const item of result.results || []) {
            const op = byId.get(item.opId);
            const queued = (this.state.outbox || []).find((row) => row.opId === item.opId);
            if (!op || !queued) continue;
            if (item.status === 'accepted' || item.status === 'duplicate') {
                queued.status = 'done';
                const revision = Number(item.revision) || (op.action === 'delete' ? op.baseRevision : op.baseRevision + 1);
                if (op.action === 'delete') {
                    this._forgetConfirmed(op.entityType, op.entityId);
                } else {
                    this.state.lastPushedRevisions[pushedKey(op.entityType, op.entityId)] = revision;
                    this._rememberConfirmed(op.entityType, op.entityId, revision);
                }
            } else if (item.status === 'conflict') {
                queued.status = 'conflict';
                this.state.conflicts.push({
                    opId: op.opId,
                    entityType: op.entityType,
                    entityId: op.entityId,
                    at: nowMs(),
                    reason: item.reason || item.error || 'conflict',
                });
            } else if (item.status === 'rejected') {
                queued.status = 'pending';
                queued.lastError = item.reason || item.error || 'rejected';
            }
            /* unknown / retryable statuses leave the op pending with the same opId */
        }
        this.state.outbox = (this.state.outbox || []).filter((op) => op.status === 'pending' || op.status === 'conflict');
        this._refreshPendingCount();
        /* serverCursor is the server's feed head, not proof that this device
         * applied everything up to it. Pull owns appliedCursor. */
        this._saveState();
    }

    _pushPayload(spec, row, fieldMask) {
        const drop = new Set([
            ...(spec.secretFields || []),
            ...(spec.serverAuthorityFields || []),
            ...(spec.deviceLocalFields || []),
        ]);
        const wanted = normalizeFieldMask(fieldMask);
        const fields = wanted.length ? wanted : [...(spec.editableFields || [])];
        const payload = {};
        for (const field of fields) {
            if (drop.has(field)) continue;
            if (Object.prototype.hasOwnProperty.call(row, field)) payload[field] = row[field];
        }
        return payload;
    }

    _sealSecrets({ spec, row, entityType, entityId, entityRevision, serverId, serverKey }) {
        const secrets = extractSecrets(spec, row);
        const envelopes = {};
        const publicKey = Buffer.from(String(serverKey.publicKey), 'base64');
        const keyVersion = Number(serverKey.keyVersion) || 1;
        for (const [fieldName, value] of Object.entries(secrets)) {
            const plaintext = Buffer.from(String(value), 'utf8');
            try {
                const aad = mobileCrypto.secretAadBytes({
                    serverId,
                    userId: this.binding.userId,
                    deviceId: this.binding.deviceId,
                    entityType,
                    entityId: String(entityId),
                    fieldName,
                    entityRevision,
                    keyVersion,
                });
                envelopes[fieldName] = mobileCrypto.sealEnvelope({
                    plaintext,
                    publicKey,
                    aad,
                    keyVersion,
                    entityRevision,
                });
            } finally {
                plaintext.fill(0);
            }
        }
        return envelopes;
    }

    _stripPresenceFlags(spec, payload) {
        const out = { ...(payload || {}) };
        for (const field of spec.secretFields || []) {
            delete out[presenceFlag(field)];
        }
        return out;
    }

    _assertRemoteSecrets(spec, change, opened) {
        const payload = change.payload || {};
        const envelopes = change.secretEnvelopes || {};
        const openedFields = opened && opened.fields ? opened.fields : {};
        for (const field of spec.secretFields || []) {
            const flag = presenceFlag(field);
            const claimed = payload[flag] === true;
            const envelope = envelopes[field];
            const openedValue = Object.prototype.hasOwnProperty.call(openedFields, field);
            if (claimed && !envelope) {
                const err = new Error(`secret envelope missing for ${field} while ${flag}=true`);
                err.code = 'secret_envelope_invalid';
                throw err;
            }
            if (envelope && !openedValue) {
                const err = new Error(`secret envelope rejected for ${field}: not opened`);
                err.code = 'secret_envelope_invalid';
                throw err;
            }
        }
    }

    async _applyRemoteChange(change) {
        const api = this.mobileV1Api;
        const user = this._localUser();
        if (!api || !user || !change) return;
        const entityType = String(change.entityType || '');
        if (!MIRROR_TYPES.has(entityType)) return;
        const adapter = api.adapters.get(entityType);
        const spec = api.entityByType.get(entityType);
        if (!adapter || !spec) return;
        const entityId = String(change.entityId || '');
        const pending = (this.state.outbox || []).find((op) => (
            op.entityType === entityType && op.entityId === entityId && (op.status === 'pending' || op.status === 'conflict')
        ));
        if (change.action === 'delete') {
            if (pending && pending.action !== 'delete') {
                this._retainConflict(entityType, entityId, change, adapter.read(user, entityId));
                return;
            }
            try {
                adapter.remove(user, entityId, { actorDeviceId: this.binding.deviceId, remoteMerge: true });
            } catch { /* already gone */ }
            this._forgetConfirmed(entityType, entityId);
            return;
        }
        /* Open and validate secrets BEFORE any adapter write. A bad envelope
         * aborts the entity: no row, no hasPassword=true presence flag. */
        const opened = this._openSecrets(spec, change);
        this._assertRemoteSecrets(spec, change, opened);
        const payload = this._stripPresenceFlags(spec, { ...(change.payload || {}), ...opened.fields });
        const existing = adapter.read(user, entityId);
        if (existing && pending && pending.action === 'upsert') {
            const patch = this._mergeRemoteUnderPending(spec, existing, payload, change, opened.fields);
            if (Object.keys(patch).length) {
                adapter.update(user, entityId, patch, { actorDeviceId: this.binding.deviceId, remoteMerge: true });
            }
            this._rememberConfirmed(entityType, entityId, Number(change.revision) || 0);
            return;
        }
        if (!existing) {
            adapter.create(user, entityId, payload, { actorDeviceId: this.binding.deviceId, remoteMerge: true });
        } else {
            const patch = {};
            const mask = Array.isArray(change.fieldMask) && change.fieldMask.length
                ? change.fieldMask
                : Object.keys(payload);
            for (const field of mask) {
                if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
            }
            /* Server-authority columns travel in the payload but never in the
             * editable field mask, so a mask-only patch silently drops them.
             * `iconSource` is one: without it the renderer treats the synced
             * `icon` as unset and guesses a glyph from the connection name. */
            for (const field of spec.serverAuthorityFields || []) {
                if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
            }
            for (const field of spec.secretFields || []) {
                if (Object.prototype.hasOwnProperty.call(opened.fields, field)) patch[field] = opened.fields[field];
            }
            adapter.update(user, entityId, patch, { actorDeviceId: this.binding.deviceId, remoteMerge: true });
        }
        /* lastPushedRevisions is a local display watermark so the dirty scan
         * does not echo a just-applied remote write. confirmedBaseRevisions is
         * the server CAS baseline and must not be replaced by that watermark. */
        const applied = adapter.read(user, entityId);
        const appliedRevision = applied && typeof adapter.revisionOf === 'function'
            ? Number(adapter.revisionOf(applied)) || 0
            : 0;
        if (appliedRevision > 0) {
            this.state.lastPushedRevisions[pushedKey(entityType, entityId)] = appliedRevision;
        }
        const remoteRevision = Number(change.revision) || 0;
        if (remoteRevision > 0) {
            this._rememberConfirmed(entityType, entityId, remoteRevision);
        }
    }

    _openSecrets(spec, change) {
        const envelopes = change.secretEnvelopes || {};
        const declared = (spec.secretFields || []).filter((field) => envelopes[field]);
        if (!declared.length) return { fields: {} };
        if (!this.keys?.encryption?.privateKey) {
            const err = new Error('secret envelope present but this device has no encryption key');
            err.code = 'secret_envelope_invalid';
            throw err;
        }
        const privateKey = Buffer.from(this.keys.encryption.privateKey, 'base64');
        const out = {};
        try {
            for (const fieldName of declared) {
                const envelope = envelopes[fieldName];
                const aad = mobileCrypto.secretAadBytes({
                    serverId: this.binding.serverId,
                    userId: this.binding.userId,
                    deviceId: this.binding.deviceId,
                    entityType: change.entityType,
                    entityId: String(change.entityId),
                    fieldName,
                    entityRevision: Number(envelope.entityRevision) || Number(change.revision) || 1,
                    keyVersion: Number(envelope.keyVersion) || 1,
                });
                let plaintext;
                try {
                    plaintext = mobileCrypto.openEnvelope({ envelope, privateKey, expectedAad: aad });
                } catch (cause) {
                    const err = new Error(`secret envelope rejected for ${fieldName}: ${cause && cause.message ? cause.message : 'open failed'}`);
                    err.code = 'secret_envelope_invalid';
                    err.cause = cause;
                    throw err;
                }
                out[fieldName] = plaintext.toString('utf8');
                plaintext.fill(0);
            }
        } finally {
            privateKey.fill(0);
        }
        return { fields: out };
    }

    /**
     * A pending local edit keeps every field it changed. Remote fields that
     * the pending edit does not touch are applied, so two devices editing
     * different fields converge instead of one silently winning.
     */
    _locallyChangedFields(entityType, entityId, existing) {
        const changed = new Set();
        const spec = this.mobileV1Api?.entityByType?.get(entityType);
        for (const op of this.state.outbox || []) {
            if (op.entityType !== entityType || op.entityId !== entityId) continue;
            if (op.action !== 'upsert' || (op.status !== 'pending' && op.status !== 'conflict')) continue;
            const mask = normalizeFieldMask(op.fieldMask);
            if (mask.length) {
                for (const field of mask) changed.add(field);
            } else {
                for (const field of spec?.editableFields || []) changed.add(field);
                for (const field of spec?.secretFields || []) changed.add(field);
            }
        }
        if (!changed.size && existing && existing.localFieldMask) {
            for (const field of existing.localFieldMask) changed.add(field);
        }
        return changed;
    }

    _mergeRemoteUnderPending(spec, existing, payload, change, openedFields) {
        const protectedFields = this._locallyChangedFields(change.entityType, String(change.entityId), existing);
        const patch = {};
        const mask = Array.isArray(change.fieldMask) && change.fieldMask.length
            ? change.fieldMask
            : Object.keys(payload);
        for (const field of mask) {
            if (protectedFields.has(field)) continue;
            if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
        }
        for (const field of spec.serverAuthorityFields || []) {
            if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
        }
        for (const field of Object.keys(openedFields || {})) {
            if (protectedFields.has(field)) continue;
            patch[field] = openedFields[field];
        }
        return this._stripPresenceFlags(spec, patch);
    }

    _retainConflict(entityType, entityId, change, localRow) {
        if (!Array.isArray(this.state.conflicts)) this.state.conflicts = [];
        this.state.conflicts.push({
            entityType,
            entityId,
            remoteRevision: Number(change.revision) || 0,
            remoteAction: change.action,
            local: localRow || null,
            at: nowMs(),
        });
        this.state.conflictCount = this.state.conflicts.length;
        this._saveState();
    }

    listDevices() {
        if (!this.binding) return [];
        return [{
            deviceId: this.binding.deviceId,
            deviceName: this.binding.deviceName,
            platform: this.binding.platform,
            username: this.binding.username,
            thisDevice: true,
            lastSyncAt: this.state.lastSuccessAt,
        }];
    }

    diagnostics() {
        return {
            ok: true,
            bound: !!this.binding,
            lastError: this.state.lastError,
            lastErrorCode: this.state.lastErrorCode,
            appliedCursor: this.state.appliedCursor,
            ackedCursor: this.state.ackedCursor,
            snapshotCursor: this.state.snapshotCursor,
            bootstrapComplete: this.state.bootstrapComplete,
            registryHash: this.state.registryHash || this.binding?.registryHash || '',
            pendingCount: this.state.pendingCount,
            conflictCount: this.state.conflictCount,
        };
    }
}

function createZephyrOneLinkSync(opts) {
    return new ZephyrOneLinkSync(opts);
}

function mountZephyrOneLinkRoutes(app, {
    linkSync,
    requireUser,
    listLocalBastionAgents = null,
} = {}) {
    if (!app || !linkSync) return;
    const sendErr = (res, err) => {
        const status = Number(err.status) || 400;
        res.status(status).json({
            ok: false,
            error: { code: err.code || 'error', message: err.message || String(err) },
        });
    };

    app.get('/api/one/link/state', requireUser, (req, res) => {
        res.json(linkSync.publicState());
    });
    app.post('/api/one/link/enroll', requireUser, async (req, res) => {
        try {
            const state = await linkSync.startEnrollment(req.body || {});
            res.status(201).json(state);
        } catch (err) {
            sendErr(res, err);
        }
    });
    app.get('/api/one/link/enroll/status', requireUser, async (req, res) => {
        try {
            res.json(await linkSync.pollEnrollment());
        } catch (err) {
            sendErr(res, err);
        }
    });
    app.get('/api/one/link/agent-bastions', requireUser, async (req, res) => {
        /* Hosted main and embedded One share this route, but they do not
         * share a source. A hosted main's Agents are connected to it
         * directly, so the local registry is authoritative — relaying
         * through the device-proof client here loops back into this same
         * process whenever a stale binding file exists, and that failure is
         * not `unbound`, so the picker comes back empty. Only the embedded
         * desktop core has no local Agents and must ask its bound main. */
        const localAgents = () => (typeof listLocalBastionAgents === 'function' ? listLocalBastionAgents(req) : []);
        if (process.env.ZEPHYR_ONE_EMBEDDED !== '1') {
            res.json({ ok: true, source: 'local', agents: localAgents() });
            return;
        }
        try {
            const agents = await linkSync.agentBastions();
            res.json({ ok: true, source: 'main', agents });
        } catch (err) {
            if (err?.code === 'unbound') {
                res.json({ ok: true, source: 'local', agents: localAgents() });
                return;
            }
            sendErr(res, err);
        }
    });
    app.post('/api/one/link/sync', requireUser, async (req, res) => {
        try {
            res.json(await linkSync.syncNow({ trigger: 'manual', respectPolicy: false }));
        } catch (err) {
            sendErr(res, err);
        }
    });
    app.put('/api/one/link/settings', requireUser, (req, res) => {
        res.json(linkSync.patchSettings(req.body || {}));
    });
    app.get('/api/one/link/devices', requireUser, (req, res) => {
        res.json({ ok: true, devices: linkSync.listDevices() });
    });
    app.get('/api/one/link/diagnostics', requireUser, (req, res) => {
        res.json(linkSync.diagnostics());
    });
    app.post('/api/one/link/unbind', requireUser, (req, res) => {
        res.json(linkSync.unbind());
    });
}

module.exports = {
    ZephyrOneLinkSync,
    createZephyrOneLinkSync,
    mountZephyrOneLinkRoutes,
    clampInterval,
    detectDesktopPlatform,
    generateDeviceKeys,
    MAX_PAGES_PER_ROUND,
    PAGE_TOKEN_TTL_MS,
    RATE_LIMIT_DEFAULT_SEC,
    canonicalRequestPath,
    applyQuery,
    accountKeyOf,
    MIRROR_TYPES,
};
