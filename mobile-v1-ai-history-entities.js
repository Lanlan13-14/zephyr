/**
 * Mobile v1 adapters for persisted AI history.
 *
 * AI runtime responses are intentionally not a sync source.  A history
 * service must opt in with the capability contract below after it owns a
 * canonical, transactional schema.  Until then the registry status keeps both
 * types unsupported, rather than leaking prompts, tool traces, or transient
 * runtime state through the mobile mirror.
 */
'use strict';

const { MobileStoreError } = require('./mobile-v1-store');

const HISTORY_TYPES = Object.freeze(['aiConversation', 'aiMessage']);
const USER_VISIBLE_ROLES = new Set(['user', 'assistant']);
const REQUIRED_CAPABILITIES = Object.freeze([
    'stableIds',
    'revisions',
    'tombstones',
    'ownerIsolation',
    'atomicChangeFeed',
    'persistentOnly',
    'attachmentResidency',
]);

function specFor(registry, type) {
    return (registry?.entities || []).find((entry) => entry?.type === type) || null;
}

/**
 * Registry status is authoritative.  Do not infer readiness from methods
 * incidentally present on the runtime bridge: its read endpoints include data
 * that is deliberately outside the mobile contract.
 */
function registryDirection(spec) {
    const status = String(spec?.status || '').toLowerCase();
    if (!spec || !status.startsWith('implemented-')) return 'blocked';
    if (status.includes('read-only') || status.includes('readonly')) return 'read-only';
    return 'bidirectional';
}

function getAiHistorySyncCapability({ registry, service } = {}) {
    const directions = Object.fromEntries(HISTORY_TYPES.map((type) => [
        type,
        registryDirection(specFor(registry, type)),
    ]));
    const registryBlocked = HISTORY_TYPES.some((type) => directions[type] === 'blocked');
    if (registryBlocked) {
        return {
            enabled: false,
            directions,
            code: 'ai_history_schema_blocked',
            reason: 'The entity registry has not declared a canonical AI history schema ready.',
        };
    }
    if (!service || typeof service !== 'object') {
        return {
            enabled: false,
            directions,
            code: 'ai_history_service_unavailable',
            reason: 'A canonical AI history persistence service was not supplied.',
        };
    }
    const declared = service.mobileSyncCapabilities;
    const absent = REQUIRED_CAPABILITIES.filter((name) => declared?.[name] !== true);
    if (absent.length) {
        return {
            enabled: false,
            directions,
            code: 'ai_history_capability_missing',
            reason: 'The history service cannot prove all mobile sync safety invariants.',
            missing: absent,
        };
    }
    const operations = [
        'listConversations', 'readConversation', 'conversationResidency',
        'listMessages', 'readMessage', 'messageResidency', 'assertAttachmentOwned',
    ];
    for (const type of HISTORY_TYPES) {
        if (directions[type] === 'bidirectional') {
            const singular = type === 'aiConversation' ? 'Conversation' : 'Message';
            operations.push(
                `create${singular}`,
                `update${singular}`,
                `delete${singular}`,
                `restore${singular}`,
            );
        }
    }
    const missingOperations = operations.filter((name) => typeof service[name] !== 'function');
    if (missingOperations.length) {
        return {
            enabled: false,
            directions,
            code: 'ai_history_service_incomplete',
            reason: 'The history service is missing canonical persistence operations.',
            missing: missingOperations,
        };
    }
    return { enabled: true, directions, code: null, reason: null };
}

function idOf(row) {
    const id = String(row?.id || '').trim();
    if (!id) throw new TypeError('AI history rows require a stable id');
    return id;
}

function revisionOf(row) {
    const revision = Number(row?.revision);
    if (!Number.isInteger(revision) || revision < 1) {
        throw new TypeError('AI history rows require a positive integer revision');
    }
    return revision;
}

function byStableOrder(left, right) {
    const time = Number(left?.createdAt || 0) - Number(right?.createdAt || 0);
    if (time) return time;
    const leftId = idOf(left);
    const rightId = idOf(right);
    return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0);
}

function ownedBy(row, user) {
    return !!row && String(row.ownerUserId || '') === String(user?.userId || '');
}

function inaccessible(kind) {
    return new MobileStoreError(
        'resource_not_found_or_inaccessible',
        `The AI ${kind} does not exist or is inaccessible.`,
        404,
    );
}

function requireOwnedRow(row, user, kind) {
    if (!ownedBy(row, user)) throw inaccessible(kind);
    return row;
}

function projectConversation(row) {
    return {
        id: idOf(row),
        ownerUserId: String(row.ownerUserId || ''),
        revision: revisionOf(row),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
        title: String(row.title || ''),
        providerId: row.providerId == null ? null : String(row.providerId),
        model: row.model == null ? null : String(row.model),
        archived: !!row.archived,
    };
}

function safeAttachments(service, user, message, { strict = false } = {}) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const safeAttachments = [];
    const seenIds = new Set();
    for (const attachment of attachments) {
        const requestedId = String(attachment?.id || '').trim();
        if (requestedId && seenIds.has(requestedId)) continue;
        if (requestedId) seenIds.add(requestedId);
        /* This callback is intentionally mandatory. A generic attachment id can
         * name a shared/foreign resource, and a shallow ownerUserId check is not
         * a substitute for the canonical resource ACL/residency decision. */
        const safe = service.assertAttachmentOwned(user, attachment, message);
        if (!safe || typeof safe !== 'object' || safe.shared === true || safe.ownerUserId !== user.userId) {
            if (!strict) continue;
            const error = new Error('AI message attachment is not an owned syncable resource');
            error.code = 'attachment_not_syncable';
            throw error;
        }
        safeAttachments.push({
            id: String(safe.id || ''),
            name: String(safe.name || ''),
            mime: String(safe.mime || ''),
            size: Math.max(0, Number(safe.size) || 0),
        });
    }
    return safeAttachments;
}

function projectMessage(service, user, row) {
    const role = String(row?.role || '').toLowerCase();
    if (!USER_VISIBLE_ROLES.has(role)) {
        const error = new Error('Only persisted user and assistant messages are syncable');
        error.code = 'ai_message_role_forbidden';
        throw error;
    }
    return {
        id: idOf(row),
        ownerUserId: String(row.ownerUserId || ''),
        revision: revisionOf(row),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
        conversationId: String(row.conversationId || ''),
        role,
        content: String(row.content || ''),
        attachments: safeAttachments(service, user, row),
    };
}

function createAiHistoryEntityAdapters({ registry, service } = {}) {
    const capability = getAiHistorySyncCapability({ registry, service });
    const adapters = new Map();
    if (!capability.enabled) return adapters;

    const conversationDirection = capability.directions.aiConversation;
    const messageDirection = capability.directions.aiMessage;
    const conversationAdapter = {
        idOf,
        revisionOf,
        residency: (user, id) => service.conversationResidency(user, id),
        list: (user) => service.listConversations(user).filter((row) => ownedBy(row, user))
            .map(projectConversation).sort(byStableOrder),
        read: (user, id) => {
            const row = service.readConversation(user, id);
            return ownedBy(row, user) ? projectConversation(row) : null;
        },
    };
    if (conversationDirection === 'bidirectional') {
        conversationAdapter.create = (user, id, patch, mutationContext = {}) => projectConversation(service.createConversation(
            user, { id, ...pickConversationPatch(patch) },
            mutationContext,
        ));
        conversationAdapter.update = (user, id, patch, mutationContext = {}) => {
            const current = requireOwnedRow(service.readConversation(user, id), user, 'conversation');
            return projectConversation(service.updateConversation(
                user,
                id,
                pickConversationPatch(patch),
                { ...mutationContext, expectedRevision: revisionOf(current) },
            ));
        };
        conversationAdapter.remove = (user, id, mutationContext = {}) => {
            const current = requireOwnedRow(service.readConversation(user, id), user, 'conversation');
            return service.deleteConversation(
                user,
                id,
                { ...mutationContext, expectedRevision: revisionOf(current) },
            );
        };
        conversationAdapter.restore = (user, id, mutationContext = {}) => {
            const deleted = requireOwnedRow(
                service.readConversation(user, id, { includeDeleted: true }),
                user,
                'conversation',
            );
            if (deleted.deletedAt == null) throw inaccessible('conversation');
            return projectConversation(service.restoreConversation(
                user,
                id,
                { ...mutationContext, expectedRevision: revisionOf(deleted) },
            ));
        };
    }
    adapters.set('aiConversation', conversationAdapter);

    const messageAdapter = {
        idOf,
        revisionOf,
        residency: (user, id) => service.messageResidency(user, id),
        list: (user) => service.listMessages(user).filter((row) => ownedBy(row, user)
            && USER_VISIBLE_ROLES.has(String(row.role || '').toLowerCase()))
            .map((row) => projectMessage(service, user, row)).sort(byStableOrder),
        read: (user, id) => {
            const row = service.readMessage(user, id);
            return ownedBy(row, user) && USER_VISIBLE_ROLES.has(String(row.role || '').toLowerCase())
                ? projectMessage(service, user, row)
                : null;
        },
    };
    if (messageDirection === 'bidirectional') {
        messageAdapter.create = (user, id, patch, mutationContext = {}) => projectMessage(service, user, service.createMessage(
            user, { id, ...pickMessagePatch(service, user, patch) },
            mutationContext,
        ));
        messageAdapter.update = (user, id, patch, mutationContext = {}) => {
            const current = requireOwnedRow(service.readMessage(user, id), user, 'message');
            return projectMessage(service, user, service.updateMessage(
                user,
                id,
                pickMessagePatch(service, user, patch),
                { ...mutationContext, expectedRevision: revisionOf(current) },
            ));
        };
        messageAdapter.remove = (user, id, mutationContext = {}) => {
            const current = requireOwnedRow(service.readMessage(user, id), user, 'message');
            return service.deleteMessage(
                user,
                id,
                { ...mutationContext, expectedRevision: revisionOf(current) },
            );
        };
        messageAdapter.restore = (user, id, mutationContext = {}) => {
            const deleted = requireOwnedRow(
                service.readMessage(user, id, { includeDeleted: true }),
                user,
                'message',
            );
            if (deleted.deletedAt == null) throw inaccessible('message');
            return projectMessage(service, user, service.restoreMessage(
                user,
                id,
                { ...mutationContext, expectedRevision: revisionOf(deleted) },
            ));
        };
    }
    adapters.set('aiMessage', messageAdapter);
    return adapters;
}

function pickConversationPatch(patch = {}) {
    const safe = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) safe.title = String(patch.title || '');
    if (Object.prototype.hasOwnProperty.call(patch, 'providerId')) {
        safe.providerId = patch.providerId == null ? null : String(patch.providerId);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
        safe.model = patch.model == null ? null : String(patch.model);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'archived')) safe.archived = !!patch.archived;
    return safe;
}

function pickMessagePatch(service, user, patch = {}) {
    const safe = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
        const role = String(patch.role || '').toLowerCase();
        if (!USER_VISIBLE_ROLES.has(role)) {
            const error = new Error('Only user and assistant messages can be written through mobile sync');
            error.code = 'ai_message_role_forbidden';
            throw error;
        }
        safe.role = role;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'conversationId')) safe.conversationId = String(patch.conversationId || '');
    if (Object.prototype.hasOwnProperty.call(patch, 'content')) safe.content = String(patch.content || '');
    if (Object.prototype.hasOwnProperty.call(patch, 'attachments')) {
        safe.attachments = safeAttachments(service, user, patch, { strict: true });
    }
    return safe;
}

module.exports = {
    HISTORY_TYPES,
    REQUIRED_CAPABILITIES,
    registryDirection,
    getAiHistorySyncCapability,
    createAiHistoryEntityAdapters,
    projectConversation,
    projectMessage,
};
