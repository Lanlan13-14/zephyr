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
const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

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
    constructor(storage, authz, options = {}) {
        this.storage = storage;
        this.authz = authz;
        this.mobileChangeBridge = options.mobileChangeBridge === false
            ? null
            : (options.mobileChangeBridge || getMobileV1ChangeBridge(storage.rawDb()));
    }

    _runMobileMutation(meta, write) {
        return this.mobileChangeBridge ? this.mobileChangeBridge.runMutation(meta, write) : write();
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
            /* Notes are declared shareable (SHARED_RESOURCE_RESIDENCY.md 5 and
             * sharing-service SHAREABLE_TYPES) but live in their own table with
             * their own column names, so without this case every note ACL call
             * collapsed to the "resource does not exist" 404 and per-user note
             * sharing was unreachable through both share APIs.
             *
             * Normalised to the ACL shape (`id`/`ownerUserId`/`name`) rather
             * than returned raw: authz and the admin grant UI read exactly those
             * three, and `content` must not travel through an ACL lookup. */
            case 'note': {
                const row = this.storage.rawDb()
                    .prepare('SELECT note_id, owner_user_id, title, visibility, share_with_users, share_with_admins, revision, deleted_at FROM notes WHERE note_id = ?')
                    .get(String(id || ''));
                if (!row || row.deleted_at) return null;
                return {
                    id: row.note_id,
                    ownerUserId: row.owner_user_id,
                    name: row.title || '',
                    visibility: row.visibility || 'private',
                    shareWithUsers: !!row.share_with_users,
                    shareWithAdmins: !!row.share_with_admins,
                    revision: Math.max(1, Number(row.revision) || 1),
                };
            }
            default: return null;
        }
    }

    _ownerOf(resourceType, id) {
        const raw = this._rawResource(resourceType, id);
        return raw ? { ownerUserId: raw.ownerUserId || '', visibility: raw.visibility || 'private' } : null;
    }

    /* ── connections ────────────────────────────────────────────── */

    /** Sanitized list the user can see: owned + shared-with-discover.
     *  Ephemeral one-shot rows stay out of the host library by default; pass
     *  `includeEphemeral: true` for server-side ACL (e.g. rdp-proxy host match). */
    listConnections(user, { includeEphemeral = false } = {}) {
        const all = this.storage.listAllConnectionRows();
        const visible = this.authz.visibleIds(user, 'connection', all);
        return all
            .filter((c) => visible.has(c.id))
            .filter((c) => includeEphemeral || !c.ephemeral)
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
        copy.shareWithUsers = conn.visibility === 'shared_users' || conn.visibility === 'shared_all';
        copy.shareWithAdmins = conn.visibility === 'shared_admins' || conn.visibility === 'shared_all';
        copy.ephemeral = !!conn.ephemeral;
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

    createConnection(user, data, mutationContext = {}) {
        return this._runMobileMutation({
            entityType: 'connection', entityId: data.id, action: 'upsert', user, before: null,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
            forceChange: mutationContext.forceMobileChange === true,
            changedSecretFields: mutationContext.changedSecretFields,
        }, () => this._createConnection(user, data));
    }

    _createConnection(user, data) {
        const ephemeral = !!data.ephemeral;
        // One-shot rows are never shared into the host library visibility graph.
        const visibility = ephemeral
            ? 'private'
            : (data.shareWithUsers
                ? (data.shareWithAdmins ? 'shared_all' : 'shared_users')
                : (data.shareWithAdmins ? 'shared_admins' : 'private'));
        const conn = {
            ...data,
            ephemeral: ephemeral ? 1 : 0,
            shareWithUsers: ephemeral ? false : !!data.shareWithUsers,
            shareWithAdmins: ephemeral ? false : !!data.shareWithAdmins,
            ownerUserId: user.userId,
            createdByUserId: user.userId,
            visibility,
        };
        this._assertDependenciesUsable(user, conn);
        const saved = this.storage.insertConnection(conn);
        this.authz.audit({
            actorUserId: user.userId,
            resourceType: 'connection',
            resourceId: conn.id,
            action: ephemeral ? 'resource.create_ephemeral' : 'resource.create',
            outcome: 'success',
            metadata: { name: conn.name, host: conn.host, port: conn.port, protocol: conn.protocol, ephemeral },
        });
        return this._toPublicConnection(user, saved);
    }

    updateConnection(user, id, mutate, mutationContext = {}) {
        const before = this.storage.getConnectionById(id);
        return this._runMobileMutation({
            entityType: 'connection', entityId: id, action: 'upsert', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
            forceChange: mutationContext.forceMobileChange === true,
            changedSecretFields: mutationContext.changedSecretFields,
        }, () => this._updateConnection(user, id, mutate));
    }

    _updateConnection(user, id, mutate) {
        const conn = this.storage.getConnectionById(id);
        this.authz.assertCan(user, CAP.EDIT, 'connection', id, conn || { ownerUserId: '' }, { resourceExists: !!conn });
        const next = mutate({ ...conn }) || conn;
        next.id = conn.id;
        next.ownerUserId = conn.ownerUserId;
        next.createdByUserId = conn.createdByUserId;
        const users = next.shareWithUsers !== undefined ? !!next.shareWithUsers : (conn.visibility === 'shared_users' || conn.visibility === 'shared_all');
        const admins = next.shareWithAdmins !== undefined ? !!next.shareWithAdmins : (conn.visibility === 'shared_admins' || conn.visibility === 'shared_all');
        next.visibility = users ? (admins ? 'shared_all' : 'shared_users') : (admins ? 'shared_admins' : 'private');
        /* Route changes must not jump the connection onto dependencies the
         * editor may not use (§13.1). */
        this._assertDependenciesUsable(user, next);
        next.updatedAt = Date.now();
        next.revision = Math.max(1, Number(conn.revision) || 1) + 1;
        const saved = this.storage.updateConnectionRow(next);
        this.authz.audit({ actorUserId: user.userId, resourceType: 'connection', resourceId: id, action: 'resource.update', outcome: 'success', metadata: { name: saved.name } });
        return this._toPublicConnection(user, saved);
    }

    deleteConnection(user, id, mutationContext = {}) {
        const before = this.storage.getConnectionById(id);
        return this._runMobileMutation({
            entityType: 'connection', entityId: id, action: 'delete', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => this._deleteConnection(user, id));
    }

    _deleteConnection(user, id) {
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
     * Authorize and freeze the complete route used by /api/connections/test.
     *
     * A shared `use` grant authorizes the saved endpoint, not an arbitrary
     * caller-supplied endpoint that happens to reuse the owner's credentials.
     * Owners/admins may test edits before saving them, while draft tests must
     * hold `use` on every referenced dependency themselves.
     */
    resolveForConnectionTest(user, candidate, { savedConnectionId = null } = {}) {
        const saved = savedConnectionId
            ? this.storage.getConnectionById(String(savedConnectionId))
            : null;
        if (savedConnectionId) {
            this.authz.assertCan(
                user,
                CAP.USE,
                'connection',
                String(savedConnectionId),
                saved || { ownerUserId: '' },
                { resourceExists: !!saved },
            );
        }

        const connection = {
            ...(candidate || {}),
            ...(saved ? {
                id: saved.id,
                ownerUserId: saved.ownerUserId,
                createdByUserId: saved.createdByUserId,
            } : {
                ownerUserId: user.userId,
                createdByUserId: user.userId,
            }),
        };
        const privilegedOverride = !!saved
            && (saved.ownerUserId === user.userId || user.role === 'admin');
        const routeChanged = !!saved && this._connectionTestRouteFingerprint(saved)
            !== this._connectionTestRouteFingerprint(connection);
        if (routeChanged && !privilegedOverride) {
            throw new HttpError(
                403,
                'connection_test_override_forbidden',
                'The saved connection target or route cannot be overridden',
                false,
            );
        }

        /* Only an unchanged shared connection may inherit its owner's bound
         * dependency graph. Drafts and privileged previews authorize every
         * dependency against the requesting account. */
        const boundOwnerUserId = saved && !privilegedOverride && !routeChanged
            ? saved.ownerUserId
            : null;
        const routePlan = this._resolveConnectionTestRoute(user, connection, { boundOwnerUserId });
        if (saved) {
            this.authz.audit({
                actorUserId: user.userId,
                resourceType: 'connection',
                resourceId: saved.id,
                action: 'resource.use',
                outcome: 'success',
                metadata: { host: connection.host, port: connection.port, protocol: connection.protocol, purpose: 'test' },
            });
        }
        return { connection: routePlan.target, routePlan };
    }

    _normalizeConnectionTestJumpIds(connOrValue) {
        const value = Array.isArray(connOrValue) || typeof connOrValue === 'string'
            ? connOrValue
            : connOrValue?.jumpHostIds;
        let ids = [];
        if (Array.isArray(value)) ids = value;
        else if (typeof value === 'string' && value.trim()) {
            try {
                const parsed = JSON.parse(value);
                ids = Array.isArray(parsed) ? parsed : value.split(',');
            } catch {
                ids = value.split(',');
            }
        }
        if (!ids.length && connOrValue?.jumpHostId) ids = [connOrValue.jumpHostId];
        return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
    }

    _connectionTestRouteFingerprint(conn) {
        return JSON.stringify({
            host: String(conn?.host || ''),
            port: Number(conn?.port) || 0,
            protocol: String(conn?.protocol || 'SSH').toUpperCase(),
            connectionMode: ['direct', 'proxy', 'jump'].includes(conn?.connectionMode)
                ? conn.connectionMode
                : 'direct',
            proxyId: String(conn?.proxyId || ''),
            jumpHostIds: this._normalizeConnectionTestJumpIds(conn),
            sshKeyId: String(conn?.sshKeyId || ''),
        });
    }

    _connectionTestDependencyUnavailable() {
        return new HttpError(
            403,
            'connection_test_dependency_unavailable',
            'A connection test dependency is unavailable',
            false,
        );
    }

    _assertConnectionTestDependency(user, resourceType, dependency, boundOwnerUserId) {
        if (!dependency) throw this._connectionTestDependencyUnavailable();
        if (boundOwnerUserId && dependency.ownerUserId === boundOwnerUserId) return dependency;
        if (!this.authz.can(user, CAP.USE, resourceType, dependency.id, dependency)) {
            throw this._connectionTestDependencyUnavailable();
        }
        return dependency;
    }

    _resolveConnectionTestRoute(user, candidate, { boundOwnerUserId = null } = {}) {
        const MAX_GRAPH_DEPTH = 8;
        const MAX_GRAPH_NODES = 32;
        const MAX_GRAPH_WORK = 64;
        const connections = new Map(this.storage.listAllConnectionRows().map((conn) => [String(conn.id), conn]));
        const jumpHosts = new Map(this.storage.listJumpHosts().map((jump) => [String(jump.id), jump]));
        const resolving = new Set();
        const resolvedConnections = new Map();
        const graphNodes = new Set();
        let graphWork = 0;

        const invalidRoute = () => new HttpError(
            400,
            'connection_test_invalid_route',
            'The connection test route is invalid',
            false,
        );
        const resolveConnection = (input, identity, depth = 0) => {
            const nodeIdentity = String(identity || input?.id || 'draft');
            graphWork += 1;
            if (depth > MAX_GRAPH_DEPTH || graphWork > MAX_GRAPH_WORK) throw invalidRoute();
            if (resolving.has(nodeIdentity)) throw invalidRoute();
            if (resolvedConnections.has(nodeIdentity)) return resolvedConnections.get(nodeIdentity);
            graphNodes.add(nodeIdentity);
            if (graphNodes.size > MAX_GRAPH_NODES) throw invalidRoute();
            resolving.add(nodeIdentity);
            try {
                const resolved = { ...input };
                if (resolved.sshKeyId) {
                    const key = this._assertConnectionTestDependency(
                        user,
                        'sshKey',
                        this.storage.getSshKeyRaw(String(resolved.sshKeyId)),
                        boundOwnerUserId,
                    );
                    if (!resolved.privateKey || resolved.privateKey === '******') resolved.privateKey = key.privateKey || '';
                    if ((!resolved.password || resolved.password === '******') && key.passphrase) resolved.password = key.passphrase || '';
                }

                const mode = ['direct', 'proxy', 'jump'].includes(resolved.connectionMode)
                    ? resolved.connectionMode
                    : 'direct';
                resolved.connectionMode = mode;
                let proxy = null;
                const hops = [];
                if (mode === 'proxy') {
                    if (!resolved.proxyId) throw this._connectionTestDependencyUnavailable();
                    proxy = this._assertConnectionTestDependency(
                        user,
                        'proxy',
                        this.storage.getProxyRaw(String(resolved.proxyId)),
                        boundOwnerUserId,
                    );
                } else if (mode === 'jump') {
                    const jumpIds = this._normalizeConnectionTestJumpIds(resolved);
                    if (!jumpIds.length || jumpIds.length > 8) throw invalidRoute();
                    resolved.jumpHostIds = jumpIds;
                    resolved.jumpHostId = jumpIds[0] || null;
                    const hopConnectionIds = new Set();
                    for (const jumpId of jumpIds) {
                        const jump = jumpHosts.get(jumpId) || null;
                        if (jump) this._assertConnectionTestDependency(user, 'jumpHost', jump, boundOwnerUserId);
                        const hopConnectionId = String(jump?.connectionId || jumpId);
                        const hopRaw = connections.get(hopConnectionId) || null;
                        this._assertConnectionTestDependency(user, 'connection', hopRaw, boundOwnerUserId);
                        if (hopConnectionIds.has(hopConnectionId)) throw invalidRoute();
                        hopConnectionIds.add(hopConnectionId);
                        if (String(hopRaw.protocol || 'SSH').toUpperCase() !== 'SSH') throw invalidRoute();
                        const hop = resolveConnection(hopRaw, hopConnectionId, depth + 1);
                        hops.push({
                            ...hop.connection,
                            routeName: jump?.name || hop.connection.name || hop.connection.host,
                            jumpHostConfigId: jump?.id || null,
                        });
                    }
                }
                const result = { connection: resolved, proxy, hops };
                resolvedConnections.set(nodeIdentity, result);
                return result;
            } finally {
                resolving.delete(nodeIdentity);
            }
        };

        const top = resolveConnection(candidate, candidate?.id || 'draft');
        const firstProxy = top.connection.connectionMode === 'proxy'
            ? top.proxy
            : (top.hops[0]?.connectionMode === 'proxy'
                ? resolveConnection(connections.get(String(top.hops[0].id)), String(top.hops[0].id), 1).proxy
                : null);
        return { target: top.connection, hops: top.hops, firstProxy };
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

    createOwned(user, resourceType, data, mutationContext = {}) {
        return this._runMobileMutation({
            entityType: resourceType, entityId: data.id, action: 'upsert', user, before: null,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
            forceChange: mutationContext.forceMobileChange === true,
            changedSecretFields: mutationContext.changedSecretFields,
        }, () => this._createOwned(user, resourceType, data));
    }

    _createOwned(user, resourceType, data) {
        const payload = { ...data, ownerUserId: user.userId, visibility: 'private' };
        let saved;
        if (resourceType === 'proxy') saved = this.storage.saveProxy(payload);
        else if (resourceType === 'sshKey') saved = this.storage.saveSshKey(payload);
        else if (resourceType === 'jumpHost') saved = this.storage.saveJumpHost(payload);
        else throw new HttpError(400, 'invalid_resource_type', '未知资源类型');
        this.authz.audit({ actorUserId: user.userId, resourceType, resourceId: data.id, action: 'resource.create', outcome: 'success', metadata: { name: data.name || '' } });
        return saved;
    }

    updateOwned(user, resourceType, id, data, mutationContext = {}) {
        const before = this.getRawAuthorized(user, resourceType, id, CAP.EDIT);
        return this._runMobileMutation({
            entityType: resourceType, entityId: id, action: 'upsert', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
            forceChange: mutationContext.forceMobileChange === true,
            changedSecretFields: mutationContext.changedSecretFields,
        }, () => this._updateOwned(user, resourceType, id, data));
    }

    _updateOwned(user, resourceType, id, data) {
        const current = this.getRawAuthorized(user, resourceType, id, CAP.EDIT);
        const revision = ['proxy', 'sshKey', 'jumpHost'].includes(resourceType) ? Math.max(1, Number(current.revision) || 1) + 1 : undefined;
        const payload = {
            ...current,
            ...data,
            id,
            ...(revision ? { revision } : {}),
            ownerUserId: current.ownerUserId || user.userId,
            visibility: current.visibility || 'private',
            createdAt: current.createdAt,
        };
        let saved;
        if (resourceType === 'proxy') saved = this.storage.saveProxy(payload);
        else if (resourceType === 'sshKey') saved = this.storage.saveSshKey(payload);
        else if (resourceType === 'jumpHost') saved = this.storage.saveJumpHost(payload);
        else throw new HttpError(400, 'invalid_resource_type', '未知资源类型');
        this.authz.audit({ actorUserId: user.userId, resourceType, resourceId: id, action: 'resource.update', outcome: 'success', metadata: { name: saved.name || '' } });
        return saved;
    }

    deleteOwned(user, resourceType, id, mutationContext = {}) {
        const before = this.getRawAuthorized(user, resourceType, id, CAP.DELETE);
        return this._runMobileMutation({
            entityType: resourceType, entityId: id, action: 'delete', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => this._deleteOwned(user, resourceType, id));
    }

    _deleteOwned(user, resourceType, id) {
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
