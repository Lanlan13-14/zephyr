'use strict';

/**
 * Desktop owned-sync durable state on the same SQLite handle as the
 * canonical Resource/Notes rows. JSON `one-link-sync-state.json` remains
 * the no-db fallback used by memory tests.
 *
 * Tables are additive and scoped by account_key = serverId:userId:deviceId.
 */

function jsonText(value, fallback) {
    if (value == null) return fallback;
    try {
        return JSON.stringify(value);
    } catch {
        return fallback;
    }
}

function parseJson(text, fallback) {
    if (text == null || text === '') return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

class OneLinkLocalStore {
    constructor(db) {
        if (!db || typeof db.prepare !== 'function') {
            throw new TypeError('OneLinkLocalStore requires a SQLite db');
        }
        this.db = db;
        this._ensureSchema();
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS one_link_meta (
                account_key TEXT PRIMARY KEY,
                applied_cursor INTEGER NOT NULL DEFAULT 0,
                acked_cursor INTEGER NOT NULL DEFAULT 0,
                snapshot_cursor INTEGER NOT NULL DEFAULT 0,
                bootstrap_complete INTEGER NOT NULL DEFAULT 0,
                bootstrap_page_token TEXT,
                bootstrap_id TEXT,
                bootstrap_pages_fetched INTEGER NOT NULL DEFAULT 0,
                bootstrap_token_expires_at INTEGER NOT NULL DEFAULT 0,
                registry_hash TEXT,
                last_success_at INTEGER,
                last_error TEXT,
                last_error_code TEXT,
                last_pushed_json TEXT NOT NULL DEFAULT '{}',
                confirmed_base_json TEXT NOT NULL DEFAULT '{}',
                automatic_enabled INTEGER NOT NULL DEFAULT 1,
                interval_sec INTEGER NOT NULL DEFAULT 300,
                network_policy TEXT NOT NULL DEFAULT 'any',
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS one_link_outbox (
                op_id TEXT PRIMARY KEY,
                account_key TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
                base_revision INTEGER NOT NULL DEFAULT 0,
                field_mask_json TEXT NOT NULL DEFAULT '[]',
                payload_json TEXT,
                secret_mutation_json TEXT,
                status TEXT NOT NULL,
                created_locally INTEGER NOT NULL DEFAULT 1,
                dispatched_at INTEGER,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                enqueued_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_one_link_outbox_account
                ON one_link_outbox(account_key, status, enqueued_at);
            CREATE TABLE IF NOT EXISTS one_link_conflicts (
                conflict_id TEXT PRIMARY KEY,
                account_key TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                op_id TEXT,
                base_json TEXT,
                base_revision INTEGER NOT NULL DEFAULT 0,
                local_json TEXT,
                server_json TEXT,
                merged_payload_json TEXT,
                resolution TEXT,
                unresolved INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_one_link_conflicts_account
                ON one_link_conflicts(account_key, entity_type, entity_id);
            CREATE TABLE IF NOT EXISTS one_link_secret_journal (
                journal_id TEXT PRIMARY KEY,
                account_key TEXT NOT NULL,
                op_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                field_name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('put','clear')),
                state TEXT NOT NULL CHECK(state IN ('prepared','applied','acked','superseded')),
                ciphertext_ref TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_one_link_secret_journal_op
                ON one_link_secret_journal(account_key, op_id, state);
            CREATE TABLE IF NOT EXISTS one_link_bootstrap_staging (
                account_key TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                payload_json TEXT NOT NULL DEFAULT '{}',
                field_mask_json TEXT NOT NULL DEFAULT '[]',
                action TEXT NOT NULL DEFAULT 'upsert',
                secret_envelopes_json TEXT,
                PRIMARY KEY(account_key, entity_type, entity_id)
            );
        `);
    }

    loadAccount(accountKey) {
        const key = String(accountKey || '');
        if (!key) {
            return { meta: null, outbox: [], conflicts: [] };
        }
        const metaRow = this.db.prepare('SELECT * FROM one_link_meta WHERE account_key = ?').get(key);
        const outbox = this.db.prepare(
            'SELECT * FROM one_link_outbox WHERE account_key = ? ORDER BY enqueued_at ASC',
        ).all(key).map((row) => this._outboxFromRow(row));
        const conflicts = this.db.prepare(
            'SELECT * FROM one_link_conflicts WHERE account_key = ? ORDER BY created_at ASC',
        ).all(key).map((row) => this._conflictFromRow(row));
        return { meta: metaRow ? this._metaFromRow(metaRow) : null, outbox, conflicts };
    }

    persistMeta(accountKey, state) {
        const key = String(accountKey || '');
        if (!key) return;
        this.db.prepare(`INSERT INTO one_link_meta (
                account_key, applied_cursor, acked_cursor, snapshot_cursor,
                bootstrap_complete, bootstrap_page_token, bootstrap_id,
                bootstrap_pages_fetched, bootstrap_token_expires_at, registry_hash,
                last_success_at, last_error, last_error_code, last_pushed_json,
                confirmed_base_json, automatic_enabled, interval_sec, network_policy, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_key) DO UPDATE SET
                applied_cursor = excluded.applied_cursor,
                acked_cursor = excluded.acked_cursor,
                snapshot_cursor = excluded.snapshot_cursor,
                bootstrap_complete = excluded.bootstrap_complete,
                bootstrap_page_token = excluded.bootstrap_page_token,
                bootstrap_id = excluded.bootstrap_id,
                bootstrap_pages_fetched = excluded.bootstrap_pages_fetched,
                bootstrap_token_expires_at = excluded.bootstrap_token_expires_at,
                registry_hash = excluded.registry_hash,
                last_success_at = excluded.last_success_at,
                last_error = excluded.last_error,
                last_error_code = excluded.last_error_code,
                last_pushed_json = excluded.last_pushed_json,
                confirmed_base_json = excluded.confirmed_base_json,
                automatic_enabled = excluded.automatic_enabled,
                interval_sec = excluded.interval_sec,
                network_policy = excluded.network_policy,
                updated_at = excluded.updated_at`).run(
            key,
            Number(state.appliedCursor) || 0,
            Number(state.ackedCursor) || 0,
            Number(state.snapshotCursor) || 0,
            state.bootstrapComplete === true ? 1 : 0,
            state.bootstrapPageToken || null,
            state.bootstrapId || '',
            Number(state.bootstrapPagesFetched) || 0,
            Number(state.bootstrapTokenExpiresAt) || 0,
            state.registryHash || '',
            state.lastSuccessAt || null,
            state.lastError || null,
            state.lastErrorCode || null,
            jsonText(state.lastPushedRevisions || {}, '{}'),
            jsonText(state.confirmedBaseRevisions || {}, '{}'),
            state.automaticEnabled === false ? 0 : 1,
            Number(state.intervalSec) || 300,
            state.networkPolicy === 'wifiOnly' ? 'wifiOnly' : 'any',
            Date.now(),
        );
    }

    upsertOutbox(accountKey, op) {
        const key = String(accountKey || '');
        if (!key || !op || !op.opId) {
            throw new Error('one_link_outbox requires accountKey and opId');
        }
        this.db.prepare(`INSERT INTO one_link_outbox (
                op_id, account_key, entity_type, entity_id, action, base_revision,
                field_mask_json, payload_json, secret_mutation_json, status,
                created_locally, dispatched_at, attempt_count, last_error, enqueued_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(op_id) DO UPDATE SET
                action = excluded.action,
                base_revision = excluded.base_revision,
                field_mask_json = excluded.field_mask_json,
                payload_json = excluded.payload_json,
                secret_mutation_json = excluded.secret_mutation_json,
                status = excluded.status,
                created_locally = excluded.created_locally,
                dispatched_at = excluded.dispatched_at,
                attempt_count = excluded.attempt_count,
                last_error = excluded.last_error`).run(
            String(op.opId),
            key,
            String(op.entityType),
            String(op.entityId),
            op.action === 'delete' ? 'delete' : 'upsert',
            Number(op.baseRevision) || 0,
            jsonText(op.fieldMask || [], '[]'),
            op.payload === undefined ? null : jsonText(op.payload, null),
            op.secretMutation == null ? null : jsonText(op.secretMutation, null),
            String(op.status || 'pending'),
            op.createdLocally === false ? 0 : 1,
            op.dispatchedAt || null,
            Number(op.attemptCount) || 0,
            op.lastError || null,
            Number(op.enqueuedAt) || Date.now(),
        );
        return op;
    }

    replaceOutbox(accountKey, ops) {
        const key = String(accountKey || '');
        const write = () => {
            this.db.prepare('DELETE FROM one_link_outbox WHERE account_key = ?').run(key);
            for (const op of ops || []) this.upsertOutbox(key, op);
        };
        if (this.db.inTransaction) write();
        else this.db.transaction(write)();
    }

    upsertConflict(accountKey, conflict) {
        const key = String(accountKey || '');
        if (!key || !conflict?.conflictId) {
            throw new Error('one_link_conflicts requires accountKey and conflictId');
        }
        this.db.prepare(`INSERT INTO one_link_conflicts (
                conflict_id, account_key, entity_type, entity_id, op_id,
                base_json, base_revision, local_json, server_json,
                merged_payload_json, resolution, unresolved, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conflict_id) DO UPDATE SET
                op_id = excluded.op_id,
                base_json = excluded.base_json,
                base_revision = excluded.base_revision,
                local_json = excluded.local_json,
                server_json = excluded.server_json,
                merged_payload_json = excluded.merged_payload_json,
                resolution = excluded.resolution,
                unresolved = excluded.unresolved`).run(
            String(conflict.conflictId),
            key,
            String(conflict.entityType),
            String(conflict.entityId),
            conflict.opId || null,
            conflict.base == null ? null : jsonText(conflict.base, null),
            Number(conflict.baseRevision) || 0,
            conflict.local == null ? null : jsonText(conflict.local, null),
            conflict.server == null ? null : jsonText(conflict.server, null),
            conflict.mergedPayload == null ? null : jsonText(conflict.mergedPayload, null),
            conflict.resolution || null,
            conflict.unresolved === false ? 0 : 1,
            Number(conflict.at || conflict.createdAt) || Date.now(),
        );
        return conflict;
    }

    replaceConflicts(accountKey, conflicts) {
        const key = String(accountKey || '');
        const write = () => {
            this.db.prepare('DELETE FROM one_link_conflicts WHERE account_key = ?').run(key);
            for (const row of conflicts || []) this.upsertConflict(key, row);
        };
        if (this.db.inTransaction) write();
        else this.db.transaction(write)();
    }

    insertJournal(row) {
        this.db.prepare(`INSERT INTO one_link_secret_journal (
                journal_id, account_key, op_id, entity_type, entity_id, field_name,
                kind, state, ciphertext_ref, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            String(row.journalId),
            String(row.accountKey),
            String(row.opId),
            String(row.entityType),
            String(row.entityId),
            String(row.fieldName),
            row.kind === 'clear' ? 'clear' : 'put',
            String(row.state || 'prepared'),
            row.ciphertextRef || null,
            Number(row.createdAt) || Date.now(),
        );
        return row;
    }

    updateJournalState(accountKey, opId, nextState) {
        const info = this.db.prepare(`UPDATE one_link_secret_journal
            SET state = ? WHERE account_key = ? AND op_id = ?`).run(
            String(nextState),
            String(accountKey),
            String(opId),
        );
        return Number(info.changes || 0);
    }

    listJournal(accountKey, { state } = {}) {
        if (state) {
            return this.db.prepare(`SELECT * FROM one_link_secret_journal
                WHERE account_key = ? AND state = ? ORDER BY created_at ASC`)
                .all(String(accountKey), String(state));
        }
        return this.db.prepare(`SELECT * FROM one_link_secret_journal
            WHERE account_key = ? ORDER BY created_at ASC`).all(String(accountKey));
    }

    replaceStaging(accountKey, entities) {
        const key = String(accountKey || '');
        const write = () => {
            this.db.prepare('DELETE FROM one_link_bootstrap_staging WHERE account_key = ?').run(key);
            const insert = this.db.prepare(`INSERT INTO one_link_bootstrap_staging (
                account_key, entity_type, entity_id, revision, payload_json,
                field_mask_json, action, secret_envelopes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const entity of entities || []) {
                insert.run(
                    key,
                    String(entity.entityType),
                    String(entity.entityId),
                    Number(entity.revision) || 1,
                    jsonText(entity.payload || {}, '{}'),
                    jsonText(entity.fieldMask || [], '[]'),
                    entity.action === 'delete' ? 'delete' : 'upsert',
                    entity.secretEnvelopes == null ? null : jsonText(entity.secretEnvelopes, null),
                );
            }
        };
        if (this.db.inTransaction) write();
        else this.db.transaction(write)();
    }

    upsertStaging(accountKey, entity) {
        this.db.prepare(`INSERT INTO one_link_bootstrap_staging (
                account_key, entity_type, entity_id, revision, payload_json,
                field_mask_json, action, secret_envelopes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_key, entity_type, entity_id) DO UPDATE SET
                revision = excluded.revision,
                payload_json = excluded.payload_json,
                field_mask_json = excluded.field_mask_json,
                action = excluded.action,
                secret_envelopes_json = excluded.secret_envelopes_json`).run(
            String(accountKey),
            String(entity.entityType),
            String(entity.entityId),
            Number(entity.revision) || 1,
            jsonText(entity.payload || {}, '{}'),
            jsonText(entity.fieldMask || [], '[]'),
            entity.action === 'delete' ? 'delete' : 'upsert',
            entity.secretEnvelopes == null ? null : jsonText(entity.secretEnvelopes, null),
        );
    }

    listStaging(accountKey) {
        return this.db.prepare(
            'SELECT * FROM one_link_bootstrap_staging WHERE account_key = ?',
        ).all(String(accountKey)).map((row) => ({
            entityType: row.entity_type,
            entityId: row.entity_id,
            revision: Number(row.revision) || 1,
            action: row.action,
            payload: parseJson(row.payload_json, {}),
            fieldMask: parseJson(row.field_mask_json, []),
            secretEnvelopes: parseJson(row.secret_envelopes_json, undefined),
        }));
    }

    clearStaging(accountKey) {
        this.db.prepare('DELETE FROM one_link_bootstrap_staging WHERE account_key = ?')
            .run(String(accountKey));
    }

    clearAccount(accountKey) {
        const key = String(accountKey || '');
        const write = () => {
            this.db.prepare('DELETE FROM one_link_outbox WHERE account_key = ?').run(key);
            this.db.prepare('DELETE FROM one_link_conflicts WHERE account_key = ?').run(key);
            this.db.prepare('DELETE FROM one_link_secret_journal WHERE account_key = ?').run(key);
            this.db.prepare('DELETE FROM one_link_bootstrap_staging WHERE account_key = ?').run(key);
            this.db.prepare('DELETE FROM one_link_meta WHERE account_key = ?').run(key);
        };
        if (this.db.inTransaction) write();
        else this.db.transaction(write)();
    }

    persistState(accountKey, state) {
        const key = String(accountKey || '');
        if (!key || !state) return;
        const write = () => {
            this.persistMeta(key, state);
            this.replaceOutbox(key, state.outbox || []);
            this.replaceConflicts(key, state.conflicts || []);
        };
        if (this.db.inTransaction) write();
        else this.db.transaction(write)();
    }

    _metaFromRow(row) {
        return {
            appliedCursor: Number(row.applied_cursor) || 0,
            ackedCursor: Number(row.acked_cursor) || 0,
            snapshotCursor: Number(row.snapshot_cursor) || 0,
            bootstrapComplete: Number(row.bootstrap_complete) === 1,
            bootstrapPageToken: row.bootstrap_page_token || null,
            bootstrapId: row.bootstrap_id || '',
            bootstrapPagesFetched: Number(row.bootstrap_pages_fetched) || 0,
            bootstrapTokenExpiresAt: Number(row.bootstrap_token_expires_at) || 0,
            registryHash: row.registry_hash || '',
            lastSuccessAt: row.last_success_at || null,
            lastError: row.last_error || null,
            lastErrorCode: row.last_error_code || null,
            lastPushedRevisions: parseJson(row.last_pushed_json, {}),
            confirmedBaseRevisions: parseJson(row.confirmed_base_json, {}),
            automaticEnabled: Number(row.automatic_enabled) !== 0,
            intervalSec: Number(row.interval_sec) || 300,
            networkPolicy: row.network_policy === 'wifiOnly' ? 'wifiOnly' : 'any',
        };
    }

    _outboxFromRow(row) {
        return {
            opId: row.op_id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            action: row.action,
            baseRevision: Number(row.base_revision) || 0,
            fieldMask: parseJson(row.field_mask_json, []),
            payload: parseJson(row.payload_json, undefined),
            secretMutation: parseJson(row.secret_mutation_json, undefined),
            status: row.status,
            createdLocally: Number(row.created_locally) !== 0,
            dispatchedAt: row.dispatched_at || null,
            attemptCount: Number(row.attempt_count) || 0,
            lastError: row.last_error || null,
            enqueuedAt: Number(row.enqueued_at) || 0,
        };
    }

    _conflictFromRow(row) {
        return {
            conflictId: row.conflict_id,
            entityType: row.entity_type,
            entityId: row.entity_id,
            opId: row.op_id || null,
            base: parseJson(row.base_json, null),
            baseRevision: Number(row.base_revision) || 0,
            local: parseJson(row.local_json, null),
            server: parseJson(row.server_json, null),
            mergedPayload: parseJson(row.merged_payload_json, null),
            resolution: row.resolution || null,
            unresolved: Number(row.unresolved) !== 0,
            at: Number(row.created_at) || 0,
        };
    }
}

module.exports = {
    OneLinkLocalStore,
};
