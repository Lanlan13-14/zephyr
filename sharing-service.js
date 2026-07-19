'use strict';
/*
 * sharing-service.js — ACL grant management UX layer (FREEZE plan §12.4, §19.4).
 * Validates subjects, expands permission tiers into stored capability sets,
 * and keeps an audit trail. Granting share requires the `share` capability.
 */
const { CAP, HttpError, expandTier, TIERS, normalizeCapabilities } = require('./authz');

const SHAREABLE_TYPES = new Set(['connection', 'proxy', 'sshKey', 'jumpHost', 'note', 'task', 'terminalSession']);

class SharingService {
    /**
     * @param {import('./authz').Authz} authz
     * @param {object} storage
     * @param {import('./resource-service').ResourceService} resources
     */
    constructor(authz, storage, resources) {
        this.authz = authz;
        this.storage = storage;
        this.resources = resources;
    }

    _loadResourceForAcl(resourceType, resourceId) {
        if (!SHAREABLE_TYPES.has(resourceType)) throw new HttpError(400, 'invalid_resource_type', '不支持的资源类型');
        const raw = this.resources._rawResource(resourceType, resourceId);
        return raw;
    }

    /** List shares for a resource (requires `share` or ownership). */
    listShares(user, resourceType, resourceId) {
        const raw = this._loadResourceForAcl(resourceType, resourceId);
        this.authz.assertCan(user, CAP.SHARE, resourceType, resourceId, raw || { ownerUserId: '' }, { resourceExists: !!raw });
        const grants = this.authz.listGrants(resourceType, resourceId);
        return grants.map((g) => {
            const subject = g.subjectType === 'user' ? this.storage.getUserById(g.subjectId) : null;
            return {
                ...g,
                subjectName: subject?.username || '',
                subjectStatus: subject?.status || '',
            };
        });
    }

    /**
     * Replace the full share set for a resource atomically-ish.
     * shares: [{ subjectId, tier? | capabilities?, expiresAt? }]
     * A subject listed with empty capabilities gets their grant revoked.
     */
    putShares(user, resourceType, resourceId, shares) {
        const raw = this._loadResourceForAcl(resourceType, resourceId);
        this.authz.assertCan(user, CAP.SHARE, resourceType, resourceId, raw || { ownerUserId: '' }, { resourceExists: !!raw });
        if (!Array.isArray(shares)) throw new HttpError(400, 'invalid_shares', '共享列表格式错误');
        if (shares.length > 200) throw new HttpError(400, 'too_many_shares', '共享对象过多');

        const wanted = new Map();
        for (const share of shares) {
            const subjectId = String(share?.subjectId || '').trim();
            if (!subjectId) throw new HttpError(400, 'invalid_subject', '共享对象不能为空');
            if (subjectId === raw.ownerUserId) throw new HttpError(400, 'cannot_share_to_owner', '不能与资源拥有者共享');
            const subject = this.storage.getUserById(subjectId);
            if (!subject) throw new HttpError(404, 'subject_not_found', '目标用户不存在');
            if (subject.status !== 'active') throw new HttpError(400, 'subject_inactive', '目标用户不可用');
            const capabilities = share.capabilities !== undefined
                ? normalizeCapabilities(share.capabilities)
                : expandTier(share.tier);
            const expiresAt = share.expiresAt ? Number(share.expiresAt) : null;
            if (expiresAt && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) {
                throw new HttpError(400, 'invalid_expiry', '有效期不合法');
            }
            wanted.set(subjectId, { capabilities, expiresAt });
        }

        const existing = new Map(this.authz.listGrants(resourceType, resourceId).map((g) => [g.subjectId, g]));
        const results = [];
        for (const [subjectId, { capabilities, expiresAt }] of wanted) {
            if (!capabilities.length) {
                if (existing.has(subjectId)) {
                    this.authz.revoke({ resourceType, resourceId, subjectId, revokedByUserId: user.userId });
                    results.push({ subjectId, revoked: true });
                }
                continue;
            }
            const caps = this.authz.grant({
                resourceType,
                resourceId,
                subjectId,
                capabilities,
                grantedByUserId: user.userId,
                expiresAt,
            });
            results.push({ subjectId, capabilities: caps, expiresAt });
        }
        for (const subjectId of existing.keys()) {
            if (!wanted.has(subjectId)) {
                this.authz.revoke({ resourceType, resourceId, subjectId, revokedByUserId: user.userId });
                results.push({ subjectId, revoked: true });
            }
        }
        return results;
    }

    deleteShare(user, resourceType, resourceId, subjectId) {
        const raw = this._loadResourceForAcl(resourceType, resourceId);
        this.authz.assertCan(user, CAP.SHARE, resourceType, resourceId, raw || { ownerUserId: '' }, { resourceExists: !!raw });
        const changed = this.authz.revoke({ resourceType, resourceId, subjectId: String(subjectId || ''), revokedByUserId: user.userId });
        if (!changed) throw new HttpError(404, 'share_not_found', '共享不存在');
        return true;
    }

    /** Everything shared TO the given user (for their "shared with me" view). */
    listSharedWithMe(user, { resourceType = null } = {}) {
        return this.authz.listSubjectGrants(user.userId, { resourceType }).map((g) => {
            const raw = this.resources._rawResource(g.resourceType, g.resourceId);
            const owner = raw?.ownerUserId ? this.storage.getUserById(raw.ownerUserId) : null;
            return {
                ...g,
                resourceExists: !!raw,
                resourceName: raw?.name || '',
                ownerName: owner?.username || '',
            };
        });
    }
}

module.exports = { SharingService, SHAREABLE_TYPES, TIERS };
