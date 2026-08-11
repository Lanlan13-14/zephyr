/**
 * file-agent-manager.js — Zephyr Agent 文件重定向管理模块
 *
 * 管理 Flutter Agent WebSocket 连接，提供：
 * - Agent 注册/注销/心跳
 * - 文件 RPC 转发（list/stat/open/read/write/close/mkdir/delete/rename/truncate）
 * - Agent 在线状态广播（SSE）
 * - REST API 给 WebRDP 查询在线设备
 * - Token 校验
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
const ipaddr = require('ipaddr.js');
const { AgentTokenStore } = require('./file-agent-token-store');
const {
    OP: ZFT2_OP,
    FLAG_ERROR: ZFT2_FLAG_ERROR,
    FLAG_RESPONSE: ZFT2_FLAG_RESPONSE,
    encodeFrame: encodeZft2Frame,
    decodeFrame: decodeZft2Frame,
} = require('./file-transfer-protocol');

const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_FACTOR = 3;
const RPC_DEFAULT_TIMEOUT_MS = 30000;
const RPC_READ_TIMEOUT_MS = 60000;
const BINARY_READ_PREFETCH_CHUNKS = 1;
const BINARY_READ_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES = 16 * 1024;
const FILE_AGENT_AUTHENTICATED_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const FILE_AGENT_AUTH_TIMEOUT_MS = 3000;
const DEFAULT_TOKEN_FILE = path.join(
    process.env.ZEPHYR_DATA_DIR ? path.resolve(process.env.ZEPHYR_DATA_DIR) : path.join(__dirname, 'data'),
    'agent-tokens.json',
);

const DEFAULT_ADMISSION_LIMITS = Object.freeze({
    preAuthGlobal: 64,
    preAuthPerIp: 8,
    authenticatedGlobal: 512,
    authenticatedPerIp: 64,
    globalRateBurst: 120,
    globalRatePerSecond: 5,
    perIpRateBurst: 12,
    perIpRatePerSecond: 0.5,
    maxPendingBytes: 1024 * 1024,
    rateEntryTtlMs: 5 * 60 * 1000,
});

function positiveLimit(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function canonicalRemoteIp(socket) {
    // The TCP peer is authoritative here; forwarded headers are intentionally ignored.
    let address = String(socket?.remoteAddress || '').trim();
    if (!address) return 'unknown';
    if (address.startsWith('[') && address.includes(']')) address = address.slice(1, address.indexOf(']'));
    const zoneAt = address.indexOf('%');
    if (zoneAt >= 0) address = address.slice(0, zoneAt);
    try {
        const parsed = ipaddr.parse(address);
        if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
            return parsed.toIPv4Address().toString();
        }
        return parsed.kind() === 'ipv6' ? parsed.toNormalizedString() : parsed.toString();
    } catch {
        return 'unknown';
    }
}

class FileAgentAdmissionGate {
    constructor(options = {}, log = console.log) {
        this.log = log;
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.limits = {
            preAuthGlobal: positiveLimit(options.preAuthGlobal, DEFAULT_ADMISSION_LIMITS.preAuthGlobal),
            preAuthPerIp: positiveLimit(options.preAuthPerIp, DEFAULT_ADMISSION_LIMITS.preAuthPerIp),
            authenticatedGlobal: positiveLimit(options.authenticatedGlobal, DEFAULT_ADMISSION_LIMITS.authenticatedGlobal),
            authenticatedPerIp: positiveLimit(options.authenticatedPerIp, DEFAULT_ADMISSION_LIMITS.authenticatedPerIp),
            globalRateBurst: positiveLimit(options.globalRateBurst, DEFAULT_ADMISSION_LIMITS.globalRateBurst),
            globalRatePerSecond: positiveLimit(options.globalRatePerSecond, DEFAULT_ADMISSION_LIMITS.globalRatePerSecond),
            perIpRateBurst: positiveLimit(options.perIpRateBurst, DEFAULT_ADMISSION_LIMITS.perIpRateBurst),
            perIpRatePerSecond: positiveLimit(options.perIpRatePerSecond, DEFAULT_ADMISSION_LIMITS.perIpRatePerSecond),
            maxPendingBytes: positiveLimit(options.maxPendingBytes, DEFAULT_ADMISSION_LIMITS.maxPendingBytes),
            rateEntryTtlMs: positiveLimit(options.rateEntryTtlMs, DEFAULT_ADMISSION_LIMITS.rateEntryTtlMs),
        };
        this.preAuthCount = 0;
        this.authenticatedCount = 0;
        this.preAuthByIp = new Map();
        this.authenticatedByIp = new Map();
        this.pendingBytes = 0;
        this.nextLeaseId = 1;
        this.leases = new Set();
        const now = this.now();
        this.globalRate = { tokens: this.limits.globalRateBurst, updatedAt: now, seenAt: now };
        this.ipRates = new Map();
        this.admissionAttempts = 0;
    }

    _count(map, ip) {
        return map.get(ip) || 0;
    }

    _increment(map, ip) {
        map.set(ip, this._count(map, ip) + 1);
    }

    _decrement(map, ip) {
        const count = this._count(map, ip);
        if (count <= 1) map.delete(ip);
        else map.set(ip, count - 1);
    }

    _refill(bucket, burst, perSecond, now) {
        const elapsed = Math.max(0, now - bucket.updatedAt);
        bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1000) * perSecond);
        bucket.updatedAt = now;
        bucket.seenAt = now;
    }

    _ipBucket(ip, now) {
        let bucket = this.ipRates.get(ip);
        if (!bucket) {
            bucket = { tokens: this.limits.perIpRateBurst, updatedAt: now, seenAt: now };
            this.ipRates.set(ip, bucket);
        }
        return bucket;
    }

    _pruneRateEntries(now) {
        if ((++this.admissionAttempts & 0xff) !== 0) return;
        for (const [ip, bucket] of this.ipRates) {
            if (now - bucket.seenAt >= this.limits.rateEntryTtlMs
                && !this.preAuthByIp.has(ip)
                && !this.authenticatedByIp.has(ip)) {
                this.ipRates.delete(ip);
            }
        }
    }

    admit(socket) {
        const ip = canonicalRemoteIp(socket);
        if (this.preAuthCount >= this.limits.preAuthGlobal) {
            return { ok: false, code: 'preauth_global_limit' };
        }
        if (this._count(this.preAuthByIp, ip) >= this.limits.preAuthPerIp) {
            return { ok: false, code: 'preauth_ip_limit' };
        }

        const now = this.now();
        this._pruneRateEntries(now);
        const ipBucket = this._ipBucket(ip, now);
        this._refill(this.globalRate, this.limits.globalRateBurst, this.limits.globalRatePerSecond, now);
        this._refill(ipBucket, this.limits.perIpRateBurst, this.limits.perIpRatePerSecond, now);
        if (this.globalRate.tokens < 1) return { ok: false, code: 'upgrade_global_rate' };
        if (ipBucket.tokens < 1) return { ok: false, code: 'upgrade_ip_rate' };

        this.globalRate.tokens -= 1;
        ipBucket.tokens -= 1;
        this.preAuthCount += 1;
        this._increment(this.preAuthByIp, ip);
        const lease = {
            id: this.nextLeaseId++,
            ip,
            phase: 'preauth',
            pendingBytes: 0,
            released: false,
            socket,
            rawListeners: null,
            wsListeners: null,
        };
        this.leases.add(lease);
        if (socket?.once) {
            const release = () => this.release(lease);
            socket.once('close', release);
            socket.once('error', release);
            lease.rawListeners = { release };
        }
        return { ok: true, lease };
    }

    attachWebSocket(lease, ws) {
        if (!lease || lease.released) return false;
        if (lease.wsListeners || !ws?.once) return true;
        const release = () => this.release(lease);
        ws.once('close', release);
        ws.once('error', release);
        lease.wsListeners = { ws, release };
        return true;
    }

    reservePendingBytes(lease, bytes) {
        const amount = Math.max(0, Number(bytes) || 0);
        if (!lease || lease.released || lease.phase !== 'preauth') return false;
        if (this.pendingBytes + amount > this.limits.maxPendingBytes) return false;
        lease.pendingBytes += amount;
        this.pendingBytes += amount;
        return true;
    }

    releasePendingBytes(lease) {
        if (!lease || lease.pendingBytes <= 0) return;
        this.pendingBytes = Math.max(0, this.pendingBytes - lease.pendingBytes);
        lease.pendingBytes = 0;
    }

    promote(lease) {
        if (!lease || lease.released || lease.phase !== 'preauth') return false;
        if (this.authenticatedCount >= this.limits.authenticatedGlobal
            || this._count(this.authenticatedByIp, lease.ip) >= this.limits.authenticatedPerIp) {
            return false;
        }
        this.releasePendingBytes(lease);
        this.preAuthCount = Math.max(0, this.preAuthCount - 1);
        this._decrement(this.preAuthByIp, lease.ip);
        this.authenticatedCount += 1;
        this._increment(this.authenticatedByIp, lease.ip);
        lease.phase = 'authenticated';
        return true;
    }

    release(lease) {
        if (!lease || lease.released) return false;
        lease.released = true;
        this.leases.delete(lease);
        this.releasePendingBytes(lease);
        if (lease.phase === 'authenticated') {
            this.authenticatedCount = Math.max(0, this.authenticatedCount - 1);
            this._decrement(this.authenticatedByIp, lease.ip);
        } else {
            this.preAuthCount = Math.max(0, this.preAuthCount - 1);
            this._decrement(this.preAuthByIp, lease.ip);
        }
        if (lease.rawListeners && lease.socket?.removeListener) {
            lease.socket.removeListener('close', lease.rawListeners.release);
            lease.socket.removeListener('error', lease.rawListeners.release);
        }
        if (lease.wsListeners?.ws?.removeListener) {
            lease.wsListeners.ws.removeListener('close', lease.wsListeners.release);
            lease.wsListeners.ws.removeListener('error', lease.wsListeners.release);
        }
        return true;
    }

    snapshot() {
        return {
            preAuth: this.preAuthCount,
            authenticated: this.authenticatedCount,
            pendingBytes: this.pendingBytes,
            preAuthByIp: Object.fromEntries(this.preAuthByIp),
            authenticatedByIp: Object.fromEntries(this.authenticatedByIp),
        };
    }

    shutdown() {
        for (const lease of [...this.leases]) this.release(lease);
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateBoundedString(value, maxLength, { required = false } = {}) {
    if (value == null && !required) return true;
    return typeof value === 'string'
        && (!required || value.length > 0)
        && value.length <= maxLength;
}

function validateHelloMessage(hello) {
    if (!isPlainObject(hello)) return false;
    const allowed = new Set([
        'type', 'protocolVersion', 'token', 'deviceId', 'deviceName',
        'platform', 'appVersion', 'capabilities', 'share',
    ]);
    if (Object.keys(hello).some((key) => !allowed.has(key))) return false;
    if (hello.type !== 'hello' || ![1, 2].includes(hello.protocolVersion)) return false;
    if (!validateBoundedString(hello.token, 512, { required: true })) return false;
    if (!validateBoundedString(hello.deviceId, 256)) return false;
    if (!validateBoundedString(hello.deviceName, 256)) return false;
    if (!validateBoundedString(hello.platform, 64)) return false;
    if (!validateBoundedString(hello.appVersion, 64)) return false;
    if (hello.capabilities != null) {
        if (!isPlainObject(hello.capabilities)) return false;
        const booleanCapabilities = new Set([
            'read', 'write', 'delete', 'rename', 'mkdir', 'truncate', 'binary',
            'binaryRead', 'binaryWrite', 'cancel', 'creditFlow',
        ]);
        for (const [key, value] of Object.entries(hello.capabilities)) {
            if (booleanCapabilities.has(key)) {
                if (typeof value !== 'boolean') return false;
            } else if (key === 'maxInflight' || key === 'maxChunkSize') {
                if (!Number.isSafeInteger(value) || value <= 0) return false;
            } else {
                return false;
            }
        }
    }
    if (hello.share != null) {
        if (!isPlainObject(hello.share)) return false;
        if (Object.keys(hello.share).some((key) => key !== 'name' && key !== 'readOnly')) return false;
        if (!validateBoundedString(hello.share.name, 256)) return false;
        if (hello.share.readOnly != null && typeof hello.share.readOnly !== 'boolean') return false;
    }
    return true;
}

class FileAgentConnection {
    constructor(ws, agentId, hello) {
        this.ws = ws;
        this.agentId = agentId;
        this.deviceId = hello.deviceId || '';
        this.deviceName = hello.deviceName || 'Unknown';
        this.platform = hello.platform || 'unknown';
        this.appVersion = hello.appVersion || '0.0.0';
        this.capabilities = hello.capabilities || { read: true };
        this.share = hello.share || { name: 'Agent', readOnly: true };
        this.ownerId = null; // set after token validation
        this.ownerUsername = '';
        this.tokenId = null;
        this.tokenName = '';
        this.lastSeenAt = Date.now();
        this.connectedAt = Date.now();
        this.pendingRequests = new Map(); // requestId → { resolve, reject, timer }
        this.nextRequestId = 1;
        this.protocolVersion = Number(hello.protocolVersion || 1);
        this.maxInflight = Math.max(1, Math.min(16, Number(this.capabilities.maxInflight || 8)));
        this.maxChunkSize = Math.max(64 * 1024, Math.min(1024 * 1024, Number(this.capabilities.maxChunkSize || 1024 * 1024)));
        this.heartbeatTimer = null;
        this.heartbeatMissCount = 0;
    }

    get online() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    toPublicInfo() {
        return {
            agentId: this.agentId,
            deviceId: this.deviceId,
            deviceName: this.deviceName,
            platform: this.platform,
            appVersion: this.appVersion,
            online: this.online,
            readOnly: this.share.readOnly !== false,
            shareName: this.share.name || this.deviceName,
            capabilities: { ...this.capabilities },
            protocolVersion: this.protocolVersion,
            maxInflight: this.maxInflight,
            maxChunkSize: this.maxChunkSize,
            connectedAt: this.connectedAt,
            lastSeenAt: this.lastSeenAt,
            tokenId: this.tokenId,
            tokenName: this.tokenName,
        };
    }

    /** Send a file RPC request to the Agent and return a Promise for the response. */
    callRpc(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this.online) {
                reject(new AgentError('agent_offline', 'Agent is offline'));
                return;
            }
            const id = `rpc_${this.agentId}_${this.nextRequestId++}`;
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new AgentError('timeout', `RPC ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs || RPC_DEFAULT_TIMEOUT_MS);

            this.pendingRequests.set(id, { resolve, reject, timer, method });
            try {
                this.ws.send(JSON.stringify({
                    id,
                    type: 'request',
                    method,
                    params: params || {},
                }));
            } catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(new AgentError('io_error', err.message));
            }
        });
    }

    /** Send a binary read request to the Agent and return a Buffer. */
    callBinaryRead(params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this.online) {
                reject(new AgentError('agent_offline', 'Agent is offline'));
                return;
            }
            const id = `rpc_${this.agentId}_${this.nextRequestId++}`;
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new AgentError('timeout', `binary read timed out after ${timeoutMs}ms`));
            }, timeoutMs || RPC_READ_TIMEOUT_MS);

            this.pendingRequests.set(id, { resolve, reject, timer, method: 'readBinary', binary: true });
            try {
                this.ws.send(JSON.stringify({
                    id,
                    type: 'request',
                    method: 'readBinary',
                    params: params || {},
                }));
            } catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(new AgentError('io_error', err.message));
            }
        });
    }

    /** Send a protocol-v2 binary request to the Agent. */
    callBinaryV2(type, meta, payload, timeoutMs) {
        // Wait for a free in-flight slot instead of immediately rejecting with
        // "busy".  The old instant-reject caused the Go WASM retry loop to spin
        // at 25/50/100 ms intervals, burning all retry attempts and eventually
        // failing large-file copies with STATUS_UNSUCCESSFUL / 0x8007048F.
        // Polling at 4 ms matches the Go WASM fileTransferSlotPoll constant so
        // both sides drain at the same cadence.
        const SLOT_POLL_MS = 4;
        let settled = false;
        let cancelled = false;
        let cancel = () => {};

        const promise = new Promise((resolve, reject) => {
            if (!this.online) { reject(new AgentError('agent_offline', 'Agent is offline')); return; }
            if (this.protocolVersion < 2) { reject(new AgentError('unsupported', 'Agent does not support ZFT2')); return; }

            const effectiveTimeout = timeoutMs || RPC_DEFAULT_TIMEOUT_MS;
            const deadline = Date.now() + effectiveTimeout;

            const finishResolve = (value) => { if (settled) return; settled = true; resolve(value); };
            const finishReject  = (error)  => { if (settled) return; settled = true; reject(error); };

            const tryAcquire = () => {
                if (cancelled || settled) return;
                if (!this.online) { finishReject(new AgentError('agent_offline', 'Agent went offline')); return; }
                if (Date.now() >= deadline) { finishReject(new AgentError('timeout', `ZFT2 request timed out after ${effectiveTimeout}ms`)); return; }

                // Slot available — claim it and send.
                if (this.pendingRequests.size < this.maxInflight) {
                    const id = this.nextRequestId++ >>> 0;
                    const frame = encodeZft2Frame({ type, requestId: id, meta: meta || {}, payload });
                    const timer = setTimeout(() => {
                        this.pendingRequests.delete(id);
                        finishReject(new AgentError('timeout', `ZFT2 request timed out after ${effectiveTimeout}ms`));
                    }, Math.max(1, deadline - Date.now()));

                    this.pendingRequests.set(id, { resolve: finishResolve, reject: finishReject, timer, binaryV2: true, method: type });

                    cancel = () => {
                        if (settled) return;
                        clearTimeout(timer);
                        this.pendingRequests.delete(id);
                        try { this.ws.send(encodeZft2Frame({ type: ZFT2_OP.CANCEL, requestId: this.nextRequestId++ >>> 0, meta: { targetRequestId: id } })); } catch {}
                        finishReject(new AgentError('cancelled', 'File request cancelled'));
                    };

                    try {
                        this.ws.send(frame, { binary: true }, (err) => {
                            if (!err || settled) return;
                            clearTimeout(timer);
                            this.pendingRequests.delete(id);
                            finishReject(new AgentError('io_error', err.message));
                        });
                    } catch (err) {
                        clearTimeout(timer);
                        this.pendingRequests.delete(id);
                        finishReject(new AgentError('io_error', err.message));
                    }
                    return;
                }

                // Window full — back off and retry.
                setTimeout(tryAcquire, SLOT_POLL_MS);
            };

            tryAcquire();
        });

        // Return the outer cancel that sets cancelled=true and delegates to
        // whichever inner cancel was bound when a slot was acquired.
        return {
            promise,
            cancel: () => {
                cancelled = true;
                cancel();
            },
        };
    }

    /** Handle an incoming ZFT2 response from the Agent. */
    handleBinaryV2(raw) {
        let frame;
        try { frame = decodeZft2Frame(raw); } catch { return false; }
        if (!(frame.flags & ZFT2_FLAG_RESPONSE)) return false;
        const pending = this.pendingRequests.get(frame.requestId);
        if (!pending || !pending.binaryV2) return true;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(frame.requestId);
        if (frame.flags & ZFT2_FLAG_ERROR) {
            pending.reject(new AgentError(frame.meta.code || 'internal_error', frame.meta.message || 'Agent request failed'));
        } else if (frame.type === ZFT2_OP.READ) {
            pending.resolve(frame.payload);
        } else {
            pending.resolve(frame.meta || {});
        }
        return true;
    }

    /** Handle an incoming binary response from the Agent. */
    handleBinaryResponse(raw) {
        if (this.handleBinaryV2(raw)) return true;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        // Binary frame: magic "ZFB1" (4) + idLen uint16BE (2) + id UTF-8 + payload
        if (buf.length < 6 || buf[0] !== 0x5a || buf[1] !== 0x46 || buf[2] !== 0x42 || buf[3] !== 0x31) {
            return false;
        }
        const idLen = buf.readUInt16BE(4);
        if (idLen <= 0 || 6 + idLen > buf.length) return false;
        const id = buf.subarray(6, 6 + idLen).toString('utf8');
        const pending = this.pendingRequests.get(id);
        if (!pending) return true;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.resolve(buf.subarray(6 + idLen));
        return true;
    }

    /** Handle an incoming response from the Agent */
    handleResponse(msg) {
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
            pending.resolve(msg.result || {});
        } else {
            const err = msg.error || {};
            pending.reject(new AgentError(err.code || 'internal_error', err.message || 'Unknown error'));
        }
    }

    /** Cancel all pending requests (e.g., on disconnect) */
    cancelAll(reason) {
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new AgentError('agent_offline', reason || 'Agent disconnected'));
        }
        this.pendingRequests.clear();
    }

    cleanup() {
        this.cancelAll('Agent disconnected');
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

class AgentError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

class FileAgentManager {
    constructor(options = {}) {
        /** @type {Map<string, FileAgentConnection>} agentId → connection */
        this.agents = new Map();
        /** @type {Map<string, Set<string>>} ownerId → Set<agentId> */
        this.ownerAgents = new Map();
        /** @type {Set<import('http').ServerResponse>} SSE subscribers */
        this.sseClients = new Set();
        /** @type {Map<string, object>} token → token record */
        /** @type {Map<string, {promise?: Promise<Buffer>, data?: Buffer, ts: number, size: number}>} */
        this.binaryReadCache = new Map();
        this.binaryReadCacheBytes = 0;
        this.binaryReadQueues = new Map(); // `${agentId}:${handle}` → Promise chain
        /** @type {Function} resolve userId from session cookie (injected) */
        this.resolveSession = options.resolveSession || (() => null);
        /** @type {Function} logger */
        this.log = options.log || console.log;
        this.admissionGate = new FileAgentAdmissionGate(options.admission || {}, this.log);
        this.authTimeoutMs = positiveLimit(options.authTimeoutMs, FILE_AGENT_AUTH_TIMEOUT_MS);
        this.preAuthMaxMessageBytes = positiveLimit(
            options.preAuthMaxMessageBytes,
            FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES,
        );
        this.authenticatedMaxMessageBytes = positiveLimit(
            options.authenticatedMaxMessageBytes,
            FILE_AGENT_AUTHENTICATED_MAX_MESSAGE_BYTES,
        );
        this.preAuthCloseGraceMs = positiveLimit(options.preAuthCloseGraceMs, 250);
        this.resolveOwner = typeof options.resolveOwner === 'function' ? options.resolveOwner : null;
        this.tokenFile = path.resolve(options.tokenFile || DEFAULT_TOKEN_FILE);
        this.tokenStore = options.tokenStore || new AgentTokenStore(this.tokenFile, {
            db: options.db,
            getDb: options.getDb,
            keyring: options.tokenKeyring,
            keyFile: options.tokenKeyFile,
            databaseFile: options.databaseFile,
            resolveOwner: this.resolveOwner,
        });
        this.metadataSyncContract = this.tokenStore.metadataSyncContract;
        this.boundTokenDb = null;
        this.teardownTimeoutMs = Math.max(10, Number(options.teardownTimeoutMs || 2000));
        this.blockedOwnerIds = new Set();

        this._loadTokens();
    }

    // ─── Token Management ────────────────────────────────────────────

    _loadTokens() {
        try {
            this.tokenStore.ensureReady({ resolveOwner: this.resolveOwner });
        } catch (err) {
            if (err?.code !== 'token_store_unavailable') {
                this.log('[file-agent] encrypted Client Token store is unavailable');
            }
        }
    }

    get db() {
        return this.tokenStore.db;
    }

    _ensureTokenStore() {
        try {
            this.tokenStore.ensureReady({ resolveOwner: this.resolveOwner });
            const currentDb = this.tokenStore.db;
            if (this.boundTokenDb && currentDb && this.boundTokenDb !== currentDb) {
                for (const [agentId] of [...this.agents]) this.unregisterAgent(agentId, 'token_store_rebound');
            }
            this.boundTokenDb = currentDb;
            this.metadataSyncContract = this.tokenStore.metadataSyncContract;
            return this.tokenStore;
        } catch (err) {
            const wrapped = new AgentError(err?.code || 'token_store_unavailable', 'Encrypted Client Token storage is unavailable');
            wrapped.cause = err;
            throw wrapped;
        }
    }

    _storeOwnerId(ownerId, ownerUsername = '') {
        const owner = this._ownerIdentity(ownerId, ownerUsername);
        if (owner.strict) return owner.userId || '';
        if (!this.resolveOwner) return owner.userId || owner.username;
        return this._resolveOwnerReference(owner)?.userId || '';
    }

    /** Resolve a route/session owner to the immutable identity used by token storage. */
    resolveTokenOwner(ownerId, ownerUsername = '') {
        const identity = this._ownerIdentity(ownerId, ownerUsername);
        const userId = this._storeOwnerId(ownerId, ownerUsername);
        if (!userId) return null;
        const resolved = this.resolveOwner ? this._resolveOwnerReference(identity) : null;
        return {
            userId,
            username: String(resolved?.username || identity.username || ''),
        };
    }

    _ownerIdentity(ownerId, ownerUsername = '') {
        if (ownerId && typeof ownerId === 'object') {
            return {
                userId: String(ownerId.userId || ''),
                username: String(ownerId.username || ''),
                strict: true,
            };
        }
        const reference = String(ownerId || '');
        return {
            userId: reference,
            username: String(ownerUsername || reference),
            strict: false,
        };
    }

    _recordOwnedBy(record, ownerId, ownerUsername = '') {
        if (!record) return false;
        const owner = this._ownerIdentity(ownerId, ownerUsername);
        if (!owner.strict && this.resolveOwner) {
            const resolved = this._resolveOwnerReference(owner);
            if (!resolved) return false;
            return record.ownerId === resolved.userId
                || (
                    resolved.legacyOwnerAllowed !== false
                    && !record.ownerUsername
                    && record.ownerId === resolved.username
                );
        }
        if (owner.userId && record.ownerId === owner.userId) return true;
        if (!owner.username) return false;
        if (record.ownerUsername) return !owner.strict && record.ownerUsername === owner.username;
        if (record.ownerId !== owner.username) return false;
        if (!owner.strict || !this.resolveOwner) return true;
        try {
            const resolved = this.resolveOwner({
                userId: record.ownerId,
                username: owner.username,
                legacy: true,
            });
            return resolved?.status === 'active'
                && resolved.legacyOwnerAllowed !== false
                && resolved.userId === owner.userId;
        } catch {
            return false;
        }
    }

    _connectionOwnedBy(connection, ownerId, ownerUsername = '') {
        if (!connection) return false;
        const owner = this._ownerIdentity(ownerId, ownerUsername);
        if (!owner.strict && this.resolveOwner) {
            const resolved = this._resolveOwnerReference(owner);
            if (!resolved) return false;
            return connection.ownerId === resolved.userId
                || (
                    resolved.legacyOwnerAllowed !== false
                    && !connection.ownerUsername
                    && connection.ownerId === resolved.username
                );
        }
        if (owner.userId && connection.ownerId === owner.userId) return true;
        if (!owner.username) return false;
        if (connection.ownerUsername) return !owner.strict && connection.ownerUsername === owner.username;
        return connection.ownerId === owner.username;
    }

    _resolveOwnerReference(owner) {
        try {
            const resolved = this.resolveOwner({
                userId: owner.userId,
                username: owner.username,
                legacy: true,
            });
            return resolved?.status === 'active' && resolved.userId && resolved.username
                ? { ...resolved }
                : null;
        } catch {
            return null;
        }
    }

    _recordInAccountNamespace(record, ownerId) {
        if (!record) return false;
        const owner = this._ownerIdentity(ownerId);
        if (owner.userId && record.ownerId === owner.userId) return true;
        return !!owner.username && !record.ownerUsername && record.ownerId === owner.username;
    }

    _ownerBlocked(recordOrOwner) {
        const values = typeof recordOrOwner === 'object'
            ? [recordOrOwner.ownerId, recordOrOwner.ownerUsername, recordOrOwner.userId, recordOrOwner.username]
            : [recordOrOwner];
        return values.some((value) => value && this.blockedOwnerIds.has(String(value)));
    }

    _assertOwnerAvailable(ownerId, ownerUsername = '') {
        if (this._ownerBlocked(this._ownerIdentity(ownerId, ownerUsername))) {
            throw new AgentError('account_cleanup_in_progress', 'Account cleanup is in progress');
        }
    }

    _generateToken(length = 50) {
        const n = Math.max(16, Math.min(256, Number(length) || 50));
        return crypto.randomBytes(Math.ceil(n * 3 / 4) + 4).toString('base64url').slice(0, n);
    }

    _newTokenRecord(ownerId, name, length = 50, ownerUsername = '') {
        const owner = this._ownerIdentity(ownerId, ownerUsername);
        const primaryOwnerId = this._storeOwnerId(ownerId, ownerUsername);
        if (!primaryOwnerId) throw new AgentError('invalid_owner', 'Token owner is required');
        this._assertOwnerAvailable(owner);
        const token = this._generateToken(length);
        const record = this._ensureTokenStore().create({
            ownerUserId: primaryOwnerId,
            name,
            secret: token,
        });
        return { ...record, ownerUsername: owner.username || '' };
    }

    listTokens(ownerId, { includeToken = false } = {}) {
        if (this._ownerBlocked(this._ownerIdentity(ownerId))) return [];
        const ownerUserId = this._storeOwnerId(ownerId);
        if (!ownerUserId) return [];
        return this._ensureTokenStore().list(ownerUserId, { includeSecret: includeToken })
            .map((t) => ({
                id: t.id,
                name: t.name,
                token: includeToken ? t.token : undefined,
                revision: t.revision,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                lastUsedAt: t.lastUsedAt || null,
            }));
    }

    publicTokenRecord(record, includeToken = false) {
        if (!record) return null;
        return {
            id: record.id,
            name: record.name,
            token: includeToken ? record.token : undefined,
            revision: record.revision,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            lastUsedAt: record.lastUsedAt || null,
        };
    }

    createToken(ownerId, name, length = 50, ownerUsername = '') {
        return this._newTokenRecord(ownerId, name, length, ownerUsername);
    }

    findTokenRecord(ownerId, tokenId) {
        if (this._ownerBlocked(this._ownerIdentity(ownerId))) return null;
        const ownerUserId = this._storeOwnerId(ownerId);
        if (!ownerUserId) return null;
        return this._ensureTokenStore().read(ownerUserId, tokenId, { includeSecret: true });
    }

    updateToken(ownerId, tokenId, patch = {}) {
        this._assertOwnerAvailable(ownerId);
        const record = this.findTokenRecord(ownerId, tokenId);
        if (!record) throw new AgentError('not_found', 'Token not found');
        if (patch.name == null) return record;
        return this._ensureTokenStore().rename(
            record.ownerId,
            record.id,
            String(patch.name || '').trim().slice(0, 80) || record.name,
            { expectedRevision: record.revision },
        );
    }

    deleteToken(ownerId, tokenId) {
        this._assertOwnerAvailable(ownerId);
        const record = this.findTokenRecord(ownerId, tokenId);
        if (!record) throw new AgentError('not_found', 'Token not found');
        this._ensureTokenStore().revoke(record.ownerId, record.id, { expectedRevision: record.revision });
        this._disconnectAgentsForToken(ownerId, record.id, 'token_deleted');
        return true;
    }

    regenerateTokenRecord(ownerId, tokenId, length = 50) {
        this._assertOwnerAvailable(ownerId);
        const record = this.findTokenRecord(ownerId, tokenId);
        if (!record) throw new AgentError('not_found', 'Token not found');
        const updated = this._ensureTokenStore().rotateSecret(
            record.ownerId,
            record.id,
            this._generateToken(length),
            { expectedRevision: record.revision },
        );
        this._disconnectAgentsForToken(ownerId, record.id, 'token_regenerated');
        return updated;
    }

    _disconnectAgentsForToken(ownerId, tokenId, reason) {
        for (const [agentId, conn] of [...this.agents]) {
            if (conn.tokenId === tokenId && this._connectionOwnedBy(conn, ownerId)) {
                this.unregisterAgent(agentId, reason);
            }
        }
    }

    /** Generate or retrieve a default file-agent token for legacy callers. */
    getOrCreateToken(ownerId) {
        const existing = this.listTokens(ownerId, { includeToken: true })[0];
        return existing?.token || this.createToken(ownerId, '默认 Token').token;
    }

    /** Legacy regenerate: reset all tokens for this user and return a new default token. */
    regenerateToken(ownerId, length = 50, name = 'Default Token') {
        this._assertOwnerAvailable(ownerId);
        const ownerUserId = this._storeOwnerId(ownerId);
        if (!ownerUserId) throw new AgentError('invalid_owner', 'Token owner is required');
        const record = this._ensureTokenStore().replaceOwnerTokens({
            ownerUserId,
            name,
            secret: this._generateToken(length),
        });
        for (const [agentId, conn] of [...this.agents]) {
            if (this._connectionOwnedBy(conn, ownerId)) this.unregisterAgent(agentId, 'token_regenerated');
        }
        return record.token;
    }

    validateTokenRecord(token) {
        let record;
        try {
            record = this._ensureTokenStore().validate(token);
        } catch {
            return null;
        }
        if (!record || this._ownerBlocked(record)) return null;
        if (this.resolveOwner) {
            let owner;
            try {
                owner = this.resolveOwner({
                    userId: record.ownerId,
                    username: record.ownerId,
                    legacy: false,
                });
            } catch {
                return null;
            }
            if (!owner || owner.status !== 'active' || !owner.userId || !owner.username) return null;
            if (record.ownerId !== owner.userId) return null;
            record = { ...record, ownerUsername: owner.username };
        }
        return record;
    }

    /** Validate a token and return the ownerId, or null if invalid. */
    validateToken(token) {
        return this.validateTokenRecord(token)?.ownerId || null;
    }

    listTokenMetadata(ownerUserId) {
        return this._ensureTokenStore().listTokenMetadata(String(ownerUserId || ''));
    }

    readTokenMetadata(ownerUserId, tokenId, options = {}) {
        return this._ensureTokenStore().readTokenMetadata(String(ownerUserId || ''), tokenId, options);
    }

    renameTokenMetadata(ownerUserId, tokenId, name, options = {}) {
        return this._ensureTokenStore().renameTokenMetadata(String(ownerUserId || ''), tokenId, name, options);
    }

    revokeTokenMetadata(ownerUserId, tokenId, options = {}) {
        const revoked = this._ensureTokenStore().revokeTokenMetadata(String(ownerUserId || ''), tokenId, options);
        if (revoked) this._disconnectAgentsForToken({ userId: String(ownerUserId || '') }, tokenId, 'token_deleted');
        return revoked;
    }

    rotateTokenEncryptionKey() {
        return this._ensureTokenStore().rotateEncryptionKey();
    }

    rebindTokenDatabase() {
        const previous = this.boundTokenDb;
        const store = this._ensureTokenStore();
        return { changed: !!previous && previous !== store.db, db: store.db };
    }

    async deleteUserState({ userId, username } = {}) {
        const owner = this._ownerIdentity({ userId, username });
        const identities = new Set([owner.userId, owner.username].filter(Boolean));
        if (!identities.size) throw new AgentError('invalid_owner', 'Account identity is required');
        if ([...identities].some((identity) => this.blockedOwnerIds.has(identity))) {
            throw new AgentError('account_cleanup_in_progress', 'Account cleanup is already in progress');
        }
        for (const identity of identities) this.blockedOwnerIds.add(identity);

        try {
            const agentIds = [...this.agents]
                .filter(([, connection]) => this._connectionOwnedBy(connection, owner))
                .map(([agentId]) => agentId);
            const queuePromises = [...this.binaryReadQueues]
                .filter(([key]) => agentIds.some((agentId) => key.startsWith(`${agentId}:`)))
                .map(([, promise]) => promise);
            const sseClients = [...this.sseClients]
                .filter((response) => this._sseOwnedBy(response, owner));

            await Promise.all([
                ...agentIds.map((agentId) => this._drainAgent(agentId, 'account_deleted')),
                ...sseClients.map((response) => this._drainSse(response)),
            ]);
            await this._settleWithin(queuePromises, this.teardownTimeoutMs);
            for (const agentId of agentIds) this._dropBinaryReadStateForAgent(agentId);

            const deletedTokens = this._ensureTokenStore().revokeOwners([...identities]);
            return {
                deletedTokens,
                disconnectedAgents: agentIds.length,
                closedSubscriptions: sseClients.length,
            };
        } finally {
            for (const identity of identities) this.blockedOwnerIds.delete(identity);
        }
    }

    async _drainAgent(agentId, reason) {
        const connection = this.agents.get(agentId);
        if (!connection) return;
        const closed = this._waitForStreamEnd(connection.ws);
        this.unregisterAgent(agentId, reason);
        const ended = await closed;
        if (!ended) {
            const terminated = this._waitForStreamEnd(connection.ws);
            try { connection.ws.terminate?.(); } catch {}
            await terminated;
        }
    }

    async _drainSse(response) {
        if (!this.sseClients.has(response)) return;
        this.sseClients.delete(response);
        const ended = this._waitForStreamEnd(response);
        try { response.end(); } catch {}
        if (!await ended) {
            const destroyed = this._waitForStreamEnd(response);
            try { response.destroy?.(); } catch {}
            await destroyed;
        }
    }

    _waitForStreamEnd(stream) {
        if (!stream || stream.destroyed || stream.writableEnded || stream.readyState === WebSocket.CLOSED) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = (ended) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                stream.removeListener?.('close', onEnd);
                stream.removeListener?.('finish', onEnd);
                resolve(ended);
            };
            const onEnd = () => finish(true);
            stream.once?.('close', onEnd);
            stream.once?.('finish', onEnd);
            timer = setTimeout(() => finish(false), this.teardownTimeoutMs);
            timer.unref?.();
        });
    }

    async _settleWithin(promises, timeoutMs) {
        if (!promises.length) return;
        let timer = null;
        await Promise.race([
            Promise.allSettled(promises),
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
                timer.unref?.();
            }),
        ]);
        if (timer) clearTimeout(timer);
    }

    // ─── Agent Registration ──────────────────────────────────────────

    admitUpgrade(socket) {
        return this.admissionGate.admit(socket);
    }

    releaseUpgradeAdmission(lease) {
        return this.admissionGate.release(lease);
    }

    getAdmissionSnapshot() {
        return this.admissionGate.snapshot();
    }

    /** Handle a new Agent WebSocket connection. */
    handleConnection(ws, req = null) {
        let admission = req?.fileAgentAdmission || null;
        if (!admission) {
            const admitted = this.admitUpgrade(ws?._socket || { remoteAddress: 'unknown' });
            if (!admitted.ok) {
                try { ws.close(1013, 'Connection limit exceeded'); } catch {}
                return false;
            }
            admission = admitted.lease;
        }
        if (!this.admissionGate.attachWebSocket(admission, ws)) {
            try { ws.close(1008, 'Connection no longer admissible'); } catch {}
            return false;
        }

        let state = 'preauth';
        let agentId = null;
        let preAuthMessages = 0;
        let terminationTimer = null;
        const clearTerminationTimer = () => {
            if (terminationTimer) clearTimeout(terminationTimer);
            terminationTimer = null;
        };
        const scheduleTermination = () => {
            if (terminationTimer) return;
            terminationTimer = setTimeout(() => {
                if (ws.readyState !== WebSocket.CLOSED) {
                    try { ws.terminate(); } catch {}
                }
            }, this.preAuthCloseGraceMs);
            terminationTimer.unref?.();
        };
        let authTimeout = null;
        const rejectPreAuth = (code, reason, error = null) => {
            if (state === 'closed' || state === 'rejected') return;
            state = 'rejected';
            if (authTimeout) clearTimeout(authTimeout);
            if (error && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        type: 'hello_ack',
                        ok: false,
                        error: { code: error.code, message: error.message },
                    }));
                } catch {}
            }
            try { ws.close(code, String(reason || '').slice(0, 120)); } catch {}
            scheduleTermination();
        };
        authTimeout = setTimeout(() => {
            if (state === 'preauth' || state === 'authenticating') {
                rejectPreAuth(1008, 'Authentication timeout');
            }
        }, this.authTimeoutMs);
        authTimeout.unref?.();

        ws.on('message', (raw, isBinary) => {
            if (state === 'authenticated' && agentId) {
                const conn = this.agents.get(agentId);
                if (conn && conn.handleBinaryResponse(raw)) return;
            }

            if (state !== 'authenticated') {
                preAuthMessages += 1;
                if (preAuthMessages !== 1 || state !== 'preauth') {
                    rejectPreAuth(1008, 'hello must be the first and only pre-auth message');
                    return;
                }
                state = 'authenticating';
                if (isBinary === true) {
                    rejectPreAuth(1008, 'hello must be a text message');
                    return;
                }
                const rawBytes = typeof raw === 'string'
                    ? Buffer.byteLength(raw, 'utf8')
                    : Number(raw?.byteLength ?? raw?.length ?? 0);
                if (!Number.isSafeInteger(rawBytes) || rawBytes <= 0 || rawBytes > this.preAuthMaxMessageBytes) {
                    rejectPreAuth(1009, 'hello message too large');
                    return;
                }
                if (!this.admissionGate.reservePendingBytes(admission, rawBytes)) {
                    rejectPreAuth(1009, 'pre-auth buffer budget exceeded');
                    return;
                }

                let hello;
                try {
                    hello = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
                } catch {
                    this.admissionGate.releasePendingBytes(admission);
                    rejectPreAuth(1008, 'invalid hello JSON');
                    return;
                }
                if (!validateHelloMessage(hello)) {
                    this.admissionGate.releasePendingBytes(admission);
                    rejectPreAuth(1008, 'invalid hello structure');
                    return;
                }

                try {
                    agentId = this._handleHello(ws, hello, () => {
                        if (!this.admissionGate.promote(admission)) return false;
                        if (ws?._receiver && '_maxPayload' in ws._receiver) {
                            ws._receiver._maxPayload = this.authenticatedMaxMessageBytes;
                        }
                        return true;
                    }, admission);
                    state = 'authenticated';
                    clearTimeout(authTimeout);
                } catch (err) {
                    this.admissionGate.releasePendingBytes(admission);
                    if (agentId) this.unregisterAgent(agentId, 'authentication_failed', ws);
                    const failure = err instanceof AgentError
                        ? err
                        : new AgentError('internal_error', 'Agent authentication failed');
                    rejectPreAuth(1008, failure.message, failure);
                }
                return;
            }

            let msg;
            try {
                msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
            } catch {
                return;
            }

            // Authenticated messages
            switch (msg.type) {
                case 'response':
                    this._handleAgentResponse(agentId, msg);
                    break;
                case 'ping':
                    this._handlePing(agentId, ws, msg);
                    break;
                case 'agent_auto_shutdown':
                    this._handleAutoShutdown(agentId, msg);
                    break;
                default:
                    break;
            }
        });

        ws.on('close', () => {
            state = 'closed';
            clearTimeout(authTimeout);
            clearTerminationTimer();
            if (agentId) {
                this.unregisterAgent(agentId, 'connection_closed', ws);
            }
        });

        ws.on('error', (err) => {
            this.log('[file-agent] ws error:', err.message);
            clearTimeout(authTimeout);
            scheduleTermination();
            if (agentId) {
                this.unregisterAgent(agentId, 'ws_error', ws);
            }
        });
        return true;
    }

    _handleHello(ws, hello, authorizeRegistration = () => true, admission = null) {
        // Validate protocol version
        if (hello.protocolVersion !== 1 && hello.protocolVersion !== 2) {
            throw new AgentError('unsupported', `Unsupported protocol version: ${hello.protocolVersion}`);
        }

        // Validate token
        const tokenRecord = this.validateTokenRecord(hello.token);
        if (!tokenRecord) {
            throw new AgentError('unauthorized', 'Invalid token');
        }
        const ownerId = tokenRecord.ownerId;
        if (!authorizeRegistration()) {
            throw new AgentError('resource_exhausted', 'Authenticated connection limit exceeded');
        }

        // Generate agentId from deviceId (stable) or random
        const agentId = hello.deviceId
            ? `agent_${crypto.createHash('sha256').update(hello.deviceId + ownerId).digest('hex').slice(0, 12)}`
            : `agent_${crypto.randomBytes(6).toString('hex')}`;

        const conn = new FileAgentConnection(ws, agentId, hello);
        conn.ownerId = ownerId;
        conn.ownerUsername = tokenRecord.ownerUsername || '';
        conn.tokenId = tokenRecord.id;
        conn.tokenName = tokenRecord.name;

        // Send hello_ack
        try {
            ws.send(JSON.stringify({
                type: 'hello_ack',
                ok: true,
                agentId,
                serverTime: Date.now(),
                heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            }));
        } catch (err) {
            this.log('[file-agent] failed to send hello_ack:', err.message);
            throw new AgentError('io_error', 'Failed to send hello acknowledgement');
        }
        if (ws.readyState !== WebSocket.OPEN || admission?.released) {
            throw new AgentError('io_error', 'Connection closed during authentication');
        }

        // Replace the old device only after the new acknowledgement was queued.
        if (this.agents.has(agentId)) {
            const old = this.agents.get(agentId);
            old.cleanup();
            try { old.ws.close(1000, 'Replaced by new connection'); } catch {}
            this.agents.delete(agentId);
        }

        this.agents.set(agentId, conn);
        if (!this.ownerAgents.has(ownerId)) {
            this.ownerAgents.set(ownerId, new Set());
        }
        this.ownerAgents.get(ownerId).add(agentId);

        // Start heartbeat monitor
        conn.heartbeatTimer = setInterval(() => {
            conn.heartbeatMissCount++;
            if (conn.heartbeatMissCount >= HEARTBEAT_TIMEOUT_FACTOR) {
                this.log(`[file-agent] heartbeat timeout for ${agentId}`);
                this.unregisterAgent(agentId, 'heartbeat_timeout');
            }
        }, HEARTBEAT_INTERVAL_MS);

        this.log(`[file-agent] registered: ${conn.deviceName} (${agentId}) for owner ${ownerId}`);
        this._broadcastEvent({
            type: 'file_agent_online',
            agent: conn.toPublicInfo(),
        }, ownerId);

        return agentId;
    }

    /** Unregister an Agent and broadcast offline event. */
    unregisterAgent(agentId, reason, expectedWs = null) {
        const conn = this.agents.get(agentId);
        if (!conn || (expectedWs && conn.ws !== expectedWs)) return;

        const ownerId = conn.ownerId;
        conn.cleanup();
        try {
            if (conn.ws.readyState === WebSocket.OPEN) {
                conn.ws.close(1000, reason || 'Unregistered');
            }
        } catch {}

        this.agents.delete(agentId);
        this._dropBinaryReadStateForAgent(agentId);
        const ownerSet = this.ownerAgents.get(ownerId);
        if (ownerSet) {
            ownerSet.delete(agentId);
            if (ownerSet.size === 0) this.ownerAgents.delete(ownerId);
        }

        this.log(`[file-agent] unregistered: ${conn.deviceName} (${agentId}), reason: ${reason}`);
        this._broadcastEvent({
            type: 'file_agent_offline',
            agentId,
            reason,
        }, ownerId);
    }

    _handleAgentResponse(agentId, msg) {
        const conn = this.agents.get(agentId);
        if (!conn) return;
        conn.lastSeenAt = Date.now();
        conn.handleResponse(msg);
    }

    _handlePing(agentId, ws, msg) {
        const conn = this.agents.get(agentId);
        if (!conn) return;
        conn.lastSeenAt = Date.now();
        conn.heartbeatMissCount = 0;
        try {
            ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        } catch {}
    }

    _handleAutoShutdown(agentId, msg) {
        this.log(`[file-agent] auto-shutdown from ${agentId}: ${msg.reason}`);
        this.unregisterAgent(agentId, msg.reason || 'auto_shutdown');
    }

    // ─── File RPC Forwarding ─────────────────────────────────────────

    /** Forward a file RPC call to the specified Agent. */
    async callAgent(agentId, method, params, timeoutMs) {
        const conn = this.agents.get(agentId);
        if (!conn) {
            throw new AgentError('agent_offline', `Agent ${agentId} not found or offline`);
        }
        if (!conn.online) {
            throw new AgentError('agent_offline', `Agent ${agentId} is not connected`);
        }

        // Check capabilities
        if (method === 'write' && conn.share.readOnly) {
            throw new AgentError('read_only', 'Agent share is read-only');
        }
        if (['delete', 'mkdir', 'rename', 'truncate'].includes(method) && conn.share.readOnly) {
            throw new AgentError('read_only', 'Agent share is read-only');
        }

        const timeout = method === 'read' || method === 'write'
            ? (timeoutMs || RPC_READ_TIMEOUT_MS)
            : (timeoutMs || RPC_DEFAULT_TIMEOUT_MS);

        return conn.callRpc(method, params, timeout);
    }

    async callAgentBinaryRead(agentId, params, timeoutMs) {
        const conn = this.agents.get(agentId);
        if (!conn) throw new AgentError('agent_offline', `Agent ${agentId} not found or offline`);
        if (!conn.online) throw new AgentError('agent_offline', `Agent ${agentId} is not connected`);
        if (!conn.capabilities || conn.capabilities.binaryRead !== true) {
            throw new AgentError('unsupported', 'Agent does not support binary read');
        }
        return conn.callBinaryRead(params, timeoutMs || RPC_READ_TIMEOUT_MS);
    }

    _binaryReadKey(agentId, handle, offset, length) {
        return `${agentId}:${handle}:${offset}:${length}`;
    }

    _binaryReadQueueKey(agentId, handle) {
        return `${agentId}:${handle}`;
    }

    _callAgentBinaryReadQueued(agentId, params, timeoutMs) {
        const handle = String(params.handle || '');
        const qKey = this._binaryReadQueueKey(agentId, handle);
        const prev = this.binaryReadQueues.get(qKey) || Promise.resolve();
        const next = prev.catch(() => {}).then(() => this.callAgentBinaryRead(agentId, params, timeoutMs));
        let tracked;
        tracked = next.finally(() => {
            if (this.binaryReadQueues.get(qKey) === tracked) this.binaryReadQueues.delete(qKey);
        });
        this.binaryReadQueues.set(qKey, tracked);
        return next;
    }

    _trimBinaryReadCache() {
        if (this.binaryReadCacheBytes <= BINARY_READ_MAX_CACHE_BYTES) return;
        const entries = [...this.binaryReadCache.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        for (const [key, entry] of entries) {
            if (this.binaryReadCacheBytes <= BINARY_READ_MAX_CACHE_BYTES) break;
            this.binaryReadCache.delete(key);
            if (entry.data) this.binaryReadCacheBytes -= entry.size || entry.data.length || 0;
        }
    }

    _dropBinaryReadCacheForHandle(agentId, handle) {
        const prefix = `${agentId}:${handle}:`;
        for (const [key, entry] of [...this.binaryReadCache.entries()]) {
            if (!key.startsWith(prefix)) continue;
            this.binaryReadCache.delete(key);
            if (entry.data) this.binaryReadCacheBytes -= entry.size || entry.data.length || 0;
        }
    }

    _dropBinaryReadStateForAgent(agentId) {
        const prefix = `${agentId}:`;
        for (const [key, entry] of [...this.binaryReadCache]) {
            if (!key.startsWith(prefix)) continue;
            this.binaryReadCache.delete(key);
            if (entry.data) this.binaryReadCacheBytes -= entry.size || entry.data.length || 0;
        }
        for (const key of [...this.binaryReadQueues.keys()]) {
            if (key.startsWith(prefix)) this.binaryReadQueues.delete(key);
        }
        this.binaryReadCacheBytes = Math.max(0, this.binaryReadCacheBytes);
    }

    _scheduleBinaryReadPrefetch(agentId, handle, offset, length) {
        if (!handle || !Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return;
        for (let i = 1; i <= BINARY_READ_PREFETCH_CHUNKS; i++) {
            const nextOffset = offset + length * i;
            const key = this._binaryReadKey(agentId, handle, nextOffset, length);
            if (this.binaryReadCache.has(key)) continue;
            const entry = { ts: Date.now(), size: 0 };
            entry.promise = this._callAgentBinaryReadQueued(agentId, { handle, offset: nextOffset, length })
                .then((buf) => {
                    if (!this.agents.has(agentId) || this.binaryReadCache.get(key) !== entry) return buf;
                    entry.data = buf;
                    entry.size = buf.length;
                    entry.ts = Date.now();
                    this.binaryReadCacheBytes += buf.length;
                    this._trimBinaryReadCache();
                    return buf;
                })
                .catch((err) => {
                    entry.error = err;
                    this.binaryReadCache.delete(key);
                    return null;
                });
            this.binaryReadCache.set(key, entry);
        }
    }

    async callAgentBinaryReadCached(agentId, params, timeoutMs) {
        const handle = String(params.handle || '');
        const offset = Number(params.offset || 0);
        const length = Number(params.length || 0);
        const key = this._binaryReadKey(agentId, handle, offset, length);
        let entry = this.binaryReadCache.get(key);
        let buf;
        if (entry) {
            entry.ts = Date.now();
            buf = entry.data || await entry.promise;
            this.binaryReadCache.delete(key);
            if (entry.data) this.binaryReadCacheBytes -= entry.size || entry.data.length || 0;
            if (!Buffer.isBuffer(buf)) {
                buf = await this._callAgentBinaryReadQueued(agentId, params, timeoutMs);
            }
        } else {
            buf = await this._callAgentBinaryReadQueued(agentId, params, timeoutMs);
        }
        this._scheduleBinaryReadPrefetch(agentId, handle, offset, length);
        return buf;
    }

    // ─── Query ───────────────────────────────────────────────────────

    /** List online agents for a specific user. */
    listAgentsForUser(ownerId) {
        const result = [];
        for (const conn of this.agents.values()) {
            if (conn.online && this._connectionOwnedBy(conn, ownerId)) result.push(conn.toPublicInfo());
        }
        return result;
    }

    /** Get all online agents (admin view). */
    listAllAgents() {
        const result = [];
        for (const conn of this.agents.values()) {
            if (conn.online) {
                result.push(conn.toPublicInfo());
            }
        }
        return result;
    }

    /** Get a specific agent's info. */
    getAgentInfo(agentId) {
        const conn = this.agents.get(agentId);
        return conn ? conn.toPublicInfo() : null;
    }

    /** Check if an agent belongs to a user. */
    isAgentOwnedBy(agentId, ownerId) {
        const conn = this.agents.get(agentId);
        return this._connectionOwnedBy(conn, ownerId);
    }

    /** Accept immutable userId ownership with username fallback for migrated tokens. */
    isAgentOwnedByUser(agentId, user) {
        const conn = this.agents.get(agentId);
        if (!conn || !user) return false;
        return this._connectionOwnedBy(conn, user);
    }

    /** Protocol-v2 operation with explicit cancellation. */
    callAgentV2(agentId, method, params = {}, timeoutMs = RPC_READ_TIMEOUT_MS) {
        const conn = this.agents.get(agentId);
        if (!conn || !conn.online) {
            return { promise: Promise.reject(new AgentError('agent_offline', `Agent ${agentId} is not connected`)), cancel() {} };
        }
        if (method === 'writeBinary' && conn.share.readOnly) {
            return { promise: Promise.reject(new AgentError('read_only', 'Agent share is read-only')), cancel() {} };
        }
        const mutating = ['writeBinary', 'mkdir', 'delete', 'rename', 'truncate'];
        if (mutating.includes(method) && conn.share.readOnly) {
            return { promise: Promise.reject(new AgentError('read_only', 'Agent share is read-only')), cancel() {} };
        }
        const map = {
            open: ZFT2_OP.OPEN, readBinary: ZFT2_OP.READ, writeBinary: ZFT2_OP.WRITE,
            close: ZFT2_OP.CLOSE, stat: ZFT2_OP.STAT, list: ZFT2_OP.LIST,
            mkdir: ZFT2_OP.MKDIR, delete: ZFT2_OP.DELETE, rename: ZFT2_OP.RENAME,
            truncate: ZFT2_OP.TRUNCATE,
        };
        const type = map[method];
        if (!type) return { promise: Promise.reject(new AgentError('unsupported', `Unsupported ZFT2 method ${method}`)), cancel() {} };
        const meta = { ...params };
        let payload = null;
        if (method === 'writeBinary') {
            payload = Buffer.from(meta.data || []);
            delete meta.data;
        }
        return conn.callBinaryV2(type, meta, payload, timeoutMs);
    }

    // ─── SSE Broadcasting ────────────────────────────────────────────

    /** Subscribe an SSE client (HTTP response) for agent events. */
    subscribeSse(res, ownerId) {
        const owner = this._ownerIdentity(ownerId);
        if (this._ownerBlocked(owner)) {
            try { res.end(); } catch {}
            return false;
        }
        res._sseOwnerId = owner.userId;
        res._sseOwnerUsername = owner.username;
        res._sseOwnerStrict = owner.strict;
        this.sseClients.add(res);
        res.on('close', () => this.sseClients.delete(res));

        // Send current agent list as initial event
        const agents = this.listAgentsForUser(ownerId);
        this._sendSse(res, 'agent_list', { agents });
        return true;
    }

    _sseOwnedBy(response, ownerId) {
        const owner = this._ownerIdentity(ownerId);
        if (owner.userId && response._sseOwnerId === owner.userId) return true;
        if (!owner.username) return false;
        if (response._sseOwnerStrict && owner.strict) return false;
        return response._sseOwnerId === owner.username
            || response._sseOwnerUsername === owner.username;
    }

    _sendSse(res, eventType, data) {
        try {
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {}
    }

    _broadcastEvent(event, ownerId) {
        for (const res of this.sseClients) {
            if (this._sseOwnedBy(res, ownerId)) {
                this._sendSse(res, event.type, event);
            }
        }
    }

    // ─── Express Route Handlers ──────────────────────────────────────

    /**
     * Mount REST API routes onto an Express app.
     * @param {import('express').Application} app
     * @param {Function} requireUser - middleware that resolves an active user
     * @param {Function} getSessionUser - (req) => { username, ... }
     */
    mountRoutes(app, requireUser, getSessionUser, verifySensitiveAccess = null) {
        // GET /api/rdp/file-agents — list online agents for current user
        app.get('/api/rdp/file-agents', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.json({ ok: true, agents: this.listAgentsForUser(user) });
        });

        // GET /api/rdp/file-agent-tokens — list named agent tokens
        app.get('/api/rdp/file-agent-tokens', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.json({ ok: true, tokens: this.listTokens(user) });
        });

        // POST /api/rdp/file-agent-tokens — create named token
        app.post('/api/rdp/file-agent-tokens', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const record = this.createToken(user, req.body?.name || 'Zephyr Agent Token', req.body?.length || 50);
            res.json({ ok: true, token: this.publicTokenRecord(record, true) });
        });

        // PATCH /api/rdp/file-agent-tokens/:tokenId — rename token
        app.patch('/api/rdp/file-agent-tokens/:tokenId', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                const record = this.updateToken(user, req.params.tokenId, { name: req.body?.name });
                res.json({ ok: true, token: this.listTokens(user).find((t) => t.id === record.id) });
            } catch (err) {
                const status = ['not_found', 'client_token_not_found'].includes(err.code) ? 404 : 500;
                res.status(status).json({ ok: false, error: { code: err.code || 'internal_error', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/:tokenId/regenerate — rotate one token (password/TOTP required)
        app.post('/api/rdp/file-agent-tokens/:tokenId/regenerate', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                const record = this.regenerateTokenRecord(user, req.params.tokenId, req.body?.length || 50);
                res.json({ ok: true, token: this.publicTokenRecord(record, true) });
            } catch (err) {
                const status = ['not_found', 'client_token_not_found'].includes(err.code) ? 404 : 400;
                res.status(status).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/:tokenId/open — reveal token after password/TOTP check
        app.post('/api/rdp/file-agent-tokens/:tokenId/open', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                const record = this.findTokenRecord(user, req.params.tokenId);
                if (!record) throw new AgentError('not_found', 'Token not found');
                res.json({ ok: true, token: this.publicTokenRecord(record, true) });
            } catch (err) {
                res.status(err.code === 'not_found' ? 404 : 400).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/reset-all — delete all tokens and create one fresh token
        app.post('/api/rdp/file-agent-tokens/reset-all', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                const token = this.regenerateToken(
                    user,
                    req.body?.length || 50,
                    req.body?.name || 'Default Token',
                );
                const record = this.listTokens(user, { includeToken: true })
                    .find((candidate) => candidate.token === token);
                res.json({ ok: true, token: this.publicTokenRecord(record, true) });
            } catch (err) {
                res.status(400).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // DELETE /api/rdp/file-agent-tokens/:tokenId — delete one token (password/TOTP required)
        app.delete('/api/rdp/file-agent-tokens/:tokenId', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                // Express DELETE body may be empty; also accept query.secret for clients that cannot send body.
                verifySensitiveAccess(req, req.body?.secret ?? req.query?.secret);
                this.deleteToken(user, req.params.tokenId);
                res.json({ ok: true });
            } catch (err) {
                const status = ['not_found', 'client_token_not_found'].includes(err.code)
                    ? 404
                    : (err.code === 'unsupported' ? 500 : 400);
                res.status(status).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/:tokenId/delete — JSON-body friendly delete with secret
        app.post('/api/rdp/file-agent-tokens/:tokenId/delete', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                this.deleteToken(user, req.params.tokenId);
                res.json({ ok: true });
            } catch (err) {
                const status = ['not_found', 'client_token_not_found'].includes(err.code) ? 404 : 400;
                res.status(status).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // GET /api/rdp/file-agent-token — legacy endpoint: ensure default token exists, but do not reveal it.
        app.get('/api/rdp/file-agent-token', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            this.getOrCreateToken(user);
            res.json({ ok: true, token: null, deprecated: true, message: 'Use Settings → Zephyr Client to reveal tokens after password/TOTP verification.' });
        });

        // POST /api/rdp/file-agent-token/regenerate — legacy reset endpoint, requires password/TOTP
        app.post('/api/rdp/file-agent-token/regenerate', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                const token = this.regenerateToken(user);
                res.json({ ok: true, token });
            } catch (err) {
                res.status(400).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // GET /api/rdp/file-agents/events — SSE stream
        app.get('/api/rdp/file-agents/events', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write('\n');
            this.subscribeSse(res, user);
        });

        // POST /api/rdp/file-agents/:agentId/rpc/read-binary — binary fast path for reads
        app.post('/api/rdp/file-agents/:agentId/rpc/read-binary', requireUser, async (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).end();

            const { agentId } = req.params;
            if (!this.isAgentOwnedByUser(agentId, user)) {
                return res.status(403).end();
            }

            const handle = String(req.query.handle || '');
            const offset = Number(req.query.offset || 0);
            const length = Math.max(0, Math.min(1 * 1024 * 1024, Number(req.query.length || 0)));
            if (!handle || !Number.isFinite(offset) || !Number.isFinite(length)) {
                return res.status(400).end();
            }

            try {
                const buf = await this.callAgentBinaryReadCached(agentId, { handle, offset, length });
                res.status(200);
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Content-Length', buf.length);
                res.end(buf);
            } catch (err) {
                const code = err.code || 'internal_error';
                const status = code === 'unsupported' ? 426 : code === 'agent_offline' ? 503 : code === 'timeout' ? 504 : 500;
                res.status(status).setHeader('X-Zephyr-Error', code).end();
            }
        });

        // POST /api/rdp/file-agents/:agentId/rpc — forward RPC to agent
        app.post('/api/rdp/file-agents/:agentId/rpc', requireUser, async (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

            const { agentId } = req.params;
            if (!this.isAgentOwnedByUser(agentId, user)) {
                return res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Agent not owned by user' } });
            }

            const { method, params } = req.body || {};
            if (!method) {
                return res.status(400).json({ ok: false, error: { code: 'invalid_parameter', message: 'Missing method' } });
            }

            try {
                if (['write', 'close', 'delete', 'rename', 'truncate'].includes(method)) {
                    const h = params?.handle;
                    if (h) this._dropBinaryReadCacheForHandle(agentId, String(h));
                }
                const result = await this.callAgent(agentId, method, params);
                res.json({ ok: true, result });
            } catch (err) {
                const code = err.code || 'internal_error';
                const status = code === 'agent_offline' ? 503 : code === 'timeout' ? 504 : 500;
                res.status(status).json({ ok: false, error: { code, message: err.message } });
            }
        });
    }

    // ─── Cleanup ─────────────────────────────────────────────────────

    shutdown() {
        this.admissionGate.shutdown();
        for (const [agentId] of this.agents) {
            this.unregisterAgent(agentId, 'server_shutdown');
        }
        for (const res of this.sseClients) {
            try { res.end(); } catch {}
        }
        this.sseClients.clear();
        this.tokenStore.close?.();
        this.boundTokenDb = null;
    }
}

module.exports = {
    FileAgentManager,
    AgentError,
    FileAgentConnection,
    FileAgentAdmissionGate,
    canonicalRemoteIp,
    FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES,
    FILE_AGENT_AUTHENTICATED_MAX_MESSAGE_BYTES,
};
