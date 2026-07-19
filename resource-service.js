'use strict';
/*
 * resource-service.js — owner-aware CRUD + dependency resolution for
 * connections, proxies, ssh keys and jump hosts (FREEZE plan §12, §19.4).
 *
 * Rules enforced here:
 * - lists only contain owned resources + resources shared with `discover`
 * - secrets leave the store only for the owner (revealSecret) or for a
 *   server-side connection attempt (use) — never into list/metadata payloads
 * - dependencies (proxy, jump hosts, ssh key) are resolved server-side at
 *   connect time and re-checked against current ACL; sharing a connection
 *   does not implicitly share its dependencies (§12.2, §13.1)
 */
const { CAP, HttpError } = require('./authz');

const RESOURCE_TYPES = Object.freeze({
    connection: { table: 'connections' },
    proxy: { table: 'proxies' },
    sshKey: { table: 'ssh_keys' },
    jumpHost: { table: 'jump_hosts' },
});

class ResourceService {
    /**
     * @param {object} storage  the storage.js module
     * @param {import('./authz').Authz} authz
     */
    constructor(storage, authz) {
        this.storage = storage;
        this.authz = authz;
    }

    /* ── raw lookups (server-internal only) ─────────────────────── */
    _rawResource(resourceType, id) {
        switch (resourceType) {
            case 'connection': return this.storage.getConnectionById(id);
            case 'proxy': return this.storage.getProxyRaw(id);
            /* getSshKeyRaw (decrypted, unmasked) — the masked listSshKeys()
             * variant must never be used here or edits would overwrite the
             * stored key with '******'. */
            case 'sshKey': return this.storage.getSshKeyRaw(id);
            case 'jumpHost': return this.storage.listJumpHosts().find((j) => j.id === id) || null;
            default: return null;
        }
    }

    _ownerOf(resourceType, id) {
        const raw = this._rawResource(resourceType, id);
        return raw ? { ownerUserId: raw.ownerUserId || '', visibility: raw.visibility || 'private' } : null;
    }

    /* ── connections ────────────────────────────────────────────── */

    /** Sanitized list the user can see: owned + shared-with-discover. */
    listConnections(user) {
        const all = this.storage.listAllConnectionRows();
        const visible = this.authz.visibleIds(user, 'connection', all);
        return all
            .filter((c) => visible.has(c.id))
            .map((c) => this._toPublicConnection(user, c));
    }

    _toPublicConnection(user, conn) {
        const caps = this.authz.effectiveCapabilities(user, 'connection', conn.id, conn);
        const owned = conn.ownerUserId === user.userId;
        const copy = { ...conn };
        copy.password = conn.password ? '******' : '';
        copy.privateKey = conn.privateKey ? '******' : '';
        copy.hasPassword = Boolean(conn.password);
        copy.hasPrivateKey = Boolean(conn.privateKey);
        copy.owner = owned ? 'own' : 'shared';
        copy.capabilities = [...caps];
        if (!caps.has(CAP.REVEAL_SECRET)) {
            delete copy.ownerUserId; // do not leak owner identity fields to non-privileged viewers
        }
        return copy;
    }

    /** Single connection for display/editing. Secrets only with revealSecret. */
    getConnection(user, id, { reveal = false } = {}) {
        const conn = this.storage.getConnectionById(id);
        this.authz.assertCan(user, reveal ? CAP.REVEAL_SECRET : CAP.VIEW, 'connection', id, conn || { ownerUserId: '' }, { resourceExists: !!conn });
        if (reveal) return conn;
        return this._toPublicConnection(user, conn);
    }

    createConnection(user, data) {
        const conn = {
            ...data,
            ownerUserId: user.userId,
            createdByUserId: user.userId,
            visibility: 'private',
        };
        this._assertDependenciesUsable(user, conn);
        const saved = this.storage.insertConnection(conn);
        this.authz.audit({ actorUserId: user.userId, resourceType: 'connection', resourceId: conn.id, action: 'resource.create', outcome: 'success', metadata: { name: conn.name, host: conn.host, port: conn.port, protocol: conn.protocol } });
        return this._toPublicConnection(user, saved);
    }

    updateConnection(user, id, mutate) {
        const conn = this.storage.getConnectionById(id);
        this.authz.assertCan(user, CAP.EDIT, 'connection', id, conn || { ownerUserId: '' }, { resourceExists: !!conn });
        const next = mutate({ ...conn }) || conn;
        next.id = conn.id;
        next.ownerUserId = conn.ownerUserId;
        next.createdByUserId = conn.createdByUserId;
        next.visibility = conn.visibility;
        /* Route changes must not jump the connection onto dependencies the
         * editor may not use (§13.1). */
        this._assertDependenciesUsable(user, next);
        next.updatedAt = Date.now();
        const saved = this.storage.updateConnectionRow(next);
        this.authz.audit({ actorUserId: user.userId, resourceType: 'connection', resourceId: id, action: 'resource.update', outcome: 'success', metadata: { name: saved.name } });
        return this._toPublicConnection(user, saved);
    }

    deleteConnection(user, id) {
        const conn = this.storage.getConnectionById(id);
        this.authz.assertCan(user, CAP.DELETE, 'connection', id, conn || { ownerUserId: '' }, { resourceExists: !!conn });
        this.storage.deleteConnectionRow(id);
        this.authz.revokeAllForResource('connection', id, user.userId);
        this.authz.audit({ actorUserId: user.userId, resourceType: 'connection', resourceId: id, action: 'resource.delete', outcome: 'success', metadata: { name: conn.name } });
        return true;
    }

    markConnected(user, id) {
        const conn = this.storage.getConnectionById(id);
        if (!conn) return;
        conn.lastConnectedAt = Date.now();
        this.storage.updateConnectionRow(conn);
    }

    /**
     * Resolve a connection for an actual server-side connect attempt.
     * Requires `use`; returns decrypted secrets to the SERVER ONLY — callers
     * must never forward this object to the browser.
     */
    resolveForConnect(user, id) {
        const conn = this.storage.getConnectionById(id);
        this.authz.assertCan(user, CAP.USE, 'connection', id, conn || { ownerUserId: '' }, { resourceExists: !!conn });
        const resolved = this._resolveDependencySecrets(user, conn);
        this.authz.audit({ actorUserId: user.userId, resourceType: 'connection', resourceId: id, action: 'resource.use', outcome: 'success', metadata: { host: conn.host, port: conn.port, protocol: conn.protocol } });
        return resolved;
    }

    /**
     * Dependency resolution (§13.1): a dependency is usable when it is owned
     * by the SAME owner as the connection, or explicitly shared to the user
     * with `use`. Secrets stay server-side.
     */
    _resolveDependencySecrets(user, conn) {
        const resolved = { ...conn };
        const depOk = (resourceType, dep) => {
            if (!dep) return false;
            if (dep.ownerUserId && dep.ownerUserId === conn.ownerUserId) return true;
            return this.authz.can(user, CAP.USE, resourceType, dep.id, dep);
        };
        // ssh key
        if (resolved.sshKeyId) {
            const key = this.storage.getSshKeyRaw(resolved.sshKeyId);
            if (key && depOk('sshKey', key)) {
                if (!resolved.privateKey || resolved.privateKey === '******') resolved.privateKey = key.privateKey || '';
                if ((!resolved.password || resolved.password === '******') && key.passphrase) resolved.password = key.passphrase;
            } else if (key) {
                throw new HttpError(403, 'forbidden_dependency_sshKey', '连接依赖的 SSH 密钥无权使用', false);
            }
        }
        // proxy
        if (resolved.connectionMode === 'proxy' && resolved.proxyId) {
            const proxy = this.storage.getProxyRaw(resolved.proxyId);
            if (proxy && !depOk('proxy', proxy)) {
                throw new HttpError(403, 'forbidden_dependency_proxy', '连接依赖的代理无权使用', false);
            }
        }
        // jump hosts (each references another connection — recurse one level)
        if (resolved.connectionMode === 'jump') {
            const jumpIds = Array.isArray(resolved.jumpHostIds) ? resolved.jumpHostIds : [];
            for (const jumpId of jumpIds) {
                const jump = this.storage.listJumpHosts().find((j) => j.id === jumpId);
                if (!jump) continue;
                if (jump.ownerUserId && jump.ownerUserId === conn.ownerUserId) continue;
                if (!this.authz.can(user, CAP.USE, 'jumpHost', jump.id, jump)) {
                    throw new HttpError(403, 'forbidden_dependency_jumpHost', '连接依赖的跳板机无权使用', false);
                }
                const jumpConn = jump.connectionId ? this.storage.getConnectionById(jump.connectionId) : null;
                if (jumpConn && jumpConn.ownerUserId !== conn.ownerUserId
                    && !this.authz.can(user, CAP.USE, 'connection', jumpConn.id, jumpConn)) {
                    throw new HttpError(403, 'forbidden_dependency_jumpConnection', '跳板机引用的连接无权使用', false);
                }
            }
        }
        return resolved;
    }

    /** Edit-time dependency validation: the editor must own or have `use` on
     * every referenced dependency, otherwise they could route a connection
     * through someone else's proxy/jump/key (§13.1). */
    _assertDependenciesUsable(user, conn) {
        if (conn.sshKeyId) {
            const key = this._ownerOf('sshKey', conn.sshKeyId);
            if (!key) throw new HttpError(400, 'invalid_dependency', '选择的 SSH 密钥不存在', false);
            const owned = key.ownerUserId === user.userId;
            if (!owned && !this.authz.can(user, CAP.USE, 'sshKey', conn.sshKeyId, key)) {
                throw new HttpError(403, 'forbidden_dependency_sshKey', '无权使用该 SSH 密钥', false);
            }
        }
        if (conn.connectionMode === 'proxy' && conn.proxyId) {
            const proxy = this._ownerOf('proxy', conn.proxyId);
            if (!proxy) throw new HttpError(400, 'invalid_dependency', '选择的代理不存在', false);
            const owned = proxy.ownerUserId === user.userId;
            if (!owned && !this.authz.can(user, CAP.USE, 'proxy', conn.proxyId, proxy)) {
                throw new HttpError(403, 'forbidden_dependency_proxy', '无权使用该代理', false);
            }
        }
        if (conn.connectionMode === 'jump') {
            for (const jumpId of (Array.isArray(conn.jumpHostIds) ? conn.jumpHostIds : [])) {
                const jump = this._ownerOf('jumpHost', jumpId);
                if (!jump) throw new HttpError(400, 'invalid_dependency', '选择的跳板机不存在', false);
                const owned = jump.ownerUserId === user.userId;
                if (!owned && !this.authz.can(user, CAP.USE, 'jumpHost', jumpId, jump)) {
                    throw new HttpError(403, 'forbidden_dependency_jumpHost', '无权使用该跳板机', false);
                }
            }
        }
    }

    /* ── proxies / ssh keys / jump hosts ────────────────────────── */

    listOwned(user, resourceType) {
        const rows = resourceType === 'proxy' ? this.storage.listProxies()
            : resourceType === 'sshKey' ? this.storage.listSshKeys()
                : this.storage.listJumpHosts();
        const visible = this.authz.visibleIds(user, resourceType, rows);
        return rows.filter((r) => visible.has(r.id)).map((r) => ({ ...r, owner: r.ownerUserId === user.userId ? 'own' : 'shared' }));
    }

    getRawAuthorized(user, resourceType, id, capability) {
        const raw = this._rawResource(resourceType, id);
        this.authz.assertCan(user, capability, resourceType, id, raw || { ownerUserId: '' }, { resourceExists: !!raw });
        return raw;
    }

    createOwned(user, resourceType, data) {
        const payload = { ...data, ownerUserId: user.userId, visibility: 'private' };
        let saved;
        if (resourceType === 'proxy') saved = this.storage.saveProxy(payload);
        else if (resourceType === 'sshKey') saved = this.storage.saveSshKey(payload);
        else if (resourceType === 'jumpHost') saved = this.storage.saveJumpHost(payload);
        else throw new HttpError(400, 'invalid_resource_type', '未知资源类型');
        this.authz.audit({ actorUserId: user.userId, resourceType, resourceId: data.id, action: 'resource.create', outcome: 'success', metadata: { name: data.name || '' } });
        return saved;
    }

    updateOwned(user, resourceType, id, data) {
        this.getRawAuthorized(user, resourceType, id, CAP.EDIT);
        return this.createOwned(user, resourceType, { ...data, id, ownerUserId: this._ownerOf(resourceType, id)?.ownerUserId || user.userId });
    }

    deleteOwned(user, resourceType, id) {
        this.getRawAuthorized(user, resourceType, id, CAP.DELETE);
        if (resourceType === 'proxy') this.storage.deleteProxy(id);
        else if (resourceType === 'sshKey') this.storage.deleteSshKey(id);
        else if (resourceType === 'jumpHost') this.storage.deleteJumpHost(id);
        this.authz.revokeAllForResource(resourceType, id, user.userId);
        this.authz.audit({ actorUserId: user.userId, resourceType, resourceId: id, action: 'resource.delete', outcome: 'success' });
        return true;
    }
}

module.exports = { ResourceService, RESOURCE_TYPES };
