'use strict';

/**
 * Versioned Link business-frame envelope (spec §4.2.2 / link-frame-envelope-v1).
 * Does not replace the outer ZSL frame; this is the inner body envelope.
 */

const OPERATION_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{8,96}$/;
const IDEMPOTENCY_RE = /^idem_[A-Za-z0-9_-]{8,128}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

const ALLOWED_KEYS = new Set([
    'protocol', 'protocolVersion', 'schemaVersion', 'kind', 'operation',
    'requestId', 'idempotencyKey', 'deviceId', 'bindingGeneration',
    'capability', 'sessionId', 'sessionEpoch', 'deadlineAt', 'body',
]);

function fail(details) {
    return { ok: false, code: 'invalid_frame', details };
}

function nonEmptyString(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateLinkFrame(frame) {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
        return fail('frame must be an object');
    }
    const extra = Object.keys(frame).filter((key) => !ALLOWED_KEYS.has(key));
    if (extra.length) return fail(`unknown field: ${extra[0]}`);

    if (frame.protocol !== 'zephyr-link') return fail('protocol');
    if (!Number.isInteger(frame.protocolVersion) || frame.protocolVersion < 2) return fail('protocolVersion');
    if (!Number.isInteger(frame.schemaVersion) || frame.schemaVersion < 1) return fail('schemaVersion');
    if (!Number.isInteger(frame.kind) || frame.kind < 1 || frame.kind > 16) return fail('kind');
    if (typeof frame.operation !== 'string' || !OPERATION_RE.test(frame.operation) || frame.operation.length > 96) {
        return fail('operation');
    }
    if (typeof frame.requestId !== 'string' || !REQUEST_ID_RE.test(frame.requestId)) return fail('requestId');
    if (typeof frame.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(frame.idempotencyKey)) {
        return fail('idempotencyKey');
    }
    if (!nonEmptyString(frame.deviceId, 160)) return fail('deviceId');
    if (!nonEmptyString(frame.bindingGeneration, 160)) return fail('bindingGeneration');
    if (typeof frame.capability !== 'string' || !CAPABILITY_RE.test(frame.capability) || frame.capability.length > 96) {
        return fail('capability');
    }
    if (frame.sessionId != null && !nonEmptyString(frame.sessionId, 160)) return fail('sessionId');
    if (frame.sessionEpoch != null && (!Number.isInteger(frame.sessionEpoch) || frame.sessionEpoch < 1)) {
        return fail('sessionEpoch');
    }
    if (!Number.isInteger(frame.deadlineAt) || frame.deadlineAt < 0) return fail('deadlineAt');
    if (frame.body === null || typeof frame.body !== 'object' || Array.isArray(frame.body)) {
        return fail('body');
    }
    return { ok: true };
}

module.exports = { validateLinkFrame };
