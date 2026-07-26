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
const { HttpError } = require('./authz');
const {
    DEFAULT_ZEPHYR_SYSTEM_PROMPT,
    DEFAULT_ZEPHYR_SKILLS,
    cloneDefaultZephyrSkills,
} = require('./ai-defaults');
const { PLAYBOOKS } = require('./ai-playbooks');
const { inferModelWindowTokens } = require('./ai-context-budget');

const AI_URL = process.env.ZEPHYR_AI_URL || '';
const AI_ADMIN = process.env.ZEPHYR_AI_ADMIN_TOKEN || '';
const HOST_TOKEN = process.env.ZEPHYR_AI_PLATFORM_HOST_TOKEN || process.env.ZEPHYR_AI_ADMIN_TOKEN || '';

class AiRuntimeBridge {
    constructor(deps = {}) {
        this.deps = deps;
        this.enabled = !!AI_URL;
    }

    _headers() {
        return {
            'content-type': 'application/json',
            'x-ai-admin': AI_ADMIN,
        };
    }

    async _fetch(path, { method = 'GET', body } = {}) {
        if (!this.enabled) throw new HttpError(503, 'ai_runtime_unavailable', 'Go AI 运行时未启用 (ZEPHYR_AI_URL)', true);
        const res = await fetch(`${AI_URL}${path}`, {
            method,
            headers: this._headers(),
            body: body != null ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new HttpError(res.status, data.code || 'ai_runtime_error', data.error || data.message || 'AI runtime error', res.status >= 500);
        }
        return data;
    }

    async createSession(user, { title, metadata } = {}) {
        return this._fetch('/admin/sessions', {
            method: 'POST',
            body: { userId: user.userId, title: title || '新对话', metadata: metadata || {} },
        });
    }

    async listSessions(user) {
        return this._fetch(`/admin/sessions?userId=${encodeURIComponent(user.userId)}`);
    }

    async getSession(user, sessionId) {
        return this._fetch(`/admin/sessions/${encodeURIComponent(sessionId)}?userId=${encodeURIComponent(user.userId)}`);
    }

    async listMessages(user, sessionId) {
        return this._fetch(`/admin/sessions/${encodeURIComponent(sessionId)}/messages?userId=${encodeURIComponent(user.userId)}`);
    }

    /**
     * Start a streaming run. Returns { runId, ticket, ssePath }.
     * systemCompose MUST preserve full skill/memory/env assembly.
     */
    async startRun(user, payload) {
        const body = {
            userId: user.userId,
            sessionId: payload.sessionId,
            provider: payload.provider,
            model: payload.model,
            message: payload.message,
            messages: payload.messages,
            options: payload.options || {},
            maxSteps: payload.maxSteps || 0,
            permission: payload.permission || { mode: 'ask' },
            mode: payload.mode || 'standard',
            systemCompose: payload.systemCompose,
            context: payload.context || null,
            mcpServers: payload.mcpServers || [],
            hourlyLimit: payload.hourlyLimit || 0,
            dailyLimit: payload.dailyLimit || 0,
            contextWindowTokens: payload.contextWindowTokens || inferModelWindowTokens(payload.provider || {}, payload.model || '', 0),
            outputReserveTokens: payload.outputReserveTokens || Number(payload.options?.max_tokens || payload.options?.maxTokens || 0),
        };
        return this._fetch('/admin/runs', { method: 'POST', body });
    }

    async abortRun(runId) {
        return this._fetch(`/admin/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST', body: {} });
    }

    async getRun(runId) {
        return this._fetch(`/admin/runs/${encodeURIComponent(runId)}`);
    }

    async decidePermission(runId, body) {
        return this._fetch(`/admin/runs/${encodeURIComponent(runId)}/permission`, { method: 'POST', body });
    }

    async submitCapture(runId, body) {
        return this._fetch(`/admin/runs/${encodeURIComponent(runId)}/capture`, { method: 'POST', body });
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
    const list = Array.isArray(skills) ? skills.slice() : [];
    const defaults = [
        ...cloneDefaultZephyrSkills(),
        ...PLAYBOOKS.map((playbook) => ({
            id: `playbook:${playbook.id}`,
            name: playbook.title,
            description: `运行时标准操作规程：${playbook.id}`,
            prompt: playbook.prompt,
            enabled: true,
        })),
    ];
    const merged = list.slice();
    defaults.forEach((fallback) => {
        const index = merged.findIndex((item) => item && (item.id === fallback.id || item.name === fallback.name));
        if (index < 0) merged.unshift(fallback);
        else if (!(merged[index].prompt || '').trim()) merged[index] = { ...fallback, ...merged[index], prompt: fallback.prompt, enabled: merged[index].enabled !== false };
    });
    return merged;
}

/**
 * Register internal platform host routes on Express.
 * Go calls these with x-ai-host-admin.
 */
function registerAiHostRoutes(app, deps) {
    const checkHost = (req, res, next) => {
        const tok = req.headers['x-ai-host-admin'] || '';
        if (!HOST_TOKEN || tok !== HOST_TOKEN) {
            // allow loopback without token only if HOST_TOKEN empty (dev)
            if (HOST_TOKEN) {
                return res.status(401).json({ ok: false, error: 'unauthorized' });
            }
        }
        next();
    };

    app.get('/internal/ai-host/v1/tools', checkHost, (req, res) => {
        try {
            const tools = listPlatformToolCatalog(deps);
            res.json({ ok: true, v: 1, tools });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    app.post('/internal/ai-host/v1/call', checkHost, async (req, res) => {
        try {
            const { tool: toolName, args, userId, sessionId, runId, context, confirmed } = req.body || {};
            if (!toolName) return res.status(400).json({ ok: false, error: 'tool required' });
            // Build a synthetic user for ACL — control plane already authenticated the browser.
            const user = userId ? { userId, role: 'user' } : null;
            if (!user) return res.status(400).json({ ok: false, error: 'userId required' });
            // Prefer full user from storage when available
            const full = deps.storage?.getUserById?.(userId) || deps.storage?.getUser?.(userId);
            const actor = full
                ? { userId: full.userId || full.id, role: full.role || (full.isSuperAdmin ? 'admin' : 'user'), ...full }
                : user;

            const result = await executePlatformTool(toolName, args || {}, {
                user: actor,
                context: context || {},
                confirmedToolId: confirmed ? String(toolName) : '',
                sessionId,
                runId,
                deps,
            });
            res.json({ ok: true, result });
        } catch (err) {
            const status = err?.status || 400;
            res.status(status).json({ ok: false, error: err.message || String(err), code: err.code || 'tool_error' });
        }
    });
}

/**
 * Tool catalog: names/schemas must stay aligned with legacy toolDefinitions().
 * Implementation executes via ai-agent-service executeAiTool until fully ported.
 */
function listPlatformToolCatalog(deps) {
    // Lazy require to avoid circular init
    const agent = require('./ai-agent-service');
    // Prefer exported catalog if present; else static minimal set
    if (typeof agent.listToolCatalog === 'function') {
        return agent.listToolCatalog(deps.storage?.getSettings?.().ai || {});
    }
    return STATIC_PLATFORM_CATALOG;
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
    registerAiHostRoutes,
    listPlatformToolCatalog,
    STATIC_PLATFORM_CATALOG,
    AI_URL,
    AI_ADMIN,
};
