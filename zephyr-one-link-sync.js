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
const { extractSecrets } = require('./mobile-v1-entities');

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
    if (query && typeof query === 'object') {
        for (const [key, value] of Object.entries(query)) {
            if (value == null || value === '') continue;
            url.searchParams.set(key, String(value));
        }
    }
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

function canonicalRequestPath(pathname, query) {
    const encoded = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return mobileProof.canonicalPath(
        query && Object.keys(query).length
            ? `${encoded}?${new URLSearchParams(query).toString()}`
            : encoded,
    );
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
        this.binding = {
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
        this.state.lastError = null;
        this.state.lastErrorCode = null;
        this._saveBinding();
        this._saveState();
        this._emit();
        return this.publicState();
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

    async _pushPending() {
        const api = this.mobileV1Api;
        if (!api || !this.binding) return;
        const user = this._localUser();
        if (!user) return;
        const capabilities = await this._fetchCapabilities();
        const serverKey = capabilities.serverEncryption;
        if (!serverKey?.publicKey) return;
        const registryHash = capabilities.registryHash || this.binding.registryHash;
        const lastPushed = this.state.lastPushedRevisions || {};
        const operations = [];
        for (const type of MIRROR_TYPES) {
            const adapter = api.adapters.get(type);
            const spec = api.entityByType.get(type);
            if (!adapter || !spec) continue;
            const rows = adapter.list(user) || [];
            for (const row of rows) {
                const id = String(adapter.idOf(row));
                const revision = Number(adapter.revisionOf(row)) || 0;
                const key = pushedKey(type, id);
                if (Number(lastPushed[key] || 0) >= revision) continue;
                const payload = this._pushPayload(spec, row);
                const envelopes = this._sealSecrets({
                    spec,
                    row,
                    entityType: type,
                    entityId: id,
                    entityRevision: revision + 1,
                    serverId: capabilities.serverId,
                    serverKey,
                });
                operations.push({
                    opId: `local-${type}-${id}-${revision}`,
                    entityType: type,
                    entityId: id,
                    action: 'upsert',
                    baseRevision: revision,
                    fieldMask: [...(spec.editableFields || [])],
                    payload,
                    secretEnvelopes: Object.keys(envelopes).length ? envelopes : undefined,
                });
            }
        }
        if (!operations.length) {
            this.state.pendingCount = 0;
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
        const accepted = (result.results || []).filter((item) => item.status === 'accepted' || item.status === 'duplicate');
        const conflicts = (result.results || []).filter((item) => item.status === 'conflict').length;
        for (const item of accepted) {
            const op = operations.find((row) => row.opId === item.opId);
            if (!op) continue;
            lastPushed[pushedKey(op.entityType, op.entityId)] = Number(item.revision) || (op.baseRevision + 1);
        }
        this.state.lastPushedRevisions = lastPushed;
        this.state.pendingCount = Math.max(0, operations.length - accepted.length);
        this.state.conflictCount = conflicts;
        if (Number(result.serverCursor) > 0) this.state.appliedCursor = Number(result.serverCursor);
    }

    _pushPayload(spec, row) {
        const drop = new Set([
            ...(spec.secretFields || []),
            ...(spec.serverAuthorityFields || []),
            ...(spec.deviceLocalFields || []),
        ]);
        const payload = {};
        for (const field of spec.editableFields || []) {
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
        if (change.action === 'delete') {
            try { adapter.remove(user, entityId, { actorDeviceId: this.binding.deviceId }); } catch { /* already gone */ }
            delete this.state.lastPushedRevisions[pushedKey(entityType, entityId)];
            return;
        }
        const payload = { ...(change.payload || {}) };
        const opened = this._openSecrets(spec, change);
        Object.assign(payload, opened);
        const existing = adapter.read(user, entityId);
        if (!existing) {
            adapter.create(user, entityId, payload, { actorDeviceId: this.binding.deviceId });
        } else {
            const patch = {};
            const mask = Array.isArray(change.fieldMask) && change.fieldMask.length
                ? change.fieldMask
                : Object.keys(payload);
            for (const field of mask) {
                if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
            }
            for (const field of spec.secretFields || []) {
                if (Object.prototype.hasOwnProperty.call(opened, field)) patch[field] = opened[field];
            }
            adapter.update(user, entityId, patch, { actorDeviceId: this.binding.deviceId });
        }
        const applied = adapter.read(user, entityId);
        const appliedRevision = applied && typeof adapter.revisionOf === 'function'
            ? Number(adapter.revisionOf(applied)) || Number(change.revision) || 0
            : Number(change.revision) || 0;
        if (appliedRevision > 0) {
            this.state.lastPushedRevisions[pushedKey(entityType, entityId)] = appliedRevision;
        }
    }

    _openSecrets(spec, change) {
        const envelopes = change.secretEnvelopes || {};
        const out = {};
        if (!this.keys?.encryption?.privateKey) return out;
        const privateKey = Buffer.from(this.keys.encryption.privateKey, 'base64');
        try {
            for (const fieldName of spec.secretFields || []) {
                const envelope = envelopes[fieldName];
                if (!envelope) continue;
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
                try {
                    const plaintext = mobileCrypto.openEnvelope({
                        envelope,
                        privateKey,
                        expectedAad: aad,
                    });
                    out[fieldName] = plaintext.toString('utf8');
                    plaintext.fill(0);
                } catch (err) {
                    this.log('[one-link] secret envelope open failed', fieldName, err && err.message);
                }
            }
        } finally {
            privateKey.fill(0);
        }
        return out;
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
};
