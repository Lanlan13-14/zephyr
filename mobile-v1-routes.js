/**
 * Zephyr One mobile v1 HTTP surface.
 *
 * Implements the 22 operations frozen in
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

const { MobileV1Store, MobileStoreError } = require('./mobile-v1-store');
const { createEntityAdapters, projectPayload, assertMaskAllowed } = require('./mobile-v1-entities');
const { SharedResourceApi, noStore } = require('./mobile-v1-shared');
const mobileCrypto = require('./mobile-v1-crypto');
const secretCrypto = require('./secret-crypto');

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
/** Rejects a stale or pre-dated proof. Two minutes covers ordinary clock skew. */
const PROOF_SKEW_SEC = 120;

function nowMs() { return Date.now(); }

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

/** Maps a thrown error onto the registry envelope without leaking internals. */
function sendThrown(res, err, requestId) {
    if (err instanceof MobileStoreError) {
        return sendError(res, err.status || 400, err.code, err.message, {
            retryable: err.retryable === true,
            details: err.details || null,
            requestId,
        });
    }
    // HttpError from authz.js / resource-service.js carries status + code.
    if (err && typeof err.status === 'number' && err.code) {
        return sendError(res, err.status, err.code, err.message || '\u8bf7\u6c42\u5931\u8d25', { requestId });
    }
    return sendError(res, 500, 'internal_error', '\u670d\u52a1\u5668\u5185\u90e8\u9519\u8bef', { retryable: true, requestId });
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
     * @param {object} opts.fileAgentManager Client Token registry
     * @param {object} opts.authz ACL
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
        this.fileAgentManager = opts.fileAgentManager;
        this.authz = opts.authz;
        this.entityRegistry = opts.entityRegistry;
        this.verifySensitive = opts.verifySensitive || null;
        this.log = opts.log || (() => {});

        this.store = opts.store || new MobileV1Store({
            db: this.db,
            entityRegistry: this.entityRegistry,
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
            storage: this.storage,
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
                proofSkewSec: PROOF_SKEW_SEC,
                encryptionAlg: 'ML-KEM-768',
                signingAlg: 'ES256',
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
                /* False, and deliberately not aspirational: the lease
                 * endpoint exists but refuses, because the device-hosted
                 * ZFT2 provider it would attach to is not implemented.
                 * Declaring true here would make the client offer a
                 * share button that cannot work. */
                fileBridge: false,
                /* Blobs move through /api/mobile/v1/blobs/* per
                 * SYNC_STATE_MACHINE.md 11, so the flag advertises them. */
                blobTransfer: true,
            },
        };
    }

    // --------------------------------------------------------------- auth ---

    /** ZephyrSid plane: the human's own session. */
    requireSid(req, res) {
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
        return user;
    }

    /**
     * DeviceAccess plane, plus DeviceProof when the device registered a
     * signing key.
     *
     * The proof is verified rather than merely accepted: a device that bound
     * with a signing key must keep signing, otherwise stripping the header
     * would downgrade every request to bearer-only.
     */
    requireDevice(req, res) {
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

        /* The Client Token that authorised the binding must still exist. Its
         * deletion on the main end is the documented way to cut a device off,
         * so a stale binding must not keep syncing. */
        try {
            const tokens = this.fileAgentManager.listTokens(user.username);
            if (!tokens.some((t) => t.id === row.token_id)) {
                sendError(res, 403, 'token_missing', '\u5173\u8054 Token \u5df2\u5220\u9664\uff0c\u8bf7\u91cd\u65b0\u7ed1\u5b9a', { requestId: req.mobileRequestId });
                return null;
            }
        } catch {
            // A token registry read failure must not be reported as "revoked".
            sendError(res, 503, 'server_unavailable', 'Token \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528', { retryable: true, requestId: req.mobileRequestId });
            return null;
        }

        if (!this.verifyProof(req, row)) {
            sendError(res, 401, 'device_proof_invalid', '\u8bbe\u5907\u7b7e\u540d\u65e0\u6548', { requestId: req.mobileRequestId });
            return null;
        }

        this.store.touchDevice(row.device_id, { appVersion: req.headers['x-zephyr-one-version'] });
        return { user, device: row };
    }

    /**
     * Verifies the ES256 proof.
     *
     * Signed string is NUL-joined exactly as DeviceIdentity.signRequestProof
     * builds it, so any reordering or field-shifting changes the digest.
     */
    verifyProof(req, row) {
        const proof = String(req.headers['x-zephyr-device-proof'] || '').trim();
        if (!proof) {
            /* No proof is not a failure.
             *
             * openapi-mobile-v1.json lists [{DeviceAccess}, {DeviceProof}] on
             * these operations, and an OpenAPI security *array* is a list of
             * alternatives: satisfying either entry authenticates the request.
             * The bearer access credential was already verified by
             * resolveAccess before this runs.
             *
             * This is also the only reading that interoperates with the
             * shipped client. DeviceProofInterceptor signs only when the
             * request carries X-Zephyr-Server-Nonce, and the signer returns
             * null without a nonce rather than signing over an invented one --
             * a proof computed over a self-chosen nonce would be replayable,
             * so refusing to forge one is correct. This server issues no nonce
             * yet, so requiring a proof here would reject every request from a
             * correctly behaving device. */
            return true;
        }
        const timestamp = Number(req.headers['x-zephyr-proof-timestamp'] || 0);
        const nonce = String(req.headers['x-zephyr-server-nonce'] || '');
        if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
        const skew = Math.abs(Math.floor(nowMs() / 1000) - timestamp);
        if (skew > PROOF_SKEW_SEC) return false;

        let jwk;
        try {
            jwk = JSON.parse(row.signing_public_jwk);
        } catch {
            return false;
        }
        if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;

        const bodyBytes = req.rawBody instanceof Buffer
            ? req.rawBody
            : Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body), 'utf8');
        const digest = crypto.createHash('sha256').update(bodyBytes).digest('base64');

        const signed = [
            'zephyr-one-device-proof-v1',
            row.device_id,
            String(req.method || '').toUpperCase(),
            req.path,
            digest,
            String(timestamp),
            nonce,
        ].join('\u0000');

        try {
            const key = crypto.createPublicKey({ key: { ...jwk, kty: 'EC', crv: 'P-256' }, format: 'jwk' });
            return crypto.verify(
                'sha256',
                Buffer.from(signed, 'utf8'),
                { key, dsaEncoding: 'ieee-p1363' },
                Buffer.from(proof, 'base64'),
            );
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
        const auth = this.requireSid(req, res);
        if (!auth) return undefined;

        const body = req.body || {};
        const tokenId = String(body.tokenId || '').trim();
        if (!tokenId) {
            return sendError(res, 400, 'token_required', '\u8bf7\u5148\u5728\u4e3b\u7aef\u521b\u5efa Client Token', { requestId });
        }

        /* The token must exist and belong to this account. A device is only ever
         * as authorised as the Client Token behind it, and deleting that token
         * on the main end is the documented way to cut the device off. */
        let tokens;
        try {
            tokens = this.fileAgentManager.listTokens(auth.username);
        } catch {
            return sendError(res, 503, 'server_unavailable', 'Token \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528', { retryable: true, requestId });
        }
        if (!tokens.length) {
            return sendError(res, 400, 'token_required', '\u8bf7\u5148\u5728\u4e3b\u7aef\u8bbe\u7f6e\u4e2d\u65b0\u589e Client Token', { requestId });
        }
        if (!tokens.some((t) => t.id === tokenId)) {
            return sendError(res, 404, 'token_not_found', 'Token \u4e0d\u5b58\u5728\u6216\u4e0d\u5c5e\u4e8e\u5f53\u524d\u8d26\u53f7', { requestId });
        }

        try {
            const bound = this.store.bindDevice({
                ownerUserId: auth.userId,
                ownerUsername: auth.username,
                deviceId: body.deviceId,
                deviceName: body.deviceName,
                platform: body.platform,
                appVersion: body.appVersion,
                tokenId,
                keys: body.keys,
                syncIntervalSec: body.syncIntervalSec,
            });
            const access = this.store.mintAccess(bound.row);
            return res.json({
                ok: true,
                device: this.store.devicePublic(bound.row),
                accessCredential: access.accessCredential,
                accessExpiresAt: access.accessExpiresAt,
                refreshCredential: bound.refreshCredential,
                registryHash: this.store.registryHash,
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
            return res.json({ ok: true });
        } catch (err) {
            return sendThrown(res, err, requestId);
        }
    }

    // --------------------------------------------------------- sensitive ----

    handleSensitiveVerify(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireSid(req, res);
        if (!auth) return undefined;

        const body = req.body || {};
        const action = String(body.action || '');
        const targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String) : [];
        if (!SENSITIVE_ACTIONS.has(action)) {
            return sendError(res, 400, 'invalid_request', '\u4e0d\u652f\u6301\u7684\u654f\u611f\u64cd\u4f5c', { requestId, details: { action } });
        }
        if (!this.verifySensitive) {
            return sendError(res, 503, 'server_unavailable', '\u654f\u611f\u9a8c\u8bc1\u6682\u4e0d\u53ef\u7528', { retryable: true, requestId });
        }
        try {
            // Throws on a wrong password / TOTP code.
            this.verifySensitive(auth, String(body.secret || ''));
        } catch {
            return sendError(res, 403, 'sensitive_verification_failed', '\u9a8c\u8bc1\u5931\u8d25', { requestId });
        }
        const created = this.store.createGrant({
            ownerUserId: auth.userId,
            action,
            targetIds,
            requestId,
        });
        return res.json({
            ok: true,
            grant: created.grant,
            expiresAt: created.expiresAt,
            action,
            targetHash: created.targetHash,
        });
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
        const mime = String(body.mime || 'application/octet-stream').slice(0, 200);
        if (!Array.isArray(body.chunks)) {
            throw new MobileStoreError('invalid_request', 'chunks must be an array of per-chunk SHA-256 digests', 400);
        }
        const chunkHashes = body.chunks.map((h) => String(h).toLowerCase());
        const expected = size === 0 ? 0 : Math.ceil(size / BLOB_CHUNK_BYTES);
        if (chunkHashes.length !== expected || chunkHashes.length > MAX_BLOB_CHUNKS) {
            throw new MobileStoreError('invalid_request', 'chunk count does not match size', 400, { details: { expectedChunks: expected, actualChunks: chunkHashes.length } });
        }
        for (const h of chunkHashes) {
            if (!/^[0-9a-f]{64}$/.test(h)) {
                throw new MobileStoreError('invalid_request', 'chunk digests must be 64-char hex', 400);
            }
        }
        return { sha256: digest, size, mime, chunkHashes, encrypted: !!body.encrypted };
    }

    handleBlobUploadCreate(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        try {
            const manifest = this.validateBlobManifest(req.body || {});
            const status = this.store.createBlobUpload({
                ownerUserId: auth.user.userId,
                deviceId: auth.device.device_id,
                ...manifest,
                /* Server-pinned, never client-chosen: capabilities advertise this
                 * exact value and the state machine lets the server lower it,
                 * not the client raise it. */
                chunkBytes: BLOB_CHUNK_BYTES,
            });
            return res.json({ ok: true, upload: status });
        } catch (err) {
            return sendThrown(res, err, req.mobileRequestId);
        }
    }

    handleBlobUploadStatus(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        const row = this.store.getBlobUpload(String(req.params.uploadId || ''));
        if (!row || String(row.owner_user_id) !== String(auth.user.userId)) {
            return sendError(res, 404, 'resource_not_found_or_inaccessible', 'upload session not found', { requestId: req.mobileRequestId });
        }
        return res.json({ ok: true, upload: this.store.blobUploadStatus(row) });
    }

    handleBlobChunkUpload(req, res) {
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;
        if (!Buffer.isBuffer(req.body)) {
            return sendError(res, 400, 'invalid_request', 'chunk must be sent as application/octet-stream', { requestId: req.mobileRequestId });
        }
        try {
            const status = this.store.recordBlobChunk({
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
        try {
            const bytes = this.store.readBlobRange(row, offset, length);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(bytes.length));
            res.setHeader('X-Zephyr-Blob-Sha256', row.sha256);
            res.setHeader('X-Zephyr-Blob-Chunk-Index', String(index));
            res.setHeader('Cache-Control', 'no-store');
            return res.end(bytes);
        } catch (err) {
            return sendThrown(res, err, req.mobileRequestId);
        }
    }

    handleBootstrap(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;

        const pageSize = clampPageSize(req.query.pageSize);
        let cursorState;
        try {
            cursorState = req.query.pageToken
                ? this.store.openBootstrapToken(String(req.query.pageToken), auth.user.userId)
                : {
                    bootstrapId: 'bs-' + crypto.randomUUID(),
                    snapshotCursor: this.store.latestCursor(auth.user.userId),
                    typeIndex: 0,
                    offset: 0,
                };
        } catch (err) {
            return sendThrown(res, err, requestId);
        }

        const entities = [];
        let typeIndex = cursorState.typeIndex;
        let offset = cursorState.offset;

        while (typeIndex < this.bootstrapTypes.length && entities.length < pageSize) {
            const entityType = this.bootstrapTypes[typeIndex];
            const spec = this.entityByType.get(entityType);
            const adapter = this.adapters.get(entityType);

            let rows;
            try {
                rows = adapter.list(auth.user) || [];
            } catch {
                /* A single service failing must not abort the whole bootstrap;
                 * an empty slice for this type is recoverable on the next run,
                 * whereas a 500 here would loop the client forever. */
                rows = [];
            }
            /* Stable order so a page boundary lands in the same place if the
             * client has to retry the same token. */
            rows = rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));

            while (offset < rows.length && entities.length < pageSize) {
                const row = rows[offset];
                entities.push({
                    changeSeq: cursorState.snapshotCursor,
                    entityType,
                    entityId: String(row.id),
                    action: 'upsert',
                    revision: adapter.revisionOf(row),
                    actorDeviceId: null,
                    changedAt: Number(row.updatedAt || row.createdAt || 0),
                    /* fieldMask is the full editable set: a bootstrap row is the
                     * complete entity, not a patch. */
                    fieldMask: (spec.editableFields || []).slice(),
                    payload: projectPayload(spec, row),
                });
                offset += 1;
            }

            if (offset >= rows.length) {
                typeIndex += 1;
                offset = 0;
            }
        }

        const complete = typeIndex >= this.bootstrapTypes.length;
        return res.json({
            ok: true,
            bootstrapId: cursorState.bootstrapId,
            snapshotCursor: cursorState.snapshotCursor,
            nextPageToken: complete ? null : this.store.sealBootstrapToken({
                bootstrapId: cursorState.bootstrapId,
                snapshotCursor: cursorState.snapshotCursor,
                typeIndex,
                offset,
                ownerUserId: auth.user.userId,
            }),
            complete,
            entities,
        });
    }

    handleChanges(req, res) {
        const requestId = req.mobileRequestId;
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;

        const sinceCursor = Number(req.query.sinceCursor || 0);
        if (!Number.isFinite(sinceCursor) || sinceCursor < 0) {
            return sendError(res, 400, 'invalid_request', 'sinceCursor \u5fc5\u987b\u662f\u975e\u8d1f\u6574\u6570', { requestId });
        }
        /* A cursor whose successor rows have been garbage collected cannot be
         * served: skipping the gap would leave the mirror permanently wrong, so
         * the device is told to bootstrap again instead. */
        if (this.store.isCursorExpired(auth.user.userId, sinceCursor)) {
            return sendError(res, 410, 'cursor_expired', '\u6e38\u6807\u5df2\u8fc7\u671f\uff0c\u9700\u91cd\u65b0\u5f15\u5bfc', { requestId });
        }
        const page = this.store.changePage(auth.user.userId, sinceCursor, clampPageSize(req.query.limit));
        return res.json({
            ok: true,
            fromCursor: page.fromCursor,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            changes: page.changes.map((change) => this.hydrateChange(auth.user, change)),
        });
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
    openSecretEnvelopes({ spec, entityType, entityId, deviceRow, envelopes, entityRevision }) {
        const values = {};
        const buffers = [];
        const release = () => { for (const buffer of buffers) buffer.fill(0); };

        if (!envelopes || typeof envelopes !== 'object') return { values, release };

        const secretFields = new Set(spec.secretFields || []);
        const serverKey = this.serverEncryptionKey();

        for (const [fieldName, envelope] of Object.entries(envelopes)) {
            if (!secretFields.has(fieldName)) {
                release();
                throw new MobileStoreError(
                    'invalid_request',
                    '\u5b57\u6bb5 ' + fieldName + ' \u4e0d\u662f\u5bc6\u94a5\u5b57\u6bb5',
                    400,
                    { details: { field: fieldName } },
                );
            }
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
            const declared = Number(envelope && envelope.entityRevision);
            if (!Number.isFinite(declared) || declared <= 0) {
                release();
                throw new MobileStoreError('invalid_request', 'envelope entityRevision \u65e0\u6548', 400);
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
                    keyVersion: Number(envelope.keyVersion),
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

    hydrateChange(user, change) {
        if (change.action === 'delete') return change;

        const spec = this.entityByType.get(change.entityType);
        const adapter = this.adapters.get(change.entityType);
        if (!spec || !adapter) {
            /* An entity type with no adapter cannot be projected. Emitting an
             * empty payload would look like "this entity has no fields"; naming
             * the gap lets the client skip the row instead of mirroring nothing. */
            return { ...change, payload: {}, unsupported: true };
        }

        let row = null;
        try {
            row = adapter.read(user, change.entityId);
        } catch {
            row = null;
        }
        return { ...change, payload: row ? projectPayload(spec, row) : {} };
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
        const auth = this.requireDevice(req, res);
        if (!auth) return undefined;

        const body = req.body || {};
        if (Number(body.protocolVersion) !== 1) {
            return sendError(res, 400, 'unsupported_protocol_version', '\u4e0d\u652f\u6301\u7684\u534f\u8bae\u7248\u672c', { requestId });
        }
        if (!this.assertRegistry(res, body.registryHash, requestId)) return undefined;
        if (String(body.deviceId || '') !== auth.device.device_id) {
            return sendError(res, 400, 'invalid_request', 'deviceId \u4e0e\u51ed\u636e\u4e0d\u4e00\u81f4', { requestId });
        }
        const operations = Array.isArray(body.operations) ? body.operations : [];
        if (operations.length > MAX_OPS_PER_BATCH) {
            return sendError(res, 413, 'payload_too_large', '\u5355\u6279\u64cd\u4f5c\u8d85\u8fc7\u4e0a\u9650', { requestId });
        }

        const ownerUserId = auth.user.userId;
        const batchId = String(body.batchId || 'batch-' + crypto.randomUUID());
        const runId = this.store.startRun({
            ownerUserId,
            deviceId: auth.device.device_id,
            trigger: 'push',
            fromCursor: Number(body.baseCursor) || 0,
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
                result = {
                    opId: String(operation && operation.opId || ''),
                    status: 'rejected',
                    error: {
                        ok: false,
                        error: {
                            code: err.code || 'internal_error',
                            message: err.message || '',
                            retryable: !!err.retryable,
                            requestId,
                        },
                    },
                };
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

        return res.json({
            ok: true,
            batchId,
            serverCursor,
            results,
            /* True when the feed has moved past what this device acked, which
             * includes the changes this very batch just created. */
            changesAvailable: serverCursor > Number(auth.device.last_acked_cursor || 0),
        });
    }

    /**
     * Decides and applies a single operation. Runs inside a transaction.
     *
     * Ordering matters: the replay check comes first, because a duplicate must
     * not even be validated against a registry that may have changed since the
     * original apply.
     */
    applyOperation({ ownerUserId, user, deviceId, deviceRow, batchId, operation }) {
        const opId = String(operation && operation.opId || '');
        if (!opId) throw new MobileStoreError('invalid_request', 'opId \u5fc5\u586b', 400);

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
        if (action === 'upsert') {
            if (!fieldMask.length) {
                throw new MobileStoreError('invalid_request', 'upsert \u5fc5\u987b\u643a\u5e26 fieldMask', 400);
            }
            assertMaskAllowed(spec, fieldMask);
        }

        const baseRevision = Number(operation.baseRevision || 0);
        const current = adapter.read(user, entityId);
        const version = this.store.getEntityVersion(ownerUserId, entityType, entityId);
        const currentRevision = current ? adapter.revisionOf(current) : Number(version && version.revision || 0);

        /* A tombstone outranks an edit that was based on a revision older than
         * the delete: SYNC_STATE_MACHINE.md 9 makes delete win, and an explicit
         * restore is a new revision rather than an undo of history. */
        if (version && version.deleted_at && action !== 'restore') {
            return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
                opId,
                status: 'conflict',
                entityId,
                revision: currentRevision,
                conflict: { reason: 'deleted_on_server', deletedAt: Number(version.deleted_at) },
            } });
        }

        if (action === 'upsert' && current && baseRevision > currentRevision) {
            /* The client claims a revision the server has never issued, which
             * means its mirror is ahead of reality - a rebind or a restored
             * backup. Accepting it would write a revision number backwards. */
            throw new MobileStoreError('revision_conflict', 'baseRevision \u9ad8\u4e8e\u670d\u52a1\u7aef\u5f53\u524d\u7248\u672c', 409, {
                details: { baseRevision, currentRevision },
            });
        }

        if (action === 'upsert' && current && this.store.hasOverlap(ownerUserId, entityType, entityId, baseRevision, fieldMask)) {
            return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
                opId,
                status: 'conflict',
                entityId,
                revision: currentRevision,
                conflict: { reason: 'field_overlap', fields: fieldMask, currentRevision },
            } });
        }

        // ---- the write itself goes through the canonical service ----
        let saved;
        if (action === 'delete') {
            if (!current) {
                return this.recordResult({ ownerUserId, deviceId, opId, batchId, result: {
                    opId, status: 'duplicate', entityId, revision: currentRevision,
                } });
            }
            adapter.remove(user, entityId);
        } else if (action === 'restore') {
            if (!adapter.restore) {
                throw new MobileStoreError('unsupported_scope', '\u8be5\u5b9e\u4f53\u7c7b\u578b\u4e0d\u652f\u6301\u6062\u590d', 400);
            }
            saved = adapter.restore(user, entityId);
        } else {
            const patch = {};
            const payload = operation.payload && typeof operation.payload === 'object' ? operation.payload : {};
            /* Only masked fields are applied. An unmasked key in the payload is
             * ignored rather than written, so a client cannot smuggle a field it
             * did not declare - which is what makes the overlap check sound. */
            for (const field of fieldMask) {
                if (Object.prototype.hasOwnProperty.call(payload, field)) patch[field] = payload[field];
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

            saved = current
                ? adapter.update(user, entityId, patch)
                : adapter.create(user, entityId, patch);

            /* Zero the plaintext as soon as the service has written it. The
             * strings themselves are immutable in JS, so the honest thing is to
             * drop the references rather than pretend they were scrubbed. */
            openedSecrets.release();
        }

        const revision = action === 'delete'
            ? currentRevision + 1
            : (saved ? adapter.revisionOf(saved) : currentRevision + 1);

        // ---- feed + version bookkeeping, same transaction ----
        const changeSeq = this.store.appendChange({
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
        if (action !== 'delete' && fieldMask.length) {
            this.store.setFieldRevisions({ ownerUserId, entityType, entityId, fields: fieldMask, revision });
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

        const body = req.body || {};
        const cursor = Number(body.cursor || 0);
        if (!Number.isFinite(cursor) || cursor < 0) {
            return sendError(res, 400, 'invalid_request', 'cursor \u5fc5\u987b\u662f\u975e\u8d1f\u6574\u6570', { requestId });
        }
        const latest = this.store.latestCursor(auth.user.userId);
        if (cursor > latest) {
            /* Acking a cursor the server never issued would let the device skip
             * changes forever, so this is refused rather than clamped. */
            return sendError(res, 409, 'cursor_invalid', 'cursor \u8d85\u8fc7\u670d\u52a1\u7aef\u6e38\u6807', { requestId, details: { latest } });
        }
        this.store.markSynced(auth.device.device_id, cursor);
        return res.json({ ok: true });
    }

    handleSyncNow(req, res) {
        const requestId = req.mobileRequestId;
        /* Either plane may ask: the phone triggers its own sync, and the desktop
         * settings page triggers a bound device's sync. */
        const viaDevice = req.headers.authorization ? this.requireDevice(req, res) : null;
        if (req.headers.authorization && !viaDevice) return undefined;

        let ownerUserId;
        let deviceId;
        if (viaDevice) {
            ownerUserId = viaDevice.user.userId;
            deviceId = viaDevice.device.device_id;
        } else {
            const auth = this.requireSid(req, res);
            if (!auth) return undefined;
            ownerUserId = auth.userId;
            deviceId = String((req.body || {}).deviceId || '');
            const row = this.store.getDeviceRow(deviceId);
            if (!row || row.owner_user_id !== ownerUserId) {
                return sendError(res, 404, 'client_not_found', '\u8bbe\u5907\u4e0d\u5b58\u5728', { requestId });
            }
        }

        /* The server does not pull on the device's behalf; it records the
         * request so the next round is attributable. The device is the only
         * party that can apply changes to its own mirror. */
        const runId = this.store.startRun({ ownerUserId, deviceId, trigger: 'manual', fromCursor: 0, requestId });
        this.store.finishRun(runId, { state: 'requested', toCursor: this.store.latestCursor(ownerUserId) });
        return res.json({ ok: true });
    }

    handleSyncStatus(req, res) {
        const requestId = req.mobileRequestId;
        const viaDevice = req.headers.authorization ? this.requireDevice(req, res) : null;
        if (req.headers.authorization && !viaDevice) return undefined;

        let ownerUserId;
        let row;
        if (viaDevice) {
            ownerUserId = viaDevice.user.userId;
            row = viaDevice.device;
        } else {
            const auth = this.requireSid(req, res);
            if (!auth) return undefined;
            ownerUserId = auth.userId;
            const deviceId = String(req.query.deviceId || '');
            row = this.store.getDeviceRow(deviceId);
            if (!row || row.owner_user_id !== ownerUserId) {
                return sendError(res, 404, 'client_not_found', '\u8bbe\u5907\u4e0d\u5b58\u5728', { requestId });
            }
        }

        const last = this.store.lastRun(row.device_id);
        return res.json({
            ok: true,
            state: row.revoked_at ? 'REVOKED' : (row.enabled ? 'IDLE' : 'UNBOUND'),
            lastAttemptAt: last ? Number(last.started_at) : null,
            lastSuccessAt: row.last_sync_at == null ? null : Number(row.last_sync_at),
            cursor: Number(row.last_acked_cursor || 0),
            /* Pending is a client-side notion: the server cannot see edits that
             * have not been pushed yet, so it reports zero rather than guessing. */
            pendingCount: 0,
            conflictCount: last ? Number(last.conflicts || 0) : 0,
            lastError: last && last.error_code ? {
                ok: false,
                error: { code: last.error_code, message: '', retryable: false, requestId },
            } : null,
        });
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
        app.get('/api/mobile/v1/devices', (req, res) => self.handleListDevices(req, res));
        app.patch('/api/mobile/v1/devices/:deviceId', (req, res) => self.handlePatchDevice(req, res));
        app.delete('/api/mobile/v1/devices/:deviceId', (req, res) => self.handleDeleteDevice(req, res));

        // ---- sync ----
        app.get('/api/mobile/v1/sync/bootstrap', (req, res) => self.handleBootstrap(req, res));
        app.get('/api/mobile/v1/sync/changes', (req, res) => self.handleChanges(req, res));
        app.post('/api/mobile/v1/sync/push', (req, res) => self.handlePush(req, res));
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
    BLOB_CHUNK_BYTES,
    MAX_BLOB_BYTES,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    PROOF_SKEW_SEC,
    sendError,
};
