'use strict';

const LEVEL_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LEVEL_RANK = new Map(LEVEL_ORDER.map((level, index) => [level, index]));

function normalizeLevel(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'off' || raw === 'disabled' || raw === '0') return 'none';
    if (raw === 'dynamic' || raw === '-1') return 'medium';
    if (raw === 'ultra') return 'max';
    return LEVEL_RANK.has(raw) ? raw : '';
}

function providerKind(provider = {}) {
    const type = String(provider?.type || provider?.kind || '').toLowerCase();
    const base = String(provider?.baseUrl || '').toLowerCase();
    if (type === 'anthropic' || type === 'claude' || base.includes('anthropic.com')) return 'anthropic';
    if (type === 'gemini' || type === 'google' || type === 'google-gemini' || base.includes('generativelanguage.googleapis.com')) return 'gemini';
    return 'openai';
}

function findModelEntry(provider = {}, modelId = '') {
    const id = String(modelId || '').trim();
    const models = Array.isArray(provider?.models) ? provider.models : [];
    for (const item of models) {
        if (typeof item === 'string') continue;
        if (String(item?.id || item?.model || '').trim() === id) return item;
    }
    return null;
}

// Model-family ceilings aligned with OpenMinis ThinkingLevelCatalog. Unknown
// reasoning-capable models conservatively top out at xhigh.
function declaredMaxLevel(modelId = '') {
    const id = String(modelId || '').trim().toLowerCase();
    const normalized = id.replaceAll('.', '-');
    if (/^gpt-5\.6-(sol|terra|luna)/.test(id)) return 'max';
    if (id.startsWith('gpt-5.5')) return 'xhigh';
    if (id.includes('mimo') || id.includes('agnes')) return 'high';
    if (id.includes('seed-') || id.includes('bytedance-seed')) return 'high';
    if (normalized.startsWith('claude-opus-4')) return 'max';
    return 'xhigh';
}

function inferredReasoningModel(modelId = '') {
    const id = String(modelId || '').trim().toLowerCase();
    return /(^|[/:._-])(o1|o3|o4)([/:._-]|$)/.test(id)
        || id.startsWith('gpt-5')
        || id.startsWith('gpt-4.1')
        || id.includes('claude-opus-4')
        || id.includes('claude-sonnet-4-6')
        || id.includes('mimo')
        || id.includes('agnes')
        || id.includes('seed-')
        || id.includes('bytedance-seed')
        || id.includes('gemini-2.5')
        || id.includes('gemini-3');
}

function effectiveMaxLevel(provider = {}, modelId = '') {
    const entry = findModelEntry(provider, modelId);
    const explicit = normalizeLevel(entry?.reasoningEffort);
    if (explicit) return explicit;
    // Older Zephyr builds wrote reasoning:false for every newly fetched model,
    // including GPT-5.x. Preserve compatibility by treating known reasoning
    // families as capable; explicit true also enables unknown model families.
    if (entry?.reasoningConfigured === true && entry?.reasoning === false) return 'none';
    if (entry?.reasoning === true || inferredReasoningModel(modelId)) return declaredMaxLevel(modelId);
    return 'none';
}

function clampLevel(level, maxLevel) {
    const requested = normalizeLevel(level);
    const ceiling = normalizeLevel(maxLevel);
    if (!requested) return '';
    if (!ceiling) return requested;
    return LEVEL_RANK.get(requested) > LEVEL_RANK.get(ceiling) ? ceiling : requested;
}

function apiMode(provider = {}) {
    const mode = String(provider?.config?.apiMode || provider?.apiMode || provider?.api || provider?.endpointMode || 'auto').toLowerCase();
    const base = String(provider?.baseUrl || '').toLowerCase();
    if (mode === 'responses' || /\/responses\/?$/.test(base)) return 'responses';
    if (mode === 'chat' || /\/chat\/completions\/?$/.test(base)) return 'chat';
    return 'chat';
}

function optionsForProvider(provider = {}, modelId = '') {
    const kind = providerKind(provider);
    const id = String(modelId || provider?.defaultModel || '').toLowerCase();
    const maxLevel = effectiveMaxLevel(provider, id);
    if (maxLevel === 'none') return [['', '默认']];
    if (kind === 'gemini') {
        if (/gemini-2\.5/i.test(id)) return [
            ['', '默认'], ['0', '关闭思考'], ['-1', '动态思考'], ['1024', '浅度思考'], ['8192', '深度思考'],
        ];
        return [['', '默认'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']];
    }
    const base = kind === 'anthropic'
        ? [['', '默认'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']]
        : [['', '默认'], ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
    const maxRank = LEVEL_RANK.get(maxLevel) ?? LEVEL_RANK.get('xhigh');
    return base.filter(([value]) => !value || (LEVEL_RANK.get(normalizeLevel(value)) ?? 0) <= maxRank);
}

function openAIWireLevel(provider = {}, modelId = '', level = '') {
    const id = String(modelId || '').toLowerCase();
    const requested = normalizeLevel(level);
    if (!requested) return '';
    const clamped = clampLevel(requested, effectiveMaxLevel(provider, id));
    if (clamped === 'none') {
        // Strict low/medium/high endpoints reject none/minimal. Omit instead.
        if (id.includes('mimo') || id.includes('agnes')) return '';
        return 'none';
    }
    if ((id.includes('mimo') || id.includes('agnes') || id.includes('seed-') || id.includes('bytedance-seed'))
        && (clamped === 'xhigh' || clamped === 'max')) return 'high';
    return clamped === 'max' && !/^gpt-5\.6-(sol|terra|luna)/.test(id) && !id.startsWith('claude-opus-4')
        ? 'xhigh'
        : clamped;
}

function sanitizeThinkingOptions(provider = {}, modelId = '', requestOptions = {}) {
    const options = requestOptions && typeof requestOptions === 'object' ? { ...requestOptions } : {};
    const kind = providerKind(provider);
    const entry = findModelEntry(provider, modelId);
    if (entry?.reasoningConfigured === true && entry.reasoning === false) {
        delete options.reasoning_effort;
        delete options.reasoning;
        delete options.effort;
        delete options.thinkingConfig;
        delete options.thinking_config;
        delete options.output_config;
        return options;
    }
    if (kind === 'openai') {
        const raw = options.reasoning_effort ?? options.reasoning?.effort ?? options.effort;
        const effort = openAIWireLevel(provider, modelId, raw);
        delete options.effort;
        if (apiMode(provider) === 'responses') {
            delete options.reasoning_effort;
            if (effort) options.reasoning = { ...(options.reasoning && typeof options.reasoning === 'object' ? options.reasoning : {}), effort };
            else delete options.reasoning;
        } else {
            delete options.reasoning;
            if (effort) options.reasoning_effort = effort;
            else delete options.reasoning_effort;
        }
        return options;
    }
    if (kind === 'gemini') {
        const config = options.thinkingConfig ?? options.thinking_config;
        delete options.thinking_config;
        delete options.reasoning_effort;
        delete options.reasoning;
        delete options.effort;
        if (config && typeof config === 'object' && Number.isFinite(Number(config.thinkingBudget))) {
            options.thinkingConfig = { ...config, thinkingBudget: Number(config.thinkingBudget) };
            return options;
        }
        const raw = config?.thinkingLevel;
        const effort = clampLevel(raw, effectiveMaxLevel(provider, modelId));
        const id = String(modelId || '').toLowerCase();
        if (!effort) {
            delete options.thinkingConfig;
        } else if (/gemini-2\.5/i.test(id)) {
            const budget = effort === 'none' ? 0
                : (effort === 'minimal' || effort === 'low') ? 1024
                    : effort === 'medium' ? -1 : 8192;
            options.thinkingConfig = { thinkingBudget: budget };
        } else {
            const level = effort === 'none' || effort === 'minimal' ? 'minimal'
                : (effort === 'xhigh' || effort === 'max') ? 'high' : effort;
            options.thinkingConfig = { thinkingLevel: level };
        }
        return options;
    }
    if (kind === 'anthropic') {
        const raw = options.effort ?? options.reasoning_effort ?? options.output_config?.effort;
        const effort = clampLevel(raw, effectiveMaxLevel(provider, modelId));
        delete options.reasoning_effort;
        if (effort && effort !== 'none') {
            const wireEffort = effort === 'xhigh' ? 'max' : effort;
            options.effort = wireEffort;
            options.output_config = { ...(options.output_config && typeof options.output_config === 'object' ? options.output_config : {}), effort: wireEffort };
        } else {
            delete options.effort;
            delete options.output_config;
        }
        return options;
    }
    return options;
}

function nextFallbackLevel(level) {
    const normalized = normalizeLevel(level);
    if (!normalized || normalized === 'none') return '';
    const ladder = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];
    const index = ladder.indexOf(normalized);
    return index < 0 || index === ladder.length - 1 ? '' : ladder[index + 1];
}

function rejectedThinkingLevel(error) {
    const text = String(error?.message || error || '');
    if (!/(reasoning|thinking|effort)/i.test(text)) return '';
    const match = text.match(/(?:invalid|unsupported|not supported|unknown)[^\n]{0,120}?(max|xhigh|high|medium|low|minimal|none)/i)
        || text.match(/(?:reasoning_effort|reasoning\.effort|thinkingLevel|effort)[^\n]{0,80}?[=:"'\s]+(max|xhigh|high|medium|low|minimal|none)/i);
    return normalizeLevel(match?.[1] || '');
}

const ThinkingPolicy = {
    LEVEL_ORDER,
    normalizeLevel,
    providerKind,
    findModelEntry,
    declaredMaxLevel,
    inferredReasoningModel,
    effectiveMaxLevel,
    clampLevel,
    apiMode,
    optionsForProvider,
    openAIWireLevel,
    sanitizeThinkingOptions,
    nextFallbackLevel,
    rejectedThinkingLevel,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ThinkingPolicy;
if (typeof globalThis !== 'undefined') globalThis.ZephyrThinkingPolicy = ThinkingPolicy;
