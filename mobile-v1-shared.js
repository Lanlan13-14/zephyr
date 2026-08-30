/**
 * Shared-to-me resources for /api/mobile/v1.
 *
 * SHARED_RESOURCE_RESIDENCY.md is unusually strict, and the strictness is the
 * whole point of a separate module:
 *
 *   - Shared resources never enter the mobile mirror. They are not in
 *     /sync/bootstrap, /sync/changes or /sync/push, so this file is the only
 *     way a device can see them at all, and every read is a fresh online
 *     authorization rather than a cache lookup.
 *   - `use` never implies `revealSecret`. A shared connection may be opened
 *     on the user behalf without the device ever being entitled to the stored
 *     password as editable data.
 *   - 404 merges `does not exist` with `you may not see it`, so a device
 *     cannot enumerate another account resources by probing ids.
 *
 * Only `relay-strict` remains: the credential never leaves the main end and
 * only session traffic is forwarded. The historical `direct-ephemeral` mode
 * is retired because it violated the zero-residency rule.
 */
'use strict';

const crypto = require('crypto');

const mobileCrypto = require('./mobile-v1-crypto');
const { MobileStoreError } = require('./mobile-v1-store');

/** Types the frozen SharedResourceSummary enum allows. */
const SHARED_TYPES = ['connection', 'proxy', 'sshKey', 'jumpHost', 'note', 'file', 'docker'];

/** Purposes a shared use envelope may carry (SharedUseEnvelope.purpose enum). */
const SHARED_PURPOSES = ['ssh', 'telnet', 'rdp', 'vnc'];

const CHANNELS = ['terminal', 'clipboard', 'audio', 'drive', 'microphone', 'camera', 'location'];

/**
 * Keys that must never appear inside a decrypted shared payload.
 *
 * Frozen by contracts/test-vectors/shared-use-v1.json `forbiddenPayloadKeys`.
 * Asserted on the way out rather than merely documented: a future edit that
 * widens the projection should fail loudly here instead of shipping a leak.
 */
const FORBIDDEN_PAYLOAD_KEYS = [
    'clientToken', 'aiProviderApiKey', 'aiEnvValue',
    'serverDataKey', 'ownerSid', 'refreshCredential',
];

/** A session grant outlives one relay attach so a dropped socket can be re-established. */
const SESSION_TTL_MS = 10 * 60 * 1000;

/* Zft2Contract.MAX_INFLIGHT_DEFAULT / a chunk the gateway already accepts. */
const ZFT2_MAX_INFLIGHT = 8;
const ZFT2_CHUNK_BYTES = 262144;

/* A relay credential lives only long enough to open the socket. The session
 * grant itself is what bounds the conversation; this token only proves that the
 * bearer is the device the grant was minted for. */
const RELAY_CREDENTIAL_TTL_MS = 60 * 1000;
const RELAY_NAMESPACE = 'shared-relay-v1';
const MAX_RELAY_ATTACHES_PER_SESSION = 1;

/* Methods are wrapped once and fan out to every SharedResourceApi using the
 * same service instance. Symbols keep the hook private and avoid collisions
 * with service state restored through Object.assign during database reopen. */
const REVOCATION_HOOKS = Symbol('mobile-v1-shared-revocation-hooks');
const REVOCATION_WRAPPED = Symbol('mobile-v1-shared-revocation-wrapped');

const FILE_LEASE_TTL_SEC = 300;

function nowMs() { return Date.now(); }

function protocolPurpose(protocol) {
    const value = String(protocol || '').toLowerCase();
    return SHARED_PURPOSES.includes(value) ? value : null;
}

/**
 * Observes a successful mutation without changing the service public API.
 *
 * MobileV1Api is constructed after the canonical services, so this is the one
 * place that can connect their revoke operations to ephemeral shared sessions
 * without making those services depend on the mobile module. The wrapper is
 * installed once; subsequent API instances only add another subscriber.
 */
function subscribeMutation(target, methodName, subscriber, describe) {
    if (!target || typeof target[methodName] !== 'function') return;
    if (!Object.prototype.hasOwnProperty.call(target, REVOCATION_HOOKS)) {
        Object.defineProperty(target, REVOCATION_HOOKS, { value: new Map(), configurable: false });
        Object.defineProperty(target, REVOCATION_WRAPPED, { value: new Set(), configurable: false });
    }
    let subscribers = target[REVOCATION_HOOKS].get(methodName);
    if (!subscribers) {
        subscribers = new Set();
        target[REVOCATION_HOOKS].set(methodName, subscribers);
    }
    subscribers.add(subscriber);
    if (target[REVOCATION_WRAPPED].has(methodName)) return;

    const original = target[methodName];
    Object.defineProperty(target, methodName, {
        configurable: true,
        writable: true,
        value: function sharedRevocationObservedMutation(...args) {
            const result = original.apply(this, args);
            const notify = (value) => {
                const event = describe(args, value);
                if (event) {
                    for (const listener of [...subscribers]) {
                        try { listener(event); } catch {}
                    }
                }
                return value;
            };
            return result && typeof result.then === 'function' ? result.then(notify) : notify(result);
        },
    });
    target[REVOCATION_WRAPPED].add(methodName);
}

/**
 * Shared resources are online-only, so every response must be uncacheable.
 *
 * A revoked grant has to take effect on the next request; a cached 200 would
 * keep a revoked resource visible for the lifetime of the cache entry.
 */
function noStore(res) {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    return res;
}

/**
 * In-memory session registry.
 *
 * Deliberately not a table. A shared session is by definition ephemeral, and
 * persisting it would create exactly the durable shared-resource record the
 * residency contract forbids. A process restart therefore invalidates every
 * shared session, which is the correct failure direction.
 */
class SharedSessionRegistry {
    constructor() {
        this.sessions = new Map();
        this.listeners = new Map();
    }

    create(entry) {
        const sessionId = 'shs-' + crypto.randomBytes(16).toString('hex');
        this.sessions.set(sessionId, {
            ...entry,
            sessionId,
            createdAt: nowMs(),
            /* Every clientNonce this session has already sealed against.
             *
             * shared-use-v1.json lists the `replay` case as
             * `none_second_consume -> shared_session_consumed`: a captured
             * response must not be re-obtainable by sending the same nonce
             * again. Tracking the nonce rather than a single consumed flag is
             * what still allows the legitimate retry path in
             * SHARED_RESOURCE_RESIDENCY.md 3.2, where a failed handshake
             * re-seals under a *fresh* nonce inside the same grant. */
            usedNonces: new Set(),
            usedAttachJtis: new Set(),
            activeAttachIds: new Set(),
            relayCredentialGeneration: 0,
        });
        return sessionId;
    }

    /**
     * Records one nonce as spent.
     *
     * @returns {boolean} false when this nonce was already used for this
     * session, which the caller must surface as `shared_session_consumed`
     * rather than re-sealing the same material.
     */
    consumeNonce(sessionId, nonce) {
        const entry = this.sessions.get(String(sessionId || ''));
        if (!entry) return false;
        const key = String(nonce || '');
        if (entry.usedNonces.has(key)) return false;
        /* Bounded so a client cannot grow the set without limit inside one
         * grant; the cap is far above any plausible handshake retry count. */
        if (entry.usedNonces.size >= 64) return false;
        entry.usedNonces.add(key);
        return true;
    }

    get(sessionId) {
        this.gc();
        return this.sessions.get(String(sessionId || '')) || null;
    }

    drop(sessionId, reason = 'revoked') {
        const id = String(sessionId || '');
        const entry = this.sessions.get(id);
        if (!entry || !this.sessions.delete(id)) return false;
        const listeners = this.listeners.get(id);
        this.listeners.delete(id);
        if (listeners) {
            for (const listener of [...listeners]) {
                try { listener({ sessionId: id, reason }); } catch {}
            }
        }
        return true;
    }

    /** Every session belonging to a device, used when a device is revoked. */
    dropForDevice(deviceId, reason = 'device-revoked') {
        return this.dropMatching((entry) => entry.deviceId === String(deviceId || ''), reason);
    }

    dropForUser(userId, reason = 'account-revoked') {
        const id = String(userId || '');
        return this.dropMatching((entry) => entry.userId === id || entry.ownerUserId === id, reason);
    }

    dropForToken(tokenId, reason = 'backing-token-revoked') {
        return this.dropMatching((entry) => entry.backingTokenId === String(tokenId || ''), reason);
    }

    dropForGrant(resourceType, resourceId, subjectId, reason = 'acl-revoked') {
        return this.dropMatching((entry) => (
            (
                (entry.resourceType === String(resourceType || '')
                    && entry.resourceId === String(resourceId || ''))
                || (entry.dependencyRefs || []).some((dependency) => (
                    dependency.resourceType === String(resourceType || '')
                    && dependency.resourceId === String(resourceId || '')
                ))
            )
            && (!subjectId || entry.userId === String(subjectId))
        ), reason);
    }

    dropMatching(predicate, reason = 'revoked') {
        let removed = 0;
        for (const [id, entry] of [...this.sessions]) {
            if (predicate(entry) && this.drop(id, reason)) removed += 1;
        }
        return removed;
    }

    subscribe(sessionId, listener) {
        const id = String(sessionId || '');
        if (!this.sessions.has(id)) {
            listener({ sessionId: id, reason: 'session-missing' });
            return () => {};
        }
        let listeners = this.listeners.get(id);
        if (!listeners) {
            listeners = new Set();
            this.listeners.set(id, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.listeners.delete(id);
        };
    }

    mintRelayClaim(sessionId) {
        const entry = this.sessions.get(String(sessionId || ''));
        if (!entry) return null;
        entry.relayCredentialGeneration += 1;
        return {
            jti: crypto.randomUUID(),
            attachGeneration: entry.relayCredentialGeneration,
        };
    }

    reserveRelayAttach(sessionId, jti, attachGeneration, limit = MAX_RELAY_ATTACHES_PER_SESSION) {
        const entry = this.sessions.get(String(sessionId || ''));
        if (!entry) return { ok: false, code: 'shared_session_expired' };
        const id = String(jti || '');
        if (!id || entry.usedAttachJtis.has(id)) return { ok: false, code: 'shared_session_consumed' };
        if (Number(attachGeneration) !== Number(entry.relayCredentialGeneration)) {
            return { ok: false, code: 'shared_session_consumed' };
        }
        if (entry.activeAttachIds.size >= limit) return { ok: false, code: 'shared_session_consumed' };

        /* This synchronous check-and-add is the atomic consume point. Node runs
         * this block without an await, so two upgrade callbacks cannot both
         * observe the jti as unused or the slot as free. */
        entry.usedAttachJtis.add(id);
        const attachId = 'sha-' + crypto.randomUUID();
        entry.activeAttachIds.add(attachId);
        return { ok: true, attachId };
    }

    releaseRelayAttach(sessionId, attachId) {
        const entry = this.sessions.get(String(sessionId || ''));
        return !!entry && entry.activeAttachIds.delete(String(attachId || ''));
    }

    gc() {
        const ts = nowMs();
        for (const [id, entry] of [...this.sessions]) {
            if (Number(entry.sessionExpiresAt) <= ts) this.drop(id, 'session-expired');
        }
    }

    get size() { return this.sessions.size; }
}

/**
 * Read-only online projection plus session brokering for shared resources.
 *
 * Holds no state beyond the ephemeral session registry: every method starts
 * from the live ACL, so a revoke takes effect on the very next call.
 */
class SharedResourceApi {
    constructor(opts) {
        this.storage = opts.storage;
        this.authz = opts.authz;
        this.resourceService = opts.resourceService;
        this.notesService = opts.notesService;
        this.sharingService = opts.sharingService;
        this.fileAgentManager = opts.fileAgentManager || null;
        this.store = opts.store;
        this.serverEncryptionKey = opts.serverEncryptionKey;
        this.log = opts.log || (() => {});
        /* Injected rather than imported: the relay transport lives in server.js
         * next to the existing ssh2 routing helpers, and this module must stay
         * testable without opening real sockets. `null` means the transport is
         * not mounted, and that is reported honestly instead of downgrading a
         * relay-strict request to direct. */
        this.relayMount = opts.relayMount || null;
        this.maxRelayAttachesPerSession = Math.max(
            1,
            Math.min(8, Number(opts.maxRelayAttachesPerSession) || MAX_RELAY_ATTACHES_PER_SESSION),
        );
        this.sessions = new SharedSessionRegistry();
        /* leaseId -> lease. In-process by design: a file lease is valid for
         * 5 minutes and must not survive a restart, because the SAF grant
         * backing it on the device does not survive one either. */
        this.leases = new Map();
        this.installRevocationHooks();
    }

    /** Connects canonical revoke operations to one fail-closed session hook. */
    installRevocationHooks() {
        const onRevoke = (event) => this.revokeSessions(event);

        subscribeMutation(this.authz, 'revoke', onRevoke, ([input], changed) => (
            changed ? {
                kind: 'grant',
                resourceType: input && input.resourceType,
                resourceId: input && input.resourceId,
                subjectId: input && input.subjectId,
                reason: 'acl-revoked',
            } : null
        ));
        /* Replacing an ACL can remove a live channel even when `use` remains,
         * so every successful grant replacement terminates old sessions. */
        subscribeMutation(this.authz, 'grant', onRevoke, ([input]) => ({
            kind: 'grant',
            resourceType: input && input.resourceType,
            resourceId: input && input.resourceId,
            subjectId: input && input.subjectId,
            reason: 'acl-changed',
        }));
        subscribeMutation(this.authz, 'revokeAllForResource', onRevoke, ([resourceType, resourceId], changed) => (
            Number(changed) > 0 ? { kind: 'resource', resourceType, resourceId, reason: 'acl-revoked' } : null
        ));

        subscribeMutation(this.store, 'revokeDevice', onRevoke, (args, changed) => (
            changed ? { kind: 'device', deviceId: args[1], reason: 'device-revoked' } : null
        ));
        subscribeMutation(this.store, 'rotateRefresh', onRevoke, ([deviceId], value) => (
            value ? { kind: 'device', deviceId, reason: 'device-generation-changed' } : null
        ));
        subscribeMutation(this.store, 'bindDevice', onRevoke, ([input], value) => (
            value ? { kind: 'device', deviceId: input && input.deviceId, reason: 'device-generation-changed' } : null
        ));
        subscribeMutation(this.store, 'patchDevice', onRevoke, ([, deviceId, patch], value) => (
            value && patch && patch.enabled === false
                ? { kind: 'device', deviceId, reason: 'device-disabled' }
                : null
        ));

        subscribeMutation(this.fileAgentManager, 'deleteToken', onRevoke, ([ownerName, tokenId]) => ({
            kind: 'token', ownerName, tokenId, reason: 'backing-token-revoked',
        }));
        subscribeMutation(this.fileAgentManager, 'regenerateTokenRecord', onRevoke, ([ownerName, tokenId]) => ({
            kind: 'token', ownerName, tokenId, reason: 'backing-token-rotated',
        }));
        subscribeMutation(this.fileAgentManager, 'regenerateToken', onRevoke, ([ownerName]) => ({
            kind: 'account-token', ownerName, reason: 'backing-tokens-reset',
        }));
        subscribeMutation(this.fileAgentManager, 'createToken', onRevoke, ([ownerName]) => ({
            /* reset-all deletes records directly, then creates the replacement.
             * Reconcile here so only sessions whose backing id disappeared are
             * dropped; ordinary token creation leaves live sessions alone. */
            kind: 'token-registry', ownerName, reason: 'backing-token-revoked',
        }));

        subscribeMutation(this.storage, 'updateUserById', onRevoke, ([userId, patch], value) => (
            value && patch && patch.status && patch.status !== 'active'
                ? { kind: 'account', userId, reason: 'account-unavailable' }
                : null
        ));

        if (this.sharingService && typeof this.sharingService.setRevocationHook === 'function') {
            this.sharingService.setRevocationHook(onRevoke);
        }
    }

    revokeSessions(event = {}) {
        if (event.kind === 'device') {
            this.dropLeasesForDevice(String(event.deviceId || ''));
            return this.sessions.dropForDevice(event.deviceId, event.reason);
        }
        if (event.kind === 'token') return this.sessions.dropForToken(event.tokenId, event.reason);
        if (event.kind === 'account-token') {
            return this.sessions.dropMatching(
                (entry) => entry.backingTokenOwner === String(event.ownerName || ''),
                event.reason,
            );
        }
        if (event.kind === 'token-registry') {
            let liveIds = new Set();
            try {
                liveIds = new Set(
                    (this.fileAgentManager?.listTokens(String(event.ownerName || '')) || [])
                        .map((token) => String(token.id || '')),
                );
            } catch {
                /* Registry I/O failures are handled by the watchdog. Do not
                 * misreport a temporary read failure as a token revoke. */
                return 0;
            }
            return this.sessions.dropMatching(
                (entry) => entry.backingTokenOwner === String(event.ownerName || '')
                    && !liveIds.has(entry.backingTokenId),
                event.reason,
            );
        }
        if (event.kind === 'account') {
            this.dropLeasesForUser(String(event.userId || ''));
            return this.sessions.dropForUser(event.userId, event.reason);
        }
        if (event.kind === 'grant') {
            return this.sessions.dropForGrant(
                event.resourceType,
                event.resourceId,
                event.subjectId,
                event.reason,
            );
        }
        if (event.kind === 'resource') {
            return this.sessions.dropForGrant(event.resourceType, event.resourceId, '', event.reason);
        }
        return 0;
    }

    // ------------------------------------------------------------ listing ---

    /**
     * Rows shared *to* this user, never rows the user owns.
     *
     * Owned rows are excluded because they already travel through the mirror;
     * returning them here as well would give the client two disagreeing
     * sources for the same entity.
     */
    listShared(user, { resourceType = null } = {}) {
        const grants = this.authz.listSubjectGrants(user.userId, { resourceType });
        const items = [];

        for (const grant of grants) {
            if (!SHARED_TYPES.includes(grant.resourceType)) continue;
            const projected = this.projectSummary(user, grant);
            if (projected) items.push(projected);
        }
        /* The frozen response is { items, nextPageToken }, not a bare array and
         * not the { ok, resources } shape the hand-written client DTO expects.
         * nextPageToken is always present and always null here: the whole grant
         * set for one account is small and is recomputed per request, and a
         * stable cursor would be a cache of authorisation state - exactly what
         * SHARED_RESOURCE_RESIDENCY.md 2.2 forbids. */
        return { items, nextPageToken: null };
    }

    activeOwner(raw) {
        const ownerUserId = String(raw?.ownerUserId || raw?.owner_user_id || '').trim();
        if (!ownerUserId) return null;
        try {
            const owner = this.storage.getUserById(ownerUserId);
            return owner?.status === 'active' ? owner : null;
        } catch {
            return null;
        }
    }

    /** Summary for one grant, or null when the row is gone or self-owned. */
    projectSummary(user, grant) {
        const raw = this.rawResource(grant.resourceType, grant.resourceId);
        if (!raw) return null;
        const ownerUserId = String(raw.ownerUserId || raw.owner_user_id || '');
        if (ownerUserId === user.userId) return null;

        const owner = this.activeOwner(raw);
        if (!owner) return null;
        if (grant.resourceType === 'connection' && !protocolPurpose(raw.protocol)) return null;
        return {
            resourceType: grant.resourceType,
            resourceId: grant.resourceId,
            displayName: String(raw.name || raw.title || grant.resourceId),
            /* Display name only. The owner userId is an internal identifier and
             * is not the sharee business. */
            ownerDisplayName: String((owner && owner.username) || ''),
            capabilities: grant.capabilities.slice().sort(),
            revision: Math.max(1, Number(raw.revision) || 1),
            expiresAt: grant.expiresAt == null ? null : Number(grant.expiresAt),
        };
    }

    /** Raw row for any shareable type, or null. */
    rawResource(resourceType, resourceId) {
        const id = String(resourceId || '');
        try {
            if (resourceType === 'connection') return this.storage.getConnectionById(id);
            if (resourceType === 'proxy') return this.storage.getProxyRaw(id);
            if (resourceType === 'sshKey') return this.storage.getSshKeyRaw(id);
            if (resourceType === 'jumpHost') {
                return (this.storage.listJumpHosts() || []).find((row) => row.id === id) || null;
            }
            if (resourceType === 'note' && this.notesService) {
                const row = this.notesService.stmtGet ? this.notesService.stmtGet.get(id) : null;
                if (!row || row.deleted_at || row.deletedAt) return null;
                const raw = {
                    id: row.note_id,
                    title: row.title,
                    ownerUserId: row.owner_user_id,
                    revision: Number(row.revision) || 1,
                };
                return this.activeOwner(raw) ? raw : null;
            }
        } catch (err) {
            this.log('[mobile-v1] shared resource read failed', { resourceType, error: err.message });
        }
        return null;
    }

    /**
     * Detail view, rechecking the live ACL.
     *
     * Throws the merged 404 for both `no such row` and `not shared with you`,
     * which is what stops id enumeration.
     */
    getShared(user, resourceType, resourceId) {
        if (!SHARED_TYPES.includes(resourceType)) {
            throw new MobileStoreError('unsupported_scope', '\u4e0d\u652f\u6301\u7684\u5171\u4eab\u8d44\u6e90\u7c7b\u578b', 400);
        }
        const raw = this.rawResource(resourceType, resourceId);
        const ownerUserId = raw ? String(raw.ownerUserId || raw.owner_user_id || '') : '';

        /* An owned row is not a shared row. Serving it here would make the
         * shared surface a second read path for mirrored data. */
        if (!raw || ownerUserId === user.userId) throw this.notFound();
        const owner = this.activeOwner(raw);
        if (!owner) throw this.notFound();

        const caps = this.authz.effectiveCapabilities(user, resourceType, resourceId, {
            ownerUserId,
            visibility: raw.visibility,
        });
        if (!caps.has('view') && !caps.has('use')) throw this.notFound();

        const detail = {
            resourceType,
            resourceId: String(resourceId),
            displayName: String(raw.name || raw.title || resourceId),
            ownerDisplayName: String((owner && owner.username) || ''),
            capabilities: [...caps].sort(),
            revision: Math.max(1, Number(raw.revision) || 1),
        };

        if (resourceType === 'connection') {
            /* Non-secret connect metadata only. A sharee needs to recognise the
             * host and know which protocol to open; the credential is resolved
             * server-side at session time and never appears here. */
            detail.protocol = String(raw.protocol || '');
            detail.host = String(raw.host || '');
            detail.port = Number(raw.port) || 0;
            detail.username = String(raw.username || '');
            /* Direct use is retired: only relay-strict remains. */
        }
        if (resourceType === 'note' && this.notesService) {
            /* Body is fetched through invoke(read), never inlined into the
             * directory response: the viewer must be an explicit online read so
             * a revoke between listing and opening is honoured. */
            detail.hasContent = true;
        }
        this.assertNoForbiddenKeys(detail);
        return detail;
    }

    notFound() {
        /* One code for both cases, deliberately. */
        return new MobileStoreError(
            'resource_not_found_or_inaccessible',
            '\u8d44\u6e90\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u8bbf\u95ee',
            404,
        );
    }


    // ----------------------------------------------------------- sessions ---

    connectionDependencyRefs(connection) {
        const refs = [];
        const add = (resourceType, resourceId) => {
            const id = String(resourceId || '');
            if (id && !refs.some((ref) => ref.resourceType === resourceType && ref.resourceId === id)) {
                refs.push({ resourceType, resourceId: id });
            }
        };
        add('sshKey', connection.sshKeyId);
        if (connection.connectionMode === 'proxy') add('proxy', connection.proxyId);
        if (connection.connectionMode === 'jump') {
            const jumpHosts = this.storage.listJumpHosts ? this.storage.listJumpHosts() : [];
            for (const jumpId of (Array.isArray(connection.jumpHostIds) ? connection.jumpHostIds : [])) {
                add('jumpHost', jumpId);
                const jump = jumpHosts.find((row) => row.id === jumpId);
                if (jump && jump.connectionId) add('connection', jump.connectionId);
            }
        }
        return refs;
    }

    /**
     * Opens a session against a shared connection.
     *
     * The decision order matters and follows SHARED_RESOURCE_RESIDENCY.md 3.1:
     * capability first, then server-side dependency resolution (which is where
     * a proxy or SSH key the sharee may not use becomes a 403), then mode.
     *
     * `relay-strict` is the safe default. Direct requires revealSecret plus a
     * separate sensitive approval or owner policy; a client asking for direct
     * without both gates receives relay and no secret.
     */
    openConnectionSession(user, deviceRow, connectionId, request) {
        const clientNonce = String(request.clientSessionNonce || '');
        if (clientNonce.length < 22 || clientNonce.length > 120) {
            throw new MobileStoreError('invalid_request', 'clientSessionNonce \u957f\u5ea6\u65e0\u6548', 400);
        }
        const requestedChannels = Array.isArray(request.requestedChannels) ? request.requestedChannels.map(String) : [];
        for (const channel of requestedChannels) {
            if (!CHANNELS.includes(channel)) {
                throw new MobileStoreError('invalid_request', '\u672a\u77e5\u901a\u9053 ' + channel, 400, { details: { channel } });
            }
        }

        const conn = this.storage.getConnectionById(String(connectionId || ''));
        const ownerUserId = conn ? String(conn.ownerUserId || '') : '';
        if (!conn || ownerUserId === user.userId) throw this.notFound();

        const caps = this.authz.effectiveCapabilities(user, 'connection', conn.id, conn);
        if (!caps.has('use')) throw this.notFound();

        const purpose = protocolPurpose(conn.protocol);
        if (!purpose) {
            throw new MobileStoreError(
                'unsupported_scope',
                '\u8be5\u534f\u8bae\u4e0d\u652f\u6301\u5171\u4eab\u4f1a\u8bdd',
                400,
                { details: { protocol: String(conn.protocol || '') } },
            );
        }

        /* Server-side dependency resolution, reusing the canonical semantics.
         * This is what turns `the connection is shared but its SSH key is not`
         * into a 403 instead of a session that fails at handshake time. */
        let resolved;
        try {
            resolved = this.resourceService.resolveForConnect(user, conn.id);
        } catch (err) {
            /* Dependency ACL failures are already structured; anything else
             * must not be reported as if the resource were missing. */
            throw new MobileStoreError(
                err.code || 'forbidden_resource_use',
                err.message || '\u65e0\u6743\u4f7f\u7528\u8be5\u5171\u4eab\u8fde\u63a5',
                err.status || 403,
            );
        }

        const grantedChannels = requestedChannels.filter((channel) => this.channelAllowed(channel, caps));
        const sessionExpiresAt = nowMs() + SESSION_TTL_MS;
        const revision = Math.max(1, Number(conn.revision) || 1);

        const sessionId = this.sessions.create({
            userId: user.userId,
            deviceId: deviceRow.device_id,
            deviceGeneration: Number(deviceRow.refresh_generation || 1),
            backingTokenId: String(deviceRow.token_id || ''),
            backingTokenOwner: String(user.username || ''),
            ownerUserId,
            resourceType: 'connection',
            resourceId: conn.id,
            dependencyRefs: this.connectionDependencyRefs(conn),
            revision,
            purpose,
            mode: 'relay-strict',
            capabilities: [...caps].sort(),
            channels: grantedChannels,
            sessionExpiresAt,
        });

        this.authz.audit({
            actorUserId: user.userId,
            targetUserId: ownerUserId,
            resourceType: 'connection',
            resourceId: conn.id,
            action: 'shared.session.open',
            outcome: 'success',
            /* Mode, device and channels are the security-relevant facts. Host
             * credentials are deliberately absent from the audit record. */
            metadata: { mode: 'relay-strict', deviceId: deviceRow.device_id, channels: grantedChannels },
        });

        const response = {
            sessionId,
            mode: 'relay-strict',
            expiresAt: sessionExpiresAt,
            capabilities: [...caps].sort(),
        };

        /* Relay-unavailable must be explicit; it can never fall back to a
         * secret-bearing direct response. */
        if (!this.relayMount) {
            this.sessions.drop(sessionId, 'relay-unavailable');
            throw new MobileStoreError(
                'shared_relay_unavailable',
                '\u670d\u52a1\u7aef relay \u901a\u9053\u5c1a\u672a\u5b9e\u73b0\uff0c\u65e0\u6cd5\u4ee3\u6267\u884c\u6b64\u5171\u4eab\u8fde\u63a5',
                503,
                { retryable: true, details: { mode: 'relay-strict' } },
            );
        }
        /* No connect material of any kind crosses this boundary. The
         * credential is a signed statement about *who may attach to this
         * session*, and SHARED_RESOURCE_RESIDENCY.md 3.3 is explicit that
         * it is not a Client Token and cannot reach another resource. */
        response.relay = {
            websocketUrl: this.relayMount + '?sessionId=' + encodeURIComponent(sessionId),
            protocol: purpose,
            credential: this.mintRelayCredential(this.sessions.get(sessionId)),
        };
        return response;
    }

    /** A channel is only granted when the ACL actually backs it. */
    channelAllowed(channel, caps) {
        if (channel === 'terminal') return caps.has('use') || caps.has('control');
        if (channel === 'clipboard' || channel === 'audio') return caps.has('control');
        if (channel === 'drive') return caps.has('fileRead') || caps.has('fileWrite');
        /* microphone / camera / location are device-invasive and are never
         * inferred from a resource ACL. */
        return false;
    }

    mintRelayCredential(session) {
        const attach = session && this.sessions.mintRelayClaim(session.sessionId);
        if (!session || !attach) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u5df2\u8fc7\u671f\u6216\u4e0d\u5b58\u5728', 410);
        }
        return this.store.signBlob(
            RELAY_NAMESPACE,
            {
                jti: attach.jti,
                attachGeneration: attach.attachGeneration,
                sessionId: session.sessionId,
                userId: session.userId,
                deviceId: session.deviceId,
                deviceGeneration: session.deviceGeneration,
                backingTokenId: session.backingTokenId,
                resourceId: session.resourceId,
                purpose: session.purpose,
                channels: session.channels || [],
            },
            RELAY_CREDENTIAL_TTL_MS,
        );
    }

    /**
     * Seals the minimum connect material for exactly one handshake.
     *
    /**
     * Re-seals for a retried handshake.
     *
     * A fresh nonce is required rather than optional: reissuing the same
     * ciphertext would make the single-use envelope replayable, and the whole
     * point of the 30 second TTL is that a captured envelope dies with it.
     */
    refreshSession(user, deviceRow, sessionId, clientNonce) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u5df2\u8fc7\u671f\u6216\u4e0d\u5b58\u5728', 410);
        }
        /* Ownership check before anything else: a session id is a bearer-ish
         * string, so it must be bound to both the account and the device. */
        if (session.userId !== user.userId || session.deviceId !== deviceRow.device_id) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u4e0d\u5c5e\u4e8e\u5f53\u524d\u8bbe\u5907', 410);
        }
        if (Number(session.deviceGeneration) !== Number(deviceRow.refresh_generation || 1)
            || session.backingTokenId !== String(deviceRow.token_id || '')) {
            this.sessions.drop(sessionId, 'device-generation-changed');
            throw new MobileStoreError('shared_session_expired', '\u8bbe\u5907\u51ed\u636e\u5df2\u66f4\u65b0', 410);
        }
        const nonce = String(clientNonce || '');
        if (nonce.length < 22) {
            throw new MobileStoreError('invalid_request', 'clientSessionNonce \u957f\u5ea6\u65e0\u6548', 400);
        }

        /* The ACL is rechecked, not trusted from session creation time: a grant
         * revoked one second ago must not be refreshable. */
        const conn = this.storage.getConnectionById(session.resourceId);
        if (!conn) throw this.notFound();
        const caps = this.authz.effectiveCapabilities(user, 'connection', conn.id, conn);
        if (!caps.has('use')) {
            this.sessions.drop(sessionId, 'acl-revoked');
            throw new MobileStoreError('shared_grant_revoked', '\u5171\u4eab\u6388\u6743\u5df2\u88ab\u6536\u56de', 410);
        }
        const response = {
            sessionId: session.sessionId,
            mode: session.mode,
            expiresAt: session.sessionExpiresAt,
            capabilities: [...caps].sort(),
        };
        if (this.relayMount) {
            /* A refresh re-mints the short-lived attach credential without
             * touching the grant, which is what lets a dropped socket be
             * re-established inside the same authorised session. */
            response.relay = {
                websocketUrl: this.relayMount + '?sessionId=' + encodeURIComponent(session.sessionId),
                protocol: session.purpose,
                credential: this.mintRelayCredential(session),
            };
        } else {
            throw new MobileStoreError(
                'shared_relay_unavailable',
                '\u670d\u52a1\u7aef relay \u901a\u9053\u5c1a\u672a\u5b9e\u73b0',
                503,
                { retryable: true },
            );
        }
        return response;
    }

    /** Explicit teardown. Idempotent: closing twice is not an error. */
    closeSession(user, deviceRow, sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && (session.userId !== user.userId || session.deviceId !== deviceRow.device_id)) {
            throw this.notFound();
        }
        if (session) {
            this.sessions.drop(sessionId, 'client-closed');
            this.authz.audit({
                actorUserId: user.userId,
                resourceType: session.resourceType,
                resourceId: session.resourceId,
                action: 'shared.session.close',
                outcome: 'success',
                metadata: { deviceId: deviceRow.device_id },
            });
        }
        /* Idempotent by design: closing an already-closed session is a success,
         * because the client calls this on teardown paths that may race a
         * server-side revoke. The frozen schema is { ok: true }. */
        return { ok: true };
    }

    // ------------------------------------------------------------- invoke ---

    /**
     * Runs one operation against a shared resource on the main end.
     *
     * This is the only way a device reads shared note text: the body is
     * returned in the response and never mirrored, so a revoke between two
     * reads is honoured by the second one failing.
     */
    invokeShared(user, resourceType, resourceId, request) {
        const operation = String(request.operation || '');
        if (!operation) {
            throw new MobileStoreError('invalid_request', 'operation \u5fc5\u586b', 400);
        }
        const args = request.arguments && typeof request.arguments === 'object' ? request.arguments : {};

        if (resourceType === 'note') return this.invokeNote(user, resourceId, operation, args, request);
        throw new MobileStoreError(
            'unsupported_scope',
            '\u8be5\u5171\u4eab\u8d44\u6e90\u7c7b\u578b\u6682\u4e0d\u652f\u6301 invoke',
            400,
            { details: { resourceType, operation } },
        );
    }

    invokeNote(user, noteId, operation, args, request) {
        if (!this.notesService) {
            throw new MobileStoreError('server_unavailable', '\u7b14\u8bb0\u670d\u52a1\u4e0d\u53ef\u7528', 503, { retryable: true });
        }

        /* Do not let legacy share flags or historical ACL rows resurrect a
         * soft-deleted note or a note whose owner account no longer exists.
         * NotesService remains the canonical second authorization check. */
        const raw = this.rawResource('note', noteId);
        if (!raw || String(raw.ownerUserId || '') === user.userId || !this.activeOwner(raw)) {
            throw this.notFound();
        }

        if (operation === 'read') {
            let note;
            try {
                note = this.notesService.get(user, noteId, { includeContent: true });
            } catch (err) {
                /* NotesService already merges missing and inaccessible into a
                 * 404, which is exactly the residency requirement. */
                throw this.notFound();
            }
            if (String(note.ownerUserId || '') === user.userId || !this.activeOwner(note)) throw this.notFound();
            return {
                ok: true,
                revision: Math.max(1, Number(note.revision) || 1),
                result: this.assertNoForbiddenKeys({
                    noteId: String(note.noteId || note.id || noteId),
                    title: String(note.title || ''),
                    content: String(note.content || ''),
                    /* The client needs these to decide whether its AI surface
                     * may touch the note at all. */
                    allowAiRead: !!note.allowAiRead,
                    allowAiWrite: !!note.allowAiWrite,
                }),
            };
        }

        if (operation === 'update') {
            const expectedRevision = Number(request.expectedRevision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
                throw new MobileStoreError('revision_required', '\u66f4\u65b0\u5fc5\u987b\u643a\u5e26 expectedRevision', 400);
            }
            let saved;
            try {
                /* Canonical service, with the revision guard. A shared note is
                 * never copied into the caller own notes to make a local save
                 * possible; that would be residency laundering. */
                saved = this.notesService.update(user, noteId, {
                    ...args,
                    expectedRevision,
                });
            } catch (err) {
                if (err.status === 409 || err.code === 'note_revision_conflict') {
                    throw new MobileStoreError('revision_conflict', err.message || 'revision conflict', 409);
                }
                if (err.status === 403) {
                    throw new MobileStoreError('forbidden_resource_edit', err.message || 'forbidden', 403);
                }
                throw this.notFound();
            }
            return {
                ok: true,
                revision: Math.max(1, Number(saved.revision) || 1),
                result: { noteId: String(noteId), saved: true },
            };
        }

        throw new MobileStoreError(
            'unsupported_scope',
            '\u672a\u77e5\u7b14\u8bb0\u64cd\u4f5c',
            400,
            { details: { operation } },
        );
    }
    /** Nothing leaving this module may carry a control-plane secret. */

    /**
     * Issues a ZFT2 lease for device-hosted file shares.
     *
     * The frozen body names `shareProfileIds`, and those ids only exist on the
     * device: a SAF tree grant on Android or a security-scoped bookmark on iOS.
     * The server cannot enumerate or verify them, so it deliberately does not
     * pretend to. What it can do, and what actually carries the security, is
     * bind a short-lived ticket to (deviceId, ownerUserId, profile set,
     * readOnly) and let the ZFT2 upgrade path check that ticket instead of a
     * cookie session -- a mobile device has a bearer credential, never a cookie.
     *
     * readOnly is recorded on the lease rather than trusted per-frame, because
     * the write-rejecting decision has to be made somewhere the client cannot
     * re-declare it.
     */
    fileBridgeLease(user, deviceRow, request) {
        const ids = Array.isArray(request && request.shareProfileIds)
            ? request.shareProfileIds.map(String).filter(Boolean)
            : [];
        if (!ids.length) {
            throw new MobileStoreError('invalid_request', 'shareProfileIds \u4e0d\u80fd\u4e3a\u7a7a', 400);
        }
        if (ids.length > 32) {
            throw new MobileStoreError('invalid_request', 'shareProfileIds \u8fc7\u591a', 400);
        }
        /* Profile ids are opaque device-side handles. They are length-capped so
         * a malformed client cannot store unbounded strings against a lease. */
        for (const id of ids) {
            if (id.length > 200) {
                throw new MobileStoreError('invalid_request', 'shareProfileId \u8fc7\u957f', 400);
            }
        }

        /* Refused before any state is written, and before any audit row.
         *
         * The device-hosted side of this feature is the whole feature: ZFT2 runs
         * against a provider backed by an Android SAF grant or an iOS
         * security-scoped URL, and neither exists in this build. The previous
         * version of this method minted a lease, recorded it, wrote an audit row
         * saying the lease succeeded, and only then threw 503 - so the audit log
         * claimed a capability the caller never received, and the lease map grew
         * entries nothing could ever attach to.
         *
         * Validation still runs first on purpose: a malformed request is a
         * client bug the client should hear about as 400 regardless of whether
         * the transport exists. */
        throw new MobileStoreError(
            'unsupported_scope',
            '\u672c\u673a\u5171\u4eab\u6587\u4ef6\u6865\u63a5\u9700\u8981\u8bbe\u5907\u7aef ZFT2 provider\uff0c\u5f53\u524d\u6784\u5efa\u672a\u5b9e\u73b0',
            501,
            { details: { profiles: ids.length, readOnly: request && request.readOnly !== false } },
        );
    }

    /** Resolves a lease for the ZFT2 upgrade path, or null when unusable. */
    resolveLease(leaseId) {
        const lease = this.leases.get(String(leaseId || ''));
        if (!lease) return null;
        if (lease.expiresAt <= nowMs()) {
            this.leases.delete(lease.leaseId);
            return null;
        }
        return lease;
    }

    gcLeases() {
        const now = nowMs();
        for (const [id, lease] of this.leases) {
            if (lease.expiresAt <= now) this.leases.delete(id);
        }
    }

    /** Device revoke / unbind must not leave a usable file lease behind. */
    dropLeasesForDevice(deviceId) {
        for (const [id, lease] of this.leases) {
            if (lease.deviceId === deviceId) this.leases.delete(id);
        }
    }

    dropLeasesForUser(ownerUserId) {
        for (const [id, lease] of this.leases) {
            if (lease.ownerUserId === ownerUserId) this.leases.delete(id);
        }
    }

    /** Rechecks every authority that can disappear while a relay is alive. */
    assertRelaySessionLive(sessionId, { attachId = '', checkDependencies = true } = {}) {
        const session = this.sessions.get(String(sessionId || ''));
        if (!session) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u5df2\u8fc7\u671f\u6216\u4e0d\u5b58\u5728', 410);
        }
        if (attachId && !session.activeAttachIds.has(String(attachId))) {
            throw new MobileStoreError('shared_session_expired', '\u9644\u52a0\u5df2\u7ec8\u6b62', 410);
        }

        const user = this.storage.getUserBrief(session.userId);
        if (!user || user.status !== 'active') {
            this.sessions.drop(session.sessionId, 'account-unavailable');
            throw new MobileStoreError('account_unavailable', '\u8d26\u53f7\u4e0d\u53ef\u7528', 403);
        }
        const owner = this.storage.getUserBrief(session.ownerUserId);
        if (!owner || owner.status !== 'active') {
            this.sessions.drop(session.sessionId, 'owner-account-unavailable');
            throw new MobileStoreError('account_unavailable', '\u8d44\u6e90\u6240\u6709\u8005\u8d26\u53f7\u4e0d\u53ef\u7528', 403);
        }

        const device = this.store.getDeviceRow(session.deviceId);
        const deviceLive = device
            && device.owner_user_id === session.userId
            && !device.revoked_at
            && !!device.enabled
            && Number(device.refresh_generation || 1) === Number(session.deviceGeneration)
            && String(device.token_id || '') === session.backingTokenId;
        if (!deviceLive) {
            this.sessions.drop(session.sessionId, 'device-revoked');
            throw new MobileStoreError('client_revoked', '\u8bbe\u5907\u5df2\u88ab\u540a\u9500\u6216\u51ed\u636e\u5df2\u66f4\u65b0', 403);
        }

        let tokenLive = false;
        try {
            tokenLive = !!this.fileAgentManager
                && this.fileAgentManager.listTokens(user.username)
                    .some((token) => token.id === session.backingTokenId);
        } catch {
            throw new MobileStoreError('server_unavailable', 'Token \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528', 503, { retryable: true });
        }
        if (!tokenLive) {
            this.sessions.drop(session.sessionId, 'backing-token-revoked');
            throw new MobileStoreError('token_missing', '\u5173\u8054 Token \u5df2\u5220\u9664', 403);
        }

        const conn = this.storage.getConnectionById(session.resourceId);
        if (!conn || String(conn.ownerUserId || '') !== session.ownerUserId) {
            this.sessions.drop(session.sessionId, 'resource-unavailable');
            throw this.notFound();
        }
        const caps = this.authz.effectiveCapabilities(user, 'connection', conn.id, conn);
        const channelsLive = (session.channels || []).every((channel) => this.channelAllowed(channel, caps));
        if (!caps.has('use') || !channelsLive) {
            this.sessions.drop(session.sessionId, 'acl-revoked');
            throw new MobileStoreError('shared_grant_revoked', '\u5171\u4eab\u6388\u6743\u5df2\u88ab\u6536\u56de', 410);
        }
        if (Math.max(1, Number(conn.revision) || 1) !== Number(session.revision)) {
            this.sessions.drop(session.sessionId, 'resource-revision-changed');
            throw new MobileStoreError('shared_session_expired', '\u8d44\u6e90\u7248\u672c\u5df2\u66f4\u65b0', 410);
        }
        if (checkDependencies && typeof this.resourceService._resolveDependencySecrets === 'function') {
            try {
                /* The return value may contain secrets and is deliberately not
                 * retained, serialized, audited or logged. This call exists
                 * only to re-evaluate dependency ACLs. */
                this.resourceService._resolveDependencySecrets(user, conn);
            } catch (err) {
                this.sessions.drop(session.sessionId, 'dependency-acl-revoked');
                throw new MobileStoreError(err.code || 'shared_grant_revoked', err.message || '\u4f9d\u8d56\u6388\u6743\u5df2\u5931\u6548', err.status || 403);
            }
        }
        return { session, user, device, conn, caps };
    }

    validateRelaySession(sessionId, attachId) {
        try {
            return this.assertRelaySessionLive(sessionId, { attachId, checkDependencies: true });
        } catch (err) {
            return { ok: false, error: err };
        }
    }

    subscribeSessionRevocation(sessionId, listener) {
        return this.sessions.subscribe(sessionId, listener);
    }

    releaseRelayAttach(sessionId, attachId) {
        return this.sessions.releaseRelayAttach(sessionId, attachId);
    }

    /**
     * Authorises one relay attach.
     *
     * Called from the WebSocket upgrade, which has no cookie session: the
     * device presents the credential minted at session-open time. Every check
     * that mattered at mint time is repeated here, because
     * SHARED_RESOURCE_RESIDENCY.md 7 requires each operation to be authorised
     * live rather than trusting that no revoke has arrived.
     *
     * @returns {{session: object, user: object, resolved: object}}
     */
    authorizeRelay({ sessionId, credential }) {
        const claim = this.store.openBlob(RELAY_NAMESPACE, credential, {
            code: 'shared_session_expired',
            status: 410,
        });
        if (String(claim.sessionId) !== String(sessionId || '')) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u4e0d\u5339\u914d', 410);
        }

        const session = this.sessions.get(String(sessionId || ''));
        if (!session) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u5df2\u8fc7\u671f\u6216\u4e0d\u5b58\u5728', 410);
        }
        /* Defence in depth.
         *
         * Both mint sites (openConnectionSession and refreshSession) derive
         * userId/deviceId from the *authenticated requester* and sessionId from
         * the session that requester owns, and refreshSession already refuses a
         * session belonging to another device. So a credential whose sessionId
         * matches necessarily carries the matching identity, and no reachable
         * request can trip this branch. Mutation testing confirms it: removing
         * this check breaks no test. It stays because it is the invariant the
         * two mint sites are *assumed* to uphold, and a future third mint site
         * that forgets would otherwise silently widen the credential. */
        if (session.userId !== String(claim.userId) || session.deviceId !== String(claim.deviceId)) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u4e0d\u5c5e\u4e8e\u5f53\u524d\u8bbe\u5907', 410);
        }
        if (session.resourceId !== String(claim.resourceId)
            || session.backingTokenId !== String(claim.backingTokenId)
            || Number(session.deviceGeneration) !== Number(claim.deviceGeneration)
            || session.purpose !== String(claim.purpose)) {
            throw new MobileStoreError('shared_session_expired', '\u4f1a\u8bdd\u7ed1\u5b9a\u4e0d\u5339\u914d', 410);
        }
        if (session.mode !== 'relay-strict') {
            throw new MobileStoreError('shared_direct_forbidden', '\u8be5\u4f1a\u8bdd\u4e0d\u662f relay \u6a21\u5f0f', 403);
        }

        /* resolveForConnect below performs the attach-time dependency ACL
         * check; avoid resolving secret material twice on this path. */
        const live = this.assertRelaySessionLive(sessionId, { checkDependencies: false });
        const reserved = this.sessions.reserveRelayAttach(
            sessionId,
            claim.jti,
            claim.attachGeneration,
            this.maxRelayAttachesPerSession,
        );
        if (!reserved.ok) {
            throw new MobileStoreError(
                reserved.code,
                reserved.code === 'shared_session_consumed'
                    ? '\u9644\u52a0\u51ed\u636e\u5df2\u4f7f\u7528\u3001\u5df2\u8fc7\u65f6\u6216\u5e76\u53d1\u8d85\u9650'
                    : '\u4f1a\u8bdd\u5df2\u8fc7\u671f',
                reserved.code === 'shared_session_consumed' ? 409 : 410,
            );
        }

        let resolved;
        try {
            /* The credentials produced here never leave this process: they are
             * handed straight to the upstream client. */
            resolved = this.resourceService.resolveForConnect(live.user, live.conn.id);
        } catch (err) {
            this.sessions.releaseRelayAttach(sessionId, reserved.attachId);
            throw err;
        }
        try {
            this.authz.audit({
                actorUserId: live.user.userId,
                resourceType: 'connection',
                resourceId: live.conn.id,
                action: 'shared.relay.attach',
                outcome: 'success',
                metadata: { deviceId: session.deviceId, purpose: session.purpose, mode: 'relay-strict' },
            });
        } catch (err) {
            this.sessions.releaseRelayAttach(sessionId, reserved.attachId);
            throw err;
        }
        return { session, user: live.user, resolved, attachId: reserved.attachId };
    }

    assertNoForbiddenKeys(payload) {
        const walk = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 6) return;
            for (const key of Object.keys(node)) {
                if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
                    throw new MobileStoreError(
                        'shared_content_export_forbidden',
                        '\u5171\u4eab\u8d1f\u8f7d\u5305\u542b\u7981\u6b62\u5b57\u6bb5',
                        403,
                        { details: { field: key } },
                    );
                }
                walk(node[key], depth + 1);
            }
        };
        walk(payload, 0);
        return payload;
    }
}

module.exports = {
    SharedResourceApi,
    SharedSessionRegistry,
    SHARED_TYPES,
    SHARED_PURPOSES,
    CHANNELS,
    FORBIDDEN_PAYLOAD_KEYS,
    SESSION_TTL_MS,
    FILE_LEASE_TTL_SEC,
    RELAY_CREDENTIAL_TTL_MS,
    RELAY_NAMESPACE,
    MAX_RELAY_ATTACHES_PER_SESSION,
    ZFT2_MAX_INFLIGHT,
    ZFT2_CHUNK_BYTES,
    noStore,
    protocolPurpose,
};
