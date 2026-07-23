'use strict';
/*
 * workspace-service.js — per-user, per-browser workspace persistence
 * (FREEZE plan §14, §18.2).
 *
 * Key: (userId, clientId, workspaceId)
 * - clientId is a browser-local id for slot selection only; never used as auth
 * - stateJson holds non-secret UI state (tabs, layout, panel flags, task refs)
 * - restore re-filters every resource id against current ACL
 */
const crypto = require('crypto');
const { HttpError } = require('./authz');

const MAX_STATE_BYTES = 256 * 1024;
const MAX_WORKSPACES_PER_USER = 20;
const DEFAULT_WORKSPACE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const FORBIDDEN_STATE_KEYS = new Set([
    'password', 'privateKey', 'passphrase', 'apiKey', 'token', 'totpSecret',
    'jmsToken', 'secret', 'credential', 'credentials',
]);

function scrubState(value, depth = 0) {
    if (depth > 12 || value == null) return value;
    if (Array.isArray(value)) return value.map((item) => scrubState(item, depth + 1));
    if (typeof value !== 'object') return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        const lower = String(key).toLowerCase();
        if (FORBIDDEN_STATE_KEYS.has(key) || FORBIDDEN_STATE_KEYS.has(lower)
            || lower.includes('password') || lower.includes('secret')
            || lower.includes('apikey') || lower.includes('privatekey')) {
            continue;
        }
        out[key] = scrubState(v, depth + 1);
    }
    return out;
}

class WorkspaceService {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {object} deps
     * @param {import('./resource-service').ResourceService} deps.resources
     * @param {() => number} [deps.now]
     */
    constructor(db, deps) {
        this.db = db;
        this.resources = deps?.resources || null;
        this.now = typeof deps?.now === 'function' ? deps.now : () => Date.now();
        this.stmtGet = db.prepare('SELECT * FROM workspaces WHERE workspace_id = ? AND user_id = ?');
        this.stmtList = db.prepare('SELECT workspace_id, user_id, client_id, name, revision, updated_at FROM workspaces WHERE user_id = ? ORDER BY updated_at DESC');
        this.stmtListClient = db.prepare('SELECT * FROM workspaces WHERE user_id = ? AND client_id = ? ORDER BY updated_at DESC');
        this.stmtUpsert = db.prepare(`INSERT INTO workspaces
            (workspace_id, user_id, client_id, name, state_json, revision, updated_at)
            VALUES (@workspaceId, @userId, @clientId, @name, @stateJson, @revision, @updatedAt)
            ON CONFLICT(user_id, client_id, workspace_id) DO UPDATE SET
              name = @name, state_json = @stateJson, revision = @revision, updated_at = @updatedAt`);
        this.stmtDelete = db.prepare('DELETE FROM workspaces WHERE workspace_id = ? AND user_id = ?');
        this.stmtCountUser = db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE user_id = ?');
        this.stmtPruneUser = db.prepare(`DELETE FROM workspaces WHERE rowid IN (
            SELECT rowid FROM workspaces
            WHERE user_id = ? AND workspace_id != ?
            ORDER BY updated_at ASC
            LIMIT ?
        )`);
        this.stmtGcStale = db.prepare('DELETE FROM workspaces WHERE updated_at < ?');
    }

    list(userId, { clientId = null } = {}) {
        const rows = clientId
            ? this.stmtListClient.all(String(userId), String(clientId))
            : this.stmtList.all(String(userId));
        return rows.map((row) => this._meta(row));
    }

    get(userId, workspaceId) {
        const row = this.stmtGet.get(String(workspaceId), String(userId));
        if (!row) throw new HttpError(404, 'workspace_not_found', '工作区不存在');
        return this._full(row);
    }

    /**
     * Create or update. Optimistic concurrency via expectedRevision.
     * Returns the saved workspace.
     */
    put(user, { workspaceId, clientId, name, state, expectedRevision = null } = {}) {
        if (!clientId || typeof clientId !== 'string' || clientId.length > 80) {
            throw new HttpError(400, 'invalid_client_id', 'clientId 无效');
        }
        const id = String(workspaceId || crypto.randomUUID());
        const existing = this.stmtGet.get(id, user.userId);
        if (existing && expectedRevision != null && Number(existing.revision) !== Number(expectedRevision)) {
            throw new HttpError(409, 'workspace_revision_conflict', '工作区已被其他设备更新', false);
        }
        const cleaned = scrubState(state || {});
        const json = JSON.stringify(cleaned);
        if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
            throw new HttpError(400, 'workspace_too_large', `工作区状态超过 ${MAX_STATE_BYTES} 字节`);
        }
        const revision = existing ? Number(existing.revision) + 1 : 1;
        const record = {
            workspaceId: id,
            userId: user.userId,
            clientId: String(clientId),
            name: String(name || existing?.name || '默认工作区').slice(0, 80),
            stateJson: json,
            revision,
            updatedAt: this.now(),
        };
        this.stmtUpsert.run(record);
        const count = Number(this.stmtCountUser.get(String(user.userId))?.count || 0);
        if (count > MAX_WORKSPACES_PER_USER) {
            this.stmtPruneUser.run(String(user.userId), id, count - MAX_WORKSPACES_PER_USER);
        }
        return this.get(user.userId, id);
    }

    delete(userId, workspaceId) {
        const changed = this.stmtDelete.run(String(workspaceId), String(userId)).changes;
        if (!changed) throw new HttpError(404, 'workspace_not_found', '工作区不存在');
        return true;
    }

    gcStale(maxAgeMs = DEFAULT_WORKSPACE_MAX_AGE_MS) {
        const age = Math.max(24 * 60 * 60 * 1000, Number(maxAgeMs) || DEFAULT_WORKSPACE_MAX_AGE_MS);
        return this.stmtGcStale.run(this.now() - age).changes;
    }

    /**
     * Restore: load workspace and re-filter every resource id against current
     * ACL. Dangerous actions are never auto-replayed — only metadata +
     * accessibility flags are returned (§14.2).
     */
    restore(user, workspaceId) {
        const ws = this.get(user.userId, workspaceId);
        const state = ws.state || {};
        const tabs = Array.isArray(state.tabs) ? state.tabs : [];
        const filteredTabs = tabs.map((tab) => {
            const connectionId = tab?.connectionId || tab?.resourceId || '';
            if (!connectionId) {
                return { ...tab, accessible: true, reason: null };
            }
            try {
                const raw = this.resources?.storage?.getConnectionById?.(connectionId)
                    || this.resources?._rawResource?.('connection', connectionId);
                if (!raw) return { ...tab, accessible: false, reason: 'resource_removed' };
                const caps = this.resources?.authz?.effectiveCapabilities?.(user, 'connection', connectionId, raw);
                if (!caps || (!caps.has('use') && !caps.has('observe') && !caps.has('view'))) {
                    return { ...tab, accessible: false, reason: 'resource_revoked' };
                }
                return {
                    ...tab,
                    accessible: true,
                    reason: null,
                    capabilities: [...caps],
                    connectionName: raw.name || tab.connectionName || '',
                };
            } catch {
                return { ...tab, accessible: false, reason: 'resource_revoked' };
            }
        });
        return {
            workspace: {
                ...ws,
                state: { ...state, tabs: filteredTabs },
            },
            inaccessible: filteredTabs.filter((t) => t.accessible === false).length,
            // Explicit: restore never auto-runs commands or re-sends input.
            autoReplay: false,
        };
    }

    _meta(row) {
        return {
            workspaceId: row.workspace_id,
            userId: row.user_id,
            clientId: row.client_id,
            name: row.name,
            revision: Number(row.revision),
            updatedAt: Number(row.updated_at),
        };
    }

    _full(row) {
        let state = {};
        try { state = JSON.parse(row.state_json || '{}'); } catch { state = {}; }
        return { ...this._meta(row), state };
    }
}

module.exports = { WorkspaceService, scrubState, MAX_STATE_BYTES, MAX_WORKSPACES_PER_USER, DEFAULT_WORKSPACE_MAX_AGE_MS };
