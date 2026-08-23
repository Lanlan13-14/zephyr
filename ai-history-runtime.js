'use strict';

const crypto = require('crypto');

const WEB_HISTORY_ROLES = new Set(['user', 'assistant']);
const MAX_WEB_CONVERSATIONS = 200;
const MAX_WEB_MESSAGES = 2000;
const MAX_MESSAGE_CHARS = 400_000;

function cleanId(value, field = 'id') {
    const id = String(value || '').trim();
    if (!id || id.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) {
        const error = new Error(`${field} is invalid`);
        error.code = 'invalid_request';
        error.status = 400;
        throw error;
    }
    return id;
}

function cleanMessageContent(value) {
    const content = String(value ?? '');
    if (content.length > MAX_MESSAGE_CHARS) {
        const error = new Error('AI message is too large');
        error.code = 'ai_message_too_large';
        error.status = 413;
        throw error;
    }
    return content;
}

function identityOf(user) {
    const userId = String(user?.userId || '').trim();
    if (!userId) {
        const error = new Error('Authentication required');
        error.code = 'unauthorized';
        error.status = 401;
        throw error;
    }
    return { userId };
}

function isNotFound(error) {
    return error?.status === 404 || /not[_ -]?found|不存在/i.test(String(error?.code || error?.message || ''));
}

function safeReadConversation(service, user, id) {
    try {
        return service.readConversation(user, id) || null;
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

function projectConversation(row) {
    if (!row) return null;
    return {
        id: String(row.id || ''),
        ownerUserId: String(row.ownerUserId || ''),
        revision: Number(row.revision || 0),
        title: String(row.title || ''),
        providerId: row.providerId == null ? null : String(row.providerId),
        model: row.model == null ? null : String(row.model),
        archived: row.archived === true,
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
    };
}

function projectMessage(row) {
    if (!row || !WEB_HISTORY_ROLES.has(String(row.role || '').toLowerCase())) return null;
    return {
        id: String(row.id || ''),
        ownerUserId: String(row.ownerUserId || ''),
        revision: Number(row.revision || 0),
        conversationId: String(row.conversationId || ''),
        role: String(row.role || '').toLowerCase(),
        content: String(row.content || ''),
        attachments: (Array.isArray(row.attachments) ? row.attachments : []).map((item) => ({
            id: String(item?.id || ''),
            name: String(item?.name || ''),
            mime: String(item?.mime || ''),
            size: Math.max(0, Number(item?.size) || 0),
        })).filter((item) => item.id),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
    };
}

function expectedRevision(req) {
    const raw = req.body?.expectedRevision
        ?? req.headers?.['if-match']
        ?? req.query?.expectedRevision;
    const parsed = Number(String(raw ?? '').replace(/^W\//, '').replaceAll('"', ''));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sendHistoryError(res, error) {
    const status = Number(error?.status) || (error?.code === 'revision_conflict' ? 409 : 400);
    res.status(status).json({
        error: error?.message || 'AI history operation failed',
        code: error?.code || 'ai_history_failed',
    });
}

/**
 * Payload-free browser wake channel. The only observable fact is that this
 * account's history changed; rows are always re-read through authenticated
 * REST. No message, entity id, provider or model is put on the SSE wire.
 */
class AiHistoryWakeHub {
    constructor({ heartbeatMs = 15_000, maxPerOwner = 6 } = {}) {
        this.heartbeatMs = Math.max(1_000, Number(heartbeatMs) || 15_000);
        this.maxPerOwner = Math.max(1, Number(maxPerOwner) || 6);
        this.clients = new Map();
        this.sequence = new Map();
    }

    subscribe(req, res, user) {
        const ownerUserId = identityOf(user).userId;
        let clients = this.clients.get(ownerUserId);
        if (!clients) {
            clients = new Set();
            this.clients.set(ownerUserId, clients);
        }
        if (clients.size >= this.maxPerOwner) {
            res.status(429).json({ error: 'Too many AI history listeners', code: 'ai_history_listener_limit' });
            return false;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        const client = { req, res, timer: null, closed: false, ownerUserId };
        clients.add(client);
        const close = () => this._close(client);
        client.close = close;
        req.once('aborted', close);
        res.once('close', close);
        res.once('error', close);
        res.write('retry: 3000\n\n');
        this._write(client, this.sequence.get(ownerUserId) || 0, 'connected');
        client.timer = setInterval(() => {
            if (!client.closed && !res.destroyed && !res.writableEnded) {
                try { res.write(': heartbeat\n\n'); } catch { this._close(client); }
            }
        }, this.heartbeatMs);
        client.timer.unref?.();
        return true;
    }

    publish(ownerUserId) {
        const owner = String(ownerUserId || '').trim();
        if (!owner) return 0;
        const sequence = (this.sequence.get(owner) || 0) + 1;
        this.sequence.set(owner, sequence);
        const clients = this.clients.get(owner);
        if (!clients) return 0;
        let sent = 0;
        for (const client of [...clients]) {
            if (this._write(client, sequence, 'change')) sent += 1;
        }
        return sent;
    }

    _write(client, sequence, reason) {
        if (!client || client.closed || client.res.destroyed || client.res.writableEnded) {
            this._close(client);
            return false;
        }
        try {
            client.res.write(`id: ${sequence}\nevent: change\ndata: ${JSON.stringify({ sequence, reason })}\n\n`);
            return true;
        } catch {
            this._close(client);
            return false;
        }
    }

    _close(client) {
        if (!client || client.closed) return;
        client.closed = true;
        if (client.timer) clearInterval(client.timer);
        client.req.off?.('aborted', client.close);
        client.res.off?.('close', client.close);
        client.res.off?.('error', client.close);
        const clients = this.clients.get(client.ownerUserId);
        clients?.delete(client);
        if (clients?.size === 0) this.clients.delete(client.ownerUserId);
        try { if (!client.res.writableEnded) client.res.end(); } catch {}
    }

    close() {
        for (const clients of this.clients.values()) {
            for (const client of [...clients]) this._close(client);
        }
    }
}

class AiHistoryRuntimeController {
    constructor({ service, wakeHub, idFactory } = {}) {
        if (!service) throw new TypeError('AiHistoryRuntimeController requires an AiHistoryService');
        this.service = service;
        this.wakeHub = wakeHub || null;
        this.idFactory = idFactory || (() => crypto.randomUUID());
        this.pendingRuns = new Map();
    }

    ensureConversation(user, data = {}) {
        const actor = identityOf(user);
        const id = cleanId(data.id || this.idFactory(), 'conversationId');
        const existing = safeReadConversation(this.service, actor, id);
        if (existing) {
            if (String(existing.ownerUserId || '') !== actor.userId) {
                const error = new Error('AI conversation not found');
                error.code = 'ai_conversation_not_found';
                error.status = 404;
                throw error;
            }
            return existing;
        }
        const created = this.service.createConversation(actor, {
            id,
            title: String(data.title || '').slice(0, 200),
            providerId: data.providerId == null ? null : String(data.providerId),
            model: data.model == null ? null : String(data.model),
            archived: false,
        });
        return created;
    }

    beginRun(user, runId, commit = {}) {
        const actor = identityOf(user);
        const id = cleanId(runId, 'runId');
        const conversationId = cleanId(commit.conversationId, 'conversationId');
        const conversation = safeReadConversation(this.service, actor, conversationId);
        if (!conversation || String(conversation.ownerUserId || '') !== actor.userId) {
            const error = new Error('AI conversation not found');
            error.code = 'ai_conversation_not_found';
            error.status = 404;
            throw error;
        }
        const userMessage = commit.userMessage || {};
        const content = cleanMessageContent(userMessage.content);
        const pending = {
            user: actor,
            conversationId,
            expectedConversationRevision: Number(conversation.revision),
            baseConversation: {
                title: conversation.title,
                providerId: conversation.providerId,
                model: conversation.model,
            },
            userMessage: {
                id: cleanId(userMessage.id || this.idFactory(), 'userMessage.id'),
                role: 'user',
                content,
                attachments: (Array.isArray(userMessage.attachments) ? userMessage.attachments : [])
                    .map((item) => ({
                        id: cleanId(typeof item === 'string' ? item : item?.id, 'attachment.id'),
                        sessionId: String(commit.runtimeSessionId || item?.sessionId || '').trim(),
                        name: String(item?.name || ''),
                        mime: String(item?.mime || ''),
                        size: Math.max(0, Number(item?.size) || 0),
                    })),
            },
            assistantMessageId: cleanId(commit.assistantMessageId || this.idFactory(), 'assistantMessage.id'),
            conversationPatch: {
                title: String(commit.title || conversation.title || '').slice(0, 200),
                providerId: commit.providerId == null ? conversation.providerId : String(commit.providerId),
                model: commit.model == null ? conversation.model : String(commit.model),
            },
            assistantContent: '',
        };
        this.pendingRuns.set(id, pending);
        return pending;
    }

    observeEvent(runId, event = {}) {
        const id = String(runId || event?.runId || '').trim();
        const pending = this.pendingRuns.get(id);
        if (!pending) return null;
        const type = String(event?.type || '').trim();
        const body = event?.data && typeof event.data === 'object' && !Buffer.isBuffer(event.data)
            ? event.data
            : {};
        if (type === 'message.completed' && String(body.role || 'assistant').toLowerCase() === 'assistant') {
            pending.assistantContent = cleanMessageContent(body.content || '');
            return { pending: true, completedMessage: true };
        }
        if (type === 'run.failed' || type === 'run.aborted') {
            this.pendingRuns.delete(id);
            return { discarded: true };
        }
        if (type !== 'run.completed') return { pending: true };
        return this.finalizeRun(id, pending.assistantContent);
    }

    finalizeRun(runId, assistantContent) {
        const id = cleanId(runId, 'runId');
        const pending = this.pendingRuns.get(id);
        if (!pending) return null;
        const content = cleanMessageContent(assistantContent || pending.assistantContent || '');
        if (!content) {
            const error = new Error('Completed AI run has no final assistant message');
            error.code = 'ai_completed_message_missing';
            error.status = 502;
            throw error;
        }
        const append = (expectedRevision, conversationPatch) => this.service.appendCompletedTurn(
            pending.user,
            pending.conversationId,
            {
                userMessage: pending.userMessage,
                assistantMessage: {
                    id: pending.assistantMessageId,
                    role: 'assistant',
                    content,
                    attachments: [],
                },
                conversationPatch,
            },
            { expectedRevision, actorDeviceId: null, mutationReceipt: {} },
        );
        let result;
        try {
            result = append(pending.expectedConversationRevision, pending.conversationPatch);
        } catch (error) {
            if (error?.code !== 'revision_conflict') throw error;
            const current = this.service.readConversation(pending.user, pending.conversationId);
            if (!current) throw error;
            const patch = { ...pending.conversationPatch };
            // Preserve concurrent metadata edits. Runtime may fill metadata
            // only when that field still equals the value observed at start.
            for (const field of ['title', 'providerId', 'model']) {
                if (current[field] !== pending.baseConversation[field]) delete patch[field];
            }
            result = append(Number(current.revision), patch);
        }
        this.pendingRuns.delete(id);
        return result;
    }

    discardRun(runId) {
        return this.pendingRuns.delete(String(runId || '').trim());
    }

    deleteUserState(ownerUserId) {
        const owner = String(ownerUserId || '').trim();
        let discarded = 0;
        for (const [runId, pending] of this.pendingRuns) {
            if (String(pending?.user?.userId || '') !== owner) continue;
            this.pendingRuns.delete(runId);
            discarded += 1;
        }
        return discarded;
    }

    reset() {
        const discarded = this.pendingRuns.size;
        this.pendingRuns.clear();
        return discarded;
    }

    commitLegacyResult(user, requestBody = {}, result = {}) {
        const commit = requestBody?.historyCommit;
        if (!commit || typeof commit !== 'object') return null;
        const actor = identityOf(user);
        const conversation = this.ensureConversation(actor, {
            id: commit.conversationId,
            title: commit.title,
            providerId: commit.providerId || result.provider?.id,
            model: commit.model || result.model,
        });
        const userMessage = commit.userMessage || {};
        const assistant = result.message || {};
        const assistantContent = cleanMessageContent(assistant.content || '');
        if (!assistantContent) return null;
        const persisted = this.service.appendCompletedTurn(actor, conversation.id, {
            userMessage: {
                id: cleanId(userMessage.id || this.idFactory(), 'userMessage.id'),
                role: 'user',
                content: cleanMessageContent(userMessage.content),
                attachments: [],
            },
            assistantMessage: {
                id: cleanId(commit.assistantMessageId || this.idFactory(), 'assistantMessage.id'),
                role: 'assistant',
                content: assistantContent,
                attachments: [],
            },
            conversationPatch: {
                title: String(commit.title || conversation.title || '').slice(0, 200),
                providerId: commit.providerId || result.provider?.id || conversation.providerId,
                model: commit.model || result.model || conversation.model,
            },
        }, { expectedRevision: Number(conversation.revision), actorDeviceId: null, mutationReceipt: {} });
        return persisted;
    }

    bootstrapMessages(user, conversationId) {
        const actor = identityOf(user);
        const id = cleanId(conversationId, 'conversationId');
        const conversation = safeReadConversation(this.service, actor, id);
        if (!conversation || String(conversation.ownerUserId || '') !== actor.userId) return [];
        return this.service.listMessages(actor, { conversationId: id })
            .filter((row) => String(row.ownerUserId || '') === actor.userId
                && WEB_HISTORY_ROLES.has(String(row.role || '').toLowerCase()))
            .slice(-500)
            .map((row) => ({ role: String(row.role).toLowerCase(), content: cleanMessageContent(row.content) }));
    }
}

function registerAiHistoryRoutes(app, { requireUser, service, controller, wakeHub } = {}) {
    if (!app || typeof app.get !== 'function') throw new TypeError('Express app is required');
    if (typeof requireUser !== 'function') throw new TypeError('requireUser middleware is required');
    const runtime = controller || new AiHistoryRuntimeController({ service, wakeHub });
    const history = service || runtime.service;
    const hub = wakeHub || runtime.wakeHub;

    app.get('/api/ai/history/conversations', requireUser, (req, res) => {
        try {
            const user = identityOf(req.user);
            const conversations = history.listConversations(user)
                .filter((row) => String(row.ownerUserId || '') === user.userId && !row.deletedAt)
                .slice(0, MAX_WEB_CONVERSATIONS)
                .map(projectConversation);
            if (String(req.query?.withMessages || '') === '1') {
                const sessions = conversations.map((conversation) => ({
                    ...conversation,
                    messages: history.listMessages(user, { conversationId: conversation.id })
                        .filter((row) => String(row.ownerUserId || '') === user.userId)
                        .map(projectMessage).filter(Boolean).slice(-MAX_WEB_MESSAGES),
                }));
                return res.json({ ok: true, conversations: sessions });
            }
            res.json({ ok: true, conversations });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.post('/api/ai/history/conversations', requireUser, (req, res) => {
        try {
            const row = runtime.ensureConversation(req.user, req.body || {});
            res.status(201).json({ ok: true, conversation: projectConversation(row) });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.patch('/api/ai/history/conversations/:id', requireUser, (req, res) => {
        try {
            const user = identityOf(req.user);
            const patch = {};
            for (const field of ['title', 'providerId', 'model', 'archived']) {
                if (Object.hasOwn(req.body || {}, field)) patch[field] = req.body[field];
            }
            const row = history.updateConversation(user, cleanId(req.params.id), patch, {
                expectedRevision: expectedRevision(req),
            });
            res.json({ ok: true, conversation: projectConversation(row) });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.delete('/api/ai/history/conversations/:id', requireUser, (req, res) => {
        try {
            const user = identityOf(req.user);
            const id = cleanId(req.params.id);
            history.deleteConversation(user, id, {
                expectedRevision: expectedRevision(req),
            });
            res.json({ ok: true, deleted: true });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.get('/api/ai/history/conversations/:id/messages', requireUser, (req, res) => {
        try {
            const user = identityOf(req.user);
            const conversationId = cleanId(req.params.id, 'conversationId');
            const conversation = history.readConversation(user, conversationId);
            if (!conversation || String(conversation.ownerUserId || '') !== user.userId) {
                const error = new Error('AI conversation not found');
                error.code = 'ai_conversation_not_found';
                error.status = 404;
                throw error;
            }
            const messages = history.listMessages(user, { conversationId })
                .filter((row) => String(row.ownerUserId || '') === user.userId)
                .map(projectMessage).filter(Boolean).slice(-MAX_WEB_MESSAGES);
            res.json({ ok: true, messages });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.patch('/api/ai/history/messages/:id', requireUser, (req, res) => {
        try {
            const user = identityOf(req.user);
            const id = cleanId(req.params.id);
            const patch = {};
            if (Object.hasOwn(req.body || {}, 'content')) patch.content = cleanMessageContent(req.body.content);
            const row = history.updateMessage(user, id, patch, { expectedRevision: expectedRevision(req) });
            res.json({ ok: true, message: projectMessage(row) });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.delete('/api/ai/history/messages/:id', requireUser, (req, res) => {
        try {
            const user = identityOf(req.user);
            const id = cleanId(req.params.id);
            history.deleteMessage(user, id, {
                expectedRevision: expectedRevision(req),
            });
            res.json({ ok: true, deleted: true });
        } catch (error) { sendHistoryError(res, error); }
    });

    app.post('/api/ai/history/import-owned-legacy', requireUser, (req, res) => {
        try {
            identityOf(req.user);
            const error = new Error('Legacy browser history has no server-verifiable owner');
            error.code = 'legacy_history_owner_unproven';
            error.status = 400;
            throw error;
        } catch (error) { sendHistoryError(res, error); }
    });

    if (hub) {
        app.get('/api/ai/history/events', requireUser, (req, res) => {
            try { hub.subscribe(req, res, req.user); } catch (error) { sendHistoryError(res, error); }
        });
    }
    return runtime;
}

module.exports = {
    AiHistoryRuntimeController,
    AiHistoryWakeHub,
    WEB_HISTORY_ROLES,
    cleanMessageContent,
    projectConversation,
    projectMessage,
    registerAiHistoryRoutes,
    sendHistoryError,
};
