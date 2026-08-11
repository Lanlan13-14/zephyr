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
const SENSITIVE_CONFIG_KEYS = new Set([
    'apikey', 'authorization', 'authheader', 'bearer', 'cookie', 'cookies',
    'credentials', 'endpointcredentials', 'extraheaders', 'extrajson', 'headers',
    'password', 'passphrase', 'refreshtoken', 'accesstoken', 'session', 'sessionid',
]);

function json(value, fallback = []) {
    try { const out = JSON.parse(value || ''); return out == null ? fallback : out; } catch { return fallback; }
}
function cleanIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].slice(0, 200);
}

function configKeyIsSensitive(key) {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_CONFIG_KEYS.has(normalized)
        || normalized.endsWith('secret')
        || normalized.endsWith('password')
        || normalized.endsWith('credential')
        || normalized.endsWith('token');
}

function splitSensitiveConfig(value) {
    if (!value || typeof value !== 'object') {
        return { publicValue: value, secretValue: undefined };
    }
    if (Array.isArray(value)) {
        const publicValue = [];
        const secretValue = [];
        let hasSecret = false;
        for (const child of value) {
            const split = splitSensitiveConfig(child);
            publicValue.push(split.publicValue);
            secretValue.push(split.secretValue === undefined ? null : split.secretValue);
            hasSecret ||= split.secretValue !== undefined;
        }
        return { publicValue, secretValue: hasSecret ? secretValue : undefined };
    }
    const publicValue = {};
    const secretValue = {};
    for (const [key, child] of Object.entries(value)) {
        if (configKeyIsSensitive(key)) {
            secretValue[key] = child;
            continue;
        }
        const split = splitSensitiveConfig(child);
        if (split.publicValue !== undefined) publicValue[key] = split.publicValue;
        if (split.secretValue !== undefined
            && (typeof split.secretValue !== 'object' || Object.keys(split.secretValue).length)) {
            secretValue[key] = split.secretValue;
        }
    }
    return {
        publicValue,
        secretValue: Object.keys(secretValue).length ? secretValue : undefined,
    };
}

function mergeConfig(publicValue, secretValue) {
    if (secretValue === undefined) return publicValue;
    if (secretValue === null) return publicValue;
    if (typeof secretValue !== 'object') return secretValue;
    if (Array.isArray(secretValue)) {
        const publicArray = Array.isArray(publicValue) ? publicValue : [];
        return secretValue.map((value, index) => (
            value == null ? publicArray[index] : mergeConfig(publicArray[index], value)
        ));
    }
    const output = { ...(publicValue && typeof publicValue === 'object' && !Array.isArray(publicValue) ? publicValue : {}) };
    for (const [key, value] of Object.entries(secretValue)) {
        const current = output[key];
        output[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeConfig(current, value)
            : value;
    }
    return output;
}

function splitEndpoint(value) {
    const endpoint = String(value || '');
    if (!endpoint) return { publicValue: '', secretValue: undefined };
    try {
        const parsed = new URL(endpoint);
        if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
            return { publicValue: endpoint, secretValue: undefined };
        }
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return { publicValue: parsed.toString(), secretValue: endpoint };
    } catch {
        return { publicValue: endpoint, secretValue: undefined };
    }
}

function providerVisionDefault(input = {}) {
    const opts = input.options || input.config?.options || {};
    return opts.vision !== false;
}

function parseModelsInput(models, input = {}) {
    return normalizeModels(models, { providerVisionDefault: providerVisionDefault(input) });
}

class AiProviderService {
    constructor(db, {
        storage,
        now = () => Date.now(),
        mobileChangeBridge = null,
        secretCrypto: secretCryptoProvider = secretCrypto,
    } = {}) {
        this.db = db;
        this.storage = storage;
        this.now = now;
        this.mobileChangeBridge = mobileChangeBridge;
        this.secretCrypto = secretCryptoProvider;
        this._schema();
        this._migrateSensitiveStorage();
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
                secret_config_enc TEXT,
                default_model TEXT,
                models_json TEXT NOT NULL DEFAULT '[]',
                config_json TEXT NOT NULL DEFAULT '{}',
                visibility TEXT NOT NULL DEFAULT 'private',
                share_with_users INTEGER NOT NULL DEFAULT 0,
                share_with_admins INTEGER NOT NULL DEFAULT 0,
                shared_user_ids_json TEXT NOT NULL DEFAULT '[]',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                deleted_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_ai_providers_owner ON ai_providers(owner_user_id, updated_at DESC);
        `);
        const columns = new Set(this.db.prepare('PRAGMA table_info(ai_providers)').all().map((row) => row.name));
        if (!columns.has('revision')) {
            this.db.exec('ALTER TABLE ai_providers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        }
        if (!columns.has('deleted_at')) {
            this.db.exec('ALTER TABLE ai_providers ADD COLUMN deleted_at INTEGER');
        }
        if (!columns.has('secret_config_enc')) {
            this.db.exec('ALTER TABLE ai_providers ADD COLUMN secret_config_enc TEXT');
        }
        this.db.exec(`
            UPDATE ai_providers SET revision=1 WHERE revision IS NULL OR revision < 1;
            CREATE INDEX IF NOT EXISTS idx_ai_providers_owner_live
                ON ai_providers(owner_user_id, deleted_at, updated_at DESC);
        `);
    }

    get mobileSyncCapabilities() {
        return Object.freeze({
            stableIds: true,
            revisions: true,
            tombstones: true,
            ownerIsolation: true,
            atomicChangeFeed: !!this.mobileChangeBridge,
            canonicalStorage: true,
            safeProjection: true,
        });
    }

    _runMutation(meta, write) {
        if (!this.mobileChangeBridge) return write();
        return this.mobileChangeBridge.runMutation(meta, write);
    }

    _encryptProviderSecrets(id, value) {
        if (!value || typeof value !== 'object' || !Object.keys(value).length) return null;
        return this.secretCrypto.encryptSecret(JSON.stringify(value), `ai-provider:${id}:config`);
    }

    _decryptProviderSecrets(row) {
        if (!row?.secret_config_enc) return {};
        return json(this.secretCrypto.decryptSecret(
            row.secret_config_enc,
            `ai-provider:${row.provider_id}:config`,
        ), {});
    }

    _storageValues(id, baseUrl, config, models = [], previousSecrets = {}) {
        const splitConfig = splitSensitiveConfig(config || {});
        const splitUrl = splitEndpoint(baseUrl);
        const publicModels = [];
        const secretModels = {};
        for (const model of Array.isArray(models) ? models : []) {
            const split = splitSensitiveConfig(model);
            publicModels.push(split.publicValue);
            if (split.secretValue && model?.id) secretModels[String(model.id)] = split.secretValue;
        }
        const nextSecrets = { ...previousSecrets };
        if (splitConfig.secretValue !== undefined) {
            nextSecrets.config = mergeConfig(nextSecrets.config, splitConfig.secretValue);
        }
        if (splitUrl.secretValue !== undefined) nextSecrets.baseUrl = splitUrl.secretValue;
        else delete nextSecrets.baseUrl;
        if (!splitConfig.secretValue) delete nextSecrets.config;
        if (Object.keys(secretModels).length) nextSecrets.models = secretModels;
        else delete nextSecrets.models;
        return {
            baseUrl: splitUrl.publicValue,
            configJson: JSON.stringify(splitConfig.publicValue || {}),
            modelsJson: JSON.stringify(publicModels),
            secretsEnc: this._encryptProviderSecrets(id, nextSecrets),
        };
    }

    _migrateSensitiveStorage() {
        const rows = this.db.prepare(`SELECT provider_id, base_url, config_json, models_json, secret_config_enc
            FROM ai_providers`).all();
        const update = this.db.prepare(`UPDATE ai_providers
            SET base_url=?, config_json=?, models_json=?, secret_config_enc=? WHERE provider_id=?`);
        this.db.transaction(() => {
            for (const row of rows) {
                const plainConfig = json(row.config_json, {});
                const plainModels = json(row.models_json, []);
                const hasPlainSecrets = splitSensitiveConfig(plainConfig).secretValue !== undefined
                    || splitEndpoint(row.base_url).secretValue !== undefined
                    || plainModels.some((model) => splitSensitiveConfig(model).secretValue !== undefined);
                if (row.secret_config_enc && !hasPlainSecrets) continue;
                const previousSecrets = this._decryptProviderSecrets(row);
                const publicModels = plainModels.map((model) => (
                    mergeConfig(model, previousSecrets.models?.[String(model?.id || '')])
                ));
                const stored = this._storageValues(
                    row.provider_id,
                    previousSecrets.baseUrl || row.base_url || '',
                    mergeConfig(plainConfig, previousSecrets.config),
                    publicModels,
                    previousSecrets,
                );
                update.run(stored.baseUrl, stored.configJson, stored.modelsJson, stored.secretsEnc, row.provider_id);
            }
        })();
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
        return this.secretCrypto.encryptSecret(String(value), `ai-provider:${id}:apiKey`);
    }
    _decryptKey(row) {
        if (!row?.api_key_enc) return '';
        return this.secretCrypto.decryptSecret(row.api_key_enc, `ai-provider:${row.provider_id}:apiKey`);
    }
    _visibility(input) {
        const users = !!input.shareWithUsers;
        const admins = !!input.shareWithAdmins;
        const selected = cleanIds(input.sharedUserIds);
        if (selected.length && !users && !admins) return 'selected';
        return users ? (admins ? 'shared_all' : 'shared_users') : (admins ? 'shared_admins' : 'private');
    }

    _insert(ownerUserId, input, mutationContext = {}) {
        const id = String(input.id || crypto.randomUUID());
        const now = this.now();
        const type = TYPES.has(String(input.type || '').toLowerCase()) ? String(input.type).toLowerCase() : 'openai-compatible';
        const shared = cleanIds(input.sharedUserIds);
        const config = { ...(input.config || {}), apiMode: input.apiMode || input.config?.apiMode || 'auto', options: input.options || input.config?.options || {}, organization: input.organization || '', extraHeaders: input.extraHeaders || '', modelUserAgents: input.modelUserAgents || '' };
        const models = parseModelsInput(input.models, { options: config.options, config });
        const stored = this._storageValues(id, input.baseUrl, config, models);
        const user = { userId: String(ownerUserId) };
        return this._runMutation({
            entityType: 'aiProvider', entityId: id, action: 'upsert', user, before: null,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
            changedSecretFields: mutationContext.changedSecretFields,
        }, () => {
            this.db.prepare(`INSERT INTO ai_providers
                (provider_id,owner_user_id,name,type,base_url,api_key_enc,secret_config_enc,default_model,models_json,config_json,visibility,share_with_users,share_with_admins,shared_user_ids_json,enabled,created_at,updated_at,revision,deleted_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`).run(
                id, ownerUserId, String(input.name || 'AI Provider').slice(0, 100), type,
                stored.baseUrl, this._encryptKey(id, input.apiKey), stored.secretsEnc, String(input.defaultModel || ''),
                stored.modelsJson,
                stored.configJson,
                this._visibility(input), input.shareWithUsers ? 1 : 0, input.shareWithAdmins ? 1 : 0,
                JSON.stringify(shared), input.enabled === false ? 0 : 1, now, now
            );
            return this.getOwned(ownerUserId, id);
        });
    }

    _row(row, { includeSecret = false } = {}) {
        if (!row) return null;
        const providerSecrets = this._decryptProviderSecrets(row);
        const config = mergeConfig(json(row.config_json, {}), providerSecrets.config);
        const storedModels = json(row.models_json, []).map((model) => (
            mergeConfig(model, providerSecrets.models?.[String(model?.id || '')])
        ));
        const visionDefault = config?.options?.vision !== false;
        const out = {
            id: row.provider_id,
            ownerUserId: row.owner_user_id,
            name: row.name,
            type: row.type,
            baseUrl: providerSecrets.baseUrl || row.base_url || '',
            defaultModel: row.default_model || '',
            models: normalizeModels(storedModels, { providerVisionDefault: visionDefault }),
            config,
            visibility: row.visibility || 'private',
            shareWithUsers: !!row.share_with_users,
            shareWithAdmins: !!row.share_with_admins,
            sharedUserIds: json(row.shared_user_ids_json, []),
            enabled: !!row.enabled,
            hasApiKey: !!row.api_key_enc,
            revision: Math.max(1, Number(row.revision) || 1),
            createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        };
        if (row.deleted_at != null) out.deletedAt = Number(row.deleted_at);
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
        return this.db.prepare('SELECT * FROM ai_providers WHERE enabled=1 AND deleted_at IS NULL ORDER BY updated_at DESC').all()
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
    listOwned(userId, { includeDeleted = false } = {}) {
        const sql = includeDeleted
            ? 'SELECT * FROM ai_providers WHERE owner_user_id=? ORDER BY updated_at DESC'
            : 'SELECT * FROM ai_providers WHERE owner_user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC';
        return this.db.prepare(sql).all(String(userId)).map((r) => this._row(r));
    }
    getOwned(userId, id, opts = {}) {
        const sql = opts.includeDeleted
            ? 'SELECT * FROM ai_providers WHERE provider_id=? AND owner_user_id=?'
            : 'SELECT * FROM ai_providers WHERE provider_id=? AND owner_user_id=? AND deleted_at IS NULL';
        const row = this.db.prepare(sql).get(String(id), String(userId));
        if (!row) throw new HttpError(404, 'provider_not_found', 'AI Provider 不存在');
        return this._row(row, opts);
    }
    readOwned(userId, id, opts = {}) {
        try { return this.getOwned(userId, id, opts); }
        catch (error) {
            if (error?.code === 'provider_not_found') return null;
            throw error;
        }
    }
    residency(userId, id) {
        const row = this.db.prepare('SELECT owner_user_id FROM ai_providers WHERE provider_id=?').get(String(id));
        if (!row) return 'missing';
        return String(row.owner_user_id) === String(userId) ? 'owned' : 'foreign';
    }
    deleteUserState(userId) {
        return Number(this.db.prepare('DELETE FROM ai_providers WHERE owner_user_id=?')
            .run(String(userId)).changes || 0);
    }
    resolveForUse(user, id, model) {
        const row = id
            ? this.db.prepare('SELECT * FROM ai_providers WHERE provider_id=? AND deleted_at IS NULL').get(String(id))
            : this.db.prepare('SELECT * FROM ai_providers WHERE enabled=1 AND deleted_at IS NULL ORDER BY updated_at DESC').all().find((r) => this._canUse(user, r));
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

    create(user, input, mutationContext = {}) {
        return this._insert(user.userId, input || {}, mutationContext);
    }
    update(user, id, patch = {}, {
        expectedRevision,
        actorDeviceId,
        mutationReceipt,
        changedSecretFields,
    } = {}) {
        const current = this.getOwned(user.userId, id, { includeSecret: true });
        if (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) {
            throw new HttpError(409, 'revision_conflict', 'AI Provider revision conflict');
        }
        const before = { ...current };
        delete before.apiKey;
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
        const stored = this._storageValues(current.id, next.baseUrl, next.config, next.models);
        return this._runMutation({
            entityType: 'aiProvider', entityId: current.id, action: 'upsert', user, before,
            actorDeviceId,
            mutationReceipt,
            changedSecretFields,
        }, () => {
            const result = this.db.prepare(`UPDATE ai_providers SET name=?,type=?,base_url=?,api_key_enc=?,secret_config_enc=?,default_model=?,models_json=?,config_json=?,visibility=?,share_with_users=?,share_with_admins=?,shared_user_ids_json=?,enabled=?,updated_at=?,revision=revision+1 WHERE provider_id=? AND owner_user_id=? AND deleted_at IS NULL AND revision=?`).run(
                String(next.name || 'AI Provider').slice(0, 100), TYPES.has(next.type) ? next.type : 'openai-compatible',
                stored.baseUrl, this._encryptKey(current.id, key), stored.secretsEnc, String(next.defaultModel || ''),
                stored.modelsJson, stored.configJson, visibility,
                next.shareWithUsers ? 1 : 0, next.shareWithAdmins ? 1 : 0, JSON.stringify(cleanIds(next.sharedUserIds)),
                next.enabled === false ? 0 : 1, this.now(), current.id, user.userId, current.revision
            );
            if (!result.changes) throw new HttpError(409, 'revision_conflict', 'AI Provider revision conflict');
            return this.getOwned(user.userId, current.id);
        });
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
    remove(user, id, { expectedRevision, actorDeviceId, mutationReceipt } = {}) {
        const before = this.getOwned(user.userId, id);
        if (expectedRevision !== undefined && Number(expectedRevision) !== before.revision) {
            throw new HttpError(409, 'revision_conflict', 'AI Provider revision conflict');
        }
        return this._runMutation({
            entityType: 'aiProvider', entityId: before.id, action: 'delete', user, before,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const timestamp = this.now();
            const result = this.db.prepare(`UPDATE ai_providers
                SET deleted_at=?, updated_at=?, revision=revision+1
                WHERE provider_id=? AND owner_user_id=? AND deleted_at IS NULL AND revision=?`).run(
                timestamp, timestamp, String(id), user.userId, before.revision,
            );
            if (!result.changes) throw new HttpError(409, 'revision_conflict', 'AI Provider revision conflict');
            return true;
        });
    }
    restore(user, id, { expectedRevision, actorDeviceId, mutationReceipt } = {}) {
        const before = this.getOwned(user.userId, id, { includeDeleted: true });
        if (before.deletedAt == null) throw new HttpError(409, 'provider_not_deleted', 'AI Provider is not deleted');
        if (expectedRevision !== undefined && Number(expectedRevision) !== before.revision) {
            throw new HttpError(409, 'revision_conflict', 'AI Provider revision conflict');
        }
        return this._runMutation({
            entityType: 'aiProvider', entityId: before.id, action: 'upsert', user, before,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const result = this.db.prepare(`UPDATE ai_providers
                SET deleted_at=NULL, updated_at=?, revision=revision+1
                WHERE provider_id=? AND owner_user_id=? AND deleted_at IS NOT NULL AND revision=?`).run(
                this.now(), String(id), user.userId, before.revision,
            );
            if (!result.changes) throw new HttpError(409, 'revision_conflict', 'AI Provider revision conflict');
            return this.getOwned(user.userId, id);
        });
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
