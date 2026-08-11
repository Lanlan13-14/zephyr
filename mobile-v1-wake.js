/**
 * Payload-free, owner-scoped wake transport for mobile sync.
 *
 * A wake is only a hint that the durable change cursor advanced. Entity ids,
 * entity types and user content remain in the authenticated change feed. The
 * publisher seam is intentionally tiny so an outbox worker can call
 * `publish(ownerUserId, cursor, reason)` without depending on HTTP objects.
 */
'use strict';

const crypto = require('crypto');

const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_RETRY_MS = 3000;
const DEFAULT_MAX_CLIENTS = 512;
const DEFAULT_MAX_CLIENTS_PER_OWNER = 8;
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024;
const PUBLIC_REASONS = new Set(['change', 'manual', 'reconcile']);

function integerOption(value, fallback, minimum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function cursorValue(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError('wake cursor must be a non-negative safe integer');
    }
    return parsed;
}

function parseEventId(value) {
    const raw = String(value || '').trim();
    const split = raw.lastIndexOf(':');
    if (split <= 0) return null;
    const epoch = raw.slice(0, split);
    const cursor = Number(raw.slice(split + 1));
    if (!epoch || !Number.isSafeInteger(cursor) || cursor < 0) return null;
    return { epoch, cursor };
}

class MobileV1Wake {
    constructor(options = {}) {
        this.epoch = String(options.epoch || crypto.randomUUID());
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(this.epoch)) {
            throw new TypeError('wake epoch must be an SSE-safe identifier');
        }
        this.heartbeatMs = integerOption(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, 25);
        this.retryMs = integerOption(options.retryMs, DEFAULT_RETRY_MS, 100);
        this.maxClients = integerOption(options.maxClients, DEFAULT_MAX_CLIENTS, 1);
        this.maxClientsPerOwner = integerOption(
            options.maxClientsPerOwner,
            DEFAULT_MAX_CLIENTS_PER_OWNER,
            1,
        );
        this.maxBufferedBytes = integerOption(
            options.maxBufferedBytes,
            DEFAULT_MAX_BUFFERED_BYTES,
            256,
        );
        this.log = options.log || (() => {});
        this.clientsByOwner = new Map();
        this.blockedOwners = new Set();
        this.clientCount = 0;
    }

    capabilities(pathname = '/api/mobile/v1/sync/wake') {
        return {
            enabled: true,
            transport: 'sse',
            path: pathname,
            event: 'wake',
            payloadFields: ['cursor', 'epoch', 'reason'],
            heartbeatSec: Math.ceil(this.heartbeatMs / 1000),
            retryMs: this.retryMs,
            supportsLastEventId: true,
            requiresDeviceAccess: true,
            requiresDeviceProof: true,
            maxConnections: this.maxClients,
            maxConnectionsPerOwner: this.maxClientsPerOwner,
            maxBufferedBytes: this.maxBufferedBytes,
        };
    }

    /**
     * Registers an already-authenticated response as an SSE subscriber.
     * Returns false before writing headers when a concurrency cap is reached.
     */
    subscribe({ req, res, ownerUserId, deviceId, currentCursor, isAuthorized }) {
        const ownerId = String(ownerUserId || '');
        const boundDeviceId = String(deviceId || '');
        if (!ownerId || !boundDeviceId) throw new TypeError('wake subscriber identity is required');
        if (this.blockedOwners.has(ownerId)) return false;
        if (this.clientCount >= this.maxClients) return false;

        let ownerClients = this.clientsByOwner.get(ownerId);
        if (ownerClients && ownerClients.size >= this.maxClientsPerOwner) return false;

        const latest = cursorValue(typeof currentCursor === 'function' ? currentCursor() : currentCursor);
        const prior = parseEventId(req.headers['last-event-id']);
        let lastCursor = -1;
        let initialReason = 'connected';
        if (prior && prior.epoch === this.epoch && prior.cursor <= latest) {
            lastCursor = prior.cursor;
            initialReason = 'reconnect';
        } else if (String(req.headers['last-event-id'] || '').trim()) {
            initialReason = 'epoch_changed';
        }

        const client = {
            req,
            res,
            ownerId,
            deviceId: boundDeviceId,
            lastCursor,
            isAuthorized: typeof isAuthorized === 'function' ? isAuthorized : (() => true),
            heartbeat: null,
            closed: false,
            onClose: null,
            onError: null,
        };

        if (!ownerClients) {
            ownerClients = new Set();
            this.clientsByOwner.set(ownerId, ownerClients);
        }
        ownerClients.add(client);
        this.clientCount += 1;

        client.onClose = () => this._close(client, false);
        client.onError = () => this._close(client, true);
        req.once('aborted', client.onClose);
        res.once('close', client.onClose);
        res.once('error', client.onError);

        try {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (res.socket && typeof res.socket.setTimeout === 'function') res.socket.setTimeout(0);
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            if (!this._write(client, `retry: ${this.retryMs}\n\n`)) return true;

            /* No replay buffer is needed: the cursor is durable in SQLite and
             * the receiver pulls all changes after its own applied cursor. */
            if (latest > client.lastCursor || initialReason !== 'reconnect') {
                this._sendWake(client, latest, initialReason);
            }

            if (!client.closed) {
                client.heartbeat = setInterval(() => this._heartbeat(client), this.heartbeatMs);
                if (typeof client.heartbeat.unref === 'function') client.heartbeat.unref();
            }
            return true;
        } catch (err) {
            this.log('[mobile-v1-wake] subscriber setup failed', { error: err.message });
            this._close(client, true);
            return true;
        }
    }

    /** Publishes a coalescible hint to subscribers belonging to one owner. */
    publish(ownerUserId, cursor, reason = 'change') {
        const ownerId = String(ownerUserId || '');
        if (!ownerId) throw new TypeError('wake owner is required');
        const throughCursor = cursorValue(cursor);
        const safeReason = PUBLIC_REASONS.has(String(reason)) ? String(reason) : 'change';
        const clients = this.clientsByOwner.get(ownerId);
        if (!clients) return 0;

        let delivered = 0;
        for (const client of [...clients]) {
            if (throughCursor <= client.lastCursor) continue;
            if (this._sendWake(client, throughCursor, safeReason)) delivered += 1;
        }
        return delivered;
    }

    disconnectDevice(deviceId) {
        const target = String(deviceId || '');
        let disconnected = 0;
        for (const clients of [...this.clientsByOwner.values()]) {
            for (const client of [...clients]) {
                if (client.deviceId !== target) continue;
                this._close(client, false);
                disconnected += 1;
            }
        }
        return disconnected;
    }

    deleteUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('wake owner is required');
        this.blockedOwners.add(owner);
        const clients = this.clientsByOwner.get(owner);
        if (!clients) return 0;
        let disconnected = 0;
        for (const client of [...clients]) {
            this._close(client, false);
            disconnected += 1;
        }
        return disconnected;
    }

    restoreUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('wake owner is required');
        this.blockedOwners.delete(owner);
    }

    close() {
        for (const clients of [...this.clientsByOwner.values()]) {
            for (const client of [...clients]) this._close(client, false);
        }
    }

    _heartbeat(client) {
        if (client.closed) return;
        let authorized = false;
        try {
            authorized = client.isAuthorized() === true;
        } catch {
            authorized = false;
        }
        if (!authorized) {
            this._close(client, false);
            return;
        }
        this._write(client, ': heartbeat\n\n');
    }

    _sendWake(client, cursor, reason) {
        if (client.closed || cursor <= client.lastCursor) return false;
        const data = JSON.stringify({ cursor, epoch: this.epoch, reason });
        const frame = `id: ${this.epoch}:${cursor}\nevent: wake\ndata: ${data}\n\n`;
        if (!this._write(client, frame)) return false;
        client.lastCursor = cursor;
        return true;
    }

    _write(client, frame) {
        const { res } = client;
        if (client.closed || res.destroyed || res.writableEnded) {
            this._close(client, false);
            return false;
        }
        if (Number(res.writableLength || 0) + Buffer.byteLength(frame, 'utf8') > this.maxBufferedBytes) {
            this._close(client, true);
            return false;
        }
        try {
            const accepted = res.write(frame);
            if (!accepted) {
                this._close(client, true);
                return false;
            }
            return true;
        } catch {
            this._close(client, true);
            return false;
        }
    }

    _close(client, destroy) {
        if (!client || client.closed) return;
        client.closed = true;
        if (client.heartbeat) clearInterval(client.heartbeat);

        client.req.off('aborted', client.onClose);
        client.res.off('close', client.onClose);
        client.res.off('error', client.onError);

        const clients = this.clientsByOwner.get(client.ownerId);
        if (clients) {
            clients.delete(client);
            if (clients.size === 0) this.clientsByOwner.delete(client.ownerId);
        }
        this.clientCount = Math.max(0, this.clientCount - 1);

        try {
            if (destroy && typeof client.res.destroy === 'function') client.res.destroy();
            else if (!client.res.writableEnded) client.res.end();
        } catch {
            // The socket is already gone; registry cleanup above is sufficient.
        }
    }
}

module.exports = {
    MobileV1Wake,
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_RETRY_MS,
    DEFAULT_MAX_CLIENTS,
    DEFAULT_MAX_CLIENTS_PER_OWNER,
    DEFAULT_MAX_BUFFERED_BYTES,
    parseEventId,
};
