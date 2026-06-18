const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { browserService, SHOT_DIR } = require('./ai-browser-service');
const { DEFAULT_ZEPHYR_SYSTEM_PROMPT, DEFAULT_ZEPHYR_SKILLS } = require('./ai-defaults');

const DEFAULT_TOOL_CALL_LIMIT = 0;
const DEFAULT_AI_CONTEXT = { windowTokens: 64000, maxInputChars: 90000, keepMessages: 18, toolResultChars: 30000, memoryItems: 16, maxToolRounds: 0, summaryChars: 18000, recentChars: 42000 };
const MAX_TOOL_TEXT = 60 * 1024;
const AI_TOOL_CACHE = new Map();
const AI_OPENAI_TOOL_CACHE = new WeakMap();
const AI_ANTHROPIC_TOOL_CACHE = new WeakMap();
const AI_GEMINI_TOOL_CACHE = new WeakMap();
const AI_PERF_SAMPLES = [];
const MAX_AI_PERF_SAMPLES = 200;
const AI_CONVERSATION_SUMMARY_PREFIX = '高轮次对话压缩摘要';
const MAX_REMOTE_READ = 512 * 1024;
const MAX_REMOTE_WRITE = 1024 * 1024;
const pendingActions = new Map();

function aiAbortError() {
    const err = new Error('AI 请求已停止');
    err.name = 'AbortError';
    return err;
}
function delay(ms, signal = null) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(aiAbortError());
        let timer = null;
        const done = () => {
            try { signal?.removeEventListener?.('abort', abort); } catch {}
            resolve();
        };
        const abort = () => {
            if (timer) clearTimeout(timer);
            reject(aiAbortError());
        };
        signal?.addEventListener?.('abort', abort, { once: true });
        timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    });
}
function clampNumber(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function safeJsonParse(value, fallback = null) { try { return JSON.parse(String(value || '').trim()); } catch { return fallback; } }
function htmlDecode(value = '') {
    return String(value)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 0));
}
function stripHtml(html = '') {
    return htmlDecode(String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}
function clipText(value, max = MAX_TOOL_TEXT) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}\n...[已截断 ${text.length - max} 字符]` : text;
}
function publicError(err) { return err?.message || String(err || '执行失败'); }
function isTransientAiFetchError(err) {
    const message = String(err?.message || err || '');
    const code = String(err?.code || err?.cause?.code || '');
    return err?.name === 'TimeoutError'
        || /fetch failed|terminated|socket hang up|network socket disconnected|other side closed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR/i.test(message)
        || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR/i.test(code);
}
function aiFetchErrorMessage(err, label = 'AI provider') {
    const message = String(err?.message || err || '请求失败');
    const cause = err?.cause;
    const causeCode = cause?.code ? ` (${cause.code})` : '';
    if (err?.name === 'TimeoutError') return `${label} 请求超时，请稍后重试或切换模型/供应商`;
    if (/fetch failed/i.test(message)) return `${label} 网络请求失败${causeCode}：可能是上游接口临时断连、代理/DNS/TLS 不稳定或响应过慢`;
    if (isTransientAiFetchError(err)) return `${label} 网络连接中断${causeCode}：${message}`;
    return message;
}
function aiProviderTimeoutMs(provider = {}, options = {}) {
    const raw = options.timeoutMs || options.timeout_ms || provider.timeoutMs || provider.timeout_ms || provider.options?.timeoutMs || 120000;
    return clampNumber(raw, 15000, 300000, 120000);
}
function aiProviderRetryCount(provider = {}, options = {}) {
    const raw = options.retries ?? options.retryCount ?? provider.retries ?? provider.retryCount ?? provider.options?.retries ?? 2;
    return clampNumber(raw, 0, 5, 2);
}
function aiBrowserSession(args = {}, ctx = {}) {
    const explicit = String(args.session || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    const chatId = String(ctx.context?.aiChatSessionId || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    if (!chatId) return explicit || 'default';
    const base = `chat-${chatId}`;
    if (!explicit || explicit === 'default' || explicit === base) return base;
    if (explicit.startsWith(`${base}-`)) return explicit;
    return `${base}-${explicit}`;
}
function unsupportedParameterName(err) {
    const text = String(err?.message || err || '');
    const match = text.match(/Unsupported parameter:\s*['"]?([A-Za-z0-9_.-]+)['"]?/i)
        || text.match(/Unsupported value:\s*['"]?([A-Za-z0-9_.-]+)['"]?/i)
        || text.match(/(?:Unknown|Unrecognized|Invalid) parameter:\s*['"]?([A-Za-z0-9_.-]+)['"]?/i)
        || text.match(/['"]([A-Za-z0-9_.-]+)['"]\s+(?:is|does)\s+not\s+support(?:ed)?/i)
        || text.match(/['"]([A-Za-z0-9_.-]+)['"]\s+is not supported/i);
    const key = match?.[1] || '';
    return /^[A-Za-z0-9_.-]{1,80}$/.test(key) ? key : '';
}
function removePayloadParameter(payload, param) {
    if (!payload || !param) return false;
    const aliases = {
        topP: ['topP', 'top_p'],
        top_p: ['top_p', 'topP'],
        maxOutputTokens: ['maxOutputTokens', 'max_output_tokens', 'max_tokens'],
        max_output_tokens: ['max_output_tokens', 'maxOutputTokens', 'max_tokens'],
        max_tokens: ['max_tokens', 'max_output_tokens', 'maxOutputTokens'],
        reasoning_effort: ['reasoning_effort', 'reasoning'],
        reasoning: ['reasoning', 'reasoning_effort'],
    };
    const names = new Set(aliases[param] || [param]);
    let removed = false;
    const removeFrom = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        names.forEach((name) => {
            if (Object.prototype.hasOwnProperty.call(obj, name)) {
                delete obj[name];
                removed = true;
            }
        });
    };
    removeFrom(payload);
    removeFrom(payload.generationConfig);
    removeFrom(payload.text);
    return removed;
}
async function fetchJsonWithUnsupportedParamRetry(url, requestOptions = {}, payload = {}, label = 'AI provider') {
    const body = payload && typeof payload === 'object' ? payload : {};
    const removed = [];
    const retryCount = clampNumber(requestOptions.retries, 0, 5, 2);
    let transientRetries = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            return await fetchJson(url, { ...requestOptions, label, body: JSON.stringify(body) });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            const param = unsupportedParameterName(err);
            if (param && !removed.includes(param) && removePayloadParameter(body, param)) {
                removed.push(param);
                console.warn(`[ai-agent] ${label} rejected unsupported parameter '${param}', retrying without it`);
                continue;
            }
            if (isTransientAiFetchError(err) && transientRetries < retryCount) {
                transientRetries += 1;
                const waitMs = 450 * transientRetries;
                console.warn(`[ai-agent] ${label} transient fetch error, retry ${transientRetries}/${retryCount} after ${waitMs}ms: ${err.message}`);
                await delay(waitMs, requestOptions.signal);
                continue;
            }
            throw err;
        }
    }
    return fetchJson(url, { ...requestOptions, label, body: JSON.stringify(body) });
}
function throwIfAborted(signal) {
    if (signal?.aborted) throw aiAbortError();
}
function normalizeRole(role) {
    const value = String(role || '').toLowerCase();
    if (value === 'ai') return 'assistant';
    if (['system', 'user', 'assistant', 'tool'].includes(value)) return value;
    return 'user';
}
function normalizeContextLimits(ai = {}, provider = {}) {
    const global = ai.context || {};
    const providerContext = provider.options?.context || {};
    const raw = { ...global, ...providerContext };
    const windowTokens = clampNumber(raw.windowTokens, 1024, 1000000, DEFAULT_AI_CONTEXT.windowTokens);
    return {
        windowTokens,
        keepMessages: clampNumber(raw.keepMessages, 4, 160, DEFAULT_AI_CONTEXT.keepMessages),
        maxInputChars: clampNumber(raw.maxInputChars || Math.floor(windowTokens * 2.4), 8000, 1200000, DEFAULT_AI_CONTEXT.maxInputChars),
        perMessageChars: clampNumber(raw.perMessageChars || Math.floor(windowTokens * 0.85), 1000, 300000, 36000),
        toolResultChars: clampNumber(raw.toolResultChars, 1000, 240000, DEFAULT_AI_CONTEXT.toolResultChars),
        memoryItems: clampNumber(raw.memoryItems, 0, 80, DEFAULT_AI_CONTEXT.memoryItems),
        summaryChars: clampNumber(raw.summaryChars, 2000, 120000, DEFAULT_AI_CONTEXT.summaryChars),
        recentChars: clampNumber(raw.recentChars, 8000, 240000, DEFAULT_AI_CONTEXT.recentChars),
    };
}
function contentTextLength(content) {
    if (Array.isArray(content)) return content.reduce((sum, part) => sum + String(part?.text || part?.content || '').length + (part?.image_url || part?.inlineData || part?.input_audio || part?.audioData ? 1200 : 0), 0);
    return String(content || '').length;
}
function messageContentText(content) {
    if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || (part?.image_url ? '[图片]' : part?.inlineData ? (String(part.inlineData.mimeType || '').startsWith('audio/') ? '[音频]' : '[图片]') : part?.input_audio || part?.audioData ? '[音频]' : '')).filter(Boolean).join('\n');
    return String(content || '');
}
function normalizeConversationMessage(item = {}, limits = {}) {
    return { role: normalizeRole(item.role), content: normalizeMultimodalContent(item.content || '', limits), response_id: item.response_id || item._response_id || '' };
}
function compactConversationHistory(messages = [], limits = {}) {
    const perMessageChars = clampNumber(limits.perMessageChars, 1000, 300000, 60000);
    const maxInputChars = clampNumber(limits.maxInputChars, 8000, 1200000, 180000);
    const summaryChars = clampNumber(limits.summaryChars, 2000, 120000, DEFAULT_AI_CONTEXT.summaryChars);
    const recentChars = clampNumber(limits.recentChars, 8000, 240000, DEFAULT_AI_CONTEXT.recentChars);
    const items = (Array.isArray(messages) ? messages : [])
        .filter((item) => !['trace', 'system'].includes(String(item?.role || '').toLowerCase()))
        .map((item) => normalizeConversationMessage(item, { ...limits, perMessageChars }))
        .filter((item) => item.content || item.role === 'assistant');
    let total = items.reduce((sum, item) => sum + contentTextLength(item.content), 0);
    if (total <= maxInputChars && items.length <= clampNumber(limits.keepMessages, 4, 160, 40)) return { messages: items, summary: '', originalCount: items.length, compactedCount: 0, totalChars: total };
    const recent = [];
    let recentTotal = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
        const len = contentTextLength(items[i].content);
        const minimumTail = recent.length < 8;
        if (!minimumTail && recentTotal + len > recentChars) break;
        recent.unshift(items[i]);
        recentTotal += len;
    }
    const older = items.slice(0, Math.max(0, items.length - recent.length));
    const lines = [];
    let omitted = 0;
    for (const item of older) {
        const role = item.role === 'assistant' ? 'AI' : item.role === 'tool' ? '工具' : '用户';
        let text = messageContentText(item.content).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const room = summaryChars - lines.join('\n').length;
        if (room <= 120) { omitted += 1; continue; }
        text = text.slice(0, Math.min(700, room));
        lines.push(`- ${role}: ${text}`);
    }
    const summary = older.length ? `${AI_CONVERSATION_SUMMARY_PREFIX}（自动生成，保留早期目标/约束/决定；最近 ${recent.length} 条保持原文）：\n${lines.join('\n')}${omitted ? `\n- ……另有 ${omitted} 条早期消息已合并进摘要窗口。` : ''}` : '';
    let compacted = recent.slice();
    let compactedTotal = compacted.reduce((sum, item) => sum + contentTextLength(item.content), 0);
    while (compacted.length > 2 && compactedTotal + summary.length > maxInputChars) {
        const removed = compacted.shift();
        compactedTotal -= contentTextLength(removed.content);
    }
    return { messages: compacted, summary: clipText(summary, summaryChars), originalCount: items.length, compactedCount: older.length, totalChars: total };
}

function normalizeMultimodalContent(content, limits = {}) {
    const perMessageChars = clampNumber(limits.perMessageChars, 1000, 300000, 60000);
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
            if (part.type === 'text') return { type: 'text', text: clipText(part.text || part.content || '', perMessageChars) };
            if (part.type === 'image_url' && part.image_url?.url) return { type: 'image_url', image_url: { url: part.image_url.url, detail: part.image_url.detail || 'auto' } };
            if (part.inlineData) return { inlineData: part.inlineData };
            return { type: 'text', text: clipText(part.text || part.content || '', perMessageChars) };
        }).filter((part) => part.inlineData || part.image_url || part.text);
    }
    const text = String(content || '');
    const parts = [];
    const re = /data:(image|audio)\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;
    let last = 0;
    let idx = 0;
    let hasImage = false;
    let hasAudio = false;
    let m;
    while ((m = re.exec(text)) && idx < 6) {
        const before = text.slice(last, m.index).trim();
        if (before) parts.push({ type: 'text', text: clipText(before, perMessageChars) });
        const payload = dataUrlPayload(m[0].replace(/\s+/g, ''));
        if (payload.data && String(payload.mimeType || '').startsWith('image/')) { parts.push({ type: 'image_url', image_url: { url: `data:${payload.mimeType};base64,${payload.data}`, detail: 'auto' } }); hasImage = true; }
        else if (payload.data && String(payload.mimeType || '').startsWith('audio/')) { parts.push({ type: 'input_audio', input_audio: { data: payload.data, format: audioFormatFromMime(payload.mimeType) }, audioData: { mimeType: payload.mimeType, data: payload.data } }); hasAudio = true; }
        last = re.lastIndex;
        idx += 1;
    }
    const rest = text.slice(last).trim();
    if (rest) parts.push({ type: 'text', text: clipText(rest, perMessageChars) });
    if (!parts.length) return clipText(text, perMessageChars);
    parts.unshift({ type: 'text', text: `${hasImage ? '用户消息包含图片附件。请直接观察图片内容；不要把 data URL 当作普通文本。' : ''}${hasAudio ? '用户消息包含音频附件。请直接听取/理解音频内容；不要要求用户另行转文字。' : ''}`.trim() });
    return parts;
}

function sanitizeMessages(messages = [], limits = {}) {
    return compactConversationHistory(messages, limits).messages;
}
function dataUrlPayload(dataUrl = '') {
    const match = /^data:([^;,]+);base64,(.*)$/i.exec(String(dataUrl || ''));
    return match ? { mimeType: match[1] || 'image/jpeg', data: match[2] || '' } : { mimeType: 'image/jpeg', data: String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '') };
}
function audioFormatFromMime(mimeType = '') {
    const value = String(mimeType || '').toLowerCase();
    if (value.includes('wav')) return 'wav';
    if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
    if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) return 'mp4';
    if (value.includes('webm')) return 'webm';
    if (value.includes('ogg') || value.includes('opus')) return 'ogg';
    return 'webm';
}
function normalizeAnthropicUserContent(content) {
    if (!Array.isArray(content)) return String(content || '');
    const parts = content.map((part) => {
        if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
        if (part.type === 'text') return { type: 'text', text: String(part.text || '') };
        if (part.type === 'tool_result') return { type: 'tool_result', tool_use_id: part.tool_use_id || part.toolUseId || 'tool', content: Array.isArray(part.content) ? part.content : (typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '')) };
        if (part.type === 'image' && part.source) return part;
        if (part.type === 'image_url' && part.image_url?.url) {
            const payload = dataUrlPayload(part.image_url.url);
            return { type: 'image', source: { type: 'base64', media_type: payload.mimeType || 'image/jpeg', data: payload.data } };
        }
        if (part.type === 'input_audio' || part.audioData || (part.inlineData && String(part.inlineData.mimeType || '').startsWith('audio/'))) return { type: 'text', text: '[用户发送了一段音频，但当前 Anthropic 接口不支持直接音频输入；请提示用户切换支持音频输入的 OpenAI Responses/Gemini 模型。]' };
        return { type: 'text', text: String(part.text || part.content || '') };
    }).filter((part) => part.type === 'image' || part.type === 'tool_result' || part.text);
    return parts.length ? parts : '';
}
function normalizeGeminiUserParts(message = {}) {
    if (Array.isArray(message.parts)) return message.parts;
    const content = message.content;
    if (!Array.isArray(content)) return [{ text: String(content || '') }];
    const parts = content.map((part) => {
        if (!part || typeof part !== 'object') return { text: String(part || '') };
        if (part.text !== undefined) return { text: String(part.text || '') };
        if (part.inlineData) return part;
        if (part.input_audio?.data) return { inlineData: { mimeType: `audio/${part.input_audio.format || 'webm'}`, data: part.input_audio.data } };
        if (part.audioData?.data) return { inlineData: { mimeType: part.audioData.mimeType || 'audio/webm', data: part.audioData.data } };
        if (part.type === 'image_url' && part.image_url?.url) {
            const payload = dataUrlPayload(part.image_url.url);
            return { inlineData: { mimeType: payload.mimeType || 'image/jpeg', data: payload.data } };
        }
        return { text: String(part.content || '') };
    }).filter((part) => part.inlineData || part.text);
    return parts.length ? parts : [{ text: '' }];
}
function normalizeResponsesContent(content) {
    if (!Array.isArray(content)) return String(content || '');
    return content.map((part) => {
        if (!part || typeof part !== 'object') return { type: 'input_text', text: String(part || '') };
        if (part.type === 'text') return { type: 'input_text', text: String(part.text || '') };
        if (part.type === 'input_text' || part.type === 'input_image' || part.type === 'input_audio') return part;
        if (part.type === 'image_url' && part.image_url?.url) return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
        if (part.input_audio?.data) return { type: 'input_audio', input_audio: { data: part.input_audio.data, format: part.input_audio.format || 'webm' } };
        if (part.audioData?.data) return { type: 'input_audio', input_audio: { data: part.audioData.data, format: audioFormatFromMime(part.audioData.mimeType) } };
        if (part.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('audio/')) return { type: 'input_audio', input_audio: { data: part.inlineData.data, format: audioFormatFromMime(part.inlineData.mimeType) } };
        return { type: 'input_text', text: String(part.text || part.content || '') };
    }).filter((part) => part.image_url || part.text || part.input_audio?.data);
}
function openAiScreenshotParts(screenshots = []) {
    const parts = [{ type: 'text', text: '下面是 remote_desktop_screenshot 工具返回的远程桌面截图。请直接观察图片内容，不要只根据 JSON 元数据回答。' }];
    for (const shot of screenshots.slice(0, 3)) parts.push({ type: 'image_url', image_url: { url: shot.dataUrl, detail: 'auto' } });
    return parts;
}
function anthropicScreenshotParts(screenshots = []) {
    const parts = [{ type: 'text', text: '下面是 remote_desktop_screenshot 工具返回的远程桌面截图。请直接观察图片内容，不要只根据 JSON 元数据回答。' }];
    for (const shot of screenshots.slice(0, 3)) {
        const payload = dataUrlPayload(shot.dataUrl);
        if (payload.data) parts.push({ type: 'image', source: { type: 'base64', media_type: payload.mimeType || 'image/jpeg', data: payload.data } });
    }
    return parts;
}
function geminiScreenshotParts(screenshots = []) {
    const parts = [{ text: '下面是 remote_desktop_screenshot 工具返回的远程桌面截图。请直接观察图片内容，不要只根据 JSON 元数据回答。' }];
    for (const shot of screenshots.slice(0, 3)) {
        const payload = dataUrlPayload(shot.dataUrl);
        if (payload.data) parts.push({ inlineData: { mimeType: payload.mimeType || 'image/jpeg', data: payload.data } });
    }
    return parts;
}
function parseExtraObject(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    const parsed = safeJsonParse(value, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}
function normalizeOptions(provider = {}, requestOptions = {}, mode = 'chat') {
    const raw = { ...(provider.options || {}), ...(requestOptions || {}) };
    const extra = parseExtraObject(raw.extraJson);
    const out = {};
    const numberFields = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'];
    numberFields.forEach((field) => {
        if (raw[field] === '' || raw[field] === undefined || raw[field] === null) return;
        const n = Number(raw[field]);
        // -1 means: do not send this parameter. Some models reject temperature/top_p.
        if (Number.isFinite(n) && n >= 0) out[field] = n;
    });
    if (raw.max_tokens !== '' && raw.max_tokens !== undefined && raw.max_tokens !== null) out.max_tokens = Math.max(1, Number(raw.max_tokens) || 4096);
    if (raw.max_output_tokens !== '' && raw.max_output_tokens !== undefined && raw.max_output_tokens !== null) out.max_output_tokens = Math.max(1, Number(raw.max_output_tokens) || 4096);
    if (raw.reasoning_effort) out.reasoning_effort = String(raw.reasoning_effort);
    if (raw.use_previous_response_id || raw.usePreviousResponseId) out.use_previous_response_id = true;
    if (raw.reasoning && typeof raw.reasoning === 'object') out.reasoning = raw.reasoning;
    if (raw.text && typeof raw.text === 'object') out.text = raw.text;
    if (raw.response_format) {
        const rf = parseExtraObject(raw.response_format);
        out.response_format = Object.keys(rf).length ? rf : { type: String(raw.response_format) };
    }
    const merged = { ...out, ...extra };
    const apiMode = String(mode || 'chat').toLowerCase();
    ['context', 'windowTokens', 'maxInputChars', 'keepMessages', 'toolResultChars', 'memoryItems', 'timeoutMs', 'timeout_ms', 'retries', 'retryCount'].forEach((key) => delete merged[key]);
    if (apiMode === 'responses') {
        if (merged.max_tokens && !merged.max_output_tokens) merged.max_output_tokens = merged.max_tokens;
        delete merged.max_tokens;
        if (merged.reasoning_effort && !merged.reasoning) merged.reasoning = { effort: merged.reasoning_effort };
        delete merged.reasoning_effort;
        delete merged.response_format;
    } else if (apiMode === 'anthropic' || apiMode === 'gemini') {
        if (merged.max_output_tokens && !merged.max_tokens) merged.max_tokens = merged.max_output_tokens;
        delete merged.max_output_tokens;
        delete merged.text;
        delete merged.response_format;
        delete merged.use_previous_response_id;
    } else {
        if (merged.max_output_tokens && !merged.max_tokens) merged.max_tokens = merged.max_output_tokens;
        delete merged.max_output_tokens;
        delete merged.text;
        delete merged.reasoning;
        delete merged.thinking;
        delete merged.output_config;
        delete merged.thinkingConfig;
        delete merged.thinking_config;
        delete merged.use_previous_response_id;
    }
    return merged;
}
function aiModelNames(provider = {}) {
    return String(provider.models || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}
function openAiApiMode(provider = {}) {
    const mode = String(provider.apiMode || provider.api || provider.endpointMode || 'auto').toLowerCase();
    const base = String(provider.baseUrl || '').toLowerCase();
    if (mode === 'responses' || /\/responses\/?$/.test(base)) return 'responses';
    if (mode === 'chat' || /\/chat\/completions\/?$/.test(base)) return 'chat';
    return 'chat';
}
function joinApiUrl(base, suffix) {
    const raw = String(base || '').trim().replace(/\/+$/, '');
    if (!raw) return suffix;
    if (/\/chat\/completions$/i.test(raw) || /\/responses$/i.test(raw) || /\/messages$/i.test(raw) || /:generateContent$/i.test(raw)) return raw;
    return `${raw}${suffix}`;
}
function providerType(provider = {}) {
    const raw = String(provider.type || '').toLowerCase();
    const base = String(provider.baseUrl || '').toLowerCase();
    if (['anthropic', 'claude'].includes(raw) || base.includes('anthropic.com')) return 'anthropic';
    if (['gemini', 'google', 'google-gemini'].includes(raw) || base.includes('generativelanguage.googleapis.com')) return 'gemini';
    if (['openai', 'openai-compatible'].includes(raw)) return raw;
    return raw || 'openai-compatible';
}
function providerSupportsTools(provider = {}) { return ['openai-compatible', 'openai', 'anthropic', 'gemini'].includes(providerType(provider)); }
function selectProvider(ai = {}, body = {}) {
    const providers = Array.isArray(ai.providers) ? ai.providers.filter((p) => p && p.enabled !== false) : [];
    if (!providers.length) throw new Error('AI 助理尚未配置可用模型供应商');
    const id = String(body.providerId || ai.defaultProviderId || '').trim();
    const provider = providers.find((p) => p.id === id) || providers[0];
    const models = aiModelNames(provider);
    const model = String(body.model || provider.defaultModel || ai.defaultModel || models[0] || '').trim();
    provider._selectedModel = model;
    if (!model) throw new Error('请选择模型；可在供应商设置中点击“获取模型”自动填充');
    return { provider, model };
}
function providerHeaders(provider = {}, contentType = 'application/json') {
    const type = providerType(provider);
    const extraHeaders = parseExtraObject(provider.extraHeaders || provider.headers);
    const headers = { 'Content-Type': contentType, ...extraHeaders };
    if (type === 'anthropic') {
        if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = provider.anthropicVersion || '2023-06-01';
    } else if (type !== 'gemini' && provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    if (provider.organization) {
        if (/^proj[_-]/i.test(String(provider.organization))) headers['OpenAI-Project'] = provider.organization;
        else headers['OpenAI-Organization'] = provider.organization;
    }
    return headers;
}
async function listProviderModels(provider = {}) {
    const type = providerType(provider);
    if (type === 'anthropic') {
        if (!provider.baseUrl && provider.apiKey) {
            try {
                const data = await fetchJson('https://api.anthropic.com/v1/models', { method: 'GET', headers: providerHeaders(provider), timeoutMs: 30000, label: `${provider.name || provider.type || 'Anthropic'}/models` });
                return (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id })).filter((m) => m.id);
            } catch (_) {}
        }
        return ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5'].map((id) => ({ id }));
    }
    if (type === 'gemini') {
        const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        const keyParam = provider.apiKey ? `?key=${encodeURIComponent(provider.apiKey)}` : '';
        const data = await fetchJson(`${base}/models${keyParam}`, { method: 'GET', headers: providerHeaders({ ...provider, apiKey: '' }), timeoutMs: 30000, label: `${provider.name || provider.type || 'Gemini'}/models` });
        return (data.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || m.name })).filter((m) => m.id && /generateContent/.test((m.supportedGenerationMethods || []).join(' ')));
    }
    const base = provider.baseUrl || 'https://api.openai.com/v1';
    const url = joinApiUrl(base.replace(/\/(chat\/completions|responses)$/i, ''), '/models');
    const data = await fetchJson(url, { method: 'GET', headers: providerHeaders(provider), timeoutMs: 30000, label: `${provider.name || provider.type || 'OpenAI'}/models` });
    return (data.data || data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id })).filter((m) => m.id);
}
async function fetchJson(url, options = {}) {
    const { timeoutMs = 0, label = 'AI provider', ...fetchOptions } = options || {};
    const parentSignal = fetchOptions.signal || null;
    const controller = timeoutMs ? new AbortController() : null;
    let timer = null;
    let abortListener = null;
    if (controller) {
        fetchOptions.signal = controller.signal;
        timer = setTimeout(() => {
            try { controller.abort(new DOMException('AI provider request timeout', 'TimeoutError')); } catch { controller.abort(); }
        }, Math.max(1000, Number(timeoutMs) || 0));
        if (parentSignal) {
            abortListener = () => {
                try { controller.abort(parentSignal.reason || aiAbortError()); } catch { controller.abort(); }
            };
            if (parentSignal.aborted) abortListener();
            else parentSignal.addEventListener?.('abort', abortListener, { once: true });
        }
    }
    try {
        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        const data = safeJsonParse(text, null);
        if (!res.ok) {
            const message = data?.error?.message || data?.message || text.slice(0, 500) || `HTTP ${res.status}`;
            throw new Error(message);
        }
        return data ?? {};
    } catch (err) {
        if (parentSignal?.aborted) throw aiAbortError();
        if (controller?.signal?.aborted && timer) {
            const timeoutErr = new Error(`${label} 请求超时`);
            timeoutErr.name = 'TimeoutError';
            timeoutErr.cause = err;
            throw timeoutErr;
        }
        throw new Error(aiFetchErrorMessage(err, label), { cause: err });
    } finally {
        if (timer) clearTimeout(timer);
        if (parentSignal && abortListener) parentSignal.removeEventListener?.('abort', abortListener);
    }
}
function mergeZephyrDefaultSkills(skills = []) {
    const list = Array.isArray(skills) ? skills.slice() : [];
    DEFAULT_ZEPHYR_SKILLS.forEach((skill) => {
        const exists = list.some((item) => item?.id === skill.id || item?.name === skill.name);
        if (!exists) list.unshift({ ...skill, updatedAt: Date.now() });
    });
    return list;
}
function buildSystemPrompt(ai = {}, context = {}, limits = {}) {
    const enabledSkills = mergeZephyrDefaultSkills(ai.skills).filter((s) => s?.enabled !== false && (s.prompt || s.description || s.name));
    const skillsText = enabledSkills.length
        ? `\n\n已启用 Skills：\n${enabledSkills.map((s, i) => `# Skill ${i + 1}: ${s.name || '未命名'}\n${s.description ? `说明：${s.description}\n` : ''}${s.prompt || ''}`).join('\n\n')}`
        : '';
    const relatedMemories = ai.memory?.enabled !== false ? selectPromptMemories(ai, context, clampNumber(limits.memoryItems, 0, 80, 28)) : [];
    const memoryText = relatedMemories.length
        ? `\n\n长期 Memory / 项目记忆（已按当前连接、项目、标签自动关联；按需参考，不要泄露敏感信息）：\n${relatedMemories.map((m) => `- ${memoryLabel(m)}: ${m.content || ''}`).join('\n')}`
        : '';
    const contextText = formatAiContextForPrompt(context);
    const envItems = Array.isArray(ai.envVars) ? ai.envVars.filter((e) => e?.enabled !== false && e.name && e.visibleToAi === true) : [];
    const envText = envItems.length ? `\n\n可用 AI 环境变量（仅列出允许暴露给 AI 的条目）：\n${envItems.map((e) => {
        const desc = e.description ? ` — ${e.description}` : '';
        const val = e.valueVisibleToAi && e.value ? ` = ${String(e.value).slice(0, 4000)}` : '（值需通过 get_env_var 并经敏感确认读取）';
        return `- ${e.name}${desc}${val}`;
    }).join('\n')}` : '';
    const defaultPrompt = String(ai.defaultSystemPrompt || DEFAULT_ZEPHYR_SYSTEM_PROMPT || '').trim();
    const customPrompt = String(ai.systemPrompt || '').trim();
    return [
        `你是 ${ai.assistantName || 'Zephyr AI 助理'}，运行在 Zephyr SSH 管理平台内。`,
        defaultPrompt,
        `当前时间：${new Date().toISOString()}`,
        contextText,
        customPrompt ? `\n用户自定义系统提示：\n${customPrompt}` : '',
        skillsText,
        memoryText,
        envText,
    ].filter(Boolean).join('\n');
}
function toolDefinitions(ai = {}) {
    const p = ai.permissions || {};
    const tools = [];
    tools.push({ type: 'function', function: { name: 'list_connections', description: '列出 Zephyr 中可用的 SSH/RDP/VNC 连接（不含密码/私钥）；只有 SSH 支持远程命令和文件工具。', parameters: { type: 'object', properties: {}, additionalProperties: false } } });
    tools.push({ type: 'function', function: { name: 'list_zephyr_resources', description: '列出 Zephyr 本地资源：连接、代理、SSH 密钥库、跳板机、代码片段。只返回脱敏信息。', parameters: { type: 'object', properties: { resources: { type: 'array', items: { type: 'string', enum: ['connections', 'proxies', 'sshKeys', 'jumpHosts', 'snippets'] } } } } } });
    tools.push({ type: 'function', function: { name: 'connection_create', description: '新增 SSH/RDP/VNC 连接资产。可填写密码/私钥/标签/代理/跳板链；属于修改本地资源的敏感操作，需要确认。', parameters: { type: 'object', properties: { name: { type: 'string' }, protocol: { type: 'string', enum: ['SSH', 'RDP', 'VNC'] }, host: { type: 'string' }, port: { type: 'number' }, username: { type: 'string' }, password: { type: 'string' }, privateKey: { type: 'string' }, sshKeyId: { type: 'string' }, remark: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, connectionMode: { type: 'string', enum: ['direct', 'proxy', 'jump'] }, proxyId: { type: 'string' }, jumpHostId: { type: 'string' }, jumpHostIds: { type: 'array', items: { type: 'string' } } }, required: ['name', 'protocol', 'host'] } } });
    tools.push({ type: 'function', function: { name: 'connection_update', description: '修改已有 SSH/RDP/VNC 连接资产。未传字段保持不变；密码/私钥传 ****** 或不传表示不修改。敏感操作，需要确认。', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, name: { type: 'string' }, protocol: { type: 'string', enum: ['SSH', 'RDP', 'VNC'] }, host: { type: 'string' }, port: { type: 'number' }, username: { type: 'string' }, password: { type: 'string' }, privateKey: { type: 'string' }, sshKeyId: { type: 'string' }, remark: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, connectionMode: { type: 'string', enum: ['direct', 'proxy', 'jump'] }, proxyId: { type: 'string' }, jumpHostId: { type: 'string' }, jumpHostIds: { type: 'array', items: { type: 'string' } } }, required: ['connectionId'] } } });
    tools.push({ type: 'function', function: { name: 'connection_delete', description: '删除连接资产。敏感操作，需要确认。', parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] } } });
    tools.push({ type: 'function', function: { name: 'connection_test', description: '测试 SSH/RDP/VNC 连接连通性。可用现有 connectionId，也可临时传入连接字段进行测试。', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, name: { type: 'string' }, protocol: { type: 'string', enum: ['SSH', 'RDP', 'VNC'] }, host: { type: 'string' }, port: { type: 'number' }, username: { type: 'string' }, password: { type: 'string' }, privateKey: { type: 'string' }, sshKeyId: { type: 'string' }, connectionMode: { type: 'string', enum: ['direct', 'proxy', 'jump'] }, proxyId: { type: 'string' }, jumpHostId: { type: 'string' }, jumpHostIds: { type: 'array', items: { type: 'string' } }, timeoutSeconds: { type: 'number' } } } } });
    tools.push({ type: 'function', function: { name: 'proxy_save', description: '新增或修改代理池条目。传 proxyId 为修改，不传为新增。敏感操作，需要确认。', parameters: { type: 'object', properties: { proxyId: { type: 'string' }, name: { type: 'string' }, host: { type: 'string' }, port: { type: 'number' }, type: { type: 'string', enum: ['socks5', 'http'] }, username: { type: 'string' }, password: { type: 'string' } }, required: ['name', 'host', 'port'] } } });
    tools.push({ type: 'function', function: { name: 'proxy_delete', description: '删除代理池条目。敏感操作，需要确认。', parameters: { type: 'object', properties: { proxyId: { type: 'string' } }, required: ['proxyId'] } } });
    tools.push({ type: 'function', function: { name: 'ssh_key_save', description: '新增或修改 SSH 密钥库条目。传 sshKeyId 为修改，不传为新增。私钥/口令属于敏感信息，需要确认。', parameters: { type: 'object', properties: { sshKeyId: { type: 'string' }, name: { type: 'string' }, privateKey: { type: 'string' }, passphrase: { type: 'string' }, remark: { type: 'string' } }, required: ['name'] } } });
    tools.push({ type: 'function', function: { name: 'ssh_key_delete', description: '删除 SSH 密钥库条目。敏感操作，需要确认。', parameters: { type: 'object', properties: { sshKeyId: { type: 'string' } }, required: ['sshKeyId'] } } });
    tools.push({ type: 'function', function: { name: 'jump_host_save', description: '新增或修改跳板机配置。传 jumpHostId 为修改，不传为新增；connectionId 必须指向 SSH 连接。敏感操作，需要确认。', parameters: { type: 'object', properties: { jumpHostId: { type: 'string' }, name: { type: 'string' }, connectionId: { type: 'string' } }, required: ['name', 'connectionId'] } } });
    tools.push({ type: 'function', function: { name: 'jump_host_delete', description: '删除跳板机配置。敏感操作，需要确认。', parameters: { type: 'object', properties: { jumpHostId: { type: 'string' } }, required: ['jumpHostId'] } } });
    tools.push({ type: 'function', function: { name: 'snippet_save', description: '新增或修改代码片段。传 snippetId 为修改，不传为新增。', parameters: { type: 'object', properties: { snippetId: { type: 'string' }, name: { type: 'string' }, command: { type: 'string' }, group: { type: 'string' }, autoRun: { type: 'boolean' } }, required: ['name', 'command'] } } });
    tools.push({ type: 'function', function: { name: 'snippet_delete', description: '删除代码片段。', parameters: { type: 'object', properties: { snippetId: { type: 'string' } }, required: ['snippetId'] } } });
    tools.push({ type: 'function', function: { name: 'terminal_read_output', description: '读取用户当前 Zephyr SSH 终端输出快照（屏幕/scrollback 文本、当前输入框内容、连接信息）。当用户问“终端里显示什么/刚才命令输出/当前屏幕结果”时优先调用。', parameters: { type: 'object', properties: { tabId: { type: 'string' }, maxChars: { type: 'number' }, allVisible: { type: 'boolean' } } } } });
    tools.push({ type: 'function', function: { name: 'remote_desktop_screenshot', description: '实时读取用户当前 Zephyr RDP/VNC 远程桌面最新画面快照（JPEG 截图）。RDP/VNC 没有文本终端输出；当你需要确认刚才操作是否生效、页面是否加载完成、当前画面是什么时调用本工具。策略：先使用 ui_action 返回的 remoteDesktopScreenshot；若状态仍不确定，等待约 2 秒后再截图；允许必要的多次截图，但不要连续秒截或为了找按钮反复截图。', parameters: { type: 'object', properties: { tabId: { type: 'string' }, maxWidth: { type: 'number' } } } } });
    tools.push({ type: 'function', function: { name: 'ui_action', description: '在用户当前 Zephyr 页面执行可见 UI 代操作：切换视图、打开新增/编辑连接弹窗、打开/全屏/排列终端、点击 SSH 终端工具栏、以及点击/调整 RDP/VNC 远程桌面工具栏（画质、视图/适应、缩放、剪贴板、键盘、快捷键、视区/拖拽、Ctrl+Alt+Del、重连、断开、发送快捷键/文本）。RDP/VNC 动作执行后通常会返回 remoteDesktopScreenshot，可直接依据该截图继续，不要重复截图。打开远程网页优先 shortcut:win 或 ctrl-l + remote_desktop_send_text 粘贴 URL。terminal_send_input 且 run=true 会像用户按发送一样执行命令，需要确认；run=false 只填入输入框。不要用于安全/数据管理设置页。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['switch_view', 'open_add_connection', 'open_edit_connection', 'terminal_fullscreen', 'terminal_exit_fullscreen', 'terminal_window_action', 'terminal_toolbar', 'terminal_send_input', 'remote_desktop_toolbar', 'remote_desktop_send_text', 'remote_desktop_mouse', 'toast'] }, view: { type: 'string', enum: ['dashboard', 'terminal', 'remote', 'settings'] }, settingsSection: { type: 'string', enum: ['ai', 'appearance', 'terminal', 'network', 'profile', 'snippets'] }, connectionId: { type: 'string' }, tabId: { type: 'string' }, windowAction: { type: 'string', enum: ['fullscreen', 'exit-fullscreen', 'left-half', 'right-half', 'right-top', 'right-bottom', 'left-two-thirds', 'right-two-thirds', 'minimize', 'close', 'reconnect-mobile'] }, control: { type: 'string', enum: ['file', 'info', 'docker', 'snippet', 'shortcut', 'copy', 'paste', 'theme', 'wterm-theme', 'reconnect', 'disconnect', 'quality', 'fit', 'zoom', 'clipboard', 'keyboard', 'shortcuts', 'joystick', 'drag', 'ctrl_alt_del', 'clipboard_send', 'clipboard_read_local', 'clipboard_copy_remote'] }, desktopControl: { type: 'string', enum: ['quality', 'fit', 'zoom', 'clipboard', 'keyboard', 'shortcuts', 'joystick', 'drag', 'ctrl_alt_del', 'reconnect', 'disconnect', 'clipboard_send', 'clipboard_read_local', 'clipboard_copy_remote', 'shortcut', 'text', 'mouse_click'] }, text: { type: 'string' }, run: { type: 'boolean' }, maxChars: { type: 'number' }, maxWidth: { type: 'number' }, qualityMode: { type: 'string', enum: ['balanced', 'performance', 'quality'] }, fitMode: { type: 'string', enum: ['fit', '1:1', '16:9', '4:3', 'original', 'drag'] }, zoomPercent: { type: 'number' }, sequence: { type: 'string' }, paste: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'number' }, coordinateSpace: { type: 'string', enum: ['remote', 'screenshot'] } }, required: ['action'] } } });
    if (p.webSearch !== false) tools.push({ type: 'function', function: { name: 'web_search', description: '在网页上搜索实时信息，返回标题、链接和摘要。', parameters: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] } } });
    if (p.webFetch !== false) tools.push({ type: 'function', function: { name: 'fetch_url', description: '读取一个网页 URL 的正文文本。', parameters: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'number' } }, required: ['url'] } } });
    if (p.browser !== false) {
        tools.push({ type: 'function', function: { name: 'browser_navigate', description: '用内置 Chromium 打开 URL，并在 AI 浮窗里显示页面预览，像用户打开网页一样继续代操作。浏览器会话默认按当前 AI 对话隔离；通常不要填写 session，除非要在本对话内开多个网页上下文。', parameters: { type: 'object', properties: { url: { type: 'string' }, session: { type: 'string' }, waitMs: { type: 'number' } }, required: ['url'] } } });
        tools.push({ type: 'function', function: { name: 'browser_inspect', description: '列出当前页面可见的按钮、链接、输入框等可交互元素及 selector/坐标。点击或输入前优先调用它，避免盲点。会话默认按当前 AI 对话隔离，通常不要填写 session。', parameters: { type: 'object', properties: { session: { type: 'string' }, max: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_screenshot', description: '截取内置 Chromium 当前页面截图。', parameters: { type: 'object', properties: { session: { type: 'string' }, fullPage: { type: 'boolean' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_click', description: '点击当前页面中的 CSS 选择器或坐标。', parameters: { type: 'object', properties: { session: { type: 'string' }, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_type', description: '向当前页面表单元素输入文本。', parameters: { type: 'object', properties: { session: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' } }, required: ['selector', 'text'] } } });
        tools.push({ type: 'function', function: { name: 'browser_scroll', description: '滚动当前页面。', parameters: { type: 'object', properties: { session: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_text', description: '读取当前浏览器页面可见/正文文本。', parameters: { type: 'object', properties: { session: { type: 'string' }, maxChars: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_key', description: '向当前页面发送键盘按键（Enter/Tab/Escape/方向键等），用于像用户一样操作页面。', parameters: { type: 'object', properties: { session: { type: 'string' }, key: { type: 'string' } }, required: ['key'] } } });
        tools.push({ type: 'function', function: { name: 'browser_wait', description: '等待页面加载或交互完成，然后返回页面状态和截图预览。', parameters: { type: 'object', properties: { session: { type: 'string' }, ms: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'browser_close', description: '关闭当前 AI 对话对应的内置浏览器页面。通常由前端关闭/删除对话时自动调用。', parameters: { type: 'object', properties: { session: { type: 'string' } } } } });
    }
    if (p.memory !== false) {
        tools.push({ type: 'function', function: { name: 'memory_search', description: '搜索长期 Memory / 项目记忆；会结合当前连接、项目、标签进行自动关联排序。', parameters: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' }, project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, connectionIds: { type: 'array', items: { type: 'string' } }, maxResults: { type: 'number' } } } } });
        tools.push({ type: 'function', function: { name: 'memory_save', description: '保存长期 Memory 或项目记忆；优先填写 connectionIds/project/projects/tags 以便自动关联。', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, scope: { type: 'string' }, project: { type: 'string' }, projects: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, connectionIds: { type: 'array', items: { type: 'string' } } }, required: ['content'] } } });
    }
    if (p.env !== false) {
        tools.push({ type: 'function', function: { name: 'list_env_vars', description: '列出 AI 专用环境变量名称和说明，不返回值。', parameters: { type: 'object', properties: {} } } });
        tools.push({ type: 'function', function: { name: 'get_env_var', description: '读取 AI 专用环境变量的值。敏感操作，需要用户确认。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } });
    }
    tools.push({ type: 'function', function: { name: 'open_connection', description: '在用户当前 Zephyr 页面里直接打开一个已存在的 SSH/RDP/VNC 连接，相当于用户点击连接卡片。必须传 connectionId；如果用户给的是连接名称（如 hytron），先用 list_connections 获取并匹配 id。不要用 connection_create / connection_update 来打开已有连接。', parameters: { type: 'object', properties: { connectionId: { type: 'string', description: '已有连接的 id，不是名称；名称需先 list_connections 匹配。' } }, required: ['connectionId'] } } });
    tools.push({ type: 'function', function: { name: 'plan_task', description: '创建执行计划，返回 planId；后续用 plan_update 更新步骤状态。', parameters: { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, risk: { type: 'string' } }, required: ['title', 'steps'] } } });
    tools.push({ type: 'function', function: { name: 'plan_update', description: '更新任务计划：步骤状态、暂停/继续、失败重试、追加日志。', parameters: { type: 'object', properties: { planId: { type: 'string' }, status: { type: 'string', enum: ['planned', 'running', 'paused', 'completed', 'failed', 'cancelled'] }, pause: { type: 'boolean' }, resume: { type: 'boolean' }, retryFailed: { type: 'boolean' }, note: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, index: { type: 'number' }, status: { type: 'string', enum: ['pending', 'running', 'paused', 'completed', 'failed', 'skipped', 'retrying'] }, note: { type: 'string' }, error: { type: 'string' } } } } }, required: ['planId'] } } });
    tools.push({ type: 'function', function: { name: 'plan_delete', description: '删除一个任务计划。', parameters: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'] } } });
    if (p.remoteExecute !== false) tools.push({ type: 'function', function: { name: 'remote_execute', description: '在一个或多个 SSH 连接上执行 shell 命令。敏感操作需要用户确认。', parameters: { type: 'object', properties: { connectionIds: { type: 'array', items: { type: 'string' } }, command: { type: 'string' }, timeoutSeconds: { type: 'number' } }, required: ['connectionIds', 'command'] } } });
    if (p.fileRead !== false) tools.push({ type: 'function', function: { name: 'remote_read_file', description: '读取远程 SSH 主机上的文本文件。', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, path: { type: 'string' }, maxBytes: { type: 'number' } }, required: ['connectionId', 'path'] } } });
    if (p.fileWrite !== false) tools.push({ type: 'function', function: { name: 'remote_write_file', description: '写入或追加远程 SSH 主机文件。敏感操作需要用户确认。', parameters: { type: 'object', properties: { connectionId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, append: { type: 'boolean' } }, required: ['connectionId', 'path', 'content'] } } });
    return tools;
}
function convertMessagesForProvider(messages = [], systemPrompt = '', limits = {}) {
    const compacted = compactConversationHistory(messages, limits);
    const prompt = compacted.summary ? `${systemPrompt}\n\n${compacted.summary}` : systemPrompt;
    const out = [{ role: 'system', content: prompt }, ...compacted.messages];
    out._contextStats = { originalMessages: compacted.originalCount, compactedMessages: compacted.compactedCount, inputCharsBeforeCompact: compacted.totalChars, promptChars: prompt.length };
    return out;
}
function normalizeOpenAiMessage(message = {}) {
    return {
        role: message.role || 'assistant',
        content: typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((p) => p?.text || '').join('\n') : '',
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
}
function openAiChatMessages(messages = []) {
    return messages.map((m) => {
        const role = normalizeRole(m.role);
        const content = Array.isArray(m.content)
            ? m.content.map((part) => {
                if (part?.type === 'text') return { type: 'text', text: String(part.text || '') };
                if (part?.type === 'image_url') return { type: 'image_url', image_url: part.image_url || {} };
                if (part?.type === 'input_audio' && part.input_audio?.data) return { type: 'input_audio', input_audio: { data: part.input_audio.data, format: part.input_audio.format || 'webm' } };
                if (part?.inlineData) return String(part.inlineData.mimeType || '').startsWith('audio/') ? { type: 'input_audio', input_audio: { data: part.inlineData.data || '', format: audioFormatFromMime(part.inlineData.mimeType) } } : { type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data || ''}`, detail: 'auto' } };
                if (part?.audioData?.data) return { type: 'input_audio', input_audio: { data: part.audioData.data, format: audioFormatFromMime(part.audioData.mimeType) } };
                return { type: 'text', text: String(part?.text || part?.content || '') };
            }).filter((part) => part.text || part.image_url?.url || part.input_audio?.data)
            : String(m.content || '');
        const out = { role, content };
        if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
        if (role === 'tool') out.tool_call_id = m.tool_call_id || m.name || 'tool';
        return out;
    });
}
function closeJsonSchema(schema = {}) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map((item) => closeJsonSchema(item));
    const out = { ...schema };
    if (out.properties && typeof out.properties === 'object') out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, closeJsonSchema(v)]));
    if (out.items) out.items = closeJsonSchema(out.items);
    if (out.anyOf) out.anyOf = out.anyOf.map((item) => closeJsonSchema(item));
    if (out.oneOf) out.oneOf = out.oneOf.map((item) => closeJsonSchema(item));
    if ((out.type === 'object' || out.properties) && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
}
function openAiChatTools(tools = []) {
    if (AI_OPENAI_TOOL_CACHE.has(tools)) return AI_OPENAI_TOOL_CACHE.get(tools);
    const converted = tools.map((tool) => ({
        ...tool,
        function: {
            ...(tool.function || {}),
            parameters: closeJsonSchema(tool.function?.parameters || { type: 'object', properties: {} }),
        },
    })).filter((tool) => tool.function?.name);
    AI_OPENAI_TOOL_CACHE.set(tools, converted);
    return converted;
}
function anthropicSchema(schema = {}) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map((item) => anthropicSchema(item));
    const out = { ...schema };
    if (out.properties && typeof out.properties === 'object') out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, anthropicSchema(v)]));
    if (out.items) out.items = anthropicSchema(out.items);
    if (out.anyOf) out.anyOf = out.anyOf.map((item) => anthropicSchema(item));
    if (out.oneOf) out.oneOf = out.oneOf.map((item) => anthropicSchema(item));
    if ((out.type === 'object' || out.properties) && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
}
function toAnthropicTools(tools = []) {
    if (AI_ANTHROPIC_TOOL_CACHE.has(tools)) return AI_ANTHROPIC_TOOL_CACHE.get(tools);
    const converted = tools.map((tool) => ({
        name: tool.function?.name,
        description: tool.function?.description || '',
        input_schema: anthropicSchema(tool.function?.parameters || { type: 'object', properties: {} }),
        strict: true,
    })).filter((tool) => tool.name);
    AI_ANTHROPIC_TOOL_CACHE.set(tools, converted);
    return converted;
}
function anthropicEffort(value = '') {
    const v = String(value || '').toLowerCase();
    if (['low', 'medium', 'high', 'xhigh'].includes(v)) return v;
    if (v === 'max') return 'xhigh';
    if (v === 'minimal') return 'low';
    return '';
}
function anthropicAdaptiveThinkingModel(model = '') {
    const name = String(model || '').toLowerCase();
    return /claude-(fable|mythos)-5|claude-opus-4-(7|8)|claude-(opus|sonnet)-4-6/.test(name);
}
function anthropicBudgetForEffort(effort = '', maxTokens = 4096) {
    const v = String(effort || '').toLowerCase();
    if (!v || v === 'none') return 0;
    const target = v === 'minimal' || v === 'low' ? 1024 : v === 'medium' ? 2048 : v === 'xhigh' ? 16000 : 8192;
    const limit = Math.max(0, Number(maxTokens) - 1024);
    return limit >= 1024 ? Math.max(1024, Math.min(target, limit)) : 0;
}
function anthropicThinkingForModel(model = '', opts = {}, maxTokens = 4096) {
    if (opts.thinking && typeof opts.thinking === 'object') return opts.thinking;
    const effort = anthropicEffort(opts.reasoning_effort || opts.effort || opts.output_config?.effort);
    if (!effort) return null;
    if (anthropicAdaptiveThinkingModel(model)) return { type: 'adaptive', display: opts.thinking_display || 'omitted' };
    const budget = Math.max(
        Number(opts.thinking_budget_tokens || opts.budget_tokens) || 0,
        anthropicBudgetForEffort(effort, maxTokens),
    );
    return budget ? { type: 'enabled', budget_tokens: budget } : null;
}
function anthropicMessages(messages = []) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            if (Array.isArray(m.content)) out.push({ role: 'user', content: normalizeAnthropicUserContent(m.content) });
            else out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || m.name || 'tool', content: String(m.content || '') }] });
        } else if (m.role === 'assistant') {
            if (Array.isArray(m.parts) && m.parts.length) {
                out.push({ role: 'assistant', content: m.parts });
                continue;
            }
            const content = [];
            if (m.content) content.push({ type: 'text', text: String(m.content) });
            (m.tool_calls || []).forEach((call) => {
                const parsed = parseToolCall(call);
                if (parsed.name) content.push({ type: 'tool_use', id: parsed.id, name: parsed.name, input: parsed.args || {} });
            });
            out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
        } else {
            out.push({ role: 'user', content: normalizeAnthropicUserContent(m.content) });
        }
    }
    return out;
}
function geminiSchema(schema = {}) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map((item) => geminiSchema(item));
    const out = { ...schema };
    const convertType = (value) => {
        const map = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
        return map[String(value || '').toLowerCase()] || String(value || '').toUpperCase();
    };
    if (Array.isArray(out.type)) {
        const withoutNull = out.type.filter((t) => String(t).toLowerCase() !== 'null');
        out.type = convertType(withoutNull[0] || 'string');
        out.nullable = true;
    } else if (typeof out.type === 'string') out.type = convertType(out.type);
    if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, geminiSchema(v)]));
    if (out.items) out.items = geminiSchema(out.items);
    if (out.anyOf) out.anyOf = out.anyOf.map((item) => geminiSchema(item));
    delete out.oneOf;
    delete out.additionalProperties;
    return out;
}
function toGeminiTools(tools = []) {
    if (AI_GEMINI_TOOL_CACHE.has(tools)) return AI_GEMINI_TOOL_CACHE.get(tools);
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function?.name,
        description: tool.function?.description || '',
        parameters: geminiSchema(tool.function?.parameters || { type: 'object', properties: {} }),
    })).filter((tool) => tool.name);
    const converted = functionDeclarations.length ? [{ functionDeclarations }] : [];
    AI_GEMINI_TOOL_CACHE.set(tools, converted);
    return converted;
}
function geminiThinkingConfig(model = '', effort = '') {
    const v = String(effort || '').toLowerCase();
    if (!v) return null;
    if (/gemini-(3|3\.)/i.test(String(model || ''))) {
        const level = v === 'minimal' || v === 'none' ? 'minimal' : (['low', 'medium', 'high'].includes(v) ? v : 'medium');
        return { thinkingLevel: level };
    }
    if (/gemini-2\.5/i.test(String(model || ''))) {
        if (v === 'none') return { thinkingBudget: 0 };
        if (v === 'minimal' || v === 'low') return { thinkingBudget: 1024 };
        if (v === 'medium') return { thinkingBudget: -1 };
        if (v === 'high' || v === 'xhigh') return { thinkingBudget: 8192 };
    }
    return null;
}
function geminiContents(messages = []) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            const response = safeJsonParse(m.content, { result: typeof m.content === 'string' ? String(m.content || '') : m.content });
            const fn = { name: m.name || 'tool', response: response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response } };
            if (m.tool_call_id) fn.id = String(m.tool_call_id);
            out.push({ role: 'user', parts: [{ functionResponse: fn }] });
            if (Array.isArray(m.parts) || Array.isArray(m.content)) out.push({ role: 'user', parts: normalizeGeminiUserParts(m) });
        } else if (m.role === 'assistant') {
            if (Array.isArray(m.parts) && m.parts.length) {
                out.push({ role: 'model', parts: m.parts });
                continue;
            }
            const parts = [];
            if (m.content) parts.push({ text: String(m.content) });
            (m.tool_calls || []).forEach((call) => {
                const parsed = parseToolCall(call);
                if (parsed.name) {
                    const fn = { name: parsed.name, args: parsed.args || {} };
                    if (parsed.id) fn.id = parsed.id;
                    parts.push({ functionCall: fn });
                }
            });
            out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
        } else {
            out.push({ role: 'user', parts: normalizeGeminiUserParts(m) });
        }
    }
    return out;
}
function responseOutputText(data = {}) {
    if (typeof data.output_text === 'string') return data.output_text;
    const chunks = [];
    (Array.isArray(data.output) ? data.output : []).forEach((item) => {
        (Array.isArray(item.content) ? item.content : []).forEach((part) => {
            if (typeof part.text === 'string') chunks.push(part.text);
            if (typeof part.output_text === 'string') chunks.push(part.output_text);
        });
    });
    return chunks.join('\n');
}
function responseToolCalls(data = {}) {
    const out = [];
    (Array.isArray(data.output) ? data.output : []).forEach((item) => {
        const name = item.name || item.function?.name;
        if (item.type === 'function_call' && name) {
            out.push({ id: item.call_id || item.id || crypto.randomUUID(), type: 'function', function: { name, arguments: item.arguments || item.function?.arguments || '{}' } });
        }
    });
    return out;
}
function toResponsesInput(messages = []) {
    const out = [];
    for (const m of messages.filter((item) => item.role !== 'system')) {
        if (m.role === 'tool') {
            const output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            out.push({ type: 'function_call_output', call_id: m.tool_call_id || m.name || 'tool', output });
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            if (m.content) out.push({ role: 'assistant', content: String(m.content || '') });
            m.tool_calls.map(parseToolCall).filter((call) => call.name).forEach((call) => out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args || {}) }));
            continue;
        }
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        out.push({ role, content: role === 'user' ? normalizeResponsesContent(m.content) : String(m.content || '') });
    }
    return out;
}
function toResponsesTools(tools = []) {
    return tools.map((tool) => ({ type: 'function', name: tool.function?.name, description: tool.function?.description || '', parameters: closeJsonSchema(tool.function?.parameters || { type: 'object', properties: {} }) })).filter((tool) => tool.name);
}
async function callOpenAiResponses(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = provider.baseUrl || 'https://api.openai.com/v1';
    const url = joinApiUrl(base, '/responses');
    const opts = normalizeOptions(provider, options, 'responses');
    const usePreviousResponseId = !!opts.use_previous_response_id;
    delete opts.use_previous_response_id;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    let previousResponseId = '';
    let startIndex = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.response_id || messages[i]?._response_id) {
            previousResponseId = messages[i].response_id || messages[i]._response_id;
            startIndex = i + 1;
            break;
        }
    }
    const inputMessages = previousResponseId && usePreviousResponseId ? messages.slice(startIndex).filter((m) => m.role === 'tool') : messages;
    const payload = { model, input: toResponsesInput(inputMessages), ...opts };
    if (previousResponseId && usePreviousResponseId) payload.previous_response_id = previousResponseId;
    if (system) payload.instructions = system;
    const responseTools = toResponsesTools(tools);
    if (responseTools.length) { payload.tools = responseTools; payload.tool_choice = 'auto'; }
    const run = async (body) => fetchJsonWithUnsupportedParamRetry(url, { method: 'POST', headers: providerHeaders(provider), signal, timeoutMs: aiProviderTimeoutMs(provider, options), retries: aiProviderRetryCount(provider, options) }, body, `${provider.name || provider.type || 'OpenAI Responses'}/${model}`);
    let data;
    try {
        data = await run(payload);
    } catch (err) {
        if (payload.previous_response_id && /previous_response_id/i.test(String(err.message || ''))) {
            const retryPayload = { ...payload, input: toResponsesInput(messages) };
            delete retryPayload.previous_response_id;
            data = await run(retryPayload);
        } else {
            throw err;
        }
    }
    return { role: 'assistant', content: responseOutputText(data), tool_calls: responseToolCalls(data), response_id: data.id || '' };
}
async function callOpenAiCompatible(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = provider.baseUrl || 'https://api.openai.com/v1';
    const url = joinApiUrl(base, '/chat/completions');
    const opts = normalizeOptions(provider, options, 'chat');
    const payload = { model, messages: openAiChatMessages(messages), stream: false, ...opts };
    if (tools.length) { payload.tools = openAiChatTools(tools); payload.tool_choice = 'auto'; }
    const data = await fetchJsonWithUnsupportedParamRetry(url, { method: 'POST', headers: providerHeaders(provider), signal, timeoutMs: aiProviderTimeoutMs(provider, options), retries: aiProviderRetryCount(provider, options) }, payload, `${provider.name || provider.type || 'OpenAI Chat'}/${model}`);
    if (openAiApiMode(provider) === 'responses' && Array.isArray(data.output)) {
        return { role: 'assistant', content: responseOutputText(data), tool_calls: responseToolCalls(data), response_id: data.id || '' };
    }
    return normalizeOpenAiMessage(data?.choices?.[0]?.message || { content: '' });
}
async function callAnthropic(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = provider.baseUrl || 'https://api.anthropic.com/v1';
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const normal = anthropicMessages(messages);
    const opts = normalizeOptions(provider, options, 'anthropic');
    const payload = { model, messages: normal.length ? normal : [{ role: 'user', content: '你好' }], max_tokens: opts.max_tokens || 4096 };
    if (system) payload.system = system;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.top_p !== undefined) payload.top_p = opts.top_p;
    const effort = anthropicEffort(opts.reasoning_effort || opts.effort || opts.output_config?.effort);
    const thinking = anthropicThinkingForModel(model, opts, payload.max_tokens);
    if (thinking) payload.thinking = thinking;
    if (effort && (thinking?.type === 'adaptive' || opts.output_config)) payload.output_config = { ...(opts.output_config || {}), effort };
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools.length) payload.tools = anthropicTools;
    const data = await fetchJsonWithUnsupportedParamRetry(joinApiUrl(base, '/messages'), { method: 'POST', headers: providerHeaders(provider), signal, timeoutMs: aiProviderTimeoutMs(provider, options), retries: aiProviderRetryCount(provider, options) }, payload, `${provider.name || provider.type || 'Anthropic'}/${model}`);
    const blocks = Array.isArray(data.content) ? data.content : [];
    const content = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
    const toolCalls = blocks.filter((b) => b.type === 'tool_use' && b.name).map((b) => ({ id: b.id || crypto.randomUUID(), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
    return { role: 'assistant', content, tool_calls: toolCalls, parts: blocks };
}
async function callGemini(provider, model, messages, options = {}, tools = [], signal = null) {
    const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const keyParam = provider.apiKey ? `?key=${encodeURIComponent(provider.apiKey)}` : '';
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = geminiContents(messages);
    const opts = normalizeOptions(provider, options, 'gemini');
    const generationConfig = { maxOutputTokens: opts.max_tokens };
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    if (opts.top_p !== undefined) generationConfig.topP = opts.top_p;
    const thinkingConfig = opts.thinkingConfig || opts.thinking_config || geminiThinkingConfig(model, opts.reasoning_effort || opts.effort);
    if (thinkingConfig && typeof thinkingConfig === 'object') generationConfig.thinkingConfig = thinkingConfig;
    Object.keys(generationConfig).forEach((k) => generationConfig[k] === undefined && delete generationConfig[k]);
    const body = { contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '你好' }] }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const geminiTools = toGeminiTools(tools);
    if (geminiTools.length) {
        body.tools = geminiTools;
        body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const modelPath = String(model || '').startsWith('models/') ? String(model) : `models/${encodeURIComponent(model)}`;
    const data = await fetchJsonWithUnsupportedParamRetry(`${base}/${modelPath}:generateContent${keyParam}`, { method: 'POST', headers: providerHeaders({ ...provider, apiKey: '' }), signal, timeoutMs: aiProviderTimeoutMs(provider, options), retries: aiProviderRetryCount(provider, options) }, body, `${provider.name || provider.type || 'Gemini'}/${model}`);
    const parts = (data.candidates || []).flatMap((c) => c.content?.parts || []);
    const content = parts.filter((p) => p.text).map((p) => p.text || '').join('\n');
    const toolCalls = parts.filter((p) => p.functionCall?.name).map((p) => ({ id: p.functionCall.id || crypto.randomUUID(), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }));
    return { role: 'assistant', content, tool_calls: toolCalls, parts };
}
async function callProvider(provider, model, messages, options = {}, tools = [], signal = null) {
    throwIfAborted(signal);
    const type = providerType(provider);
    if (type === 'anthropic') return callAnthropic(provider, model, messages, options, tools, signal);
    if (type === 'gemini') return callGemini(provider, model, messages, options, tools, signal);
    if (openAiApiMode(provider) === 'responses') return callOpenAiResponses(provider, model, messages, options, tools, signal);
    return callOpenAiCompatible(provider, model, messages, options, tools, signal);
}
async function duckDuckGoSearch(query, maxResults = 6) {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 ZephyrAI/1.0' } });
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < maxResults) {
        let link = htmlDecode(m[1]);
        try { const u = new URL(link, 'https://duckduckgo.com'); if (u.searchParams.get('uddg')) link = u.searchParams.get('uddg'); } catch {}
        out.push({ title: stripHtml(m[2]), url: link, snippet: stripHtml(m[3]) });
    }
    if (!out.length) {
        const simple = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{5,220}?)<\/a>/gi;
        while ((m = simple.exec(html)) && out.length < maxResults) {
            const title = stripHtml(m[2]);
            const link = htmlDecode(m[1]);
            if (/^https?:/i.test(link) && title) out.push({ title, url: link, snippet: '' });
        }
    }
    return out;
}
async function fetchUrlText(url, maxChars = MAX_TOOL_TEXT) {
    const parsed = new URL(String(url || ''));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https URL');
    const res = await fetch(parsed.href, { headers: { 'User-Agent': 'Mozilla/5.0 ZephyrAI/1.0' } });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    const body = /html/i.test(contentType) ? stripHtml(text) : text;
    return clipText(body, clampNumber(maxChars, 1000, 120000, MAX_TOOL_TEXT));
}
function connectionSummary(conn) {
    return { id: conn.id, name: conn.name, protocol: conn.protocol, host: conn.host, port: conn.port, username: conn.username, tags: conn.tags || [], remark: conn.remark || '', lastConnectedAt: conn.lastConnectedAt || null };
}
function getAllConnections(deps) {
    return (deps.readJSON(deps.CONNECTIONS_FILE, { connections: [] }).connections || []);
}
function findConnectionByIdOrName(deps, value = '') {
    const key = String(value || '').trim();
    if (!key) return null;
    const list = getAllConnections(deps);
    return list.find((c) => c.id === key)
        || list.find((c) => String(c.name || '').toLowerCase() === key.toLowerCase())
        || list.find((c) => String(c.host || '').toLowerCase() === key.toLowerCase())
        || null;
}
function saveConnectionsStore(deps, store) {
    if (typeof deps.writeJSON !== 'function') throw new Error('连接写入接口不可用');
    deps.writeJSON(deps.CONNECTIONS_FILE, store);
}
function publicConnectionForAi(conn = {}) {
    const clean = connectionSummary(conn);
    clean.connectionMode = conn.connectionMode || 'direct';
    clean.proxyId = conn.proxyId || '';
    clean.jumpHostId = conn.jumpHostId || '';
    clean.jumpHostIds = stringList(conn.jumpHostIds || conn.jumpHostId);
    clean.sshKeyId = conn.sshKeyId || '';
    clean.hasPassword = !!conn.password;
    clean.hasPrivateKey = !!conn.privateKey;
    return clean;
}
function defaultPortForProtocol(protocol = 'SSH') {
    const p = String(protocol || 'SSH').toUpperCase();
    if (p === 'RDP') return 3389;
    if (p === 'VNC') return 5900;
    return 22;
}
function normalizeConnectionTags(value) {
    return Array.isArray(value) ? uniqueStrings(value).slice(0, 50) : uniqueStrings(String(value || '').split(/[,，\n]+/)).slice(0, 50);
}
function normalizeJumpIds(value, fallback = '') {
    const ids = Array.isArray(value) ? value : String(value || fallback || '').split(/[,，\n]+/);
    return uniqueStrings(ids).slice(0, 12);
}
function normalizeConnectionForSave(raw = {}, old = null) {
    const create = !old;
    const protocol = String(raw.protocol ?? old?.protocol ?? 'SSH').toUpperCase();
    if (!['SSH', 'RDP', 'VNC'].includes(protocol)) throw new Error('连接协议仅支持 SSH/RDP/VNC');
    const next = create ? {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        lastConnectedAt: null,
    } : { ...old };
    next.protocol = protocol;
    next.name = String(raw.name ?? old?.name ?? '').trim().slice(0, 120);
    next.host = String(raw.host ?? old?.host ?? '').trim().slice(0, 255);
    next.port = Number(raw.port ?? old?.port) || defaultPortForProtocol(protocol);
    next.username = String(raw.username ?? old?.username ?? '').trim().slice(0, 120);
    next.remark = String(raw.remark ?? old?.remark ?? '').slice(0, 20000);
    next.tags = raw.tags !== undefined ? normalizeConnectionTags(raw.tags) : normalizeConnectionTags(old?.tags || []);
    next.sshKeyId = String(raw.sshKeyId ?? old?.sshKeyId ?? '').slice(0, 120);
    next.connectionMode = ['direct', 'proxy', 'jump'].includes(String(raw.connectionMode ?? old?.connectionMode ?? 'direct')) ? String(raw.connectionMode ?? old?.connectionMode ?? 'direct') : 'direct';
    next.proxyId = raw.proxyId !== undefined ? (raw.proxyId || null) : (old?.proxyId || null);
    const jumpHostIds = raw.jumpHostIds !== undefined || raw.jumpHostId !== undefined
        ? normalizeJumpIds(raw.jumpHostIds, raw.jumpHostId)
        : normalizeJumpIds(old?.jumpHostIds, old?.jumpHostId);
    next.jumpHostIds = jumpHostIds;
    next.jumpHostId = jumpHostIds[0] || (raw.jumpHostId ?? old?.jumpHostId ?? null) || null;
    if (create || (raw.password !== undefined && raw.password !== '******')) next.password = String(raw.password || '');
    if (create || (raw.privateKey !== undefined && raw.privateKey !== '******')) next.privateKey = String(raw.privateKey || '');
    if (!next.name || !next.host || (protocol === 'SSH' && !next.username)) throw new Error(protocol === 'SSH' ? '名称、主机、用户名不能为空' : '名称、主机不能为空');
    next.updatedAt = Date.now();
    return next;
}
function publicResourceList(deps, resources = []) {
    const wanted = new Set((resources.length ? resources : ['connections', 'proxies', 'sshKeys', 'jumpHosts', 'snippets']).map((x) => String(x || '').toLowerCase()));
    const out = {};
    if (wanted.has('connections')) out.connections = getAllConnections(deps).map(publicConnectionForAi);
    if (wanted.has('proxies')) out.proxies = typeof deps.storage.listProxies === 'function' ? deps.storage.listProxies() : [];
    if (wanted.has('sshkeys') || wanted.has('ssh_keys')) out.sshKeys = typeof deps.storage.listSshKeys === 'function' ? deps.storage.listSshKeys() : [];
    if (wanted.has('jumphosts') || wanted.has('jump_hosts')) out.jumpHosts = typeof deps.storage.listJumpHosts === 'function' ? deps.storage.listJumpHosts() : [];
    if (wanted.has('snippets')) out.snippets = Array.isArray(deps.storage.getSettings()?.snippets) ? deps.storage.getSettings().snippets : [];
    return out;
}
function getSshConnections(deps) {
    return getAllConnections(deps).filter((c) => String(c.protocol || '').toUpperCase() === 'SSH');
}
function aiEnvList(ai = {}) {
    return (Array.isArray(ai.envVars) ? ai.envVars : []).filter((item) => item?.enabled !== false && item.name && item.visibleToAi === true);
}
function publicEnvVar(item = {}) {
    return {
        name: item.name,
        description: item.description || '',
        enabled: item.enabled !== false,
        visibleToAi: item.visibleToAi === true,
        valueVisibleToAi: item.valueVisibleToAi === true,
        hasValue: !!item.value,
        valuePreview: item.valueVisibleToAi ? String(item.value || '') : '',
        updatedAt: item.updatedAt || null,
    };
}
function searchMemories(ai = {}, query = '', scope = '', maxResults = 10, context = {}) {
    const q = String(query || '').toLowerCase();
    const wantedScope = String(scope || '').toLowerCase();
    const enriched = rankMemories(ai, context)
        .filter((m) => !wantedScope || [m.scope, m.project, ...(m.projects || []), ...(m.tags || [])].join(' ').toLowerCase().includes(wantedScope))
        .filter((m) => !q || memorySearchHaystack(m).includes(q));
    return enriched.slice(0, clampNumber(maxResults, 1, 50, 10));
}
function stringList(value) {
    if (Array.isArray(value)) return value.map((x) => String(x || '').trim()).filter(Boolean);
    return String(value || '').split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean);
}
function uniqueStrings(list = []) {
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
        const text = String(item || '').trim();
        const key = text.toLowerCase();
        if (text && !seen.has(key)) { seen.add(key); out.push(text); }
    });
    return out;
}
function normalizeAiContext(context = {}) {
    const connections = Array.isArray(context.connections) ? context.connections : [];
    const activeConnectionIds = uniqueStrings([
        ...stringList(context.activeConnectionIds),
        ...connections.map((c) => c.id),
    ]);
    const projects = uniqueStrings([context.project, ...stringList(context.projects)]);
    const tags = uniqueStrings([...stringList(context.tags), ...connections.flatMap((c) => Array.isArray(c.tags) ? c.tags : stringList(c.tags))]);
    return { ...context, activeConnectionIds, projects, tags, connections };
}
function formatAiContextForPrompt(context = {}) {
    const c = normalizeAiContext(context);
    const lines = [];
    if (c.view) lines.push(`当前视图：${c.view}`);
    if (c.activeChatTitle) lines.push(`当前 AI 对话：${c.activeChatTitle}`);
    if (c.projects.length) lines.push(`关联项目：${c.projects.join(', ')}`);
    if (c.tags.length) lines.push(`关联标签：${c.tags.join(', ')}`);
    if (c.connections.length) lines.push(`当前连接上下文：${c.connections.slice(0, 12).map((x) => `${x.protocol || 'SSH'}:${x.name || x.id}(${x.username || '-'}@${x.host || '-'})${Array.isArray(x.tags) && x.tags.length ? `[${x.tags.join(',')}]` : ''}`).join('; ')}`);
    const terminalOutputs = Array.isArray(c.terminalOutputs) ? c.terminalOutputs : [];
    if (terminalOutputs.length) {
        const rendered = terminalOutputs.slice(0, 3).map((t) => {
            const label = `${t.name || t.tabId || '终端'} ${t.username || '-'}@${t.host || '-'} ${t.status ? `(${t.status})` : ''}`.trim();
            const text = tailText(t.text || '', 6000) || '[无可见输出]';
            const input = t.currentInput ? `\n当前输入框：${String(t.currentInput).slice(0, 1000)}` : '';
            return `${label}${t.truncated ? '（输出已截断为尾部）' : ''}${input}\n~~~text\n${text}\n~~~`;
        }).join('\n');
        lines.push(`当前 SSH 终端输出快照（来自用户当前活动/可见终端；需要指定终端或更长文本时调用 terminal_read_output）：\n${rendered}`);
    }
    const remoteDesktopSnapshots = Array.isArray(c.remoteDesktopSnapshots) ? c.remoteDesktopSnapshots : [];
    const rdps = remoteDesktopSnapshots.filter((r) => ['RDP', 'VNC'].includes(String(r.protocol || '').toUpperCase()));
    if (rdps.length) {
        const summary = rdps.slice(0, 3).map((r) => {
            const label = (r.name || r.tabId || '远程桌面') + ' ' + (r.protocol || '') + ' ' + (r.host || '') + (r.port ? ':' + r.port : '') + ' ' + (r.connected ? '已连接' : (r.error || r.status || '未连接')) + ' ' + (r.originalWidth || r.width || 0) + 'x' + (r.originalHeight || r.height || 0);
            return label.trim();
        }).join('; ');
        lines.push('当前 RDP/VNC 远程桌面画面可用（无文本输出，需调用 remote_desktop_screenshot 查看画面快照）：' + summary);
    }
    if (!lines.length) return '';
    return `\n当前 Zephyr 上下文（用于选择连接、项目和 Memory）：\n${lines.map((x) => `- ${x}`).join('\n')}`;
}
function memoryLabel(m = {}) {
    const bits = [];
    const scopes = uniqueStrings([m.scope, m.project, ...(m.projects || [])]);
    if (scopes.length) bits.push(scopes.join('/'));
    if (Array.isArray(m.connectionIds) && m.connectionIds.length) bits.push(`连接:${m.connectionIds.join(',')}`);
    if (Array.isArray(m.tags) && m.tags.length) bits.push(`标签:${m.tags.join(',')}`);
    return `[${bits.join(' · ') || 'global'}] ${m.title || m.key || 'memory'}`;
}
function memorySearchHaystack(m = {}) {
    return [m.title, m.key, m.content, m.scope, m.project, ...(m.projects || []), ...(m.tags || []), ...(m.connectionIds || []), ...(m.connectionNames || [])].join(' ').toLowerCase();
}
function rankMemories(ai = {}, context = {}) {
    const c = normalizeAiContext(context);
    const projectSet = new Set(c.projects.map((x) => x.toLowerCase()));
    const tagSet = new Set(c.tags.map((x) => x.toLowerCase()));
    const connSet = new Set(c.activeConnectionIds.map((x) => x.toLowerCase()));
    return (Array.isArray(ai.memories) ? ai.memories : [])
        .filter((m) => m?.enabled !== false)
        .map((m) => {
            const connectionIds = stringList(m.connectionIds);
            const projects = uniqueStrings([m.project, ...stringList(m.projects)]);
            const tags = stringList(m.tags);
            let score = 0;
            if (connectionIds.some((id) => connSet.has(id.toLowerCase()))) score += 120;
            if (projects.some((p) => projectSet.has(p.toLowerCase()))) score += 70;
            if (tags.some((t) => tagSet.has(t.toLowerCase()))) score += 45;
            if (String(m.scope || '').toLowerCase() === 'global') score += 5;
            return { ...m, connectionIds, projects, tags, _score: score };
        })
        .sort((a, b) => (b._score - a._score) || (Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)));
}
function selectPromptMemories(ai = {}, context = {}, max = 28) {
    const ranked = rankMemories(ai, context);
    const relevant = ranked.filter((m) => m._score > 0);
    const globals = ranked.filter((m) => String(m.scope || '').toLowerCase() === 'global' && !relevant.some((x) => x.id === m.id)).slice(0, 6);
    return [...relevant, ...globals].slice(0, max);
}
function findConnection(deps, id) {
    const conn = getSshConnections(deps).find((c) => c.id === String(id || ''));
    if (!conn) throw new Error('SSH 连接不存在或不可用');
    return conn;
}
function addStoreActivity(store, message) {
    store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message }, ...(store.activities || [])].slice(0, 100);
}
function normalizeProxyType(type) {
    const value = String(type || 'socks5').toLowerCase();
    return ['socks5', 'http'].includes(value) ? value : 'socks5';
}
function normalizeSnippet(item = {}, old = null) {
    const out = {
        id: String(item.snippetId || item.id || old?.id || crypto.randomUUID()).slice(0, 80),
        name: String(item.name ?? old?.name ?? '').slice(0, 60),
        command: String(item.command ?? old?.command ?? '').slice(0, 20000),
        group: String(item.group ?? old?.group ?? '').slice(0, 40),
        autoRun: item.autoRun !== undefined ? !!item.autoRun : !!old?.autoRun,
        updatedAt: Date.now(),
    };
    if (!out.name || !out.command.trim()) throw new Error('代码片段名称和命令不能为空');
    return out;
}
function tailText(value = '', max = MAX_TOOL_TEXT) {
    const text = String(value || '');
    const limit = Math.max(1000, Math.min(200000, Number(max) || MAX_TOOL_TEXT));
    return text.length > limit ? `[前面已截断 ${text.length - limit} 字符]
${text.slice(-limit)}` : text;
}
function publicTerminalOutput(item = {}, maxChars = 30000) {
    return {
        tabId: item.tabId || '',
        connectionId: item.connectionId || '',
        name: item.name || '',
        protocol: item.protocol || 'SSH',
        host: item.host || '',
        port: item.port || '',
        username: item.username || '',
        status: item.status || '',
        currentInput: item.currentInput || '',
        text: tailText(item.text || '', clampNumber(maxChars, 1000, 60000, 30000)),
        lineCount: item.lineCount || 0,
        originalLength: item.originalLength || 0,
        truncated: !!item.truncated || String(item.text || '').length > clampNumber(maxChars, 1000, 60000, 30000),
        cols: item.cols || 0,
        rows: item.rows || 0,
        scrollbackCount: item.scrollbackCount || 0,
        at: item.at || Date.now(),
    };
}

function publicRemoteDesktopScreenshot(r = {}, maxWidth = 960) {
    const w = Math.max(1, Number(r.originalWidth || r.width || 0));
    const h = Math.max(1, Number(r.originalHeight || r.height || 0));
    const dataUrl = String(r.dataUrl || '');
    const maxDataUrlChars = clampNumber(r.maxDataUrlChars || 2500000, 300000, 2500000, 2500000);
    const dataUrlOk = !!dataUrl && dataUrl.length > 200 && dataUrl.length <= maxDataUrlChars && /^data:image\//i.test(dataUrl);
    return {
        tabId: String(r.tabId || ''),
        name: String(r.name || ''),
        protocol: String(r.protocol || '').toUpperCase(),
        connectionId: String(r.connectionId || ''),
        host: String(r.host || ''),
        port: String(r.port || ''),
        status: String(r.status || ''),
        title: String(r.title || r.name || ''),
        connected: !!r.connected,
        width: w,
        height: h,
        originalWidth: w,
        originalHeight: h,
        renderedWidth: Number(r.width || 0),
        renderedHeight: Number(r.height || 0),
        screenshotWidth: Number(r.width || 0),
        screenshotHeight: Number(r.height || 0),
        coordinateHint: 'ui_action remote_desktop_mouse 默认使用截图图片像素坐标；如使用 originalWidth/originalHeight 原始坐标，请传 coordinateSpace=remote。',
        dataUrl: dataUrlOk ? dataUrl : '',
        dataUrlLength: dataUrl.length,
        dataUrlTruncated: false,
        hasScreenshot: dataUrlOk,
        error: String(r.error || (dataUrl && !dataUrlOk ? `截图数据过大（${dataUrl.length} chars），前端需降低 maxWidth 后重试` : '')),
        at: Number(r.at || Date.now()),
    };
}
function cachedToolDefinitions(ai = {}) {
    const p = ai.permissions || {};
    const key = JSON.stringify({ webSearch: p.webSearch !== false, webFetch: p.webFetch !== false, browser: p.browser !== false, memory: p.memory !== false, env: p.env !== false, remoteExecute: p.remoteExecute !== false, fileRead: p.fileRead !== false, fileWrite: p.fileWrite !== false });
    if (!AI_TOOL_CACHE.has(key)) AI_TOOL_CACHE.set(key, toolDefinitions(ai));
    return AI_TOOL_CACHE.get(key);
}
function recordAiPerf(sample = {}) {
    AI_PERF_SAMPLES.unshift({ at: Date.now(), ...sample });
    if (AI_PERF_SAMPLES.length > MAX_AI_PERF_SAMPLES) AI_PERF_SAMPLES.length = MAX_AI_PERF_SAMPLES;
}
function aiPerfSnapshot() {
    const list = AI_PERF_SAMPLES.slice();
    const avg = (field) => list.length ? Math.round(list.reduce((sum, x) => sum + Number(x[field] || 0), 0) / list.length) : 0;
    return { count: list.length, avgDurationMs: avg('durationMs'), avgProviderMs: avg('providerMs'), avgToolMs: avg('toolMs'), samples: list.slice(0, 50) };
}
function toolRoundLimit(ai = {}, provider = {}) {
    const raw = provider.options?.context?.maxToolRounds ?? ai.context?.maxToolRounds ?? DEFAULT_TOOL_CALL_LIMIT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return Infinity;
    return Math.max(1, Math.min(100000, Math.floor(n)));
}
function safeUiActionArgs(args = {}) {
    const action = String(args.action || '');
    const forbiddenSettings = ['security', 'data'];
    if (action === 'switch_view' && String(args.view || '') === 'settings' && forbiddenSettings.includes(String(args.settingsSection || '').toLowerCase())) throw new Error('AI 不允许代操作安全/数据管理设置页');
    return { ...args, action };
}
function sftpOpen(client) { return new Promise((resolve, reject) => client.sftp((err, sftp) => err ? reject(err) : resolve(sftp))); }
function sftpStat(sftp, targetPath) { return new Promise((resolve, reject) => sftp.stat(targetPath, (err, stat) => err ? reject(err) : resolve(stat))); }
function sftpReadFile(sftp, targetPath) { return new Promise((resolve, reject) => sftp.readFile(targetPath, (err, data) => err ? reject(err) : resolve(data))); }
function sftpWriteFile(sftp, targetPath, buffer, append = false) {
    return new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(targetPath, { flags: append ? 'a' : 'w' });
        stream.on('error', reject);
        stream.on('finish', resolve);
        stream.end(buffer);
    });
}
async function withRemoteSftp(deps, conn, fn) {
    const routed = await deps.createRoutedSSHConnection(conn, 10000);
    try {
        const sftp = await sftpOpen(routed.client);
        return await fn(sftp);
    } finally {
        (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
    }
}
function isSensitiveTool(name, args = {}) {
    const value = String(name || '');
    if (value === 'ui_action') return String(args.action || '') === 'terminal_send_input' && args.run !== false;
    return ['remote_execute', 'remote_write_file', 'get_env_var', 'connection_create', 'connection_update', 'connection_delete', 'proxy_save', 'proxy_delete', 'ssh_key_save', 'ssh_key_delete', 'jump_host_save', 'jump_host_delete'].includes(value);
}
function maskToolPayload(value, key = '') {
    const sensitiveKeys = /password|passwd|private[_-]?key|passphrase|secret|token|authorization|cookie|api[_-]?key/i;
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return sensitiveKeys.test(key) && value ? '******' : value;
    if (Array.isArray(value)) return value.map((item) => maskToolPayload(item, key));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitiveKeys.test(k) && v ? '******' : maskToolPayload(v, k)]));
}
function publicToolArgs(toolName, args) {
    const copy = maskToolPayload(JSON.parse(JSON.stringify(args || {})));
    if (copy.content && String(copy.content).length > 1200) copy.content = `${String(copy.content).slice(0, 1200)}
...[内容已截断]`;
    if (copy.privateKey && String(copy.privateKey).length > 80) copy.privateKey = '******';
    if (toolName === 'get_env_var') delete copy.nameValue;
    return copy;
}
function confirmationSummary(toolName, args, deps) {
    if (toolName === 'connection_create') return `新增连接：${args.protocol || 'SSH'} ${args.name || args.host || ''}`;
    if (toolName === 'connection_update') return `修改连接：${args.connectionId || ''}`;
    if (toolName === 'connection_delete') return `删除连接：${args.connectionId || ''}`;
    if (toolName === 'proxy_save') return `${args.proxyId ? '修改' : '新增'}代理：${args.name || args.host || ''}`;
    if (toolName === 'proxy_delete') return `删除代理：${args.proxyId || ''}`;
    if (toolName === 'ssh_key_save') return `${args.sshKeyId ? '修改' : '新增'} SSH 密钥：${args.name || args.sshKeyId || ''}`;
    if (toolName === 'ssh_key_delete') return `删除 SSH 密钥：${args.sshKeyId || ''}`;
    if (toolName === 'jump_host_save') return `${args.jumpHostId ? '修改' : '新增'}跳板机：${args.name || args.connectionId || ''}`;
    if (toolName === 'jump_host_delete') return `删除跳板机：${args.jumpHostId || ''}`;
    if (toolName === 'remote_execute') return `在 ${(args.connectionIds || []).length} 台服务器执行：${String(args.command || '').slice(0, 200)}`;
    if (toolName === 'remote_write_file') {
        let connName = args.connectionId;
        try { connName = findConnection(deps, args.connectionId).name || connName; } catch {}
        return `写入远程文件：${connName}:${args.path}${args.append ? '（追加）' : ''}`;
    }
    if (toolName === 'get_env_var') return `读取 AI 环境变量：${String(args.name || '').slice(0, 120)}`;
    return `执行工具：${toolName}`;
}
async function browserResultWithPreview(action, result, session = 'default', includePreview = true) {
    if (!includePreview) return result;
    try {
        const preview = await browserService.screenshot({ session, fullPage: false });
        return { ...result, preview };
    } catch (err) {
        return { ...result, previewError: err.message || String(err) };
    }
}
function normalizePlanStep(step, index = 0) {
    const isPlain = typeof step === 'string';
    const text = isPlain ? step : (step?.text || '');
    return {
        id: String(isPlain ? `step-${index + 1}` : (step?.id || `step-${index + 1}`)).slice(0, 80),
        text: String(text || '').slice(0, 500),
        status: String(isPlain ? 'pending' : (step?.status || 'pending')).slice(0, 40),
        note: String(isPlain ? '' : (step?.note || '')).slice(0, 1000),
        error: String(isPlain ? '' : (step?.error || '')).slice(0, 1000),
        attempts: Number(isPlain ? 0 : (step?.attempts || 0)),
        updatedAt: Number(isPlain ? Date.now() : (step?.updatedAt || Date.now())),
    };
}
function updateStoredPlan(ai = {}, planId = '', updater) {
    const plans = Array.isArray(ai.plans) ? ai.plans.slice(0, 100) : [];
    const idx = plans.findIndex((p) => p.id === String(planId || ''));
    if (idx < 0) throw new Error('任务计划不存在');
    const plan = { ...plans[idx], steps: Array.isArray(plans[idx].steps) ? plans[idx].steps.map(normalizePlanStep) : [] };
    const next = updater(plan) || plan;
    next.updatedAt = Date.now();
    plans[idx] = next;
    return { plans, plan: next };
}
function inferPlanStatus(plan = {}) {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (!steps.length) return plan.status || 'planned';
    if (steps.some((s) => s.status === 'failed')) return 'failed';
    if (steps.some((s) => s.status === 'paused')) return 'paused';
    if (steps.some((s) => s.status === 'running' || s.status === 'retrying')) return 'running';
    if (steps.every((s) => ['completed', 'skipped'].includes(s.status))) return 'completed';
    if (steps.some((s) => ['completed', 'skipped'].includes(s.status))) return 'running';
    return plan.status || 'planned';
}
async function maybeRequireConfirmation(toolName, args, ctx, run, deps) {
    const ai = deps.storage.getSettings().ai || {};
    const sensitive = ai.sensitive || {};
    if (!isSensitiveTool(toolName, args) || ctx.confirmed || sensitive.requireConfirmation === false) return run();
    if (sensitive.autoConfirm) {
        await delay(clampNumber(sensitive.autoConfirmDelayMs, 0, 60000, 2500), ctx.signal);
        return run();
    }
    const id = crypto.randomUUID();
    const confirmation = { id, toolName, summary: confirmationSummary(toolName, args, deps), args: publicToolArgs(toolName, args), createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 };
    pendingActions.set(id, { ...confirmation, username: ctx.req.session.username, rawArgs: args, context: ctx.context || {} });
    return { confirmationRequired: true, confirmation };
}
async function executeAiTool(toolName, args = {}, ctx, deps) {
    const ai = deps.storage.getSettings().ai || {};
    const p = ai.permissions || {};
    switch (toolName) {
        case 'list_connections':
            return { connections: getAllConnections(deps).map(connectionSummary) };
        case 'list_zephyr_resources':
            return publicResourceList(deps, args.resources || []);
        case 'connection_create':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                if (!String(args.name || '').trim() || !String(args.host || '').trim()) throw new Error('connection_create 只能用于新增连接，必须提供 name 和 host；如果是打开已有连接，请先 list_connections 再 open_connection({ connectionId })');
                const store = deps.readJSON(deps.CONNECTIONS_FILE, { connections: [], activities: [] });
                const conn = normalizeConnectionForSave(args, null);
                store.connections = [conn, ...(store.connections || [])];
                addStoreActivity(store, `AI 新增连接：${conn.name}`);
                saveConnectionsStore(deps, store);
                return { connection: publicConnectionForAi(conn), resources: publicResourceList(deps, ['connections']) };
            }, deps);
        case 'connection_update':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const connectionId = String(args.connectionId || '').trim();
                const store = deps.readJSON(deps.CONNECTIONS_FILE, { connections: [], activities: [] });
                const idx = (store.connections || []).findIndex((c) => c.id === connectionId);
                if (idx < 0) throw new Error('连接不存在');
                const conn = normalizeConnectionForSave(args, store.connections[idx]);
                store.connections[idx] = conn;
                addStoreActivity(store, `AI 修改连接：${conn.name}`);
                saveConnectionsStore(deps, store);
                return { connection: publicConnectionForAi(conn), resources: publicResourceList(deps, ['connections']) };
            }, deps);
        case 'connection_delete':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const connectionId = String(args.connectionId || '').trim();
                const store = deps.readJSON(deps.CONNECTIONS_FILE, { connections: [], activities: [] });
                const target = (store.connections || []).find((c) => c.id === connectionId);
                if (!target) throw new Error('连接不存在');
                store.connections = (store.connections || []).filter((c) => c.id !== connectionId);
                addStoreActivity(store, `AI 删除连接：${target.name}`);
                saveConnectionsStore(deps, store);
                return { deleted: true, connectionId, name: target.name, resources: publicResourceList(deps, ['connections']) };
            }, deps);
        case 'connection_test': {
            if (typeof deps.testConnection !== 'function') throw new Error('连接测试接口不可用');
            const store = deps.readJSON(deps.CONNECTIONS_FILE, { connections: [] });
            const old = args.connectionId ? (store.connections || []).find((c) => c.id === String(args.connectionId)) : null;
            if (args.connectionId && !old) throw new Error('连接不存在；如果你只有连接名称，请先 list_connections 匹配 connectionId');
            if (!old && (!String(args.name || '').trim() || !String(args.host || '').trim())) throw new Error('connection_test 测试临时连接必须提供 name 和 host；测试已有连接请传 connectionId');
            const conn = normalizeConnectionForSave(args, old || null);
            return deps.testConnection(conn, clampNumber(args.timeoutSeconds, 1, 30, 10));
        }
        case 'proxy_save':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const old = args.proxyId && typeof deps.storage.getProxyRaw === 'function' ? deps.storage.getProxyRaw(String(args.proxyId)) : null;
                const proxy = deps.storage.saveProxy({
                    ...(old || {}),
                    id: String(args.proxyId || old?.id || crypto.randomUUID()),
                    name: String(args.name ?? old?.name ?? '').trim(),
                    host: String(args.host ?? old?.host ?? '').trim(),
                    port: Number(args.port ?? old?.port) || 1080,
                    type: normalizeProxyType(args.type ?? old?.type),
                    username: String(args.username ?? old?.username ?? ''),
                    password: args.password === '******' || args.password === undefined ? (old?.password || '') : String(args.password || ''),
                    createdAt: old?.createdAt || Date.now(),
                    updatedAt: Date.now(),
                });
                if (!proxy.name || !proxy.host || !proxy.port) throw new Error('代理名称、主机、端口不能为空');
                deps.addActivity?.(`AI ${old ? '修改' : '新增'}代理：${proxy.name}`);
                return { proxy, resources: publicResourceList(deps, ['proxies']) };
            }, deps);
        case 'proxy_delete':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const proxyId = String(args.proxyId || '').trim();
                deps.storage.deleteProxy(proxyId);
                deps.addActivity?.(`AI 删除代理：${proxyId}`);
                return { deleted: true, proxyId, resources: publicResourceList(deps, ['proxies']) };
            }, deps);
        case 'ssh_key_save':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const old = args.sshKeyId && typeof deps.storage.getSshKeyRaw === 'function' ? deps.storage.getSshKeyRaw(String(args.sshKeyId)) : null;
                const privateKey = args.privateKey === '******' || args.privateKey === undefined ? (old?.privateKey || '') : String(args.privateKey || '');
                if (!privateKey.includes('-----BEGIN')) throw new Error('请填写有效的 SSH 私钥');
                const sshKey = deps.storage.saveSshKey({
                    ...(old || {}),
                    id: String(args.sshKeyId || old?.id || crypto.randomUUID()),
                    name: String(args.name ?? old?.name ?? '').trim(),
                    privateKey,
                    passphrase: args.passphrase === '******' || args.passphrase === undefined ? (old?.passphrase || '') : String(args.passphrase || ''),
                    remark: String(args.remark ?? old?.remark ?? ''),
                    createdAt: old?.createdAt || Date.now(),
                    updatedAt: Date.now(),
                });
                deps.addActivity?.(`AI ${old ? '修改' : '新增'} SSH 密钥：${sshKey.name}`);
                return { sshKey, resources: publicResourceList(deps, ['sshKeys']) };
            }, deps);
        case 'ssh_key_delete':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const sshKeyId = String(args.sshKeyId || '').trim();
                deps.storage.deleteSshKey(sshKeyId);
                deps.addActivity?.(`AI 删除 SSH 密钥：${sshKeyId}`);
                return { deleted: true, sshKeyId, resources: publicResourceList(deps, ['sshKeys']) };
            }, deps);
        case 'jump_host_save':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const connectionId = String(args.connectionId || '').trim();
                const conn = getAllConnections(deps).find((c) => c.id === connectionId);
                if (!conn || String(conn.protocol || 'SSH').toUpperCase() !== 'SSH') throw new Error('跳板机必须选择一个 SSH 连接');
                const old = args.jumpHostId ? (deps.storage.listJumpHosts() || []).find((j) => j.id === String(args.jumpHostId)) : null;
                const jumpHost = deps.storage.saveJumpHost({ id: String(args.jumpHostId || old?.id || crypto.randomUUID()), name: String(args.name ?? old?.name ?? '').trim(), connectionId, createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() });
                deps.addActivity?.(`AI ${old ? '修改' : '新增'}跳板机：${jumpHost.name}`);
                return { jumpHost, resources: publicResourceList(deps, ['jumpHosts']) };
            }, deps);
        case 'jump_host_delete':
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const jumpHostId = String(args.jumpHostId || '').trim();
                deps.storage.deleteJumpHost(jumpHostId);
                deps.addActivity?.(`AI 删除跳板机：${jumpHostId}`);
                return { deleted: true, jumpHostId, resources: publicResourceList(deps, ['jumpHosts']) };
            }, deps);
        case 'snippet_save': {
            const settings = deps.storage.getSettings();
            const snippets = Array.isArray(settings.snippets) ? settings.snippets.slice(0, 500) : [];
            const idx = snippets.findIndex((x) => x.id === String(args.snippetId || args.id || ''));
            const item = normalizeSnippet(args, idx >= 0 ? snippets[idx] : null);
            if (idx >= 0) snippets[idx] = item; else snippets.unshift(item);
            deps.storage.updateSettings({ snippets: snippets.slice(0, 500) });
            return { snippet: item, resources: publicResourceList(deps, ['snippets']) };
        }
        case 'snippet_delete': {
            const snippetId = String(args.snippetId || '').trim();
            const settings = deps.storage.getSettings();
            const snippets = (Array.isArray(settings.snippets) ? settings.snippets : []).filter((x) => x.id !== snippetId);
            deps.storage.updateSettings({ snippets });
            return { deleted: true, snippetId, resources: publicResourceList(deps, ['snippets']) };
        }
        case 'terminal_read_output': {
            const maxChars = clampNumber(args.maxChars, 1000, 60000, 30000);
            const outputs = Array.isArray(ctx.context?.terminalOutputs) ? ctx.context.terminalOutputs : [];
            const tabId = String(args.tabId || '').trim();
            const selected = (args.allVisible ? outputs : (tabId ? outputs.filter((t) => String(t.tabId || '') === tabId) : outputs.slice(0, 1))).filter((t) => String(t.protocol || 'SSH').toUpperCase() === 'SSH');
            return { activeTerminalTab: ctx.context?.activeTerminalTab || '', terminalOutputs: selected.map((t) => publicTerminalOutput(t, maxChars)), message: selected.length ? '已读取终端输出快照' : '当前没有可读取的 SSH 终端输出；请先打开 SSH 连接或切到终端页。' };
        }
        case 'ui_action':
            return maybeRequireConfirmation(toolName, args, ctx, async () => ({ uiAction: 'ui_action', action: safeUiActionArgs(args), message: '已请求前端执行可见 UI 代操作' }), deps);
        case 'web_search':
            if (p.webSearch === false) throw new Error('网页搜索权限未开启');
            return { results: await duckDuckGoSearch(String(args.query || ''), clampNumber(args.maxResults, 1, 10, 6)) };
        case 'fetch_url':
            if (p.webFetch === false) throw new Error('网页读取权限未开启');
            return { url: String(args.url || ''), text: await fetchUrlText(args.url, args.maxChars) };
        case 'browser_navigate': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('navigate', await browserService.navigate({ url: args.url, session, waitMs: args.waitMs }), session);
        }
        case 'browser_screenshot': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserService.screenshot({ session, fullPage: !!args.fullPage });
        }
        case 'browser_inspect': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('inspect', await browserService.inspect({ session, max: args.max || 80 }), session);
        }
        case 'browser_click': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('click', await browserService.click({ session, selector: args.selector || '', x: args.x, y: args.y }), session);
        }
        case 'browser_type': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('type', await browserService.type({ session, selector: args.selector || '', text: args.text || '', clear: !!args.clear }), session);
        }
        case 'browser_scroll': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('scroll', await browserService.scroll({ session, direction: args.direction || 'down', amount: args.amount }), session);
        }
        case 'browser_text': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('text', { session, text: await browserService.text(session, clampNumber(args.maxChars, 1000, 120000, MAX_TOOL_TEXT)) }, session);
        }
        case 'browser_key': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('key', await browserService.key({ session, key: args.key || 'Enter' }), session);
        }
        case 'browser_wait': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserResultWithPreview('wait', await browserService.wait({ session, ms: args.ms || 1000 }), session);
        }
        case 'browser_close': {
            if (p.browser === false) throw new Error('浏览器自动化权限未开启');
            const session = aiBrowserSession(args, ctx);
            return browserService.closeSession(session);
        }
        case 'open_connection': {
            const requested = String(args.connectionId || args.name || args.host || '').trim();
            const conn = findConnectionByIdOrName(deps, requested);
            if (!conn) throw new Error('连接不存在；请先调用 list_connections 获取可用连接并使用返回的 connectionId');
            deps.addActivity?.(`AI 请求打开连接：${conn.name || conn.id}`);
            return { uiAction: 'open_connection', connectionId: conn.id, connection: connectionSummary(conn), message: `准备在页面打开 ${conn.protocol || 'SSH'} 连接：${conn.name || conn.host}` };
        }
        case 'memory_search':
            if (p.memory === false || ai.memory?.enabled === false) throw new Error('长期 Memory 权限未开启');
            return { memories: searchMemories(ai, args.query || '', args.scope || args.project || '', args.maxResults || 10, { ...(ctx.context || {}), activeConnectionIds: uniqueStrings([...stringList(ctx.context?.activeConnectionIds), ...stringList(args.connectionIds)]), projects: uniqueStrings([...stringList(ctx.context?.projects), args.project].filter(Boolean)), tags: uniqueStrings([...stringList(ctx.context?.tags), ...stringList(args.tags)]) }) };
        case 'memory_save': {
            if (p.memory === false || ai.memory?.enabled === false) throw new Error('长期 Memory 权限未开启');
            const memories = Array.isArray(ai.memories) ? ai.memories.slice(0, 1000) : [];
            const context = normalizeAiContext(ctx.context || {});
            const connectionIds = uniqueStrings([...context.activeConnectionIds, ...stringList(args.connectionIds)]);
            const projects = uniqueStrings([...(context.projects || []), args.project, ...stringList(args.projects)]);
            const tags = uniqueStrings([...(context.tags || []), ...stringList(args.tags)]);
            const item = {
                id: crypto.randomUUID(),
                title: String(args.title || args.key || 'AI Memory').slice(0, 120),
                content: String(args.content || '').slice(0, 20000),
                scope: String(args.scope || projects[0] || (connectionIds.length ? 'connection' : 'global')).slice(0, 80),
                project: String(args.project || projects[0] || '').slice(0, 120),
                projects: projects.slice(0, 20),
                tags: tags.slice(0, 30),
                connectionIds: connectionIds.slice(0, 50),
                enabled: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            if (!item.content.trim()) throw new Error('Memory 内容不能为空');
            memories.unshift(item);
            deps.storage.updateSettings({ ai: { memories: memories.slice(0, clampNumber(ai.memory?.maxItems, 1, 2000, 500)) } });
            deps.addActivity?.(`AI 保存 Memory：${item.title}`);
            return { memory: item };
        }
        case 'list_env_vars':
            if (p.env === false) throw new Error('AI 环境变量权限未开启');
            return { envVars: aiEnvList(ai).map(publicEnvVar) };
        case 'get_env_var':
            if (p.env === false) throw new Error('AI 环境变量权限未开启');
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const name = String(args.name || '').trim();
                const item = aiEnvList(ai).find((envVar) => envVar.name === name);
                if (!item) throw new Error('环境变量不存在或未启用');
                return { name: item.name, value: item.value || '', description: item.description || '' };
            }, deps);
        case 'plan_task': {
            const steps = Array.isArray(args.steps) ? args.steps.map((s) => String(s).slice(0, 500)).filter(Boolean) : [];
            if (!steps.length) throw new Error('计划至少需要一个步骤');
            const plans = Array.isArray(ai.plans) ? ai.plans.slice(0, 100) : [];
            const plan = {
                id: crypto.randomUUID(),
                title: String(args.title || 'AI 任务计划').slice(0, 160),
                steps: steps.map((text, index) => normalizePlanStep({ id: `step-${index + 1}`, text, status: 'pending' }, index)),
                risk: String(args.risk || '').slice(0, 2000),
                status: 'planned',
                logs: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            plans.unshift(plan);
            deps.storage.updateSettings({ ai: { plans: plans.slice(0, 100) } });
            return { plan };
        }
        case 'plan_update': {
            const planId = String(args.planId || '').trim();
            if (!planId) throw new Error('planId 不能为空');
            const { plans, plan } = updateStoredPlan(ai, planId, (draft) => {
                const logs = Array.isArray(draft.logs) ? draft.logs.slice(-80) : [];
                if (args.note) logs.push({ time: Date.now(), text: String(args.note).slice(0, 2000) });
                draft.logs = logs;
                if (args.pause) { draft.status = 'paused'; draft.steps = draft.steps.map((s) => s.status === 'running' || s.status === 'retrying' ? { ...s, status: 'paused', updatedAt: Date.now() } : s); }
                if (args.resume) { draft.status = 'running'; const first = draft.steps.find((s) => s.status === 'paused') || draft.steps.find((s) => s.status === 'pending'); if (first) { first.status = 'running'; first.updatedAt = Date.now(); } }
                if (args.retryFailed) { draft.status = 'running'; draft.steps = draft.steps.map((s) => s.status === 'failed' ? { ...s, status: 'retrying', attempts: Number(s.attempts || 0) + 1, error: '', updatedAt: Date.now() } : s); }
                if (Array.isArray(args.steps)) {
                    args.steps.forEach((patch) => {
                        const idx = patch.id ? draft.steps.findIndex((s) => s.id === patch.id) : Number(patch.index) - 1;
                        if (idx < 0 || idx >= draft.steps.length) return;
                        const old = draft.steps[idx];
                        draft.steps[idx] = { ...old, status: patch.status ? String(patch.status).slice(0, 40) : old.status, note: patch.note !== undefined ? String(patch.note).slice(0, 1000) : old.note, error: patch.error !== undefined ? String(patch.error).slice(0, 1000) : old.error, updatedAt: Date.now() };
                    });
                }
                if (args.status) draft.status = String(args.status).slice(0, 40);
                else draft.status = inferPlanStatus(draft);
                return draft;
            });
            deps.storage.updateSettings({ ai: { plans } });
            return { plan };
        }
        case 'plan_delete': {
            const planId = String(args.planId || '').trim();
            if (!planId) throw new Error('planId 不能为空');
            const plans = (Array.isArray(ai.plans) ? ai.plans : []).filter((plan) => plan.id !== planId);
            deps.storage.updateSettings({ ai: { plans } });
            return { deleted: true, planId, plans };
        }
        case 'remote_execute':
            if (p.remoteExecute === false) throw new Error('远程执行权限未开启');
            return maybeRequireConfirmation(toolName, args, ctx, async () => {
                const ids = Array.isArray(args.connectionIds) ? args.connectionIds.map(String) : [];
                if (!ids.length) throw new Error('请选择 SSH 连接');
                const command = String(args.command || '').trim();
                if (!command) throw new Error('命令不能为空');
                const targets = getSshConnections(deps).filter((c) => ids.includes(c.id));
                if (!targets.length) throw new Error('远程执行仅支持 SSH 连接；RDP/VNC 只能作为资产上下文或通过连接入口打开');
                const results = await Promise.all(targets.map((conn) => deps.runRemoteCommand(conn, command, clampNumber(args.timeoutSeconds, 1, 300, 30), { signal: ctx.signal })));
                deps.addActivity?.(`AI 助理远程执行：${targets.length} 台服务器，命令 ${command.slice(0, 40)}`);
                return { results };
            }, deps);
        case 'remote_read_file':
            if (p.fileRead === false) throw new Error('远程文件读取权限未开启');
            return withRemoteSftp(deps, findConnection(deps, args.connectionId), async (sftp) => {
                const targetPath = String(args.path || '');
                const maxBytes = clampNumber(args.maxBytes, 1, MAX_REMOTE_READ, MAX_REMOTE_READ);
                const stat = await sftpStat(sftp, targetPath);
                if (Number(stat.size) > maxBytes) throw new Error(`文件过大（${stat.size} bytes），当前上限 ${maxBytes} bytes`);
                const data = await sftpReadFile(sftp, targetPath);
                return { path: targetPath, size: data.length, content: data.toString('utf8') };
            });
        case 'remote_write_file':
            if (p.fileWrite === false) throw new Error('远程文件写入权限未开启');
            return maybeRequireConfirmation(toolName, args, ctx, async () => withRemoteSftp(deps, findConnection(deps, args.connectionId), async (sftp) => {
                const targetPath = String(args.path || '');
                const buffer = args.encoding === 'base64' ? Buffer.from(String(args.content || ''), 'base64') : Buffer.from(String(args.content || ''), 'utf8');
                if (buffer.length > MAX_REMOTE_WRITE) throw new Error(`写入内容过大，当前上限 ${MAX_REMOTE_WRITE} bytes`);
                await sftpWriteFile(sftp, targetPath, buffer, !!args.append);
                deps.addActivity?.(`AI 助理写入远程文件：${targetPath}`);
                return { path: targetPath, bytes: buffer.length, append: !!args.append };
            }), deps);
        case 'remote_desktop_screenshot': {
            const raw = Array.isArray(ctx.context?.remoteDesktopSnapshots) ? ctx.context.remoteDesktopSnapshots : [];
            const tabId = String(args.tabId || '').trim();
            const maxWidth = clampNumber(args.maxWidth, 320, 1600, 640);
            const targets = (tabId ? raw.filter((r) => String(r.tabId || '') === tabId) : raw)
                .filter((r) => ['RDP', 'VNC'].includes(String(r.protocol || '').toUpperCase()) && (r.connected || r.hasScreenshot || r.dataUrl || r.error))
                .slice(0, 3)
                .map((r) => ({ tabId: r.tabId || '', protocol: r.protocol || '', title: r.title || r.name || '', host: r.host || '', port: r.port || '', status: r.status || '', connected: !!r.connected, width: r.width || 0, height: r.height || 0, originalWidth: r.originalWidth || 0, originalHeight: r.originalHeight || 0, at: r.at || 0 }));
            const screenshots = (tabId ? raw.filter((r) => String(r.tabId || '') === tabId) : raw)
                .filter((r) => ['RDP', 'VNC'].includes(String(r.protocol || '').toUpperCase()) && r.dataUrl)
                .slice(0, 1)
                .map((r) => ({ ...r, hasScreenshot: true }));
            if (screenshots.length) return { screenshots, targets, clientCaptureRequired: false, tabId, maxWidth, message: '已读取当前上下文中的最新远程桌面画面' };
            if (!targets.length) return { screenshots: [], clientCaptureRequired: false, message: '当前没有可读取的 RDP/VNC 远程桌面画面；请先打开 RDP 或 VNC 连接。' };
            return { screenshots: [], targets, clientCaptureRequired: true, tabId, maxWidth, message: '需要前端实时截取最新远程桌面画面' };
        }
        default:
            throw new Error(`未知工具：${toolName}`);
    }
}
function parseToolCall(call = {}) {
    const fn = call.function || {};
    return { id: call.id || crypto.randomUUID(), name: fn.name || call.name || '', args: safeJsonParse(fn.arguments || call.arguments || '{}', {}) || {} };
}
function toolResultMessage(call, result, mode = 'chat', limits = {}, providerType = '') {
    const max = clampNumber(limits.toolResultChars, 1000, 240000, 60000);
    const screenshots = call.name === 'remote_desktop_screenshot' ? (result?.screenshots || []).filter((r) => r.hasScreenshot && r.dataUrl) : [];
    const safeJson = () => clipText(JSON.stringify(result, (key, value) => {
        if (key === 'dataUrl' && typeof value === 'string') return value ? `[image data omitted ${value.length} chars]` : '';
        return value;
    }, 2), max);
    if (screenshots.length && providerType === 'anthropic') {
        return { role: 'tool', tool_call_id: call.id, name: call.name, content: [{ type: 'tool_result', tool_use_id: call.id, content: safeJson() }, ...anthropicScreenshotParts(screenshots)] };
    }
    if (screenshots.length && providerType === 'gemini') {
        return [
            { role: 'tool', tool_call_id: call.id, name: call.name || parseToolCall(call).name || '', content: safeJson() },
            { role: 'user', parts: geminiScreenshotParts(screenshots) },
        ];
    }
    if (screenshots.length && (mode === 'chat' || mode === 'responses')) {
        return [
            { role: 'tool', tool_call_id: call.id, name: call.name, content: safeJson() },
            { role: 'user', content: openAiScreenshotParts(screenshots) },
        ];
    }
    const callName = call.name || parseToolCall(call).name || '';
    if (mode === 'responses') return { role: 'tool', tool_call_id: call.id, name: callName, content: clipText(JSON.stringify(result), max) };
    return { role: 'tool', tool_call_id: call.id, name: callName, content: clipText(JSON.stringify(result, null, 2), max) };
}
async function completeWithProvider(ai, body) {
    const { provider, model } = selectProvider(ai, body);
    const language = String(body.language || 'plain');
    const path = String(body.path || 'untitled');
    const prefix = String(body.prefix || '').slice(-5000);
    const suffix = String(body.suffix || '').slice(0, 2000);
    const prompt = `你是代码补全引擎。只返回应插入光标处的代码，不要解释，不要 Markdown。\n文件: ${path}\n语言: ${language}\n\n<光标前>\n${prefix}\n</光标前>\n<光标后>\n${suffix}\n</光标后>`;
    const messages = [{ role: 'system', content: '你只输出代码补全内容。' }, { role: 'user', content: prompt }];
    const message = await callProvider(provider, model, messages, { temperature: 0.2, max_tokens: clampNumber(body.maxTokens, 16, 1024, 160) }, []);
    const text = String(message.content || '').replace(/^```[\w-]*\n?/, '').replace(/```$/, '').slice(0, 8000);
    return { suggestions: text.trim() ? [{ label: text.split(/\r?\n/)[0].slice(0, 80) || 'AI 补全', detail: `${provider.name || provider.type} / ${model}`, apply: text }] : [] };
}
function normalizeAiSettingsInput(currentAi = {}, ai = {}) {
    const currentProviders = Array.isArray(currentAi.providers) ? currentAi.providers : [];
    const partial = arguments.length >= 2 && ai && typeof ai === 'object' ? ai : {};
    const pick = (key, fallback) => Object.prototype.hasOwnProperty.call(partial, key) ? partial[key] : fallback;
    const next = { ...(currentAi || {}), ...(partial || {}) };
    next.enabled = !!pick('enabled', currentAi.enabled);
    next.assistantName = String(pick('assistantName', currentAi.assistantName) || 'Zephyr AI').slice(0, 40);
    next.defaultProviderId = String(pick('defaultProviderId', currentAi.defaultProviderId) || '').slice(0, 120);
    next.defaultModel = String(pick('defaultModel', currentAi.defaultModel) || '').slice(0, 160);
    next.systemPrompt = String(pick('systemPrompt', currentAi.systemPrompt) || '').slice(0, 20000);
    next.defaultSystemPrompt = String(pick('defaultSystemPrompt', currentAi.defaultSystemPrompt || DEFAULT_ZEPHYR_SYSTEM_PROMPT) || DEFAULT_ZEPHYR_SYSTEM_PROMPT).slice(0, 40000);
    const contextIn = { ...(currentAi.context || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'context') ? (partial.context || {}) : {}) };
    next.context = {
        windowTokens: clampNumber(contextIn.windowTokens, 1024, 1000000, DEFAULT_AI_CONTEXT.windowTokens),
        maxInputChars: clampNumber(contextIn.maxInputChars, 8000, 1200000, DEFAULT_AI_CONTEXT.maxInputChars),
        keepMessages: clampNumber(contextIn.keepMessages, 4, 160, DEFAULT_AI_CONTEXT.keepMessages),
        toolResultChars: clampNumber(contextIn.toolResultChars, 1000, 240000, DEFAULT_AI_CONTEXT.toolResultChars),
        memoryItems: clampNumber(contextIn.memoryItems, 0, 80, DEFAULT_AI_CONTEXT.memoryItems),
        maxToolRounds: clampNumber(contextIn.maxToolRounds, 0, 100000, DEFAULT_TOOL_CALL_LIMIT),
    };
    next.guidanceVersion = Math.max(1, Number(pick('guidanceVersion', currentAi.guidanceVersion) || 1));
    next.codeCompletionEnabled = pick('codeCompletionEnabled', currentAi.codeCompletionEnabled) !== false;
    const sensitiveIn = { ...(currentAi.sensitive || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'sensitive') ? (partial.sensitive || {}) : {}) };
    next.sensitive = {
        requireConfirmation: sensitiveIn.requireConfirmation !== false,
        autoConfirm: !!sensitiveIn.autoConfirm,
        autoConfirmDelayMs: clampNumber(sensitiveIn.autoConfirmDelayMs, 0, 60000, 2500),
    };
    const permissionsIn = { ...(currentAi.permissions || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'permissions') ? (partial.permissions || {}) : {}) };
    next.permissions = {
        webSearch: permissionsIn.webSearch !== false,
        webFetch: permissionsIn.webFetch !== false,
        browser: permissionsIn.browser !== false,
        remoteExecute: permissionsIn.remoteExecute !== false,
        fileRead: permissionsIn.fileRead !== false,
        fileWrite: permissionsIn.fileWrite !== false,
        codeEdit: permissionsIn.codeEdit !== false,
        memory: permissionsIn.memory !== false,
        env: permissionsIn.env !== false,
    };
    const plannerIn = { ...(currentAi.planner || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'planner') ? (partial.planner || {}) : {}) };
    next.planner = { enabled: plannerIn.enabled !== false, requirePlanBeforeTools: !!plannerIn.requirePlanBeforeTools };
    const memoryIn = { ...(currentAi.memory || {}), ...(Object.prototype.hasOwnProperty.call(partial, 'memory') ? (partial.memory || {}) : {}) };
    next.memory = { enabled: memoryIn.enabled !== false, maxItems: clampNumber(memoryIn.maxItems, 1, 2000, 500) };
    if (Array.isArray(ai.providers)) {
        next.providers = ai.providers.slice(0, 30).map((p) => {
            const old = currentProviders.find((x) => x.id === p.id) || {};
            const rawModels = String(p.models || old.models || '').slice(0, 4000);
            const modelList = rawModels.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
            return {
                id: String(p.id || crypto.randomUUID()).slice(0, 120),
                name: String(p.name || '未命名供应商').slice(0, 80),
                type: ['openai-compatible', 'anthropic', 'gemini'].includes(providerType(p)) ? providerType(p) : 'openai-compatible',
                enabled: p.enabled !== false,
                baseUrl: String(p.baseUrl || '').slice(0, 500),
                apiMode: ['openai-compatible', 'openai'].includes(providerType(p))
                    ? (['auto', 'chat', 'responses'].includes(String(p.apiMode || old.apiMode || '').toLowerCase()) ? String(p.apiMode || old.apiMode || 'auto').toLowerCase() : 'auto')
                    : 'native',
                apiKey: p.apiKey === '******' ? (old.apiKey || '') : String(p.apiKey || ''),
                organization: String(p.organization || old.organization || '').slice(0, 200),
                extraHeaders: String(p.extraHeaders || old.extraHeaders || '').slice(0, 4000),
                models: rawModels,
                modelsPending: !modelList.length,
                defaultModel: String(p.defaultModel || old.defaultModel || modelList[0] || '').slice(0, 160),
                options: {
                    temperature: p.options?.temperature ?? old.options?.temperature ?? -1,
                    top_p: p.options?.top_p ?? old.options?.top_p ?? -1,
                    max_tokens: p.options?.max_tokens ?? old.options?.max_tokens ?? 4096,
                    max_output_tokens: p.options?.max_output_tokens ?? old.options?.max_output_tokens ?? p.options?.max_tokens ?? old.options?.max_tokens ?? 4096,
                    presence_penalty: p.options?.presence_penalty ?? old.options?.presence_penalty ?? 0,
                    frequency_penalty: p.options?.frequency_penalty ?? old.options?.frequency_penalty ?? 0,
                    reasoning_effort: String(p.options?.reasoning_effort ?? old.options?.reasoning_effort ?? ''),
                    response_format: String(p.options?.response_format ?? old.options?.response_format ?? ''),
                    use_previous_response_id: !!(p.options?.use_previous_response_id ?? old.options?.use_previous_response_id ?? false),
                    context: {
                        windowTokens: clampNumber(p.options?.context?.windowTokens ?? old.options?.context?.windowTokens ?? next.context.windowTokens, 1024, 1000000, next.context.windowTokens),
                        maxInputChars: clampNumber(p.options?.context?.maxInputChars ?? old.options?.context?.maxInputChars ?? next.context.maxInputChars, 8000, 1200000, next.context.maxInputChars),
                        keepMessages: clampNumber(p.options?.context?.keepMessages ?? old.options?.context?.keepMessages ?? next.context.keepMessages, 4, 160, next.context.keepMessages),
                        toolResultChars: clampNumber(p.options?.context?.toolResultChars ?? old.options?.context?.toolResultChars ?? next.context.toolResultChars, 1000, 240000, next.context.toolResultChars),
                    },
                    extraJson: String(p.options?.extraJson ?? old.options?.extraJson ?? '').slice(0, 12000),
                },
            };
        });
        if (!next.defaultProviderId && next.providers.length) next.defaultProviderId = next.providers[0].id;
        if (!next.defaultModel) {
            const defaultProvider = next.providers.find((p) => p.id === next.defaultProviderId) || next.providers[0];
            next.defaultModel = defaultProvider?.defaultModel || aiModelNames(defaultProvider)[0] || '';
        }
    }
    if (Array.isArray(ai.skills)) {
        next.skills = mergeZephyrDefaultSkills(ai.skills.slice(0, 200).map((s) => ({
            id: String(s.id || crypto.randomUUID()).slice(0, 120),
            name: String(s.name || '').slice(0, 80),
            description: String(s.description || '').slice(0, 500),
            prompt: String(s.prompt || '').slice(0, 30000),
            enabled: s.enabled !== false,
            updatedAt: Number(s.updatedAt || Date.now()),
        })).filter((s) => s.name || s.prompt)).slice(0, 200);
    } else {
        next.skills = mergeZephyrDefaultSkills(next.skills || []).slice(0, 200);
    }
    if (Array.isArray(ai.memories)) {
        next.memories = ai.memories.slice(0, 2000).map((m) => ({
            id: String(m.id || crypto.randomUUID()).slice(0, 120),
            title: String(m.title || m.key || 'Memory').slice(0, 120),
            content: String(m.content || '').slice(0, 20000),
            scope: String(m.scope || 'global').slice(0, 80),
            project: String(m.project || '').slice(0, 120),
            projects: uniqueStrings([m.project, ...stringList(m.projects)]).slice(0, 20),
            tags: stringList(m.tags).slice(0, 30),
            connectionIds: stringList(m.connectionIds).slice(0, 50),
            enabled: m.enabled !== false,
            createdAt: Number(m.createdAt || Date.now()),
            updatedAt: Number(m.updatedAt || Date.now()),
        })).filter((m) => m.content.trim()).slice(0, next.memory.maxItems);
    }
    const currentEnvVars = Array.isArray(currentAi.envVars) ? currentAi.envVars : [];
    if (Array.isArray(ai.envVars)) {
        next.envVars = ai.envVars.slice(0, 200).map((item) => {
            const old = currentEnvVars.find((x) => x.id === item.id || x.name === item.name) || {};
            return {
                id: String(item.id || old.id || crypto.randomUUID()).slice(0, 120),
                name: String(item.name || '').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80),
                description: String(item.description || '').slice(0, 500),
                value: item.value === '******' ? (old.value || '') : String(item.value || ''),
                visibleToAi: item.visibleToAi === true,
                valueVisibleToAi: item.valueVisibleToAi === true,
                enabled: item.enabled !== false,
                updatedAt: Number(item.updatedAt || Date.now()),
            };
        }).filter((item) => item.name);
    }
    if (Array.isArray(ai.plans)) {
        next.plans = ai.plans.slice(0, 100).map((plan) => ({
            id: String(plan.id || crypto.randomUUID()).slice(0, 120),
            title: String(plan.title || 'AI 任务计划').slice(0, 160),
            risk: String(plan.risk || '').slice(0, 2000),
            status: String(plan.status || 'planned').slice(0, 40),
            steps: Array.isArray(plan.steps) ? plan.steps.slice(0, 100).map(normalizePlanStep) : [],
            logs: Array.isArray(plan.logs) ? plan.logs.slice(-100).map((log) => ({ time: Number(log.time || Date.now()), text: String(log.text || '').slice(0, 2000) })) : [],
            createdAt: Number(plan.createdAt || Date.now()),
            updatedAt: Number(plan.updatedAt || Date.now()),
        }));
    }
    return next;
}
function safeAiSettings(ai = {}) {
    const copy = JSON.parse(JSON.stringify(ai || {}));
    if (Array.isArray(copy.providers)) copy.providers.forEach((p) => { if (p.apiKey) p.apiKey = '******'; });
    if (Array.isArray(copy.envVars)) copy.envVars.forEach((item) => {
        item.hasValue = !!item.value;
        item.valuePreview = item.valueVisibleToAi ? String(item.value || '') : '';
        if (item.value) item.value = '******';
    });
    return copy;
}
function cleanupPendingActions() {
    const now = Date.now();
    for (const [id, item] of pendingActions.entries()) if (!item || item.expiresAt < now) pendingActions.delete(id);
}
function registerAiRoutes(app, deps) {
    app.get('/api/ai/status', deps.requireAuth, (req, res) => {
        const ai = safeAiSettings(deps.storage.getSettings().ai || {});
        res.json({ ai, pending: pendingActions.size });
    });

    app.get('/api/ai/browser/screenshots/:name', deps.requireAuth, (req, res) => {
        const name = path.basename(String(req.params.name || ''));
        if (!/^[A-Za-z0-9_.-]+\.png$/.test(name)) return res.status(400).end('bad screenshot name');
        const file = path.join(SHOT_DIR, name);
        if (!fs.existsSync(file)) return res.status(404).end('not found');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(file);
    });

    app.post('/api/ai/models', deps.requireAuth, async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            const providerId = String(req.body?.providerId || '').trim();
            const provider = providerId
                ? (Array.isArray(ai.providers) ? ai.providers : []).find((p) => p.id === providerId)
                : req.body?.provider;
            if (!provider) return res.status(404).json({ error: '模型供应商不存在' });
            const models = await listProviderModels(provider);
            res.json({ ok: true, models: models.slice(0, 300) });
        } catch (err) { res.status(isTransientAiFetchError(err) ? 502 : 400).json({ error: publicError(err), transient: isTransientAiFetchError(err) }); }
    });

    app.post('/api/ai/chat', deps.requireAuth, async (req, res) => {
        const abortController = new AbortController();
        const abortRequest = () => {
            if (res.writableEnded) return;
            abortController.abort();
        };
        req.on('aborted', abortRequest);
        res.on('close', abortRequest);
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled) return res.status(403).json({ error: 'AI 助理未启用，请先到设置中开启' });
            const { provider, model } = selectProvider(ai, req.body || {});
            const context = normalizeAiContext(req.body?.context || {});
            const limits = normalizeContextLimits(ai, provider);
            const requestStartedAt = Date.now();
            let providerMs = 0;
            let toolMs = 0;
            let providerCalls = 0;
            const baseMessages = convertMessagesForProvider(req.body?.messages || [], buildSystemPrompt(ai, context, limits), limits);
            const contextStats = baseMessages._contextStats || {};
            const tools = providerSupportsTools(provider) ? cachedToolDefinitions(ai) : [];
            let messages = baseMessages;
            const toolResults = [];
            const maxToolRounds = toolRoundLimit(ai, provider);
            for (let step = 0; step < maxToolRounds; step += 1) {
                throwIfAborted(abortController.signal);
                const providerStartedAt = Date.now();
                const message = await callProvider(provider, model, messages, req.body?.options || {}, tools, abortController.signal);
                providerMs += Date.now() - providerStartedAt;
                providerCalls += 1;
                throwIfAborted(abortController.signal);
                const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(parseToolCall).filter((c) => c.name) : [];
                if (!calls.length) {
                    deps.addActivity?.(`AI 助理对话：${provider.name || provider.type}/${model}`);
                    const durationMs = Date.now() - requestStartedAt;
                    recordAiPerf({ status: 'ok', durationMs, providerMs, toolMs, providerCalls, toolResults: toolResults.length, model, provider: provider.name || provider.type, compactedMessages: contextStats.compactedMessages || 0, originalMessages: contextStats.originalMessages || 0, inputCharsBeforeCompact: contextStats.inputCharsBeforeCompact || 0 });
                    return res.json({ ok: true, message: { role: 'assistant', content: message.content || '' }, toolResults, provider: { id: provider.id, name: provider.name, type: provider.type }, model, metrics: { durationMs, providerMs, toolMs, providerCalls, toolResults: toolResults.length, compactedMessages: contextStats.compactedMessages || 0, originalMessages: contextStats.originalMessages || 0, inputCharsBeforeCompact: contextStats.inputCharsBeforeCompact || 0 } });
                }
                messages = [...messages, { role: 'assistant', content: message.content || '', tool_calls: message.tool_calls, response_id: message.response_id || '', parts: Array.isArray(message.parts) ? message.parts : undefined }];
                const followupToolMessages = [];
                for (const call of calls) {
                    throwIfAborted(abortController.signal);
                    const startedAt = Date.now();
                    let result;
                    let status = 'success';
                    try {
                        result = await executeAiTool(call.name, call.args, { req, context, responseMode: openAiApiMode(provider), signal: abortController.signal }, deps);
                    } catch (toolErr) {
                        if (toolErr?.name === 'AbortError' || abortController.signal.aborted) throw toolErr;
                        status = 'error';
                        result = { ok: false, error: publicError(toolErr), hint: '工具调用失败。请根据错误修正下一步：例如打开已有连接应先 list_connections 再 open_connection；不要把打开连接误用为 connection_create。' };
                    }
                    throwIfAborted(abortController.signal);
                    const endedAt = Date.now();
                    toolMs += endedAt - startedAt;
                    if (result?.confirmationRequired) {
                        return res.json({ ok: true, message: { role: 'assistant', content: message.content || '需要用户确认后继续执行。' }, confirmationRequired: true, confirmation: result.confirmation, toolResults });
                    }
                    const publicArgs = publicToolArgs(call.name, call.args);
                    toolResults.push({ tool: call.name, args: publicArgs, result, status, startedAt, endedAt, durationMs: endedAt - startedAt });
                    if (result?.clientCaptureRequired) {
                        return res.json({ ok: true, message: { role: 'assistant', content: message.content || '正在读取最新远程桌面画面。' }, toolResults, clientCaptureRequired: true, clientCapture: { tool: call.name, args: publicArgs, toolCallId: call.id, tabId: result.tabId || publicArgs.tabId || '', maxWidth: result.maxWidth || publicArgs.maxWidth || 640, targets: result.targets || [] }, provider: { id: provider.id, name: provider.name, type: provider.type }, model });
                    }
                    const toolMessage = toolResultMessage(call, result, openAiApiMode(provider), limits, provider.type || '');
                    const toolMessages = Array.isArray(toolMessage) ? toolMessage : [toolMessage];
                    for (const item of toolMessages) {
                        if (item?.role === 'user') followupToolMessages.push(item);
                        else messages.push(item);
                    }
                }
                if (followupToolMessages.length) messages.push(...followupToolMessages);
            }
            const durationMs = Date.now() - requestStartedAt;
            recordAiPerf({ status: 'tool_limit', durationMs, providerMs, toolMs, providerCalls, toolResults: toolResults.length, model, provider: provider.name || provider.type, compactedMessages: contextStats.compactedMessages || 0, originalMessages: contextStats.originalMessages || 0, inputCharsBeforeCompact: contextStats.inputCharsBeforeCompact || 0 });
            res.json({ ok: true, message: { role: 'assistant', content: '已达到工具调用轮次上限，请根据上方工具结果继续。' }, toolResults, metrics: { durationMs, providerMs, toolMs, providerCalls, toolResults: toolResults.length, compactedMessages: contextStats.compactedMessages || 0, originalMessages: contextStats.originalMessages || 0, inputCharsBeforeCompact: contextStats.inputCharsBeforeCompact || 0 } });
        } catch (err) {
            if (err?.name === 'AbortError' || abortController.signal.aborted) {
                console.info('[ai-agent] chat aborted by client');
                if (!res.headersSent && !res.destroyed && !res.writableEnded) return res.status(499).json({ error: 'AI 请求已停止' });
                return;
            }
            console.error('[ai-agent] chat failed:', err);
            const status = isTransientAiFetchError(err) ? 502 : 400;
            recordAiPerf({ status: 'error', durationMs: 0, error: publicError(err).slice(0, 240) });
            res.status(status).json({ error: publicError(err), transient: status === 502 });
        } finally {
            req.off?.('aborted', abortRequest);
            res.off?.('close', abortRequest);
        }
    });

    app.get('/api/ai/metrics', deps.requireAuth, (req, res) => {
        res.json({ ok: true, metrics: aiPerfSnapshot() });
    });

    app.post('/api/ai/voice/transcribe', deps.requireAuth, deps.upload.single('audio'), async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled) return res.status(403).json({ error: 'AI 助理未启用' });
            const provider = (Array.isArray(ai.providers) ? ai.providers : []).find((p) => p.enabled !== false && (p.type === 'openai' || p.type === 'openai-compatible') && (p.apiKey || p.envKey));
            if (!provider) return res.status(400).json({ error: '语音转文字需要一个 OpenAI/OpenAI-compatible Provider' });
            if (!req.file?.buffer?.length) return res.status(400).json({ error: '未收到语音数据' });
            const apiKey = provider.apiKey || process.env[provider.envKey] || '';
            if (!apiKey) return res.status(400).json({ error: 'Provider API Key 未配置' });
            const baseUrl = String(provider.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
            const form = new FormData();
            form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'voice.webm');
            form.append('model', ai.voice?.transcribeModel || provider.options?.transcribeModel || 'whisper-1');
            form.append('language', req.body?.language || 'zh');
            const response = await fetch(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error?.message || data.message || `语音转文字失败（HTTP ${response.status}）`);
            res.json({ ok: true, text: data.text || '' });
        } catch (err) { res.status(400).json({ error: publicError(err) }); }
    });

    app.post('/api/ai/providers/:id/open', deps.requireAuth, async (req, res) => {
        try {
            if (typeof deps.verifySensitiveAccess !== 'function') return res.status(403).json({ error: '敏感信息验证不可用' });
            const auth = deps.verifySensitiveAccess(req, req.body?.secret);
            const ai = deps.storage.getSettings().ai || {};
            const provider = (Array.isArray(ai.providers) ? ai.providers : []).find((p) => p.id === req.params.id);
            if (!provider) return res.status(404).json({ error: '模型供应商不存在' });
            deps.addActivity?.(`查看 AI Provider API Key：${provider.name || provider.id}`);
            console.info('[ai-secret-open] reveal provider api key', { providerId: provider.id, name: provider.name, hasApiKey: !!provider.apiKey, authMethod: auth.method });
            res.json({ providerId: provider.id, apiKey: provider.apiKey || '', hasApiKey: !!provider.apiKey });
        } catch (err) { res.status(403).json({ error: publicError(err) }); }
    });

    app.post('/api/ai/tools/run', deps.requireAuth, async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled) return res.status(403).json({ error: 'AI 助理未启用' });
            const result = await executeAiTool(String(req.body?.tool || ''), req.body?.args || {}, { req, context: req.body?.context || {} }, deps);
            res.json({ ok: true, result });
        } catch (err) { res.status(400).json({ error: publicError(err) }); }
    });

    app.post('/api/ai/confirm/:id', deps.requireAuth, async (req, res) => {
        const abortController = new AbortController();
        const abortRequest = () => {
            if (res.writableEnded) return;
            abortController.abort();
        };
        req.on('aborted', abortRequest);
        res.on('close', abortRequest);
        try {
            cleanupPendingActions();
            const item = pendingActions.get(req.params.id);
            if (!item || item.username !== req.session.username) return res.status(404).json({ error: '确认请求不存在或已过期' });
            pendingActions.delete(req.params.id);
            if (req.body?.approve === false) return res.json({ ok: true, cancelled: true });
            const startedAt = Date.now();
            throwIfAborted(abortController.signal);
            const result = await executeAiTool(item.toolName, item.rawArgs || item.args || {}, { req, confirmed: true, context: item.context || {}, signal: abortController.signal }, deps);
            throwIfAborted(abortController.signal);
            const endedAt = Date.now();
            res.json({ ok: true, toolName: item.toolName, args: publicToolArgs(item.toolName, item.rawArgs || item.args || {}), result, status: 'success', startedAt, endedAt, durationMs: endedAt - startedAt });
        } catch (err) {
            if (err?.name === 'AbortError' || abortController.signal.aborted) {
                console.info('[ai-agent] confirmed action aborted by client');
                if (!res.headersSent && !res.destroyed && !res.writableEnded) return res.status(499).json({ error: 'AI 请求已停止' });
                return;
            }
            res.status(400).json({ error: publicError(err) });
        } finally {
            req.off?.('aborted', abortRequest);
            res.off?.('close', abortRequest);
        }
    });

    app.post('/api/ai/complete', deps.requireAuth, async (req, res) => {
        try {
            const ai = deps.storage.getSettings().ai || {};
            if (!ai.enabled || ai.codeCompletionEnabled === false || ai.permissions?.codeEdit === false) return res.json({ suggestions: [] });
            res.json(await completeWithProvider(ai, req.body || {}));
        } catch (err) {
            console.warn('[ai-agent] completion failed:', err.message);
            res.json({ suggestions: [], error: publicError(err) });
        }
    });
}

module.exports = { registerAiRoutes, normalizeAiSettingsInput, safeAiSettings };
