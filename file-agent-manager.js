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

const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_FACTOR = 3;
const RPC_DEFAULT_TIMEOUT_MS = 30000;
const RPC_READ_TIMEOUT_MS = 60000;
const TOKEN_FILE = path.join(__dirname, 'data', 'agent-tokens.json');

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
            online: this.online,
            readOnly: this.share.readOnly !== false,
            shareName: this.share.name || this.deviceName,
            capabilities: { ...this.capabilities },
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

    /** Handle an incoming binary response from the Agent. */
    handleBinaryResponse(raw) {
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
        /** @type {Function} resolve userId from session cookie (injected) */
        this.resolveSession = options.resolveSession || (() => null);
        /** @type {Function} logger */
        this.log = options.log || console.log;

        this._loadTokens();
    }

    // ─── Token Management ────────────────────────────────────────────

    _loadTokens() {
        try {
            if (!fs.existsSync(TOKEN_FILE)) return;
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
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
            fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
            fs.writeFileSync(TOKEN_FILE, JSON.stringify({ version: 2, tokens }, null, 2));
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
        if (hello.protocolVersion !== 1) {
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
     * @param {Function} requireAuth - middleware that ensures req.session exists
     * @param {Function} getSessionUser - (req) => { username, ... }
     */
    mountRoutes(app, requireAuth, getSessionUser, verifySensitiveAccess = null) {
        // GET /api/rdp/file-agents — list online agents for current user
        app.get('/api/rdp/file-agents', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const agents = this.listAgentsForUser(user.username);
            res.json({ ok: true, agents });
        });

        // GET /api/rdp/file-agent-tokens — list named agent tokens
        app.get('/api/rdp/file-agent-tokens', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            res.json({ ok: true, tokens: this.listTokens(user.username) });
        });

        // POST /api/rdp/file-agent-tokens — create named token
        app.post('/api/rdp/file-agent-tokens', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const record = this.createToken(user.username, req.body?.name || 'Zephyr Agent Token', req.body?.length || 50);
            res.json({ ok: true, token: this.publicTokenRecord(record, true) });
        });

        // PATCH /api/rdp/file-agent-tokens/:tokenId — rename token
        app.patch('/api/rdp/file-agent-tokens/:tokenId', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                const record = this.updateToken(user.username, req.params.tokenId, { name: req.body?.name });
                res.json({ ok: true, token: this.listTokens(user.username).find((t) => t.id === record.id) });
            } catch (err) {
                res.status(err.code === 'not_found' ? 404 : 500).json({ ok: false, error: { code: err.code || 'internal_error', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/:tokenId/regenerate — rotate one token
        app.post('/api/rdp/file-agent-tokens/:tokenId/regenerate', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                const record = this.regenerateTokenRecord(user.username, req.params.tokenId, req.body?.length || 50);
                res.json({ ok: true, token: this.publicTokenRecord(record, true) });
            } catch (err) {
                res.status(err.code === 'not_found' ? 404 : 500).json({ ok: false, error: { code: err.code || 'internal_error', message: err.message } });
            }
        });

        // POST /api/rdp/file-agent-tokens/:tokenId/open — reveal token after password/TOTP check
        app.post('/api/rdp/file-agent-tokens/:tokenId/open', requireAuth, (req, res) => {
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
        app.post('/api/rdp/file-agent-tokens/reset-all', requireAuth, (req, res) => {
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

        // DELETE /api/rdp/file-agent-tokens/:tokenId — delete one token
        app.delete('/api/rdp/file-agent-tokens/:tokenId', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            try {
                this.deleteToken(user.username, req.params.tokenId);
                res.json({ ok: true });
            } catch (err) {
                res.status(err.code === 'not_found' ? 404 : 500).json({ ok: false, error: { code: err.code || 'internal_error', message: err.message } });
            }
        });

        // GET /api/rdp/file-agent-token — legacy endpoint: ensure default token exists, but do not reveal it.
        app.get('/api/rdp/file-agent-token', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            this.getOrCreateToken(user.username);
            res.json({ ok: true, token: null, deprecated: true, message: 'Use Settings → Zephyr Agent to reveal tokens after password/TOTP verification.' });
        });

        // POST /api/rdp/file-agent-token/regenerate — legacy reset endpoint, requires password/TOTP
        app.post('/api/rdp/file-agent-token/regenerate', requireAuth, (req, res) => {
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
        app.get('/api/rdp/file-agents/events', requireAuth, (req, res) => {
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
        app.post('/api/rdp/file-agents/:agentId/rpc/read-binary', requireAuth, async (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).end();

            const { agentId } = req.params;
            if (!this.isAgentOwnedBy(agentId, user.username)) {
                return res.status(403).end();
            }

            const handle = String(req.query.handle || '');
            const offset = Number(req.query.offset || 0);
            const length = Math.max(0, Math.min(8 * 1024 * 1024, Number(req.query.length || 0)));
            if (!handle || !Number.isFinite(offset) || !Number.isFinite(length)) {
                return res.status(400).end();
            }

            try {
                const buf = await this.callAgentBinaryRead(agentId, { handle, offset, length });
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
        app.post('/api/rdp/file-agents/:agentId/rpc', requireAuth, async (req, res) => {
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

module.exports = { FileAgentManager, AgentError };
