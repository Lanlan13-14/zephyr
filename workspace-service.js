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
const {
    PORTABLE_CLIENT_ID,
    WorkspacePortableSyncService,
} = require('./workspace-portable-sync-service');

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
        /* Deterministic single-row reads. stmtGet stays for the existence checks
         * in put(), which only need "does any row with this id exist for this
         * user" and are followed by a client-scoped upsert. */
        this.stmtGetScoped = db.prepare('SELECT * FROM workspaces WHERE workspace_id = ? AND user_id = ? AND client_id = ?');
        this.stmtGetLatest = db.prepare('SELECT * FROM workspaces WHERE workspace_id = ? AND user_id = ? ORDER BY updated_at DESC, client_id ASC LIMIT 1');
        this.stmtList = db.prepare('SELECT workspace_id, user_id, client_id, name, revision, updated_at FROM workspaces WHERE user_id = ? ORDER BY updated_at DESC');
        this.stmtListClient = db.prepare('SELECT * FROM workspaces WHERE user_id = ? AND client_id = ? ORDER BY updated_at DESC');
        this.stmtUpsert = db.prepare(`INSERT INTO workspaces
            (workspace_id, user_id, client_id, name, state_json, revision, updated_at)
            VALUES (@workspaceId, @userId, @clientId, @name, @stateJson, @revision, @updatedAt)
            ON CONFLICT(user_id, client_id, workspace_id) DO UPDATE SET
              name = @name, state_json = @stateJson, revision = @revision, updated_at = @updatedAt`);
        this.stmtDeleteScoped = db.prepare('DELETE FROM workspaces WHERE workspace_id = ? AND user_id = ? AND client_id = ?');
        this.stmtCountUser = db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE user_id = ?');
        this.stmtPruneUser = db.prepare(`SELECT * FROM workspaces
            WHERE user_id = ? AND NOT (client_id = ? AND workspace_id = ?)
            ORDER BY updated_at ASC
            LIMIT ?`);
        this.stmtGcStale = db.prepare('SELECT * FROM workspaces WHERE updated_at < ? ORDER BY updated_at ASC');
        this.portableSyncService = deps?.portableSyncService === false
            ? null
            : (deps?.portableSyncService || new WorkspacePortableSyncService({
                db,
                now: this.now,
                mobileChangeBridge: deps?.mobileChangeBridge,
            }));
        if (this.portableSyncService) {
            this.portableSyncService.attachCanonical({
                put: (user, data, mutationContext) => this._put(user, data, true, mutationContext),
                delete: (userId, workspaceId, options, mutationContext) => (
                    this._delete(userId, workspaceId, options, mutationContext)
                ),
            });
            this.portableSyncService.adoptExistingRows();
        }
    }

    list(userId, { clientId = null } = {}) {
        const rows = clientId
            ? this.stmtListClient.all(String(userId), String(clientId))
            : this.stmtList.all(String(userId));
        return rows.map((row) => this._meta(row));
    }

    /**
     * One workspace, optionally scoped to a single client.
     *
     * The primary key is (user_id, client_id, workspace_id), so a workspace id on
     * its own can match one row per client. `stmtGet` filters only on
     * workspace_id + user_id, which made the unscoped read return whichever row
     * SQLite happened to visit first: verified against two rows sharing an id,
     * where the caller asking for the mobile workspace received the desktop one.
     *
     * Passing `clientId` selects exactly one row. Omitting it now resolves to the
     * most recently updated row rather than an arbitrary one, so the existing Web
     * route keeps working and becomes deterministic instead of changing shape.
     */
    get(userId, workspaceId, { clientId = null } = {}) {
        const row = clientId
            ? this.stmtGetScoped.get(String(workspaceId), String(userId), String(clientId))
            : this.stmtGetLatest.get(String(workspaceId), String(userId));
        if (!row) throw new HttpError(404, 'workspace_not_found', '工作区不存在');
        return this._full(row);
    }

    /**
     * Create or update. Optimistic concurrency via expectedRevision.
     * Returns the saved workspace.
     */
    put(user, data = {}, mutationContext = {}) {
        return this.db.transaction(() => this._put(user, data, false, mutationContext))();
    }

    _put(user, {
        workspaceId,
        clientId,
        name,
        state,
        expectedRevision = null,
        preferredPortableId = null,
    } = {}, portableInternal = false, mutationContext = {}) {
        if (!clientId || typeof clientId !== 'string' || clientId.length > 80) {
            throw new HttpError(400, 'invalid_client_id', 'clientId 无效');
        }
        if (clientId === PORTABLE_CLIENT_ID && !portableInternal) {
            throw new HttpError(400, 'invalid_client_id', 'clientId is reserved for portable workspace sync.');
        }
        const id = String(workspaceId || crypto.randomUUID());
        /* Scoped to this client, because the primary key is
         * (user_id, client_id, workspace_id) and the upsert below conflicts on
         * all three. Reading with the unscoped statement compared the caller's
         * expectedRevision against whichever row SQLite happened to return
         * first, so two devices holding the same workspaceId saw each other's
         * revisions: one device could be handed a spurious 409 while the other
         * silently jumped its revision counter. Both rows are legitimate and
         * independent; the guard has to be per row. */
        const existing = this.stmtGetScoped.get(id, user.userId, String(clientId));
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
        const savedRow = this.stmtGetScoped.get(id, user.userId, String(clientId));
        if (this.portableSyncService) {
            this.portableSyncService.captureUpsert(savedRow, {
                preferredPortableId,
                mutationContext,
            });
        }
        const count = Number(this.stmtCountUser.get(String(user.userId))?.count || 0);
        if (count > MAX_WORKSPACES_PER_USER) {
            const pruned = this.stmtPruneUser.all(
                String(user.userId),
                String(clientId),
                id,
                count - MAX_WORKSPACES_PER_USER,
            );
            for (const row of pruned) {
                if (this.portableSyncService) this.portableSyncService.captureDelete(row);
                this.stmtDeleteScoped.run(row.workspace_id, row.user_id, row.client_id);
            }
        }
        return this.get(user.userId, id, { clientId: String(clientId) });
    }

    delete(userId, workspaceId, options = {}, mutationContext = {}) {
        return this.db.transaction(() => this._delete(
            userId, workspaceId, options, mutationContext,
        ))();
    }

    _delete(userId, workspaceId, { clientId = null } = {}, mutationContext = {}) {
        const owner = String(userId);
        const id = String(workspaceId);
        const rows = clientId
            ? [this.stmtGetScoped.get(id, owner, String(clientId))].filter(Boolean)
            : this.stmtGet.all(id, owner);
        if (!rows.length) throw new HttpError(404, 'workspace_not_found', '工作区不存在');
        for (const row of rows) {
            if (this.portableSyncService) {
                this.portableSyncService.captureDelete(row, { mutationContext });
            }
            this.stmtDeleteScoped.run(row.workspace_id, row.user_id, row.client_id);
        }
        return true;
    }

    gcStale(maxAgeMs = DEFAULT_WORKSPACE_MAX_AGE_MS) {
        const age = Math.max(24 * 60 * 60 * 1000, Number(maxAgeMs) || DEFAULT_WORKSPACE_MAX_AGE_MS);
        return this.db.transaction(() => {
            const rows = this.stmtGcStale.all(this.now() - age);
            for (const row of rows) {
                if (this.portableSyncService) this.portableSyncService.captureDelete(row);
                this.stmtDeleteScoped.run(row.workspace_id, row.user_id, row.client_id);
            }
            return rows.length;
        })();
    }

    /**
     * Restore: load workspace and re-filter every resource id against current
     * ACL. Dangerous actions are never auto-replayed — only metadata +
     * accessibility flags are returned (§14.2).
     */
    restore(user, workspaceId, { clientId = null } = {}) {
        const ws = this.get(user.userId, workspaceId, { clientId });
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
