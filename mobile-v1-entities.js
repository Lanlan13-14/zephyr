/**
 * Canonical entity projection for /api/mobile/v1 sync.
 *
 * The registry in contracts/registries/entity-registry.json names 20 entity
 * types. This module is the only place that maps a registry type onto the
 * canonical Zephyr service that owns it, because SYNC_STATE_MACHINE.md 6 is
 * explicit that mobile sync must never write a business table directly:
 *
 *     "[KNOWN] BUZHUNXU mobile sync ZHIJIE RAOKAI service XIE YEWU BIAO."
 *
 * A type with no adapter is reported as `unsupported_scope` rather than being
 * silently skipped. Skipping would let a device believe it had a complete
 * mirror of something the server never sent, which is worse than a clear
 * "this server cannot sync that yet".
 */
'use strict';

const { MobileStoreError } = require('./mobile-v1-store');

const INACCESSIBLE_CODE = 'resource_not_found_or_inaccessible';
const INACCESSIBLE_MESSAGE = '\u8d44\u6e90\u4e0d\u5b58\u5728\u6216\u4e0d\u53ef\u8bbf\u95ee';

function inaccessible() {
    return new MobileStoreError(INACCESSIBLE_CODE, INACCESSIBLE_MESSAGE, 404);
}

function ownerId(row) {
    return row && String(row.ownerUserId || row.owner_user_id || '');
}

function isOwnedBy(row, user) {
    return !!row && ownerId(row) !== '' && ownerId(row) === String(user && user.userId || '');
}

/**
 * Reads ownership without going through the discover/share ACL projection.
 *
 * Sync has a stricter boundary than the regular Web library: an object another
 * account shared with this user is still not part of this user's offline
 * mirror. Keeping the raw lookup here also prevents an editable share from
 * reaching update/delete through an adapter.
 */
function createRawLookup(storage) {
    const ownerStatements = new Map();
    const definitions = {
        connection: 'SELECT id, ownerUserId, revision FROM connections WHERE id = ?',
        proxy: 'SELECT id, ownerUserId, revision FROM proxies WHERE id = ?',
        sshKey: 'SELECT id, ownerUserId, revision FROM ssh_keys WHERE id = ?',
        jumpHost: 'SELECT id, ownerUserId, revision FROM jump_hosts WHERE id = ?',
        note: 'SELECT note_id AS id, owner_user_id AS ownerUserId, revision, deleted_at AS deletedAt FROM notes WHERE note_id = ?',
    };
    let db = null;
    try {
        db = storage && typeof storage.rawDb === 'function' ? storage.rawDb() : null;
    } catch {
        db = null;
    }
    if (db && typeof db.prepare === 'function') {
        for (const [type, sql] of Object.entries(definitions)) {
            try {
                ownerStatements.set(type, db.prepare(sql));
            } catch {
                // Alternate hosts may intentionally omit an unsupported table.
            }
        }
    }

    return (type, id) => {
        const statement = ownerStatements.get(type);
        if (statement) return statement.get(String(id)) || null;
        /* Falling back to the ordinary raw getters would decrypt password,
         * private-key or note-content columns just to compare an owner id. A
         * host without the narrow query fails closed instead. */
        throw new MobileStoreError(
            'server_unavailable',
            '\u540c\u6b65\u6240\u6709\u6743\u6821\u9a8c\u4e0d\u53ef\u7528',
            503,
            { retryable: true },
        );
    };
}

function requireOwned(rawLookup, type, user, id) {
    const row = rawLookup(type, id);
    if (!isOwnedBy(row, user)) throw inaccessible();
    return row;
}

function requireVacant(rawLookup, type, id) {
    if (rawLookup(type, id)) throw inaccessible();
}

function readOwned(rawLookup, type, user, id, readCanonical) {
    if (!isOwnedBy(rawLookup(type, id), user)) return null;
    try {
        const row = readCanonical();
        return isOwnedBy(row, user) ? row : null;
    } catch (err) {
        if (err && err.code === INACCESSIBLE_CODE) return null;
        throw err;
    }
}

function residencyOf(rawLookup, type, user, id) {
    const row = rawLookup(type, id);
    if (!row) return 'missing';
    return isOwnedBy(row, user) ? 'owned' : 'foreign';
}

/**
 * Strips every field One must never receive or name in a fieldMask.
 *
 * Driven by the registry rather than a hand-kept list: secretFields,
 * serverAuthorityFields and deviceLocalFields all have different reasons to be
 * excluded, and the registry is the frozen source for all three.
 *
 * opaquePreserveFields are deliberately *kept*. The registry invariant is
 * "unknown fields are retained but never emitted in a One-authored fieldMask",
 * so the value round-trips while the client is forbidden from editing it.
 */
function presenceFlag(fieldName) {
    const name = String(fieldName || '');
    return 'has' + name.charAt(0).toUpperCase() + name.slice(1);
}

function hasStoredSecret(value) {
    if (value == null) return false;
    if (typeof value === 'boolean') return value === true;
    const text = String(value);
    return text.length > 0 && text !== '******';
}

function extractSecrets(spec, row) {
    const secrets = {};
    if (!row) return secrets;
    for (const field of spec.secretFields || []) {
        if (hasStoredSecret(row[field])) secrets[field] = String(row[field]);
    }
    return secrets;
}

/**
 * Secret fields that must be resealed on this change.
 *
 * Empty fieldMask is a full replacement and reseals every stored secret.
 * Incremental patches reseal only a secret whose field-revision equals this
 * change.revision *and* that still has a real value. A later name/host edit
 * that also stamped an empty privateKey must not count as a password change.
 */
function changedStoredSecretFields(spec, before, after) {
    return (spec.secretFields || []).filter((field) => {
        const previous = hasStoredSecret(before && before[field]) ? String(before[field]) : '';
        const current = hasStoredSecret(after && after[field]) ? String(after[field]) : '';
        return previous !== current;
    });
}

function secretFieldsNeedingDownlink(spec, row, change, fieldRevisionOf) {
    const secretFields = spec.secretFields || [];
    if (!secretFields.length) return [];
    const stored = secretFields.filter((field) => hasStoredSecret(row && row[field]));
    const mask = Array.isArray(change && change.fieldMask) ? change.fieldMask : [];
    if (mask.length === 0) return stored;
    const revision = Number(change && change.revision);
    if (!Number.isFinite(revision)) return [];
    return stored.filter((field) => {
        let rev = null;
        try {
            rev = typeof fieldRevisionOf === 'function' ? fieldRevisionOf(field) : null;
        } catch {
            rev = null;
        }
        return Number(rev) === revision;
    });
}

/* SQLite INTEGER 0/1 columns. rdpTouchMode is a string enum ('direct' /
 * 'relative') and must never be coerced through Boolean('direct') === true. */
const SQLITE_BOOLEAN_FIELDS = new Set([
    'rdpClipboard', 'rdpMicrophone', 'rdpCamera', 'rdpStorage', 'rdpLocation',
    'shareWithUsers', 'shareWithAdmins', 'allowAi', 'allowAiRead', 'allowAiWrite',
    'enabled', 'autoRun', 'ephemeral',
]);
const VISIBILITY_WIRE = ['private', 'shared', 'public'];

function coerceSqliteBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (value === '0' || value === '1') return value === '1';
    if (value === 'true' || value === 'false') return value === 'true';
    return Boolean(value);
}

function coerceOwnedPayloadValue(key, value) {
    if (SQLITE_BOOLEAN_FIELDS.has(key)) return coerceSqliteBoolean(value);
    if (key === 'visibility') {
        if (typeof value === 'number') return VISIBILITY_WIRE[value] || 'private';
        if (typeof value === 'string' && value.length) return value;
        return 'private';
    }
    if ((key === 'tags' || key === 'jumpHostIds' || key === 'sharedUserIds') && typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    /* Main-end storage coalesces a missing sshKeyId to '' (TEXT column). One
     * treats any non-null string as a live dependency, so the empty sentinel
     * has to become JSON null on the owned-sync wire. Same for proxy/jump. */
    if (key === 'sshKeyId' || key === 'proxyId' || key === 'jumpHostId') {
        if (value == null) return null;
        const text = String(value).trim();
        return text ? text : null;
    }
    return value;
}

function projectPayload(spec, row) {
    if (!row) return {};
    const drop = new Set([
        ...(spec.secretFields || []),
        ...(spec.deviceLocalFields || []),
    ]);
    /* Connection/proxy/sshKey web-library extras must not ride the owned
     * mirror. `capabilities` is a real resourceAcl field, so it cannot be
     * dropped globally; only strip the host-library copies here. */
    if (spec.type === 'connection' || spec.type === 'proxy' || spec.type === 'sshKey' || spec.type === 'jumpHost') {
        drop.add('capabilities');
        drop.add('owner');
    }
    if (spec.type === 'note') drop.add('preview');
    const payload = {};
    for (const [key, value] of Object.entries(row)) {
        if (drop.has(key)) continue;
        payload[key] = coerceOwnedPayloadValue(key, value);
    }
    /* One refuses a secret-bearing row whose presence flags are missing, and
     * refuses hasX=true without a matching device envelope. Always emit the
     * boolean, including false, so an empty-secret connection can still sync. */
    for (const field of spec.secretFields || []) {
        payload[presenceFlag(field)] = hasStoredSecret(row[field]);
    }
    return payload;
}

/** Which fields a client is allowed to name in a fieldMask for this type. */
function assertMaskAllowed(spec, fieldMask) {
    const editable = new Set(spec.editableFields || []);
    const forbidden = new Set([
        ...(spec.secretFields || []),
        ...(spec.serverAuthorityFields || []),
        ...(spec.opaquePreserveFields || []),
        ...(spec.deviceLocalFields || []),
    ]);
    for (const field of fieldMask) {
        const path = String(field);
        const segments = path.split(/[.\[\]]/).filter(Boolean);
        if (segments.some((segment) => (
            segment === '__proto__' || segment === 'prototype' || segment === 'constructor'
        ))) {
            throw new MobileStoreError(
                'invalid_request',
                '\u5b57\u6bb5 ' + path + ' \u5305\u542b\u4e0d\u5b89\u5168\u8def\u5f84',
                400,
                { details: { field: path } },
            );
        }
        const root = segments[0] || '';
        if (forbidden.has(path) || forbidden.has(root)) {
            throw new MobileStoreError(
                'invalid_request',
                '\u5b57\u6bb5 ' + path + ' \u4e0d\u5141\u8bb8\u7531\u79fb\u52a8\u7aef\u4fee\u6539',
                400,
                { details: { field: path } },
            );
        }
        /* Object members are editable only when the registry declares that
         * exact path. Treating every child of an editable root as editable
         * defeats the registry when a later canonical object grows a secret or
         * server-authority member. */
        if (!editable.has(path)) {
            throw new MobileStoreError(
                'invalid_request',
                '\u5b57\u6bb5 ' + path + ' \u4e0d\u5728\u53ef\u540c\u6b65\u5b57\u6bb5\u8868\u4e2d',
                400,
                { details: { field: path } },
            );
        }
    }
}

/**
 * Builds the adapter table.
 *
 * Only types with a real canonical service are wired. `connection`, `proxy`,
 * `sshKey` and `jumpHost` go through ResourceService; `note` through
 * NotesService. The remaining 15 registry types have no mobile-writable
 * canonical path yet and are reported as unsupported.
 */
function createEntityAdapters({
    resourceService,
    notesService,
    userSettingsService,
    storage,
    db,
    store,
    changeBridge,
    fileSyncConfigService,
    entityRegistry,
    aiProviderService,
    aiKnowledgeService,
    aiHistoryService,
    workspacePortableSyncService,
    serverMetadataServices,
    serverMetadataAuthorize,
    serverId,
    resourceAclService,
    clientTokenService,
}) {
    /* These adapters depend on canonical services that themselves load the
     * change bridge. Resolve them lazily after this module has finished
     * exporting projectPayload, otherwise Node's circular module cache leaves
     * the bridge with an undefined projector. */
    const { createPersonalEntityAdapters } = require('./mobile-v1-personal-entities');
    const { createFileSyncConfigAdapter } = require('./mobile-v1-file-config-entity');
    const { createAiProviderEntityAdapters } = require('./mobile-v1-ai-provider-entities');
    const { createAiKnowledgeEntityAdapters } = require('./mobile-v1-ai-knowledge-entities');
    const { createAiHistoryEntityAdapters } = require('./mobile-v1-ai-history-entities');
    const { createWorkspacePortableEntityAdapters } = require('./mobile-v1-workspace-entity');
    const { createServerMetadataEntityAdapters } = require('./mobile-v1-server-metadata-entities');
    const { createAclTokenMetadataAdapters } = require('./mobile-v1-acl-token-metadata');
    const adapters = new Map();
    const rawLookup = createRawLookup(storage);

    adapters.set('connection', {
        idOf: (row) => row.id,
        residency: (user, id) => residencyOf(rawLookup, 'connection', user, id),
        list: (user) => resourceService.storage.listAllConnectionRows()
            .filter((row) => row && row.ownerUserId === user.userId && !row.ephemeral),
        read: (user, id) => readOwned(
            rawLookup,
            'connection',
            user,
            id,
            () => resourceService.storage.getConnectionById(id),
        ),
        revisionOf: (row) => Math.max(1, Number(row.revision) || 1),
        create: (user, id, patch, mutationContext) => {
            requireVacant(rawLookup, 'connection', id);
            return resourceService.createConnection(
                user,
                /* Full row, not just the patch.
                 *
                 * storage.insertConnection binds every column by name, so a partial
                 * object makes SQLite reject the statement with "Missing named
                 * parameters" rather than defaulting. The canonical Web route
                 * (POST /api/connections) builds the same complete shape before
                 * calling the service, so this mirrors it instead of teaching the
                 * storage layer a second, laxer contract. */
                connectionDefaults(id, patch),
                mutationContext,
            );
        },
        update: (user, id, patch, mutationContext) => {
            requireOwned(rawLookup, 'connection', user, id);
            return resourceService.updateConnection(
                user,
                id,
                (current) => ({ ...current, ...patch }),
                mutationContext,
            );
        },
        remove: (user, id, mutationContext) => {
            requireOwned(rawLookup, 'connection', user, id);
            return resourceService.deleteConnection(user, id, mutationContext);
        },
    });

    for (const type of ['proxy', 'sshKey', 'jumpHost']) {
        adapters.set(type, {
            idOf: (row) => row.id,
            residency: (user, id) => residencyOf(rawLookup, type, user, id),
            list: (user) => resourceService.listOwnedRawForSync(user, type),
            read: (user, id) => readOwned(
                rawLookup,
                type,
                user,
                id,
                () => resourceService.getRawAuthorized(user, type, id, 'view'),
            ),
            revisionOf: (row) => Math.max(1, Number(row.revision) || 1),
            create: (user, id, patch, mutationContext) => {
                /* saveProxy/saveSshKey/saveJumpHost use INSERT OR REPLACE. A raw
                 * collision check is therefore a security boundary: without it,
                 * a mobile create could replace another account's row. */
                requireVacant(rawLookup, type, id);
                return resourceService.createOwned(user, type, { ...patch, id }, mutationContext);
            },
            update: (user, id, patch, mutationContext) => {
                requireOwned(rawLookup, type, user, id);
                return resourceService.updateOwned(user, type, id, patch, mutationContext);
            },
            remove: (user, id, mutationContext) => {
                requireOwned(rawLookup, type, user, id);
                return resourceService.deleteOwned(user, type, id, mutationContext);
            },
        });
    }

    if (notesService) {
        adapters.set('note', {
            idOf: (row) => row.noteId,
            residency: (user, id) => residencyOf(rawLookup, 'note', user, id),
            list: (user) => notesService.listOwnedForSync(user)
                .filter((row) => row.ownerUserId === user.userId),
            read: (user, id) => readOwned(
                rawLookup,
                'note',
                user,
                id,
                () => notesService.get(user, id),
            ),
            revisionOf: (row) => Math.max(1, Number(row.revision) || 1),
            create: (user, id, patch, mutationContext) => {
                requireVacant(rawLookup, 'note', id);
                return notesService.create(user, { ...patch, id }, mutationContext);
            },
            update: (user, id, patch, mutationContext) => {
                const current = requireOwned(rawLookup, 'note', user, id);
                return notesService.update(user, id, {
                    ...patch,
                    expectedRevision: Number(current.revision),
                }, mutationContext);
            },
            /* Soft delete: notes already have trash/restore, and the registry
             * records deleteMode `tombstone` for this type. A purge here would
             * make the client's restore action impossible to honour. */
            remove: (user, id, mutationContext) => {
                requireOwned(rawLookup, 'note', user, id);
                return notesService.delete(user, id, mutationContext);
            },
            /* The registry's `restore` action exists precisely because delete is
             * soft here. SYNC_STATE_MACHINE.md 9 says a restore is a new
             * revision rather than an undo of the tombstone, which is what
             * NotesService.restore already does. */
            restore: (user, id, mutationContext) => {
                requireOwned(rawLookup, 'note', user, id);
                return notesService.restore(user, id, mutationContext);
            },
        });
    }

    for (const [type, adapter] of createPersonalEntityAdapters({ userSettingsService })) {
        adapters.set(type, adapter);
    }

    if (fileSyncConfigService || (db && typeof db.prepare === 'function'
        && typeof db.exec === 'function' && store)) {
        adapters.set('fileSyncConfig', createFileSyncConfigAdapter({
            db,
            store,
            changeBridge,
            service: fileSyncConfigService,
        }));
    }

    for (const [type, adapter] of createAiProviderEntityAdapters({
        registry: entityRegistry,
        service: aiProviderService,
    })) {
        adapters.set(type, adapter);
    }

    /* AI memories, skills, and environment metadata share the same account
     * canonical service as the Web settings facade and AI runtime. Passing
     * the service instance preserves its bridge transaction and prevents a
     * mobile-only table or an ownerless settings.ai fallback. */
    const sharedAiKnowledgeService = aiKnowledgeService || userSettingsService?.aiKnowledgeService;
    if (sharedAiKnowledgeService) {
        for (const [type, adapter] of createAiKnowledgeEntityAdapters({
            db,
            store,
            changeBridge,
            registry: entityRegistry,
            service: sharedAiKnowledgeService,
        })) {
            adapters.set(type, adapter);
        }
    }

    for (const [type, adapter] of createAiHistoryEntityAdapters({
        registry: entityRegistry,
        service: aiHistoryService,
    })) {
        adapters.set(type, adapter);
    }

    for (const [type, adapter] of createWorkspacePortableEntityAdapters({
        service: workspacePortableSyncService,
    })) {
        adapters.set(type, adapter);
    }

    for (const [type, adapter] of createServerMetadataEntityAdapters({
        registry: entityRegistry,
        serverSettings: serverMetadataServices?.serverSettings,
        backupMetadata: serverMetadataServices?.backupMetadata,
        activityEvents: serverMetadataServices?.activityEvents,
        authorize: serverMetadataAuthorize,
        serverId,
    })) {
        adapters.set(type, adapter);
    }

    for (const [type, adapter] of createAclTokenMetadataAdapters({
        resourceAclService,
        clientTokenService,
    })) {
        adapters.set(type, adapter);
    }

    return adapters;
}

/**
 * Builds a complete connection row from a sparse mobile patch.
 *
 * Mirrors the field set and the fallbacks of the canonical `POST
 * /api/connections` handler. Protocol default ports are duplicated here rather
 * than imported because server.js does not export `protocolDefaultPort`; the
 * four values are frozen in core-model's `Protocol` enum on the client side, so
 * a drift would break the client first and loudly.
 */
function connectionDefaults(id, patch) {
    const protocol = String(patch.protocol || 'SSH').toUpperCase();
    const defaultPort = { SSH: 22, TELNET: 23, RDP: 3389, VNC: 5900 }[protocol] || 22;
    const host = String(patch.host || '').trim();
    return {
        id,
        name: String(patch.name || '').trim() || (protocol + ' ' + host),
        host,
        port: Number(patch.port) || defaultPort,
        protocol,
        username: String(patch.username || '').trim(),
        /* Secrets arrive already decrypted from an ML-KEM envelope, never in
         * the payload or the fieldMask. Hardcoding '' here silently dropped
         * every synced password: the envelope was opened correctly and then
         * overwritten one line before the canonical write. */
        password: typeof patch.password === 'string' ? patch.password : '',
        privateKey: typeof patch.privateKey === 'string' ? patch.privateKey : '',
        sshKeyId: String(patch.sshKeyId || ''),
        remark: String(patch.remark || ''),
        tags: Array.isArray(patch.tags) ? patch.tags.map(String).filter(Boolean) : [],
        connectionMode: ['direct', 'proxy', 'jump'].includes(patch.connectionMode) ? patch.connectionMode : 'direct',
        proxyId: patch.proxyId || null,
        jumpHostId: patch.jumpHostId || null,
        jumpHostIds: Array.isArray(patch.jumpHostIds) ? patch.jumpHostIds.map(String) : [],
        encoding: String(patch.encoding || 'utf-8'),
        rdpSoundMode: ['local', 'remote', 'off'].includes(patch.rdpSoundMode) ? patch.rdpSoundMode : 'local',
        rdpClipboard: patch.rdpClipboard !== false,
        rdpMicrophone: !!patch.rdpMicrophone,
        rdpCamera: !!patch.rdpCamera,
        rdpStorage: !!patch.rdpStorage,
        rdpLocation: !!patch.rdpLocation,
        rdpResolution: ['auto', '1080p', '2K', '4K', '8K'].includes(patch.rdpResolution) ? patch.rdpResolution : '1080p',
        rdpQuality: ['balanced', 'performance', 'quality'].includes(patch.rdpQuality) ? patch.rdpQuality : 'balanced',
        rdpFps: [30, 45, 60, 120, 144].includes(Number(patch.rdpFps)) ? Number(patch.rdpFps) : 30,
        rdpTouchMode: patch.rdpTouchMode === 'relative' ? 'relative' : 'direct',
        rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(patch.rdpTouchSensitivity) || 1.5)),
        rdpDomain: String(patch.rdpDomain || ''),
        /* Never one-shot: a synced connection is a library row by definition,
         * and an ephemeral flag would make it invisible to the next bootstrap. */
        ephemeral: false,
        shareWithUsers: false,
        shareWithAdmins: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
        lastConnectedAt: null,
    };
}

module.exports = {
    createEntityAdapters,
    projectPayload,
    extractSecrets,
    changedStoredSecretFields,
    secretFieldsNeedingDownlink,
    presenceFlag,
    hasStoredSecret,
    assertMaskAllowed,
    connectionDefaults,
};
