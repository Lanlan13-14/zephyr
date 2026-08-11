'use strict';

const crypto = require('crypto');
const { HttpError } = require('./authz');
const {
    WorkspacePortableProjectionError,
    projectPortableWorkspaceState,
    mergePortableWorkspaceState,
    samePortableWorkspace,
} = require('./workspace-portable-projection');

const ENTITY_TYPE = 'workspaceState';
const PORTABLE_CLIENT_ID = '__zephyr_portable_workspace_v1__';
const MAX_WIRE_ID_CHARS = 120;

function bridgeFor(db, bridge) {
    if (bridge === false) return null;
    if (bridge) return bridge;
    return require('./mobile-v1-change-bridge').getMobileV1ChangeBridge(db);
}

function parseJson(value, fallback) {
    try { return JSON.parse(value || ''); } catch { return fallback; }
}

function validOwner(userOrId) {
    const candidate = userOrId && typeof userOrId === 'object' ? userOrId.userId : userOrId;
    const userId = String(candidate || '').trim();
    if (!userId) {
        throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Workspace does not exist or is inaccessible.');
    }
    return userId;
}

function validWireId(value) {
    const raw = String(value || '');
    const id = raw.trim();
    if (raw !== id || !id || id.length > MAX_WIRE_ID_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
        throw new HttpError(400, 'invalid_request', 'Workspace sync id is invalid.');
    }
    return id;
}

function projectionError(error) {
    if (error instanceof WorkspacePortableProjectionError) {
        return new HttpError(400, 'invalid_request', error.message);
    }
    return error;
}

function canonicalWorkspaceId(portableId) {
    return 'portable-' + crypto.createHash('sha256').update(portableId).digest('hex');
}

class WorkspacePortableSyncService {
    constructor({ db, now = () => Date.now(), mobileChangeBridge } = {}) {
        if (!db) throw new TypeError('WorkspacePortableSyncService requires a SQLite db');
        this.db = db;
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.mobileChangeBridge = bridgeFor(db, mobileChangeBridge);
        this.canonical = null;
        this._ensureSchema();
        this._prepare();
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS workspace_portable_identities (
                owner_user_id TEXT NOT NULL,
                source_client_id TEXT NOT NULL,
                source_workspace_id TEXT NOT NULL,
                portable_id TEXT NOT NULL,
                sync_revision INTEGER NOT NULL DEFAULT 0,
                projection_json TEXT,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER,
                PRIMARY KEY (owner_user_id, source_client_id, source_workspace_id),
                UNIQUE (owner_user_id, portable_id)
            );
            CREATE INDEX IF NOT EXISTS idx_workspace_portable_owner_active
                ON workspace_portable_identities(owner_user_id, deleted_at, updated_at DESC);
        `);
    }

    _prepare() {
        this.stmtIdentityBySource = this.db.prepare(`SELECT * FROM workspace_portable_identities
            WHERE owner_user_id = ? AND source_client_id = ? AND source_workspace_id = ?`);
        this.stmtIdentityByPortable = this.db.prepare(`SELECT * FROM workspace_portable_identities
            WHERE owner_user_id = ? AND portable_id = ?`);
        this.stmtInsertIdentity = this.db.prepare(`INSERT INTO workspace_portable_identities
            (owner_user_id, source_client_id, source_workspace_id, portable_id,
             sync_revision, projection_json, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, 0, NULL, ?, NULL)`);
        this.stmtActivate = this.db.prepare(`UPDATE workspace_portable_identities
            SET sync_revision = ?, projection_json = ?, updated_at = ?, deleted_at = NULL
            WHERE owner_user_id = ? AND source_client_id = ? AND source_workspace_id = ?`);
        this.stmtDeleteIdentity = this.db.prepare(`UPDATE workspace_portable_identities
            SET sync_revision = ?, updated_at = ?, deleted_at = ?
            WHERE owner_user_id = ? AND source_client_id = ? AND source_workspace_id = ?`);
        this.stmtWorkspaceBySource = this.db.prepare(`SELECT * FROM workspaces
            WHERE user_id = ? AND client_id = ? AND workspace_id = ?`);
        this.stmtWorkspacesByOwner = this.db.prepare(`SELECT * FROM workspaces
            WHERE user_id = ? ORDER BY updated_at DESC, client_id ASC, workspace_id ASC`);
        try {
            this.stmtOwnedConnection = this.db.prepare(
                'SELECT id, ownerUserId, ephemeral FROM connections WHERE id = ?',
            );
        } catch {
            this.stmtOwnedConnection = null;
        }
    }

    attachCanonical(canonical) {
        const required = ['put', 'delete'];
        if (!canonical || required.some((name) => typeof canonical[name] !== 'function')) {
            throw new TypeError('Workspace portable sync requires canonical put and delete operations');
        }
        this.canonical = canonical;
        return this;
    }

    _requireCanonical() {
        if (!this.canonical) throw new Error('Workspace portable sync is not attached to WorkspaceService');
        return this.canonical;
    }

    _transaction(write) {
        return this.db.transaction(write)();
    }

    _ownedResource(resourceType, resourceId, ownerUserId) {
        if (resourceType !== 'connection' || !this.stmtOwnedConnection) return false;
        const row = this.stmtOwnedConnection.get(String(resourceId || ''));
        return !!row
            && String(row.ownerUserId || '') === String(ownerUserId || '')
            && !row.ephemeral;
    }

    _portableState(state, ownerUserId, strict) {
        try {
            return projectPortableWorkspaceState(state, {
                ownerUserId,
                strict,
                resolveOwnedResource: (type, id, owner) => this._ownedResource(type, id, owner),
            });
        } catch (error) {
            throw projectionError(error);
        }
    }

    _newPortableId(ownerUserId) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const candidate = 'wsp_' + crypto.randomBytes(18).toString('base64url');
            if (!this.stmtIdentityByPortable.get(ownerUserId, candidate)) return candidate;
        }
        throw new Error('Unable to allocate a stable workspace sync id');
    }

    _ensureIdentity(row, preferredPortableId = null) {
        const owner = String(row.user_id || '');
        const client = String(row.client_id || '');
        const workspace = String(row.workspace_id || '');
        if (!owner || !client || !workspace) {
            throw new Error('Canonical workspace identity is incomplete');
        }
        let identity = this.stmtIdentityBySource.get(owner, client, workspace);
        if (identity) {
            if (preferredPortableId && identity.portable_id !== preferredPortableId) {
                throw new HttpError(409, 'workspace_revision_conflict', 'Workspace sync identity already exists.');
            }
            return identity;
        }
        const portableId = preferredPortableId || this._newPortableId(owner);
        const collision = this.stmtIdentityByPortable.get(owner, portableId);
        if (collision) {
            throw new HttpError(409, 'workspace_revision_conflict', 'Workspace sync identity already exists.');
        }
        this.stmtInsertIdentity.run(owner, client, workspace, portableId, this.now());
        return this.stmtIdentityBySource.get(owner, client, workspace);
    }

    _projectionData(row, strict = false) {
        return {
            name: String(row.name || 'Workspace').slice(0, 80),
            state: this._portableState(parseJson(row.state_json, {}), row.user_id, strict),
        };
    }

    _public(identity, data = null) {
        const projection = data || parseJson(identity.projection_json, { name: 'Workspace', state: { version: 1, tabs: [] } });
        return {
            workspaceId: identity.portable_id,
            userId: identity.owner_user_id,
            name: String(projection.name || 'Workspace').slice(0, 80),
            state: projection.state || { version: 1, tabs: [] },
            revision: Math.max(1, Number(identity.sync_revision) || 1),
            updatedAt: Number(identity.updated_at) || 0,
            deletedAt: identity.deleted_at == null ? null : Number(identity.deleted_at),
        };
    }

    /** Backfills stable ids for legacy workspace rows without inventing feed history. */
    adoptExistingRows() {
        return this._transaction(() => {
            const rows = this.db.prepare(`SELECT * FROM workspaces
                ORDER BY user_id, client_id, workspace_id`).all();
            for (const row of rows) {
                if (!row.user_id || !row.client_id || !row.workspace_id) continue;
                const identity = this._ensureIdentity(row);
                if (identity.projection_json != null || identity.deleted_at != null) continue;
                const data = this._projectionData(row, false);
                this.stmtActivate.run(
                    1,
                    JSON.stringify(data),
                    Number(row.updated_at) || this.now(),
                    row.user_id,
                    row.client_id,
                    row.workspace_id,
                );
            }
            return rows.length;
        });
    }

    /** Called by WorkspaceService inside the same transaction as its upsert. */
    captureUpsert(row, { preferredPortableId = null, mutationContext = {} } = {}) {
        const identity = this._ensureIdentity(row, preferredPortableId);
        const data = this._projectionData(row, false);
        const before = identity.projection_json != null && identity.deleted_at == null
            ? this._public(identity)
            : null;
        const previousData = before ? { name: before.name, state: before.state } : null;
        if (before && samePortableWorkspace(previousData, data)) return before;

        const revision = Math.max(0, Number(identity.sync_revision) || 0) + 1;
        const updatedAt = this.now();
        this.stmtActivate.run(
            revision,
            JSON.stringify(data),
            updatedAt,
            row.user_id,
            row.client_id,
            row.workspace_id,
        );
        const active = this.stmtIdentityBySource.get(row.user_id, row.client_id, row.workspace_id);
        const after = this._public(active, data);
        if (this.mobileChangeBridge) {
            this.mobileChangeBridge.recordMutation({
                entityType: ENTITY_TYPE,
                entityId: active.portable_id,
                action: 'upsert',
                user: { userId: row.user_id },
                before,
                after,
                revision,
                actorDeviceId: mutationContext?.actorDeviceId,
                mutationReceipt: mutationContext?.mutationReceipt,
            });
        }
        return after;
    }

    /** Called before the canonical row disappears, including prune and GC. */
    captureDelete(row, { mutationContext = {} } = {}) {
        const identity = this._ensureIdentity(row);
        if (identity.deleted_at != null) return this._public(identity);
        let before;
        if (identity.projection_json == null) {
            const data = this._projectionData(row, false);
            this.stmtActivate.run(
                Math.max(1, Number(identity.sync_revision) || 0),
                JSON.stringify(data),
                Number(row.updated_at) || this.now(),
                row.user_id,
                row.client_id,
                row.workspace_id,
            );
            before = this._public(this.stmtIdentityBySource.get(
                row.user_id, row.client_id, row.workspace_id,
            ), data);
        } else {
            before = this._public(identity);
        }
        const revision = Math.max(1, Number(before.revision) || 1) + 1;
        const deletedAt = this.now();
        this.stmtDeleteIdentity.run(
            revision,
            deletedAt,
            deletedAt,
            row.user_id,
            row.client_id,
            row.workspace_id,
        );
        if (this.mobileChangeBridge) {
            this.mobileChangeBridge.recordMutation({
                entityType: ENTITY_TYPE,
                entityId: identity.portable_id,
                action: 'delete',
                user: { userId: row.user_id },
                before,
                revision,
                actorDeviceId: mutationContext?.actorDeviceId,
                mutationReceipt: mutationContext?.mutationReceipt,
            });
        }
        return this._public(this.stmtIdentityBySource.get(
            row.user_id, row.client_id, row.workspace_id,
        ));
    }

    list(userOrId) {
        const ownerUserId = validOwner(userOrId);
        const rows = this.stmtWorkspacesByOwner.all(ownerUserId);
        return this._transaction(() => rows.map((row) => {
            let identity = this._ensureIdentity(row);
            if (identity.projection_json == null || identity.deleted_at != null) {
                return this.captureUpsert(row);
            }
            return this._public(identity);
        }));
    }

    read(userOrId, portableId, { includeDeleted = false } = {}) {
        const ownerUserId = validOwner(userOrId);
        const id = validWireId(portableId);
        const identity = this.stmtIdentityByPortable.get(ownerUserId, id);
        if (!identity || (!includeDeleted && identity.deleted_at != null)) return null;
        if (identity.deleted_at == null) {
            const row = this.stmtWorkspaceBySource.get(
                ownerUserId, identity.source_client_id, identity.source_workspace_id,
            );
            if (!row) return null;
        }
        return this._public(identity);
    }

    residency(userOrId, portableId) {
        const ownerUserId = validOwner(userOrId);
        const id = validWireId(portableId);
        const identity = this.stmtIdentityByPortable.get(ownerUserId, id);
        if (!identity || identity.deleted_at != null) return 'missing';
        return this.stmtWorkspaceBySource.get(
            ownerUserId, identity.source_client_id, identity.source_workspace_id,
        ) ? 'owned' : 'missing';
    }

    create(user, portableId, patch = {}, mutationContext = {}) {
        const ownerUserId = validOwner(user);
        const id = validWireId(portableId);
        if (this.stmtIdentityByPortable.get(ownerUserId, id)) {
            throw new HttpError(409, 'workspace_revision_conflict', 'Workspace sync identity already exists.');
        }
        const state = this._portableState(patch.state || {}, ownerUserId, true);
        const name = String(patch.name || 'Workspace').slice(0, 80);
        const sourceWorkspaceId = canonicalWorkspaceId(id);
        return this._transaction(() => {
            const syntheticRow = {
                user_id: ownerUserId,
                client_id: PORTABLE_CLIENT_ID,
                workspace_id: sourceWorkspaceId,
            };
            this._ensureIdentity(syntheticRow, id);
            this._requireCanonical().put(user, {
                workspaceId: sourceWorkspaceId,
                clientId: PORTABLE_CLIENT_ID,
                name,
                state: mergePortableWorkspaceState({}, state),
                expectedRevision: null,
                preferredPortableId: id,
            }, mutationContext);
            return this.read(user, id);
        });
    }

    update(user, portableId, patch = {}, mutationContext = {}) {
        const ownerUserId = validOwner(user);
        const id = validWireId(portableId);
        const identity = this.stmtIdentityByPortable.get(ownerUserId, id);
        if (!identity || identity.deleted_at != null) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Workspace does not exist or is inaccessible.');
        }
        const canonicalRow = this.stmtWorkspaceBySource.get(
            ownerUserId, identity.source_client_id, identity.source_workspace_id,
        );
        if (!canonicalRow) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Workspace does not exist or is inaccessible.');
        }
        const current = this._public(identity);
        const state = Object.prototype.hasOwnProperty.call(patch, 'state')
            ? this._portableState(patch.state, ownerUserId, true)
            : current.state;
        const name = Object.prototype.hasOwnProperty.call(patch, 'name')
            ? String(patch.name || 'Workspace').slice(0, 80)
            : current.name;
        const canonicalState = mergePortableWorkspaceState(parseJson(canonicalRow.state_json, {}), state);
        return this._transaction(() => {
            this._requireCanonical().put(user, {
                workspaceId: identity.source_workspace_id,
                clientId: identity.source_client_id,
                name,
                state: canonicalState,
                expectedRevision: Number(canonicalRow.revision),
                preferredPortableId: id,
            }, mutationContext);
            return this.read(user, id);
        });
    }

    remove(user, portableId, mutationContext = {}) {
        const ownerUserId = validOwner(user);
        const id = validWireId(portableId);
        const identity = this.stmtIdentityByPortable.get(ownerUserId, id);
        if (!identity || identity.deleted_at != null) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Workspace does not exist or is inaccessible.');
        }
        return this._transaction(() => {
            this._requireCanonical().delete(
                ownerUserId,
                identity.source_workspace_id,
                { clientId: identity.source_client_id },
                mutationContext,
            );
            return true;
        });
    }

    restore(user, portableId, mutationContext = {}) {
        const ownerUserId = validOwner(user);
        const id = validWireId(portableId);
        const identity = this.stmtIdentityByPortable.get(ownerUserId, id);
        if (!identity || identity.deleted_at == null || identity.projection_json == null) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Workspace tombstone does not exist or is inaccessible.');
        }
        if (this.stmtWorkspaceBySource.get(
            ownerUserId, identity.source_client_id, identity.source_workspace_id,
        )) {
            throw new HttpError(409, 'workspace_revision_conflict', 'Workspace source identity is already active.');
        }
        const projection = parseJson(identity.projection_json, null);
        if (!projection) throw new HttpError(409, 'workspace_revision_conflict', 'Workspace tombstone cannot be restored.');
        return this._transaction(() => {
            this._requireCanonical().put(user, {
                workspaceId: identity.source_workspace_id,
                clientId: identity.source_client_id,
                name: projection.name,
                state: mergePortableWorkspaceState({}, projection.state),
                expectedRevision: null,
                preferredPortableId: id,
            }, mutationContext);
            return this.read(user, id);
        });
    }
}

module.exports = {
    ENTITY_TYPE,
    PORTABLE_CLIENT_ID,
    WorkspacePortableSyncService,
    canonicalWorkspaceId,
    validWireId,
};
