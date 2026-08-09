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
function projectPayload(spec, row) {
    if (!row) return {};
    const drop = new Set([
        ...(spec.secretFields || []),
        ...(spec.deviceLocalFields || []),
    ]);
    const payload = {};
    for (const [key, value] of Object.entries(row)) {
        if (drop.has(key)) continue;
        payload[key] = value;
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
        // Root of a dotted path: the registry declares whole fields, and
        // SYNC_STATE_MACHINE.md 7 treats an object as one atomic field path
        // unless the registry says otherwise.
        const root = String(field).split(/[.\[]/)[0];
        if (forbidden.has(root)) {
            throw new MobileStoreError(
                'invalid_request',
                '\u5b57\u6bb5 ' + field + ' \u4e0d\u5141\u8bb8\u7531\u79fb\u52a8\u7aef\u4fee\u6539',
                400,
                { details: { field } },
            );
        }
        if (!editable.has(root)) {
            throw new MobileStoreError(
                'invalid_request',
                '\u5b57\u6bb5 ' + field + ' \u4e0d\u5728\u53ef\u540c\u6b65\u5b57\u6bb5\u8868\u4e2d',
                400,
                { details: { field } },
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
function createEntityAdapters({ resourceService, notesService, storage }) {
    const adapters = new Map();

    adapters.set('connection', {
        list: (user) => resourceService.listConnections(user, { includeEphemeral: false })
            .filter((row) => row.ownerUserId === user.userId),
        read: (user, id) => {
            try {
                return resourceService.getConnection(user, id);
            } catch {
                return null;
            }
        },
        revisionOf: (row) => Math.max(1, Number(row.revision) || 1),
        create: (user, id, patch) => resourceService.createConnection(
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
        ),
        update: (user, id, patch) => resourceService.updateConnection(user, id, (current) => ({ ...current, ...patch })),
        remove: (user, id) => resourceService.deleteConnection(user, id),
    });

    for (const type of ['proxy', 'sshKey', 'jumpHost']) {
        adapters.set(type, {
            list: (user) => resourceService.listOwned(user, type)
                .filter((row) => row.ownerUserId === user.userId),
            read: (user, id) => {
                try {
                    return resourceService.getRawAuthorized(user, type, id, 'view');
                } catch {
                    return null;
                }
            },
            revisionOf: (row) => Math.max(1, Number(row.revision) || 1),
            create: (user, id, patch) => resourceService.createOwned(user, type, { ...patch, id }),
            update: (user, id, patch) => resourceService.updateOwned(user, type, id, patch),
            remove: (user, id) => resourceService.deleteOwned(user, type, id),
        });
    }

    if (notesService) {
        adapters.set('note', {
            list: (user) => notesService.list(user, { limit: 500 }).items || [],
            read: (user, id) => {
                try {
                    return notesService.get(user, id);
                } catch {
                    return null;
                }
            },
            revisionOf: (row) => Math.max(1, Number(row.revision) || 1),
            create: (user, id, patch) => notesService.create(user, { ...patch, id }),
            update: (user, id, patch) => notesService.update(user, id, patch),
            /* Soft delete: notes already have trash/restore, and the registry
             * records deleteMode `tombstone` for this type. A purge here would
             * make the client's restore action impossible to honour. */
            remove: (user, id) => notesService.delete(user, id),
            /* The registry's `restore` action exists precisely because delete is
             * soft here. SYNC_STATE_MACHINE.md 9 says a restore is a new
             * revision rather than an undo of the tombstone, which is what
             * NotesService.restore already does. */
            restore: (user, id) => notesService.restore(user, id),
        });
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

module.exports = { createEntityAdapters, projectPayload, assertMaskAllowed, connectionDefaults };
