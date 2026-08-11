'use strict';

const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { HttpError } = require('./authz');
const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

const MAX_ID_CHARS = 160;
const MAX_TITLE_CHARS = 512;
const MAX_PROVIDER_CHARS = 160;
const MAX_MODEL_CHARS = 240;
const MAX_CONTENT_CHARS = 2 * 1024 * 1024;
const MAX_ATTACHMENTS = 32;
const MAX_ATTACHMENT_NAME_CHARS = 255;
const MAX_ATTACHMENT_MIME_CHARS = 160;
const USER_VISIBLE_ROLES = new Set(['user', 'assistant']);
const INLINE_DATA_URL = /data:[^;,\s]{1,160}(?:;[^,\s]{1,160})*;base64,/i;

const MOBILE_SYNC_CAPABILITIES = Object.freeze({
    stableIds: true,
    revisions: true,
    tombstones: true,
    ownerIsolation: true,
    atomicChangeFeed: true,
    persistentOnly: true,
    attachmentResidency: true,
});

const MOBILE_SYNC_CAPABILITIES_WITHOUT_FEED = Object.freeze({
    ...MOBILE_SYNC_CAPABILITIES,
    atomicChangeFeed: false,
});

function ensureAiHistorySchema(db) {
    if (!db) throw new TypeError('AI history schema requires a SQLite db');
    db.exec(`
        CREATE TABLE IF NOT EXISTS ai_conversations (
            owner_user_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            provider_id TEXT,
            model TEXT,
            archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            PRIMARY KEY (owner_user_id, conversation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_active_updated
            ON ai_conversations(owner_user_id, deleted_at, updated_at DESC, created_at DESC, conversation_id ASC);
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_id_owner
            ON ai_conversations(conversation_id, owner_user_id);

        CREATE TABLE IF NOT EXISTS ai_messages (
            owner_user_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL DEFAULT '',
            attachments_json TEXT NOT NULL DEFAULT '[]',
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            deleted_by_conversation INTEGER NOT NULL DEFAULT 0
                CHECK (deleted_by_conversation IN (0, 1)),
            PRIMARY KEY (owner_user_id, message_id),
            FOREIGN KEY (owner_user_id, conversation_id)
                REFERENCES ai_conversations(owner_user_id, conversation_id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ai_messages_owner_conversation_active_created
            ON ai_messages(owner_user_id, conversation_id, deleted_at, created_at ASC, message_id ASC);
        CREATE INDEX IF NOT EXISTS idx_ai_messages_id_owner
            ON ai_messages(message_id, owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_messages_deleted_gc
            ON ai_messages(deleted_at, owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_deleted_gc
            ON ai_conversations(deleted_at, owner_user_id);
    `);
}

function asUser(userOrId) {
    const user = userOrId && typeof userOrId === 'object'
        ? userOrId
        : { userId: String(userOrId || '') };
    const userId = String(user?.userId || '').trim();
    if (!userId) throw new HttpError(401, 'authentication_required', 'An authenticated account is required.');
    return { ...user, userId };
}

function historyError(status, code, message) {
    return new HttpError(status, code, message);
}

function inaccessible(kind) {
    return historyError(404, 'resource_not_found_or_inaccessible', `The AI ${kind} does not exist or is inaccessible.`);
}

function conflict(kind) {
    return historyError(409, 'revision_conflict', `The AI ${kind} changed on another client. Reload it and retry.`);
}

function validateId(value, kind, { generate = false } = {}) {
    const id = String(value || (generate ? crypto.randomUUID() : '')).trim();
    if (!id || id.length > MAX_ID_CHARS || /[\u0000-\u001f\u007f]/.test(id)) {
        throw historyError(400, `invalid_ai_${kind}`, `${kind} id must be 1-${MAX_ID_CHARS} printable characters.`);
    }
    return id;
}

function nullableText(value, maxChars, field) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw historyError(400, 'invalid_ai_history', `${field} must be text or null.`);
    const normalized = value.trim();
    if (normalized.length > maxChars) {
        throw historyError(400, 'invalid_ai_history', `${field} exceeds ${maxChars} characters.`);
    }
    return normalized || null;
}

function titleText(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw historyError(400, 'invalid_ai_history', 'title must be text.');
    const title = value.trim();
    if (title.length > MAX_TITLE_CHARS) {
        throw historyError(400, 'invalid_ai_history', `title exceeds ${MAX_TITLE_CHARS} characters.`);
    }
    return title;
}

function contentText(value) {
    if (typeof value !== 'string') throw historyError(400, 'invalid_ai_message', 'message content must be text.');
    if (value.length > MAX_CONTENT_CHARS) {
        throw historyError(413, 'ai_message_too_large', `message content exceeds ${MAX_CONTENT_CHARS} characters.`);
    }
    if (INLINE_DATA_URL.test(value)) {
        throw historyError(422, 'inline_attachment_forbidden', 'Inline attachment data cannot be persisted in AI history.');
    }
    return value;
}

function roleValue(value, fallback) {
    const role = String(value === undefined ? fallback || '' : value).trim().toLowerCase();
    if (!USER_VISIBLE_ROLES.has(role)) {
        throw historyError(422, 'ai_message_role_forbidden', 'Only completed user and assistant messages can be persisted.');
    }
    return role;
}

function jsonArray(raw) {
    try {
        const value = JSON.parse(String(raw || '[]'));
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function normalizeExpectedRevision(value, kind) {
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 1) {
        throw historyError(400, 'expected_revision_required', `A positive expectedRevision is required for AI ${kind} mutations.`);
    }
    return revision;
}

function stableLegacyId(ownerUserId, entityType, parentId, rawId, index) {
    const explicit = String(rawId || '').trim();
    if (explicit && explicit.length <= MAX_ID_CHARS && !/[\u0000-\u001f\u007f]/.test(explicit)) return explicit;
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify([String(ownerUserId), String(entityType), String(parentId || ''), Number(index)]))
        .digest('hex')
        .slice(0, 40);
    return `legacy-${entityType}-${digest}`;
}

function discardPromise(value) {
    if (!value || typeof value.then !== 'function') return false;
    Promise.resolve(value).catch(() => {});
    return true;
}

class AiHistoryService {
    constructor(db, now = () => Date.now(), options = {}) {
        if (!db) throw new TypeError('AiHistoryService requires a SQLite db');
        if (now && typeof now === 'object') {
            options = now;
            now = options.now || (() => Date.now());
        }
        this.db = db;
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.attachmentResolver = typeof options.attachmentResolver === 'function'
            ? options.attachmentResolver
            : null;
        this.legacyOwnershipVerifier = typeof options.legacyOwnershipVerifier === 'function'
            ? options.legacyOwnershipVerifier
            : null;
        this.onMutation = typeof options.onMutation === 'function' ? options.onMutation : null;
        this.ownerSubscribers = new Map();
        this.pendingNotifications = new Map();
        this.notificationScheduled = false;
        ensureAiHistorySchema(db);
        this.mobileChangeBridge = options.mobileChangeBridge === false
            ? null
            : (options.mobileChangeBridge || getMobileV1ChangeBridge(db, {
                registry: options.registry,
                registryPath: options.registryPath,
            }));
        this.mobileSyncCapabilities = this.mobileChangeBridge
            ? MOBILE_SYNC_CAPABILITIES
            : MOBILE_SYNC_CAPABILITIES_WITHOUT_FEED;
        this._prepare();
    }

    _prepare() {
        this.stmtCommittedChange = this.mobileChangeBridge
            ? this.db.prepare(`SELECT 1 AS committed FROM mobile_sync_changes
                WHERE owner_user_id=? AND change_seq=? LIMIT 1`)
            : null;
        this.stmtListConversations = this.db.prepare(`SELECT * FROM ai_conversations
            WHERE owner_user_id = @ownerUserId AND deleted_at IS NULL
            ORDER BY updated_at DESC, created_at DESC, conversation_id ASC`);
        this.stmtListConversationsAll = this.db.prepare(`SELECT * FROM ai_conversations
            WHERE owner_user_id = @ownerUserId
            ORDER BY updated_at DESC, created_at DESC, conversation_id ASC`);
        this.stmtGetConversation = this.db.prepare(`SELECT * FROM ai_conversations
            WHERE owner_user_id = @ownerUserId AND conversation_id = @id`);
        this.stmtConversationAnyOwner = this.db.prepare(`SELECT owner_user_id FROM ai_conversations
            WHERE conversation_id = @id LIMIT 1`);
        this.stmtInsertConversation = this.db.prepare(`INSERT INTO ai_conversations
            (owner_user_id, conversation_id, title, provider_id, model, archived,
             revision, created_at, updated_at, deleted_at)
            VALUES (@ownerUserId, @id, @title, @providerId, @model, @archived,
                    1, @createdAt, @updatedAt, NULL)`);
        this.stmtUpdateConversation = this.db.prepare(`UPDATE ai_conversations
            SET title=@title, provider_id=@providerId, model=@model, archived=@archived,
                revision=revision+1, updated_at=@updatedAt
            WHERE owner_user_id=@ownerUserId AND conversation_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtTouchConversation = this.db.prepare(`UPDATE ai_conversations
            SET revision=revision+1, updated_at=@updatedAt
            WHERE owner_user_id=@ownerUserId AND conversation_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtDeleteConversation = this.db.prepare(`UPDATE ai_conversations
            SET revision=revision+1, updated_at=@updatedAt, deleted_at=@deletedAt
            WHERE owner_user_id=@ownerUserId AND conversation_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtRestoreConversation = this.db.prepare(`UPDATE ai_conversations
            SET revision=revision+1, updated_at=@updatedAt, deleted_at=NULL
            WHERE owner_user_id=@ownerUserId AND conversation_id=@id
              AND revision=@expectedRevision AND deleted_at IS NOT NULL`);

        this.stmtListMessages = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId AND deleted_at IS NULL
            ORDER BY created_at ASC, message_id ASC`);
        this.stmtListMessagesForConversation = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId AND conversation_id=@conversationId
              AND deleted_at IS NULL
            ORDER BY created_at ASC, message_id ASC`);
        this.stmtListMessagesAll = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId
            ORDER BY created_at ASC, message_id ASC`);
        this.stmtListMessagesForConversationAll = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId AND conversation_id=@conversationId
            ORDER BY created_at ASC, message_id ASC`);
        this.stmtGetMessage = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId AND message_id=@id`);
        this.stmtMessageAnyOwner = this.db.prepare(`SELECT owner_user_id FROM ai_messages
            WHERE message_id=@id LIMIT 1`);
        this.stmtInsertMessage = this.db.prepare(`INSERT INTO ai_messages
            (owner_user_id, message_id, conversation_id, role, content, attachments_json,
             revision, created_at, updated_at, deleted_at, deleted_by_conversation)
            VALUES (@ownerUserId, @id, @conversationId, @role, @content, @attachmentsJson,
                    1, @createdAt, @updatedAt, NULL, 0)`);
        this.stmtUpdateMessage = this.db.prepare(`UPDATE ai_messages
            SET conversation_id=@conversationId, role=@role, content=@content,
                attachments_json=@attachmentsJson, revision=revision+1, updated_at=@updatedAt
            WHERE owner_user_id=@ownerUserId AND message_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtDeleteMessage = this.db.prepare(`UPDATE ai_messages
            SET revision=revision+1, updated_at=@updatedAt, deleted_at=@deletedAt,
                deleted_by_conversation=@deletedByConversation
            WHERE owner_user_id=@ownerUserId AND message_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtRestoreMessage = this.db.prepare(`UPDATE ai_messages
            SET revision=revision+1, updated_at=@updatedAt, deleted_at=NULL,
                deleted_by_conversation=0
            WHERE owner_user_id=@ownerUserId AND message_id=@id
              AND revision=@expectedRevision AND deleted_at IS NOT NULL`);
        this.stmtCascadeDeletedMessages = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId AND conversation_id=@conversationId
              AND deleted_at IS NOT NULL AND deleted_by_conversation=1
            ORDER BY created_at ASC, message_id ASC`);
        this.stmtDeleteActiveMessages = this.db.prepare(`SELECT * FROM ai_messages
            WHERE owner_user_id=@ownerUserId AND conversation_id=@conversationId
              AND deleted_at IS NULL
            ORDER BY created_at ASC, message_id ASC`);
    }

    _timestampAfter(previous = 0, supplied) {
        const candidate = supplied === undefined ? Number(this.now()) : Number(supplied);
        const safe = Number.isFinite(candidate) && candidate >= 0 ? Math.floor(candidate) : Number(this.now());
        return Math.max(safe, Number(previous || 0) + (previous ? 1 : 0));
    }

    _priorVersion(ownerUserId, entityType, entityId) {
        return this.mobileChangeBridge?.store?.getEntityVersion?.(
            String(ownerUserId),
            String(entityType),
            String(entityId),
        ) || null;
    }

    _assertNeverReused(ownerUserId, entityType, entityId) {
        const prior = this._priorVersion(ownerUserId, entityType, entityId);
        if (!prior) return;
        throw historyError(
            409,
            'entity_id_tombstoned',
            'A previously allocated AI history id cannot be reused. Create a new stable id.',
        );
    }

    _conversation(row) {
        if (!row) return null;
        return {
            id: row.conversation_id,
            ownerUserId: row.owner_user_id,
            title: row.title || '',
            providerId: row.provider_id == null ? null : row.provider_id,
            model: row.model == null ? null : row.model,
            archived: !!row.archived,
            revision: Math.max(1, Number(row.revision) || 1),
            createdAt: Number(row.created_at) || 0,
            updatedAt: Number(row.updated_at) || 0,
            deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
        };
    }

    _message(row) {
        if (!row) return null;
        return {
            id: row.message_id,
            ownerUserId: row.owner_user_id,
            conversationId: row.conversation_id,
            role: row.role,
            content: row.content || '',
            attachments: jsonArray(row.attachments_json),
            revision: Math.max(1, Number(row.revision) || 1),
            createdAt: Number(row.created_at) || 0,
            updatedAt: Number(row.updated_at) || 0,
            deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
            deletedByConversation: !!row.deleted_by_conversation,
        };
    }

    _runMobileMutation(meta, write) {
        if (!this.mobileChangeBridge) return write();
        const suppliedReceipt = meta?.mutationReceipt;
        const receipt = suppliedReceipt && typeof suppliedReceipt === 'object' && !Array.isArray(suppliedReceipt)
            ? suppliedReceipt
            : {};
        const result = this.mobileChangeBridge.runMutation({ ...meta, mutationReceipt: receipt }, write);
        this._scheduleMutationNotification(meta?.user?.userId, receipt.changeSeq);
        return result;
    }

    /**
     * Wake notifications deliberately contain no entity id, title, message or
     * field mask. The microtask verifies that the feed row survived the
     * caller's outer transaction, so a later rollback cannot emit a false wake.
     */
    _scheduleMutationNotification(ownerUserId, changeSeq) {
        const owner = String(ownerUserId || '').trim();
        const cursor = Number(changeSeq);
        if (!owner || !Number.isInteger(cursor) || cursor < 1) return;
        let cursors = this.pendingNotifications.get(owner);
        if (!cursors) {
            cursors = new Set();
            this.pendingNotifications.set(owner, cursors);
        }
        cursors.add(cursor);
        if (this.notificationScheduled) return;
        this.notificationScheduled = true;
        queueMicrotask(() => {
            this.notificationScheduled = false;
            const pending = [...this.pendingNotifications.entries()];
            this.pendingNotifications.clear();
            for (const [ownerUserIdValue, candidateCursors] of pending) {
                let committedCursor = 0;
                try {
                    const candidates = [...candidateCursors].sort((left, right) => right - left);
                    committedCursor = candidates.find((cursorValue) => (
                        !!this.stmtCommittedChange?.get(ownerUserIdValue, cursorValue)
                    )) || 0;
                } catch {
                    committedCursor = 0;
                }
                if (!committedCursor) continue;
                const event = Object.freeze({ ownerUserId: ownerUserIdValue, cursor: committedCursor });
                try { discardPromise(this.onMutation?.(event)); } catch {}
                for (const listener of this.ownerSubscribers.get(ownerUserIdValue) || []) {
                    try { discardPromise(listener(event)); } catch {}
                }
            }
        });
    }

    subscribe(ownerUserId, listener) {
        const owner = String(ownerUserId || '').trim();
        if (!owner || typeof listener !== 'function') {
            throw new TypeError('subscribe requires an ownerUserId and listener');
        }
        let listeners = this.ownerSubscribers.get(owner);
        if (!listeners) {
            listeners = new Set();
            this.ownerSubscribers.set(owner, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.ownerSubscribers.delete(owner);
        };
    }

    _context(options = {}) {
        return {
            actorDeviceId: options?.actorDeviceId == null ? null : String(options.actorDeviceId),
            mutationReceipt: options?.mutationReceipt || null,
        };
    }

    _normalizeConversation(data = {}, old = null, trustedTimestamps = null) {
        const title = titleText(data.title);
        const providerId = nullableText(data.providerId, MAX_PROVIDER_CHARS, 'providerId');
        const model = nullableText(data.model, MAX_MODEL_CHARS, 'model');
        const createdAt = old?.createdAt || this._timestampAfter(0, trustedTimestamps?.createdAt);
        const suppliedUpdatedAt = trustedTimestamps
            ? (trustedTimestamps.updatedAt ?? createdAt)
            : undefined;
        return {
            id: validateId(data.id || old?.id, 'conversation', { generate: !old }),
            title: title === undefined ? (old?.title || '') : title,
            providerId: providerId === undefined ? (old?.providerId ?? null) : providerId,
            model: model === undefined ? (old?.model ?? null) : model,
            archived: data.archived === undefined ? !!old?.archived : !!data.archived,
            createdAt,
            updatedAt: old
                ? this._timestampAfter(old.updatedAt, suppliedUpdatedAt)
                : this._timestampAfter(Math.max(0, createdAt - 1), suppliedUpdatedAt),
        };
    }

    _resolvedAttachment(user, attachment) {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return null;
        const requestedId = String(attachment.id || '').trim();
        if (!requestedId || !this.attachmentResolver) return null;
        let resolved;
        try {
            resolved = this.attachmentResolver(user, { ...attachment, id: requestedId });
        } catch {
            return null;
        }
        if (discardPromise(resolved)) {
            throw historyError(500, 'attachment_proof_async_unsupported', 'Attachment ownership proof must be synchronous at the persistence boundary.');
        }
        if (!resolved || typeof resolved !== 'object'
            || String(resolved.id || '') !== requestedId
            || String(resolved.ownerUserId || '') !== user.userId
            || resolved.shared === true
            || resolved.mobileSyncAllowed !== true
            || !['owned', 'private-owned'].includes(String(resolved.residency || ''))) return null;
        const name = String(resolved.name || '').slice(0, MAX_ATTACHMENT_NAME_CHARS);
        const mime = String(resolved.mime || '').slice(0, MAX_ATTACHMENT_MIME_CHARS);
        const size = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(resolved.size) || 0)));
        return {
            id: requestedId,
            ownerUserId: user.userId,
            shared: false,
            residency: String(resolved.residency),
            mobileSyncAllowed: true,
            name,
            mime,
            size,
        };
    }

    _normalizeAttachments(user, input, { strict = true } = {}) {
        if (input === undefined) return undefined;
        if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) {
            throw historyError(400, 'invalid_ai_message', `attachments must contain at most ${MAX_ATTACHMENTS} references.`);
        }
        const safe = [];
        const ids = new Set();
        for (const attachment of input) {
            const requestedId = String(attachment?.id || '').trim();
            if (requestedId && ids.has(requestedId)) continue;
            if (requestedId) ids.add(requestedId);
            const resolved = this._resolvedAttachment(user, attachment);
            if (!resolved) {
                if (strict) {
                    throw historyError(422, 'attachment_not_syncable', 'An attachment is not an owned, private, mobile-resident resource.');
                }
                continue;
            }
            safe.push({
                id: resolved.id,
                name: resolved.name,
                mime: resolved.mime,
                size: resolved.size,
            });
        }
        return safe;
    }

    _normalizeMessage(user, data = {}, old = null, trustedTimestamps = null, { strictAttachments = true } = {}) {
        const conversationId = validateId(data.conversationId || old?.conversationId, 'conversation');
        const conversation = this.readConversation(user, conversationId);
        if (!conversation) throw inaccessible('conversation');
        const attachments = this._normalizeAttachments(user, data.attachments, { strict: strictAttachments });
        const createdAt = old?.createdAt || this._timestampAfter(0, trustedTimestamps?.createdAt);
        const suppliedUpdatedAt = trustedTimestamps
            ? (trustedTimestamps.updatedAt ?? createdAt)
            : undefined;
        return {
            id: validateId(data.id || old?.id, 'message', { generate: !old }),
            conversationId,
            role: roleValue(data.role, old?.role),
            content: data.content === undefined && old ? old.content : contentText(data.content),
            attachments: attachments === undefined ? (old?.attachments || []) : attachments,
            createdAt,
            updatedAt: old
                ? this._timestampAfter(old.updatedAt, suppliedUpdatedAt)
                : this._timestampAfter(Math.max(0, createdAt - 1), suppliedUpdatedAt),
        };
    }

    listConversations(userOrId, { includeDeleted = false } = {}) {
        const user = asUser(userOrId);
        const statement = includeDeleted ? this.stmtListConversationsAll : this.stmtListConversations;
        return statement.all({ ownerUserId: user.userId }).map((row) => this._conversation(row));
    }

    readConversation(userOrId, id, { includeDeleted = false } = {}) {
        const user = asUser(userOrId);
        const row = this._conversation(this.stmtGetConversation.get({
            ownerUserId: user.userId,
            id: validateId(id, 'conversation'),
        }));
        if (!row || (!includeDeleted && row.deletedAt != null)) return null;
        return row;
    }

    conversationResidency(userOrId, id) {
        const user = asUser(userOrId);
        const entityId = validateId(id, 'conversation');
        if (this.readConversation(user, entityId, { includeDeleted: true })) return 'owned';
        return this.stmtConversationAnyOwner.get({ id: entityId }) ? 'foreign' : 'missing';
    }

    createConversation(userOrId, data = {}, options = {}) {
        const user = asUser(userOrId);
        return this._createConversation(user, data, options, null);
    }

    _createConversation(user, data, options, trustedTimestamps) {
        const normalized = this._normalizeConversation(data, null, trustedTimestamps);
        const context = this._context(options);
        return this._runMobileMutation({
            entityType: 'aiConversation', entityId: normalized.id, action: 'upsert', user, before: null,
            ...context,
        }, () => {
            if (this.readConversation(user, normalized.id, { includeDeleted: true })) throw conflict('conversation');
            this._assertNeverReused(user.userId, 'aiConversation', normalized.id);
            this.stmtInsertConversation.run({
                ownerUserId: user.userId,
                ...normalized,
                archived: normalized.archived ? 1 : 0,
            });
            return this.readConversation(user, normalized.id);
        });
    }

    updateConversation(userOrId, id, patch = {}, options = {}) {
        const user = asUser(userOrId);
        const before = this.readConversation(user, id);
        if (!before) throw inaccessible('conversation');
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'conversation');
        if (expectedRevision !== before.revision) throw conflict('conversation');
        const next = this._normalizeConversation(patch, before);
        const comparable = (row) => ({
            title: row.title, providerId: row.providerId, model: row.model, archived: row.archived,
        });
        if (isDeepStrictEqual(comparable(before), comparable(next))) return before;
        const context = this._context(options);
        return this._runMobileMutation({
            entityType: 'aiConversation', entityId: before.id, action: 'upsert', user, before,
            ...context,
        }, () => {
            const result = this.stmtUpdateConversation.run({
                ownerUserId: user.userId,
                id: before.id,
                title: next.title,
                providerId: next.providerId,
                model: next.model,
                archived: next.archived ? 1 : 0,
                updatedAt: next.updatedAt,
                expectedRevision,
            });
            if (Number(result.changes || 0) !== 1) throw conflict('conversation');
            return this.readConversation(user, before.id);
        });
    }

    renameConversation(userOrId, id, title, options = {}) {
        return this.updateConversation(userOrId, id, { title }, options);
    }

    _touchConversation(user, id, options = {}) {
        const before = this.readConversation(user, id);
        if (!before) throw inaccessible('conversation');
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'conversation');
        if (expectedRevision !== before.revision) throw conflict('conversation');
        return this._runMobileMutation({
            entityType: 'aiConversation', entityId: before.id, action: 'upsert', user, before,
            ...this._context(options),
        }, () => {
            const result = this.stmtTouchConversation.run({
                ownerUserId: user.userId,
                id: before.id,
                updatedAt: this._timestampAfter(before.updatedAt),
                expectedRevision,
            });
            if (Number(result.changes || 0) !== 1) throw conflict('conversation');
            return this.readConversation(user, before.id);
        });
    }

    deleteConversation(userOrId, id, options = {}) {
        const user = asUser(userOrId);
        const context = this._context(options);
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'conversation');
        const receipts = [];
        return this.db.transaction(() => {
            const before = this.readConversation(user, id);
            if (!before) throw inaccessible('conversation');
            if (expectedRevision !== before.revision) throw conflict('conversation');
            const activeMessages = this.stmtDeleteActiveMessages.all({
                ownerUserId: user.userId,
                conversationId: before.id,
            }).map((row) => this._message(row));
            for (const message of activeMessages) {
                const childReceipt = {};
                this._deleteMessage(user, message.id, {
                    expectedRevision: message.revision,
                    actorDeviceId: context.actorDeviceId,
                    mutationReceipt: childReceipt,
                }, true);
                if (childReceipt.changeSeq) receipts.push(childReceipt.changeSeq);
            }
            const conversationReceipt = {};
            const deleted = this._runMobileMutation({
                entityType: 'aiConversation', entityId: before.id, action: 'delete', user, before,
                actorDeviceId: context.actorDeviceId,
                mutationReceipt: conversationReceipt,
                after: () => null,
            }, () => {
                const timestamp = this._timestampAfter(before.updatedAt);
                const result = this.stmtDeleteConversation.run({
                    ownerUserId: user.userId,
                    id: before.id,
                    updatedAt: timestamp,
                    deletedAt: timestamp,
                    expectedRevision,
                });
                if (Number(result.changes || 0) !== 1) throw conflict('conversation');
                return this.readConversation(user, before.id, { includeDeleted: true });
            });
            if (conversationReceipt.changeSeq) receipts.push(conversationReceipt.changeSeq);
            this._finishBatchReceipt(context.mutationReceipt, receipts);
            return deleted;
        })();
    }

    restoreConversation(userOrId, id, options = {}) {
        const user = asUser(userOrId);
        const context = this._context(options);
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'conversation');
        const receipts = [];
        return this.db.transaction(() => {
            const before = this.readConversation(user, id, { includeDeleted: true });
            if (!before || before.deletedAt == null) throw inaccessible('conversation');
            if (expectedRevision !== before.revision) throw conflict('conversation');
            const conversationReceipt = {};
            const restored = this._runMobileMutation({
                entityType: 'aiConversation', entityId: before.id, action: 'upsert', user, before,
                actorDeviceId: context.actorDeviceId,
                mutationReceipt: conversationReceipt,
            }, () => {
                const result = this.stmtRestoreConversation.run({
                    ownerUserId: user.userId,
                    id: before.id,
                    updatedAt: this._timestampAfter(before.updatedAt),
                    expectedRevision,
                });
                if (Number(result.changes || 0) !== 1) throw conflict('conversation');
                return this.readConversation(user, before.id);
            });
            if (conversationReceipt.changeSeq) receipts.push(conversationReceipt.changeSeq);
            const cascaded = this.stmtCascadeDeletedMessages.all({
                ownerUserId: user.userId,
                conversationId: before.id,
            }).map((row) => this._message(row));
            for (const message of cascaded) {
                const childReceipt = {};
                this.restoreMessage(user, message.id, {
                    expectedRevision: message.revision,
                    actorDeviceId: context.actorDeviceId,
                    mutationReceipt: childReceipt,
                });
                if (childReceipt.changeSeq) receipts.push(childReceipt.changeSeq);
            }
            this._finishBatchReceipt(context.mutationReceipt, receipts);
            return restored;
        })();
    }

    listMessages(userOrId, options = {}) {
        const user = asUser(userOrId);
        const includeDeleted = !!options.includeDeleted;
        const hasConversation = options.conversationId !== undefined && options.conversationId !== null;
        if (hasConversation) {
            const conversationId = validateId(options.conversationId, 'conversation');
            const statement = includeDeleted
                ? this.stmtListMessagesForConversationAll
                : this.stmtListMessagesForConversation;
            return statement.all({ ownerUserId: user.userId, conversationId })
                .map((row) => this._message(row));
        }
        const statement = includeDeleted ? this.stmtListMessagesAll : this.stmtListMessages;
        return statement.all({ ownerUserId: user.userId }).map((row) => this._message(row));
    }

    readMessage(userOrId, id, { includeDeleted = false } = {}) {
        const user = asUser(userOrId);
        const row = this._message(this.stmtGetMessage.get({
            ownerUserId: user.userId,
            id: validateId(id, 'message'),
        }));
        if (!row || (!includeDeleted && row.deletedAt != null)) return null;
        return row;
    }

    messageResidency(userOrId, id) {
        const user = asUser(userOrId);
        const entityId = validateId(id, 'message');
        if (this.readMessage(user, entityId, { includeDeleted: true })) return 'owned';
        return this.stmtMessageAnyOwner.get({ id: entityId }) ? 'foreign' : 'missing';
    }

    assertAttachmentOwned(userOrId, attachment) {
        return this._resolvedAttachment(asUser(userOrId), attachment);
    }

    createMessage(userOrId, data = {}, options = {}) {
        const user = asUser(userOrId);
        return this._createMessage(user, data, options, null, { strictAttachments: true });
    }

    appendCompletedMessage(userOrId, conversationId, data = {}, options = {}) {
        return this.createMessage(userOrId, { ...data, conversationId }, options);
    }

    _createMessage(user, data, options, trustedTimestamps, normalizeOptions) {
        const normalized = this._normalizeMessage(user, data, null, trustedTimestamps, normalizeOptions);
        const context = this._context(options);
        return this._runMobileMutation({
            entityType: 'aiMessage', entityId: normalized.id, action: 'upsert', user, before: null,
            ...context,
        }, () => {
            if (this.readMessage(user, normalized.id, { includeDeleted: true })) throw conflict('message');
            this._assertNeverReused(user.userId, 'aiMessage', normalized.id);
            this.stmtInsertMessage.run({
                ownerUserId: user.userId,
                ...normalized,
                attachmentsJson: JSON.stringify(normalized.attachments),
            });
            return this.readMessage(user, normalized.id);
        });
    }

    updateMessage(userOrId, id, patch = {}, options = {}) {
        const user = asUser(userOrId);
        const before = this.readMessage(user, id);
        if (!before) throw inaccessible('message');
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'message');
        if (expectedRevision !== before.revision) throw conflict('message');
        const next = this._normalizeMessage(user, patch, before, null, { strictAttachments: true });
        const comparable = (row) => ({
            conversationId: row.conversationId,
            role: row.role,
            content: row.content,
            attachments: row.attachments,
        });
        if (isDeepStrictEqual(comparable(before), comparable(next))) return before;
        const context = this._context(options);
        return this._runMobileMutation({
            entityType: 'aiMessage', entityId: before.id, action: 'upsert', user, before,
            ...context,
        }, () => {
            const result = this.stmtUpdateMessage.run({
                ownerUserId: user.userId,
                id: before.id,
                conversationId: next.conversationId,
                role: next.role,
                content: next.content,
                attachmentsJson: JSON.stringify(next.attachments),
                updatedAt: next.updatedAt,
                expectedRevision,
            });
            if (Number(result.changes || 0) !== 1) throw conflict('message');
            return this.readMessage(user, before.id);
        });
    }

    deleteMessage(userOrId, id, options = {}) {
        return this._deleteMessage(asUser(userOrId), id, options, false);
    }

    _deleteMessage(user, id, options, deletedByConversation) {
        const before = this.readMessage(user, id);
        if (!before) throw inaccessible('message');
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'message');
        if (expectedRevision !== before.revision) throw conflict('message');
        return this._runMobileMutation({
            entityType: 'aiMessage', entityId: before.id, action: 'delete', user, before,
            after: () => null,
            ...this._context(options),
        }, () => {
            const timestamp = this._timestampAfter(before.updatedAt);
            const result = this.stmtDeleteMessage.run({
                ownerUserId: user.userId,
                id: before.id,
                updatedAt: timestamp,
                deletedAt: timestamp,
                deletedByConversation: deletedByConversation ? 1 : 0,
                expectedRevision,
            });
            if (Number(result.changes || 0) !== 1) throw conflict('message');
            return this.readMessage(user, before.id, { includeDeleted: true });
        });
    }

    restoreMessage(userOrId, id, options = {}) {
        const user = asUser(userOrId);
        const before = this.readMessage(user, id, { includeDeleted: true });
        if (!before || before.deletedAt == null) throw inaccessible('message');
        if (!this.readConversation(user, before.conversationId)) throw inaccessible('conversation');
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'message');
        if (expectedRevision !== before.revision) throw conflict('message');
        return this._runMobileMutation({
            entityType: 'aiMessage', entityId: before.id, action: 'upsert', user, before,
            ...this._context(options),
        }, () => {
            const result = this.stmtRestoreMessage.run({
                ownerUserId: user.userId,
                id: before.id,
                updatedAt: this._timestampAfter(before.updatedAt),
                expectedRevision,
            });
            if (Number(result.changes || 0) !== 1) throw conflict('message');
            return this.readMessage(user, before.id);
        });
    }

    _finishBatchReceipt(receipt, changeSeqs) {
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return;
        const unique = [...new Set(changeSeqs.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
        receipt.changeSeqs = unique;
        if (unique.length) receipt.changeSeq = Math.max(...unique);
    }

    appendCompletedTurn(userOrId, conversationId, turn = {}, options = {}) {
        const user = asUser(userOrId);
        const id = validateId(conversationId, 'conversation');
        const expectedRevision = normalizeExpectedRevision(options.expectedRevision, 'conversation');
        const receipts = [];
        return this.db.transaction(() => {
            const before = this.readConversation(user, id);
            if (!before) throw inaccessible('conversation');
            if (before.revision !== expectedRevision) throw conflict('conversation');
            const userReceipt = {};
            const userMessage = this._createMessage(user, {
                ...(turn.userMessage || {}),
                conversationId: id,
                role: 'user',
            }, { actorDeviceId: options.actorDeviceId, mutationReceipt: userReceipt }, null, {
                strictAttachments: true,
            });
            if (userReceipt.changeSeq) receipts.push(userReceipt.changeSeq);
            const assistantReceipt = {};
            const assistantMessage = this._createMessage(user, {
                ...(turn.assistantMessage || {}),
                conversationId: id,
                role: 'assistant',
            }, { actorDeviceId: options.actorDeviceId, mutationReceipt: assistantReceipt }, null, {
                strictAttachments: true,
            });
            if (assistantReceipt.changeSeq) receipts.push(assistantReceipt.changeSeq);
            const conversationReceipt = {};
            const conversationPatch = turn.conversationPatch && typeof turn.conversationPatch === 'object'
                ? turn.conversationPatch
                : null;
            let conversation;
            if (conversationPatch && Object.keys(conversationPatch).length) {
                conversation = this.updateConversation(user, id, conversationPatch, {
                    expectedRevision,
                    actorDeviceId: options.actorDeviceId,
                    mutationReceipt: conversationReceipt,
                });
                /* A completed turn changes the conversation aggregate even
                 * when its editable metadata is unchanged. Touch exactly once
                 * so last-activity sorting and future CAS revisions advance. */
                if (conversation.revision === expectedRevision) {
                    conversation = this._touchConversation(user, id, {
                        expectedRevision,
                        actorDeviceId: options.actorDeviceId,
                        mutationReceipt: conversationReceipt,
                    });
                }
            } else {
                conversation = this._touchConversation(user, id, {
                    expectedRevision,
                    actorDeviceId: options.actorDeviceId,
                    mutationReceipt: conversationReceipt,
                });
            }
            if (conversationReceipt.changeSeq) receipts.push(conversationReceipt.changeSeq);
            this._finishBatchReceipt(options.mutationReceipt, receipts);
            return { conversation, messages: [userMessage, assistantMessage] };
        })();
    }

    migrateLegacyOwnedHistory(userOrId, sessions, options = {}) {
        const user = asUser(userOrId);
        if (!Array.isArray(sessions)) {
            throw historyError(400, 'invalid_legacy_ai_history', 'Legacy AI history must be an array of sessions.');
        }
        const stats = {
            conversationsCreated: 0,
            messagesCreated: 0,
            skippedUnverified: 0,
            skippedUnsafe: 0,
            skippedExisting: 0,
        };
        const receipts = [];
        this.db.transaction(() => {
            sessions.forEach((session, sessionIndex) => {
                if (!session || typeof session !== 'object' || Array.isArray(session)
                    || String(session.ownerUserId || '') !== user.userId) {
                    stats.skippedUnverified += 1;
                    return;
                }
                let verified = false;
                if (this.legacyOwnershipVerifier) {
                    try {
                        const proof = this.legacyOwnershipVerifier({
                            user,
                            session,
                            source: String(options.source || ''),
                            evidence: options.ownershipEvidence,
                        });
                        verified = discardPromise(proof) ? false : proof === true;
                    } catch {
                        verified = false;
                    }
                }
                if (!verified) {
                    stats.skippedUnverified += 1;
                    return;
                }
                const conversationId = stableLegacyId(user.userId, 'conversation', '', session.id, sessionIndex);
                let conversation = this.readConversation(user, conversationId, { includeDeleted: true });
                if (!conversation && this._priorVersion(user.userId, 'aiConversation', conversationId)) {
                    stats.skippedExisting += 1;
                    return;
                }
                if (!conversation) {
                    const receipt = {};
                    try {
                        conversation = this._createConversation(user, {
                            id: conversationId,
                            title: typeof session.title === 'string' ? session.title : '',
                            providerId: typeof session.providerId === 'string' ? session.providerId : null,
                            model: typeof session.model === 'string' ? session.model : null,
                            archived: !!session.archived,
                        }, { actorDeviceId: options.actorDeviceId, mutationReceipt: receipt }, {
                            createdAt: session.createdAt,
                            updatedAt: session.updatedAt,
                        });
                        stats.conversationsCreated += 1;
                        if (receipt.changeSeq) receipts.push(receipt.changeSeq);
                    } catch (error) {
                        if (error?.code === 'invalid_ai_history') stats.skippedUnsafe += 1;
                        else throw error;
                        return;
                    }
                } else {
                    stats.skippedExisting += 1;
                    if (conversation.deletedAt != null) return;
                }
                const messages = Array.isArray(session.messages) ? session.messages : [];
                messages.forEach((message, messageIndex) => {
                    if (!message || typeof message !== 'object' || Array.isArray(message)
                        || !USER_VISIBLE_ROLES.has(String(message.role || '').toLowerCase())) {
                        stats.skippedUnsafe += 1;
                        return;
                    }
                    const messageId = stableLegacyId(
                        user.userId,
                        'message',
                        conversationId,
                        message.id,
                        messageIndex,
                    );
                    if (this.readMessage(user, messageId, { includeDeleted: true })) {
                        stats.skippedExisting += 1;
                        return;
                    }
                    if (this._priorVersion(user.userId, 'aiMessage', messageId)) {
                        stats.skippedExisting += 1;
                        return;
                    }
                    const receipt = {};
                    try {
                        this._createMessage(user, {
                            id: messageId,
                            conversationId,
                            role: message.role,
                            content: message.content,
                            attachments: Array.isArray(message.attachments) ? message.attachments : [],
                        }, { actorDeviceId: options.actorDeviceId, mutationReceipt: receipt }, {
                            createdAt: message.createdAt,
                            updatedAt: message.updatedAt,
                        }, { strictAttachments: false });
                        stats.messagesCreated += 1;
                        if (receipt.changeSeq) receipts.push(receipt.changeSeq);
                    } catch (error) {
                        if (['invalid_ai_message', 'ai_message_too_large', 'inline_attachment_forbidden',
                            'ai_message_role_forbidden'].includes(error?.code)) {
                            stats.skippedUnsafe += 1;
                            return;
                        }
                        throw error;
                    }
                });
            });
            this._finishBatchReceipt(options.mutationReceipt, receipts);
        })();
        return stats;
    }

    purgeTombstones({ before, ownerUserId } = {}) {
        if (!this.mobileChangeBridge) {
            throw historyError(503, 'atomic_change_feed_required', 'AI history tombstones cannot be purged without the durable change ledger.');
        }
        const cutoff = Number(before);
        if (!Number.isFinite(cutoff) || cutoff < 0) {
            throw historyError(400, 'invalid_tombstone_cutoff', 'A non-negative tombstone cutoff is required.');
        }
        const owner = ownerUserId == null ? null : String(ownerUserId).trim();
        if (ownerUserId != null && !owner) {
            throw historyError(400, 'invalid_tombstone_owner', 'A non-empty tombstone owner is required when ownerUserId is supplied.');
        }
        return this.db.transaction(() => {
            const messageSql = owner
                ? `DELETE FROM ai_messages WHERE owner_user_id=@ownerUserId
                    AND deleted_at IS NOT NULL AND deleted_at < @before`
                : 'DELETE FROM ai_messages WHERE deleted_at IS NOT NULL AND deleted_at < @before';
            const conversationSql = owner
                ? `DELETE FROM ai_conversations WHERE owner_user_id=@ownerUserId
                    AND deleted_at IS NOT NULL AND deleted_at < @before`
                : 'DELETE FROM ai_conversations WHERE deleted_at IS NOT NULL AND deleted_at < @before';
            const params = owner ? { ownerUserId: owner, before: Math.floor(cutoff) } : { before: Math.floor(cutoff) };
            const messages = Number(this.db.prepare(messageSql).run(params).changes || 0);
            const conversations = Number(this.db.prepare(conversationSql).run(params).changes || 0);
            return { messages, conversations };
        })();
    }

    deleteUserState(userOrId) {
        const user = asUser(userOrId);
        return this.db.transaction(() => {
            /* Minimise recoverable sensitive text even if a test/development DB
             * was opened without the production secure_delete pragma. */
            this.db.prepare(`UPDATE ai_messages SET content='', attachments_json='[]'
                WHERE owner_user_id=?`).run(user.userId);
            const messages = Number(this.db.prepare('DELETE FROM ai_messages WHERE owner_user_id=?')
                .run(user.userId).changes || 0);
            const conversations = Number(this.db.prepare('DELETE FROM ai_conversations WHERE owner_user_id=?')
                .run(user.userId).changes || 0);
            return { messages, conversations };
        })();
    }
}

module.exports = {
    AiHistoryService,
    ensureAiHistorySchema,
    MOBILE_SYNC_CAPABILITIES,
    USER_VISIBLE_ROLES,
    MAX_ID_CHARS,
    MAX_TITLE_CHARS,
    MAX_CONTENT_CHARS,
    MAX_ATTACHMENTS,
    stableLegacyId,
};
