'use strict';

const RISK_LEVELS = new Set(['R0', 'R1', 'R2', 'R3', 'R4']);
const EXECUTION_MODES = new Set(['ai', 'humanOnly']);
const CAPABILITY_STATES = new Set(['implemented', 'planned']);
const CONFIRMATION_POLICIES = new Set(['never', 'always']);
const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

function strings(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function defineCapability(input = {}) {
    const id = String(input.id || '').trim();
    const mode = String(input.mode || 'ai');
    const state = String(input.state || 'planned');
    const risk = String(input.risk || 'R0');
    const confirmation = String(input.confirmation || (risk === 'R0' ? 'never' : 'always'));
    const toolIds = strings(input.toolIds);
    const keywords = strings(input.keywords);

    if (!CAPABILITY_ID.test(id)) throw new Error(`invalid capability id: ${id || '(empty)'}`);
    if (!EXECUTION_MODES.has(mode)) throw new Error(`invalid capability mode for ${id}`);
    if (!CAPABILITY_STATES.has(state)) throw new Error(`invalid capability state for ${id}`);
    if (!RISK_LEVELS.has(risk)) throw new Error(`invalid capability risk for ${id}`);
    if (!CONFIRMATION_POLICIES.has(confirmation)) throw new Error(`invalid capability confirmation policy for ${id}`);
    if (risk === 'R0' && confirmation !== 'never') throw new Error(`R0 capability cannot require confirmation: ${id}`);
    if (risk !== 'R0' && mode === 'ai' && confirmation !== 'always') throw new Error(`non-R0 AI capability requires confirmation: ${id}`);
    if (!String(input.title || '').trim()) throw new Error(`capability title is required: ${id}`);
    if (mode === 'humanOnly' && !String(input.humanOnlyReason || '').trim()) {
        throw new Error(`humanOnly capability requires a reason: ${id}`);
    }
    if (mode === 'humanOnly' && toolIds.length) throw new Error(`humanOnly capability cannot expose tools: ${id}`);
    if (mode === 'ai' && state === 'implemented' && !toolIds.length) {
        throw new Error(`implemented AI capability requires tool ids: ${id}`);
    }

    return Object.freeze({
        id,
        title: String(input.title).trim(),
        mode,
        state,
        risk,
        confirmation,
        keywords: Object.freeze(keywords),
        toolIds: Object.freeze(toolIds),
        humanOnlyReason: mode === 'humanOnly' ? String(input.humanOnlyReason).trim() : '',
        playbookId: String(input.playbookId || '').trim(),
    });
}

function defineCapabilities(items = []) {
    const seen = new Set();
    return Object.freeze(items.map((item) => {
        const capability = defineCapability(item);
        if (seen.has(capability.id)) throw new Error(`duplicate capability id: ${capability.id}`);
        seen.add(capability.id);
        return capability;
    }));
}

function publicCapability(capability) {
    return Object.freeze({
        id: capability.id,
        title: capability.title,
        mode: capability.mode,
        state: capability.state,
        risk: capability.risk,
        confirmation: capability.confirmation,
        toolIds: Object.freeze([...capability.toolIds]),
        playbookId: capability.playbookId,
        humanOnlyReason: capability.humanOnlyReason,
    });
}

function searchCapabilities(capabilities = [], query = '', { limit = 20, includeHumanOnly = false } = {}) {
    const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = capabilities.filter((capability) => includeHumanOnly || capability.mode !== 'humanOnly');
    const ranked = list.map((capability) => {
        const haystack = [capability.id, capability.title, capability.playbookId, ...capability.keywords, ...capability.toolIds].join(' ').toLowerCase();
        const score = words.length ? words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0) : 0;
        return { capability, score };
    }).filter((item) => !words.length || item.score > 0)
        .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id));
    return Object.freeze(ranked.slice(0, Math.max(1, Math.min(50, Number(limit) || 20))).map((item) => publicCapability(item.capability)));
}

function capabilityCoverageReport(capabilities = [], availableToolIds = []) {
    const tools = new Set(strings(availableToolIds));
    const missingToolBindings = [];
    const planned = [];
    const humanOnly = [];

    for (const capability of capabilities) {
        if (capability.mode === 'humanOnly') {
            humanOnly.push(capability.id);
            continue;
        }
        if (capability.state !== 'implemented') {
            planned.push(capability.id);
            continue;
        }
        const missingTools = capability.toolIds.filter((toolId) => !tools.has(toolId));
        if (missingTools.length) missingToolBindings.push({ id: capability.id, missingTools });
    }

    return Object.freeze({
        ok: missingToolBindings.length === 0,
        missingToolBindings: Object.freeze(missingToolBindings.map((item) => Object.freeze({
            id: item.id,
            missingTools: Object.freeze([...item.missingTools]),
        }))),
        planned: Object.freeze(planned),
        humanOnly: Object.freeze(humanOnly),
    });
}

module.exports = {
    RISK_LEVELS,
    EXECUTION_MODES,
    CAPABILITY_STATES,
    CONFIRMATION_POLICIES,
    defineCapability,
    defineCapabilities,
    publicCapability,
    searchCapabilities,
    capabilityCoverageReport,
};
