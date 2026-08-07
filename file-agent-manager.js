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
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
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
const DEFAULT_TOKEN_FILE = path.join(
    process.env.ZEPHYR_DATA_DIR ? path.resolve(process.env.ZEPHYR_DATA_DIR) : path.join(__dirname, 'data'),
    'agent-tokens.json',
);

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
        this.tokenRecords = new Map();
        /** @type {Map<string, {promise?: Promise<Buffer>, data?: Buffer, ts: number, size: number}>} */
        this.binaryReadCache = new Map();
        this.binaryReadCacheBytes = 0;
        this.binaryReadQueues = new Map(); // `${agentId}:${handle}` → Promise chain
        /** @type {Function} resolve userId from session cookie (injected) */
        this.resolveSession = options.resolveSession || (() => null);
        /** @type {Function} logger */
        this.log = options.log || console.log;
        this.tokenFile = path.resolve(options.tokenFile || DEFAULT_TOKEN_FILE);

        this._loadTokens();
    }

    // ─── Token Management ────────────────────────────────────────────

    _loadTokens() {
        try {
            if (!fs.existsSync(this.tokenFile)) return;
            const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
            if (data && Array.isArray(data.tokens)) {
                for (const item of data.tokens) {
                    if (!item || !item.token || !item.ownerId) continue;
                    this.tokenRecords.set(item.token, {
                        id: item.id || `tok_${crypto.randomBytes(6).toString('hex')}`,
                        ownerId: item.ownerId,
                        name: item.name || '默认 Token',
                        token: item.token,
                        createdAt: Number(item.createdAt || Date.now()),
                        updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
                        lastUsedAt: item.lastUsedAt ? Number(item.lastUsedAt) : null,
                    });
                }
                return;
            }
            // Backward compatibility: old format was { token: ownerId }.
            if (data && typeof data === 'object') {
                for (const [token, ownerId] of Object.entries(data)) {
                    if (!token || !ownerId || typeof ownerId !== 'string') continue;
                    this.tokenRecords.set(token, {
                        id: `tok_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`,
                        ownerId,
                        name: '默认 Token',
                        token,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        lastUsedAt: null,
                    });
                }
                this._saveTokens();
            }
        } catch (err) {
            this.log('[file-agent] failed to load tokens:', err.message);
        }
    }

    _saveTokens() {
        try {
            const tokens = [...this.tokenRecords.values()].map((t) => ({
                id: t.id,
                ownerId: t.ownerId,
                name: t.name,
                token: t.token,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                lastUsedAt: t.lastUsedAt || null,
            }));
            fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
            fs.writeFileSync(this.tokenFile, JSON.stringify({ version: 2, tokens }, null, 2));
        } catch (err) {
            this.log('[file-agent] failed to save tokens:', err.message);
        }
    }

    _generateToken(length = 50) {
        const n = Math.max(16, Math.min(256, Number(length) || 50));
        return crypto.randomBytes(Math.ceil(n * 3 / 4) + 4).toString('base64url').slice(0, n);
    }

    _newTokenRecord(ownerId, name, length = 50) {
        const now = Date.now();
        const token = this._generateToken(length);
        const record = {
            id: `tok_${crypto.randomBytes(8).toString('hex')}`,
            ownerId,
            name: String(name || 'Zephyr Agent Token').trim().slice(0, 80) || 'Zephyr Agent Token',
            token,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
        };
        this.tokenRecords.set(token, record);
        this._saveTokens();
        return record;
    }

    listTokens(ownerId, { includeToken = false } = {}) {
        return [...this.tokenRecords.values()]
            .filter((t) => t.ownerId === ownerId)
            .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
            .map((t) => ({
                id: t.id,
                name: t.name,
                token: includeToken ? t.token : undefined,
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
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            lastUsedAt: record.lastUsedAt || null,
        };
    }

    createToken(ownerId, name, length = 50) {
        return this._newTokenRecord(ownerId, name, length);
    }

    findTokenRecord(ownerId, tokenId) {
        return [...this.tokenRecords.values()].find((t) => t.ownerId === ownerId && t.id === tokenId) || null;
    }

    updateToken(ownerId, tokenId, patch = {}) {
        const record = this.findTokenRecord(ownerId, tokenId);
        if (!record) throw new AgentError('not_found', 'Token not found');
        if (patch.name != null) {
            record.name = String(patch.name || '').trim().slice(0, 80) || record.name;
        }
        record.updatedAt = Date.now();
        this._saveTokens();
        return record;
    }

    deleteToken(ownerId, tokenId) {
        const record = this.findTokenRecord(ownerId, tokenId);
        if (!record) throw new AgentError('not_found', 'Token not found');
        this.tokenRecords.delete(record.token);
        this._disconnectAgentsForToken(ownerId, record.id, 'token_deleted');
        this._saveTokens();
    }

    regenerateTokenRecord(ownerId, tokenId, length = 50) {
        const record = this.findTokenRecord(ownerId, tokenId);
        if (!record) throw new AgentError('not_found', 'Token not found');
        this.tokenRecords.delete(record.token);
        this._disconnectAgentsForToken(ownerId, record.id, 'token_regenerated');
        record.token = this._generateToken(length);
        record.updatedAt = Date.now();
        record.lastUsedAt = null;
        this.tokenRecords.set(record.token, record);
        this._saveTokens();
        return record;
    }

    _disconnectAgentsForToken(ownerId, tokenId, reason) {
        const agentIds = this.ownerAgents.get(ownerId);
        if (!agentIds) return;
        for (const agentId of [...agentIds]) {
            const conn = this.agents.get(agentId);
            if (conn && conn.tokenId === tokenId) this.unregisterAgent(agentId, reason);
        }
    }

    /** Generate or retrieve a default file-agent token for legacy callers. */
    getOrCreateToken(ownerId) {
        const existing = this.listTokens(ownerId, { includeToken: true })[0];
        return existing?.token || this._newTokenRecord(ownerId, '默认 Token').token;
    }

    /** Legacy regenerate: reset all tokens for this user and return a new default token. */
    regenerateToken(ownerId) {
        for (const record of [...this.tokenRecords.values()]) {
            if (record.ownerId === ownerId) this.tokenRecords.delete(record.token);
        }
        const agentIds = this.ownerAgents.get(ownerId);
        if (agentIds) {
            for (const agentId of [...agentIds]) this.unregisterAgent(agentId, 'token_regenerated');
        }
        return this._newTokenRecord(ownerId, '默认 Token').token;
    }

    validateTokenRecord(token) {
        const record = this.tokenRecords.get(token) || null;
        if (record) {
            record.lastUsedAt = Date.now();
            this._saveTokens();
        }
        return record;
    }

    /** Validate a token and return the ownerId, or null if invalid. */
    validateToken(token) {
        return this.validateTokenRecord(token)?.ownerId || null;
    }

    // ─── Agent Registration ──────────────────────────────────────────

    /** Handle a new Agent WebSocket connection. */
    handleConnection(ws) {
        let authenticated = false;
        let agentId = null;
        const authTimeout = setTimeout(() => {
            if (!authenticated) {
                try { ws.close(1008, 'Authentication timeout'); } catch {}
            }
        }, 10000);

        ws.on('message', (raw) => {
            if (authenticated && agentId) {
                const conn = this.agents.get(agentId);
                if (conn && conn.handleBinaryResponse(raw)) return;
            }

            let msg;
            try {
                msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
            } catch {
                return;
            }

            if (!authenticated) {
                if (msg.type === 'hello') {
                    clearTimeout(authTimeout);
                    this._handleHello(ws, msg, (err, aid) => {
                        if (err) {
                            try {
                                ws.send(JSON.stringify({
                                    type: 'hello_ack',
                                    ok: false,
                                    error: { code: err.code, message: err.message },
                                }));
                                ws.close(1008, err.message);
                            } catch {}
                            return;
                        }
                        authenticated = true;
                        agentId = aid;
                    });
                }
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
            clearTimeout(authTimeout);
            if (agentId) {
                this.unregisterAgent(agentId, 'connection_closed');
            }
        });

        ws.on('error', (err) => {
            this.log('[file-agent] ws error:', err.message);
            clearTimeout(authTimeout);
            if (agentId) {
                this.unregisterAgent(agentId, 'ws_error');
            }
        });
    }

    _handleHello(ws, hello, callback) {
        // Validate protocol version
        if (hello.protocolVersion !== 1 && hello.protocolVersion !== 2) {
            callback(new AgentError('unsupported', `Unsupported protocol version: ${hello.protocolVersion}`));
            return;
        }

        // Validate token
        const tokenRecord = this.validateTokenRecord(hello.token);
        if (!tokenRecord) {
            callback(new AgentError('unauthorized', 'Invalid token'));
            return;
        }
        const ownerId = tokenRecord.ownerId;

        // Generate agentId from deviceId (stable) or random
        const agentId = hello.deviceId
            ? `agent_${crypto.createHash('sha256').update(hello.deviceId + ownerId).digest('hex').slice(0, 12)}`
            : `agent_${crypto.randomBytes(6).toString('hex')}`;

        // If this device is already connected, disconnect the old one
        if (this.agents.has(agentId)) {
            const old = this.agents.get(agentId);
            old.cleanup();
            try { old.ws.close(1000, 'Replaced by new connection'); } catch {}
            this.agents.delete(agentId);
        }

        const conn = new FileAgentConnection(ws, agentId, hello);
        conn.ownerId = ownerId;
        conn.tokenId = tokenRecord.id;
        conn.tokenName = tokenRecord.name;

        // Register
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
            callback(new AgentError('io_error', err.message));
            return;
        }

        this.log(`[file-agent] registered: ${conn.deviceName} (${agentId}) for owner ${ownerId}`);
        this._broadcastEvent({
            type: 'file_agent_online',
            agent: conn.toPublicInfo(),
        }, ownerId);

        callback(null, agentId);
    }

    /** Unregister an Agent and broadcast offline event. */
    unregisterAgent(agentId, reason) {
        const conn = this.agents.get(agentId);
        if (!conn) return;

        const ownerId = conn.ownerId;
        conn.cleanup();
        try {
            if (conn.ws.readyState === WebSocket.OPEN) {
                conn.ws.close(1000, reason || 'Unregistered');
            }
        } catch {}

        this.agents.delete(agentId);
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

    _scheduleBinaryReadPrefetch(agentId, handle, offset, length) {
        if (!handle || !Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return;
        for (let i = 1; i <= BINARY_READ_PREFETCH_CHUNKS; i++) {
            const nextOffset = offset + length * i;
            const key = this._binaryReadKey(agentId, handle, nextOffset, length);
            if (this.binaryReadCache.has(key)) continue;
            const entry = { ts: Date.now(), size: 0 };
            entry.promise = this._callAgentBinaryReadQueued(agentId, { handle, offset: nextOffset, length })
                .then((buf) => {
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
        const agentIds = this.ownerAgents.get(ownerId);
        if (!agentIds) return result;
        for (const agentId of agentIds) {
            const conn = this.agents.get(agentId);
            if (conn && conn.online) {
                result.push(conn.toPublicInfo());
            }
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
        return conn ? conn.ownerId === ownerId : false;
    }

    /** Accept immutable userId ownership with username fallback for migrated tokens. */
    isAgentOwnedByUser(agentId, user) {
        const conn = this.agents.get(agentId);
        if (!conn || !user) return false;
        return conn.ownerId === user.userId || conn.ownerId === user.username;
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
        res._sseOwnerId = ownerId;
        this.sseClients.add(res);
        res.on('close', () => this.sseClients.delete(res));

        // Send current agent list as initial event
        const agents = this.listAgentsForUser(ownerId);
        this._sendSse(res, 'agent_list', { agents });
    }

    _sendSse(res, eventType, data) {
        try {
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {}
    }

    _broadcastEvent(event, ownerId) {
        for (const res of this.sseClients) {
            if (res._sseOwnerId === ownerId) {
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
            res.json({ ok: true, agents: this.listAgentsForUser(user.username) });
        });

        // GET /api/rdp/file-agent-tokens — list named agent tokens
        app.get('/api/rdp/file-agent-tokens', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.json({ ok: true, tokens: this.listTokens(user.username) });
        });

        // POST /api/rdp/file-agent-tokens — create named token
        app.post('/api/rdp/file-agent-tokens', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const record = this.createToken(user.username, req.body?.name || 'Zephyr Agent Token', req.body?.length || 50);
            res.json({ ok: true, token: this.publicTokenRecord(record, true) });
        });

        // PATCH /api/rdp/file-agent-tokens/:tokenId — rename token
        app.patch('/api/rdp/file-agent-tokens/:tokenId', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                const record = this.updateToken(user.username, req.params.tokenId, { name: req.body?.name });
                res.json({ ok: true, token: this.listTokens(user.username).find((t) => t.id === record.id) });
            } catch (err) {
                res.status(err.code === 'not_found' ? 404 : 500).json({ ok: false, error: { code: err.code || 'internal_error', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/:tokenId/regenerate — rotate one token (password/TOTP required)
        app.post('/api/rdp/file-agent-tokens/:tokenId/regenerate', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                const record = this.regenerateTokenRecord(user.username, req.params.tokenId, req.body?.length || 50);
                res.json({ ok: true, token: this.publicTokenRecord(record, true) });
            } catch (err) {
                const status = err.code === 'not_found' ? 404 : 400;
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
                const record = this.findTokenRecord(user.username, req.params.tokenId);
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
                for (const record of [...this.tokenRecords.values()]) {
                    if (record.ownerId === user.username) this.tokenRecords.delete(record.token);
                }
                const agentIds = this.ownerAgents.get(user.username);
                if (agentIds) for (const agentId of [...agentIds]) this.unregisterAgent(agentId, 'tokens_reset');
                const record = this.createToken(user.username, req.body?.name || '默认 Token', req.body?.length || 50);
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
                this.deleteToken(user.username, req.params.tokenId);
                res.json({ ok: true });
            } catch (err) {
                const status = err.code === 'not_found' ? 404 : (err.code === 'unsupported' ? 500 : 400);
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
                this.deleteToken(user.username, req.params.tokenId);
                res.json({ ok: true });
            } catch (err) {
                const status = err.code === 'not_found' ? 404 : 400;
                res.status(status).json({ ok: false, error: { code: err.code || 'auth_failed', message: err.message } });
            }
        });

        // GET /api/rdp/file-agent-token — legacy endpoint: ensure default token exists, but do not reveal it.
        app.get('/api/rdp/file-agent-token', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            this.getOrCreateToken(user.username);
            res.json({ ok: true, token: null, deprecated: true, message: 'Use Settings → Zephyr Client to reveal tokens after password/TOTP verification.' });
        });

        // POST /api/rdp/file-agent-token/regenerate — legacy reset endpoint, requires password/TOTP
        app.post('/api/rdp/file-agent-token/regenerate', requireUser, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                if (!verifySensitiveAccess) throw new AgentError('unsupported', 'Sensitive verification unavailable');
                verifySensitiveAccess(req, req.body?.secret);
                const token = this.regenerateToken(user.username);
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
            this.subscribeSse(res, user.username);
        });

        // POST /api/rdp/file-agents/:agentId/rpc/read-binary — binary fast path for reads
        app.post('/api/rdp/file-agents/:agentId/rpc/read-binary', requireUser, async (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).end();

            const { agentId } = req.params;
            if (!this.isAgentOwnedBy(agentId, user.username)) {
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
            if (!this.isAgentOwnedBy(agentId, user.username)) {
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
        for (const [agentId] of this.agents) {
            this.unregisterAgent(agentId, 'server_shutdown');
        }
        for (const res of this.sseClients) {
            try { res.end(); } catch {}
        }
        this.sseClients.clear();
    }
}

module.exports = { FileAgentManager, AgentError, FileAgentConnection };
