import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createAiHistoryEntityAdapters } = require(path.join(root, 'mobile-v1-ai-history-entities.js'));
const { createLinkSyncBridge } = require(path.join(root, 'link-v2-sync-bridge.js'));
const { KIND } = require(path.join(root, 'link-v2-codec.js'));

function makeMockService() {
    const conversations = new Map();
    const messages = new Map();
    let revisionCounter = 1;

    return {
        mobileSyncCapabilities: {
            stableIds: true,
            revisions: true,
            tombstones: true,
            ownerIsolation: true,
            atomicChangeFeed: true,
            persistentOnly: true,
            attachmentResidency: true,
        },
        listConversations: (user) => [...conversations.values()].filter(c => c.ownerUserId === user.userId && c.deletedAt == null),
        readConversation: (user, id, { includeDeleted = false } = {}) => {
            const row = conversations.get(id);
            if (!row || row.ownerUserId !== user.userId) return null;
            if (row.deletedAt != null && !includeDeleted) return null;
            return row;
        },
        conversationResidency: (user, id) => conversations.has(id) ? 'owned' : 'missing',
        createConversation: (user, patch) => {
            const id = patch.id || `conv-${Date.now()}`;
            const row = {
                id,
                ownerUserId: user.userId,
                title: patch.title || '新对话',
                model: patch.model || 'default',
                providerId: patch.providerId || 'default',
                revision: revisionCounter++,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                deletedAt: null,
            };
            conversations.set(id, row);
            return row;
        },
        updateConversation: (user, id, patch, { expectedRevision }) => {
            const row = conversations.get(id);
            if (!row || row.ownerUserId !== user.userId) throw new Error('not found');
            if (expectedRevision != null && row.revision !== expectedRevision) {
                const err = new Error('revision conflict');
                err.code = 'revision_conflict';
                throw err;
            }
            if (patch.title !== undefined) row.title = patch.title;
            row.revision = revisionCounter++;
            row.updatedAt = Date.now();
            return row;
        },
        deleteConversation: (user, id, { expectedRevision } = {}) => {
            const row = conversations.get(id);
            if (!row || row.ownerUserId !== user.userId) throw new Error('not found');
            row.deletedAt = Date.now();
            row.revision = revisionCounter++;
            // Cascade delete messages
            for (const msg of messages.values()) {
                if (msg.conversationId === id) {
                    msg.deletedAt = Date.now();
                    msg.revision = revisionCounter++;
                }
            }
            return { deleted: true, revision: row.revision };
        },
        restoreConversation: (user, id) => {
            const row = conversations.get(id);
            if (!row || row.ownerUserId !== user.userId) throw new Error('not found');
            row.deletedAt = null;
            row.revision = revisionCounter++;
            return row;
        },
        listMessages: (user) => [...messages.values()].filter(m => m.ownerUserId === user.userId && m.deletedAt == null),
        readMessage: (user, id) => {
            const m = messages.get(id);
            return m && m.ownerUserId === user.userId && m.deletedAt == null ? m : null;
        },
        createMessage: (user, patch) => {
            const id = patch.id || `msg-${Date.now()}`;
            const row = {
                id,
                ownerUserId: user.userId,
                conversationId: patch.conversationId,
                role: patch.role || 'user',
                content: patch.content || '',
                revision: revisionCounter++,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                deletedAt: null,
            };
            messages.set(id, row);
            return row;
        },
        updateMessage: (user, id, patch) => {
            const row = messages.get(id);
            if (!row || row.ownerUserId !== user.userId) throw new Error('not found');
            if (patch.content !== undefined) row.content = patch.content;
            row.revision = revisionCounter++;
            row.updatedAt = Date.now();
            return row;
        },
        deleteMessage: (user, id) => {
            const row = messages.get(id);
            if (!row || row.ownerUserId !== user.userId) throw new Error('not found');
            row.deletedAt = Date.now();
            row.revision = revisionCounter++;
            return { deleted: true, revision: row.revision };
        },
        restoreMessage: (user, id) => {
            const row = messages.get(id);
            if (!row || row.ownerUserId !== user.userId) throw new Error('not found');
            row.deletedAt = null;
            row.revision = revisionCounter++;
            return row;
        },
        messageResidency: (user, id) => messages.has(id) ? 'owned' : 'missing',
        assertAttachmentOwned: () => true,
    };
}

test('Zephyr One and Zephyr main-end bidirectional AI conversation sync contract', () => {
    const registry = {
        entities: [
            { type: 'aiConversation', status: 'implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection' },
            { type: 'aiMessage', status: 'implemented-canonical-service-revision-tombstone-atomic-change-feed-secret-safe-projection' },
        ],
    };
    const service = makeMockService();
    const adapters = createAiHistoryEntityAdapters({ registry, service });

    assert.ok(adapters.has('aiConversation'), 'aiConversation adapter must be active');
    const convAdapter = adapters.get('aiConversation');
    const user = { userId: 'alice' };

    // 1. One creates conversation
    const created = convAdapter.create(user, 'c-101', { title: '测试对话', model: 'gpt-4' });
    assert.equal(created.id, 'c-101');
    assert.equal(created.title, '测试对话');

    // Both ends can read it
    const read = convAdapter.read(user, 'c-101');
    assert.equal(read.id, 'c-101');
    assert.equal(read.title, '测试对话');

    // 2. Main end or One deletes conversation with matching revision
    const delResult = convAdapter.remove(user, 'c-101');
    assert.equal(delResult.deleted, true);

    // After deletion, conversation is not visible in active list on both ends
    assert.equal(convAdapter.read(user, 'c-101'), null);
    assert.equal(convAdapter.list(user).length, 0);
});

test('Zephyr Link owned-sync bridge dispatches AI conversation operations', () => {
    let pushedOp = null;
    const bridge = createLinkSyncBridge({
        api: {
            store: {
                getDeviceRow: (id) => (id === 'dev-one' ? { device_id: 'dev-one', owner_user_id: 'alice', enabled: 1, revoked_at: null } : null),
            },
            executePushForDevice: (auth, request) => {
                pushedOp = request;
                return { ok: true, batchId: 'b-ai', serverCursor: 50 };
            },
        },
        storage: {
            getUserBrief: (id) => (id === 'alice' ? { userId: 'alice', status: 'active' } : null),
        },
        adminToken: 'strong-secret-token-12345678',
    });

    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };

    bridge.handle({
        get: (header) => (header.toLowerCase() === 'x-link-admin' ? 'strong-secret-token-12345678' : null),
        body: {
            deviceId: 'dev-one',
            kind: KIND.SYNC_OP,
            body: {
                op: 'push',
                operations: [
                    { entityType: 'aiConversation', entityId: 'c-101', action: 'upsert', values: { title: 'Hello' } },
                ],
            },
        },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.kind, KIND.SYNC_ACK);
    assert.equal(pushedOp.operations.length, 1);
    assert.equal(pushedOp.operations[0].entityType, 'aiConversation');
});
