'use strict';
/*
 * user-service.js — account lifecycle for the multi-user platform
 * (FREEZE plan §11, §19.3): create/suspend/delete users, admin-initiated
 * resets, session revocation, last-admin protection, all audited.
 */
const { HttpError } = require('./authz');

const USERNAME_RE = /^[A-Za-z0-9_.@-]{2,32}$/;
const ROLES = new Set(['admin', 'user']);
const STATUSES = new Set(['active', 'invited', 'suspended', 'deleted']);

class UserService {
    /**
     * @param {object} storage
     * @param {import('./session-store').SessionStore} sessionStoreProvider — getter so reopenStorage stays safe
     * @param {import('./authz').Authz} authz
     * @param {(password:string)=>string} hashPassword
     */
    constructor(storage, sessionStoreProvider, authz, hashPassword) {
        this.storage = storage;
        this.getSessionStore = sessionStoreProvider;
        this.authz = authz;
        this.hashPassword = hashPassword;
    }

    _publicUser(u) {
        if (!u) return null;
        return {
            userId: u.userId,
            username: u.username,
            role: u.role,
            status: u.status,
            email: u.email || '',
            defaultPassword: !!u.defaultPassword,
            totpEnabled: !!u.totpEnabled,
            createdAt: u.createdAt || null,
            updatedAt: u.updatedAt || null,
            lastLoginAt: u.lastLoginAt || null,
            isSuperAdmin: !!u.isSuperAdmin,
        };
    }

    listUsers() {
        return this.storage.listUsers().map((u) => this._publicUser(u));
    }

    getUser(userId) {
        const u = this.storage.getUserById(userId);
        if (!u) throw new HttpError(404, 'user_not_found', '用户不存在');
        return this._publicUser(u);
    }

    createUser(actor, { username, password, email = '', role = 'user', mustChangePassword = true }) {
        username = String(username || '').trim();
        if (!USERNAME_RE.test(username)) throw new HttpError(400, 'invalid_username', '用户名需为 2-32 位字母、数字或 ._@-' );
        if (this.storage.getUser(username)) throw new HttpError(409, 'username_taken', '用户名已存在');
        if (!password || String(password).length < 4) throw new HttpError(400, 'weak_password', '密码至少 4 位');
        if (!ROLES.has(role)) throw new HttpError(400, 'invalid_role', '角色不合法');
        // Only super admin can create new admins (§19.3)
        if (role === 'admin' && !actor.isSuperAdmin) throw new HttpError(403, 'super_admin_required', '只有超级管理员可以创建管理员账号');
        const user = this.storage.createUser({
            username,
            passwordHash: this.hashPassword(String(password)),
            email: String(email || ''),
            role,
            status: 'active',
            defaultPassword: !!mustChangePassword,
        });
        this.authz.audit({ actorUserId: actor.userId, targetUserId: user.userId, action: 'user.create', outcome: 'success', metadata: { username, role } });
        return this._publicUser(user);
    }

    updateUser(actor, userId, { email, role, status } = {}) {
        const target = this.storage.getUserById(userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        const patch = {};
        if (email !== undefined) patch.email = String(email || '');
        if (role !== undefined) {
            if (!ROLES.has(role)) throw new HttpError(400, 'invalid_role', '角色不合法');
            // Only super admin can promote/demote admin roles (§19.3)
            if (role === 'admin' || target.role === 'admin') {
                if (!actor.isSuperAdmin) throw new HttpError(403, 'super_admin_required', '只有超级管理员可以授予或撤销管理员角色');
            }
            if (target.role === 'admin' && role !== 'admin') this._assertNotLastAdmin(target, '降级');
            // Super admin cannot be demoted by anyone (including self)
            if (target.isSuperAdmin && role !== 'admin') throw new HttpError(403, 'cannot_demote_super_admin', '超级管理员不能被降级');
            patch.role = role;
        }
        if (status !== undefined) {
            if (!STATUSES.has(status)) throw new HttpError(400, 'invalid_status', '状态不合法');
            if (target.isSuperAdmin) throw new HttpError(403, 'cannot_suspend_super_admin', '超级管理员不能被停用或删除');
            if (target.status === 'active' && status !== 'active' && target.role === 'admin') this._assertNotLastAdmin(target, '停用');
            patch.status = status;
        }
        const updated = this.storage.updateUserById(userId, patch);
        this.authz.audit({ actorUserId: actor.userId, targetUserId: userId, action: 'user.update', outcome: 'success', metadata: { fields: Object.keys(patch) } });
        if (patch.status && patch.status !== 'active') {
            this.getSessionStore().revokeAllForUser(userId, `status-${patch.status}`);
        }
        if (patch.role && patch.role !== target.role) {
            // Role changes re-authenticate: existing sessions keep identity but
            // must re-establish privilege-sensitive connections.
            this.getSessionStore().revokeAllForUser(userId, 'role-changed');
        }
        return this._publicUser(updated);
    }

    suspendUser(actor, userId) {
        const target = this.storage.getUserById(userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        if (target.isSuperAdmin) throw new HttpError(403, 'cannot_suspend_super_admin', '超级管理员不能被停用');
        if (target.role === 'admin') this._assertNotLastAdmin(target, '停用');
        const updated = this.storage.updateUserById(userId, { status: 'suspended' });
        this.getSessionStore().revokeAllForUser(userId, 'suspended');
        this.authz.audit({ actorUserId: actor.userId, targetUserId: userId, action: 'user.suspend', outcome: 'success' });
        return this._publicUser(updated);
    }

    reactivateUser(actor, userId) {
        const target = this.storage.getUserById(userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        const updated = this.storage.updateUserById(userId, { status: 'active' });
        this.authz.audit({ actorUserId: actor.userId, targetUserId: userId, action: 'user.reactivate', outcome: 'success' });
        return this._publicUser(updated);
    }

    /** Admin sets a new password; user must change it at next login (§11.3). */
    forcePasswordReset(actor, userId, { newPassword } = {}) {
        const target = this.storage.getUserById(userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        if (!newPassword || String(newPassword).length < 4) throw new HttpError(400, 'weak_password', '密码至少 4 位');
        this.storage.updateUserById(userId, { passwordHash: this.hashPassword(String(newPassword)), defaultPassword: true });
        this.getSessionStore().revokeAllForUser(userId, 'admin-password-reset');
        this.getSessionStore().setMustChangePassword(userId, true);
        this.authz.audit({ actorUserId: actor.userId, targetUserId: userId, action: 'user.force_password_reset', outcome: 'success' });
        return true;
    }

    revokeSessions(actor, userId) {
        const target = this.storage.getUserById(userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        const count = this.getSessionStore().revokeAllForUser(userId, 'admin-revoked');
        this.authz.audit({ actorUserId: actor.userId, targetUserId: userId, action: 'user.revoke_sessions', outcome: 'success', metadata: { count } });
        return count;
    }

    deleteUser(actor, userId, { resourcePolicy = 'transfer-to-admin' } = {}) {
        const target = this.storage.getUserById(userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        if (target.userId === actor.userId) throw new HttpError(400, 'cannot_delete_self', '不能删除自己的账号');
        if (target.isSuperAdmin) throw new HttpError(403, 'cannot_delete_super_admin', '超级管理员不能被删除');
        if (target.role === 'admin') this._assertNotLastAdmin(target, '删除');
        const db = this.storage.rawDb();
        const admin = actor;
        const tx = db.transaction(() => {
            if (resourcePolicy === 'delete-resources') {
                for (const table of ['connections', 'proxies', 'ssh_keys', 'jump_hosts']) {
                    db.prepare(`DELETE FROM ${table} WHERE ownerUserId = ?`).run(userId);
                }
                db.prepare('DELETE FROM resource_acl WHERE subject_id = ?').run(userId);
            } else {
                /* transfer-to-admin: resources must not stay ownerless (§11.2) */
                for (const table of ['connections', 'proxies', 'ssh_keys', 'jump_hosts']) {
                    db.prepare(`UPDATE ${table} SET ownerUserId = ? WHERE ownerUserId = ?`).run(admin.userId, userId);
                }
                db.prepare('DELETE FROM resource_acl WHERE subject_id = ?').run(userId);
            }
            db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), 'user-deleted', userId);
            this.storage.updateUserById(userId, { status: 'deleted' });
        });
        tx();
        this.authz.audit({ actorUserId: actor.userId, targetUserId: userId, action: 'user.delete', outcome: 'success', metadata: { resourcePolicy } });
        return true;
    }

    _assertNotLastAdmin(target, actionLabel) {
        const admins = this.storage.listUsers().filter((u) => u.role === 'admin' && u.status === 'active' && u.userId !== target.userId);
        if (!admins.length) throw new HttpError(409, 'last_admin_protected', `不能${actionLabel}最后一个可用管理员`);
    }

    /** Transfer super admin to another user; the current super admin becomes
     * a regular admin. There must always be exactly one super admin. */
    transferSuperAdmin(actor, targetUserId) {
        if (!actor.isSuperAdmin) throw new HttpError(403, 'super_admin_required', '只有超级管理员可以转移超级管理员权限');
        const target = this.storage.getUserById(targetUserId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        if (target.userId === actor.userId) throw new HttpError(400, 'cannot_transfer_to_self', '不能转移给自己');
        if (target.role !== 'admin' || target.status !== 'active') {
            throw new HttpError(400, 'target_must_be_active_admin', '超级管理员只能转让给另一名已启用的管理员');
        }
        this.storage.updateUserById(targetUserId, { role: 'admin', isSuperAdmin: true });
        this.storage.updateUserById(actor.userId, { role: 'admin', isSuperAdmin: false });
        this.authz.audit({ actorUserId: actor.userId, targetUserId, action: 'user.transfer_super_admin', outcome: 'success' });
        return this._publicUser(this.storage.getUserById(targetUserId));
    }
}

module.exports = { UserService, USERNAME_RE };
