'use strict';

/**
 * Production mapper for owned-sync v1 bodies → Link v2 business envelopes.
 *
 * Spec: ZEPHYR-LINK-INTERCONNECTION-SPEC.md §4.2.1.
 * This module is the production function the conformance adapter must call.
 * It does not load the documentation reference adapter.
 */

const fs = require('fs');
const path = require('path');

const OPERATIONS = Object.freeze({
    bootstrap: 'sync.bootstrap',
    changes: 'sync.changes',
    push: 'sync.push',
    ack: 'sync.ack',
    status: 'sync.status',
});

const RESPONSE_SHAPE = Object.freeze({
    bootstrap: 'BootstrapPage',
    changes: 'ChangePage',
    push: 'PushResponse',
    ack: 'AckResponse',
    status: 'SyncStatus',
});

const ALLOWED_OPERATION_KEYS = Object.freeze([
    'opId',
    'entityType',
    'entityId',
    'action',
    'baseRevision',
    'fieldMask',
    'payload',
    'secretEnvelopes',
    'clearSecretFields',
]);

const RESERVED_FIELD_SEGMENTS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const SYNC_KIND = 1;

let registryCache = null;

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function loadEntityRegistry() {
    if (registryCache) return registryCache;
    const registryPath = path.join(__dirname, 'mobile-contracts', 'registries', 'entity-registry.json');
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const byType = new Map();
    for (const entity of parsed.entities || []) {
        if (entity && typeof entity.type === 'string') byType.set(entity.type, entity);
    }
    registryCache = { raw: parsed, byType };
    return registryCache;
}

function fieldSegments(field) {
    return String(field).split('.');
}

function isReservedField(field) {
    return fieldSegments(field).some((segment) => RESERVED_FIELD_SEGMENTS.includes(segment));
}

function extraKeys(value, allowed) {
    return Object.keys(value).filter((key) => !allowed.includes(key));
}

function validateSecretEnvelope(envelope) {
    if (!object(envelope)) return 'invalid_request';
    if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length === 0) return 'invalid_request';
    if (envelope.v !== undefined && envelope.v !== 1) return 'invalid_request';
    return null;
}

function validateSyncOperation(op, sessionContext) {
    if (!object(op)) return 'invalid_request';
    if (extraKeys(op, ALLOWED_OPERATION_KEYS).length) return 'invalid_request';
    if (!nonEmptyText(op.opId, 80)) return 'invalid_request';
    if (!nonEmptyText(op.entityType, 80)) return 'invalid_request';
    if (!nonEmptyText(op.entityId, 160)) return 'invalid_request';
    if (!['upsert', 'delete', 'restore'].includes(op.action)) return 'invalid_request';
    if (!Number.isSafeInteger(op.baseRevision) || op.baseRevision < 0) return 'invalid_request';
    if (!Array.isArray(op.fieldMask) || op.fieldMask.length > 256) return 'invalid_request';
    if (!op.fieldMask.every((field) => typeof field === 'string' && field.length > 0)) return 'invalid_request';
    if (!object(op.payload)) return 'invalid_request';
    if (op.action !== 'upsert' && (op.fieldMask.length || Object.keys(op.payload).length || op.secretEnvelopes || op.clearSecretFields)) {
        return 'invalid_request';
    }
    if (op.action === 'upsert' && !op.fieldMask.length && !op.secretEnvelopes && !op.clearSecretFields) {
        return 'invalid_request';
    }
    if (op.secretEnvelopes && op.clearSecretFields) return 'invalid_request';
    if (op.clearSecretFields) {
        if (!Array.isArray(op.clearSecretFields) || !op.clearSecretFields.every((field) => typeof field === 'string' && field.length > 0)) {
            return 'invalid_request';
        }
    }

    const registry = loadEntityRegistry();
    const spec = registry.byType.get(op.entityType);
    if (!spec) return 'unknown_entity_type';

    const editable = new Set(spec.editableFields || []);
    const secrets = new Set(spec.secretFields || []);
    const serverAuthority = new Set(spec.serverAuthorityFields || []);

    for (const field of op.fieldMask) {
        if (isReservedField(field)) return 'invalid_request';
        if (serverAuthority.has(field) || secrets.has(field)) return 'invalid_request';
        const root = fieldSegments(field)[0];
        if (serverAuthority.has(root) || secrets.has(root)) return 'invalid_request';
        if (!editable.has(field) && !editable.has(root)) return 'invalid_request';
    }
    for (const field of Object.keys(op.payload)) {
        if (isReservedField(field)) return 'invalid_request';
        if (serverAuthority.has(field) || secrets.has(field)) return 'invalid_request';
    }
    if (op.clearSecretFields) {
        for (const field of op.clearSecretFields) {
            if (!secrets.has(field)) return 'invalid_request';
        }
    }
    if (op.secretEnvelopes) {
        if (!object(op.secretEnvelopes)) return 'invalid_request';
        for (const [field, envelope] of Object.entries(op.secretEnvelopes)) {
            if (!secrets.has(field)) return 'invalid_request';
            const envelopeError = validateSecretEnvelope(envelope);
            if (envelopeError) return envelopeError;
        }
    }

    const currentRevision = sessionContext.currentRevision;
    if (Number.isSafeInteger(currentRevision) && op.baseRevision > currentRevision) {
        return 'revision_conflict';
    }
    return null;
}

/**
 * Map a legacy mobile-v1 sync body onto the v2 business envelope.
 *
 * @param {object} legacyBody
 * @param {object} [sessionContext]
 * @param {number} [sessionContext.envelopeVersion] negotiated version; default 1
 * @param {string|null} [sessionContext.authenticatedDeviceId]
 * @param {string|null} [sessionContext.bindingGeneration]
 * @param {number|null} [sessionContext.currentRevision] canonical store revision only
 * @param {string|null} [sessionContext.serverRegistryHash] capabilities/session hash
 * @param {number} [sessionContext.maxOperations]
 */
function mapSyncOperation(legacyBody, sessionContext = {}) {
    const envelopeVersion = sessionContext.envelopeVersion === undefined ? 1 : sessionContext.envelopeVersion;
    if (envelopeVersion !== 1 && envelopeVersion !== 2) {
        return { error: 'unsupported_protocol_version' };
    }
    if (!object(legacyBody)) return { error: 'invalid_request' };

    // Never infer v2 from field presence. envelopeVersion comes only from the session.
    if (legacyBody.kind !== undefined && legacyBody.kind !== SYNC_KIND) {
        return { error: 'unsupported_kind' };
    }
    if (typeof legacyBody.op !== 'string') return { error: 'invalid_request' };
    const operation = OPERATIONS[legacyBody.op];
    if (!operation) return { error: 'unsupported_op' };
    if (legacyBody.operation !== undefined && legacyBody.operation !== operation) {
        return { error: 'invalid_request' };
    }
    if (legacyBody.body !== undefined) return { error: 'invalid_request' };

    if (legacyBody.op === 'push' && legacyBody.protocolVersion !== 1) {
        return { error: 'unsupported_protocol_version' };
    }

    const authenticatedDeviceId = sessionContext.authenticatedDeviceId || null;
    if (authenticatedDeviceId && legacyBody.deviceId && legacyBody.deviceId !== authenticatedDeviceId) {
        return { error: 'device_proof_invalid' };
    }
    const deviceId = legacyBody.deviceId || authenticatedDeviceId || null;

    if (legacyBody.op === 'push') {
        if (!nonEmptyText(deviceId, 160)) return { error: 'device_proof_invalid' };
        const serverRegistryHash = sessionContext.serverRegistryHash || null;
        if (serverRegistryHash && legacyBody.registryHash && serverRegistryHash !== legacyBody.registryHash) {
            return { error: 'registry_mismatch' };
        }
        if (!nonEmptyText(legacyBody.batchId, 160)) return { error: 'invalid_request' };
        if (!Array.isArray(legacyBody.operations)) return { error: 'invalid_request' };
        const maxOperations = sessionContext.maxOperations;
        if (Number.isSafeInteger(maxOperations) && (maxOperations <= 0 || legacyBody.operations.length > maxOperations)) {
            return { error: 'invalid_request' };
        }
        const seenOpIds = new Set();
        for (const op of legacyBody.operations) {
            if (object(op) && typeof op.opId === 'string') {
                if (seenOpIds.has(op.opId)) return { error: 'duplicate_operation' };
                seenOpIds.add(op.opId);
            }
            const opError = validateSyncOperation(op, sessionContext);
            if (opError) return { error: opError };
        }
    }

    if (legacyBody.op === 'ack') {
        if (!nonEmptyText(deviceId, 160)) return { error: 'device_proof_invalid' };
        if (!Number.isSafeInteger(legacyBody.cursor) || legacyBody.cursor < 0) return { error: 'invalid_request' };
        if (legacyBody.appliedOpIds !== undefined) {
            if (!Array.isArray(legacyBody.appliedOpIds) || !legacyBody.appliedOpIds.every((id) => nonEmptyText(id, 80))) {
                return { error: 'invalid_request' };
            }
        }
    }

    if (legacyBody.op === 'changes') {
        if (!Number.isSafeInteger(legacyBody.sinceCursor) || legacyBody.sinceCursor < 0) return { error: 'invalid_request' };
        if (legacyBody.limit !== undefined && (!Number.isSafeInteger(legacyBody.limit) || legacyBody.limit < 1 || legacyBody.limit > 1000)) {
            return { error: 'invalid_request' };
        }
    }

    if (legacyBody.op === 'bootstrap') {
        if (legacyBody.pageSize !== undefined && (!Number.isSafeInteger(legacyBody.pageSize) || legacyBody.pageSize < 1 || legacyBody.pageSize > 500)) {
            return { error: 'invalid_request' };
        }
        if (legacyBody.pageToken !== undefined && !nonEmptyText(legacyBody.pageToken, 4096)) {
            return { error: 'invalid_request' };
        }
    }

    const body = { ...legacyBody };
    delete body.op;
    delete body.operation;
    delete body.kind;
    delete body.envelopeVersion;
    if (deviceId && (legacyBody.op === 'push' || legacyBody.op === 'ack')) body.deviceId = deviceId;

    let idempotency;
    if (legacyBody.op === 'push') {
        idempotency = {
            kind: 'batch',
            key: `push:${deviceId}:${legacyBody.batchId}`,
            operationIdsPreserved: true,
        };
    } else if (legacyBody.op === 'ack') {
        idempotency = { kind: 'monotonic-ack' };
    } else {
        idempotency = { kind: 'read-only' };
    }

    return {
        kind: SYNC_KIND,
        envelopeVersion: 2,
        operation,
        body,
        requestIdGenerated: true,
        bindingGeneration: sessionContext.bindingGeneration || null,
        responseShape: RESPONSE_SHAPE[legacyBody.op],
        idempotency,
    };
}

module.exports = {
    mapSyncOperation,
    OPERATIONS,
    RESPONSE_SHAPE,
    SYNC_KIND,
};
