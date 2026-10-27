/**
 * Delivers durable mobile change hints to the in-process SSE broadcaster.
 *
 * The outbox remains the source of truth. A wake only tells a connected device
 * which durable cursor to pull, so an acknowledged publish with no subscribers
 * is still correct: a later reconnect catches up from SQLite.
 *
 * Leader election:
 *  - When a store/db is injected, leadership is a SQLite lease with a fencing
 *    token (`mobile_wake_leader`). Two processes sharing that database cannot
 *    both drain. capabilities.multiProcessSafe === true.
 *  - When no db is injected, a process-local `activeLeader` mutex is the
 *    fallback. It is NOT a global lock and MUST NOT be treated as multi-replica
 *    safety. capabilities.multiProcessSafe === false.
 */
'use strict';

const { MobileV1Store } = require('./mobile-v1-store');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30000;
const DEFAULT_LEASE_TTL_MS = 15000;
const WAKE_LOCK_ID = 'mobile-v1-outbox';

/* In-process mutex only. Never a substitute for the SQLite lease. */
let activeLeader = null;

function integerOption(value, fallback, minimum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function wakePublisher(wake) {
    if (!wake || typeof wake.publish !== 'function') {
        throw new TypeError('MobileV1OutboxDispatcher requires wake.publish');
    }
    return wake.publish.bind(wake);
}

function resolveLeaderStore(options) {
    if (options.store && typeof options.store.tryAcquireWakeLeader === 'function') {
        return options.store;
    }
    if (options.db) {
        return new MobileV1Store({
            db: options.db,
            entityRegistry: options.entityRegistry || { entities: [] },
            log: options.log,
        });
    }
    return null;
}

class MobileV1OutboxDispatcher {
    constructor(options = {}) {
        const bridge = options.changeBridge || options.bridge;
        if (!bridge || typeof bridge.pendingWakeEvents !== 'function'
            || typeof bridge.acknowledgeWakeEvents !== 'function') {
            throw new TypeError('MobileV1OutboxDispatcher requires a mobile change bridge');
        }
        this.changeBridge = bridge;
        this.publish = wakePublisher(options.wake);
        this.pollMs = integerOption(options.pollMs, DEFAULT_POLL_MS, 1);
        this.pageSize = integerOption(options.pageSize, DEFAULT_PAGE_SIZE, 1);
        this.retryBaseMs = integerOption(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, 1);
        this.retryMaxMs = integerOption(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, this.retryBaseMs);
        this.leaseTtlMs = integerOption(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, 1000);
        this.log = typeof options.log === 'function' ? options.log : (() => {});
        this.random = typeof options.random === 'function' ? options.random : Math.random;
        this.setTimeout = options.setTimeout || setTimeout;
        this.clearTimeout = options.clearTimeout || clearTimeout;
        this.timer = null;
        this.started = false;
        this.closed = false;
        this.draining = null;
        this.retryAttempt = 0;
        this.blockedOwners = new Set();
        this.leaderStore = resolveLeaderStore(options);
        this.instanceId = String(options.instanceId || '');
        this.fencingToken = null;
        this.multiProcessSafe = !!this.leaderStore;
        /* capabilities documents the lock that this instance actually uses. */
        this.capabilities = {
            multiProcessSafe: this.multiProcessSafe,
            lock: this.multiProcessSafe ? 'sqlite-lease' : 'in-process-activeLeader',
        };
        if (this.multiProcessSafe && !this.instanceId) {
            this.instanceId = 'wake-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
    }

    /** Starts one local leader and immediately recovers unfinished outbox rows. */
    start() {
        if (this.closed) throw new Error('MobileV1OutboxDispatcher is closed');
        if (this.started) return true;
        if (this.multiProcessSafe) {
            const lease = this.leaderStore.tryAcquireWakeLeader({
                lockId: WAKE_LOCK_ID,
                instanceId: this.instanceId,
                ttlMs: this.leaseTtlMs,
            });
            if (!lease) return false;
            this.fencingToken = Number(lease.fencingToken);
        } else {
            /* Fallback: process-local mutex. multiProcessSafe is false. */
            if (activeLeader && activeLeader !== this) return false;
            activeLeader = this;
        }
        this.started = true;
        this._schedule(0);
        return true;
    }

    /** Useful for host integration tests and explicit best-effort drains. */
    async flush() {
        if (this.closed || !this.started || !this._isLeader()) return false;
        this._clearTimer();
        await this._drain();
        return true;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.started = false;
        this._clearTimer();
        if (this.multiProcessSafe && this.fencingToken != null) {
            try {
                this.leaderStore.releaseWakeLeader({
                    lockId: WAKE_LOCK_ID,
                    instanceId: this.instanceId,
                    fencingToken: this.fencingToken,
                });
            } catch {}
            this.fencingToken = null;
        } else if (activeLeader === this) {
            activeLeader = null;
        }
    }

    async deleteUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('outbox owner is required');
        this.blockedOwners.add(owner);
        if (this.draining) await this.draining;
        return true;
    }

    restoreUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('outbox owner is required');
        this.blockedOwners.delete(owner);
        if (this.started && !this.closed) this._schedule(0);
    }

    _isLeader() {
        if (this.closed || !this.started) return false;
        if (!this.multiProcessSafe) return activeLeader === this;
        if (this.fencingToken == null) return false;
        return this.leaderStore.hasWakeLeader({
            lockId: WAKE_LOCK_ID,
            instanceId: this.instanceId,
            fencingToken: this.fencingToken,
        });
    }

    _schedule(delayMs) {
        if (this.closed || !this.started || !this._isLeader() || this.timer !== null) return;
        this.timer = this.setTimeout(() => {
            this.timer = null;
            void this._drain();
        }, Math.max(0, Number(delayMs) || 0));
        if (typeof this.timer?.unref === 'function') this.timer.unref();
    }

    _clearTimer() {
        if (this.timer === null) return;
        this.clearTimeout(this.timer);
        this.timer = null;
    }

    _retryDelay() {
        const exponent = Math.min(this.retryAttempt, 30);
        const ceiling = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
        const sample = Math.max(0, Math.min(1, Number(this.random()) || 0));
        return Math.max(1, Math.floor(ceiling * (0.5 + sample * 0.5)));
    }

    _groupEvents(events) {
        const grouped = new Map();
        for (const event of events || []) {
            const ownerUserId = String(event?.ownerUserId || '');
            if (this.blockedOwners.has(ownerUserId)) continue;
            const throughCursor = Number(event?.throughCursor);
            const outboxId = Number(event?.outboxId);
            if (!ownerUserId || !Number.isSafeInteger(throughCursor) || throughCursor < 0
                || !Number.isSafeInteger(outboxId) || outboxId < 1) continue;
            const current = grouped.get(ownerUserId);
            if (current) {
                current.throughCursor = Math.max(current.throughCursor, throughCursor);
                current.outboxIds.push(outboxId);
            } else {
                grouped.set(ownerUserId, { throughCursor, outboxIds: [outboxId] });
            }
        }
        return grouped;
    }

    _drain() {
        if (this.draining) return this.draining;
        this.draining = this._drainOnce().finally(() => {
            this.draining = null;
        });
        return this.draining;
    }

    async _drainOnce() {
        if (!this._isLeader()) {
            this.started = false;
            return;
        }
        let events;
        try {
            events = await Promise.resolve(this.changeBridge.pendingWakeEvents(this.pageSize));
        } catch {
            this._retry();
            return;
        }

        if (!Array.isArray(events) || !events.length) {
            this.retryAttempt = 0;
            if (this._renewLease()) this._schedule(this.pollMs);
            return;
        }

        const acknowledged = [];
        let failed = false;
        for (const [ownerUserId, group] of this._groupEvents(events)) {
            if (!this._isLeader()) {
                this.started = false;
                return;
            }
            if (this.blockedOwners.has(ownerUserId)) continue;
            try {
                await Promise.resolve(this.publish(ownerUserId, group.throughCursor, 'change'));
                acknowledged.push(...group.outboxIds);
            } catch {
                failed = true;
                /* Deliberately no owner, cursor, error text or payload in logs. */
                this.log('[mobile-v1-outbox] wake publish failed; retry scheduled');
            }
        }

        if (!this._isLeader()) {
            this.started = false;
            return;
        }
        if (acknowledged.length) {
            try {
                await Promise.resolve(this.changeBridge.acknowledgeWakeEvents(acknowledged));
            } catch {
                failed = true;
                this.log('[mobile-v1-outbox] wake acknowledgement failed; retry scheduled');
            }
        }

        if (failed) {
            this._retry();
            return;
        }
        this.retryAttempt = 0;
        if (!this._renewLease()) {
            this.started = false;
            return;
        }
        this._schedule(events.length >= this.pageSize ? 0 : this.pollMs);
    }

    _renewLease() {
        if (!this.multiProcessSafe) return this._isLeader();
        const renewed = this.leaderStore.renewWakeLeader({
            lockId: WAKE_LOCK_ID,
            instanceId: this.instanceId,
            fencingToken: this.fencingToken,
            ttlMs: this.leaseTtlMs,
        });
        return !!renewed;
    }

    _retry() {
        if (!this._isLeader()) {
            this.started = false;
            return;
        }
        const delay = this._retryDelay();
        this.retryAttempt += 1;
        this._schedule(delay);
    }
}

module.exports = {
    MobileV1OutboxDispatcher,
    DEFAULT_POLL_MS,
    DEFAULT_PAGE_SIZE,
    DEFAULT_RETRY_BASE_MS,
    DEFAULT_RETRY_MAX_MS,
    DEFAULT_LEASE_TTL_MS,
    WAKE_LOCK_ID,
};
