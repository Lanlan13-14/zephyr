'use strict';

/*
 * Account-scoped canonical storage for the three editable AI knowledge
 * entities. The legacy settings.ai bag is process-wide and may contain
 * provider credentials, so it is deliberately not a sync source.
 *
 * This table contains the sync projection itself, never an env value or a
 * provider/tool credential. Keeping secrets out of the schema makes it
 * impossible for a change row, tombstone, wake outbox, or diagnostic caller
 * to serialize one by accident.
 */

const { isDeepStrictEqual } = require('util');
const { HttpError } = require('./authz');
const secretCrypto = require('./secret-crypto');

/* Keep this lazy: mobile-v1-change-bridge imports the central entity helpers,
 * which in turn may compose this adapter factory. */
function getMobileV1ChangeBridge(db, options) {
    return require('./mobile-v1-change-bridge').getMobileV1ChangeBridge(db, options);
}

const ENTITY_TYPES = Object.freeze(['aiMemory', 'aiSkill', 'aiEnv']);
const REQUIRED_CAPABILITIES = Object.freeze([
    'stableIds',
    'revisions',
    'tombstones',
    'ownerIsolation',
    'atomicChangeFeed',
    'canonicalStorage',
    'safeProjection',
    'secretEnvelopeOnly',
]);
const MAX_ID_CHARS = 120;
const LIMITS = Object.freeze({ aiMemory: 2000, aiSkill: 200, aiEnv: 200 });
const FIELD_NAMES = Object.freeze({
    aiMemory: Object.freeze(['title', 'content', 'scope', 'project', 'projects', 'tags', 'connectionIds']),
    aiSkill: Object.freeze(['name', 'description', 'prompt', 'enabled']),
    // Do not add value, description, valueVisibleToAi, apiKey, or tool config.
    // This is intentionally narrower than the Web form's private env record.
    aiEnv: Object.freeze(['name', 'enabled', 'visibleToAi']),
});

function asUser(userOrId) {
    if (userOrId && typeof userOrId === 'object') return userOrId;
    return { userId: String(userOrId || '') };
}

function requireOwner(userOrId) {
    const user = asUser(userOrId);
    if (!String(user.userId || '').trim()) {
        throw new HttpError(403, 'resource_not_found_or_inaccessible', 'An account owner is required.');
    }
    return user;
}

function conflict() {
    return new HttpError(409, 'revision_conflict', 'The AI knowledge item changed on another client. Reload it and retry.');
}

function inaccessible() {
    return new HttpError(404, 'resource_not_found_or_inaccessible', 'The AI knowledge item does not exist or is inaccessible.');
}

function invalid(message) {
    return new HttpError(400, 'invalid_ai_knowledge', message);
}

function validId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > MAX_ID_CHARS || /[\0\r\n]/.test(id)) throw invalid('AI knowledge id is invalid.');
    return id;
}

function boundedString(value, max, field, { required = false } = {}) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
    const result = value.slice(0, max);
    if (required && !result.trim()) throw invalid(`${field} is required.`);
    return result;
}

function stringList(value, maxItems, maxChars, field) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
        throw invalid(`${field} must be a string array.`);
    }
    return [...new Set(value.map((item) => item.slice(0, maxChars).trim()).filter(Boolean))];
}

function bool(value, field) {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw invalid(`${field} must be a boolean.`);
    return value;
}

function assertKnownPatch(type, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('AI knowledge patch must be an object.');
    const allowed = new Set(FIELD_NAMES[type]);
    for (const key of Object.keys(patch)) {
        if (!allowed.has(key)) {
            // Fail closed for all secret-shaped and future private fields. The
            // same guard also prevents unsupported fields from becoming an
            // accidental new sync contract.
            throw invalid(`Field ${key} is not syncable for ${type}.`);
        }
    }
}

function normalizePayload(type, patch, previous = null, { creating = false } = {}) {
    assertKnownPatch(type, patch);
    const next = { ...(previous || {}) };
    if (type === 'aiMemory') {
        const title = boundedString(patch.title, 120, 'title');
        const content = boundedString(patch.content, 20000, 'content');
        const scope = boundedString(patch.scope, 80, 'scope');
        const project = boundedString(patch.project, 120, 'project');
        const projects = stringList(patch.projects, 20, 120, 'projects');
        const tags = stringList(patch.tags, 30, 120, 'tags');
        const connectionIds = stringList(patch.connectionIds, 50, 120, 'connectionIds');
        if (title !== undefined) next.title = title;
        if (content !== undefined) next.content = content;
        if (scope !== undefined) next.scope = scope;
        if (project !== undefined) next.project = project;
        if (projects !== undefined) next.projects = projects;
        if (tags !== undefined) next.tags = tags;
        if (connectionIds !== undefined) next.connectionIds = connectionIds;
        if (creating) {
            next.title = next.title || 'Memory';
            next.scope = next.scope || 'global';
            next.project = next.project || '';
            next.projects = next.projects || [];
            next.tags = next.tags || [];
            next.connectionIds = next.connectionIds || [];
            if (!String(next.content || '').trim()) throw invalid('content is required.');
        }
    } else if (type === 'aiSkill') {
        const name = boundedString(patch.name, 80, 'name');
        const description = boundedString(patch.description, 500, 'description');
        const prompt = boundedString(patch.prompt, 30000, 'prompt');
        const enabled = bool(patch.enabled, 'enabled');
        if (name !== undefined) next.name = name;
        if (description !== undefined) next.description = description;
        if (prompt !== undefined) next.prompt = prompt;
        if (enabled !== undefined) next.enabled = enabled;
        if (creating) {
            next.name = next.name || '';
            next.description = next.description || '';
            next.prompt = next.prompt || '';
            next.enabled = next.enabled !== false;
            if (!next.name.trim() && !next.prompt.trim()) throw invalid('name or prompt is required.');
        }
    } else if (type === 'aiEnv') {
        const name = boundedString(patch.name, 80, 'name');
        const enabled = bool(patch.enabled, 'enabled');
        const visibleToAi = bool(patch.visibleToAi, 'visibleToAi');
        if (name !== undefined) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw invalid('name must be a safe environment variable name.');
            next.name = name;
        }
        if (enabled !== undefined) next.enabled = enabled;
        if (visibleToAi !== undefined) next.visibleToAi = visibleToAi;
        if (creating) {
            if (!next.name) throw invalid('name is required.');
            next.enabled = next.enabled !== false;
            next.visibleToAi = next.visibleToAi === true;
        }
    } else {
        throw invalid('Unknown AI knowledge entity type.');
    }
    return next;
}

class AiKnowledgeService {
    constructor({ db, now = () => Date.now(), mobileChangeBridge } = {}) {
        if (!db) throw new TypeError('AiKnowledgeService requires a SQLite db');
        this.db = db;
        this.now = typeof now === 'function' ? now : () => Date.now();
        this._ensureSchema();
        this.mobileChangeBridge = mobileChangeBridge === false
            ? null
            : (mobileChangeBridge || getMobileV1ChangeBridge(db));
        this._prepare();
        this.mobileSyncCapabilities = Object.freeze({
            stableIds: true,
            revisions: true,
            tombstones: true,
            ownerIsolation: true,
            atomicChangeFeed: !!this.mobileChangeBridge,
            canonicalStorage: true,
            safeProjection: true,
            secretEnvelopeOnly: true,
        });
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ai_knowledge_entities (
                owner_user_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER,
                PRIMARY KEY (owner_user_id, entity_type, entity_id)
            );
            CREATE INDEX IF NOT EXISTS idx_ai_knowledge_owner_active
                ON ai_knowledge_entities(owner_user_id, entity_type, deleted_at, updated_at DESC);
            /* Non-sync UI policy and the encrypted env value are intentionally
             * separate from the projection table. Neither row is ever passed
             * to MobileV1ChangeBridge. */
            CREATE TABLE IF NOT EXISTS ai_knowledge_private_metadata (
                owner_user_id TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_user_id, entity_type, entity_id)
            );
            CREATE TABLE IF NOT EXISTS ai_knowledge_env_secrets (
                owner_user_id TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                value_ciphertext TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_user_id, entity_id)
            );
        `);
    }

    _prepare() {
        this.stmtGet = this.db.prepare(`SELECT * FROM ai_knowledge_entities
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?`);
        this.stmtList = this.db.prepare(`SELECT * FROM ai_knowledge_entities
            WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC, entity_id ASC`);
        this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS count FROM ai_knowledge_entities
            WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL`);
        this.stmtInsert = this.db.prepare(`INSERT INTO ai_knowledge_entities
            (owner_user_id, entity_type, entity_id, payload_json, revision, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, NULL)`);
        this.stmtUpdate = this.db.prepare(`UPDATE ai_knowledge_entities
            SET payload_json = ?, revision = revision + 1, updated_at = ?
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?
              AND revision = ? AND deleted_at IS NULL`);
        this.stmtDelete = this.db.prepare(`UPDATE ai_knowledge_entities
            SET revision = revision + 1, updated_at = ?, deleted_at = ?
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?
              AND revision = ? AND deleted_at IS NULL`);
        this.stmtRestore = this.db.prepare(`UPDATE ai_knowledge_entities
            SET revision = revision + 1, updated_at = ?, deleted_at = NULL
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?
              AND revision = ? AND deleted_at IS NOT NULL`);
        this.stmtPrivateGet = this.db.prepare(`SELECT metadata_json FROM ai_knowledge_private_metadata
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?`);
        this.stmtPrivatePut = this.db.prepare(`INSERT INTO ai_knowledge_private_metadata
            (owner_user_id, entity_type, entity_id, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_user_id, entity_type, entity_id) DO UPDATE
            SET metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`);
        this.stmtPrivateDelete = this.db.prepare(`DELETE FROM ai_knowledge_private_metadata
            WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?`);
        this.stmtEnvSecretGet = this.db.prepare(`SELECT value_ciphertext FROM ai_knowledge_env_secrets
            WHERE owner_user_id = ? AND entity_id = ?`);
        this.stmtEnvSecretPut = this.db.prepare(`INSERT INTO ai_knowledge_env_secrets
            (owner_user_id, entity_id, value_ciphertext, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_user_id, entity_id) DO UPDATE
            SET value_ciphertext=excluded.value_ciphertext, updated_at=excluded.updated_at`);
        this.stmtEnvSecretDelete = this.db.prepare(`DELETE FROM ai_knowledge_env_secrets
            WHERE owner_user_id = ? AND entity_id = ?`);
    }

    _assertType(type) {
        const normalized = String(type || '');
        if (!ENTITY_TYPES.includes(normalized)) throw invalid('Unknown AI knowledge entity type.');
        return normalized;
    }

    _row(row) {
        if (!row) return null;
        let payload;
        try { payload = JSON.parse(row.payload_json); } catch { throw new Error('Malformed canonical AI knowledge payload.'); }
        return {
            id: String(row.entity_id),
            ownerUserId: String(row.owner_user_id),
            revision: Math.max(1, Number(row.revision) || 1),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            ...(row.deleted_at == null ? payload : {}),
            ...(row.deleted_at == null ? {} : { deletedAt: Number(row.deleted_at) }),
        };
    }

    _runMutation(meta, write) {
        if (!this.mobileChangeBridge) return write();
        return this.mobileChangeBridge.runMutation(meta, write);
    }

    _privateMetadata(userId, type, id) {
        const row = this.stmtPrivateGet.get(String(userId), type, id);
        if (!row) return {};
        try { return JSON.parse(row.metadata_json) || {}; } catch { return {}; }
    }

    _setPrivateMetadata(userId, type, id, metadata) {
        if (!metadata || !Object.keys(metadata).length) {
            this.stmtPrivateDelete.run(String(userId), type, id);
            return;
        }
        this.stmtPrivatePut.run(String(userId), type, id, JSON.stringify(metadata), Number(this.now()));
    }

    _envValue(userId, id) {
        const row = this.stmtEnvSecretGet.get(String(userId), id);
        if (!row?.value_ciphertext) return '';
        return secretCrypto.decryptSecret(row.value_ciphertext, `ai-env:${userId}:${id}:value`);
    }

    _setEnvValue(userId, id, value) {
        const text = String(value ?? '');
        if (!text) {
            this.stmtEnvSecretDelete.run(String(userId), id);
            return;
        }
        const ciphertext = secretCrypto.encryptSecret(text, `ai-env:${userId}:${id}:value`);
        this.stmtEnvSecretPut.run(String(userId), id, ciphertext, Number(this.now()));
    }

    _privatePatch(type, input = {}, existing = {}) {
        if (type === 'aiMemory') {
            return input.enabled === undefined ? existing : { enabled: input.enabled !== false };
        }
        if (type === 'aiEnv') {
            const next = { ...existing };
            if (input.description !== undefined) next.description = String(input.description || '').slice(0, 500);
            if (input.valueVisibleToAi !== undefined) next.valueVisibleToAi = input.valueVisibleToAi === true;
            return next;
        }
        return {};
    }

    _withEnvSecret(userId, row) {
        if (!row) return row;
        const value = this._envValue(userId, row.id);
        return value ? { ...row, value } : row;
    }

    list(userOrId, type) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        return this.stmtList.all(String(user.userId), type).map((row) => this._row(row));
    }

    read(userOrId, type, id, { includeDeleted = false } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        const row = this._row(this.stmtGet.get(String(user.userId), type, validId(id)));
        if (!row || (!includeDeleted && row.deletedAt != null)) return null;
        return row;
    }

    /**
     * Mobile sync only. Web listForUser must never see env plaintext; the
     * projector seals `value` into a device envelope before it hits the wire.
     */
    listOwnedForSync(userOrId, type) {
        const user = requireOwner(userOrId);
        const rows = this.list(user, type);
        return type === 'aiEnv'
            ? rows.map((row) => this._withEnvSecret(user.userId, row))
            : rows;
    }

    readOwnedForSync(userOrId, type, id, options = {}) {
        const user = requireOwner(userOrId);
        const row = this.read(user, type, id, options);
        return type === 'aiEnv' ? this._withEnvSecret(user.userId, row) : row;
    }

    residency(userOrId, type, id) {
        return this.read(userOrId, type, id, { includeDeleted: true }) ? 'owned' : 'missing';
    }

    create(userOrId, type, id, patch, {
        actorDeviceId = null,
        mutationReceipt = null,
        changedSecretFields = [],
    } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        const payload = normalizePayload(type, patch, null, { creating: true });
        return this._runMutation({
            entityType: type, entityId: id, action: 'upsert', user, before: null,
            actorDeviceId, mutationReceipt, changedSecretFields,
        }, () => {
            if (this.read(user, type, id, { includeDeleted: true })) throw conflict();
            if (Number(this.stmtCount.get(String(user.userId), type)?.count || 0) >= LIMITS[type]) {
                throw new HttpError(409, 'ai_knowledge_limit_reached', `At most ${LIMITS[type]} ${type} rows are allowed.`);
            }
            const timestamp = Number(this.now());
            this.stmtInsert.run(String(user.userId), type, id, JSON.stringify(payload), timestamp, timestamp);
            return this.read(user, type, id);
        });
    }

    update(userOrId, type, id, patch, {
        expectedRevision,
        actorDeviceId = null,
        mutationReceipt = null,
        forceRevision = false,
        changedSecretFields = [],
    } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        const before = this.read(user, type, id);
        if (!before) throw inaccessible();
        if (Number(expectedRevision) !== before.revision) throw conflict();
        const previousPayload = this._payload(type, before);
        const payload = normalizePayload(type, patch, previousPayload);
        if (isDeepStrictEqual(previousPayload, payload) && !forceRevision) return before;
        return this._runMutation({
            entityType: type, entityId: id, action: 'upsert', user, before,
            actorDeviceId, mutationReceipt, changedSecretFields,
        }, () => {
            const result = this.stmtUpdate.run(JSON.stringify(payload), Number(this.now()), String(user.userId), type, id, before.revision);
            if (Number(result.changes || 0) !== 1) throw conflict();
            return this.read(user, type, id);
        });
    }

    remove(userOrId, type, id, { expectedRevision, actorDeviceId = null, mutationReceipt = null } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        const before = this.read(user, type, id);
        if (!before) throw inaccessible();
        if (Number(expectedRevision) !== before.revision) throw conflict();
        return this._runMutation({ entityType: type, entityId: id, action: 'delete', user, before, actorDeviceId, mutationReceipt }, () => {
            const timestamp = Number(this.now());
            const result = this.stmtDelete.run(timestamp, timestamp, String(user.userId), type, id, before.revision);
            if (Number(result.changes || 0) !== 1) throw conflict();
            this.stmtPrivateDelete.run(String(user.userId), type, id);
            if (type === 'aiEnv') this.stmtEnvSecretDelete.run(String(user.userId), id);
            return true;
        });
    }

    restore(userOrId, type, id, { expectedRevision, actorDeviceId = null, mutationReceipt = null } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        const before = this.read(user, type, id, { includeDeleted: true });
        if (!before || before.deletedAt == null) throw inaccessible();
        if (Number(expectedRevision) !== before.revision) throw conflict();
        return this._runMutation({ entityType: type, entityId: id, action: 'upsert', user, before, actorDeviceId, mutationReceipt }, () => {
            const result = this.stmtRestore.run(Number(this.now()), String(user.userId), type, id, before.revision);
            if (Number(result.changes || 0) !== 1) throw conflict();
            return this.read(user, type, id);
        });
    }

    _payload(type, row) {
        const payload = {};
        for (const field of FIELD_NAMES[type] || []) {
            if (Object.prototype.hasOwnProperty.call(row || {}, field)) payload[field] = row[field];
        }
        return payload;
    }

    /** Web/runtime projections compose safe canonical fields with private UI
     * policy. `forRuntime` is the only path that opens an env ciphertext. */
    listForUser(userOrId, type, { forRuntime = false } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        return this.list(user, type).map((row) => {
            const privateMetadata = this._privateMetadata(user.userId, type, row.id);
            const next = { ...row, ...privateMetadata };
            if (type === 'aiEnv') {
                if (forRuntime) next.value = this._envValue(user.userId, row.id);
                else {
                    next.hasValue = !!this.stmtEnvSecretGet.get(String(user.userId), row.id);
                    next.value = '';
                }
            }
            return next;
        });
    }

    /**
     * Mobile receives secret fields only after MobileV1Api has authenticated
     * and opened a per-field envelope. Keep that short-lived plaintext out of
     * the canonical projection, change feed, and Web compatibility facade.
     */
    writeFromMobile(userOrId, type, id, input = {}, mutationContext = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('AI knowledge patch must be an object.');
        const allowed = new Set([...FIELD_NAMES[type], ...(type === 'aiEnv' ? ['value'] : [])]);
        for (const key of Object.keys(input)) {
            if (!allowed.has(key)) throw invalid(`Field ${key} is not syncable for ${type}.`);
        }
        const corePatch = Object.fromEntries(FIELD_NAMES[type]
            .filter((field) => Object.prototype.hasOwnProperty.call(input, field))
            .map((field) => [field, input[field]]));
        const hasEnvValue = type === 'aiEnv' && Object.prototype.hasOwnProperty.call(input, 'value');
        const receipt = mutationContext.mutationReceipt;
        return this.db.transaction(() => {
            const current = this.read(user, type, id);
            const saved = current
                ? this.update(user, type, id, corePatch, {
                    expectedRevision: current.revision,
                    actorDeviceId: mutationContext.actorDeviceId,
                    mutationReceipt: receipt,
                    // A secret-only write must still advance the canonical
                    // revision without placing the secret in a field mask.
                    forceRevision: hasEnvValue,
                })
                : this.create(user, type, id, corePatch, {
                    actorDeviceId: mutationContext.actorDeviceId,
                    mutationReceipt: receipt,
                });
            if (hasEnvValue) this._setEnvValue(user.userId, id, input.value);
            /* MobileV1Api must not synthesize a fallback change with the
             * secret field in its mask when a revision-only secret write emits
             * no portable payload change. */
            if (receipt && !receipt.changeSeq) receipt.handled = true;
            return saved;
        })();
    }

    writeFromWeb(userOrId, type, id, input = {}, { expectedRevision } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        const allowed = new Set([
            ...FIELD_NAMES[type], 'enabled', 'description', 'valueVisibleToAi', 'value', 'revision',
            // Compatibility-only server fields from existing Web payloads.
            'id', 'ownerUserId', 'createdAt', 'updatedAt', 'hasValue',
        ]);
        for (const key of Object.keys(input || {})) if (!allowed.has(key)) throw invalid(`Field ${key} is not accepted by the Web compatibility facade.`);
        const redactedExistingValue = type === 'aiEnv' && input.hasValue === true && input.value === '';
        const changesEnvValue = type === 'aiEnv'
            && input.value !== undefined
            && input.value !== '******'
            && !redactedExistingValue;
        return this.db.transaction(() => {
            const current = this.read(user, type, id, { includeDeleted: true });
            if (current?.deletedAt != null) throw conflict();
            const corePatch = Object.fromEntries(FIELD_NAMES[type]
                .filter((field) => Object.prototype.hasOwnProperty.call(input, field))
                .map((field) => [field, input[field]]));
            let saved;
            if (!current) {
                saved = this.create(user, type, id, corePatch, {
                    changedSecretFields: changesEnvValue ? ['value'] : [],
                });
            } else {
                const revision = expectedRevision ?? input.revision ?? current.revision;
                saved = this.update(user, type, id, corePatch, {
                    expectedRevision: revision,
                    forceRevision: changesEnvValue,
                    changedSecretFields: changesEnvValue ? ['value'] : [],
                });
            }
            const existingPrivate = this._privateMetadata(user.userId, type, id);
            this._setPrivateMetadata(user.userId, type, id, this._privatePatch(type, input, existingPrivate));
            /* The Web view deliberately redacts a stored value as '' plus
             * hasValue=true. A full-form save must preserve that ciphertext;
             * only an explicit empty edit (hasValue absent/false) clears it. */
            if (type === 'aiEnv' && input.value !== undefined && input.value !== '******' && !redactedExistingValue) {
                this._setEnvValue(user.userId, id, input.value);
            }
            return this.listForUser(user, type).find((item) => item.id === id) || saved;
        })();
    }

    removeFromWeb(userOrId, type, id, { expectedRevision } = {}) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        id = validId(id);
        return this.db.transaction(() => {
            const current = this.read(user, type, id);
            if (!current) throw inaccessible();
            this.remove(user, type, id, { expectedRevision: expectedRevision ?? current.revision });
            this.stmtPrivateDelete.run(String(user.userId), type, id);
            if (type === 'aiEnv') this.stmtEnvSecretDelete.run(String(user.userId), id);
            return true;
        })();
    }

    replaceFromWeb(userOrId, type, items) {
        const user = requireOwner(userOrId);
        type = this._assertType(type);
        if (!Array.isArray(items) || items.length > LIMITS[type]) throw invalid(`${type} must be a bounded array.`);
        return this.db.transaction(() => {
            const existing = new Map(this.list(user, type).map((item) => [item.id, item]));
            const seen = new Set();
            for (const item of items) {
                const id = validId(item?.id);
                if (seen.has(id)) throw invalid(`Duplicate ${type} id.`);
                seen.add(id);
                this.writeFromWeb(user, type, id, item || {}, { expectedRevision: item?.revision });
            }
            for (const [id, row] of existing) {
                if (!seen.has(id)) this.removeFromWeb(user, type, id, { expectedRevision: row.revision });
            }
            return this.listForUser(user, type);
        })();
    }

    /* A legacy global bag has no owner and must never be auto-copied. Callers
     * may migrate only after supplying the authenticated owner explicitly. */
    migrateLegacyForOwner(userOrId, legacyAi, { legacyOwnerUserId } = {}) {
        const user = requireOwner(userOrId);
        if (String(legacyOwnerUserId || '') !== String(user.userId)) {
            throw new HttpError(403, 'legacy_ai_owner_required', 'Legacy AI data has no matching explicit owner.');
        }
        const source = legacyAi && typeof legacyAi === 'object' ? legacyAi : {};
        return this.db.transaction(() => ({
            memories: this.replaceFromWeb(user, 'aiMemory', Array.isArray(source.memories) ? source.memories : []),
            skills: this.replaceFromWeb(user, 'aiSkill', Array.isArray(source.skills) ? source.skills.filter((item) => item?.id !== 'zephyr-unified-operator') : []),
            envVars: this.replaceFromWeb(user, 'aiEnv', Array.isArray(source.envVars) ? source.envVars : []),
        }))();
    }
}

function getAiKnowledgeSyncCapability({ registry, service } = {}) {
    const specs = ENTITY_TYPES.map((type) => (registry?.entities || []).find((entry) => entry?.type === type));
    if (specs.some((spec) => !spec)) return { enabled: false, code: 'ai_knowledge_registry_missing' };
    if (specs.some((spec) => /^(blocked|requires)-/i.test(String(spec.status || '')))) {
        return { enabled: false, code: 'ai_knowledge_registry_blocked' };
    }
    const missing = REQUIRED_CAPABILITIES.filter((name) => service?.mobileSyncCapabilities?.[name] !== true);
    if (missing.length) return { enabled: false, code: 'ai_knowledge_capability_missing', missing };
    const operations = ['residency', 'list', 'read', 'create', 'update', 'remove', 'restore', 'writeFromMobile'];
    const absent = operations.filter((name) => typeof service?.[name] !== 'function');
    if (absent.length) return { enabled: false, code: 'ai_knowledge_service_incomplete', missing: absent };
    return { enabled: true, code: null };
}

function createAiKnowledgeEntityAdapters({ db, store, changeBridge, service, now, registry } = {}) {
    const bridge = changeBridge === undefined
        ? (store ? getMobileV1ChangeBridge(db, { store }) : undefined)
        : changeBridge;
    const knowledge = service || new AiKnowledgeService({
        db,
        now,
        mobileChangeBridge: bridge,
    });
    const capability = getAiKnowledgeSyncCapability({ registry, service: knowledge });
    const adapters = new Map();
    if (!capability.enabled) return adapters;
    for (const type of ENTITY_TYPES) {
        adapters.set(type, {
            idOf: (row) => row.id,
            residency: (user, id) => knowledge.residency(user, type, id),
            list: (user) => knowledge.listOwnedForSync(user, type),
            read: (user, id) => knowledge.readOwnedForSync(user, type, id),
            revisionOf: (row) => Math.max(1, Number(row?.revision) || 1),
            create: (user, id, patch, mutationContext = {}) => knowledge.writeFromMobile(user, type, id, patch, mutationContext),
            update: (user, id, patch, mutationContext = {}) => {
                const current = knowledge.read(user, type, id);
                if (!current) throw inaccessible();
                return knowledge.writeFromMobile(user, type, id, patch, mutationContext);
            },
            remove: (user, id, mutationContext = {}) => {
                const current = knowledge.read(user, type, id);
                if (!current) throw inaccessible();
                return knowledge.remove(user, type, id, { expectedRevision: current.revision, ...mutationContext });
            },
            restore: (user, id, mutationContext = {}) => {
                const deleted = knowledge.read(user, type, id, { includeDeleted: true });
                if (!deleted) throw inaccessible();
                return knowledge.restore(user, type, id, { expectedRevision: deleted.revision, ...mutationContext });
            },
            capability,
        });
    }
    return adapters;
}

module.exports = {
    AiKnowledgeService,
    createAiKnowledgeEntityAdapters,
    getAiKnowledgeSyncCapability,
    ENTITY_TYPES,
    REQUIRED_CAPABILITIES,
    FIELD_NAMES,
};
