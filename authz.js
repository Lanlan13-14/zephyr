'use strict';
/*
 * authz.js — single authorization entry point (FREEZE plan §12, §19.1).
 *
 * Every HTTP route, WebSocket handler, worker and AI tool must decide access
 * through this module — never through ad-hoc `username === 'admin'` checks.
 *
 * Capability model (§12.3):
 *   discover / view / use / observe / control / execute /
 *   fileRead / fileWrite / edit / share / delete / revealSecret / administer
 *
 * Effective permission (§12.5) is the intersection of:
 *   user status · role ceiling · ownership or ACL grant · dependency ACL
 * with ownership granting the full set for that resource and the admin role
 * granting only metadata-level governance over other users' private resources
 * (never secret material, never implicit use).
 */
const crypto = require('crypto');

const CAP = Object.freeze({
    DISCOVER: 'discover',
    VIEW: 'view',
    USE: 'use',
    OBSERVE: 'observe',
    CONTROL: 'control',
    EXECUTE: 'execute',
    FILE_READ: 'fileRead',
    FILE_WRITE: 'fileWrite',
    EDIT: 'edit',
    SHARE: 'share',
    DELETE: 'delete',
    REVEAL_SECRET: 'revealSecret',
    ADMINISTER: 'administer',
});

const ALL_CAPS = Object.freeze(Object.values(CAP));

/* Owner implicitly holds every capability over their own resource. */
const OWNER_CAPS = Object.freeze([...ALL_CAPS]);

/* Permission tiers (§12.4) — UI presets; the DB stores the expanded set. */
const TIERS = Object.freeze({
    observer: [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE],
    operator: [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE, CAP.USE, CAP.CONTROL],
    'file-operator': [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE, CAP.USE, CAP.CONTROL, CAP.FILE_READ, CAP.FILE_WRITE],
    executor: [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE, CAP.USE, CAP.CONTROL, CAP.EXECUTE],
    editor: [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE, CAP.USE, CAP.CONTROL, CAP.EDIT],
    manager: [CAP.DISCOVER, CAP.VIEW, CAP.OBSERVE, CAP.USE, CAP.CONTROL, CAP.EXECUTE, CAP.FILE_READ, CAP.FILE_WRITE, CAP.EDIT, CAP.SHARE, CAP.DELETE],
});

/* Admins governing OTHER users' private resources get metadata-level sight
 * only (§13.3): counts, names, state — never secrets, never implicit use. */
const ADMIN_GOVERNANCE_CAPS = Object.freeze([CAP.VIEW]);

function normalizeCapabilities(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    for (const cap of list) {
        const value = String(cap || '').trim();
        if (ALL_CAPS.includes(value) && !out.includes(value)) out.push(value);
    }
    return out;
}

function expandTier(tierOrCaps) {
    if (Array.isArray(tierOrCaps)) return normalizeCapabilities(tierOrCaps);
    const tier = TIERS[String(tierOrCaps || '').trim()];
    return tier ? [...tier] : [];
}

class HttpError extends Error {
    constructor(status, code, message, retryable = false) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

class Authz {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {object} deps
     * @param {(userId:string)=>object|null} deps.getUserById
     * @param {()=>number} [deps.now]
     */
    constructor(db, deps) {
        if (!db) throw new Error('authz requires a database');
        this.db = db;
        this.getUserById = deps?.getUserById || (() => null);
        this.now = typeof deps?.now === 'function' ? deps.now : () => Date.now();

        this.stmtGrantGet = db.prepare('SELECT * FROM resource_acl WHERE resource_type = ? AND resource_id = ? AND subject_type = ? AND subject_id = ?');
        this.stmtGrantUpsert = db.prepare(`INSERT INTO resource_acl
            (resource_type, resource_id, subject_type, subject_id, capabilities_json, granted_by_user_id, created_at, expires_at, revoked_at)
            VALUES (@resourceType, @resourceId, @subjectType, @subjectId, @capabilitiesJson, @grantedByUserId, @createdAt, @expiresAt, NULL)
            ON CONFLICT(resource_type, resource_id, subject_type, subject_id)
            DO UPDATE SET capabilities_json = @capabilitiesJson, granted_by_user_id = @grantedByUserId, expires_at = @expiresAt, revoked_at = NULL`);
        this.stmtRevoke = db.prepare('UPDATE resource_acl SET revoked_at = ? WHERE resource_type = ? AND resource_id = ? AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL');
        this.stmtListForResource = db.prepare('SELECT * FROM resource_acl WHERE resource_type = ? AND resource_id = ? AND revoked_at IS NULL');
        this.stmtListForSubject = db.prepare('SELECT * FROM resource_acl WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL');
        this.stmtAudit = db.prepare(`INSERT INTO audit_events
            (event_id, actor_user_id, target_user_id, resource_type, resource_id, action, outcome, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        this.stmtRevokeAllForResource = db.prepare('UPDATE resource_acl SET revoked_at = ? WHERE resource_type = ? AND resource_id = ? AND revoked_at IS NULL');
    }

    _isGrantLive(row, nowTs) {
        if (!row || row.revoked_at) return false;
        if (row.expires_at && Number(row.expires_at) < nowTs) return false;
        return true;
    }

    /**
     * Effective capability set for (user, resource).
     * @param {object} user       { userId, role, status }
     * @param {object} resource   { ownerUserId } — secrets are never needed here
     * @returns {Set<string>}
     */
    effectiveCapabilities(user, resourceType, resourceId, resource) {
        const caps = new Set();
        if (!user || !resource) return caps;
        if (user.status !== 'active') return caps;
        if (resource.ownerUserId && resource.ownerUserId === user.userId) {
            for (const cap of OWNER_CAPS) caps.add(cap);
            return caps;
        }
        if (user.role === 'admin') {
            for (const cap of ADMIN_GOVERNANCE_CAPS) caps.add(cap);
        }
        // Built-in visibility modes used by the connection sharing UI.
        // Grant connect/use but never secret reveal, edit, share or delete.
        const visibility = String(resource.visibility || '');
        if (visibility === 'shared_users' || visibility === 'shared_all' || (visibility === 'shared_admins' && user.role === 'admin')) {
            caps.add(CAP.DISCOVER);
            caps.add(CAP.VIEW);
            caps.add(CAP.USE);
            caps.add(CAP.OBSERVE);
        }
        const row = this.stmtGrantGet.get(resourceType, resourceId, 'user', user.userId);
        if (this._isGrantLive(row, this.now())) {
            for (const cap of normalizeCapabilities(JSON.parse(row.capabilities_json || '[]'))) caps.add(cap);
        }
        return caps;
    }

    can(user, capability, resourceType, resourceId, resource) {
        return this.effectiveCapabilities(user, resourceType, resourceId, resource).has(capability);
    }

    /**
     * Like can(), but throws a structured HttpError. Non-existent and
     * inaccessible resources collapse to the same 404 for non-admins to
     * prevent resource enumeration (§12.5).
     */
    assertCan(user, capability, resourceType, resourceId, resource, { resourceExists = true } = {}) {
        if (!user || user.status !== 'active') {
            throw new HttpError(403, 'account_suspended', '账号不可用', false);
        }
        if (!resourceExists) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', '资源不存在或无权访问', false);
        }
        if (!this.can(user, capability, resourceType, resourceId, resource)) {
            throw new HttpError(403, `forbidden_resource_${capability}`, '当前账号没有此资源的所需权限', false);
        }
        return true;
    }

    /**
     * Grant (or replace) a capability set. Always audited. Never stores
     * secrets — capabilities only (§18.3).
     */
    grant({ resourceType, resourceId, subjectType = 'user', subjectId, capabilities, grantedByUserId, expiresAt = null }) {
        const caps = normalizeCapabilities(capabilities);
        if (!caps.length) throw new HttpError(400, 'invalid_capabilities', '权限集合不能为空');
        const nowTs = this.now();
        this.stmtGrantUpsert.run({
            resourceType: String(resourceType),
            resourceId: String(resourceId),
            subjectType: String(subjectType),
            subjectId: String(subjectId),
            capabilitiesJson: JSON.stringify(caps),
            grantedByUserId: String(grantedByUserId || ''),
            createdAt: nowTs,
            expiresAt: expiresAt ? Number(expiresAt) : null,
        });
        this.audit({
            actorUserId: grantedByUserId,
            targetUserId: subjectType === 'user' ? subjectId : null,
            resourceType,
            resourceId,
            action: 'acl.grant',
            outcome: 'success',
            metadata: { capabilities: caps, expiresAt: expiresAt || null },
        });
        return caps;
    }

    revoke({ resourceType, resourceId, subjectType = 'user', subjectId, revokedByUserId = '' }) {
        const changed = this.stmtRevoke.run(this.now(), String(resourceType), String(resourceId), String(subjectType), String(subjectId)).changes > 0;
        if (changed) {
            this.audit({
                actorUserId: revokedByUserId,
                targetUserId: subjectType === 'user' ? subjectId : null,
                resourceType,
                resourceId,
                action: 'acl.revoke',
                outcome: 'success',
            });
        }
        return changed;
    }

    revokeAllForResource(resourceType, resourceId, revokedByUserId = '') {
        const changed = this.stmtRevokeAllForResource.run(this.now(), String(resourceType), String(resourceId)).changes;
        if (changed > 0) {
            this.audit({ actorUserId: revokedByUserId, resourceType, resourceId, action: 'acl.revoke_all', outcome: 'success', metadata: { count: changed } });
        }
        return changed;
    }

    listGrants(resourceType, resourceId) {
        return this.stmtListForResource.all(String(resourceType), String(resourceId))
            .filter((row) => this._isGrantLive(row, this.now()))
            .map((row) => ({
                resourceType: row.resource_type,
                resourceId: row.resource_id,
                subjectType: row.subject_type,
                subjectId: row.subject_id,
                capabilities: normalizeCapabilities(JSON.parse(row.capabilities_json || '[]')),
                grantedByUserId: row.granted_by_user_id,
                createdAt: Number(row.created_at),
                expiresAt: row.expires_at ? Number(row.expires_at) : null,
            }));
    }

    /** All live grants a subject holds, optionally narrowed to one type. */
    listSubjectGrants(userId, { resourceType = null } = {}) {
        return this.stmtListForSubject.all('user', String(userId))
            .filter((row) => this._isGrantLive(row, this.now()))
            .filter((row) => !resourceType || row.resource_type === resourceType)
            .map((row) => ({
                resourceType: row.resource_type,
                resourceId: row.resource_id,
                capabilities: normalizeCapabilities(JSON.parse(row.capabilities_json || '[]')),
                grantedByUserId: row.granted_by_user_id,
                createdAt: Number(row.created_at),
                expiresAt: row.expires_at ? Number(row.expires_at) : null,
            }));
    }

    /**
     * Ids of `rows` the user may at least discover: owned rows plus rows with
     * a live grant containing `discover`. Admin governance alone (view without
     * discover) does NOT place a resource into the user's lists (§20.2).
     */
    visibleIds(user, resourceType, rows) {
        const out = new Set();
        if (!user || user.status !== 'active') return out;
        const grants = this.listSubjectGrants(user.userId, { resourceType });
        const discoverable = new Set(grants.filter((g) => g.capabilities.includes(CAP.DISCOVER)).map((g) => g.resourceId));
        for (const row of rows || []) {
            if (row.ownerUserId && row.ownerUserId === user.userId) out.add(row.id);
            else if (discoverable.has(row.id)) out.add(row.id);
            else {
                const vis = String(row.visibility || '');
                if (vis === 'shared_users' || vis === 'shared_all' || (vis === 'shared_admins' && user.role === 'admin')) out.add(row.id);
            }
        }
        return out;
    }

    /** Append an audit trail entry. Metadata must never contain secrets. */
    audit({ actorUserId = null, targetUserId = null, resourceType = null, resourceId = null, action, outcome, metadata = {} }) {
        try {
            this.stmtAudit.run(
                crypto.randomUUID(),
                actorUserId || null,
                targetUserId || null,
                resourceType || null,
                resourceId || null,
                String(action || '').slice(0, 80),
                String(outcome || '').slice(0, 40),
                JSON.stringify(metadata || {}),
                this.now(),
            );
        } catch (err) {
            console.warn('[audit] failed to write event', { action, error: err.message });
        }
    }

    listAuditEvents({ limit = 200, actorUserId = null } = {}) {
        const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
        if (actorUserId) {
            return this.db.prepare('SELECT * FROM audit_events WHERE actor_user_id = ? ORDER BY created_at DESC LIMIT ?').all(String(actorUserId), capped);
        }
        return this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?').all(capped);
    }
}

module.exports = { Authz, CAP, ALL_CAPS, TIERS, OWNER_CAPS, ADMIN_GOVERNANCE_CAPS, HttpError, normalizeCapabilities, expandTier };
