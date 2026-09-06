/**
 * Bridges canonical service mutations into the mobile v1 incremental feed.
 *
 * ResourceService and NotesService are the canonical write boundary used by
 * Web routes, AI tools and mobile adapters. Recording here means every caller
 * gets the same feed semantics without teaching those callers about sync.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { MobileV1Store, MobileStoreError } = require('./mobile-v1-store');
const { projectPayload, changedStoredSecretFields } = require('./mobile-v1-entities');

const sharedByDb = new WeakMap();

function assertEntityRegistry(registry, source) {
    if (!registry || typeof registry !== 'object' || !Array.isArray(registry.entities)) {
        throw new TypeError(`Invalid mobile entity registry from ${source}: expected an object with entities[]`);
    }
    return registry;
}

/**
 * Resolves the frozen registry in both runtime layouts.
 *
 * Callers that already loaded the registry should inject it. A supplied path
 * is also authoritative: if it is missing or malformed, fail on that path
 * instead of silently switching to a different contract. Without either, the
 * staged-core location is checked before the source-repository location.
 */
function resolveEntityRegistry({ registry, registryPath } = {}) {
    if (registry !== undefined) return assertEntityRegistry(registry, 'injected value');

    const explicitPath = registryPath == null ? '' : path.resolve(String(registryPath));
    const candidates = explicitPath ? [explicitPath] : [
        path.join(__dirname, 'mobile-contracts', 'registries', 'entity-registry.json'),
        path.join(__dirname, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
    ];
    const selected = explicitPath || candidates.find((candidate) => fs.existsSync(candidate));
    if (!selected) {
        throw new Error(`Mobile entity registry not found (looked in ${candidates.join(', ')})`);
    }

    let raw;
    try {
        raw = fs.readFileSync(selected, 'utf8');
    } catch (error) {
        throw new Error(`Unable to read mobile entity registry at ${selected}: ${error.message}`, { cause: error });
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid JSON in mobile entity registry at ${selected}: ${error.message}`, { cause: error });
    }
    return assertEntityRegistry(parsed, selected);
}

function valueAt(row, field) {
    return row && Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined;
}

function editableFieldMask(spec, before, after) {
    const previous = projectPayload(spec, before || {});
    const current = projectPayload(spec, after || {});
    return (spec.editableFields || []).filter((field) => {
        if (!before) return Object.prototype.hasOwnProperty.call(current, field);
        return !isDeepStrictEqual(valueAt(previous, field), valueAt(current, field));
    });
}

function secretFieldMask(spec, changedSecretFields) {
    if (changedSecretFields == null) return [];
    if (!Array.isArray(changedSecretFields)) {
        throw new MobileStoreError('invalid_request', 'changedSecretFields must be an array', 400);
    }
    const allowed = new Set((spec.secretFields || []).map(String));
    const fields = [...new Set(changedSecretFields.map(String))];
    const invalid = fields.find((field) => !allowed.has(field));
    if (invalid) {
        throw new MobileStoreError('invalid_request', 'Canonical secret field is not declared by the registry', 400, {
            details: { entityType: spec.type },
        });
    }
    return fields;
}

class MobileV1ChangeBridge {
    constructor({ db, store, registry, registryPath, wakePublisher = null } = {}) {
        if (!db) throw new TypeError('MobileV1ChangeBridge requires a SQLite db');
        const resolvedRegistry = resolveEntityRegistry({
            registry: registry === undefined ? store?.entityRegistry : registry,
            registryPath,
        });
        this.db = db;
        this.registry = resolvedRegistry;
        this.store = store || new MobileV1Store({ db, entityRegistry: resolvedRegistry });
        this.entityByType = new Map(resolvedRegistry.entities.map((spec) => [spec.type, spec]));
        this.wakePublisher = typeof wakePublisher === 'function' ? wakePublisher : null;
    }

    setWakePublisher(publisher) {
        this.wakePublisher = typeof publisher === 'function' ? publisher : null;
    }

    publishCommittedChange(ownerUserId, sequence) {
        this._publishWakeCandidate(ownerUserId, sequence);
    }

    _publishWakeCandidate(ownerUserId, sequence) {
        if (!this.wakePublisher) return;
        try {
            this.wakePublisher({
                ownerUserId: String(ownerUserId),
                sequence: Number(sequence),
            });
        } catch {
            /* Browser invalidation is best-effort and must never decide the
             * fate of the canonical transaction. The runtime independently
             * verifies commit before putting anything on the wire. */
        }
    }

    /**
     * Runs a canonical write and its feed bookkeeping in one transaction.
     * Nested calls use the database driver's savepoint support, so this remains
     * atomic when invoked from the existing mobile push transaction.
     */
    runMutation(meta, write) {
        if (typeof write !== 'function') throw new TypeError('mutation write must be a function');
        return this.db.transaction(() => {
            const result = write();
            const after = typeof meta.after === 'function' ? meta.after(result) : result;
            this.recordMutation({ ...meta, after });
            return result;
        })();
    }

    recordMutation({
        entityType,
        entityId,
        action = 'upsert',
        user,
        before = null,
        after = null,
        revision,
        actorDeviceId = null,
        mutationReceipt = null,
        forceChange = false,
        changedSecretFields = [],
    }) {
        const spec = this.entityByType.get(String(entityType || ''));
        if (!spec) {
            throw new MobileStoreError('unknown_entity_type', 'Unknown mobile entity type', 400, {
                details: { entityType },
            });
        }
        if (action !== 'upsert' && action !== 'delete') {
            throw new MobileStoreError('invalid_request', 'Canonical mutation action must be upsert or delete', 400);
        }

        /* Ephemeral connections are intentionally absent from bootstrap and
         * remain absent from incremental sync as well. */
        if (entityType === 'connection' && (before?.ephemeral || after?.ephemeral)) {
            return { skipped: true, reason: 'device_local_entity' };
        }

        const ownerField = String(spec.ownerField || 'ownerUserId');
        const idField = String(spec.idField || 'id');
        const ownerUserId = String(valueAt(after, ownerField) || valueAt(before, ownerField) || user?.userId || '');
        const resolvedEntityId = String(entityId || valueAt(after, idField) || valueAt(before, idField) || '');
        if (!ownerUserId || !resolvedEntityId) {
            throw new MobileStoreError('invalid_request', 'Canonical mutation is missing immutable owner or entity id', 400);
        }

        const priorVersion = this.store.getEntityVersion(ownerUserId, entityType, resolvedEntityId);
        const rowRevision = Number(valueAt(after, spec.revisionField) || valueAt(before, spec.revisionField) || 0);
        const nextRevision = Number(revision) || (action === 'delete'
            ? Math.max(rowRevision, Number(priorVersion?.revision || 0)) + 1
            : Math.max(1, rowRevision, Number(priorVersion?.revision || 0)));
        const changedAt = Date.now();
        /* Restore changes only server-authority `deletedAt`, but the client
         * still needs an upsert to recreate the row it removed for the
         * tombstone. Treat it like a fresh projection and initialise all
         * editable field revisions at the restore revision. */
        const restored = action === 'upsert' && before?.deletedAt && after && !after.deletedAt;
        const fieldMask = action === 'upsert' ? editableFieldMask(spec, restored ? null : before, after) : [];
        /* Callers historically stamped every secret the form posted, including
         * empty privateKey on a rename. The feed ledger follows stored values. */
        if (changedSecretFields.length) secretFieldMask(spec, changedSecretFields);
        const secretMask = action === 'upsert'
            ? secretFieldMask(spec, changedStoredSecretFields(spec, restored ? null : before, after))
            : [];

        /* A service may receive the same logical mutation twice. Do not move
         * the cursor for a no-op update, but do keep the authoritative revision
         * ledger aligned with the canonical row. */
        if (action === 'upsert' && before && fieldMask.length === 0 && secretMask.length === 0 && !forceChange) {
            this.store.setEntityVersion({
                ownerUserId,
                entityType,
                entityId: resolvedEntityId,
                revision: nextRevision,
                deletedAt: null,
            });
            return { skipped: true, reason: 'no_editable_change', revision: nextRevision };
        }

        const tombstone = action === 'delete' ? {
            entityType,
            entityId: resolvedEntityId,
            ownerUserId,
            deletedRevision: nextRevision,
            deletedAt: changedAt,
            deletedBy: 'canonical',
            lastKnownName: String(before?.name || before?.title || '').slice(0, 200),
        } : null;
        const changeSeq = this.store.appendChange({
            ownerUserId,
            entityType,
            entityId: resolvedEntityId,
            action,
            revision: nextRevision,
            fieldMask,
            actorDeviceId: actorDeviceId == null ? null : String(actorDeviceId),
            tombstone,
        });
        this.store.setEntityVersion({
            ownerUserId,
            entityType,
            entityId: resolvedEntityId,
            revision: nextRevision,
            deletedAt: action === 'delete' ? changedAt : null,
        });
        const revisionFields = [...fieldMask, ...secretMask];
        if (revisionFields.length) {
            this.store.setFieldRevisions({
                ownerUserId,
                entityType,
                entityId: resolvedEntityId,
                fields: revisionFields,
                revision: nextRevision,
                changedAt,
            });
        }
        if (mutationReceipt && typeof mutationReceipt === 'object' && !Array.isArray(mutationReceipt)) {
            mutationReceipt.changeSeq = changeSeq;
        }
        this._publishWakeCandidate(ownerUserId, changeSeq);
        return { changeSeq, revision: nextRevision, fieldMask, tombstone };
    }

    /** Payload-free durable events for a future wake transport. */
    pendingWakeEvents(limit = 100) {
        return this.store.wakeOutboxPage(limit);
    }

    acknowledgeWakeEvents(outboxIds) {
        return this.store.ackWakeOutbox(outboxIds);
    }
}

/**
 * True only when the frozen mobile contract file is simply absent from this
 * tree. A malformed or unreadable registry is NOT this case and must keep
 * failing loudly so a bad contract cannot silently degrade sync semantics.
 */
function isMissingRegistryError(error) {
    return !!error && String(error.message || '').includes('Mobile entity registry not found');
}

/**
 * No-op change bridge for trees that deliberately ship without the frozen
 * mobile contracts (the hosted Zephyr Docker image excludes zephyr_one/, so
 * the registry and the whole mobile v1 surface are absent there). Consumers
 * still receive a bridge-shaped object: mutations pass straight through,
 * nothing is recorded, and there is no registry to project against. The
 * mobile v1 API itself stays unmounted because server.js still requires the
 * real contract file, so nothing reachable serves a disabled bridge output.
 */
function createDisabledMobileV1ChangeBridge(db) {
    const registry = { entities: [] };
    return {
        db,
        registry,
        entityByType: new Map(),
        store: {
            serverId() {
                try {
                    const row = db && typeof db.prepare === "function"
                        ? db.prepare("SELECT value FROM settings WHERE key = 'mobileV1ServerId'").get()
                        : null;
                    if (row && row.value) return String(row.value);
                } catch {
                    /* settings table may not exist yet; fall through to the constant */
                }
                return 'srv-mobile-v1-disabled';
            },
            appendChange() {
                return 0;
            },
            setEntityVersion() {},
            setFieldRevisions() {},
        },
        setWakePublisher() {},
        publishCommittedChange() {},
        runMutation(meta, write) {
            if (typeof write !== 'function') throw new TypeError('mutation write must be a function');
            return write();
        },
        recordMutation() {
            return { skipped: true, reason: 'change_bridge_disabled' };
        },
        pendingWakeEvents() {
            return [];
        },
        acknowledgeWakeEvents() {},
    };
}

function getMobileV1ChangeBridge(db, options = {}) {
    if (options.bridge) return options.bridge;
    let bridge = sharedByDb.get(db);
    if (!bridge) {
        try {
            bridge = new MobileV1ChangeBridge({ db, ...options });
        } catch (error) {
            if (!isMissingRegistryError(error)) throw error;
            console.warn('[mobile-v1] entity registry absent; change bridge disabled:',
                error && error.message);
            bridge = createDisabledMobileV1ChangeBridge(db);
        }
        sharedByDb.set(db, bridge);
    }
    return bridge;
}

module.exports = {
    MobileV1ChangeBridge,
    getMobileV1ChangeBridge,
    editableFieldMask,
    secretFieldMask,
    resolveEntityRegistry,
};
