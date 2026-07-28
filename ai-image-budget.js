'use strict';

/**
 * S4 ImageBudget — align with OpenMinis-style spillover/elide.
 * Defaults are conservative; ModelEntry may override maxImages/maxImageBytes.
 */

const DEFAULTS = Object.freeze({
    maxImageBytes: 5 * 1024 * 1024,       // 5MB per image
    maxImagesPerRequest: 6,
    maxRequestImageBytes: 25 * 1024 * 1024, // 25MB total
    pinRecentVisualFrames: 2,             // RDP pins kept full
    compressEdges: Object.freeze([2000, 1600, 1280, 1024, 800, 640]),
});

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveBudget(modelEntry = {}, overrides = {}) {
    return {
        maxImageBytes: num(overrides.maxImageBytes ?? modelEntry?.maxImageBytes, DEFAULTS.maxImageBytes),
        maxImagesPerRequest: num(overrides.maxImagesPerRequest ?? modelEntry?.maxImagesPerRequest, DEFAULTS.maxImagesPerRequest),
        maxRequestImageBytes: num(overrides.maxRequestImageBytes, DEFAULTS.maxRequestImageBytes),
        pinRecentVisualFrames: num(overrides.pinRecentVisualFrames, DEFAULTS.pinRecentVisualFrames),
        compressEdges: DEFAULTS.compressEdges,
    };
}

/**
 * Estimate raw byte size of a data URL payload (base64 → ~3/4).
 */
function estimateDataUrlBytes(dataUrl = '') {
    const s = String(dataUrl || '');
    const i = s.indexOf('base64,');
    if (i < 0) return Buffer.byteLength(s);
    const b64 = s.slice(i + 7).replace(/\s+/g, '');
    return Math.floor(b64.length * 0.75);
}

function isImagePart(part = {}) {
    return part && (part.type === 'image_url' || part.Type === 'image_url') && (part.imageUrl || part.ImageURL);
}

function partImageUrl(part = {}) {
    return part.imageUrl || part.ImageURL || '';
}

/**
 * Apply budget to a list of provider-style messages (mutates copies).
 * Strategy: keep newest pinRecentVisualFrames full; elide older image parts
 * to text placeholders referencing attachmentId/spillover path when present.
 */
function applyImageBudget(messages = [], budgetInput = {}) {
    const budget = resolveBudget(budgetInput.modelEntry, budgetInput);
    const out = messages.map((m) => ({
        ...m,
        parts: Array.isArray(m.parts) ? m.parts.map((p) => ({ ...p })) : (Array.isArray(m.Parts) ? m.Parts.map((p) => ({ ...p })) : undefined),
        Parts: undefined,
    }));

    // Collect image part locations newest-first.
    const images = [];
    for (let mi = out.length - 1; mi >= 0; mi--) {
        const parts = out[mi].parts || [];
        for (let pi = parts.length - 1; pi >= 0; pi--) {
            if (isImagePart(parts[pi])) {
                images.push({ mi, pi, bytes: estimateDataUrlBytes(partImageUrl(parts[pi])), name: out[mi].name || out[mi].Name || '' });
            }
        }
    }

    let totalBytes = 0;
    let kept = 0;
    const elided = [];
    // images is newest-first
    for (let i = 0; i < images.length; i++) {
        const loc = images[i];
        const isPinned = i < budget.pinRecentVisualFrames;
        const overCount = kept >= budget.maxImagesPerRequest;
        const overBytes = totalBytes + loc.bytes > budget.maxRequestImageBytes;
        const overSingle = loc.bytes > budget.maxImageBytes;
        if (!isPinned && (overCount || overBytes || overSingle)) {
            const part = out[loc.mi].parts[loc.pi];
            const url = partImageUrl(part);
            const idMatch = /attachment[:\s]+([a-f0-9]{8,})/i.exec(out[loc.mi].content || '')
                || /\[attached image:\s*([^\s|]+)/i.exec((out[loc.mi].parts || []).map((p) => p.text || '').join('\n'));
            const placeholder = `[image elided by budget: ~${loc.bytes} bytes${idMatch ? `; id=${idMatch[1]}` : ''}; use user_attachment_view_v1 / workspace tools]`;
            out[loc.mi].parts[loc.pi] = { type: 'text', text: placeholder };
            // Drop empty image_url remnants
            elided.push({ index: loc.mi, bytes: loc.bytes, reason: overSingle ? 'single' : (overCount ? 'count' : 'total') });
            continue;
        }
        if (overSingle && isPinned) {
            // Still keep pin but note oversize — caller may compress; mark meta only.
            elided.push({ index: loc.mi, bytes: loc.bytes, reason: 'pin_oversize_kept' });
        }
        totalBytes += loc.bytes;
        kept += 1;
    }

    // Normalize parts key for Go (parts) — strip empty arrays
    return {
        messages: out.map((m) => {
            const msg = { role: m.role || m.Role, content: m.content || m.Content || '', name: m.name || m.Name, toolCallId: m.toolCallId || m.ToolCallID, toolCalls: m.toolCalls || m.ToolCalls };
            if (Array.isArray(m.parts) && m.parts.length) {
                msg.parts = m.parts.map((p) => ({
                    type: p.type || p.Type,
                    text: p.text || p.Text || '',
                    imageUrl: p.imageUrl || p.ImageURL || '',
                    mimeType: p.mimeType || p.MIMEType || '',
                }));
            }
            return msg;
        }),
        budget,
        stats: { imageCount: images.length, kept, elided: elided.length, totalBytes, elisions: elided },
    };
}

module.exports = {
    DEFAULTS,
    resolveBudget,
    estimateDataUrlBytes,
    applyImageBudget,
};
