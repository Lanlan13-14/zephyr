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
        /** @type {Map<string, string>} token → ownerId */
        this.tokenBindings = new Map();
        /** @type {Function} resolve userId from session cookie (injected) */
        this.resolveSession = options.resolveSession || (() => null);
        /** @type {Function} logger */
        this.log = options.log || console.log;

        this._loadTokens();
    }

    // ─── Token Management ────────────────────────────────────────────

    _loadTokens() {
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
                if (data && typeof data === 'object') {
                    for (const [token, ownerId] of Object.entries(data)) {
                        this.tokenBindings.set(token, ownerId);
                    }
                }
            }
        } catch (err) {
            this.log('[file-agent] failed to load tokens:', err.message);
        }
    }

    _saveTokens() {
        try {
            const obj = {};
            for (const [token, ownerId] of this.tokenBindings) {
                obj[token] = ownerId;
            }
            fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            this.log('[file-agent] failed to save tokens:', err.message);
        }
    }

    /** Generate or retrieve a file-agent token for a user. */
    getOrCreateToken(ownerId) {
        // Check if user already has a token
        for (const [token, owner] of this.tokenBindings) {
            if (owner === ownerId) return token;
        }
        // Generate new token
        const token = crypto.randomBytes(24).toString('base64url');
        this.tokenBindings.set(token, ownerId);
        this._saveTokens();
        return token;
    }

    /** Regenerate token for a user (invalidates old one). */
    regenerateToken(ownerId) {
        // Remove old tokens for this user
        for (const [token, owner] of this.tokenBindings) {
            if (owner === ownerId) {
                this.tokenBindings.delete(token);
                // Disconnect any agents using this token
                const agentIds = this.ownerAgents.get(ownerId);
                if (agentIds) {
                    for (const agentId of agentIds) {
                        this.unregisterAgent(agentId, 'token_regenerated');
                    }
                }
            }
        }
        return this.getOrCreateToken(ownerId);
    }

    /** Validate a token and return the ownerId, or null if invalid. */
    validateToken(token) {
        return this.tokenBindings.get(token) || null;
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
        const ownerId = this.validateToken(hello.token);
        if (!ownerId) {
            callback(new AgentError('unauthorized', 'Invalid token'));
            return;
        }

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
    mountRoutes(app, requireAuth, getSessionUser) {
        // GET /api/rdp/file-agents — list online agents for current user
        app.get('/api/rdp/file-agents', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const agents = this.listAgentsForUser(user.username);
            res.json({ ok: true, agents });
        });

        // GET /api/rdp/file-agent-token — get or create agent token
        app.get('/api/rdp/file-agent-token', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const token = this.getOrCreateToken(user.username);
            res.json({ ok: true, token });
        });

        // POST /api/rdp/file-agent-token/regenerate — regenerate token
        app.post('/api/rdp/file-agent-token/regenerate', requireAuth, (req, res) => {
            const user = getSessionUser(req);
            if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
            const token = this.regenerateToken(user.username);
            res.json({ ok: true, token });
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
