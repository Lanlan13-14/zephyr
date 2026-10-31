'use strict';
const crypto = require('node:crypto');

function fault(code, status = 409) {
    return Object.assign(new Error('AI request cannot be replayed'), { code, status, retryable: false });
}
function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');

/** Durable at-most-once dispatch reservation. No prompt, credential or ticket is persisted.
 * A crash after reservation is uncertain, never permission to execute again. */
class LinkAIDispatchStore {
    constructor(database) {
        this.db = database;
        this.inflight = new Map();
        this.db.exec(`CREATE TABLE IF NOT EXISTS link_ai_dispatch (
            scope TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
            runtime_generation TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT,
            receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(scope, request_id)
        )`);
    }
    read(scope, requestId) {
        return this.db.prepare('SELECT * FROM link_ai_dispatch WHERE scope=? AND request_id=?').get(scope, requestId) || null;
    }
    async dispatch({ scope, requestId, input, generation, assertLive, execute }) {
        const hash = digest(input);
        assertLive();
        const existing = this.read(scope, requestId);
        if (existing) {
            if (existing.input_hash !== hash) throw fault('idempotency_conflict');
            if (existing.runtime_generation !== generation) throw fault('ai_run_generation_expired');
            const running = this.inflight.get(scope + '\0' + requestId);
            if (running) {
                const result = await running;
                assertLive();
                return result;
            }
            assertLive();
            if (existing.state === 'completed') return JSON.parse(existing.receipt_json);
            if (existing.state === 'failed') throw fault('ai_dispatch_failed');
            throw fault('ai_dispatch_uncertain');
        }
        // SQLite uniqueness is the cross-request/process arbiter; no async gap before reserve.
        this.db.prepare(`INSERT INTO link_ai_dispatch(scope,request_id,input_hash,runtime_generation,state,created_at,updated_at)
            VALUES(?,?,?,?,'reserved',?,?)`).run(scope, requestId, hash, generation, Date.now(), Date.now());
        const key = scope + '\0' + requestId;
        const operation = Promise.resolve().then(async () => {
            try {
                assertLive();
                const result = await execute();
                if (!result || typeof result.runId !== 'string' || !result.runId) throw fault('ai_runtime_invalid_response', 502);
                // A minimal receipt lets callers query the original run, never open a new one.
                const receipt = { ok: true, requestId, runId: result.runId,
                    sessionId: result.sessionId || '', conversationId: result.conversationId || '', executionTarget: 'remote_host' };
                this.db.prepare(`UPDATE link_ai_dispatch SET state='completed',run_id=?,receipt_json=?,updated_at=?
                    WHERE scope=? AND request_id=? AND state='reserved'`).run(result.runId, JSON.stringify(receipt), Date.now(), scope, requestId);
                assertLive();
                return receipt;
            } catch (error) {
                // A 4xx received before run creation is terminal. Network/5xx errors could have
                // followed a side effect: keep reservation uncertain, never auto-re-dispatch.
                const state = Number(error?.status) >= 400 && Number(error?.status) < 500 ? 'failed' : 'uncertain';
                this.db.prepare(`UPDATE link_ai_dispatch SET state=?,updated_at=?
                    WHERE scope=? AND request_id=? AND state='reserved'`).run(state, Date.now(), scope, requestId);
                throw error;
            }
        });
        this.inflight.set(key, operation);
        try { return await operation; } finally { this.inflight.delete(key); }
    }
    query(scope, requestId, generation) {
        const row = this.read(scope, requestId);
        if (!row) throw fault('ai_request_not_found', 404);
        if (row.runtime_generation !== generation) throw fault('ai_run_generation_expired');
        if (row.state === 'completed') return JSON.parse(row.receipt_json);
        return { ok: true, requestId, state: row.state, runId: row.run_id || null, retryDispatch: false };
    }
}
module.exports = { LinkAIDispatchStore, digest };
