'use strict';

const DEFAULT_WINDOW_TOKENS = 128000;
const MIN_INPUT_TOKENS = 4096;

const KNOWN_WINDOWS = [
    [/gpt-4\.1|gpt-4o|gpt-5|o1|o3|o4/i, 128000],
    [/gpt-4-turbo/i, 128000],
    [/gpt-4(?!o|\.1|-turbo)/i, 8192],
    [/gpt-3\.5-turbo/i, 16385],
    [/claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku/i, 200000],
    [/gemini-2|gemini-1\.5/i, 1000000],
    [/deepseek|qwen|glm-4|kimi|moonshot/i, 128000],
    [/llama-3\.1|llama-3\.2|llama-3\.3/i, 128000],
];

function finitePositive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function inferModelWindowTokens(provider = {}, model = '', explicit = 0) {
    const candidates = [
        explicit,
        provider.options?.context?.windowTokens,
        provider.options?.contextWindowTokens,
        provider.config?.context?.windowTokens,
        provider.config?.contextWindowTokens,
        provider.contextWindowTokens,
    ];
    for (const candidate of candidates) {
        const value = finitePositive(candidate);
        if (value) return Math.max(1024, Math.min(2000000, Math.floor(value)));
    }
    const selected = String(model || provider.defaultModel || '');
    for (const [pattern, tokens] of KNOWN_WINDOWS) if (pattern.test(selected)) return tokens;
    return DEFAULT_WINDOW_TOKENS;
}

function estimateTextTokens(text = '') {
    const value = String(text || '');
    if (!value) return 0;
    const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const other = Math.max(0, value.length - cjk);
    return Math.ceil(cjk * 1.05 + other / 3.7);
}

function estimateJsonTokens(value) {
    try { return estimateTextTokens(JSON.stringify(value || {})); } catch { return 0; }
}

function computeContextBudget({ provider = {}, model = '', explicitWindowTokens = 0, systemPrompt = '', tools = [], requestedOutputTokens = 0 } = {}) {
    const windowTokens = inferModelWindowTokens(provider, model, explicitWindowTokens);
    const systemTokens = estimateTextTokens(systemPrompt);
    const toolTokens = estimateJsonTokens(tools);
    const configuredOutput = finitePositive(requestedOutputTokens || provider.options?.maxTokens || provider.options?.max_tokens || provider.config?.maxTokens);
    const outputReserveTokens = Math.max(1024, Math.min(Math.floor(windowTokens * 0.25), Math.floor(configuredOutput || Math.min(8192, windowTokens * 0.08))));
    const safetyReserveTokens = Math.max(1024, Math.floor(windowTokens * 0.05));
    const overheadTokens = Math.max(512, Math.ceil((systemTokens + toolTokens) * 0.04));
    const historyBudgetTokens = Math.max(MIN_INPUT_TOKENS, windowTokens - systemTokens - toolTokens - outputReserveTokens - safetyReserveTokens - overheadTokens);
    const charsPerToken = 2.8;
    return {
        windowTokens,
        systemTokens,
        toolTokens,
        outputReserveTokens,
        safetyReserveTokens,
        overheadTokens,
        historyBudgetTokens,
        maxInputChars: Math.max(8000, Math.floor(historyBudgetTokens * charsPerToken)),
        perMessageChars: Math.max(2000, Math.floor(historyBudgetTokens * charsPerToken * 0.65)),
        recentChars: Math.max(8000, Math.floor(historyBudgetTokens * charsPerToken * 0.35)),
        summaryChars: Math.max(2000, Math.min(30000, Math.floor(historyBudgetTokens * charsPerToken * 0.12))),
    };
}

module.exports = { inferModelWindowTokens, estimateTextTokens, estimateJsonTokens, computeContextBudget };
