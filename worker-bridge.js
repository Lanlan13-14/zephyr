'use strict';
/*
 * worker-bridge.js - Node <-> zephyr-worker (Go) bridge (FREEZE plan §14).
 *
 * Node is the control plane: it authenticates the user, resolves the saved
 * connection through ACL, decrypts secrets, and issues a one-time ticket.
 * The browser then opens a WebSocket directly to the Go worker (ticket in
 * URL), so the terminal byte stream never transits Node.
 *
 * Lifecycle:
 *   1. Browser POST /api/worker/ticket { connectionId | transientToken }
 *   2. Node verifies ACL / consumes deep-link token, resolves secrets,
 *      issues a worker ticket via the worker's admin API, returns ticket id
 *   3. Browser opens wss://host/worker/ssh?ticket=<id>  (Go worker)
 *   4. Worker consumes ticket, dials SSH, holds the session persistently
 *   5. Browser disconnect -> session stays alive; reconnect resumes
 */
const crypto = require('crypto');
const { HttpError } = require('./authz');

const WORKER_URL = process.env.ZEPHYR_WORKER_URL || ''; // e.g. http://127.0.0.1:8443
const WORKER_ADMIN_TOKEN = process.env.ZEPHYR_WORKER_ADMIN_TOKEN || '';
const TICKET_TTL_SECONDS = 30;

class WorkerBridge {
    /**
     * @param {object} deps
     * @param {object} deps.storage
     * @param {import('./resource-service').ResourceService} deps.resources
     * @param {import('./deeplink-service').DeepLinkService} deps.deepLink
     * @param {import('./authz').Authz} deps.authz
     */
    constructor(deps) {
        this.storage = deps.storage;
        this.resources = deps.resources;
        this.deepLink = deps.deepLink;
        this.authz = deps.authz;
        this.enabled = !!WORKER_URL;
    }

    _adminHeaders() {
        return {
            'content-type': 'application/json',
            'x-worker-admin': WORKER_ADMIN_TOKEN,
        };
    }

    async _post(path, body) {
        if (!this.enabled) throw new HttpError(503, 'worker_unavailable', '持久任务后端未启用', true);
        const res = await fetch(`${WORKER_URL}${path}`, {
            method: 'POST',
            headers: this._adminHeaders(),
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new HttpError(res.status, data.code || 'worker_error', data.message || 'worker 请求失败', res.status >= 500);
        return data;
    }

    /**
     * Issue a worker ticket for a saved connection.
     * Returns { ticket, workerWsUrl }.
     */
    async issueForConnection(user, connectionId) {
        const conn = this.storage.getConnectionById(connectionId);
        if (!conn) throw new HttpError(404, 'resource_not_found_or_inaccessible', '连接不存在或无权访问');
        this.authz.assertCan(user, 'use', 'connection', connectionId, conn, { resourceExists: true });
        const resolved = this.resources.resolveForConnect(user, connectionId);
        const protocol = String(resolved.protocol || 'SSH').toUpperCase();
        return this._issueTicket(user, {
            connId: connectionId,
            host: resolved.host,
            port: Number(resolved.port) || (protocol === 'TELNET' ? 23 : 22),
            username: resolved.username || '',
            password: resolved.password && resolved.password !== '******' ? resolved.password : '',
            privateKey: resolved.privateKey && resolved.privateKey !== '******' ? resolved.privateKey : '',
            protocol,
            source: 'saved',
        });
    }

    /**
     * Issue a worker ticket for a Deep Link transient connection.
     * Consumes the deep-link token atomically.
     */
    async issueForTransient(user, transientToken, overrides = {}) {
        const consumed = this.deepLink.consume(user, transientToken, overrides);
        const protocol = String(consumed.draft.protocol || 'SSH').toUpperCase();
        return this._issueTicket(user, {
            connId: '',
            host: consumed.draft.host,
            port: Number(consumed.draft.port) || (protocol === 'TELNET' ? 23 : 22),
            username: consumed.draft.username || '',
            password: consumed.credential?.password || '',
            privateKey: '',
            protocol,
            source: 'transient',
        });
    }

    async _issueTicket(user, { connId, host, port, username, password, privateKey, protocol = 'SSH', source }) {
        const proto = String(protocol || 'SSH').toUpperCase();
        if (!host) throw new HttpError(400, 'invalid_connect_target', '主机不能为空');
        // Telnet authenticates in-band; username is optional display-only.
        if (proto !== 'TELNET' && !username) {
            throw new HttpError(400, 'invalid_connect_target', '主机和用户名不能为空');
        }
        const resp = await this._post('/admin/tickets', {
            userId: user.userId,
            connId,
            host,
            port,
            username,
            password,
            privateKey,
            protocol: proto,
            source,
            ttlSeconds: TICKET_TTL_SECONDS,
        });
        return {
            ticket: resp.ticket,
            workerWsUrl: this._workerWsUrl(resp.ticket),
        };
    }

    _workerWsUrl(ticket) {
        if (!this.enabled || !ticket) return '';
        const u = new URL(WORKER_URL);
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        u.pathname = '/ssh';
        u.search = `?ticket=${encodeURIComponent(ticket)}`;
        return u.toString();
    }

    /** List live sessions for the admin/audit view. */
    async listSessions() {
        if (!this.enabled) return { sessions: [] };
        try {
            const res = await fetch(`${WORKER_URL}/admin/sessions`, { headers: this._adminHeaders() });
            if (!res.ok) return { sessions: [] };
            return await res.json();
        } catch {
            return { sessions: [] };
        }
    }

    async killSession(sessionId) {
        return this._post('/admin/sessions/kill', { sessionId });
    }
}

module.exports = { WorkerBridge, TICKET_TTL_SECONDS };
