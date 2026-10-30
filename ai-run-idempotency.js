'use strict';

/** In-process execution deduplication, not a durable AI/KindAI execution broker. */
const crypto = require('crypto');

class AiRunIdempotencyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AiRunIdempotencyError';
        this.code = code;
    }
}
function fail(code, message) { throw new AiRunIdempotencyError(code, message); }
function sha256Json(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
const HIGH_RISK_TOOLS = new Set(['revealSecret', 'remoteWipe', 'shell.exec', 'connection_create_v1']);
function scopeOf({ userId, sessionId, runId, toolCallId, tool, generation } = {}) {
    const actor = String(userId || '');
    // Only unscoped module callers retain the old single-tool convenience API.
    const call = String(toolCallId || (!actor ? `legacy-tool:${tool}` : ''));
    if (!runId || !tool) fail('invalid_request', 'runId and tool required');
    if (!call || call.length > 256 || /[\0-\x1f\x7f]/.test(call)) {
        fail('invalid_tool_call_id', 'a valid toolCallId is required');
    }
    return { actor, sessionId: String(sessionId || ''), runId: String(runId), call, generation: String(generation || '') };
}
function keyOf(scope) {
    return sha256Json([scope.actor, scope.sessionId, scope.runId, scope.call, scope.generation]);
}

class AiRunRegistry {
    constructor({ now = () => Date.now(), maxEntries = 10_000 } = {}) {
        this.now = now;
        this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 10_000));
        this.runs = new Map();
        this.approvals = new Map();
        this.executions = 0;
    }
    approve(request = {}) {
        const { tool, input, confirmationId, expiresAt } = request;
        const scope = scopeOf(request);
        if (!confirmationId) fail('invalid_request', 'confirmationId required');
        for (const [key, grant] of this.approvals) {
            if (grant.expiresAt <= this.now()) this.approvals.delete(key);
        }
        if (this.approvals.size >= this.maxEntries && !this.approvals.has(keyOf(scope))) {
            fail('idempotency_capacity', 'approval capacity reached');
        }
        const inputHash = sha256Json(input);
        this.approvals.set(keyOf(scope), {
            tool, inputHash, confirmationId: String(confirmationId),
            expiresAt: Number(expiresAt) || this.now() + 60_000,
        });
        return { inputHash };
    }
    async dispatch(request = {}) {
        const { tool, input, execute, authorize, highRisk = HIGH_RISK_TOOLS.has(tool) } = request;
        const scope = scopeOf(request);
        if (typeof execute !== 'function') fail('invalid_request', 'execute required');
        const check = async () => { if (typeof authorize === 'function') await authorize(); };
        await check(); // Replays are data reads, not authorization grants.
        const key = keyOf(scope);
        const inputHash = sha256Json(input);
        const existing = this.runs.get(key);
        if (existing) {
            if (existing.tool !== tool || existing.inputHash !== inputHash) {
                fail('idempotency_conflict', 'tool call or input differs from its first execution');
            }
            const result = await existing.promise;
            await check(); // The run/ACL can be revoked while awaiting the first execution.
            return { ok: true, replayed: true, runId: scope.runId, result, executions: this.executions };
        }
        // Never evict an execution key and silently execute a side effect again.
        // This bounded in-process registry fails closed. Restart durability is not claimed.
        if (this.runs.size >= this.maxEntries) fail('idempotency_capacity', 'execution capacity reached');
        if (highRisk) {
            const grant = this.approvals.get(key);
            if (!grant || grant.tool !== tool) fail('approval_required', 'high-risk tool requires approval');
            if (grant.inputHash !== inputHash) fail('approval_stale', 'command changed after approval');
            if (this.now() >= grant.expiresAt) fail('approval_expired', 'approval expired');
            this.approvals.delete(key);
        }
        const record = { tool, inputHash, result: undefined, promise: null };
        // Publish before user code runs; concurrent duplicates share the promise.
        // Retain failures too: a tool can throw after committing a side effect.
        record.promise = Promise.resolve().then(() => execute(input)).then((result) => {
            record.result = result;
            return result;
        });
        this.runs.set(key, record);
        this.executions += 1;
        const result = await record.promise;
        await check();
        return { ok: true, replayed: false, runId: scope.runId, result, executions: this.executions };
    }
    lookup(request = {}) { return this.runs.get(keyOf(scopeOf(request))) || null; }
}
function createAiRunRegistry(options) { return new AiRunRegistry(options); }
module.exports = { AiRunIdempotencyError, AiRunRegistry, createAiRunRegistry, sha256Json, HIGH_RISK_TOOLS };
