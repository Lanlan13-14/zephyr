'use strict';

const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

/**
 * Binds the process-local browser hub to one SQLite database generation.
 *
 * The bridge calls this seam while its transaction may still be nested. The
 * microtask then verifies the owner/cursor against SQLite after the complete
 * synchronous transaction stack has committed. A rollback leaves no row and
 * therefore emits no browser event.
 */
class AppChangeWakeRuntime {
    constructor({ hub, changeBridgeFactory = getMobileV1ChangeBridge } = {}) {
        if (!hub || typeof hub.publish !== 'function') {
            throw new TypeError('AppChangeWakeRuntime requires an AppChangeWakeHub');
        }
        this.hub = hub;
        this.changeBridgeFactory = changeBridgeFactory;
        this.db = null;
        this.bridge = null;
        this.publisher = null;
        this.generation = 0;
        this.pending = new Set();
        this.seenByOwner = new Map();
    }

    bind(db, { bridge } = {}) {
        if (!db || typeof db.prepare !== 'function') throw new TypeError('SQLite db is required');
        this.unbind({ disconnect: true });
        this.db = db;
        this.bridge = bridge || this.changeBridgeFactory(db);
        this.db.exec(`CREATE TABLE IF NOT EXISTS app_change_wake_sequences (
            owner_user_id TEXT PRIMARY KEY,
            sequence INTEGER NOT NULL CHECK(sequence >= 0),
            updated_at INTEGER NOT NULL
        )`);
        /* A database replacement can contain the same numeric sequence as the
         * generation it replaced. Advance each account independently on every
         * bind so a surviving browser cursor always observes a gap and
         * performs a canonical refresh. Isolated service tests may not have a
         * users table, hence the deliberately narrow fallback. */
        try {
            const users = this.db.prepare(`SELECT userId FROM users
                WHERE COALESCE(status, 'active') != 'deleted'`).all();
            this.db.transaction(() => {
                const read = this.db.prepare(`SELECT sequence FROM app_change_wake_sequences
                    WHERE owner_user_id = ?`);
                const write = this.db.prepare(`INSERT INTO app_change_wake_sequences
                    (owner_user_id, sequence, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(owner_user_id) DO UPDATE SET
                        sequence = excluded.sequence,
                        updated_at = excluded.updated_at`);
                for (const user of users) {
                    const ownerUserId = String(user.userId || '').trim();
                    if (!ownerUserId) continue;
                    const current = read.get(ownerUserId);
                    write.run(ownerUserId, Number(current?.sequence || 0) + 1, Date.now());
                }
            })();
        } catch (error) {
            if (!/no such table:\s*users/i.test(String(error?.message || ''))) throw error;
        }
        const generation = this.generation;
        this.publisher = (candidate) => this._queueCandidate(candidate, generation);
        this.bridge.setWakePublisher(this.publisher);
        this.hub.setSequenceResolver((ownerUserId) => {
            const row = this.db.prepare(`SELECT sequence FROM app_change_wake_sequences
                WHERE owner_user_id = ?`).get(String(ownerUserId || ''));
            return Number(row?.sequence || 0);
        });
        return this;
    }

    _queueCandidate(candidate, generation) {
        const ownerUserId = String(candidate?.ownerUserId || '').trim();
        const sequence = Number(candidate?.sequence);
        if (!ownerUserId || !Number.isSafeInteger(sequence) || sequence <= 0) return;
        const key = `${generation}:${ownerUserId}:${sequence}`;
        if (this.pending.has(key)) return;
        this.pending.add(key);
        queueMicrotask(() => {
            this.pending.delete(key);
            if (generation !== this.generation || !this.db) return;
            let row = null;
            try {
                row = this.db.prepare(`SELECT entity_type FROM mobile_sync_changes
                    WHERE owner_user_id = ? AND change_seq = ?`).get(ownerUserId, sequence);
            } catch {
                return;
            }
            if (!row) return;
            const entityType = String(row.entity_type || '');
            let seen = this.seenByOwner.get(ownerUserId);
            if (!seen) {
                seen = new Set();
                this.seenByOwner.set(ownerUserId, seen);
            }
            const marker = `${sequence}:${entityType}`;
            if (seen.has(marker)) return;
            seen.add(marker);
            while (seen.size > 4096) seen.delete(seen.values().next().value);
            let wakeSequence;
            try {
                wakeSequence = this.db.transaction(() => {
                    const current = this.db.prepare(`SELECT sequence FROM app_change_wake_sequences
                        WHERE owner_user_id = ?`).get(ownerUserId);
                    const next = Number(current?.sequence || 0) + 1;
                    this.db.prepare(`INSERT INTO app_change_wake_sequences
                        (owner_user_id, sequence, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT(owner_user_id) DO UPDATE SET
                            sequence = excluded.sequence,
                            updated_at = excluded.updated_at`).run(ownerUserId, next, Date.now());
                    return next;
                })();
            } catch {
                return;
            }
            this.hub.publish({
                ownerUserId,
                sequence: wakeSequence,
                reason: 'change',
                entityTypes: [entityType],
            });
        });
    }

    deleteUserState(ownerUserId) {
        const owner = String(ownerUserId || '').trim();
        if (!owner) return 0;
        this.seenByOwner.delete(owner);
        try {
            this.db?.prepare('DELETE FROM app_change_wake_sequences WHERE owner_user_id = ?').run(owner);
        } catch {}
        return this.hub.disconnectOwner(owner, { clearState: true });
    }

    unbind({ disconnect = true } = {}) {
        this.generation += 1;
        if (this.bridge && typeof this.bridge.setWakePublisher === 'function') {
            this.bridge.setWakePublisher(null);
        }
        this.db = null;
        this.bridge = null;
        this.publisher = null;
        this.pending.clear();
        this.seenByOwner.clear();
        this.hub.setSequenceResolver(null);
        if (disconnect) this.hub.reset();
    }

    close() {
        this.unbind({ disconnect: true });
        this.hub.close();
    }
}

module.exports = { AppChangeWakeRuntime };
