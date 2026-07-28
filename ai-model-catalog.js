'use strict';

/**
 * Per-model capability catalog (S0).
 * models_json accepts legacy string[] or ModelEntry[]; reads always normalize to ModelEntry[].
 */

function bool(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    return !!value;
}

function numOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function cleanId(value) {
    return String(value || '').trim().slice(0, 200);
}

function defaultModalities(providerVisionDefault = true) {
    return {
        input: {
            image: !!providerVisionDefault,
            pdf: false,
            audio: false,
            video: false,
        },
        output: {
            image: false,
            audio: false,
        },
    };
}

/**
 * @param {string|object} raw
 * @param {{ providerVisionDefault?: boolean }} [opts]
 * @returns {object|null}
 */
function normalizeModelEntry(raw, opts = {}) {
    const providerVisionDefault = opts.providerVisionDefault !== false;
    if (raw == null) return null;
    if (typeof raw === 'string') {
        const id = cleanId(raw);
        if (!id) return null;
        const mods = defaultModalities(providerVisionDefault);
        return {
            id,
            label: id,
            hidden: false,
            contextWindowTokens: null,
            maxOutputTokens: null,
            temperature: null,
            topP: null,
            reasoning: false,
            reasoningEffort: null,
            input: mods.input,
            output: mods.output,
            tools: true,
            parallelToolCalls: true,
            promptCache: 'auto',
            maxImagesPerRequest: null,
            maxImageBytes: null,
            apiMode: null,
            userAgent: null,
            extra: {},
        };
    }
    if (typeof raw !== 'object') return null;
    const id = cleanId(raw.id || raw.model || raw.name);
    if (!id) return null;
    const mods = defaultModalities(providerVisionDefault);
    const input = raw.input && typeof raw.input === 'object' ? raw.input : {};
    const output = raw.output && typeof raw.output === 'object' ? raw.output : {};
    const effort = raw.reasoningEffort == null || raw.reasoningEffort === ''
        ? null
        : String(raw.reasoningEffort);
    const allowedEffort = new Set(['none', 'low', 'medium', 'high', 'max']);
    return {
        id,
        label: cleanId(raw.label || raw.displayName || id) || id,
        hidden: bool(raw.hidden, false),
        contextWindowTokens: numOrNull(raw.contextWindowTokens ?? raw.context_window),
        maxOutputTokens: numOrNull(raw.maxOutputTokens ?? raw.max_output_tokens),
        temperature: raw.temperature == null || raw.temperature === '' ? null : Number(raw.temperature),
        topP: raw.topP == null && raw.top_p == null ? null : Number(raw.topP ?? raw.top_p),
        reasoning: bool(raw.reasoning, false),
        reasoningEffort: effort && allowedEffort.has(effort) ? effort : null,
        input: {
            image: bool(input.image, mods.input.image),
            pdf: bool(input.pdf, false),
            audio: bool(input.audio, false),
            video: bool(input.video, false),
        },
        output: {
            image: bool(output.image, false),
            audio: bool(output.audio, false),
        },
        tools: raw.tools === undefined ? true : !!raw.tools,
        parallelToolCalls: raw.parallelToolCalls === undefined ? true : !!raw.parallelToolCalls,
        promptCache: ['auto', 'explicit', 'none'].includes(String(raw.promptCache || ''))
            ? String(raw.promptCache)
            : 'auto',
        maxImagesPerRequest: numOrNull(raw.maxImagesPerRequest),
        maxImageBytes: numOrNull(raw.maxImageBytes),
        apiMode: raw.apiMode == null || raw.apiMode === '' || raw.apiMode === 'auto'
            ? (raw.apiMode === 'auto' ? 'auto' : null)
            : (['chat', 'responses'].includes(String(raw.apiMode)) ? String(raw.apiMode) : null),
        userAgent: raw.userAgent == null || raw.userAgent === '' ? null : String(raw.userAgent).slice(0, 300),
        extra: raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra) ? { ...raw.extra } : {},
    };
}

/**
 * Normalize any models field to ModelEntry[].
 * Dedupes by id (last wins for merge safety on refresh).
 */
function normalizeModels(models, opts = {}) {
    const list = Array.isArray(models)
        ? models
        : String(models || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const byId = new Map();
    for (const item of list) {
        const entry = normalizeModelEntry(item, opts);
        if (!entry) continue;
        byId.set(entry.id, entry);
    }
    return [...byId.values()];
}

/**
 * Merge remote model id list into existing entries, preserving capability config.
 * New ids get defaults from providerVisionDefault.
 */
function mergeModelList(existing, remoteIds, opts = {}) {
    const current = normalizeModels(existing, opts);
    const byId = new Map(current.map((m) => [m.id, m]));
    const remote = (Array.isArray(remoteIds) ? remoteIds : [])
        .map((x) => (typeof x === 'string' ? x : x?.id))
        .map(cleanId)
        .filter(Boolean);
    for (const id of remote) {
        if (!byId.has(id)) {
            byId.set(id, normalizeModelEntry(id, opts));
        }
    }
    // Keep remote order when provided; append locals not in remote at end.
    if (remote.length) {
        const ordered = [];
        const seen = new Set();
        for (const id of remote) {
            if (seen.has(id)) continue;
            ordered.push(byId.get(id));
            seen.add(id);
        }
        for (const m of byId.values()) {
            if (!seen.has(m.id)) ordered.push(m);
        }
        return ordered;
    }
    return [...byId.values()];
}

function findModelEntry(models, modelId) {
    const id = cleanId(modelId);
    if (!id) return null;
    const list = normalizeModels(models, { providerVisionDefault: true });
    return list.find((m) => m.id === id) || null;
}

/**
 * Runtime gate helper: does this model accept image input?
 * Falls back to provider.options.vision when entry missing (legacy).
 */
function modelAcceptsImage(provider, modelId) {
    const entry = findModelEntry(provider?.models, modelId);
    if (entry) return !!entry.input?.image;
    if (provider?.config?.options?.vision === false || provider?.options?.vision === false) return false;
    return true;
}

function modelIsHidden(provider, modelId) {
    const entry = findModelEntry(provider?.models, modelId);
    return !!(entry && entry.hidden);
}

function selectableModelIds(provider) {
    return normalizeModels(provider?.models || [], {
        providerVisionDefault: provider?.config?.options?.vision !== false && provider?.options?.vision !== false,
    })
        .filter((m) => !m.hidden)
        .map((m) => m.id);
}

/**
 * Serialize rich Node ModelEntry[] to the legacy Go provider.Config []string.
 * Hidden models remain included: hidden affects UI selection, not provider auth.
 */
function runtimeModelIds(models) {
    const list = Array.isArray(models) ? models : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const id = cleanId(typeof item === 'string' ? item : item?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

module.exports = {
    normalizeModelEntry,
    normalizeModels,
    mergeModelList,
    findModelEntry,
    modelAcceptsImage,
    modelIsHidden,
    selectableModelIds,
    runtimeModelIds,
    defaultModalities,
};
