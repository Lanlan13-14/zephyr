'use strict';

/**
 * AI run idempotency + approval binding (spec §9 / test gate 6.2).
 *
 * Dispatch retries with the same runId must not execute the tool twice.
 * Approvals bind run + tool + inputHash; a mutated command invalidates the grant.
 * This is not KindAI execution and must not be registered as a successful AI lane.
 */

const crypto = require('crypto');

class AiRunIdempotencyError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'AiRunIdempotencyError';
    }
}

function fail(code, message) {
    throw new AiRunIdempotencyError(code, message);
}

function sha256Json(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

const HIGH_RISK_TOOLS = new Set([
    'revealSecret', 'remoteWipe', 'shell.exec', 'connection_create_v1',
]);

class AiRunRegistry {
    constructor({ now = () => Date.now() } = {}) {
        this.now = now;
        this.runs = new Map();
        this.approvals = new Map();
        this.executions = 0;
    }

    approve({ runId, tool, input, confirmationId, expiresAt } = {}) {
        if (!runId || !tool || !confirmationId) fail('invalid_request', 'approval fields required');
        const inputHash = sha256Json(input);
        this.approvals.set(`${runId}:${tool}`, {
            confirmationId: String(confirmationId),
            inputHash,
            expiresAt: Number(expiresAt) || (this.now() + 60_000),
        });
        return { inputHash };
    }

    dispatch({ runId, tool, input, execute, highRisk = false } = {}) {
        if (!runId || !tool) fail('invalid_request', 'runId and tool required');
        if (typeof execute !== 'function') fail('invalid_request', 'execute required');
        const existing = this.runs.get(runId);
        const inputHash = sha256Json(input);
        if (existing) {
            if (existing.tool !== tool) fail('idempotency_conflict', 'runId already bound to another tool');
            if (existing.inputHash !== inputHash) fail('idempotency_conflict', 'retry payload does not match original run');
            return {
                ok: true,
                replayed: true,
                runId,
                result: existing.result,
                executions: this.executions,
            };
        }

        const risk = highRisk || HIGH_RISK_TOOLS.has(tool);
        if (risk) {
            const grant = this.approvals.get(`${runId}:${tool}`);
            if (!grant) fail('approval_required', 'high-risk tool requires approval');
            if (grant.inputHash !== inputHash) fail('approval_stale', 'command changed after approval');
            if (this.now() >= grant.expiresAt) fail('approval_expired', 'approval expired');
        }

        const result = execute(input);
        this.executions += 1;
        this.runs.set(runId, { tool, inputHash, result });
        return {
            ok: true,
            replayed: false,
            runId,
            result,
            executions: this.executions,
        };
    }

    lookup(runId) {
        return this.runs.get(runId) || null;
    }
}

function createAiRunRegistry(opts) {
    return new AiRunRegistry(opts);
}

module.exports = {
    AiRunIdempotencyError,
    AiRunRegistry,
    createAiRunRegistry,
    sha256Json,
    HIGH_RISK_TOOLS,
};
