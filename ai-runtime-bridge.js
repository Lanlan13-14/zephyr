'use strict';
/*
 * ai-runtime-bridge.js - Node control plane ↔ zephyr-ai (Go) data plane.
 *
 * Node responsibilities:
 *   - AuthN/AuthZ, resolve provider secrets, build systemCompose (same assembly
 *     as legacy ai-agent-service — DO NOT thin for tokens), issue runs.
 *   - Platform tool host (/internal/ai-host/v1/*) executes Zephyr-local tools.
 *
 * Browser talks SSE to Go (ticket URL returned by startRun). Provider keys never
 * reach the browser.
 */
const crypto = require('crypto');
const { HttpError } = require('./authz');
const {
    DEFAULT_ZEPHYR_SYSTEM_PROMPT,
    DEFAULT_ZEPHYR_SKILLS,
    buildUnifiedZephyrSkill,
    cloneDefaultZephyrSkills,
} = require('./ai-defaults');
const { PLAYBOOKS } = require('./ai-playbooks');
const { inferModelWindowTokens } = require('./ai-context-budget');

const AI_URL = process.env.ZEPHYR_AI_URL || '';
const AI_ADMIN = process.env.ZEPHYR_AI_ADMIN_TOKEN || '';
const HOST_TOKEN = process.env.ZEPHYR_AI_PLATFORM_HOST_TOKEN || process.env.ZEPHYR_AI_ADMIN_TOKEN || '';

/** Incremental SSE parser used by the server-side completion monitor. */
function createRuntimeSseParser(onEvent) {
    let buffer = '';
    let eventName = '';
    let dataLines = [];
    const flush = () => {
        if (!eventName && dataLines.length === 0) return;
        const raw = dataLines.join('\n');
        let envelope = {};
        try { envelope = raw ? JSON.parse(raw) : {}; } catch { envelope = {}; }
        const type = String(envelope?.type || eventName || 'message');
        let data = envelope?.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { data = {}; }
        }
        try { onEvent?.({ ...envelope, type, data: data && typeof data === 'object' ? data : {} }); } catch (error) {
            // Persistence errors are not parser errors. Re-throw so the monitor
            // retains its pending record for reconciliation instead of silently
            // acknowledging a completion it did not persist.
            eventName = '';
            dataLines = [];
            throw error;
        }
        eventName = '';
        dataLines = [];
    };
    const process = () => {
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            let line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (!line) { flush(); continue; }
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
    };
    return {
        push(chunk) { buffer += String(chunk || ''); process(); },
        end() {
            if (buffer) {
                buffer += '\n';
                process();
            }
            flush();
        },
    };
}

class AiRuntimeBridge {
    constructor(deps = {}) {
        this.deps = deps;
        this.baseUrl = String(deps.baseUrl ?? AI_URL).replace(/\/$/, '');
        this.adminToken = String(deps.adminToken ?? AI_ADMIN);
        this.fetchImpl = deps.fetchImpl || globalThis.fetch;
        this.enabled = !!this.baseUrl;
        this.historyController = deps.historyController || null;
        this.historyMonitors = new Map();
        this.historyMonitorAborts = new Map();
        this.databaseGeneration = this._newDatabaseGeneration();
        this.maintenance = false;
        this.maintenanceDrain = null;
        this.runLeasesByNonce = new Map();
        this.runLeasesById = new Map();
        this.pendingStarts = new Set();
        this.inFlightHostCalls = 0;
        this.hostCallAborts = new Set();
        this.hostCallLeases = new Map();
        this.hostDrainWaiters = new Set();
        this.maintenanceTimeoutMs = Math.max(
            1,
            Number(deps.maintenanceTimeoutMs ?? deps.drainTimeoutMs) || 30_000,
        );
        this.maintenanceContext = null;
    }

    _newDatabaseGeneration() {
        return crypto.randomBytes(32).toString('base64url');
    }

    _maintenanceError() {
        return new HttpError(503, 'database_maintenance', 'Database maintenance is in progress', true);
    }

    _expiredRunError() {
        return new HttpError(409, 'ai_run_generation_expired', 'AI run belongs to an expired database generation');
    }

    _assertOperational() {
        if (this.maintenance) throw this._maintenanceError();
    }

    _assertCurrentRun(user, runId) {
        this._assertOperational();
        const id = String(runId || '').trim();
        const userId = String(user?.userId || '').trim();
        const lease = this.runLeasesById.get(id);
        if (!id || !userId || !lease || lease.generation !== this.databaseGeneration) {
            throw this._expiredRunError();
        }
        if (lease.userId !== userId) {
            throw new HttpError(403, 'ai_run_forbidden', 'AI run does not belong to this account');
        }
        return lease;
    }

    assertRunAccess(user, runId) {
        return this._assertCurrentRun(user, runId);
    }

    setHistoryController(controller) {
        this.historyController = controller || null;
    }

    _headers() {
        return {
            'content-type': 'application/json',
            'x-ai-admin': this.adminToken,
        };
    }

    _maintenanceTimeoutError() {
        const error = new Error('timed out draining AI runtime for database maintenance');
        error.code = 'ai_runtime_maintenance_timeout';
        return error;
    }

    _remainingDeadlineMs(deadline) {
        if (!Number.isFinite(deadline)) return null;
        return Math.max(0, deadline - Date.now());
    }

    _throwIfAborted(signal, deadline) {
        if (Number.isFinite(deadline) && this._remainingDeadlineMs(deadline) <= 0) {
            throw this._maintenanceTimeoutError();
        }
        if (signal?.aborted) throw signal.reason || this._expiredRunError();
    }

    _awaitAbortable(value, signal, deadline) {
        const promise = Promise.resolve(value);
        if (!signal && !Number.isFinite(deadline)) return promise;
        try {
            this._throwIfAborted(signal, deadline);
        } catch (error) {
            promise.catch(() => {});
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                signal?.removeEventListener?.('abort', onAbort);
            };
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };
            const onAbort = () => finish(reject, signal?.reason || this._expiredRunError());
            signal?.addEventListener?.('abort', onAbort, { once: true });
            if (Number.isFinite(deadline) && !signal) {
                const remaining = this._remainingDeadlineMs(deadline);
                if (remaining <= 0) {
                    finish(reject, this._maintenanceTimeoutError());
                    return;
                }
                timer = setTimeout(() => finish(reject, this._maintenanceTimeoutError()), remaining);
                timer.unref?.();
            }
            promise.then(
                (result) => {
                    try {
                        // A stalled event loop can run this callback after the
                        // absolute deadline but before its timeout task runs.
                        this._throwIfAborted(signal, deadline);
                        finish(resolve, result);
                    } catch (error) {
                        finish(reject, error);
                    }
                },
                (error) => {
                    try {
                        this._throwIfAborted(signal, deadline);
                        finish(reject, error);
                    } catch (deadlineError) {
                        finish(reject, deadlineError);
                    }
                },
            );
        });
    }

    _maintenanceFetchOptions(context) {
        this._throwIfAborted(context?.controller?.signal, context?.deadline);
        return { signal: context?.controller?.signal, deadline: context?.deadline };
    }

    async _fetchUnchecked(path, { method = 'GET', body, signal, deadline } = {}) {
        if (!this.enabled) throw new HttpError(503, 'ai_runtime_unavailable', 'Go AI 运行时未启用 (ZEPHYR_AI_URL)', true);
        this._throwIfAborted(signal, deadline);
        const fetchPromise = Promise.resolve().then(() => {
            this._throwIfAborted(signal, deadline);
            return this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                headers: this._headers(),
                body: body != null ? JSON.stringify(body) : undefined,
                signal,
            });
        });
        const res = await this._awaitAbortable(fetchPromise, signal, deadline);
        const data = await this._awaitAbortable(
            Promise.resolve().then(() => res.json()).catch(() => ({})),
            signal,
            deadline,
        );
        if (!res.ok) {
            throw new HttpError(res.status, data.code || 'ai_runtime_error', data.error || data.message || 'AI runtime error', res.status >= 500);
        }
        return data;
    }

    async createSession(user, { title, metadata } = {}) {
        return this._fetch('/admin/sessions', {
            method: 'POST',
            body: {
                userId: user.userId,
                databaseGeneration: this.databaseGeneration,
                title: title || '新对话',
                metadata: metadata || {},
            },
        });
    }

    async listSessions(user) {
        return this._fetch(`/admin/sessions?userId=${encodeURIComponent(user.userId)}&databaseGeneration=${encodeURIComponent(this.databaseGeneration)}`);
    }

    async getSession(user, sessionId) {
        return this._fetch(`/admin/sessions/${encodeURIComponent(sessionId)}?userId=${encodeURIComponent(user.userId)}&databaseGeneration=${encodeURIComponent(this.databaseGeneration)}`);
    }

    async listMessages(user, sessionId) {
        return this._fetch(`/admin/sessions/${encodeURIComponent(sessionId)}/messages?userId=${encodeURIComponent(user.userId)}&databaseGeneration=${encodeURIComponent(this.databaseGeneration)}`);
    }

    async getSessionUsage(user, sessionId) {
        return this._fetch(`/admin/sessions/${encodeURIComponent(sessionId)}/usage?userId=${encodeURIComponent(user.userId)}&databaseGeneration=${encodeURIComponent(this.databaseGeneration)}`);
    }

    /**
     * Start a streaming run. Returns { runId, ticket, ssePath }.
     * systemCompose MUST preserve full skill/memory/env assembly.
     */
    startRun(user, payload) {
        const abortController = new AbortController();
        const entry = { abortController, operation: null };
        const operation = this._startRun(user, payload, { signal: abortController.signal });
        entry.operation = operation;
        this.pendingStarts.add(entry);
        operation.finally(() => this.pendingStarts.delete(entry)).catch(() => {});
        return operation;
    }

    async _startRun(user, payload, { signal } = {}) {
        this._assertOperational();
        this._throwIfAborted(signal);
        const generation = this.databaseGeneration;
        const runNonce = crypto.randomBytes(32).toString('base64url');
        const lease = {
            generation,
            runNonce,
            runId: '',
            userId: String(user?.userId || '').trim(),
        };
        if (!lease.userId) throw new HttpError(401, 'app_session_expired', 'Login required');
        this.runLeasesByNonce.set(runNonce, lease);
        const body = {
            userId: user.userId,
            databaseGeneration: generation,
            runNonce,
            sessionId: payload.sessionId,
            provider: payload.provider,
            model: payload.model,
            message: payload.message,
            messages: payload.messages,
            // Canonical, owner-scoped history uses a separate wire field. Go
            // accepts only plain user/assistant content and imports it only
            // into an empty runtime session, so tool state cannot be smuggled
            // in through the regular multimodal `messages` tail.
            bootstrapMessages: Array.isArray(payload.bootstrapMessages) ? payload.bootstrapMessages : undefined,
            options: payload.options || {},
            maxSteps: payload.maxSteps || 0,
            permission: payload.permission || { mode: 'ask' },
            autoConfirm: !!payload.autoConfirm,
            autoConfirmDelayMs: Math.max(0, Math.min(Number(payload.autoConfirmDelayMs) || 0, 60000)),
            mode: payload.mode || 'standard',
            systemCompose: payload.systemCompose,
            context: payload.context || null,
            mcpServers: payload.mcpServers || [],
            hourlyLimit: payload.hourlyLimit || 0,
            dailyLimit: payload.dailyLimit || 0,
            contextWindowTokens: payload.contextWindowTokens || inferModelWindowTokens(payload.provider || {}, payload.model || '', 0),
            outputReserveTokens: payload.outputReserveTokens || Number(payload.options?.max_tokens || payload.options?.maxTokens || 0),
        };
        let data;
        try {
            data = await this._fetchUnchecked('/admin/runs', { method: 'POST', body, signal });
        } catch (error) {
            this.runLeasesByNonce.delete(runNonce);
            if (lease.runId) this.runLeasesById.delete(lease.runId);
            throw error;
        }
        const runId = String(data?.runId || '').trim();
        if (!runId) {
            this.runLeasesByNonce.delete(runNonce);
            throw new HttpError(502, 'ai_runtime_invalid_response', 'AI runtime did not return a run id', true);
        }
        if (lease.runId && lease.runId !== runId) {
            this.runLeasesByNonce.delete(runNonce);
            this.runLeasesById.delete(lease.runId);
            throw new HttpError(502, 'ai_runtime_run_mismatch', 'AI runtime returned a mismatched run id');
        }
        lease.runId = runId;
        this.runLeasesById.set(runId, lease);
        if (this.maintenance || generation !== this.databaseGeneration) {
            await this._fetchUnchecked(
                `/admin/runs/${encodeURIComponent(runId)}/abort`,
                { method: 'POST', body: {}, signal },
            ).catch(() => {});
            this.runLeasesByNonce.delete(runNonce);
            this.runLeasesById.delete(runId);
            throw this._expiredRunError();
        }
        if (this.historyController && payload.historyCommit && data?.runId) {
            this.historyController.beginRun(user, data.runId, {
                ...payload.historyCommit,
                runtimeSessionId: data.sessionId || payload.sessionId,
            });
            this._startHistoryMonitor(data.runId, data.ticket).catch((error) => {
                // A monitor failure must never expose or persist an incomplete
                // transcript. Keep the pending record for an explicit replay
                // or reconciliation attempt, and log metadata only.
                this.deps.log?.('[ai-runtime-history] monitor failed', {
                    runId: data.runId,
                    code: error?.code || error?.name || 'monitor_failed',
                });
            });
        }
        return data;
    }

    async _fetch(path, options = {}) {
        this._assertOperational();
        return this._fetchUnchecked(path, options);
    }

    async _startHistoryMonitor(runId, ticket) {
        if (!this.historyController || !runId || !ticket || !this.enabled) return null;
        if (this.historyMonitors.has(runId)) return this.historyMonitors.get(runId);
        const abortController = new AbortController();
        this.historyMonitorAborts.set(runId, abortController);
        const monitor = this._consumeHistoryEvents(runId, ticket, abortController.signal)
            .finally(() => {
                this.historyMonitors.delete(runId);
                this.historyMonitorAborts.delete(runId);
            });
        this.historyMonitors.set(runId, monitor);
        return monitor;
    }

    async _consumeHistoryEvents(runId, ticket, signal) {
        this._throwIfAborted(signal);
        const response = await this._awaitAbortable(
            Promise.resolve().then(() => this.fetchImpl(
                `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?ticket=${encodeURIComponent(ticket)}`,
                { headers: { accept: 'text/event-stream' }, signal },
            )),
            signal,
        );
        if (!response.ok) {
            const error = new Error(`AI runtime history monitor failed (${response.status})`);
            error.code = 'ai_runtime_history_monitor_failed';
            throw error;
        }
        const reader = response.body?.getReader?.();
        if (!reader) throw Object.assign(new Error('AI runtime SSE body unavailable'), { code: 'ai_runtime_sse_unavailable' });
        const decoder = new TextDecoder();
        const parser = createRuntimeSseParser((event) => {
            this.historyController?.observeEvent(runId, event);
            if (['run.completed', 'run.failed', 'run.aborted'].includes(String(event?.type || ''))) {
                this._forgetRun(runId);
            }
        });
        for (;;) {
            const { done, value } = await this._awaitAbortable(reader.read(), signal);
            if (done) break;
            parser.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
        return true;
    }

    _forgetRun(runId) {
        const lease = this.runLeasesById.get(String(runId || ''));
        if (!lease) return;
        this.runLeasesById.delete(lease.runId);
        this.runLeasesByNonce.delete(lease.runNonce);
    }

    async abortRun(user, runId) {
        this._assertCurrentRun(user, runId);
        const data = await this._fetchUnchecked(`/admin/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST', body: {} });
        this._forgetRun(runId);
        return data;
    }

    async getRun(user, runId) {
        this._assertCurrentRun(user, runId);
        return this._fetchUnchecked(`/admin/runs/${encodeURIComponent(runId)}`);
    }

    async decidePermission(user, runId, body) {
        const lease = this._assertCurrentRun(user, runId);
        return this._fetchUnchecked(`/admin/runs/${encodeURIComponent(runId)}/permission`, {
            method: 'POST',
            body: { ...body, databaseGeneration: lease.generation, runNonce: lease.runNonce },
        });
    }

    async uploadCaptureImage(user, runId, callId, bytes, mimeType) {
        this._assertCurrentRun(user, runId);
        const userId = String(user?.userId || '').trim();
        if (!userId) throw new HttpError(401, 'app_session_expired', '未登录或会话已过期');
        const query = new URLSearchParams({ userId, callId: String(callId || '') });
        if (!this.enabled) throw new HttpError(503, 'ai_runtime_unavailable', 'Go AI 运行时未启用 (ZEPHYR_AI_URL)', true);
        const response = await this.fetchImpl(`${this.baseUrl}/admin/runs/${encodeURIComponent(runId)}/capture-image?${query}`, {
            method: 'POST',
            headers: { 'X-AI-Admin': this.adminToken, 'Content-Type': mimeType || 'application/octet-stream' },
            body: bytes,
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
        if (!response.ok || data.ok === false) throw new Error(data.error || `zephyr-ai ${response.status}`);
        return data;
    }

    async submitCapture(user, runId, body) {
        const lease = this._assertCurrentRun(user, runId);
        return this._fetchUnchecked(`/admin/runs/${encodeURIComponent(runId)}/capture`, {
            method: 'POST',
            body: { ...body, databaseGeneration: lease.generation, runNonce: lease.runNonce },
        });
    }

    beginHostCall({ userId, runId, databaseGeneration, runNonce, abortController } = {}) {
        this._assertOperational();
        const generation = String(databaseGeneration || '').trim();
        const nonce = String(runNonce || '').trim();
        const id = String(runId || '').trim();
        const actor = String(userId || '').trim();
        const lease = this.runLeasesByNonce.get(nonce);
        if (!lease || !generation || generation !== this.databaseGeneration || lease.generation !== generation) {
            throw this._expiredRunError();
        }
        if (!actor || lease.userId !== actor) {
            throw new HttpError(403, 'ai_run_forbidden', 'AI run does not belong to this account');
        }
        if (!id || (lease.runId && lease.runId !== id)) throw this._expiredRunError();
        const conflictingLease = this.runLeasesById.get(id);
        if (conflictingLease && conflictingLease !== lease) throw this._expiredRunError();
        lease.runId = id;
        this.runLeasesById.set(id, lease);
        this.inFlightHostCalls += 1;
        if (abortController && typeof abortController.abort === 'function') {
            this.hostCallAborts.add(abortController);
        }
        const token = Object.freeze({});
        const record = { token, lease, generation, abortController, released: false };
        this.hostCallLeases.set(token, record);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            record.released = true;
            this.hostCallAborts.delete(abortController);
            this.hostCallLeases.delete(token);
            this.inFlightHostCalls = Math.max(0, this.inFlightHostCalls - 1);
            if (this.inFlightHostCalls === 0) {
                for (const resolve of [...this.hostDrainWaiters]) resolve();
                this.hostDrainWaiters.clear();
            }
        };
        Object.defineProperty(release, 'assertLive', {
            value: () => this._assertHostCallLive(token),
            enumerable: false,
            writable: false,
            configurable: false,
        });
        return release;
    }

    _assertHostCallLive(token) {
        const record = this.hostCallLeases.get(token);
        if (!record
            || record.released
            || this.maintenance
            || record.abortController?.signal?.aborted
            || record.generation !== this.databaseGeneration
            || this.runLeasesByNonce.get(record.lease.runNonce) !== record.lease) {
            throw this._expiredRunError();
        }
    }

    _waitForHostDrain(context) {
        if (this.inFlightHostCalls === 0) return Promise.resolve();
        const waitForDrain = new Promise((resolve) => {
            const onDrain = () => {
                this.hostDrainWaiters.delete(onDrain);
                resolve();
            };
            this.hostDrainWaiters.add(onDrain);
        });
        return this._awaitAbortable(
            waitForDrain,
            context?.controller?.signal,
            context?.deadline,
        );
    }

    _createMaintenanceContext() {
        const controller = new AbortController();
        const timeoutError = this._maintenanceTimeoutError();
        const context = {
            controller,
            deadline: Date.now() + this.maintenanceTimeoutMs,
            timeoutError,
            timer: null,
        };
        context.timer = setTimeout(() => {
            controller.abort(timeoutError);
        }, this.maintenanceTimeoutMs);
        return context;
    }

    _disposeMaintenanceContext(context) {
        if (!context) return;
        if (context.timer) clearTimeout(context.timer);
        context.timer = null;
        if (this.maintenanceContext === context) this.maintenanceContext = null;
    }

    _clearRetiredGeneration(retiredGeneration) {
        for (const lease of [...this.runLeasesByNonce.values()]) {
            if (lease.generation !== retiredGeneration) continue;
            this.runLeasesByNonce.delete(lease.runNonce);
            if (lease.runId) this.runLeasesById.delete(lease.runId);
        }
    }

    async _settleBeforeMaintenanceDeadline(promises, context) {
        return this._awaitAbortable(
            Promise.allSettled(promises),
            context.controller.signal,
            context.deadline,
        );
    }

    beginMaintenance() {
        if (this.maintenance) return this.maintenanceDrain || Promise.resolve();
        this.maintenance = true;
        const context = this._createMaintenanceContext();
        this.maintenanceContext = context;
        const retiredGeneration = this.databaseGeneration;
        this.databaseGeneration = this._newDatabaseGeneration();
        const runs = [...this.runLeasesById.values()]
            .filter((lease) => lease.generation === retiredGeneration && lease.runId);
        const pendingStarts = [...this.pendingStarts];
        const monitors = [...this.historyMonitors.values()];
        for (const controller of this.historyMonitorAborts.values()) controller.abort();
        for (const controller of this.hostCallAborts) controller.abort();
        for (const entry of pendingStarts) entry.abortController.abort(this._expiredRunError());

        this.maintenanceDrain = (async () => {
            try {
                const abortResults = await this._settleBeforeMaintenanceDeadline(
                    runs.map((lease) => this._fetchUnchecked(
                        `/admin/runs/${encodeURIComponent(lease.runId)}/abort`,
                        { method: 'POST', body: {}, ...this._maintenanceFetchOptions(context) },
                    )),
                    context,
                );
                await this._settleBeforeMaintenanceDeadline(pendingStarts.map((entry) => entry.operation), context);
                await this._settleBeforeMaintenanceDeadline(monitors, context);
                await this._waitForHostDrain(context);
                const failures = abortResults
                    .filter((result) => result.status === 'rejected')
                    .map((result) => result.reason);
                if (failures.length) throw new AggregateError(failures, 'failed to abort AI runs for database maintenance');
            } finally {
                this._clearRetiredGeneration(retiredGeneration);
                this._disposeMaintenanceContext(context);
            }
        })();
        return this.maintenanceDrain;
    }

    endMaintenance() {
        this._disposeMaintenanceContext(this.maintenanceContext);
        this.maintenance = false;
        this.maintenanceDrain = null;
    }

    /**
     * Build systemCompose from current AI settings + context.
     * HARD RULE: keep full skills text + memories + env + timestamp — no token-saving thinning.
     */
    buildSystemCompose(ai = {}, contextText = '', selectedMemories = [], locale = 'zh-CN') {
        const skills = mergeSkills(ai.skills).filter((s) => s && s.enabled !== false);
        const envVars = Array.isArray(ai.envVars)
            ? ai.envVars.filter((e) => e?.enabled !== false && e.name && e.visibleToAi === true).map((e) => ({
                name: e.name,
                description: e.description || '',
                value: e.valueVisibleToAi ? String(e.value || '') : '',
                valueVisibleToAi: !!e.valueVisibleToAi,
            }))
            : [];
        return {
            assistantName: ai.assistantName || 'Zephyr AI 助理',
            defaultSystemPrompt: String(ai.defaultSystemPrompt || DEFAULT_ZEPHYR_SYSTEM_PROMPT || ''),
            customSystemPrompt: String(ai.systemPrompt || ''),
            contextText: String(contextText || ''),
            locale: String(locale || 'zh-CN'),
            skills: skills.map((s) => ({
                id: s.id,
                name: s.name || '',
                description: s.description || '',
                prompt: s.prompt || '',
                enabled: s.enabled !== false,
            })),
            memories: (selectedMemories || []).map((m) => ({
                title: m.title || m.key || 'Memory',
                content: m.content || '',
                scope: m.scope || '',
                project: m.project || '',
                tags: m.tags || [],
            })),
            envVars,
        };
    }
}

function mergeSkills(skills) {
    const source = Array.isArray(skills) ? skills : cloneDefaultZephyrSkills();
    const builtinIds = new Set([
        ...DEFAULT_ZEPHYR_SKILLS.map((item) => String(item.id || '')),
        ...PLAYBOOKS.map((item) => `playbook:${item.id}`),
        'zephyr-unified-operator',
    ]);
    const customSkills = source.filter((item) => item?.id && !builtinIds.has(String(item.id)));
    return [buildUnifiedZephyrSkill(PLAYBOOKS), ...customSkills];
}

/**
 * Register internal platform host routes on Express.
 * Go calls these with x-ai-host-admin.
 */
function registerAiHostRoutes(app, deps) {
    const checkHost = (req, res, next) => {
        const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
        if (!['127.0.0.1', '::1'].includes(remote)) {
            return res.status(403).json({ ok: false, error: 'loopback_only' });
        }
        const tok = req.headers['x-ai-host-admin'] || '';
        if (HOST_TOKEN && tok !== HOST_TOKEN) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
        next();
    };

    app.get('/internal/ai-host/v1/tools', checkHost, (req, res) => {
        let releaseHostCall = null;
        try {
            releaseHostCall = deps.runtimeBridge?.beginHostCall({
                userId: req.query?.userId,
                runId: req.query?.runId,
                databaseGeneration: req.query?.databaseGeneration,
                runNonce: req.query?.runNonce,
            }) || null;
            let context = {};
            try { context = req.query?.context ? JSON.parse(String(req.query.context)) : {}; } catch (_) {}
            const tools = listPlatformToolCatalog(deps, context);
            res.json({ ok: true, v: 1, tools });
        } catch (err) {
            const status = err?.status || 500;
            res.status(status).json({ ok: false, error: err.message, code: err.code || 'tool_catalog_error' });
        } finally {
            releaseHostCall?.();
        }
    });

    app.post('/internal/ai-host/v1/call', checkHost, async (req, res) => {
        let releaseHostCall = null;
        const abortController = new AbortController();
        const abortHostCall = () => abortController.abort();
        req.once('aborted', abortHostCall);
        try {
            const {
                tool: toolName,
                args,
                userId,
                sessionId,
                runId,
                databaseGeneration,
                runNonce,
                context,
                confirmed,
            } = req.body || {};
            if (!toolName) return res.status(400).json({ ok: false, error: 'tool required' });
            releaseHostCall = deps.runtimeBridge?.beginHostCall({
                userId,
                runId,
                databaseGeneration,
                runNonce,
                abortController,
            }) || null;
            // Build a synthetic user for ACL — control plane already authenticated the browser.
            const user = userId ? { userId, role: 'user' } : null;
            if (!user) return res.status(400).json({ ok: false, error: 'userId required' });
            // Prefer full user from storage when available
            const full = deps.storage?.getUserById?.(userId) || deps.storage?.getUser?.(userId);
            const actor = full
                ? { userId: full.userId || full.id, role: full.role || (full.isSuperAdmin ? 'admin' : 'user'), ...full }
                : user;

            if (String(toolName || '').startsWith('note_') && deps.userSettingsService) {
                try {
                    const effective = deps.userSettingsService.effective(actor);
                    if (!effective?.notes?.enabled) {
                        return res.status(403).json({ ok: false, error: '当前用户未启用笔记功能', code: 'notes_disabled' });
                    }
                } catch (_) {}
            }
            const result = await executePlatformTool(toolName, args || {}, {
                user: actor,
                context: context || {},
                confirmedToolId: confirmed ? String(toolName) : '',
                sessionId,
                runId,
                signal: abortController.signal,
                hostCallGuard: releaseHostCall?.assertLive,
                deps,
            });
            res.json({ ok: true, result });
        } catch (err) {
            const status = err?.status || 400;
            res.status(status).json({ ok: false, error: err.message || String(err), code: err.code || 'tool_error' });
        } finally {
            req.off('aborted', abortHostCall);
            releaseHostCall?.();
        }
    });
}

/**
 * Tool catalog: names/schemas must stay aligned with legacy toolDefinitions().
 * Implementation executes via ai-agent-service executeAiTool until fully ported.
 */
function listPlatformToolCatalog(deps, context = {}) {
    // Lazy require to avoid circular init
    const agent = require('./ai-agent-service');
    // Prefer exported catalog if present; else static minimal set
    let tools = typeof agent.listToolCatalog === 'function'
        ? agent.listToolCatalog(deps.storage?.getSettings?.().ai || {})
        : STATIC_PLATFORM_CATALOG;
    if (context?.activeSurface?.kind === 'remote-desktop') {
        tools = tools.filter((tool) => !String(tool?.name || '').startsWith('browser_'));
    }
    // Runtime catalog must honor per-user notes.enabled, same as Legacy Chat.
    const userId = String(context?.userId || context?.actorUserId || '').trim();
    if (userId && deps.userSettingsService && typeof deps.userSettingsService.effective === 'function') {
        try {
            const user = deps.storage?.getUserById?.(userId) || { userId };
            const effective = deps.userSettingsService.effective(user);
            if (!effective?.notes?.enabled) {
                tools = tools.filter((tool) => !String(tool?.name || '').startsWith('note_'));
            }
        } catch (_) {}
    }
    return tools;
}

async function executePlatformTool(toolName, args, ctx) {
    const agent = require('./ai-agent-service');
    if (typeof agent.executeAiToolForHost !== 'function') {
        // Fallback path using internal export once wired
        throw new Error(`platform tool host not wired for ${toolName}; restart after ai-agent-service host exports`);
    }
    return agent.executeAiToolForHost(toolName, args, ctx);
}

// Fail closed if the dynamic catalog is unavailable. A stale fallback catalog
// previously re-exposed credential-bearing legacy tools during partial startup.
const STATIC_PLATFORM_CATALOG = Object.freeze([]);

// No static Tool definitions by design.

module.exports = {
    AiRuntimeBridge,
    createRuntimeSseParser,
    registerAiHostRoutes,
    listPlatformToolCatalog,
    STATIC_PLATFORM_CATALOG,
    AI_URL,
    AI_ADMIN,
};
