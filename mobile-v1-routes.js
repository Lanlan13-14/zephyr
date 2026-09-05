/**
 * Zephyr One mobile v1 HTTP surface.
 *
 * Implements the operations declared in
 * `zephyr_one/mobile/contracts/openapi-mobile-v1.json`. The Kotlin client in
 * `zephyr_one/mobile/android` is already written against that contract, so the
 * response field names here are the wire format and are not free to drift:
 * `mobile-v1-routes.test.mjs` asserts them against the generated DTOs.
 *
 * Three planes of authentication, matching the OpenAPI security schemes:
 *
 *   ZephyrSid     an existing Zephyr app session (header `X-Zephyr-Sid`).
 *                 Used for binding and for account-level device management,
 *                 because those actions belong to the human, not the device.
 *   DeviceAccess  a short-lived bearer credential minted at bind/refresh.
 *                 Used for every sync call.
 *   DeviceProof   an ES256 signature over method, path, body digest and a
 *                 timestamp. Layered on top of DeviceAccess so a leaked bearer
 *                 alone cannot be replayed against a different route.
 *
 * Why the routes never write business tables directly: SYNC_STATE_MACHINE.md 6
 * requires every mobile write to go through the canonical Zephyr service, so
 * ACL checks, dependency validation and audit entries cannot be bypassed by
 * coming in through the mobile plane. The sync bookkeeping (entity revision,
 * field revisions, change feed, replay guard) is written in the *same*
 * transaction as the service call.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const {
    MobileV1Store,
    MobileStoreError,
    PROOF_CHALLENGE_TTL_SEC,
    PROOF_MAX_ACTIVE_PER_DEVICE,
    PROOF_MAX_ISSUES_PER_MINUTE,
} = require('./mobile-v1-store');
const { MobileV1BlobManager } = require('./mobile-v1-blob-manager');
const { createEntityAdapters, projectPayload, extractSecrets, assertMaskAllowed } = require('./mobile-v1-entities');
const { SharedResourceApi, noStore } = require('./mobile-v1-shared');
const { MobileV1Wake } = require('./mobile-v1-wake');
const mobileCrypto = require('./mobile-v1-crypto');
const mobileProof = require('./mobile-v1-proof');
const secretCrypto = require('./secret-crypto');
const { HttpError } = require('./authz');

/** Link enrollment has no legacy Client Token; this marker is frozen on the bind row. */
const LINK_ENROLLMENT_TOKEN_ID = 'link-v2-enrollment';

/** Protocol versions this build speaks. A client outside this set is fatal. */
const PROTOCOL_VERSIONS = [1];
const MAX_OPS_PER_BATCH = 200;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 86400;
const TOMBSTONE_RETENTION_DAYS = 180;
const APPLIED_OP_RETENTION_DAYS = 180;
const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;
/* Blob bodies are capped so one device cannot fill the server disk through the
 * sync plane; 512 MiB covers encrypted backup archives by an order of magnitude. */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_BLOB_CHUNKS = Math.ceil(MAX_BLOB_BYTES / BLOB_CHUNK_BYTES);
const MAX_CONFLICT_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_CONFLICT_PAYLOAD_DEPTH = 16;
/** Push JSON is metadata, while large binary/content bodies use blob routes. */
const MAX_PUSH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PUSH_OPERATION_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PUSH_ID_LENGTH = 80;
const MAX_JSON_INPUT_DEPTH = 64;
const PUSH_REQUEST_FIELDS = new Set([
    'protocolVersion',
    'deviceId',
    'batchId',
    'baseCursor',
    'registryHash',
    'operations',
]);
const PUSH_REQUEST_REQUIRED_FIELDS = [...PUSH_REQUEST_FIELDS];
/** Kept in capabilities for old clients; v2 uses an exact server-issued timestamp. */
const PROOF_SKEW_SEC = PROOF_CHALLENGE_TTL_SEC;
/** Account-level operations that may exchange a password/TOTP for a grant. */
const SENSITIVE_ACTIONS = Object.freeze([
    'device.bind',
    'device.revoke',
    'token.reveal',
    'token.rotate',
    'token.delete',
    'token.resetAll',
    'backup.import',
]);

function nowMs() { return Date.now(); }

function publishAcceptedPushWake(changeBridge, ownerUserId, result) {
    const sequence = Number(result?.changeSeq);
    const owner = String(ownerUserId || '').trim();
    if (!owner || result?.status !== 'accepted' || !Number.isSafeInteger(sequence) || sequence <= 0) return false;
    if (typeof changeBridge?.publishCommittedChange !== 'function') return false;
    changeBridge.publishCommittedChange(owner, sequence);
    return true;
}

function timingSafeSecretEqual(left, right) {
    const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();
    return crypto.timingSafeEqual(digest(left), digest(right));
}

function normalizeSensitiveTargets(action, value) {
    if (!Array.isArray(value) || value.length > 200) return null;
    const targets = value.map(String);
    if (targets.some((item) => !item || item.length > 256 || item.includes('\u0000'))) return null;
    if (new Set(targets).size !== targets.length) return null;
    if (action === 'device.bind' && targets.length !== 2) return null;
    if (action === 'device.revoke' && targets.length !== 1) return null;
    return targets;
}

let validateFrozenSyncOperation = null;

function resolveMobileSchema(name) {
    const candidates = [
        path.join(__dirname, 'mobile-contracts', 'schemas', name),
        path.join(__dirname, 'zephyr_one', 'mobile', 'contracts', 'schemas', name),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('mobile schema not found: ' + name);
}

function frozenSyncOperationValidator() {
    if (validateFrozenSyncOperation) return validateFrozenSyncOperation;
    const operationSchema = JSON.parse(fs.readFileSync(resolveMobileSchema('sync-operation.schema.json'), 'utf8'));
    const envelopeSchema = JSON.parse(fs.readFileSync(resolveMobileSchema('secret-envelope.schema.json'), 'utf8'));
    const ajv = new Ajv2020({
        allErrors: true,
        strict: false,
        ownProperties: true,
    });
    ajv.addSchema(envelopeSchema);
    validateFrozenSyncOperation = ajv.compile(operationSchema);
    return validateFrozenSyncOperation;
}

function invalidPush(message, details = null) {
    return new MobileStoreError('invalid_request', message, 400, { details });
}

/**
 * Requires the in-memory value to have the same ownership semantics as parsed
 * JSON. This keeps internal callers and tests from satisfying a required field
 * through a prototype or smuggling an accessor that changes during validation.
 */
function assertOwnJsonData(root, label = 'request') {
    const pending = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    while (pending.length) {
        const { value, depth } = pending.pop();
        if (!value || typeof value !== 'object') continue;
        if (depth > MAX_JSON_INPUT_DEPTH) throw invalidPush(label + ' JSON nesting is too deep');
        if (seen.has(value)) throw invalidPush(label + ' must not contain cycles');
        seen.add(value);

        const prototype = Object.getPrototypeOf(value);
        const expected = Array.isArray(value) ? Array.prototype : Object.prototype;
        if (prototype !== expected && prototype !== null) {
            throw invalidPush(label + ' must contain only own JSON properties');
        }
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') throw invalidPush(label + ' must not contain symbol properties');
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                throw invalidPush(label + ' must not contain accessors');
            }
            pending.push({ value: descriptor.value, depth: depth + 1 });
        }
    }
}

function jsonBytes(value, label) {
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new Error('not JSON');
        return Buffer.byteLength(encoded, 'utf8');
    } catch {
        throw invalidPush(label + ' must be JSON serializable');
    }
}

function validationDetails(errors) {
    return {
        schema: 'sync-operation',
        violations: (errors || []).slice(0, 8).map((error) => ({
            path: String(error.instancePath || ''),
            keyword: String(error.keyword || 'invalid'),
        })),
    };
}

function validatePushRequest(body) {
    assertOwnJsonData(body, 'push request');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw invalidPush('push request must be an object');
    }
    for (const field of PUSH_REQUEST_REQUIRED_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body, field)) {
            throw invalidPush('push request is missing ' + field);
        }
    }
    for (const field of Object.keys(body)) {
        if (!PUSH_REQUEST_FIELDS.has(field)) throw invalidPush('unknown push request field', { field });
    }
    if (body.protocolVersion !== 1) {
        throw invalidPush('protocolVersion must be 1');
    }
    if (typeof body.deviceId !== 'string' || body.deviceId.length < 1
        || [...body.deviceId].length > MAX_PUSH_ID_LENGTH || body.deviceId.includes('\u0000')) {
        throw invalidPush('deviceId is invalid');
    }
    if (typeof body.batchId !== 'string' || body.batchId.length < 1
        || [...body.batchId].length > MAX_PUSH_ID_LENGTH || body.batchId.includes('\u0000')) {
        throw invalidPush('batchId is invalid');
    }
    if (!Number.isSafeInteger(body.baseCursor) || body.baseCursor < 0) {
        throw invalidPush('baseCursor must be a non-negative safe integer');
    }
    if (typeof body.registryHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.registryHash)) {
        throw invalidPush('registryHash is invalid');
    }
    if (!Array.isArray(body.operations)) throw invalidPush('operations must be an array');
    if (body.operations.length > MAX_OPS_PER_BATCH) {
        throw new MobileStoreError('payload_too_large', '\u5355\u6279\u64cd\u4f5c\u8d85\u8fc7\u4e0a\u9650', 413);
    }

    const validateOperation = frozenSyncOperationValidator();
    body.operations.forEach((operation, index) => {
        if (!validateOperation(operation)) {
            throw invalidPush('operation does not match the frozen schema', {
                operationIndex: index,
                ...validationDetails(validateOperation.errors),
            });
        }
        for (const field of ['opId', 'entityType', 'entityId']) {
            if (operation[field].includes('\u0000')) {
                throw invalidPush('operation identifier contains NUL', { operationIndex: index, field });
            }
        }
        const payloadBytes = jsonBytes(operation.payload, 'operation payload');
        if (payloadBytes > MAX_PUSH_OPERATION_PAYLOAD_BYTES) {
            throw new MobileStoreError('payload_too_large', 'operation payload is too large', 413, {
                details: {
                    operationIndex: index,
                    maxBytes: MAX_PUSH_OPERATION_PAYLOAD_BYTES,
                },
            });
        }
    });
    return body;
}

function pushBodyByteLength(req) {
    const declared = String(req.headers?.['content-length'] || '').trim();
    if (/^[0-9]+$/.test(declared) && Number(declared) > MAX_PUSH_BODY_BYTES) {
        return Number(declared);
    }
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody.length;
    return jsonBytes(req.body, 'push request');
}

function createPushJsonBodyParser() {
    return express.json({
        type: ['application/json'],
        limit: MAX_PUSH_BODY_BYTES,
        verify: (req, _res, buf) => { req.rawBody = buf; },
    });
}

function cloneJsonForPatch(value) {
    if (Array.isArray(value)) return value.map(cloneJsonForPatch);
    if (!value || typeof value !== 'object') return value;
    const copy = Object.create(null);
    for (const [key, child] of Object.entries(value)) copy[key] = cloneJsonForPatch(child);
    return copy;
}

function fieldPathsOverlap(left, right) {
    const a = String(left);
    const b = String(right);
    return a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
}

/**
 * Clamps a client-supplied page size into the range capabilities advertises.
 *
 * An absent or unparseable value becomes the default rather than an error: the
 * client is allowed to omit it, and rejecting a stray `pageSize=abc` would fail
 * a request that is otherwise perfectly answerable.
 */
function clampPageSize(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
    return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n)));
}


/**
 * The one error shape mobile v1 emits.
 *
 * error-registry.json rule 1: clients branch on `code` and never parse
 * `message`, so the code must come from the registry and the requestId must
 * always be present for support correlation.
 */
function sendError(res, status, code, message, { retryable = false, details = null, requestId } = {}) {
    const id = requestId || res.locals?.mobileRequestId || crypto.randomUUID();
    if (status === 429 && !res.getHeader('Retry-After')) res.setHeader('Retry-After', '5');
    return res.status(status).json({
        ok: false,
        error: { code, message, retryable, details, requestId: id },
    });
}

function payloadValueAtPath(payload, field) {
    let current = payload;
    for (const part of String(field || '').split('.')) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return { present: false, value: undefined };
        }
        current = current[part];
    }
    return { present: true, value: current };
}

function setPatchValueAtPath(patch, field, value) {
    const parts = String(field || '').split('.').filter(Boolean);
    if (!parts.length) return;
    let current = patch;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        if (!Object.prototype.hasOwnProperty.call(current, part)
            || !current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
            current[part] = Object.create(null);
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = cloneJsonForPatch(value);
}

function conflictProjectionPath(payload, source, field) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
        payload[field] = source[field];
        return;
    }
    const parts = String(field || '').split('.').filter(Boolean);
    let current = source;
    for (const part of parts) {
        if (!current || typeof current !== 'object' || Array.isArray(current)
            || !Object.prototype.hasOwnProperty.call(current, part)) return;
        current = current[part];
    }
    setPatchValueAtPath(payload, field, current);
}

function conflictPayloadWithinDepth(root) {
    const pending = [{ value: root, depth: 0 }];
    while (pending.length) {
        const { value, depth } = pending.pop();
        if (depth > MAX_CONFLICT_PAYLOAD_DEPTH) return false;
        if (!value || typeof value !== 'object') continue;
        const children = Array.isArray(value) ? value : Object.values(value);
        for (const child of children) pending.push({ value: child, depth: depth + 1 });
    }
    return true;
}

/**
 * Produces the only canonical row shape that may be persisted in a conflict.
 *
 * projectPayload remains the common secret/device-local projection seam. This
 * second allow-list is intentionally narrower than bootstrap: conflict rows
 * need only editable data, opaque-preserve data, and the typed account owner.
 */
function safeConflictPayload(spec, row, ownerUserId) {
    const ownerField = String(spec?.ownerField || 'ownerUserId');
    const editableFields = Array.isArray(spec?.editableFields) ? spec.editableFields.map(String) : [];
    if (!row || !ownerField || ownerField === 'serverId' || !editableFields.length) return null;

    let projected;
    try {
        projected = projectPayload(spec, row);
    } catch {
        return null;
    }
    if (!projected || typeof projected !== 'object' || Array.isArray(projected)
        || typeof projected[ownerField] !== 'string'
        || !projected[ownerField]
        || projected[ownerField] !== String(ownerUserId || '')) return null;

    const payload = { [ownerField]: projected[ownerField] };
    const allowedPaths = [...new Set([
        ...editableFields,
        ...((spec.opaquePreserveFields || []).map(String)),
    ])];
    for (const field of allowedPaths) conflictProjectionPath(payload, projected, field);

    try {
        const encoded = JSON.stringify(payload);
        if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_CONFLICT_PAYLOAD_BYTES) return null;
        const plain = JSON.parse(encoded);
        return conflictPayloadWithinDepth(plain) ? plain : null;
    } catch {
        return null;
    }
}

const INTERNAL_ERROR_MESSAGE = '\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef';

function loadPublicErrorCodes() {
    const candidates = [
        path.join(__dirname, 'mobile-contracts', 'registries', 'error-registry.json'),
        path.join(__dirname, 'zephyr_one', 'mobile', 'contracts', 'registries', 'error-registry.json'),
    ];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            return new Set((parsed.errors || []).map((entry) => entry.code));
        } catch {
            // Try the other supported runtime layout.
        }
    }
    /* Contract resolution failure already prevents MobileV1Api construction in
     * server.js. Keep module loading fail-closed too: no error text is public
     * until a registry explicitly declares its code stable. */
    return new Set();
}

const PUBLIC_ERROR_CODES = loadPublicErrorCodes();

/**
 * Only deliberately typed business errors may cross the mobile boundary.
 * SQLite/crypto/programming errors can carry table names, SQL text, paths or
 * secret-adjacent values in `message`, even when a dependency added a `code`
 * property of its own.
 */
function publicError(err) {
    const typed = err instanceof MobileStoreError || err instanceof HttpError;
    if (typed && PUBLIC_ERROR_CODES.has(err.code) && err.code !== 'internal_error') {
        return {
            status: Number(err.status) || 400,
            code: String(err.code),
            message: String(err.message || '\u8bf7\u6c42\u5931\u8d25'),
            retryable: err.retryable === true,
            details: err.details || null,
        };
    }
    return {
        status: 500,
        code: 'internal_error',
        message: INTERNAL_ERROR_MESSAGE,
        retryable: true,
        details: null,
    };
}

/** Maps a thrown error onto the registry envelope without leaking internals. */
function sendThrown(res, err, requestId) {
    const safe = publicError(err);
    if (safe.status === 429 && err && err.retryAfterSec) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(Number(err.retryAfterSec) || 1))));
    }
    return sendError(res, safe.status, safe.code, safe.message, {
        retryable: safe.retryable,
        details: safe.details,
        requestId,
    });
}

class MobileV1Api {
    /**
     * @param {object} opts
     * @param {object} opts.db raw SQLite handle (storage.rawDb())
     * @param {object} opts.storage storage.js module
     * @param {object} opts.sessionStore SessionStore, for the ZephyrSid plane
     * @param {object} opts.resourceService canonical connection/proxy/key writes
     * @param {object} opts.notesService canonical note writes
     * @param {object} opts.userSettingsService canonical settings writes
     * @param {object} opts.aiProviderService canonical AI provider writes
     * @param {object} opts.aiKnowledgeService canonical AI knowledge writes
     * @param {object} opts.aiHistoryService canonical persisted AI history writes
     * @param {object} opts.workspacePortableSyncService canonical portable workspace writes
     * @param {object} opts.serverMetadataServices canonical server settings/activity seams
     * @param {Function} opts.serverMetadataAuthorize explicit server metadata policy
     * @param {object} opts.fileAgentManager Client Token registry
     * @param {object} opts.authz ACL
     * @param {object} opts.resourceAclService canonical owner-only ACL metadata
     * @param {object} opts.clientTokenService canonical secret-free Client Token metadata
     * @param {object} opts.entityRegistry parsed entity-registry.json
     * @param {Function} [opts.verifySensitive] (user, secret) => {method}
     */
    constructor(opts) {
        this.db = opts.db;
        this.storage = opts.storage;
        this.sessionStore = opts.sessionStore;
        this.resourceService = opts.resourceService;
        this.notesService = opts.notesService;
        this.userSettingsService = opts.userSettingsService;
        this.aiProviderService = opts.aiProviderService;
        this.aiKnowledgeService = opts.aiKnowledgeService || this.userSettingsService?.aiKnowledgeService;
        this.aiHistoryService = opts.aiHistoryService;
        this.fileAgentManager = opts.fileAgentManager;
        this.authz = opts.authz;
        this.resourceAclService = opts.resourceAclService;
        this.clientTokenService = opts.clientTokenService;
        this.changeBridge = opts.changeBridge || null;
        this.entityRegistry = opts.entityRegistry;
        this.verifySensitive = opts.verifySensitive || null;
        this.log = opts.log || (() => {});

        /* The durable change bridge only needs this payload-free publisher
         * seam. Tests and alternate hosts may inject an equivalent broadcaster. */
        this.wake = opts.wake || new MobileV1Wake({ log: this.log });

        this.store = opts.store || new MobileV1Store({
            db: this.db,
            entityRegistry: this.entityRegistry,
            log: this.log,
        });
        this.blobs = opts.blobs || new MobileV1BlobManager({
            store: this.store,
            limits: opts.blobLimits,
            availableDiskBytes: opts.availableBlobDiskBytes,
            log: this.log,
        });

        this.entityByType = new Map();
        for (const entity of this.entityRegistry.entities || []) {
            this.entityByType.set(entity.type, entity);
        }

        /* Registry type -> canonical Zephyr service. Only types with a real
         * service are wired; the rest answer `unsupported_scope` so a client
         * never mistakes "not implemented" for "you own nothing of this type". */
        this.adapters = createEntityAdapters({
            resourceService: this.resourceService,
            notesService: this.notesService,
            userSettingsService: this.userSettingsService,
            storage: this.storage,
            db: this.db,
            store: this.store,
            changeBridge: opts.changeBridge,
            fileSyncConfigService: opts.fileSyncConfigService,
            entityRegistry: this.entityRegistry,
            aiProviderService: this.aiProviderService,
            aiKnowledgeService: this.aiKnowledgeService,
            aiHistoryService: this.aiHistoryService,
            workspacePortableSyncService: opts.workspacePortableSyncService,
            serverMetadataServices: opts.serverMetadataServices,
            serverMetadataAuthorize: opts.serverMetadataAuthorize,
            serverId: () => this.store.serverId(),
            resourceAclService: this.resourceAclService,
            clientTokenService: this.clientTokenService,
        });

        /* Bootstrap walks types in dependency order, so a client applying pages
         * in receipt order always has a proxy/sshKey/jumpHost before the
         * connection that points at it. */
        /* Shared-to-me lives in its own module because its rules are the
         * inverse of sync's: SHARED_RESOURCE_RESIDENCY.md forbids a shared
         * resource from entering the mirror at all, so it must never reach
         * the adapters above. Keeping it separate makes that structural
         * rather than a convention someone can forget. */
        this.shared = opts.shared || new SharedResourceApi({
            storage: this.storage,
            authz: this.authz,
            resourceService: this.resourceService,
            notesService: this.notesService,
            sharingService: opts.sharingService,
            fileAgentManager: this.fileAgentManager,
            store: this.store,
            serverEncryptionKey: () => this.serverEncryptionKey(),
            /* Where the relay transport is mounted, or null when the host
             * application did not mount one. The shared plane refuses
             * relay-strict outright in that case rather than returning a
             * URL nothing answers. */
            relayMount: opts.relayMount || null,
            log: this.log,
        });

        this.bootstrapTypes = (this.entityRegistry.entities || [])
            .filter((entity) => this.adapters.has(entity.type))
            .slice()
            .sort((a, b) => Number(a.dependencyOrder || 0) - Number(b.dependencyOrder || 0))
            .map((entity) => entity.type);
    }

    // ------------------------------------------------------------ helpers ---

    /** Fields a client may name in a fieldMask for this type. */
    editableFields(entityType) {
        const spec = this.entityByType.get(entityType);
        return spec ? new Set(spec.editableFields || []) : new Set();
    }

    /**
     * Fields a client may never name.
     *
     * Secrets travel as envelopes rather than mask entries; server-authority,
     * opaque-preserve and device-local fields are not the client's to set.
     */
    forbiddenFields(entityType) {
        const spec = this.entityByType.get(entityType);
        if (!spec) return new Set();
        return new Set([
            ...(spec.secretFields || []),
            ...(spec.serverAuthorityFields || []),
            ...(spec.opaquePreserveFields || []),
            ...(spec.deviceLocalFields || []),
        ]);
    }

    /**
     * Normalizes a server-authored mask to the same frozen allow-list clients enforce.
     *
     * Adapter masks may describe the broader downlink projection, including opaque-preserve
     * values. Those values are allowed in payload but never in fieldMask. Emitting them there makes
     * Android reject the entire page, so every bootstrap/change boundary filters through the
     * registry rather than trusting an adapter or a historical change row.
     */
    serverFieldMask(entityType, requested) {
        const editable = this.editableFields(entityType);
        const forbidden = this.forbiddenFields(entityType);
        const accepted = [];
        let requiresFullReplacement = false;
        for (const raw of Array.isArray(requested) ? requested : []) {
            const field = String(raw || '');
            const root = field.split(/[.\[]/, 1)[0];
            if (!field || forbidden.has(field) || forbidden.has(root)
                || (!editable.has(field) && !editable.has(root)) || accepted.includes(field)) {
                requiresFullReplacement = true;
                continue;
            }
            accepted.push(field);
        }
        /* An empty inbound change mask means "replace with this complete canonical projection" on
         * both Android and iOS. If even one requested field is opaque/unknown/duplicate, retaining
         * only the editable subset would silently lose the server-authored portion of a mixed
         * mutation. Full replacement preserves the entire projected row without naming a forbidden
         * field in the mask. */
        return requiresFullReplacement ? [] : accepted;
    }

    /**
     * The server's ML-KEM-768 public key, for devices to seal secrets to.
     *
     * Reuses the existing at-rest data keypair rather than minting a second
     * one. That keypair is already the thing that can read a stored secret, so
     * a separate mobile-only key would add a second copy of the same authority
     * without reducing anyone's blast radius.
     *
     * keyVersion is 1: the product has exactly one data keypair and no rotation
     * mechanism yet. When rotation lands, this must return the real version, and
     * the client already refuses an envelope whose keyVersion it does not know.
     */
    serverEncryptionKey() {
        try {
            const pair = secretCrypto.ensureKeyPair();
            return { publicKey: Buffer.from(pair.publicKey), keyVersion: 1 };
        } catch (err) {
            /* A missing data keypair must not take /capabilities down: every
             * non-secret sync path still works, and the client simply defers
             * operations that carry a secret. */
            this.log('[mobile-v1] server encryption key unavailable', { error: err.message });
            return null;
        }
    }

    capabilitiesPayload() {
        const serverKey = this.serverEncryptionKey();
        return {
            ok: true,
            protocolVersions: PROTOCOL_VERSIONS,
            registryHash: this.store.registryHash,
            minimumAppVersions: { android: '0.1.0', ios: '0.1.0' },
            limits: {
                maxOpsPerBatch: MAX_OPS_PER_BATCH,
                maxPageSize: MAX_PAGE_SIZE,
                defaultPageSize: DEFAULT_PAGE_SIZE,
                minIntervalSec: MIN_INTERVAL_SEC,
                maxIntervalSec: MAX_INTERVAL_SEC,
                blobChunkBytes: BLOB_CHUNK_BYTES,
                maxBlobBytes: MAX_BLOB_BYTES,
                /* The client uses these two to decide whether a cursor it has
                 * been holding offline can still be trusted. */
                tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS,
                appliedOpRetentionDays: APPLIED_OP_RETENTION_DAYS,
            },
            /* The device binds every envelope AAD to this exact string, so it
             * must come from the server rather than being invented locally:
             * a mismatch makes the ciphertext unopenable with no useful error. */
            serverId: this.store.serverId(),
            auth: {
                sidHeader: 'X-Zephyr-Sid',
                accessScheme: 'Bearer',
                proofHeader: 'X-Zephyr-Device-Proof',
                nonceHeader: 'X-Zephyr-Server-Nonce',
                timestampHeader: 'X-Zephyr-Proof-Timestamp',
                challengePath: '/api/mobile/v1/devices/proof-challenge',
                proofVersion: mobileProof.PROOF_VERSION,
                proofSkewSec: PROOF_SKEW_SEC,
                challengeTtlSec: PROOF_CHALLENGE_TTL_SEC,
                challengeMaxActivePerDevice: PROOF_MAX_ACTIVE_PER_DEVICE,
                challengeMaxIssuesPerMinute: PROOF_MAX_ISSUES_PER_MINUTE,
                signatureFormat: 'P1363',
                encryptionAlg: 'ML-KEM-768',
                signingAlg: mobileProof.PROOF_ALGORITHM,
            },
            serverEncryption: serverKey
                ? {
                    alg: mobileCrypto.KEM,
                    keyVersion: serverKey.keyVersion,
                    publicKey: serverKey.publicKey.toString('base64'),
                }
                /* Null rather than omitted: the client branches on presence to
                 * decide whether it may seal, and an absent key must read as
                 * "defer the secret", never as "send it in the clear". */
                : null,
            features: {
                /* Declared false rather than omitted. The client branches on
                 * these, and an absent key would read as "unknown" and make it
                 * probe an endpoint that is deliberately not implemented. */
                bidirectionalSync: true,
                sharedResources: true,
                linkEnrollment: true,
                /* False, and deliberately not aspirational: the lease
                 * endpoint exists but refuses, because the device-hosted
                 * ZFT2 provider it would attach to is not implemented.
                 * Declaring true here would make the client offer a
                 * share button that cannot work. */
                fileBridge: false,
                /* Blobs move through /api/mobile/v1/blobs/* per
                 * SYNC_STATE_MACHINE.md 11, so the flag advertises them. */
                blobTransfer: true,
                nearRealtimeWake: true,
            },
            wake: this.wake.capabilities('/api/mobile/v1/sync/wake'),
        };
    }

    // --------------------------------------------------------------- auth ---

    /** ZephyrSid plane: the human's own session. */
    requireSid(req, res, { passwordReady = false } = {}) {
        const sid = String(req.headers['x-zephyr-sid'] || '').trim();
        if (!sid) {
            sendError(res, 401, 'app_session_expired', '\u672a\u767b\u5f55\u6216\u4f1a\u8bdd\u5df2\u8fc7\u671f', { requestId: req.mobileRequestId });
            return null;
        }
        const session = this.sessionStore.resolve(sid);
        if (!session) {
            sendError(res, 401, 'app_session_expired', '\u4f1a\u8bdd\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55', { requestId: req.mobileRequestId });
            return null;
        }
        const user = this.storage.getUserBrief(session.userId);
        if (!user || user.status === 'deleted') {
            sendError(res, 401, 'app_session_expired', '\u8d26\u53f7\u4e0d\u5b58\u5728\u6216\u5df2\u5220\u9664', { requestId: req.mobileRequestId });
            return null;
        }
        if (user.status === 'suspended') {
            sendError(res, 403, 'account_suspended', '\u8d26\u53f7\u5df2\u88ab\u505c\u7528\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458', { requestId: req.mobileRequestId });
            return null;
        }
        /* Re-check both durable sources. A stale session flag must not bypass
         * a newly forced reset, and a stale user row must not bypass the
         * session's first-login requirement. */
        if (passwordReady && (session.mustChangePassword || user.defaultPassword)) {
            sendError(res, 403, 'must_change_password', '\u8bf7\u5148\u4fee\u6539\u9ed8\u8ba4\u5bc6\u7801', {
                details: { mustChangePassword: true },
                requestId: req.mobileRequestId,
            });
            return null;
        }
        req.mobileSidSession = session;
        return user;
    }

    /** Resolves Bearer access and all mutable account/token authorities. */
    requireDeviceAccess(req, res, { touch = false } = {}) {
        const header = String(req.headers.authorization || '');
        const match = header.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            sendError(res, 401, 'app_session_expired', '\u8bbf\u95ee\u51ed\u636e\u65e0\u6548\u6216\u5df2\u8fc7\u671f', { requestId: req.mobileRequestId });
            return null;
        }

        let row;
        try {
            row = this.store.resolveAccess(match[1].trim());
        } catch (err) {
            sendThrown(res, err, req.mobileRequestId);
            return null;
        }

        const user = this.storage.getUserBrief(row.owner_user_id);
        if (!user || user.status === 'deleted') {
            sendError(res, 403, 'account_unavailable', '\u8d26\u53f7\u4e0d\u53ef\u7528', { requestId: req.mobileRequestId });
            return null;
        }
        if (user.status === 'suspended') {
            sendError(res, 403, 'account_suspended', '\u8d26\u53f7\u5df2\u88ab\u505c\u7528\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458', { requestId: req.mobileRequestId });
            return null;
        }

        /* Legacy Client-Token bindings remain coupled to that token's lifetime. Link enrollment
         * deliberately has no Client Token; its sentinel row is revoked through mobile_devices and
         * must not be looked up in the legacy token registry. Doing so rejects every first
         * capabilities/bootstrap request with token_missing after an otherwise successful bind. */
        try {
            if (row.token_id !== LINK_ENROLLMENT_TOKEN_ID) {
                const tokens = this.fileAgentManager.listTokens(user.username);
                if (!tokens.some((t) => t.id === row.token_id)) {
                    sendError(res, 403, 'token_missing', '\u5173\u8054 Token \u5df2\u5220\u9664\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a', { requestId: req.mobileRequestId });
                    return null;
                }
            }
        } catch {
            // A token registry read failure must not be reported as "revoked".
            sendError(res, 503, 'server_unavailable', 'Token \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528', { retryable: true, requestId: req.mobileRequestId });
            return null;
        }

        if (touch) this.store.touchDevice(row.device_id, { appVersion: req.headers['x-zephyr-one-version'] });
        return { user, device: row };
    }

    /**
     * Device data-plane gate: Bearer access AND a server-issued, single-use
     * ES256 proof. There is intentionally no access-only downgrade path.
     */
    requireDevice(req, res) {
        const auth = this.requireDeviceAccess(req, res);
        if (!auth) return null;
        if (!this.verifyProof(req, auth.device)) {
            sendError(res, 401, 'device_proof_invalid', '\u8bbe\u5907\u7b7e\u540d\u65e0\u6548', { requestId: req.mobileRequestId });
            return null;
        }
        this.store.touchDevice(auth.device.device_id, { appVersion: req.headers['x-zephyr-one-version'] });
        return auth;
    }

    /** Verifies P1363 first, then atomically consumes the matching challenge. */
    verifyProof(req, row) {
        const proof = String(req.headers['x-zephyr-device-proof'] || '').trim();
        const timestampHeader = String(req.headers['x-zephyr-proof-timestamp'] || '').trim();
        const nonce = String(req.headers['x-zephyr-server-nonce'] || '').trim();
        if (!proof || !/^[0-9]{10}$/.test(timestampHeader) || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return false;
        const timestamp = Number(timestampHeader);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false;

        let jwk;
        try {
            jwk = JSON.parse(row.signing_public_jwk);
        } catch {
            return false;
        }
        if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
        const binding = mobileProof.requestBinding(req);
        if (!binding) return false;
        const payload = mobileProof.signedProofPayload({
            deviceId: row.device_id,
            ...binding,
            timestamp,
            nonce,
        });
        if (!mobileProof.verifyP1363({ jwk, payload, proof })) return false;
        try {
            return this.store.consumeProofChallenge({
                nonce,
                ownerUserId: row.owner_user_id,
                deviceId: row.device_id,
                ...binding,
                timestamp,
            });
        } catch {
            return false;
        }
    }

    /** Re-checks the mutable authorities behind an established wake stream. */
    isDeviceSessionLive(accessCredential, expectedDeviceId, expectedOwnerUserId) {
        try {
            const row = this.store.resolveAccess(accessCredential);
            if (String(row.device_id) !== String(expectedDeviceId)
                || String(row.owner_user_id) !== String(expectedOwnerUserId)) return false;

            const user = this.storage.getUserBrief(row.owner_user_id);
            if (!user || user.status === 'deleted' || user.status === 'suspended') return false;
            const tokens = this.fileAgentManager.listTokens(user.username);
            return tokens.some((token) => token.id === row.token_id);
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------- registry gate --

    /**
     * A client built against a different registry must stop, not guess.
     *
     * Silently accepting a mismatched hash is how a client ends up writing a
     * field the server classifies differently.
     */
    assertRegistry(res, given, requestId) {
        if (!given) return true;
        if (given === this.store.registryHash) return true;
        sendError(res, 409, 'registry_mismatch', '\u5b9e\u4f53\u6ce8\u518c\u8868\u7248\u672c\u4e0d\u4e00\u81f4\uff0c\u8bf7\u5347\u7ea7\u5ba2\u6237\u7aef', {
            details: { serverRegistryHash: this.store.registryHash },
            requestId,
        });
        return false;
    }


    // ------------------------------------------------------------ devices ---

    /**
     * Binds an authenticated account plus an existing Client Token to a device.
     *
     * SID-authenticated, never device-authenticated: this is the call that
     * *creates* the device credential, so accepting a device credential here
     * would let a compromised access token mint itself a fresh binding.
     */
    handleBind(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireSid(req, res, { passwordReady: true });
        if (!auth) return undefined;

        const body = req.body || {};
        const tokenId = String(body.tokenId || '').trim();
        if (!tokenId) {
            return sendError(res, 400, 'token_required', '\u8bf7\u5148\u5728\u4e3b\u7aef\u521b\u5efa Client Token', { requestId });
        }
        const deviceId = String(body.deviceId || '').trim();
        const grant = String(req.headers['x-zephyr-sensitive-grant'] || '').trim();
        const tokenSecret = String(body.tokenSecret || '').trim();
        const bindReceipt = String(body.bindReceipt || '').trim();
        if (bindReceipt && !/^[A-Za-z0-9_-]{43}$/.test(bindReceipt)) {
            return sendError(res, 400, 'invalid_request', 'bindReceipt is invalid', { requestId });
        }
        if (body.bindingProtocolVersion != null && Number(body.bindingProtocolVersion) !== 2) {
            return sendError(res, 400, 'invalid_request', 'bindingProtocolVersion is unsupported', { requestId });
        }
        const hasGrant = /^[A-Za-z0-9_-]{43}$/.test(grant);
        if (!hasGrant && !tokenSecret) {
            return sendError(res, 403, 'sensitive_verification_required', '\u8be5\u64cd\u4f5c\u9700\u8981\u5148\u5b8c\u6210\u654f\u611f\u9a8c\u8bc1', { requestId });
        }

        if (!hasGrant) {
            /* A SID holder can create a new Client Token through the ordinary
             * settings API. Such a token is not an independent proof, so the
             * secret fallback is limited to tokens that predate this session. */
            let tokenRecord = null;
            try {
                tokenRecord = this.fileAgentManager
                    .listTokens(auth.username, { includeToken: true })
                    .find((token) => token.id === tokenId) || null;
            } catch {
                return sendError(res, 503, 'server_unavailable', 'Token \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528', { retryable: true, requestId });
            }
            const sessionCreatedAt = Number(req.mobileSidSession?.createdAt || 0);
            const tokenCreatedAt = Number(tokenRecord?.createdAt || 0);
            const secretIsIndependent = tokenSecret.length <= 512
                && tokenRecord !== null
                && sessionCreatedAt > 0
                && tokenCreatedAt > 0
                && tokenCreatedAt < sessionCreatedAt
                && timingSafeSecretEqual(tokenRecord?.token || '', tokenSecret);
            if (!secretIsIndependent) {
                return sendError(res, 403, 'sensitive_verification_required', '\u8be5\u64cd\u4f5c\u9700\u8981\u5148\u5b8c\u6210\u654f\u611f\u9a8c\u8bc1', { requestId });
            }
        }

        try {
            const requestFingerprint = MobileV1Store.bindRequestFingerprint(body);
            const bindTransaction = this.db.transaction(() => {
                let attempt;
                if (hasGrant) {
                    const claimed = this.store.claimBindAttempt({
                        ownerUserId: auth.userId,
                        deviceId,
                        tokenId,
                        grant,
                        receipt: bindReceipt,
                        requestFingerprint,
                    });
                    let tokens;
                    try {
                        tokens = this.fileAgentManager.listTokens(auth.username);
                    } catch {
                        throw new MobileStoreError('server_unavailable', 'Token \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528', 503, { retryable: true });
                    }
                    if (!tokens.length) {
                        throw new MobileStoreError('token_required', '\u8bf7\u5148\u5728\u4e3b\u7aef\u8bbe\u7f6e\u4e2d\u65b0\u589e Client Token', 400);
                    }
                    if (!tokens.some((token) => token.id === tokenId)) {
                        throw new MobileStoreError('token_not_found', 'Token \u4e0d\u5b58\u5728\u6216\u4e0d\u5c5e\u4e8e\u5f53\u524d\u8d26\u53f7', 404);
                    }
                    if (claimed.replay) return this.store.replayBindAttempt(claimed);
                    attempt = claimed.attempt;
                } else {
                    /* The legacy pre-session token-secret proof is one HTTP
                     * request, but still uses the conditional writer. */
                    attempt = this.store.beginBindAttempt({
                        ownerUserId: auth.userId,
                        deviceId,
                        tokenId,
                        requestId,
                    });
                    if (attempt.expectedBindingRevision !== 0
                        || attempt.expectedRefreshGeneration !== 0) {
                        throw new MobileStoreError(
                            'sensitive_verification_required',
                            'device rebind requires a server-issued verified attempt',
                            403,
                        );
                    }
                }
                return this.store.bindDevice({
                    ownerUserId: auth.userId,
                    ownerUsername: auth.username,
                    deviceId,
                    deviceName: body.deviceName,
                    platform: body.platform,
                    appVersion: body.appVersion,
                    tokenId,
                    keys: body.keys,
                    syncIntervalSec: body.syncIntervalSec,
                    attempt,
                    requestFingerprint,
                });
            });
            const bound = bindTransaction();
            noStore(res);
            return res.json({
                ok: true,
                device: this.store.devicePublic(bound.row),
                accessCredential: bound.accessCredential,
                accessExpiresAt: bound.accessExpiresAt,
                refreshCredential: bound.refreshCredential,
                registryHash: this.store.registryHash,
                bindingProtocolVersion: bound.bindingProtocolVersion,
                bindingRevision: bound.bindingRevision,
                bindingToken: bound.bindingToken,
                /* Always true on a fresh bind: the device has no mirror yet, and
                 * the client uses this to enter BOUND_NEEDS_BOOTSTRAP rather
                 * than asking for changes from cursor 0 it cannot interpret. */
                bootstrapRequired: true,
            });
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /**
     * Rotates the access credential using the single-use refresh credential.
     *
     * The refresh credential travels in the body, never as a bearer header, so
     * a captured Authorization header cannot be replayed to mint new access.
     */
    handleRefresh(req, res) {
        const requestId = req.mobileRequestId;
        const body = req.body || {};
        const deviceId = String(body.deviceId || '').trim();
        const refreshCredential = String(body.refreshCredential || '');
        if (!deviceId || !refreshCredential) {
            return sendError(res, 400, 'invalid_request', 'deviceId \u4e0e refreshCredential \u5fc5\u586b', { requestId });
        }
        try {
            const rotated = this.store.rotateRefresh(deviceId, refreshCredential);
            const row = this.store.getDeviceRow(deviceId);
            const access = this.store.mintAccess(row);
            return res.json({
                ok: true,
                device: this.store.devicePublic(row),
                accessCredential: access.accessCredential,
                accessExpiresAt: access.accessExpiresAt,
                refreshCredential: rotated.refreshCredential,
                registryHash: this.store.registryHash,
            });
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /**
     * Mints a short-lived proof challenge using Bearer access alone. This call
     * exposes no device or account data and cannot be used as a data-plane
     * downgrade: every target operation still requires the private-key proof.
     */
    handleProofChallenge(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDeviceAccess(req, res, { touch: true });
        if (!auth) return undefined;
        const body = req.body || {};
        const method = String(body.method || '').toUpperCase();
        const target = mobileProof.canonicalPath(body.path);
        const digest = String(body.bodySha256 || '').trim();
        const usage = target ? mobileProof.proofUsage(method, target) : null;
        if (!target || !usage || !mobileProof.decodeSha256(digest)
            || (body.usage !== undefined && String(body.usage) !== usage)) {
            return sendError(res, 400, 'invalid_request', 'proof challenge target is invalid', { requestId });
        }
        try {
            const issued = this.store.issueProofChallenge({
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                method,
                canonicalPath: target,
                bodySha256: digest,
                usage,
            });
            noStore(res);
            return res.json({
                ok: true,
                challenge: {
                    nonce: issued.nonce,
                    timestamp: issued.timestamp,
                    expiresAt: issued.expiresAt,
                    method,
                    canonicalPath: target,
                    bodySha256: digest,
                    usage,
                    algorithm: mobileProof.PROOF_ALGORITHM,
                    signatureFormat: 'P1363',
                    proofVersion: mobileProof.PROOF_VERSION,
                },
            });
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    handleListDevices(req, res) {
        const auth = this.requireSid(req, res);
        if (!auth) return undefined;
        const devices = this.store.listDeviceRows(auth.userId).map((row) => this.store.devicePublic(row));
        return res.json({ ok: true, devices });
    }

    handlePatchDevice(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireSid(req, res);
        if (!auth) return undefined;
        try {
            const row = this.store.patchDevice(auth.userId, req.params.deviceId, req.body || {});
            if (!row.enabled) this.wake.disconnectDevice(row.device_id);
            return res.json({ ok: true, ...this.store.devicePublic(row) });
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /**
     * Revokes a device. Requires a sensitive grant, not just a session.
     *
     * Revoking is the action that strands a device holding decrypted material,
     * so the error registry gives it its own gate: a stolen session cookie must
     * not be enough to cut off the owner's other devices.
     */
    handleDeleteDevice(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireSid(req, res);
        if (!auth) return undefined;

        const deviceId = String(req.params.deviceId || '');
        const grant = String(req.headers['x-zephyr-sensitive-grant'] || '');
        if (!grant) {
            return sendError(res, 403, 'sensitive_verification_required', '\u8be5\u64cd\u4f5c\u9700\u8981\u5148\u5b8c\u6210\u654f\u611f\u9a8c\u8bc1', { requestId });
        }
        try {
            this.store.consumeGrant({
                ownerUserId: auth.userId,
                action: 'device.revoke',
                targetIds: [deviceId],
                grant,
            });
            this.store.revokeDevice(auth.userId, deviceId, 'revoked_by_user');
            this.wake.disconnectDevice(deviceId);
            return res.json({ ok: true });
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    // --------------------------------------------------------- sensitive ----

    handleSensitiveVerify(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireSid(req, res, { passwordReady: true });
        if (!auth) return undefined;

        const body = req.body || {};
        const action = String(body.action || '');
        if (!SENSITIVE_ACTIONS.includes(action)) {
            return sendError(res, 400, 'invalid_request', '\u4e0d\u652f\u6301\u7684\u654f\u611f\u64cd\u4f5c', { requestId });
        }
        const targetIds = normalizeSensitiveTargets(action, body.targetIds);
        if (!targetIds) {
            return sendError(res, 400, 'invalid_request', '\u654f\u611f\u64cd\u4f5c\u76ee\u6807\u65e0\u6548', { requestId });
        }
        if (body.bindingProtocolVersion != null && Number(body.bindingProtocolVersion) !== 2) {
            return sendError(res, 400, 'invalid_request', 'bindingProtocolVersion is unsupported', { requestId });
        }
        if (!this.verifySensitive) {
            return sendError(res, 503, 'server_unavailable', '\u654f\u611f\u9a8c\u8bc1\u6682\u4e0d\u53ef\u7528', { retryable: true, requestId });
        }
        try {
            this.store.takeSensitiveVerificationAttempt(auth.userId);
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
        let bindAttempt = null;
        if (action === 'device.bind') {
            try {
                bindAttempt = this.store.beginBindAttempt({
                    ownerUserId: auth.userId,
                    tokenId: targetIds[0],
                    deviceId: targetIds[1],
                    requestId,
                });
            } catch (err) {
                return sendThrown(res, err, requestId);
            }
        }
        try {
            // Throws on a wrong password / TOTP code.
            const verified = this.verifySensitive(auth, String(body.secret || ''));
            if (!verified) throw new Error('verification rejected');
        } catch {
            if (bindAttempt) this.store.cancelBindAttempt(auth.userId, bindAttempt.attemptHash);
            return sendError(res, 403, 'sensitive_verification_failed', '\u9a8c\u8bc1\u5931\u8d25', { requestId });
        }
        try {
            const created = this.store.createGrant({
                ownerUserId: auth.userId,
                action,
                targetIds,
                requestId,
                bindAttemptHash: bindAttempt?.attemptHash || null,
            });
            noStore(res);
            return res.json({
                ok: true,
                grant: created.grant,
                expiresAt: created.expiresAt,
                action,
                targetHash: created.targetHash,
                ...(bindAttempt ? {
                    bindingProtocolVersion: 2,
                    bindAttempt: {
                        receipt: bindAttempt.receipt,
                        expectedBindingRevision: bindAttempt.expectedBindingRevision,
                        expectedRefreshGeneration: bindAttempt.expectedRefreshGeneration,
                        expiresAt: bindAttempt.expiresAt,
                    },
                } : {}),
            });
        } catch (err) {
            if (bindAttempt) this.store.cancelBindAttempt(auth.userId, bindAttempt.attemptHash);
            return sendThrown(res, err, requestId);
        }
    }

    // -------------------------------------------------------------- sync ----

    /**
     * Serves one bootstrap page.
     *
     * The snapshot cursor is captured on the first page and carried in the page
     * token, so a change committed midway through a multi-page bootstrap is not
     * silently missed: the client resumes the change feed from that exact
     * cursor and picks the write up as a normal change.
     */
    // -------------------------------------------------------------- blobs ---

    /**
     * Validates the content-addressed manifest (SYNC_STATE_MACHINE.md 11).
     *
     * `chunks` is the array of per-chunk SHA-256 hex digests, not a count: the
     * state machine requires each chunk to be verified individually, and the
     * count alone would not let the server do that.
     */
    validateBlobManifest(body) {
        const digest = String(body.sha256 || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(digest)) {
            throw new MobileStoreError('invalid_request', 'sha256 must be a 64-char hex digest', 400);
        }
        const size = Number(body.size);
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new MobileStoreError('invalid_request', 'size must be a non-negative integer', 400);
        }
        if (size > MAX_BLOB_BYTES) {
            throw new MobileStoreError('payload_too_large', 'blob exceeds the server size limit', 413, { details: { maxBlobBytes: MAX_BLOB_BYTES } });
        }
        const mime = String(body.mime || 'application/octet-stream');
        if (mime.length > 200 || /[\0\r\n]/.test(mime)) {
            throw new MobileStoreError('invalid_request', 'mime contains invalid characters', 400);
        }
        if (!Array.isArray(body.chunks)) {
            throw new MobileStoreError('invalid_request', 'chunks must be an array of per-chunk SHA-256 digests', 400);
        }
        const chunkHashes = body.chunks.map((h) => String(h).toLowerCase());
        const algorithm = String(body.chunkAlgorithm || body.algorithm || 'fixed');
        const chunkSizes = Array.isArray(body.chunkSizes) ? body.chunkSizes.map(Number) : [];
        const keyedIds = Array.isArray(body.keyedIds) ? body.keyedIds.map(String) : [];
        if (algorithm === 'fastcdc-gear-v1') {
            if (chunkHashes.length !== chunkSizes.length || chunkHashes.length > MAX_BLOB_CHUNKS * 64) {
                throw new MobileStoreError('invalid_request', 'CDC chunk count does not match sizes', 400);
            }
            if (chunkSizes.reduce((sum, value) => sum + value, 0) !== size) {
                throw new MobileStoreError('invalid_request', 'CDC chunk sizes do not sum to blob size', 400);
            }
            if (chunkSizes.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > BLOB_CHUNK_BYTES)) {
                throw new MobileStoreError('invalid_request', 'CDC chunk size exceeds server limit', 400);
            }
        } else {
            const expected = size === 0 ? 0 : Math.ceil(size / BLOB_CHUNK_BYTES);
            if (chunkHashes.length !== expected || chunkHashes.length > MAX_BLOB_CHUNKS) {
                throw new MobileStoreError('invalid_request', 'chunk count does not match size', 400, { details: { expectedChunks: expected, actualChunks: chunkHashes.length } });
            }
        }
        for (const h of chunkHashes) {
            if (!/^[0-9a-f]{64}$/.test(h)) {
                throw new MobileStoreError('invalid_request', 'chunk digests must be 64-char hex', 400);
            }
        }
        return {
            sha256: digest,
            size,
            mime,
            chunkHashes,
            encrypted: !!body.encrypted,
            chunkSizes,
            keyedIds,
            chunkAlgorithm: algorithm,
            merkle: body.merkle ? String(body.merkle) : null,
        };
    }

    async handleBlobUploadCreate(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        try {
            const manifest = this.validateBlobManifest(req.body || {});
            const status = await this.blobs.createUpload({
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                ...manifest,
                chunkBytes: manifest.chunkAlgorithm === 'fastcdc-gear-v1'
                    ? Math.max(1, ...(manifest.chunkSizes.length ? manifest.chunkSizes : [BLOB_CHUNK_BYTES]))
                    : BLOB_CHUNK_BYTES,
            });
            if (manifest.keyedIds.length) {
                const known = this.store.knownKeyedChunkIds(auth.user.userId, manifest.keyedIds);
                status.knownKeyedIds = [...known];
            }
            return res.json({ ok: true, upload: status });
        } catch (err) {
            return sendThrown(res, err, req.mobileRequestId);
        }
    }

    async handleBlobUploadStatus(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        try {
            const status = await this.blobs.getUploadStatus({
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                uploadId: String(req.params.uploadId || ''),
            });
            return res.json({ ok: true, upload: status });
        } catch (err) {
            return sendThrown(res, err, req.mobileRequestId);
        }
    }

    async handleBlobChunkUpload(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        if (!Buffer.isBuffer(req.body)) {
            return sendError(res, 400, 'invalid_request', 'chunk must be sent as application/octet-stream', { requestId: req.mobileRequestId });
        }
        try {
            const status = await this.blobs.uploadChunk({
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                uploadId: String(req.params.uploadId || ''),
                index: Number(req.params.index),
                bytes: req.body,
            });
            return res.json({ ok: true, upload: status });
        } catch (err) {
            return sendThrown(res, err, req.mobileRequestId);
        }
    }

    /**
     * Downloads a whole blob. Only completed blobs are served: an in-flight
     * upload has no final file, and answering with partial bytes would let a
     * client persist a corrupt copy under a good digest. The registered code
     * for "not fully here yet" is blob_missing_chunk with clientAction
     * resume_blob.
     */
    handleBlobDownload(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        const row = this.store.getBlob(auth.user.userId, String(req.params.sha256 || '').toLowerCase());
        if (!row) {
            return sendError(res, 409, 'blob_missing_chunk', 'blob is not fully uploaded to this server', { retryable: true, requestId: req.mobileRequestId });
        }
        res.setHeader('Content-Type', row.mime || 'application/octet-stream');
        res.setHeader('Content-Length', String(Number(row.size)));
        res.setHeader('X-Zephyr-Blob-Sha256', row.sha256);
        res.setHeader('Cache-Control', 'no-store');
        const stream = this.store.createBlobReadStream(row);
        stream.on('error', () => {
            if (!res.headersSent) {
                sendError(res, 500, 'internal_error', 'blob read failed', { retryable: true, requestId: req.mobileRequestId });
            } else {
                res.destroy();
            }
        });
        stream.pipe(res);
        return undefined;
    }

    /** Single-chunk download so an interrupted pull resumes per SYNC_STATE_MACHINE.md 11. */
    handleBlobChunkDownload(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        const row = this.store.getBlob(auth.user.userId, String(req.params.sha256 || '').toLowerCase());
        if (!row) {
            return sendError(res, 409, 'blob_missing_chunk', 'blob is not fully uploaded to this server', { retryable: true, requestId: req.mobileRequestId });
        }
        const index = Number(req.params.index);
        const count = Number(row.chunk_count);
        if (!Number.isInteger(index) || index < 0 || index >= count) {
            return sendError(res, 400, 'invalid_request', 'chunk index out of range', { requestId: req.mobileRequestId, details: { index, chunkCount: count } });
        }
        const chunkBytes = Number(row.chunk_bytes);
        const offset = index * chunkBytes;
        const length = Math.min(chunkBytes, Number(row.size) - offset);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(length));
        res.setHeader('X-Zephyr-Blob-Sha256', row.sha256);
        res.setHeader('X-Zephyr-Blob-Chunk-Index', String(index));
        res.setHeader('Cache-Control', 'no-store');
        const stream = this.store.createBlobReadStream(row, { start: offset, end: offset + length - 1 });
        stream.on('error', () => {
            if (!res.headersSent) {
                sendError(res, 500, 'internal_error', 'blob read failed', { retryable: true, requestId: req.mobileRequestId });
            } else {
                res.destroy();
            }
        });
        stream.pipe(res);
        return undefined;
    }

    handleBootstrap(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        try {
            return res.json(this.executeBootstrapForDevice(auth, {
                pageToken: req.query.pageToken,
                pageSize: req.query.pageSize,
            }));
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /* Transport-independent bootstrap page. Link and HTTP must share this exact
     * snapshot/token implementation or a device can observe two incompatible
     * generations depending on the transport used for a page. */
    executeBootstrapForDevice(auth, { pageToken = null, pageSize = null } = {}) {
        pageSize = clampPageSize(pageSize);
            const binding = {
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                generation: Number(auth.device.refresh_generation || 1),
                registryHash: this.store.registryHash,
                typeOrder: this.bootstrapTypes,
            };
            const firstPageRows = new Map();
            const readRows = (typeIndex) => {
                if (firstPageRows.has(typeIndex)) return firstPageRows.get(typeIndex);
                const entityType = this.bootstrapTypes[typeIndex];
                const spec = this.entityByType.get(entityType);
                const adapter = this.adapters.get(entityType);
                const listed = adapter.list(auth.user);
                if (listed != null && !Array.isArray(listed)) {
                    throw new Error('bootstrap adapter list must return an array');
                }
                const seen = new Set();
                const rows = (listed || []).map((row) => {
                    const rawId = adapter.idOf(row);
                    if (rawId == null || String(rawId).length === 0 || String(rawId).length > 2048) {
                        throw new Error('bootstrap adapter returned an invalid stable id');
                    }
                    const id = String(rawId);
                    if (seen.has(id)) throw new Error('bootstrap adapter returned a duplicate stable id');
                    seen.add(id);

                    const ownerField = String(spec.ownerField || 'ownerUserId');
                    const rowOwnerUserId = row && (row[ownerField] ?? row.ownerUserId ?? row.owner_user_id);
                    const expectedOwner = ownerField === 'serverId'
                        ? this.store.serverId()
                        : auth.user.userId;
                    if (String(rowOwnerUserId || '') !== String(expectedOwner)) {
                        throw new MobileStoreError(
                            'shared_residency_violation',
                            '\u5171\u4eab\u8d44\u6e90\u4e0d\u80fd\u8fdb\u5165\u79bb\u7ebf\u955c\u50cf',
                            409,
                        );
                    }
                    return { id, row };
                });
                rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
                return rows;
            };

            let cursorState;
            if (pageToken) {
                cursorState = this.store.openBootstrapToken(String(pageToken), binding);
            } else {
                const snapshotCursor = this.store.latestCursor(auth.user.userId);
                const upperBounds = this.bootstrapTypes.map((_, typeIndex) => {
                    const rows = readRows(typeIndex);
                    firstPageRows.set(typeIndex, rows);
                    return rows.length ? rows[rows.length - 1].id : null;
                });
                cursorState = this.store.beginBootstrapSnapshot({
                    bootstrapId: 'bs-' + crypto.randomUUID(),
                    snapshotCursor,
                    typeOrder: this.bootstrapTypes,
                    upperBounds,
                    ownerUserId: binding.ownerUserId,
                    deviceId: binding.deviceId,
                    generation: binding.generation,
                });
            }

            const entities = [];
            let typeIndex = cursorState.typeIndex;
            let afterEntityId = cursorState.afterEntityId;

            while (typeIndex < this.bootstrapTypes.length && entities.length < pageSize) {
                const entityType = this.bootstrapTypes[typeIndex];
                const spec = this.entityByType.get(entityType);
                const adapter = this.adapters.get(entityType);
                const upperBound = cursorState.upperBounds[typeIndex];
                if (upperBound == null) {
                    typeIndex += 1;
                    afterEntityId = null;
                    continue;
                }

                const rows = readRows(typeIndex).filter(({ id }) => (
                    (afterEntityId == null || id > afterEntityId) && id <= upperBound
                ));
                let consumedType = true;
                for (const { id: rowId, row } of rows) {
                    if (entities.length >= pageSize) {
                        consumedType = false;
                        break;
                    }
                    entities.push({
                        changeSeq: cursorState.snapshotCursor,
                        entityType,
                        entityId: rowId,
                        action: 'upsert',
                        revision: adapter.revisionOf(row),
                        actorDeviceId: null,
                        /* Every SyncChange requires a positive timestamp. Canonical services use
                         * different event names, and old/config rows may predate updatedAt. Pick the
                         * best durable source at the wire boundary; 1 is the explicit legacy epoch,
                         * never wall-clock "now", so repeated bootstrap pages remain deterministic. */
                        changedAt: Math.max(
                            1,
                            Number(row.updatedAt) || 0,
                            Number(row.createdAt) || 0,
                            Number(row.time) || 0,
                            Number(row.occurredAt) || 0,
                            Number(row.finishedAt) || 0,
                            Number(row.startedAt) || 0,
                        ),
                        /* Bootstrap carries a complete canonical projection. The normal mask is
                         * the full editable set; if an adapter also names opaque/unknown fields,
                         * serverFieldMask returns [] to request a safe full replacement instead. */
                        fieldMask: this.serverFieldMask(
                            entityType,
                            adapter.fieldMaskOf
                                ? adapter.fieldMaskOf(row)
                                : (spec.editableFields || []).slice(),
                        ),
                        payload: projectPayload(spec, row),
                        ...this.ownedSecretEnvelopeFields({
                            spec,
                            row,
                            user: auth.user,
                            device: auth.device,
                            entityType,
                            entityId: rowId,
                            entityRevision: adapter.revisionOf(row),
                        }),
                    });
                    afterEntityId = rowId;
                }

                if (consumedType) {
                    typeIndex += 1;
                    afterEntityId = null;
                }
            }

            const complete = typeIndex >= this.bootstrapTypes.length;
            return {
                ok: true,
                bootstrapId: cursorState.bootstrapId,
                snapshotCursor: cursorState.snapshotCursor,
                nextPageToken: complete ? null : this.store.sealBootstrapToken({
                    ...cursorState,
                    typeIndex,
                    afterEntityId,
                }),
                complete,
                entities,
            };
    }

    handleChanges(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        try {
            const result = this.executeChangesForDevice(auth, {
                sinceCursor: Number(req.query.sinceCursor || 0),
                limit: req.query.limit,
            });
            return res.json(result);
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /* Transport-independent change-page fetch: the same logic the HTTP route and
     * the Link owned-sync bridge both run. Throws MobileStoreError on a bad or
     * expired cursor so each transport maps it onto its own error envelope. */
    executeChangesForDevice(auth, { sinceCursor, limit } = {}) {
        sinceCursor = Number(sinceCursor || 0);
        if (!Number.isSafeInteger(sinceCursor) || sinceCursor < 0) {
            throw new MobileStoreError('invalid_request', 'sinceCursor 必须是非负整数', 400);
        }
        const latestCursor = this.store.latestCursor(auth.user.userId);
        if (sinceCursor > latestCursor) {
            throw new MobileStoreError('cursor_invalid', '游标超过服务端最新位置', 409,
                { details: { bootstrapRequired: true, latestCursor } });
        }
        /* A cursor whose successor rows have been garbage collected cannot be
         * served: skipping the gap would leave the mirror permanently wrong, so
         * the device is told to bootstrap again instead. */
        if (this.store.isCursorExpired(auth.user.userId, sinceCursor)) {
            throw new MobileStoreError('cursor_expired', '游标已过期，需重新引导', 410,
                { details: { bootstrapRequired: true, latestCursor } });
        }
        const page = this.store.changePage(auth.user.userId, sinceCursor, clampPageSize(limit));
        /* A foreign row aborts the entire page before nextCursor reaches the
         * device. Advancing past it would leave shared data resident or the owned
         * mirror silently incomplete. */
        const changes = page.changes.map((change) => this.hydrateChange(auth.user, change, auth.device));
        return {
            ok: true,
            fromCursor: page.fromCursor,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            changes,
        };
    }

    /**
     * Fills in the payload the SyncChange schema requires for an upsert.
     *
     * `mobile_sync_changes` deliberately stores no payload: DATA_AND_MIGRATION.md
     * section 2 ends with "mobile_sync_changes BU CUN secret MINGWEN", and a feed
     * table holding entity bodies would be a second copy of every secret with its
     * own retention. So the body is projected from the canonical entity at read
     * time, through the same registry filter bootstrap uses.
     *
     * Consequence worth stating: the payload is the entity as it is *now*, not as
     * it was at `change.revision`. That is sound for this protocol because the
     * client dedupes by revision and only applies a change whose revision exceeds
     * its mirror - it never needs a historical body. It also means a row deleted
     * after the change was recorded yields an empty payload rather than a
     * resurrected one, which is the correct outcome: the later delete has its own
     * change row and wins.
     */
    /**
     * Opens the per-field secret envelopes on one push operation.
     *
     * Every envelope is bound by its AAD to (serverId, userId, deviceId,
     * entityType, entityId, fieldName, entityRevision, keyVersion). The AAD is
     * rebuilt here from the *server's* view of all eight values and compared
     * before any key material is used, so an envelope captured from another
     * device, field or entity cannot be replayed into this one.
     *
     * A field the registry does not classify as a secret is refused rather than
     * written: secretEnvelopes is not a second, unchecked write channel.
     */
    secretEnvelopeFields(spec, envelopes) {
        if (envelopes == null) return [];
        if (typeof envelopes !== 'object' || Array.isArray(envelopes)) {
            throw new MobileStoreError('invalid_request', 'secretEnvelopes \u5fc5\u987b\u662f\u5bf9\u8c61', 400);
        }
        const allowed = new Set(spec.secretFields || []);
        const fields = Object.keys(envelopes);
        for (const fieldName of fields) {
            if (!allowed.has(fieldName)) {
                throw new MobileStoreError(
                    'invalid_request',
                    '\u5b57\u6bb5 ' + fieldName + ' \u4e0d\u662f\u5bc6\u94a5\u5b57\u6bb5',
                    400,
                    { details: { field: fieldName } },
                );
            }
        }
        return fields;
    }

    /**
     * Validates the explicit intent to remove already-stored secret fields.
     *
     * A clear is intentionally not represented by an absent envelope: an
     * interrupted local deletion must still be able to revoke the old
     * canonical value on a later retry.  Field names are public protocol
     * metadata, but the values are never accepted outside a sealed envelope.
     */
    secretClearFields(spec, fields) {
        if (fields == null) return [];
        if (!Array.isArray(fields)) {
            throw new MobileStoreError('invalid_request', 'clearSecretFields must be an array', 400);
        }
        const allowed = new Set(spec.secretFields || []);
        const unique = new Set();
        for (const fieldName of fields) {
            if (typeof fieldName !== 'string' || !fieldName || !allowed.has(fieldName)) {
                throw new MobileStoreError('invalid_request', 'clearSecretFields contains an undeclared secret field', 400);
            }
            if (unique.has(fieldName)) {
                throw new MobileStoreError('invalid_request', 'clearSecretFields must not contain duplicates', 400);
            }
            unique.add(fieldName);
        }
        return [...unique];
    }

    /** Reject clear-text secret smuggling even when the key is not masked. */
    assertNoSecretPayload(spec, payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const secretFields = new Set(spec.secretFields || []);
        for (const fieldName of Object.keys(payload)) {
            if (secretFields.has(fieldName)) {
                throw new MobileStoreError('invalid_request', 'secret fields must use secretEnvelopes or clearSecretFields', 400, {
                    details: { field: fieldName },
                });
            }
        }
    }

    openSecretEnvelopes({ spec, entityType, entityId, deviceRow, envelopes, entityRevision }) {
        const values = {};
        const buffers = [];
        const release = () => { for (const buffer of buffers) buffer.fill(0); };

        const envelopeFields = this.secretEnvelopeFields(spec, envelopes);
        if (!envelopeFields.length) return { values, release };

        const serverKey = this.serverEncryptionKey();

        for (const fieldName of envelopeFields) {
            const envelope = envelopes[fieldName];
            if (!serverKey) {
                release();
                throw new MobileStoreError(
                    'server_unavailable',
                    '\u670d\u52a1\u7aef\u52a0\u5bc6\u5bc6\u94a5\u4e0d\u53ef\u7528\uff0c\u65e0\u6cd5\u63a5\u6536\u5bc6\u94a5\u5b57\u6bb5',
                    503,
                    { retryable: true },
                );
            }

            /* entityRevision is the revision this write is *creating*, which is
             * what the client sealed against. Accepting any other value would
             * let an envelope from an older revision be replayed forward. */
            const declared = envelope && envelope.entityRevision;
            if (!Number.isSafeInteger(declared) || declared <= 0 || declared !== entityRevision) {
                release();
                throw new MobileStoreError(
                    'revision_conflict',
                    'envelope entityRevision \u4e0e\u670d\u52a1\u7aef\u4e0b\u4e00\u7248\u672c\u4e0d\u4e00\u81f4',
                    409,
                    { details: { expectedRevision: entityRevision } },
                );
            }
            const declaredKeyVersion = envelope && envelope.keyVersion;
            if (!Number.isSafeInteger(declaredKeyVersion) || declaredKeyVersion !== serverKey.keyVersion) {
                release();
                throw new MobileStoreError('invalid_request', 'envelope keyVersion \u65e0\u6548', 400);
            }

            let aad;
            try {
                aad = mobileCrypto.secretAadBytes({
                    serverId: this.store.serverId(),
                    userId: deviceRow.owner_user_id,
                    deviceId: deviceRow.device_id,
                    entityType,
                    entityId,
                    fieldName,
                    entityRevision: declared,
                    keyVersion: declaredKeyVersion,
                });
            } catch (err) {
                release();
                throw new MobileStoreError('invalid_request', 'envelope AAD \u65e0\u6cd5\u6784\u9020', 400);
            }

            let plaintext;
            try {
                plaintext = mobileCrypto.openEnvelope({
                    envelope,
                    privateKey: secretCrypto.ensureKeyPair().secretKey,
                    expectedAad: aad,
                });
            } catch (err) {
                release();
                /* Deliberately not retryable and deliberately not detailed: a
                 * failure here is either tampering or a key mismatch, and
                 * neither is fixed by sending the same bytes again. */
                throw new MobileStoreError(
                    'invalid_request',
                    '\u5bc6\u94a5\u5c01\u88c5\u65e0\u6cd5\u89e3\u5f00',
                    400,
                    { details: { field: fieldName } },
                );
            }

            buffers.push(plaintext);
            values[fieldName] = plaintext.toString('utf8');
        }

        return { values, release };
    }

    hydrateChange(user, change, device = null) {
        const spec = this.entityByType.get(change.entityType);
        const adapter = this.adapters.get(change.entityType);
        if (!spec || !adapter) {
            /* An entity type with no adapter cannot be projected. Emitting an
             * empty payload would look like "this entity has no fields"; naming
             * the gap lets the client skip the row instead of mirroring nothing. */
            return { ...change, payload: {}, unsupported: true };
        }

        const tombstoneOwner = change.tombstone && String(change.tombstone.ownerUserId || '');
        const residency = typeof adapter.residency === 'function'
            ? adapter.residency(user, change.entityId)
            : 'missing';
        if (residency === 'foreign'
            || (tombstoneOwner && tombstoneOwner !== String(user.userId))) {
            throw new MobileStoreError(
                'shared_residency_violation',
                '\u5171\u4eab\u8d44\u6e90\u4e0d\u80fd\u8fdb\u5165\u79bb\u7ebf\u955c\u50cf',
                409,
            );
        }
        if (change.action === 'delete') return change;

        const safeChange = {
            ...change,
            fieldMask: this.serverFieldMask(change.entityType, change.fieldMask),
        };
        let row = null;
        try {
            row = adapter.read(user, change.entityId);
        } catch {
            row = null;
        }
        if (!row) {
            /* A live change whose canonical row is gone, or whose owner key
             * does not match the bound account (legacy activity rows store
             * username in userId). Emitting an empty payload would fail
             * residency on the client and freeze the cursor. Mark the row
             * skippable the same way an unknown type is skipped. */
            return { ...safeChange, payload: {}, unsupported: true };
        }
        const payload = projectPayload(spec, row);
        /* Presence flags stay in the payload. Re-sealing an unchanged secret
         * at a later entity revision is what made One fail the whole page
         * with internal_error after the first successful sync.
         *
         * Empty fieldMask is a full replacement (bootstrap / opaque mutation)
         * and must reseal. A secret field whose stored field-revision equals
         * this change.revision was mutated by this write and must reseal.
         * Name/host/tag patches leave secret field-revisions behind, so they
         * keep hasPassword=true and omit secretEnvelopes. */
        const secretFields = spec.secretFields || [];
        const mask = Array.isArray(safeChange.fieldMask) ? safeChange.fieldMask : [];
        const secretTouched = secretFields.some((field) => {
            let rev = null;
            try {
                if (this.store && typeof this.store.fieldRevision === 'function') {
                    rev = this.store.fieldRevision(
                        user.userId, change.entityType, change.entityId, field,
                    );
                }
            } catch {
                rev = null;
            }
            return Number(rev) === Number(change.revision);
        });
        const needsSecretDownlink = secretFields.length > 0 && (
            mask.length === 0 || secretTouched
        );
        return {
            ...safeChange,
            payload,
            ...(needsSecretDownlink ? this.ownedSecretEnvelopeFields({
                spec,
                row,
                user,
                device,
                entityType: change.entityType,
                entityId: change.entityId,
                entityRevision: change.revision,
            }) : {}),
        };
    }

    deviceEncryptionPublicKey(device) {
        const raw = device && device.encryption_public_key;
        if (!raw) return null;
        const key = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        return key.length === mobileCrypto.MLKEM768_PUBLIC_KEY_BYTES ? key : null;
    }

    /**
     * Seals stored secrets to the bound device's ML-KEM public key.
     *
     * One's mirror writer requires a boolean presence flag for every registry
     * secret field, and a matching envelope whenever that flag is true. Web
     * library rows used to send `******` / `hasPassword=true` with no envelope,
     * which aborted the entire bootstrap page as soon as the account had a
     * real connection. Downlink uses the same envelope suite as uplink, bound
     * to this deviceId so a captured ciphertext cannot be opened on another
     * handset.
     */
    ownedSecretEnvelopeFields({ spec, row, user, device, entityType, entityId, entityRevision }) {
        const secrets = extractSecrets(spec, row);
        const fields = Object.keys(secrets);
        if (!fields.length) return {};

        const publicKey = this.deviceEncryptionPublicKey(device);
        if (!publicKey) {
            throw new MobileStoreError(
                'server_unavailable',
                '\u8bbe\u5907\u52a0\u5bc6\u516c\u94a5\u4e0d\u53ef\u7528\uff0c\u65e0\u6cd5\u4e0b\u53d1\u5bc6\u94a5',
                503,
                { retryable: true },
            );
        }

        const serverKey = this.serverEncryptionKey();
        if (!serverKey) {
            throw new MobileStoreError(
                'server_unavailable',
                '\u670d\u52a1\u7aef\u52a0\u5bc6\u5bc6\u94a5\u4e0d\u53ef\u7528\uff0c\u65e0\u6cd5\u4e0b\u53d1\u5bc6\u94a5',
                503,
                { retryable: true },
            );
        }
        const keyVersion = Number(serverKey.keyVersion);
        const envelopes = {};
        for (const fieldName of fields) {
            const plaintext = Buffer.from(String(secrets[fieldName]), 'utf8');
            /* Bind AAD to the last revision that mutated this secret field,
             * not the entity revision. A later name/host edit bumps the
             * entity revision; resealing the unchanged password under that
             * new number makes One open the envelope with the wrong AAD and
             * freeze the whole change page. */
            const fieldRevision = this.store.fieldRevision(
                user.userId, entityType, entityId, fieldName,
            ) || Number(entityRevision) || 1;
            try {
                const aad = mobileCrypto.secretAadBytes({
                    serverId: this.store.serverId(),
                    userId: user.userId,
                    deviceId: device.device_id,
                    entityType,
                    entityId: String(entityId),
                    fieldName,
                    entityRevision: fieldRevision,
                    keyVersion,
                });
                envelopes[fieldName] = mobileCrypto.sealEnvelope({
                    plaintext,
                    publicKey,
                    aad,
                    keyVersion,
                    entityRevision: fieldRevision,
                });
            } finally {
                plaintext.fill(0);
            }
        }
        return { secretEnvelopes: envelopes };
    }

    /**
     * Applies one push batch.
     *
     * Every operation runs inside the caller's transaction together with its
     * change-feed row and its applied-op record, which is what makes a replay
     * return the identical logical result instead of writing twice.
     */
    handlePush(req, res) {
        const requestId = req.mobileRequestId;
        try {
            const bodyBytes = pushBodyByteLength(req);
            if (bodyBytes > MAX_PUSH_BODY_BYTES) {
                throw new MobileStoreError('payload_too_large', 'push request body is too large', 413, {
                    details: { maxBytes: MAX_PUSH_BODY_BYTES },
                });
            }
        } catch (err) {
            return sendThrown(res, err, requestId);
        }

        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;

        const body = req.body;
        try {
            assertOwnJsonData(body, 'push request');
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.protocolVersion !== 1) {
            return sendError(res, 400, 'unsupported_protocol_version', '\u4e0d\u652f\u6301\u7684\u534f\u8bae\u7248\u672c', { requestId });
        }
        try {
            validatePushRequest(body);
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
        try {
            const result = this.executePushForDevice(auth, body, requestId);
            return res.json(result);
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /**
     * The transport-independent core of a push: preflight, run the batch, publish
     * the wake, finish the run, and return the exact result payload the HTTP route
     * produced. The HTTP route authenticates off the request then calls this; the
     * Link owned-sync bridge authenticates off the ZSL/2 session's attested device
     * and calls the same method, so browser, mobile and desktop clients share ONE
     * sync implementation and identical semantics.
     *
     * Throws MobileStoreError on validation/datastore failure; the caller maps that
     * onto its transport (HTTP status, or a sealed frame error on the Link channel).
     */
    executePushForDevice(auth, body, requestId = crypto.randomUUID()) {
        assertOwnJsonData(body, 'push request');
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.protocolVersion !== 1) {
            throw new MobileStoreError('unsupported_protocol_version', '不支持的协议版本', 400);
        }
        validatePushRequest(body);
        if (this.store.registryHash && body.registryHash && body.registryHash !== this.store.registryHash) {
            throw new MobileStoreError('registry_mismatch', '实体注册表版本不一致，请升级客户端', 409, {
                details: { serverRegistryHash: this.store.registryHash },
            });
        }
        if (body.deviceId !== auth.device.device_id) {
            throw new MobileStoreError('invalid_request', 'deviceId 与凭据不一致', 400);
        }
        const operations = body.operations;
        this.preflightPushOperations(operations);

        const ownerUserId = auth.user.userId;
        const batchId = body.batchId;
        const runId = this.store.startRun({
            ownerUserId,
            deviceId: auth.device.device_id,
            trigger: 'push',
            fromCursor: body.baseCursor,
            requestId,
        });

        const results = [];
        let conflicts = 0;
        let accepted = 0;

        for (const operation of operations) {
            let result;
            try {
                /* One transaction per operation, not per batch: a conflict on
                 * op 3 must not roll back the accepted op 2, because the client
                 * has already been told op 2 succeeded in this same response. */
                result = this.db.transaction(() => this.applyOperation({
                    ownerUserId,
                    user: auth.user,
                    deviceId: auth.device.device_id,
                    deviceRow: auth.device,
                    batchId,
                    operation,
                }))();
            } catch (err) {
                const safe = publicError(err);
                result = {
                    opId: String(operation && operation.opId || ''),
                    status: 'rejected',
                    error: {
                        ok: false,
                        error: {
                            code: safe.code,
                            message: safe.message,
                            retryable: safe.retryable,
                            details: safe.details,
                            requestId,
                        },
                    },
                };
            }
            /* This point is outside the per-operation transaction. Canonical
             * adapters normally queued the same cursor through their bridge;
             * the bridge/runtime dedupe it. The explicit post-commit seam also
             * covers adapters whose fallback feed append did not call a
             * canonical bridge, without ever publishing a rejected rollback. */
            if (result.status === 'accepted' && Number(result.changeSeq) > 0) {
                publishAcceptedPushWake(this.changeBridge, ownerUserId, result);
            }
            if (result.status === 'conflict') conflicts += 1;
            if (result.status === 'accepted') accepted += 1;
            results.push(result);
        }

        const serverCursor = this.store.latestCursor(ownerUserId);
        this.store.finishRun(runId, {
            state: 'completed',
            toCursor: serverCursor,
            pushed: accepted,
            conflicts,
        });

        return {
            ok: true,
            batchId,
            serverCursor,
            results,
            /* True when the feed has moved past what this device acked, which
             * includes the changes this very batch just created. */
            changesAvailable: serverCursor > Number(auth.device.last_acked_cursor || 0),
        };
    }

    /** Registry-dependent validation is also completed before startRun/BEGIN. */
    preflightPushOperations(operations) {
        for (const operation of operations) {
            const spec = this.entityByType.get(operation.entityType);
            if (!spec) continue;
            if (operation.action === 'upsert') assertMaskAllowed(spec, operation.fieldMask);
            this.assertNoSecretPayload(spec, operation.payload);
            this.secretEnvelopeFields(spec, operation.secretEnvelopes);
            this.secretClearFields(spec, operation.clearSecretFields);
        }
    }

    conflictServerPayload({ spec, adapter, user, entityId, current }) {
        if (!current) return null;
        try {
            if (typeof adapter.residency === 'function'
                && adapter.residency(user, entityId) !== 'owned') return null;
        } catch {
            return null;
        }
        return safeConflictPayload(spec, current, user?.userId);
    }

    /**
     * A deleted row has no live canonical projection. The version ledger is
     * owner-scoped, so the only safe conflict projection is the typed owner;
     * tombstones must never retain editable or secret values just to improve a
     * conflict response.
     */
    tombstoneConflictServerPayload(spec, ownerUserId) {
        const ownerField = String(spec?.ownerField || 'ownerUserId');
        return safeConflictPayload(spec, { [ownerField]: String(ownerUserId) }, ownerUserId);
    }

    /**
     * Delete and restore are whole-entity compare-and-set operations. Keep
     * their stale result on the existing conflict wire shape so current mobile
     * clients can persist it, but expose only an owner-scoped safe projection.
     */
    recordRevisionConflict({
        ownerUserId, user, deviceId, opId, batchId, entityType, entityId,
        spec, adapter, current, baseRevision, currentRevision,
    }) {
        const serverPayload = current
            ? this.conflictServerPayload({ spec, adapter, user, entityId, current })
            : this.tombstoneConflictServerPayload(spec, ownerUserId);
        if (!serverPayload) this.conflictPayloadUnavailable();
        const serverChangedFields = this.serverChangedFields(
            ownerUserId,
            entityType,
            entityId,
            baseRevision,
            [],
            spec,
        );
        return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
            opId,
            status: 'conflict',
            entityId,
            revision: currentRevision,
            conflict: {
                /* Frozen clients currently accept this standard conflict kind.
                 * An empty field set denotes a whole-entity CAS conflict. */
                reason: 'field_overlap',
                fields: [],
                currentRevision,
                serverChangedFields,
                serverPayload,
            },
        } });
    }

    hasFieldOverlap(ownerUserId, entityType, entityId, baseRevision, incomingFields) {
        if (typeof this.store.hasOverlap === 'function'
            && this.store.hasOverlap(ownerUserId, entityType, entityId, baseRevision, incomingFields)) return true;
        if (typeof this.store.fieldRevisions !== 'function') return false;
        const base = Number(baseRevision) || 0;
        const incoming = incomingFields.map(String);
        for (const [serverField, revision] of this.store.fieldRevisions(ownerUserId, entityType, entityId)) {
            if (Number(revision) <= base) continue;
            if (incoming.some((field) => fieldPathsOverlap(field, serverField))) return true;
        }
        return false;
    }

    /** Positive `clientModifiedAt` from the frozen SyncOperation schema; 0 means unknown. */
    clientModifiedAt(operation) {
        const value = Number(operation && operation.clientModifiedAt);
        return Number.isSafeInteger(value) && value > 0 ? value : 0;
    }

    /**
     * Last-write-wins for overlapping fields.
     *
     * Field revisions only serialize writes that already landed on this
     * server. Two devices that edited the same field while offline share no
     * such order, so the later wall-clock write (`clientModifiedAt` vs the
     * stamped `changed_at`) is the source of truth. Missing timestamps fail
     * closed to a conflict: guessing would silently drop a user's edit.
     */
    newerLocalWriteWins(ownerUserId, entityType, entityId, overlapFields, clientModifiedAt) {
        if (!(clientModifiedAt > 0) || !overlapFields.length) return false;
        if (typeof this.store.fieldWriteTimes !== 'function') return false;
        const times = this.store.fieldWriteTimes(ownerUserId, entityType, entityId);
        for (const field of overlapFields) {
            const serverAt = Number(times.get(String(field)) || 0);
            if (!(serverAt > 0) || !(clientModifiedAt > serverAt)) return false;
        }
        return true;
    }

    serverChangedFields(ownerUserId, entityType, entityId, baseRevision, fallback, spec) {
        const declared = [
            ...((spec?.editableFields || []).map(String)),
            ...((spec?.secretFields || []).map(String)),
        ];
        const isDeclared = (field) => declared.some((candidate) => (
            field === candidate || field.startsWith(candidate + '.')
        ));
        const safeFallback = fallback.map(String).filter(isDeclared).slice(0, 200);
        if (typeof this.store.fieldRevisions !== 'function') return safeFallback;
        try {
            const base = Number(baseRevision) || 0;
            const fields = [...this.store.fieldRevisions(ownerUserId, entityType, entityId)]
                .filter(([, revision]) => Number(revision) > base)
                .map(([field]) => String(field))
                .filter(isDeclared)
                .sort()
                .slice(0, 200);
            return fields.length ? fields : safeFallback;
        } catch {
            return safeFallback;
        }
    }

    conflictPayloadUnavailable() {
        throw new MobileStoreError(
            'cursor_invalid',
            'Conflict state cannot be projected safely; restart bootstrap',
            409,
            {
                details: {
                    reason: 'conflict_payload_unavailable',
                    bootstrapRequired: true,
                },
            },
        );
    }

    /**
     * Decides and applies a single operation. Runs inside a transaction.
     *
     * Ordering matters: after the immutable account/device tuple is verified,
     * the replay check precedes registry and payload validation. A duplicate
     * must not be reinterpreted under a registry that changed after its first
     * apply.
     */
    applyOperation({ ownerUserId, user, deviceId, deviceRow, batchId, operation }) {
        const opId = String(operation && operation.opId || '');
        if (!opId) throw new MobileStoreError('invalid_request', 'opId \u5fc5\u586b', 400);

        const hasSecretEnvelopes = Object.prototype.hasOwnProperty.call(operation, 'secretEnvelopes');
        const hasSecretClears = Object.prototype.hasOwnProperty.call(operation, 'clearSecretFields');
        const hasSecretIntent = hasSecretEnvelopes || hasSecretClears;
        const hasCompleteDeviceIdentity = !!String(deviceRow?.owner_user_id || '')
            && !!String(deviceRow?.device_id || '');
        const identityMatches = String(ownerUserId || '') === String(user?.userId || '')
            && String(ownerUserId || '') === String(deviceRow?.owner_user_id || '')
            && String(deviceId || '') === String(deviceRow?.device_id || '');
        /* The HTTP gate already resolves these values from one authenticated
         * device row. Keep the invariant explicit for every secret intent:
         * envelope AAD must never be rebuilt from a mixed account/device tuple
         * supplied by an alternate host or a future internal caller. */
        if ((hasSecretIntent || hasCompleteDeviceIdentity) && !identityMatches) {
            throw new MobileStoreError('device_proof_invalid', '\u8bbe\u5907\u7ed1\u5b9a\u4e0e\u8d26\u53f7\u4e0d\u5339\u914d', 401);
        }

        const replayed = this.store.findAppliedOp(ownerUserId, deviceId, opId);
        if (replayed) return { ...replayed, status: replayed.status === 'accepted' ? 'duplicate' : replayed.status };

        const entityType = String(operation.entityType || '');
        const entityId = String(operation.entityId || '');
        const action = String(operation.action || '');
        const spec = this.entityByType.get(entityType);
        if (!spec) {
            throw new MobileStoreError('unknown_entity_type', '\u672a\u77e5\u5b9e\u4f53\u7c7b\u578b', 400, { details: { entityType } });
        }
        const adapter = this.adapters.get(entityType);
        if (!adapter) {
            throw new MobileStoreError('unsupported_scope', '\u8be5\u5b9e\u4f53\u7c7b\u578b\u5c1a\u4e0d\u652f\u6301\u79fb\u52a8\u7aef\u5199\u5165', 400, { details: { entityType } });
        }
        if (!['upsert', 'delete', 'restore'].includes(action)) {
            throw new MobileStoreError('invalid_request', '\u672a\u77e5\u64cd\u4f5c\u7c7b\u578b', 400, { details: { action } });
        }

        const fieldMask = Array.isArray(operation.fieldMask) ? operation.fieldMask.map(String) : [];
        if (hasSecretEnvelopes && hasSecretClears) {
            throw new MobileStoreError('invalid_request', 'secretEnvelopes and clearSecretFields are mutually exclusive', 400);
        }
        const secretFieldMask = this.secretEnvelopeFields(spec, operation.secretEnvelopes);
        const clearSecretFields = this.secretClearFields(spec, operation.clearSecretFields);
        if (action !== 'upsert' && (secretFieldMask.length || clearSecretFields.length)) {
            throw new MobileStoreError('invalid_request', 'delete/restore cannot carry secret operations', 400);
        }
        const mutationFieldMask = [...new Set([...fieldMask, ...secretFieldMask, ...clearSecretFields])];
        if (action === 'upsert') {
            if (!fieldMask.length && !secretFieldMask.length && !clearSecretFields.length) {
                throw new MobileStoreError('invalid_request', 'upsert requires fieldMask or an explicit secret operation', 400);
            }
            assertMaskAllowed(spec, fieldMask);
        }

        const baseRevision = Number(operation.baseRevision || 0);
        const residency = typeof adapter.residency === 'function'
            ? adapter.residency(user, entityId)
            : null;
        if ((secretFieldMask.length || clearSecretFields.length) && residency === 'foreign') {
            throw new MobileStoreError(
                'resource_not_found_or_inaccessible',
                '\u8d44\u6e90\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u8bbf\u95ee',
                404,
            );
        }
        const current = adapter.read(user, entityId);
        if ((secretFieldMask.length || clearSecretFields.length) && current) {
            const ownerField = String(spec.ownerField || 'ownerUserId');
            const currentOwner = payloadValueAtPath(current, ownerField);
            if (!currentOwner.present || String(currentOwner.value || '') !== String(ownerUserId)) {
                throw new MobileStoreError(
                    'resource_not_found_or_inaccessible',
                    '\u8d44\u6e90\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u8bbf\u95ee',
                    404,
                );
            }
        }
        const version = this.store.getEntityVersion(ownerUserId, entityType, entityId);
        const currentRevision = current ? adapter.revisionOf(current) : Number(version && version.revision || 0);

        /* Every action is revision-bounded. In particular, delete/restore must
         * not accept a mirror revision the canonical server never issued. This
         * check remains after the replay lookup and inside the operation
         * transaction, preserving an already-issued receipt verbatim. */
        if (baseRevision > currentRevision) {
            throw new MobileStoreError('revision_conflict', 'baseRevision \u9ad8\u4e8e\u670d\u52a1\u7aef\u5f53\u524d\u7248\u672c', 409, {
                details: { baseRevision, currentRevision },
            });
        }

        /* A version row without its canonical entity cannot produce a safe
         * conflict snapshot. The device must rebuild from bootstrap instead of
         * treating an empty object as authoritative or recreating a stale row. */
        if (!current && version && !version.deleted_at) {
            this.conflictPayloadUnavailable();
        }

        /* A tombstone outranks an edit that was based on a revision older than
         * the delete: SYNC_STATE_MACHINE.md 9 makes delete win, and an explicit
         * restore is a new revision rather than an undo of history. */
        if (version && version.deleted_at && action !== 'restore') {
            if (action === 'delete') {
                return this.recordRevisionConflict({
                    ownerUserId, user, deviceId, opId, batchId, entityType, entityId,
                    spec, adapter, current, baseRevision, currentRevision,
                });
            }
            this.conflictPayloadUnavailable();
        }

        if ((action === 'delete' || action === 'restore') && baseRevision < currentRevision) {
            return this.recordRevisionConflict({
                ownerUserId, user, deviceId, opId, batchId, entityType, entityId,
                spec, adapter, current, baseRevision, currentRevision,
            });
        }

        if (action === 'upsert' && current && this.hasFieldOverlap(
            ownerUserId,
            entityType,
            entityId,
            baseRevision,
            mutationFieldMask,
        )) {
            const serverChangedFields = this.serverChangedFields(
                ownerUserId,
                entityType,
                entityId,
                baseRevision,
                mutationFieldMask,
                spec,
            );
            const overlapFields = mutationFieldMask.filter((field) => (
                serverChangedFields.some((serverField) => fieldPathsOverlap(field, serverField))
            ));
            const namedOverlap = overlapFields.length ? overlapFields : mutationFieldMask;
            if (!this.newerLocalWriteWins(
                ownerUserId,
                entityType,
                entityId,
                namedOverlap,
                this.clientModifiedAt(operation),
            )) {
                const serverPayload = this.conflictServerPayload({ spec, adapter, user, entityId, current });
                if (!serverPayload) this.conflictPayloadUnavailable();
                return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
                    opId,
                    status: 'conflict',
                    entityId,
                    revision: currentRevision,
                    conflict: {
                        reason: 'field_overlap',
                        fields: namedOverlap,
                        currentRevision,
                        serverChangedFields,
                        serverPayload,
                    },
                } });
            }
        }

        // ---- the write itself goes through the canonical service ----
        const mutationReceipt = {};
        const mutationContext = { actorDeviceId: deviceId, mutationReceipt };
        let saved;
        if (action === 'delete') {
            if (!current) {
                return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
                    opId, status: 'duplicate', entityId, revision: currentRevision,
                } });
            }
            adapter.remove(user, entityId, mutationContext);
        } else if (action === 'restore') {
            if (!adapter.restore) {
                throw new MobileStoreError('unsupported_scope', '\u8be5\u5b9e\u4f53\u7c7b\u578b\u4e0d\u652f\u6301\u6062\u590d', 400);
            }
            saved = adapter.restore(user, entityId, mutationContext);
        } else {
            const patch = Object.create(null);
            const payload = operation.payload && typeof operation.payload === 'object' ? operation.payload : {};
            this.assertNoSecretPayload(spec, payload);
            /* Only masked fields are applied. An unmasked key in the payload is
             * ignored rather than written, so a client cannot smuggle a field it
             * did not declare - which is what makes the overlap check sound. */
            for (const field of fieldMask) {
                const selected = payloadValueAtPath(payload, field);
                if (selected.present) setPatchValueAtPath(patch, field, selected.value);
            }
            /* Secret fields never travel in the payload. They arrive as
             * per-field ML-KEM envelopes sealed to this server's public key, so
             * the plaintext is opened here and merged into the same patch the
             * canonical service receives. A field named in secretEnvelopes is
             * deliberately *not* required to appear in fieldMask: the mask is
             * the client's declaration of editable fields, and the registry
             * forbids naming a secret there. */
            const openedSecrets = this.openSecretEnvelopes({
                spec,
                entityType,
                entityId,
                deviceRow,
                envelopes: operation.secretEnvelopes,
                entityRevision: currentRevision + 1,
            });
            Object.assign(patch, openedSecrets.values);
            /* All currently declared secret fields are textual values in their
             * canonical services. Clearing them in the same patch as the
             * revisioned write prevents an envelope-less retry from leaving a
             * stale server secret behind. */
            for (const field of clearSecretFields) patch[field] = '';

            try {
                mutationContext.forceMobileChange = secretFieldMask.length > 0 || clearSecretFields.length > 0;
                saved = current
                    ? adapter.update(user, entityId, patch, mutationContext)
                    : adapter.create(user, entityId, patch, mutationContext);
            } finally {
                /* Zero mutable plaintext and drop the immutable String
                 * references even when the canonical service rejects the write. */
                openedSecrets.release();
                for (const field of [...secretFieldMask, ...clearSecretFields]) delete patch[field];
                for (const field of secretFieldMask) delete openedSecrets.values[field];
            }
        }

        const revision = action === 'delete'
            ? currentRevision + 1
            : (saved ? adapter.revisionOf(saved) : currentRevision + 1);

        // ---- feed + version bookkeeping, same transaction ----
        const canonicalChangeSeq = Number(mutationReceipt.changeSeq || 0);
        const changeSeq = Number.isSafeInteger(canonicalChangeSeq) && canonicalChangeSeq > 0
            ? canonicalChangeSeq
            : this.store.appendChange({
                ownerUserId,
                entityType,
                entityId,
                action: action === 'delete' ? 'delete' : 'upsert',
                revision,
                fieldMask: action === 'delete' ? [] : fieldMask,
                actorDeviceId: deviceId,
                tombstone: action === 'delete' ? {
                    entityType,
                    entityId,
                    ownerUserId,
                    deletedRevision: revision,
                    deletedAt: Date.now(),
                    deletedBy: deviceId,
                    /* Name only: a tombstone must carry no secret, and the client
                     * needs something human-readable for the conflict UI. */
                    lastKnownName: String(current && (current.name || current.title) || ''),
                } : null,
            });

        this.store.setEntityVersion({
            ownerUserId,
            entityType,
            entityId,
            revision,
            deletedAt: action === 'delete' ? Date.now() : null,
        });
        /* Secret field names stay in the internal revision ledger so a stale
         * clear and a concurrent replace conflict deterministically. They are
         * deliberately absent from the public change fieldMask. */
        const revisionFields = mutationFieldMask;
        if (action !== 'delete' && revisionFields.length) {
            this.store.setFieldRevisions({
                ownerUserId,
                entityType,
                entityId,
                fields: revisionFields,
                revision,
                changedAt: this.clientModifiedAt(operation),
            });
        }

        return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
            opId, status: 'accepted', entityId, revision, changeSeq,
        } });
    }

    /** Stores the logical result so a replay is answered from it verbatim. */
    recordResult({ ownerUserId, deviceId, opId, batchId, result }) {
        this.store.recordAppliedOp({ ownerUserId, deviceId, opId, batchId, result });
        return result;
    }

    handleAck(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        try {
            const result = this.executeAckForDevice(auth, (req.body || {}).cursor);
            return res.json(result);
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    /* Transport-independent ack. Refuses a cursor the server never issued rather
     * than clamping, so a device can never skip changes forever. */
    executeAckForDevice(auth, cursor) {
        cursor = Number(cursor || 0);
        if (!Number.isFinite(cursor) || cursor < 0) {
            throw new MobileStoreError('invalid_request', 'cursor 必须是非负整数', 400);
        }
        const latest = this.store.latestCursor(auth.user.userId);
        if (cursor > latest) {
            throw new MobileStoreError('cursor_invalid', 'cursor 超过服务端游标', 409, { details: { latest } });
        }
        this.store.markSynced(auth.device.device_id, cursor);
        return { ok: true };
    }

    handleSyncNow(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        const ownerUserId = auth.user.userId;
        const deviceId = auth.device.device_id;

        /* The server does not pull on the device's behalf; it records the
         * request so the next round is attributable. The device is the only
         * party that can apply changes to its own mirror. */
        const runId = this.store.startRun({ ownerUserId, deviceId, trigger: 'manual', fromCursor: 0, requestId });
        this.store.finishRun(runId, { state: 'requested', toCursor: this.store.latestCursor(ownerUserId) });
        return res.json({ ok: true });
    }

    /**
     * Holds an authenticated SSE stream carrying cursor-only wake hints.
     * The proof is consumed during the HTTP upgrade; the stream then keeps
     * re-checking the mutable access, account and Client Token authorities.
     */
    handleWake(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;

        const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        const accessCredential = match ? match[1].trim() : '';
        try {
            const accepted = this.wake.subscribe({
                req,
                res,
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                currentCursor: () => this.store.latestCursor(auth.user.userId),
                isAuthorized: () => this.isDeviceSessionLive(
                    accessCredential,
                    auth.device.device_id,
                    auth.user.userId,
                ),
            });
            if (!accepted) {
                return sendError(res, 429, 'rate_limited', '\u8bbe\u5907\u5b9e\u65f6\u8fde\u63a5\u6570\u5df2\u8fbe\u4e0a\u9650', {
                    retryable: true,
                    requestId,
                });
            }
            return undefined;
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    handleSyncStatus(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        return res.json(this.executeSyncStatusForDevice(auth, requestId));
    }

    /* Transport-independent sync status. Pending is a client-side notion: the
     * server cannot see edits that have not been pushed yet, so it reports zero. */
    executeSyncStatusForDevice(auth, requestId = crypto.randomUUID()) {
        const row = auth.device;
        const last = this.store.lastRun(row.device_id);
        return {
            ok: true,
            state: row.revoked_at ? 'REVOKED' : (row.enabled ? 'IDLE' : 'UNBOUND'),
            lastAttemptAt: last ? Number(last.started_at) : null,
            lastSuccessAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
            cursor: Number(row.last_acked_cursor || 0),
            pendingCount: 0,
            conflictCount: last ? Number(last.conflicts || 0) : 0,
            lastError: last && last.error_code ? {
                ok: false,
                error: { code: last.error_code, message: '', retryable: false, requestId },
            } : null,
        };
    }

    mountRoutes(app) {
        const self = this;

        /* One requestId per request, echoed in every error envelope and stored
         * on sync runs so a user-visible failure can be traced. */
        app.use('/api/mobile/v1', (req, res, next) => {
            req.mobileRequestId = String(req.headers['x-zephyr-request-id'] || '').trim() || crypto.randomUUID();
            res.locals = res.locals || {};
            res.locals.mobileRequestId = req.mobileRequestId;
            res.setHeader('X-Zephyr-Request-Id', req.mobileRequestId);
            next();
        });

        // ---- capabilities: unauthenticated by contract ----
        app.get('/api/mobile/v1/capabilities', (req, res) => {
            res.json(self.capabilitiesPayload());
        });

        // ---- devices ----
        app.post('/api/mobile/v1/devices/bind', (req, res) => self.handleBind(req, res));
        app.post('/api/mobile/v1/devices/refresh', (req, res) => self.handleRefresh(req, res));
        app.post('/api/mobile/v1/devices/proof-challenge', (req, res) => self.handleProofChallenge(req, res));
        app.get('/api/mobile/v1/devices', (req, res) => self.handleListDevices(req, res));
        app.patch('/api/mobile/v1/devices/:deviceId', (req, res) => self.handlePatchDevice(req, res));
        app.delete('/api/mobile/v1/devices/:deviceId', (req, res) => self.handleDeleteDevice(req, res));

        // ---- sync ----
        app.get('/api/mobile/v1/sync/bootstrap', (req, res) => self.handleBootstrap(req, res));
        app.get('/api/mobile/v1/sync/changes', (req, res) => self.handleChanges(req, res));
        app.get('/api/mobile/v1/sync/wake', (req, res) => self.handleWake(req, res));
        app.post('/api/mobile/v1/sync/push',
            createPushJsonBodyParser(),
            (req, res) => self.handlePush(req, res));
        app.post('/api/mobile/v1/sync/ack', (req, res) => self.handleAck(req, res));
        app.post('/api/mobile/v1/sync/now', (req, res) => self.handleSyncNow(req, res));
        app.get('/api/mobile/v1/sync/status', (req, res) => self.handleSyncStatus(req, res));

        /* ---- blobs (SYNC_STATE_MACHINE.md 11) ----
         *
         * Content-addressed upload/download for bodies too large for the JSON
         * change feed. The chunk PUT needs the raw bytes, so it carries its own
         * parser; the proof verify hook re-captures rawBody here because the
         * global JSON parser never runs for octet-stream bodies. */
        app.post('/api/mobile/v1/blobs/uploads', (req, res) => self.handleBlobUploadCreate(req, res));
        app.get('/api/mobile/v1/blobs/uploads/:uploadId', (req, res) => self.handleBlobUploadStatus(req, res));
        app.put('/api/mobile/v1/blobs/uploads/:uploadId/chunks/:index',
            express.raw({
                type: ['application/octet-stream'],
                limit: BLOB_CHUNK_BYTES + 65536,
                verify: (req, _res, buf) => { req.rawBody = buf; },
            }),
            (req, res) => self.handleBlobChunkUpload(req, res));
        app.get('/api/mobile/v1/blobs/:sha256/chunks/:index', (req, res) => self.handleBlobChunkDownload(req, res));
        app.get('/api/mobile/v1/blobs/:sha256', (req, res) => self.handleBlobDownload(req, res));

        // ---- sensitive verification ----
        app.post('/api/mobile/v1/sensitive/verify', (req, res) => self.handleSensitiveVerify(req, res));

        /* Shared-resource and file-bridge operations are declared in the
         * contract but not implemented in this build. They answer 501 with a
         * registry code rather than falling through to the SPA catch-all,
         * which would return HTML and make the client report a parse error
         * instead of an unimplemented feature. */
        /* ---- shared-to-me, online only ----
         *
         * Every handler here re-authorises against the live ACL rather than
         * trusting anything the device holds: SHARED_RESOURCE_RESIDENCY.md 7
         * is explicit that push revoke is only an accelerator and that "no
         * revoke received" must never be read as "still permitted".
         *
         * Responses carry Cache-Control: no-store so a revoked grant cannot be
         * served from an intermediary after the server said no. */
        app.get('/api/mobile/v1/shared', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.listShared(auth.user, {
                    resourceType: req.query.type ? String(req.query.type) : null,
                }));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        app.get('/api/mobile/v1/shared/:resourceType/:resourceId', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.getShared(
                    auth.user,
                    String(req.params.resourceType),
                    String(req.params.resourceId),
                ));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        app.post('/api/mobile/v1/shared/:resourceType/:resourceId/invoke', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.invokeShared(
                    auth.user,
                    String(req.params.resourceType),
                    String(req.params.resourceId),
                    req.body || {},
                ));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        app.post('/api/mobile/v1/shared/connections/:connectionId/sessions', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.openConnectionSession(
                    auth.user,
                    auth.device,
                    String(req.params.connectionId),
                    req.body || {},
                ));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        app.post('/api/mobile/v1/shared/sessions/:sessionId/refresh', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.refreshSession(
                    auth.user,
                    auth.device,
                    String(req.params.sessionId),
                    (req.body || {}).clientSessionNonce,
                ));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        app.delete('/api/mobile/v1/shared/sessions/:sessionId', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.closeSession(
                    auth.user,
                    auth.device,
                    String(req.params.sessionId),
                ));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        app.post('/api/mobile/v1/file-bridge/lease', (req, res) => {
            const auth = self.requireDevice(req, res);
            if (!auth) return undefined;
            try {
                noStore(res);
                return res.json(self.shared.fileBridgeLease(auth.user, auth.device, req.body || {}));
            } catch (err) {
                return sendThrown(res, err, req.mobileRequestId);
            }
        });

        return app;
    }
}

module.exports = {
    MobileV1Api,
    PROTOCOL_VERSIONS,
    MAX_OPS_PER_BATCH,
    MAX_PUSH_BODY_BYTES,
    MAX_PUSH_OPERATION_PAYLOAD_BYTES,
    MAX_PUSH_ID_LENGTH,
    BLOB_CHUNK_BYTES,
    MAX_BLOB_BYTES,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    PROOF_SKEW_SEC,
    SENSITIVE_ACTIONS,
    assertOwnJsonData,
    validatePushRequest,
    fieldPathsOverlap,
    setPatchValueAtPath,
    createPushJsonBodyParser,
    sendError,
    publishAcceptedPushWake,
};
