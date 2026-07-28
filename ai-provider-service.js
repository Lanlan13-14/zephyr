'use strict';

const crypto = require('crypto');
const secretCrypto = require('./secret-crypto');
const { HttpError } = require('./authz');
const {
    normalizeModels,
    mergeModelList,
    findModelEntry,
    modelAcceptsImage,
    selectableModelIds,
} = require('./ai-model-catalog');

const TYPES = new Set(['openai', 'openai-compatible', 'anthropic', 'gemini', 'ollama']);
const VIS = new Set(['private', 'shared_users', 'shared_admins', 'shared_all', 'selected']);

function json(value, fallback = []) {
    try { const out = JSON.parse(value || ''); return out == null ? fallback : out; } catch { return fallback; }
}
function cleanIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].slice(0, 200);
}

function providerVisionDefault(input = {}) {
    const opts = input.options || input.config?.options || {};
    return opts.vision !== false;
}

function parseModelsInput(models, input = {}) {
    return normalizeModels(models, { providerVisionDefault: providerVisionDefault(input) });
}

class AiProviderService {
    constructor(db, { storage, now = () => Date.now() } = {}) {
        this.db = db;
        this.storage = storage;
        this.now = now;
        this._schema();
        this._migrateLegacy();
    }

    _schema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ai_providers (
                provider_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                base_url TEXT,
                api_key_enc TEXT,
                default_model TEXT,
                models_json TEXT NOT NULL DEFAULT '[]',
                config_json TEXT NOT NULL DEFAULT '{}',
                visibility TEXT NOT NULL DEFAULT 'private',
                share_with_users INTEGER NOT NULL DEFAULT 0,
                share_with_admins INTEGER NOT NULL DEFAULT 0,
                shared_user_ids_json TEXT NOT NULL DEFAULT '[]',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ai_providers_owner ON ai_providers(owner_user_id, updated_at DESC);
        `);
    }

    _migrateLegacy() {
        const done = this.db.prepare("SELECT value FROM meta WHERE key='aiProvidersMigratedAt'").get();
        if (done) return;
        const owner = this.db.prepare("SELECT userId FROM users WHERE isSuperAdmin=1 ORDER BY createdAt LIMIT 1").get()
            || this.db.prepare("SELECT userId FROM users ORDER BY createdAt LIMIT 1").get();
        if (!owner?.userId) return;
        const providers = this.storage?.getSettings?.().ai?.providers || [];
        const tx = this.db.transaction(() => {
            for (const p of providers) {
                const id = String(p.id || crypto.randomUUID());
                if (this.db.prepare('SELECT 1 FROM ai_providers WHERE provider_id=?').get(id)) continue;
                this._insert(owner.userId, { ...p, id, shareWithAdmins: true, shareWithUsers: true });
            }
            this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('aiProvidersMigratedAt',?)").run(String(this.now()));
        });
        tx();
    }

    _encryptKey(id, value) {
        if (!value) return null;
        return secretCrypto.encryptSecret(String(value), `ai-provider:${id}:apiKey`);
    }
    _decryptKey(row) {
        if (!row?.api_key_enc) return '';
        return secretCrypto.decryptSecret(row.api_key_enc, `ai-provider:${row.provider_id}:apiKey`);
    }
    _visibility(input) {
        const users = !!input.shareWithUsers;
        const admins = !!input.shareWithAdmins;
        const selected = cleanIds(input.sharedUserIds);
        if (selected.length && !users && !admins) return 'selected';
        return users ? (admins ? 'shared_all' : 'shared_users') : (admins ? 'shared_admins' : 'private');
    }

    _insert(ownerUserId, input) {
        const id = String(input.id || crypto.randomUUID());
        const now = this.now();
        const type = TYPES.has(String(input.type || '').toLowerCase()) ? String(input.type).toLowerCase() : 'openai-compatible';
        const shared = cleanIds(input.sharedUserIds);
        const config = { ...(input.config || {}), apiMode: input.apiMode || input.config?.apiMode || 'auto', options: input.options || input.config?.options || {}, organization: input.organization || '', extraHeaders: input.extraHeaders || '', modelUserAgents: input.modelUserAgents || '' };
        const models = parseModelsInput(input.models, { options: config.options, config });
        this.db.prepare(`INSERT INTO ai_providers
            (provider_id,owner_user_id,name,type,base_url,api_key_enc,default_model,models_json,config_json,visibility,share_with_users,share_with_admins,shared_user_ids_json,enabled,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            id, ownerUserId, String(input.name || 'AI Provider').slice(0, 100), type,
            String(input.baseUrl || ''), this._encryptKey(id, input.apiKey), String(input.defaultModel || ''),
            JSON.stringify(models),
            JSON.stringify(config),
            this._visibility(input), input.shareWithUsers ? 1 : 0, input.shareWithAdmins ? 1 : 0,
            JSON.stringify(shared), input.enabled === false ? 0 : 1, now, now
        );
        return this.getOwned(ownerUserId, id);
    }

    _row(row, { includeSecret = false } = {}) {
        if (!row) return null;
        const config = json(row.config_json, {});
        const visionDefault = config?.options?.vision !== false;
        const out = {
            id: row.provider_id,
            ownerUserId: row.owner_user_id,
            name: row.name,
            type: row.type,
            baseUrl: row.base_url || '',
            defaultModel: row.default_model || '',
            models: normalizeModels(json(row.models_json, []), { providerVisionDefault: visionDefault }),
            config,
            visibility: row.visibility || 'private',
            shareWithUsers: !!row.share_with_users,
            shareWithAdmins: !!row.share_with_admins,
            sharedUserIds: json(row.shared_user_ids_json, []),
            enabled: !!row.enabled,
            hasApiKey: !!row.api_key_enc,
            createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        };
        if (includeSecret) out.apiKey = this._decryptKey(row);
        return out;
    }

    _canUse(user, row) {
        if (!row || !user || !row.enabled) return false;
        if (row.owner_user_id === user.userId) return true;
        if (row.share_with_users) return true;
        if (row.share_with_admins && user.role === 'admin') return true;
        return json(row.shared_user_ids_json, []).includes(user.userId);
    }

    listVisible(user) {
        return this.db.prepare('SELECT * FROM ai_providers WHERE enabled=1 ORDER BY updated_at DESC').all()
            .filter((r) => this._canUse(user, r))
            .map((r) => {
                const owned = r.owner_user_id === user.userId;
                const owner = this.storage?.getUserBrief?.(r.owner_user_id);
                const out = { ...this._row(r), owner: owned ? 'own' : 'shared', owned, ownerUserId: r.owner_user_id, ownerUsername: owner?.username || '' };
                delete out.apiKey;
                if (!owned) out.sharedUserIds = [];
                return out;
            });
    }
    listOwned(userId) {
        return this.db.prepare('SELECT * FROM ai_providers WHERE owner_user_id=? ORDER BY updated_at DESC').all(userId).map((r) => this._row(r));
    }
    getOwned(userId, id, opts = {}) {
        const row = this.db.prepare('SELECT * FROM ai_providers WHERE provider_id=? AND owner_user_id=?').get(String(id), String(userId));
        if (!row) throw new HttpError(404, 'provider_not_found', 'AI Provider 不存在');
        return this._row(row, opts);
    }
    resolveForUse(user, id, model) {
        const row = id
            ? this.db.prepare('SELECT * FROM ai_providers WHERE provider_id=?').get(String(id))
            : this.db.prepare('SELECT * FROM ai_providers WHERE enabled=1 ORDER BY updated_at DESC').all().find((r) => this._canUse(user, r));
        if (!row || !this._canUse(user, row)) throw new HttpError(404, 'provider_not_found_or_inaccessible', 'AI Provider 不存在或无权访问');
        const provider = this._row(row, { includeSecret: true });
        const allowedModels = selectableModelIds(provider);
        const allIds = provider.models.map((m) => m.id);
        if (model && allIds.length && !allIds.includes(model)) throw new HttpError(403, 'model_not_allowed', '该模型未被 Provider 所有者授权');
        if (model && allIds.includes(model) && !allowedModels.includes(model)) {
            throw new HttpError(403, 'model_hidden', '该模型已对选择器隐藏');
        }
        const resolvedModel = model || (allowedModels.includes(provider.defaultModel) ? provider.defaultModel : '') || allowedModels[0] || '';
        const modelEntry = findModelEntry(provider.models, resolvedModel);
        return { provider, model: resolvedModel, modelEntry };
    }

    create(user, input) { return this._insert(user.userId, input || {}); }
    update(user, id, patch = {}) {
        const current = this.getOwned(user.userId, id, { includeSecret: true });
        const mergedConfig = {
            ...(current.config || {}),
            ...(patch.config || {}),
            ...(patch.apiMode !== undefined ? { apiMode: patch.apiMode } : {}),
            ...(patch.options !== undefined ? { options: patch.options } : {}),
            ...(patch.organization !== undefined ? { organization: patch.organization } : {}),
            ...(patch.extraHeaders !== undefined ? { extraHeaders: patch.extraHeaders } : {}),
            ...(patch.modelUserAgents !== undefined ? { modelUserAgents: patch.modelUserAgents } : {}),
        };
        const parsedModels = patch.models === undefined
            ? normalizeModels(current.models, { providerVisionDefault: mergedConfig?.options?.vision !== false })
            : parseModelsInput(patch.models, { options: mergedConfig.options, config: mergedConfig });
        const next = { ...current, ...patch, id: current.id, models: parsedModels, config: mergedConfig };
        const key = patch.apiKey === undefined || patch.apiKey === '******' ? current.apiKey : String(patch.apiKey || '');
        const visibility = this._visibility(next);
        this.db.prepare(`UPDATE ai_providers SET name=?,type=?,base_url=?,api_key_enc=?,default_model=?,models_json=?,config_json=?,visibility=?,share_with_users=?,share_with_admins=?,shared_user_ids_json=?,enabled=?,updated_at=? WHERE provider_id=? AND owner_user_id=?`).run(
            String(next.name || 'AI Provider').slice(0, 100), TYPES.has(next.type) ? next.type : 'openai-compatible',
            String(next.baseUrl || ''), this._encryptKey(current.id, key), String(next.defaultModel || ''),
            JSON.stringify(Array.isArray(next.models) ? next.models : []), JSON.stringify(next.config || {}), visibility,
            next.shareWithUsers ? 1 : 0, next.shareWithAdmins ? 1 : 0, JSON.stringify(cleanIds(next.sharedUserIds)),
            next.enabled === false ? 0 : 1, this.now(), current.id, user.userId
        );
        return this.getOwned(user.userId, current.id);
    }

    /** Merge a refreshed remote model id list while preserving per-model capabilities. */
    mergeFetchedModels(user, id, remoteModels = []) {
        const current = this.getOwned(user.userId, id);
        const merged = mergeModelList(current.models, remoteModels, {
            providerVisionDefault: current.config?.options?.vision !== false,
        });
        return this.update(user, id, { models: merged });
    }

    modelAcceptsImage(provider, modelId) {
        return modelAcceptsImage(provider, modelId);
    }
    remove(user, id) {
        const result = this.db.prepare('DELETE FROM ai_providers WHERE provider_id=? AND owner_user_id=?').run(String(id), user.userId);
        if (!result.changes) throw new HttpError(404, 'provider_not_found', 'AI Provider 不存在');
        return true;
    }
    share(user, id, data = {}) {
        return this.update(user, id, {
            shareWithUsers: !!data.shareWithUsers,
            shareWithAdmins: !!data.shareWithAdmins,
            sharedUserIds: cleanIds(data.sharedUserIds),
        });
    }
}

module.exports = {
    AiProviderService,
    normalizeModels,
    mergeModelList,
    findModelEntry,
    modelAcceptsImage,
    selectableModelIds,
};
