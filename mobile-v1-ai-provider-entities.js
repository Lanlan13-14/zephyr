'use strict';

const { MobileStoreError } = require('./mobile-v1-store');

const ENTITY_TYPE = 'aiProvider';
const REQUIRED_CAPABILITIES = Object.freeze([
    'stableIds',
    'revisions',
    'tombstones',
    'ownerIsolation',
    'atomicChangeFeed',
    'canonicalStorage',
    'safeProjection',
]);
const SAFE_OPTION_NUMBER_FIELDS = Object.freeze([
    'temperature',
    'top_p',
    'max_tokens',
    'max_output_tokens',
    'presence_penalty',
    'frequency_penalty',
]);
const SAFE_MODEL_BOOLEAN_FIELDS = Object.freeze([
    'hidden',
    'reasoning',
    'reasoningConfigured',
    'tools',
    'parallelToolCalls',
]);
const SAFE_MODEL_NUMBER_FIELDS = Object.freeze([
    'contextWindowTokens',
    'maxOutputTokens',
    'temperature',
    'topP',
    'maxImagesPerRequest',
    'maxImageBytes',
]);

function invalid(code, message, status = 400, details) {
    return new MobileStoreError(code, message, status, details ? { details } : undefined);
}

function registrySpec(registry) {
    return (registry?.entities || []).find((entry) => entry?.type === ENTITY_TYPE) || null;
}

function getAiProviderSyncCapability({ registry, service } = {}) {
    const spec = registrySpec(registry);
    if (!spec) {
        return { enabled: false, code: 'ai_provider_registry_missing', reason: 'aiProvider is absent from the entity registry.' };
    }
    const status = String(spec.status || '').toLowerCase();
    if (status.startsWith('blocked-') || status.startsWith('requires-')) {
        return {
            enabled: false,
            code: 'ai_provider_registry_blocked',
            reason: `The entity registry has not enabled aiProvider sync (${spec.status || 'no status'}).`,
        };
    }
    if (!service) {
        return { enabled: false, code: 'ai_provider_service_unavailable', reason: 'The canonical AI provider service is unavailable.' };
    }
    const missingCapabilities = REQUIRED_CAPABILITIES.filter((name) => service.mobileSyncCapabilities?.[name] !== true);
    if (missingCapabilities.length) {
        return {
            enabled: false,
            code: 'ai_provider_capability_missing',
            reason: 'The canonical AI provider service cannot prove the mobile sync invariants.',
            missing: missingCapabilities,
        };
    }
    const operations = ['listOwned', 'readOwned', 'residency', 'create', 'update', 'remove', 'restore'];
    const missingOperations = operations.filter((name) => typeof service[name] !== 'function');
    if (missingOperations.length) {
        return {
            enabled: false,
            code: 'ai_provider_service_incomplete',
            reason: 'The canonical AI provider service is missing required operations.',
            missing: missingOperations,
        };
    }
    return { enabled: true, code: null, reason: null };
}

function stableId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 200) throw invalid('invalid_ai_provider', 'AI provider id is invalid.');
    return id;
}

function safeEndpoint(value) {
    const endpoint = String(value || '').trim();
    if (!endpoint) return '';
    let parsed;
    try { parsed = new URL(endpoint); }
    catch { throw invalid('ai_provider_endpoint_not_syncable', 'AI provider endpoint must be an absolute HTTP(S) URL.', 409); }
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw invalid(
            'ai_provider_endpoint_not_syncable',
            'Credential-bearing or non-HTTP AI provider endpoints remain server-only.',
            409,
        );
    }
    return endpoint;
}

function copyObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
}

function safeOptions(value, { patch = false } = {}) {
    const input = copyObject(value);
    const output = {};
    for (const field of SAFE_OPTION_NUMBER_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
        const number = Number(input[field]);
        if (!Number.isFinite(number)) throw invalid('invalid_ai_provider', `AI provider option ${field} is invalid.`);
        output[field] = number;
    }
    for (const field of ['vision', 'use_previous_response_id']) {
        if (Object.prototype.hasOwnProperty.call(input, field)) output[field] = input[field] === true;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'reasoning_effort')) {
        const effort = String(input.reasoning_effort || '');
        if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
            throw invalid('invalid_ai_provider', 'AI provider reasoning effort is invalid.');
        }
        output.reasoning_effort = effort;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'context')) {
        const context = copyObject(input.context);
        if (Object.prototype.hasOwnProperty.call(context, 'windowTokens')) {
            const windowTokens = Number(context.windowTokens);
            if (!Number.isFinite(windowTokens) || windowTokens < 1) {
                throw invalid('invalid_ai_provider', 'AI provider context window is invalid.');
            }
            output.context = { windowTokens: Math.floor(windowTokens) };
        } else if (!patch) {
            output.context = {};
        }
    }
    return output;
}

function safeConfig(value, { patch = false } = {}) {
    const input = copyObject(value);
    const output = {};
    if (Object.prototype.hasOwnProperty.call(input, 'apiMode')) {
        const mode = String(input.apiMode || 'auto');
        if (!['auto', 'chat', 'responses', 'native'].includes(mode)) {
            throw invalid('invalid_ai_provider', 'AI provider apiMode is invalid.');
        }
        output.apiMode = mode;
    } else if (!patch) {
        output.apiMode = 'auto';
    }
    if (Object.prototype.hasOwnProperty.call(input, 'options')) {
        output.options = safeOptions(input.options, { patch });
    } else if (!patch) {
        output.options = {};
    }
    return output;
}

function safeModel(model) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
        const id = stableId(model);
        return { id, label: id };
    }
    const id = stableId(model.id || model.model || model.name);
    const output = { id, label: String(model.label || model.displayName || id).slice(0, 200) || id };
    for (const field of SAFE_MODEL_BOOLEAN_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(model, field)) output[field] = model[field] === true;
    }
    for (const field of SAFE_MODEL_NUMBER_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(model, field)) continue;
        const value = model[field];
        output[field] = value == null ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
    }
    if (Object.prototype.hasOwnProperty.call(model, 'reasoningEffort')) {
        const effort = String(model.reasoningEffort || '');
        output.reasoningEffort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
            ? effort
            : null;
    }
    if (Object.prototype.hasOwnProperty.call(model, 'promptCache')) {
        const cache = String(model.promptCache || 'auto');
        output.promptCache = ['auto', 'explicit', 'none'].includes(cache) ? cache : 'auto';
    }
    if (Object.prototype.hasOwnProperty.call(model, 'apiMode')) {
        const mode = model.apiMode == null ? null : String(model.apiMode);
        output.apiMode = mode === null || ['auto', 'chat', 'responses'].includes(mode) ? mode : null;
    }
    if (model.input && typeof model.input === 'object' && !Array.isArray(model.input)) {
        output.input = Object.fromEntries(['image', 'pdf', 'audio', 'video']
            .filter((field) => Object.prototype.hasOwnProperty.call(model.input, field))
            .map((field) => [field, model.input[field] === true]));
    }
    if (model.output && typeof model.output === 'object' && !Array.isArray(model.output)) {
        output.output = Object.fromEntries(['image', 'audio']
            .filter((field) => Object.prototype.hasOwnProperty.call(model.output, field))
            .map((field) => [field, model.output[field] === true]));
    }
    return output;
}

function safeModels(models) {
    if (!Array.isArray(models)) throw invalid('invalid_ai_provider', 'AI provider models must be an array.');
    const byId = new Map();
    for (const model of models.slice(0, 500)) {
        const projected = safeModel(model);
        byId.set(projected.id, projected);
    }
    return [...byId.values()];
}

function projectAiProvider(row) {
    if (!row) return null;
    if (row.deletedAt != null) return null;
    return {
        id: stableId(row.id),
        ownerUserId: String(row.ownerUserId || ''),
        revision: Math.max(1, Number(row.revision) || 1),
        createdAt: Number(row.createdAt || 0),
        updatedAt: Number(row.updatedAt || 0),
        name: String(row.name || '').slice(0, 100),
        type: String(row.type || 'openai-compatible'),
        baseUrl: safeEndpoint(row.baseUrl),
        defaultModel: String(row.defaultModel || '').slice(0, 200),
        models: safeModels(Array.isArray(row.models) ? row.models : []),
        config: safeConfig(row.config),
        visibility: String(row.visibility || 'private'),
        shareWithUsers: row.shareWithUsers === true,
        shareWithAdmins: row.shareWithAdmins === true,
        sharedUserIds: [...new Set((Array.isArray(row.sharedUserIds) ? row.sharedUserIds : []).map(String).filter(Boolean))].slice(0, 200),
        enabled: row.enabled !== false,
    };
}

function mergeModelsWithServerOnlyFields(current, incoming) {
    const prior = new Map((Array.isArray(current) ? current : []).map((model) => [String(model?.id || ''), model]));
    return safeModels(incoming).map((model) => ({ ...(prior.get(model.id) || {}), ...model }));
}

function safePatch(patch, current = null) {
    const input = copyObject(patch);
    const output = {};
    for (const field of ['name', 'type', 'defaultModel', 'visibility', 'shareWithUsers', 'shareWithAdmins', 'sharedUserIds', 'enabled']) {
        if (Object.prototype.hasOwnProperty.call(input, field)) output[field] = input[field];
    }
    if (Object.prototype.hasOwnProperty.call(input, 'baseUrl')) output.baseUrl = safeEndpoint(input.baseUrl);
    if (Object.prototype.hasOwnProperty.call(input, 'config')) {
        const mobileConfig = safeConfig(input.config, { patch: true });
        output.config = current ? {
            ...(current.config || {}),
            ...mobileConfig,
            ...(Object.prototype.hasOwnProperty.call(mobileConfig, 'options') ? {
                options: { ...(current.config?.options || {}), ...mobileConfig.options },
            } : {}),
        } : mobileConfig;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'models')) {
        output.models = mergeModelsWithServerOnlyFields(current?.models, input.models);
    }
    // apiKey reaches this seam only after the route opens its ML-KEM envelope.
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) output.apiKey = String(input.apiKey || '');
    return output;
}

function createAiProviderEntityAdapters({ registry, service } = {}) {
    const capability = getAiProviderSyncCapability({ registry, service });
    const adapters = new Map();
    if (!capability.enabled) return adapters;

    adapters.set(ENTITY_TYPE, {
        idOf: (row) => stableId(row?.id),
        revisionOf: (row) => Math.max(1, Number(row?.revision) || 1),
        residency: (user, id) => service.residency(user?.userId, id),
        list: (user) => service.listOwned(user?.userId).map(projectAiProvider),
        read: (user, id) => projectAiProvider(service.readOwned(user?.userId, id)),
        create: (user, id, patch, mutationContext = {}) => {
            id = stableId(id);
            if (service.residency(user?.userId, id) !== 'missing') {
                throw invalid('resource_not_found_or_inaccessible', 'AI provider id is unavailable.', 404);
            }
            return projectAiProvider(service.create(user, { id, ...safePatch(patch) }, mutationContext));
        },
        update: (user, id, patch, mutationContext = {}) => {
            const current = service.readOwned(user?.userId, id);
            if (!current) throw invalid('resource_not_found_or_inaccessible', 'AI provider is unavailable.', 404);
            return projectAiProvider(service.update(
                user,
                id,
                safePatch(patch, current),
                { expectedRevision: current.revision, ...mutationContext },
            ));
        },
        remove: (user, id, mutationContext = {}) => {
            const current = service.readOwned(user?.userId, id);
            if (!current) throw invalid('resource_not_found_or_inaccessible', 'AI provider is unavailable.', 404);
            return service.remove(user, id, { expectedRevision: current.revision, ...mutationContext });
        },
        restore: (user, id, mutationContext = {}) => {
            const deleted = service.readOwned(user?.userId, id, { includeDeleted: true });
            if (!deleted || deleted.deletedAt == null) {
                throw invalid('resource_not_found_or_inaccessible', 'Deleted AI provider is unavailable.', 404);
            }
            return projectAiProvider(service.restore(user, id, {
                expectedRevision: deleted.revision,
                ...mutationContext,
            }));
        },
        capability,
    });
    return adapters;
}

module.exports = {
    ENTITY_TYPE,
    REQUIRED_CAPABILITIES,
    getAiProviderSyncCapability,
    safeEndpoint,
    safeConfig,
    safeModels,
    safePatch,
    projectAiProvider,
    createAiProviderEntityAdapters,
};
