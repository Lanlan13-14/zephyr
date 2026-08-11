'use strict';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_COALESCE_MS = 60;
const DEFAULT_MAX_CONNECTIONS_PER_OWNER = 8;
const DEFAULT_MAX_CONNECTIONS_GLOBAL = 1024;
const DEFAULT_MAX_CONNECTS_PER_MINUTE = 30;
const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 5_000;
const DEFAULT_HISTORY_SIZE = 64;
const DEFAULT_IDLE_STATE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_IDLE_OWNER_STATES = 4_096;
const EVENT_NAME = 'change';
const ROUTE_PATH = '/api/me/change-wake';

const PUBLIC_REASONS = new Set(['connected', 'change', 'reconnect', 'database_rebind']);

function ownerIdOf(user) {
    const ownerUserId = String(user?.userId || '').trim();
    if (!ownerUserId) throw new TypeError('App change wake requires an authenticated user');
    return ownerUserId;
}

function sessionIdentityOf(user) {
    const sessionIdentity = String(user?.sessionIdentity || user?.sessionId || '').trim();
    if (!sessionIdentity) throw new TypeError('App change wake requires an authenticated session identity');
    return sessionIdentity;
}

function safeSequence(value) {
    const sequence = Number(value);
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

function parseLastEventId(req) {
    const header = String(req?.headers?.['last-event-id'] || '').trim();
    const queryValue = req?.query?.cursor;
    const query = queryValue == null ? '' : String(queryValue).trim();
    const raw = header || query;
    if (!raw) return { provided: false, valid: true, value: 0 };
    if (!/^\d{1,16}$/.test(raw)) return { provided: true, valid: false, value: 0 };
    const value = Number(raw);
    return {
        provided: true,
        valid: Number.isSafeInteger(value) && value >= 0,
        value: safeSequence(value),
    };
}

function mergeEvents(left, right, allowedEntityTypes) {
    if (!left) return right;
    if (!right) return left;
    const entityTypes = [];
    const selected = new Set([...(left.entityTypes || []), ...(right.entityTypes || [])]);
    for (const type of allowedEntityTypes) {
        if (selected.has(type)) entityTypes.push(type);
    }
    return {
        sequence: Math.max(safeSequence(left.sequence), safeSequence(right.sequence)),
        reason: left.reason === right.reason ? left.reason : 'change',
        entityTypes,
    };
}

/**
 * Payload-free, owner-scoped browser invalidation channel.
 *
 * Events are hints only. Clients re-read canonical REST resources after a
 * wake, so ids, masks and application data never need to cross this channel.
 */
class AppChangeWakeHub {
    constructor({
        allowedEntityTypes,
        heartbeatMs = DEFAULT_HEARTBEAT_MS,
        coalesceMs = DEFAULT_COALESCE_MS,
        maxConnectionsPerOwner = DEFAULT_MAX_CONNECTIONS_PER_OWNER,
        maxConnectionsGlobal = DEFAULT_MAX_CONNECTIONS_GLOBAL,
        maxConnectsPerMinute = DEFAULT_MAX_CONNECTS_PER_MINUTE,
        backpressureTimeoutMs = DEFAULT_BACKPRESSURE_TIMEOUT_MS,
        historySize = DEFAULT_HISTORY_SIZE,
        idleStateTtlMs = DEFAULT_IDLE_STATE_TTL_MS,
        maxIdleOwnerStates = DEFAULT_MAX_IDLE_OWNER_STATES,
        now = () => Date.now(),
    } = {}) {
        const declared = [...new Set((allowedEntityTypes || []).map(String).filter(Boolean))];
        if (!declared.length) throw new TypeError('AppChangeWakeHub requires allowed entity types');
        this.allowedEntityTypes = Object.freeze(declared);
        this.allowedEntityTypeSet = new Set(declared);
        this.heartbeatMs = Math.max(1_000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
        this.coalesceMs = Math.max(0, Number(coalesceMs) || 0);
        this.maxConnectionsPerOwner = Math.max(1, Number(maxConnectionsPerOwner) || 1);
        this.maxConnectionsGlobal = Math.max(1, Number(maxConnectionsGlobal) || 1);
        this.maxConnectsPerMinute = Math.max(1, Number(maxConnectsPerMinute) || 1);
        this.backpressureTimeoutMs = Math.max(100, Number(backpressureTimeoutMs) || 100);
        this.historySize = Math.max(1, Math.min(256, Number(historySize) || DEFAULT_HISTORY_SIZE));
        this.idleStateTtlMs = Math.max(1_000, Number(idleStateTtlMs) || DEFAULT_IDLE_STATE_TTL_MS);
        this.maxIdleOwnerStates = Math.max(1, Number(maxIdleOwnerStates) || DEFAULT_MAX_IDLE_OWNER_STATES);
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.clients = new Map();
        this.clientCount = 0;
        this.currentSequence = new Map();
        this.history = new Map();
        this.pending = new Map();
        this.connectionAttempts = new Map();
        this.ownerActivity = new Map();
        this.sessionGenerations = new Map();
        this.sequenceResolver = null;
        this.closed = false;
        this.heartbeatTimer = setInterval(() => this._heartbeat(), this.heartbeatMs);
        this.heartbeatTimer.unref?.();
    }

    setSequenceResolver(resolver) {
        this.sequenceResolver = typeof resolver === 'function' ? resolver : null;
    }

    _touchOwner(ownerUserId) {
        this.ownerActivity.set(ownerUserId, this.now());
    }

    _sessionGeneration(ownerUserId, sessionIdentity) {
        return this.sessionGenerations.get(ownerUserId)?.get(sessionIdentity) || 0;
    }

    _sessionStillCurrent(client) {
        if (!client || client.closed) return false;
        if (client.sessionGeneration !== this._sessionGeneration(client.ownerUserId, client.sessionIdentity)) return false;
        try { return client.sessionIsLive?.() !== false; } catch { return false; }
    }

    _dropSessionGenerationIfUnused(ownerUserId, sessionIdentity) {
        const ownerClients = this.clients.get(ownerUserId);
        if ([...(ownerClients || [])].some((client) => client.sessionIdentity === sessionIdentity)) return;
        const generations = this.sessionGenerations.get(ownerUserId);
        if (!generations) return;
        generations.delete(sessionIdentity);
        if (generations.size === 0) this.sessionGenerations.delete(ownerUserId);
    }

    /* Trusted session lifecycle hooks call these methods synchronously after
     * durable revocation. A per-session generation makes the publish and
     * heartbeat paths fail closed without querying SQLite for every event. */
    invalidateSession(ownerUserId, sessionIdentity) {
        const owner = String(ownerUserId || '').trim();
        const identity = String(sessionIdentity || '').trim();
        if (!owner || !identity) return 0;
        const ownerClients = this.clients.get(owner);
        if (!ownerClients?.size) return 0;
        const generations = this.sessionGenerations.get(owner) || new Map();
        generations.set(identity, (generations.get(identity) || 0) + 1);
        this.sessionGenerations.set(owner, generations);
        let closed = 0;
        for (const client of [...ownerClients]) {
            if (client.sessionIdentity !== identity) continue;
            this._closeClient(client);
            closed += 1;
        }
        return closed;
    }

    invalidateOwnerSessions(ownerUserId, { exceptSessionIdentity = '' } = {}) {
        const owner = String(ownerUserId || '').trim();
        if (!owner) return 0;
        const except = String(exceptSessionIdentity || '').trim();
        let closed = 0;
        const identities = new Set();
        for (const client of this.clients.get(owner) || []) {
            if (!except || client.sessionIdentity !== except) identities.add(client.sessionIdentity);
        }
        for (const identity of identities) closed += this.invalidateSession(owner, identity);
        return closed;
    }

    _ownerStateKeys() {
        return new Set([
            ...this.currentSequence.keys(),
            ...this.history.keys(),
            ...this.ownerActivity.keys(),
        ]);
    }

    _pruneConnectionAttempts(now = this.now()) {
        const cutoff = now - 60_000;
        for (const [ownerUserId, attempts] of this.connectionAttempts) {
            const recent = attempts.filter((at) => at > cutoff);
            if (recent.length) this.connectionAttempts.set(ownerUserId, recent);
            else this.connectionAttempts.delete(ownerUserId);
        }
    }

    _durableSequenceCovers(ownerUserId) {
        if (!this.sequenceResolver) return false;
        let durable = 0;
        try { durable = safeSequence(this.sequenceResolver(ownerUserId)); } catch { return false; }
        const retained = this.history.get(ownerUserId) || [];
        const historySequence = retained.length ? safeSequence(retained[retained.length - 1].sequence) : 0;
        return durable >= Math.max(safeSequence(this.currentSequence.get(ownerUserId)), historySequence);
    }

    /* Public for deterministic maintenance tests and for hosts that want to
     * sweep after an unusual connection surge. Every eviction is guarded by
     * the durable sequence resolver, so a reconnect always still gets a gap. */
    sweepIdleState() {
        const now = this.now();
        this._pruneConnectionAttempts(now);
        const idleOwners = [...this._ownerStateKeys()].filter((ownerUserId) => {
            return !(this.clients.get(ownerUserId)?.size)
                && !this.pending.has(ownerUserId)
                && !this.connectionAttempts.has(ownerUserId);
        }).sort((left, right) => (this.ownerActivity.get(left) || 0) - (this.ownerActivity.get(right) || 0));
        const excess = Math.max(0, idleOwners.length - this.maxIdleOwnerStates);
        let removed = 0;
        for (let index = 0; index < idleOwners.length; index += 1) {
            const ownerUserId = idleOwners[index];
            const idleFor = now - (this.ownerActivity.get(ownerUserId) || 0);
            if (index >= excess && idleFor < this.idleStateTtlMs) continue;
            if (!this._durableSequenceCovers(ownerUserId)) continue;
            this.currentSequence.delete(ownerUserId);
            this.history.delete(ownerUserId);
            this.ownerActivity.delete(ownerUserId);
            removed += 1;
        }
        return removed;
    }

    _resolvedSequence(ownerUserId) {
        let durable = 0;
        try { durable = safeSequence(this.sequenceResolver?.(ownerUserId)); } catch {}
        const current = Math.max(durable, this.currentSequence.get(ownerUserId) || 0);
        this.currentSequence.set(ownerUserId, current);
        this._touchOwner(ownerUserId);
        return current;
    }

    _connectionAllowed(ownerUserId) {
        const now = this.now();
        const cutoff = now - 60_000;
        const recent = (this.connectionAttempts.get(ownerUserId) || []).filter((at) => at > cutoff);
        if (recent.length >= this.maxConnectsPerMinute) {
            this.connectionAttempts.set(ownerUserId, recent);
            return false;
        }
        recent.push(now);
        this.connectionAttempts.set(ownerUserId, recent);
        this._touchOwner(ownerUserId);
        return true;
    }

    subscribe(req, res, user) {
        let ownerUserId;
        let sessionIdentity;
        try {
            ownerUserId = ownerIdOf(user);
            sessionIdentity = sessionIdentityOf(user);
        } catch {
            res.status(401).json({ error: 'App session expired', code: 'app_session_expired', retryable: false });
            return false;
        }
        const resume = parseLastEventId(req);
        if (!resume.valid) {
            res.status(400).json({
                error: 'Change stream cursor must be a non-negative integer',
                code: 'invalid_change_wake_cursor',
                retryable: false,
            });
            return false;
        }
        const ownerClients = this.clients.get(ownerUserId) || new Set();
        if (this.closed) {
            res.setHeader('Retry-After', '1');
            res.status(503).json({ error: 'Change stream unavailable', code: 'change_wake_unavailable', retryable: true });
            return false;
        }
        if (!this._connectionAllowed(ownerUserId)) {
            res.setHeader('Retry-After', '3');
            res.status(429).json({ error: 'Too many change stream reconnects', code: 'change_wake_rate_limited', retryable: true });
            return false;
        }
        if (ownerClients.size >= this.maxConnectionsPerOwner || this.clientCount >= this.maxConnectionsGlobal) {
            res.setHeader('Retry-After', '3');
            res.status(429).json({ error: 'Too many change stream listeners', code: 'change_wake_listener_limit', retryable: true });
            return false;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        const client = {
            req,
            res,
            ownerUserId,
            sessionIdentity,
            sessionGeneration: this._sessionGeneration(ownerUserId, sessionIdentity),
            sessionIsLive: typeof user?.sessionIsLive === 'function' ? user.sessionIsLive : null,
            closed: false,
            blocked: false,
            pendingEvent: null,
            backpressureTimer: null,
            close: null,
            drain: null,
        };
        client.close = () => this._closeClient(client);
        client.drain = () => this._drainClient(client);
        ownerClients.add(client);
        this.clients.set(ownerUserId, ownerClients);
        this.clientCount += 1;
        this._touchOwner(ownerUserId);
        req.once?.('aborted', client.close);
        res.once?.('close', client.close);
        res.once?.('error', client.close);
        res.on?.('drain', client.drain);
        this._writeRaw(client, 'retry: 3000\n\n');

        const current = this._resolvedSequence(ownerUserId);
        const lastEventId = resume.value;
        if (resume.provided && lastEventId !== current) {
            const retained = (this.history.get(ownerUserId) || []).filter((event) => event.sequence > lastEventId);
            let replay = null;
            for (const event of retained) replay = mergeEvents(replay, event, this.allowedEntityTypes);
            if (replay) replay = { ...replay, reason: 'reconnect' };
            this._writeEvent(client, replay || {
                sequence: current,
                reason: 'reconnect',
                entityTypes: [...this.allowedEntityTypes],
            });
        } else {
            this._writeEvent(client, { sequence: current, reason: 'connected', entityTypes: [] });
        }
        return true;
    }

    publish({ ownerUserId, sequence, reason = 'change', entityTypes = [] } = {}) {
        const owner = String(ownerUserId || '').trim();
        if (!owner || this.closed) return false;
        const cleanTypes = [...new Set((entityTypes || []).map(String))]
            .filter((type) => this.allowedEntityTypeSet.has(type));
        if (!cleanTypes.length) return false;
        const event = {
            sequence: safeSequence(sequence),
            reason: PUBLIC_REASONS.has(reason) ? reason : 'change',
            entityTypes: cleanTypes,
        };
        event.sequence = Math.max(event.sequence, this.currentSequence.get(owner) || 0);
        this.currentSequence.set(owner, event.sequence);
        this._touchOwner(owner);

        const existing = this.pending.get(owner);
        if (existing) {
            existing.event = mergeEvents(existing.event, event, this.allowedEntityTypes);
            return true;
        }
        const pending = { event, timer: null };
        this.pending.set(owner, pending);
        pending.timer = setTimeout(() => this._flushOwner(owner), this.coalesceMs);
        pending.timer.unref?.();
        return true;
    }

    _flushOwner(ownerUserId) {
        const pending = this.pending.get(ownerUserId);
        if (!pending) return;
        this.pending.delete(ownerUserId);
        if (pending.timer) clearTimeout(pending.timer);
        const event = pending.event;
        const retained = this.history.get(ownerUserId) || [];
        retained.push(event);
        if (retained.length > this.historySize) retained.splice(0, retained.length - this.historySize);
        this.history.set(ownerUserId, retained);
        this._touchOwner(ownerUserId);
        for (const client of [...(this.clients.get(ownerUserId) || [])]) {
            if (!this._sessionStillCurrent(client)) {
                this._closeClient(client);
                continue;
            }
            this._writeEvent(client, event);
        }
    }

    _writeEvent(client, event) {
        if (!client || !event) return false;
        if (!this._sessionStillCurrent(client)) {
            this._closeClient(client);
            return false;
        }
        if (client.blocked) {
            client.pendingEvent = mergeEvents(client.pendingEvent, event, this.allowedEntityTypes);
            return false;
        }
        const frame = `id: ${safeSequence(event.sequence)}\nevent: ${EVENT_NAME}\ndata: ${JSON.stringify({
            sequence: safeSequence(event.sequence),
            reason: PUBLIC_REASONS.has(event.reason) ? event.reason : 'change',
            entityTypes: (event.entityTypes || []).filter((type) => this.allowedEntityTypeSet.has(type)),
        })}\n\n`;
        return this._writeRaw(client, frame);
    }

    _writeRaw(client, frame) {
        if (!client || client.closed || client.res.destroyed || client.res.writableEnded) {
            this._closeClient(client);
            return false;
        }
        try {
            const accepted = client.res.write(frame);
            if (accepted === false) {
                client.blocked = true;
                if (client.backpressureTimer) clearTimeout(client.backpressureTimer);
                client.backpressureTimer = setTimeout(() => this._closeClient(client), this.backpressureTimeoutMs);
                client.backpressureTimer.unref?.();
            }
            return accepted !== false;
        } catch {
            this._closeClient(client);
            return false;
        }
    }

    _drainClient(client) {
        if (!client || client.closed) return;
        client.blocked = false;
        if (client.backpressureTimer) clearTimeout(client.backpressureTimer);
        client.backpressureTimer = null;
        const pending = client.pendingEvent;
        client.pendingEvent = null;
        if (pending) this._writeEvent(client, pending);
    }

    _heartbeat() {
        this.sweepIdleState();
        for (const ownerClients of this.clients.values()) {
            for (const client of [...ownerClients]) {
                if (!this._sessionStillCurrent(client)) {
                    this._closeClient(client);
                    continue;
                }
                if (!client.blocked) this._writeRaw(client, ': heartbeat\n\n');
            }
        }
    }

    _closeClient(client) {
        if (!client || client.closed) return;
        client.closed = true;
        if (client.backpressureTimer) clearTimeout(client.backpressureTimer);
        client.req.off?.('aborted', client.close);
        client.res.off?.('close', client.close);
        client.res.off?.('error', client.close);
        client.res.off?.('drain', client.drain);
        const ownerClients = this.clients.get(client.ownerUserId);
        ownerClients?.delete(client);
        if (ownerClients?.size === 0) this.clients.delete(client.ownerUserId);
        this._dropSessionGenerationIfUnused(client.ownerUserId, client.sessionIdentity);
        this.clientCount = Math.max(0, this.clientCount - 1);
        this._touchOwner(client.ownerUserId);
        try { if (!client.res.writableEnded) client.res.end(); } catch {}
    }

    disconnectOwner(ownerUserId, { clearState = true } = {}) {
        const owner = String(ownerUserId || '').trim();
        if (!owner) return 0;
        const clients = [...(this.clients.get(owner) || [])];
        for (const client of clients) this._closeClient(client);
        const pending = this.pending.get(owner);
        if (pending?.timer) clearTimeout(pending.timer);
        this.pending.delete(owner);
        this.sessionGenerations.delete(owner);
        if (clearState) {
            this.currentSequence.delete(owner);
            this.history.delete(owner);
            this.connectionAttempts.delete(owner);
            this.ownerActivity.delete(owner);
        } else {
            this._touchOwner(owner);
        }
        return clients.length;
    }

    reset() {
        for (const owner of [...this.clients.keys()]) this.disconnectOwner(owner);
        for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer);
        this.pending.clear();
        this.currentSequence.clear();
        this.history.clear();
        this.connectionAttempts.clear();
        this.ownerActivity.clear();
        this.sessionGenerations.clear();
    }

    close() {
        if (this.closed) return;
        this.reset();
        this.closed = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.sequenceResolver = null;
    }
}

function registerAppChangeWakeRoute(app, {
    requireUser,
    hub,
    path = ROUTE_PATH,
    sessionIdentityFromRequest = (req) => req?.session?.tokenHash,
    sessionLivenessFromRequest = (req) => {
        const session = req?.session;
        return () => {
            const now = Date.now();
            return !!session
                && !session.revokedAt
                && now <= Number(session.idleExpiresAt)
                && now <= Number(session.absoluteExpiresAt);
        };
    },
} = {}) {
    if (!app || typeof app.get !== 'function') throw new TypeError('Express app is required');
    if (typeof requireUser !== 'function') throw new TypeError('requireUser middleware is required');
    if (!hub || typeof hub.subscribe !== 'function') throw new TypeError('AppChangeWakeHub is required');
    if (typeof sessionIdentityFromRequest !== 'function') throw new TypeError('sessionIdentityFromRequest must be a function');
    if (typeof sessionLivenessFromRequest !== 'function') throw new TypeError('sessionLivenessFromRequest must be a function');
    app.get(path, requireUser, (req, res) => hub.subscribe(req, res, {
        ...req.user,
        sessionIdentity: sessionIdentityFromRequest(req),
        sessionIsLive: sessionLivenessFromRequest(req),
    }));
    return path;
}

module.exports = {
    AppChangeWakeHub,
    registerAppChangeWakeRoute,
    APP_CHANGE_WAKE_EVENT: EVENT_NAME,
    APP_CHANGE_WAKE_ROUTE: ROUTE_PATH,
    APP_CHANGE_WAKE_REASONS: Object.freeze([...PUBLIC_REASONS]),
};
