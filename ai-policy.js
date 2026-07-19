'use strict';
/*
 * ai-policy.js - multi-user AI policy engine (FREEZE plan §16, §19.5).
 *
 * Modes (§16.1):
 *   disabled      - AI entirely off for this user
 *   admin_shared  - user may call admin-configured providers; no own keys
 *   self_managed  - user brings own provider keys (stored per-user)
 *   both          - admin providers + user's own
 *
 * Per-user overrides live in user_settings under the `ai.policy` key
 * (admin-writable only). Provider ownership is enforced here.
 */
const { HttpError } = require('./authz');

const POLICY_MODES = ['disabled', 'admin_shared', 'self_managed', 'both'];
const DEFAULT_MODE = 'admin_shared';

function normalizeMode(mode) {
    return POLICY_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

class AiPolicyService {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {object} deps
     * @param {object} deps.storage  for global settings (admin providers)
     * @param {import('./user-settings-service').UserSettingsService} deps.userSettings
     */
    constructor(db, deps) {
        this.db = db;
        this.storage = deps.storage;
        this.userSettings = deps.userSettings;
        this.stmtGetPolicy = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?');
        this.stmtPutPolicy = db.prepare('INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
        this.stmtDelPolicy = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?');
    }

    /** Effective policy for a user (admin-set override > system default). */
    policyFor(user) {
        const global = this.storage.getSettings().ai || {};
        if (!global.enabled) return { mode: 'disabled', reason: 'system_disabled' };
        const row = this.stmtGetPolicy.get(String(user.userId), 'ai.policy.mode');
        const mode = normalizeMode(row ? JSON.parse(row.value) : (global.defaultPolicyMode || DEFAULT_MODE));
        return {
            mode,
            canUseAdminProviders: mode === 'admin_shared' || mode === 'both',
            canUseOwnProviders: mode === 'self_managed' || mode === 'both',
            modelWhitelist: global.modelWhitelist || [],
            quota: global.quota || { dailyRequests: 0, hourlyRequests: 0 },
            concurrency: Math.max(1, Math.min(Number(global.concurrency) || 3, 10)),
        };
    }

    /** Admin sets a per-user policy override. */
    setPolicy(adminUser, targetUserId, mode) {
        if (adminUser.role !== 'admin') throw new HttpError(403, 'forbidden_admin_required', '需要管理员权限');
        const normalized = normalizeMode(mode);
        this.stmtPutPolicy.run(String(targetUserId), 'ai.policy.mode', JSON.stringify(normalized), Date.now());
        return normalized;
    }

    clearPolicy(adminUser, targetUserId) {
        if (adminUser.role !== 'admin') throw new HttpError(403, 'forbidden_admin_required', '需要管理员权限');
        this.stmtDelPolicy.run(String(targetUserId), 'ai.policy.mode');
        return true;
    }

    /**
     * Resolve the provider a user may call. Admin providers are shared (key
     * never returned to non-admin). Own providers are stored per-user.
     * Returns { provider, model, source } or throws.
     */
    resolveProvider(user, requestedProviderId, requestedModel) {
        const policy = this.policyFor(user);
        if (policy.mode === 'disabled') throw new HttpError(403, 'ai_disabled', 'AI 助理未启用', false);

        const global = this.storage.getSettings().ai || {};
        const adminProviders = (global.providers || []).filter((p) => p && p.enabled !== false);

        // 1. own providers (self_managed / both)
        if (policy.canUseOwnProviders) {
            const own = this._ownProviders(user.userId);
            const match = requestedProviderId
                ? own.find((p) => p.id === requestedProviderId)
                : own[0];
            if (match) {
                return this._validate({ provider: match, model: requestedModel, source: 'own', policy, user });
            }
        }

        // 2. admin-shared providers
        if (policy.canUseAdminProviders) {
            const match = requestedProviderId
                ? adminProviders.find((p) => p.id === requestedProviderId)
                : adminProviders[0];
            if (match) {
                // Strip API key for non-admin callers; the server-side call uses
                // the real key but it never leaves this function.
                return this._validate({ provider: match, model: requestedModel, source: 'admin_shared', policy, user });
            }
        }

        throw new HttpError(403, 'ai_no_provider', '没有可用的 AI Provider，请联系管理员', false);
    }

    _validate({ provider, model, source, policy, user }) {
        if (policy.modelWhitelist && policy.modelWhitelist.length) {
            const allowed = policy.modelWhitelist;
            if (model && !allowed.includes(model) && !allowed.includes('*')) {
                throw new HttpError(403, 'ai_model_not_allowed', `模型 ${model} 不在白名单中`, false);
            }
        }
        return { provider, model: model || provider.defaultModel || '', source };
    }

    /** Per-user provider storage (self_managed / both). */
    _ownProviders(userId) {
        const row = this.stmtGetPolicy.get(String(userId), 'ai.ownProviders');
        if (!row) return [];
        try {
            const list = JSON.parse(row.value);
            return Array.isArray(list) ? list.filter((p) => p && p.id) : [];
        } catch { return []; }
    }

    setOwnProviders(user, providers) {
        const policy = this.policyFor(user);
        if (!policy.canUseOwnProviders) throw new HttpError(403, 'ai_own_providers_disabled', '当前策略不允许自有 Provider');
        if (!Array.isArray(providers)) throw new HttpError(400, 'invalid_providers', 'Provider 列表格式错误');
        const cleaned = providers.slice(0, 20).map((p) => ({
            id: String(p.id || crypto.randomUUID()).slice(0, 80),
            name: String(p.name || '').slice(0, 80),
            type: String(p.type || 'openai').slice(0, 30),
            baseUrl: String(p.baseUrl || '').slice(0, 300),
            apiKey: String(p.apiKey || '').slice(0, 500),
            defaultModel: String(p.defaultModel || '').slice(0, 120),
            enabled: p.enabled !== false,
        }));
        this.stmtPutPolicy.run(String(user.userId), 'ai.ownProviders', JSON.stringify(cleaned), Date.now());
        // Never echo keys back
        return cleaned.map((p) => ({ ...p, apiKey: p.apiKey ? '******' : '', hasApiKey: !!p.apiKey }));
    }

    /** Check if a user may use a given AI tool capability. */
    canUseTool(user, toolName, capabilities) {
        const policy = this.policyFor(user);
        if (policy.mode === 'disabled') return false;
        // Tools that require admin
        const adminOnly = new Set(['list_zephyr_resources', 'connection_create', 'proxy_create', 'sshkey_create', 'jumphost_create']);
        if (adminOnly.has(toolName) && user.role !== 'admin') return false;
        // Resource-touching tools require the matching ACL capability
        if (toolName === 'open_connection') return capabilities?.has('use') || capabilities?.has('control');
        if (toolName === 'remote_execute') return capabilities?.has('execute');
        if (toolName === 'file_read' || toolName === 'file_write') {
            return capabilities?.has(toolName === 'file_read' ? 'fileRead' : 'fileWrite');
        }
        return true;
    }

    /** Sanitize provider for API response (strip keys for non-admin). */
    sanitizeProviderForUser(provider, user) {
        if (!provider) return null;
        if (user.role === 'admin') return provider;
        return {
            ...provider,
            apiKey: '',
            hasApiKey: !!provider.apiKey,
        };
    }
}

module.exports = { AiPolicyService, POLICY_MODES, DEFAULT_MODE, normalizeMode };
