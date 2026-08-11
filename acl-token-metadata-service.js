'use strict';

const crypto = require('crypto');
const { normalizeCapabilities } = require('./authz');

const ACL_INSTALL = Symbol.for('zephyr.mobile.resourceAclMetadataService');
const TOKEN_INSTALL = Symbol.for('zephyr.mobile.clientTokenMetadataService');
const TOKEN_SYNC_CONTRACT_VERSION = 1;
const CLIENT_TOKEN_SYNC_BLOCKER = Object.freeze({
    code: 'client_token_canonical_store_not_ready',
    requirement: 'encrypted-sqlite canonical metadata seam with atomic revision/tombstone writes',
});

class MetadataSyncError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function positiveRevision(value) {
    return Math.max(1, Number(value) || 1);
}

function nullableTime(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function stableGrantKey(resourceType, resourceId, subjectType, subjectId) {
    const identity = JSON.stringify([
        String(resourceType || ''),
        String(resourceId || ''),
        String(subjectType || 'user'),
        String(subjectId || ''),
    ]);
    return `acl_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

function sameCapabilities(left, right) {
    const normalize = (value) => normalizeCapabilities(value).sort();
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function safeJsonArray(value) {
    try {
        const parsed = JSON.parse(String(value || '[]'));
        return normalizeCapabilities(parsed);
    } catch {
        return [];
    }
}

/**
 * Adds sync identity/revision metadata to the canonical ACL table. It wraps
 * Authz itself, not an individual HTTP route, so Web, admin, AI and mobile ACL
 * changes all enter the same owner feed transaction.
 */
class ResourceAclMetadataService {
    constructor({ db, authz, resources, changeBridge, now = () => Date.now(), autoInstall = true } = {}) {
        if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
            throw new TypeError('ResourceAclMetadataService requires a SQLite database');
        }
        if (!authz || typeof authz.grant !== 'function' || typeof authz.revoke !== 'function') {
            throw new TypeError('ResourceAclMetadataService requires Authz');
        }
        if (!resources || typeof resources._rawResource !== 'function') {
            throw new TypeError('ResourceAclMetadataService requires the canonical resource lookup');
        }
        if (!changeBridge || typeof changeBridge.recordMutation !== 'function') {
            throw new TypeError('ResourceAclMetadataService requires the mobile change bridge');
        }
        if (changeBridge.db && changeBridge.db !== db) {
            throw new MetadataSyncError('acl_sync_database_mismatch', 'ACL and mobile feed must share one SQLite database', 503);
        }

        this.db = db;
        this.authz = authz;
        this.resources = resources;
        this.changeBridge = changeBridge;
        this.now = now;
        this.originals = null;
        this.wrappers = null;
        this._ensureSchema();
        this._prepare();
        this._backfillProvableOwners();
        if (autoInstall) this.install();
    }

    _ensureSchema() {
        const columns = this.db.prepare('PRAGMA table_info(resource_acl)').all();
        if (!columns.length) {
            throw new MetadataSyncError('acl_sync_unavailable', 'Canonical resource_acl table is unavailable', 503);
        }
        const names = new Set(columns.map((column) => column.name));
        if (!names.has('grant_key')) this.db.exec('ALTER TABLE resource_acl ADD COLUMN grant_key TEXT');
        if (!names.has('resource_owner_user_id')) this.db.exec('ALTER TABLE resource_acl ADD COLUMN resource_owner_user_id TEXT');
        if (!names.has('revision')) this.db.exec('ALTER TABLE resource_acl ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
        if (!names.has('updated_at')) this.db.exec('ALTER TABLE resource_acl ADD COLUMN updated_at INTEGER');
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_acl_grant_key ON resource_acl(grant_key) WHERE grant_key IS NOT NULL');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_resource_acl_owner_live ON resource_acl(resource_owner_user_id, revoked_at, grant_key)');
    }

    _prepare() {
        this.stmtGetIdentity = this.db.prepare(`SELECT * FROM resource_acl
            WHERE resource_type = ? AND resource_id = ? AND subject_type = ? AND subject_id = ?`);
        this.stmtGetKey = this.db.prepare('SELECT * FROM resource_acl WHERE grant_key = ?');
        this.stmtListOwner = this.db.prepare(`SELECT * FROM resource_acl
            WHERE resource_owner_user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, grant_key ASC`);
        this.stmtListOwnerAll = this.db.prepare(`SELECT * FROM resource_acl
            WHERE resource_owner_user_id = ? ORDER BY created_at ASC, grant_key ASC`);
        this.stmtListUserState = this.db.prepare(`SELECT * FROM resource_acl
            WHERE revoked_at IS NULL AND (
                (subject_type = 'user' AND subject_id = ?)
                OR resource_owner_user_id = ?
            )
            ORDER BY created_at ASC, grant_key ASC`);
        this.stmtAll = this.db.prepare('SELECT * FROM resource_acl');
        this.stmtSetMetadata = this.db.prepare(`UPDATE resource_acl SET
            grant_key = ?, resource_owner_user_id = ?, revision = ?, updated_at = ?
            WHERE resource_type = ? AND resource_id = ? AND subject_type = ? AND subject_id = ?`);
    }

    _backfillProvableOwners() {
        const migrate = this.db.transaction(() => {
            for (const row of this.stmtAll.all()) {
                const ownerUserId = this._ownerFor(row.resource_type, row.resource_id, row);
                if (!ownerUserId) continue;
                this._setMetadata(row, ownerUserId, positiveRevision(row.revision), Number(row.updated_at || row.created_at || this.now()));
            }
        });
        migrate();
    }

    _ownerFor(resourceType, resourceId, row = null) {
        const stored = String(row?.resource_owner_user_id || '');
        if (stored) return stored;
        return this._liveOwner(resourceType, resourceId);
    }

    _liveOwner(resourceType, resourceId) {
        const resource = this.resources._rawResource(String(resourceType || ''), String(resourceId || ''));
        return String(resource?.ownerUserId || '');
    }

    _setMetadata(row, ownerUserId, revision, updatedAt = this.now()) {
        const grantKey = stableGrantKey(row.resource_type, row.resource_id, row.subject_type, row.subject_id);
        this.stmtSetMetadata.run(
            grantKey,
            String(ownerUserId),
            positiveRevision(revision),
            Number(updatedAt),
            row.resource_type,
            row.resource_id,
            row.subject_type,
            row.subject_id,
        );
        return this.stmtGetKey.get(grantKey);
    }

    _project(row) {
        if (!row?.grant_key || !row.resource_owner_user_id) return null;
        return {
            grantKey: row.grant_key,
            resourceOwnerUserId: row.resource_owner_user_id,
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            capabilities: safeJsonArray(row.capabilities_json),
            expiresAt: nullableTime(row.expires_at),
            grantedByUserId: row.granted_by_user_id,
            createdAt: Number(row.created_at || 0),
            revokedAt: nullableTime(row.revoked_at),
            revision: positiveRevision(row.revision),
        };
    }

    _assertOwner(user, row) {
        const projected = this._project(row);
        const resource = row ? this.resources._rawResource(row.resource_type, row.resource_id) : null;
        const liveOwner = String(resource?.ownerUserId || '');
        const ownerIsCurrent = liveOwner
            ? liveOwner === projected?.resourceOwnerUserId
            : !!row?.revoked_at;
        if (!projected || !user?.userId || !ownerIsCurrent || projected.resourceOwnerUserId !== String(user.userId)) {
            throw new MetadataSyncError('acl_not_found', 'ACL grant does not exist or is inaccessible', 404);
        }
        return projected;
    }

    install() {
        if (this.authz[ACL_INSTALL] === this
            && this.wrappers
            && this.authz.grant === this.wrappers.grant
            && this.authz.revoke === this.wrappers.revoke
            && this.authz.revokeAllForResource === this.wrappers.revokeAllForResource) return this;
        if (this.authz[ACL_INSTALL]) {
            if (this.authz[ACL_INSTALL] !== this) {
                throw new MetadataSyncError('acl_sync_already_installed', 'Authz already has an ACL metadata service', 503);
            }
        }
        this.originals = {
            grant: this.authz.grant.bind(this.authz),
            revoke: this.authz.revoke.bind(this.authz),
            revokeAllForResource: this.authz.revokeAllForResource.bind(this.authz),
        };
        this.wrappers = {
            grant: (input) => this._grant(input),
            revoke: (input) => this._revoke(input),
            revokeAllForResource: (resourceType, resourceId, revokedByUserId) => (
                this._revokeAll(resourceType, resourceId, revokedByUserId)
            ),
        };
        Object.assign(this.authz, this.wrappers);
        if (this.authz[ACL_INSTALL] !== this) {
            Object.defineProperty(this.authz, ACL_INSTALL, { value: this, configurable: true });
        }
        return this;
    }

    uninstall() {
        if (this.authz[ACL_INSTALL] !== this || !this.originals) return;
        if (this.wrappers
            && this.authz.grant === this.wrappers.grant
            && this.authz.revoke === this.wrappers.revoke
            && this.authz.revokeAllForResource === this.wrappers.revokeAllForResource) {
            Object.assign(this.authz, this.originals);
        }
        delete this.authz[ACL_INSTALL];
        this.originals = null;
        this.wrappers = null;
    }

    _grant(input = {}) {
        const resourceType = String(input.resourceType || '');
        const resourceId = String(input.resourceId || '');
        const subjectType = String(input.subjectType || 'user');
        const subjectId = String(input.subjectId || '');
        const beforeRow = this.stmtGetIdentity.get(resourceType, resourceId, subjectType, subjectId) || null;
        const ownerUserId = this._liveOwner(resourceType, resourceId);
        if (!ownerUserId) {
            throw new MetadataSyncError('acl_owner_unprovable', 'ACL owner cannot be proven from canonical storage', 409);
        }
        if (beforeRow?.resource_owner_user_id && beforeRow.resource_owner_user_id !== ownerUserId) {
            throw new MetadataSyncError(
                'acl_owner_changed_requires_revoke',
                'Transferred resources must revoke prior ACLs before new grants are written',
                409,
            );
        }

        return this.db.transaction(() => {
            const result = this.originals.grant(input);
            const written = this.stmtGetIdentity.get(resourceType, resourceId, subjectType, subjectId);
            const before = this._project(beforeRow);
            const changed = !beforeRow || beforeRow.revoked_at
                || !sameCapabilities(safeJsonArray(beforeRow.capabilities_json), result)
                || nullableTime(beforeRow.expires_at) !== nullableTime(input.expiresAt);
            const revision = changed
                ? Math.max(0, Number(beforeRow?.revision || 0)) + 1
                : positiveRevision(beforeRow?.revision);
            const afterRow = this._setMetadata(written, ownerUserId, revision);
            if (changed) {
                this.changeBridge.recordMutation({
                    entityType: 'resourceAcl',
                    entityId: afterRow.grant_key,
                    action: 'upsert',
                    user: { userId: ownerUserId },
                    before: beforeRow?.revoked_at ? null : before,
                    after: this._project(afterRow),
                    revision,
                    actorDeviceId: input.mutationContext?.actorDeviceId,
                    mutationReceipt: input.mutationContext?.mutationReceipt,
                });
            }
            return result;
        })();
    }

    _revoke(input = {}) {
        const resourceType = String(input.resourceType || '');
        const resourceId = String(input.resourceId || '');
        const subjectType = String(input.subjectType || 'user');
        const subjectId = String(input.subjectId || '');
        return this.db.transaction(() => {
            const beforeRow = this.stmtGetIdentity.get(resourceType, resourceId, subjectType, subjectId) || null;
            const ownerUserId = this._ownerFor(resourceType, resourceId, beforeRow);
            const changed = this.originals.revoke(input);
            if (!changed || !beforeRow || !ownerUserId) return changed;
            const revision = positiveRevision(beforeRow.revision) + 1;
            const written = this.stmtGetIdentity.get(resourceType, resourceId, subjectType, subjectId);
            const afterRow = this._setMetadata(written, ownerUserId, revision);
            this.changeBridge.recordMutation({
                entityType: 'resourceAcl',
                entityId: afterRow.grant_key,
                action: 'delete',
                user: { userId: ownerUserId },
                before: this._project(beforeRow),
                after: null,
                revision,
                actorDeviceId: input.mutationContext?.actorDeviceId,
                mutationReceipt: input.mutationContext?.mutationReceipt,
            });
            return changed;
        })();
    }

    _revokeAll(resourceType, resourceId, revokedByUserId = '') {
        const type = String(resourceType || '');
        const id = String(resourceId || '');
        return this.db.transaction(() => {
            const rows = this.db.prepare(`SELECT * FROM resource_acl
                WHERE resource_type = ? AND resource_id = ? AND revoked_at IS NULL`).all(type, id);
            const changed = this.originals.revokeAllForResource(type, id, revokedByUserId);
            for (const beforeRow of rows) {
                const ownerUserId = this._ownerFor(type, id, beforeRow);
                if (!ownerUserId) continue;
                const revision = positiveRevision(beforeRow.revision) + 1;
                const written = this.stmtGetIdentity.get(type, id, beforeRow.subject_type, beforeRow.subject_id);
                const afterRow = this._setMetadata(written, ownerUserId, revision);
                this.changeBridge.recordMutation({
                    entityType: 'resourceAcl',
                    entityId: afterRow.grant_key,
                    action: 'delete',
                    user: { userId: ownerUserId },
                    before: this._project(beforeRow),
                    after: null,
                    revision,
                });
            }
            return changed;
        })();
    }

    /**
     * Revoke every live grant held by the identity and every grant attached to
     * one of its resources. `granted_by_user_id` is audit provenance, not
     * ownership, so grants merely created by this user remain intact.
     *
     * This method is synchronous by design: account deletion invokes it inside
     * the same SQLite transaction that changes the user and resource rows.
     */
    deleteUserState(userId, { revokedByUserId = '' } = {}) {
        const identity = String(userId || '');
        if (!identity) throw new TypeError('deleteUserState requires a user id');
        return this.db.transaction(() => {
            const rows = this.stmtListUserState.all(identity, identity);
            let revoked = 0;
            for (const row of rows) {
                const changed = this.authz.revoke({
                    resourceType: row.resource_type,
                    resourceId: row.resource_id,
                    subjectType: row.subject_type,
                    subjectId: row.subject_id,
                    revokedByUserId: String(revokedByUserId || ''),
                });
                if (changed) revoked += 1;
            }
            return { revoked };
        })();
    }

    list(user, { includeRevoked = false } = {}) {
        if (!user?.userId) return [];
        const rows = (includeRevoked ? this.stmtListOwnerAll : this.stmtListOwner).all(String(user.userId));
        return rows.map((row) => {
            try { return this._assertOwner(user, row); } catch { return null; }
        }).filter(Boolean);
    }

    read(user, grantKey, { includeRevoked = false } = {}) {
        const row = this.stmtGetKey.get(String(grantKey || ''));
        if (!row || (!includeRevoked && row.revoked_at)) return null;
        try {
            return this._assertOwner(user, row);
        } catch {
            return null;
        }
    }

    residency(user, grantKey) {
        return this.read(user, grantKey, { includeRevoked: true }) ? 'owned' : 'foreign';
    }

    update(user, grantKey, patch = {}, { expectedRevision, mutationContext = {} } = {}) {
        const row = this.stmtGetKey.get(String(grantKey || ''));
        const current = this._assertOwner(user, row);
        if (row.revoked_at) throw new MetadataSyncError('acl_revoked', 'ACL grant has been revoked', 409);
        if (expectedRevision != null && Number(expectedRevision) !== current.revision) {
            throw new MetadataSyncError('revision_conflict', 'ACL revision does not match', 409);
        }
        if (patch.subjectType !== undefined && String(patch.subjectType) !== current.subjectType) {
            throw new MetadataSyncError('acl_identity_immutable', 'ACL subject type is immutable', 409);
        }
        if (patch.subjectId !== undefined && String(patch.subjectId) !== current.subjectId) {
            throw new MetadataSyncError('acl_identity_immutable', 'ACL subject id is immutable', 409);
        }
        const allowed = new Set(['subjectType', 'subjectId', 'capabilities', 'expiresAt']);
        if (Object.keys(patch || {}).some((key) => !allowed.has(key))) {
            throw new MetadataSyncError('acl_field_forbidden', 'ACL patch contains a non-syncable field', 400);
        }
        const capabilities = patch.capabilities === undefined ? current.capabilities : normalizeCapabilities(patch.capabilities);
        if (!capabilities.length) {
            return this.remove(user, grantKey, { expectedRevision, mutationContext });
        }
        if (patch.expiresAt !== undefined && patch.expiresAt !== null) {
            const requestedExpiry = Number(patch.expiresAt);
            if (!Number.isFinite(requestedExpiry) || requestedExpiry <= Number(this.now())) {
                throw new MetadataSyncError('invalid_acl_expiry', 'ACL expiry must be a future timestamp', 400);
            }
        }
        const expiresAt = patch.expiresAt === undefined ? current.expiresAt : nullableTime(patch.expiresAt);
        this.authz.grant({
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            capabilities,
            grantedByUserId: String(user.userId),
            expiresAt,
            mutationContext,
        });
        return this.read(user, grantKey);
    }

    remove(user, grantKey, { expectedRevision, mutationContext = {} } = {}) {
        const row = this.stmtGetKey.get(String(grantKey || ''));
        const current = this._assertOwner(user, row);
        if (expectedRevision != null && Number(expectedRevision) !== current.revision) {
            throw new MetadataSyncError('revision_conflict', 'ACL revision does not match', 409);
        }
        if (!row.revoked_at) {
            this.authz.revoke({
                resourceType: row.resource_type,
                resourceId: row.resource_id,
                subjectType: row.subject_type,
                subjectId: row.subject_id,
                revokedByUserId: String(user.userId),
                mutationContext,
            });
        }
        return true;
    }

    create() {
        throw new MetadataSyncError(
            'acl_create_requires_resource_route',
            'ACL creation requires the owner-authorized resource sharing route',
            409,
        );
    }
}

function projectClientTokenMetadata(row, expectedOwnerUserId = '') {
    const ownerUserId = String(row?.ownerUserId || '');
    const id = String(row?.id || '');
    const name = String(row?.name || '').trim();
    const revision = Number(row?.revision);
    const createdAt = Number(row?.createdAt);
    const updatedAt = Number(row?.updatedAt);
    if (!row || !id || !ownerUserId || !name || name.length > 80
        || !Number.isSafeInteger(revision) || revision < 1
        || !Number.isFinite(createdAt) || createdAt <= 0
        || !Number.isFinite(updatedAt) || updatedAt < createdAt
        || (expectedOwnerUserId && ownerUserId !== String(expectedOwnerUserId))) return null;
    return {
        id,
        ownerUserId,
        name,
        revision,
        createdAt,
        updatedAt,
        lastUsedAt: nullableTime(row.lastUsedAt),
    };
}

/**
 * Facade for the future encrypted-SQLite token authority. The existing JSON
 * token manager deliberately fails this contract, so metadata sync cannot
 * accidentally legitimize or duplicate its plaintext secret store.
 */
class ClientTokenMetadataService {
    constructor({ db, source, changeBridge, autoInstall = true } = {}) {
        this.db = db;
        this.source = source;
        this.changeBridge = changeBridge;
        this.originals = null;
        this.wrappers = null;
        const contract = source?.metadataSyncContract;
        this.available = !!(
            db
            && changeBridge
            && (!changeBridge.db || changeBridge.db === db)
            && source?.db === db
            && contract?.version === TOKEN_SYNC_CONTRACT_VERSION
            && contract?.storage === 'encrypted-sqlite'
            && contract?.secretsEncrypted === true
            && typeof source.listTokenMetadata === 'function'
            && typeof source.readTokenMetadata === 'function'
            && typeof source.renameTokenMetadata === 'function'
            && typeof source.revokeTokenMetadata === 'function'
        );
        this.unavailableReason = this.available ? null : CLIENT_TOKEN_SYNC_BLOCKER.code;
        if (autoInstall) this.install();
    }

    _supportsCanonicalInstall() {
        return this.available
            && typeof this.changeBridge?.recordMutation === 'function'
            && typeof this.source?.resolveTokenOwner === 'function'
            && ['createToken', 'updateToken', 'deleteToken', 'regenerateTokenRecord', 'regenerateToken']
                .every((method) => typeof this.source?.[method] === 'function');
    }

    install() {
        if (!this._supportsCanonicalInstall()) return this;
        if (this.source[TOKEN_INSTALL] === this
            && this.wrappers
            && this.source.createToken === this.wrappers.createToken
            && this.source.updateToken === this.wrappers.updateToken
            && this.source.deleteToken === this.wrappers.deleteToken
            && this.source.regenerateTokenRecord === this.wrappers.regenerateTokenRecord
            && this.source.regenerateToken === this.wrappers.regenerateToken) return this;

        const prior = this.source[TOKEN_INSTALL];
        if (prior && prior !== this) prior.uninstall?.();
        if (this.source[TOKEN_INSTALL] && this.source[TOKEN_INSTALL] !== this) {
            throw new MetadataSyncError(
                'client_token_sync_already_installed',
                'Client Token manager already has a metadata sync service',
                503,
            );
        }

        this.originals = {
            createToken: this.source.createToken.bind(this.source),
            updateToken: this.source.updateToken.bind(this.source),
            deleteToken: this.source.deleteToken.bind(this.source),
            regenerateTokenRecord: this.source.regenerateTokenRecord.bind(this.source),
            regenerateToken: this.source.regenerateToken.bind(this.source),
        };
        this.wrappers = {
            createToken: (...args) => this._createCanonical(...args),
            updateToken: (...args) => this._updateCanonical(...args),
            deleteToken: (...args) => this._removeCanonical(...args),
            regenerateTokenRecord: (...args) => this._rotateCanonical(...args),
            regenerateToken: (...args) => this._replaceCanonical(...args),
        };
        Object.assign(this.source, this.wrappers);
        Object.defineProperty(this.source, TOKEN_INSTALL, { value: this, configurable: true });
        return this;
    }

    uninstall() {
        if (this.source?.[TOKEN_INSTALL] !== this || !this.originals) return;
        if (this.wrappers
            && this.source.createToken === this.wrappers.createToken
            && this.source.updateToken === this.wrappers.updateToken
            && this.source.deleteToken === this.wrappers.deleteToken
            && this.source.regenerateTokenRecord === this.wrappers.regenerateTokenRecord
            && this.source.regenerateToken === this.wrappers.regenerateToken) {
            Object.assign(this.source, this.originals);
        }
        delete this.source[TOKEN_INSTALL];
        this.originals = null;
        this.wrappers = null;
    }

    _canonicalUser(ownerId, ownerUsername = '') {
        const user = this.source.resolveTokenOwner(ownerId, ownerUsername);
        if (!user?.userId) {
            throw new MetadataSyncError('invalid_owner', 'Client Token owner cannot be resolved', 400);
        }
        return { userId: String(user.userId), username: String(user.username || '') };
    }

    _projectCanonical(row, user) {
        const projected = projectClientTokenMetadata(row, user.userId);
        if (!projected) {
            throw new MetadataSyncError(
                'client_token_store_invalid',
                'Canonical token store returned invalid metadata',
                503,
            );
        }
        return projected;
    }

    _readCanonical(user, id) {
        const before = this.read(user, id);
        if (!before) {
            throw new MetadataSyncError(
                'client_token_not_found',
                'Client Token does not exist or is inaccessible',
                404,
            );
        }
        return before;
    }

    _createCanonical(ownerId, name, length = 50, ownerUsername = '') {
        const user = this._canonicalUser(ownerId, ownerUsername);
        return this.changeBridge.runMutation({
            entityType: 'clientToken',
            action: 'upsert',
            user,
            before: null,
            after: (row) => this._projectCanonical(row, user),
            actorDeviceId: null,
            changedSecretFields: ['token'],
        }, () => this.originals.createToken(ownerId, name, length, ownerUsername));
    }

    _updateCanonical(ownerId, tokenId, patch = {}) {
        if (patch?.name == null) return this.originals.updateToken(ownerId, tokenId, patch);
        const user = this._canonicalUser(ownerId);
        const before = this._readCanonical(user, tokenId);
        const requestedName = String(patch.name || '').trim().slice(0, 80) || before.name;
        return this.changeBridge.runMutation({
            entityType: 'clientToken',
            entityId: before.id,
            action: 'upsert',
            user,
            /* The store advances revision even for an equivalent sanitized
             * name. Emit a metadata refresh so peers advance as well. */
            before: requestedName === before.name ? null : before,
            after: (row) => this._projectCanonical(row, user),
            actorDeviceId: null,
        }, () => this.originals.updateToken(ownerId, tokenId, patch));
    }

    _rotateCanonical(ownerId, tokenId, length = 50) {
        const user = this._canonicalUser(ownerId);
        const before = this._readCanonical(user, tokenId);
        return this.changeBridge.runMutation({
            entityType: 'clientToken',
            entityId: before.id,
            action: 'upsert',
            user,
            /* changedSecretFields advances peers without pretending public
             * metadata changed or exposing the secret field in the feed. */
            before,
            after: (row) => this._projectCanonical(row, user),
            actorDeviceId: null,
            changedSecretFields: ['token'],
        }, () => this.originals.regenerateTokenRecord(ownerId, tokenId, length));
    }

    _removeCanonical(ownerId, tokenId) {
        const user = this._canonicalUser(ownerId);
        const before = this._readCanonical(user, tokenId);
        return this.changeBridge.runMutation({
            entityType: 'clientToken',
            entityId: before.id,
            action: 'delete',
            user,
            before,
            after: null,
            actorDeviceId: null,
        }, () => this.originals.deleteToken(ownerId, tokenId));
    }

    _replaceCanonical(ownerId, length = 50, name = 'Default Token') {
        const user = this._canonicalUser(ownerId);
        const before = this.list(user);
        return this.db.transaction(() => {
            const token = this.originals.regenerateToken(ownerId, length, name);
            for (const row of before) {
                const tombstone = this.read(user, row.id, { includeDeleted: true });
                if (!tombstone || tombstone.revision <= row.revision) {
                    throw new MetadataSyncError(
                        'client_token_store_invalid',
                        'Canonical token store did not persist a revisioned tombstone',
                        503,
                    );
                }
                this.changeBridge.recordMutation({
                    entityType: 'clientToken', entityId: row.id, action: 'delete', user,
                    before: row, after: null, revision: tombstone.revision, actorDeviceId: null,
                });
            }
            const created = this.list(user);
            if (created.length !== 1) {
                throw new MetadataSyncError(
                    'client_token_store_invalid',
                    'Canonical token reset did not create exactly one active token',
                    503,
                );
            }
            this.changeBridge.recordMutation({
                entityType: 'clientToken', entityId: created[0].id, action: 'upsert', user,
                before: null, after: created[0], actorDeviceId: null,
                changedSecretFields: ['token'],
            });
            return token;
        })();
    }

    _requireAvailable() {
        if (!this.available) {
            throw new MetadataSyncError(
                this.unavailableReason,
                'Client Token sync requires the encrypted SQLite canonical store',
                503,
            );
        }
    }

    list(user) {
        this._requireAvailable();
        if (!user?.userId) return [];
        return (this.source.listTokenMetadata(String(user.userId)) || [])
            .map((row) => projectClientTokenMetadata(row, user.userId))
            .filter(Boolean);
    }

    read(user, id, { includeDeleted = false } = {}) {
        this._requireAvailable();
        if (!user?.userId) return null;
        const row = this.source.readTokenMetadata(String(user.userId), String(id || ''), { includeDeleted });
        return projectClientTokenMetadata(row, user.userId);
    }

    residency(user, id) {
        return this.read(user, id, { includeDeleted: true }) ? 'owned' : 'foreign';
    }

    update(user, id, patch = {}, { expectedRevision, mutationContext = {} } = {}) {
        this._requireAvailable();
        const before = this.read(user, id);
        if (!before) throw new MetadataSyncError('client_token_not_found', 'Client Token does not exist or is inaccessible', 404);
        if (expectedRevision != null && Number(expectedRevision) !== before.revision) {
            throw new MetadataSyncError('revision_conflict', 'Client Token revision does not match', 409);
        }
        const keys = Object.keys(patch || {});
        if (keys.some((key) => key !== 'name')) {
            throw new MetadataSyncError('client_token_secret_forbidden', 'Only Client Token name metadata can be synced', 400);
        }
        const name = String(patch.name || '').trim();
        if (!name || name.length > 80) throw new MetadataSyncError('invalid_client_token_name', 'Client Token name is invalid', 400);
        return this.changeBridge.runMutation({
            entityType: 'clientToken', entityId: before.id, action: 'upsert', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => {
            const raw = this.source.renameTokenMetadata(String(user.userId), before.id, name, { expectedRevision: before.revision });
            const after = projectClientTokenMetadata(raw, user.userId);
            if (!after) throw new MetadataSyncError('client_token_store_invalid', 'Canonical token store returned invalid metadata', 503);
            if (after.id !== before.id || after.revision <= before.revision) {
                throw new MetadataSyncError('client_token_store_invalid', 'Canonical token store did not advance the same token revision', 503);
            }
            return after;
        });
    }

    remove(user, id, { expectedRevision, mutationContext = {} } = {}) {
        this._requireAvailable();
        const before = this.read(user, id);
        if (!before) throw new MetadataSyncError('client_token_not_found', 'Client Token does not exist or is inaccessible', 404);
        if (expectedRevision != null && Number(expectedRevision) !== before.revision) {
            throw new MetadataSyncError('revision_conflict', 'Client Token revision does not match', 409);
        }
        return this.changeBridge.runMutation({
            entityType: 'clientToken', entityId: before.id, action: 'delete', user, before, after: null,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => {
            const revoked = this.source.revokeTokenMetadata(String(user.userId), before.id, { expectedRevision: before.revision });
            if (revoked === false) throw new MetadataSyncError('revision_conflict', 'Client Token revision does not match', 409);
            const tombstone = projectClientTokenMetadata(
                this.source.readTokenMetadata(String(user.userId), before.id, { includeDeleted: true }),
                user.userId,
            );
            if (!tombstone || tombstone.id !== before.id || tombstone.revision <= before.revision) {
                throw new MetadataSyncError('client_token_store_invalid', 'Canonical token store did not persist a revisioned tombstone', 503);
            }
            /* The bridge derives a delete revision from `before`; returning the
             * tombstone row here would make it add one revision a second time. */
            return true;
        });
    }

    create() {
        throw new MetadataSyncError('client_token_create_sensitive', 'Client Tokens must be created through the sensitive server route', 409);
    }
}

module.exports = {
    CLIENT_TOKEN_SYNC_BLOCKER,
    ClientTokenMetadataService,
    MetadataSyncError,
    ResourceAclMetadataService,
    TOKEN_SYNC_CONTRACT_VERSION,
    projectClientTokenMetadata,
    stableGrantKey,
};
