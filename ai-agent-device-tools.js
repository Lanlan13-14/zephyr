'use strict';

const path = require('path').posix;
const { HttpError } = require('./authz');

const AGENT_LIST_SCHEMA = Object.freeze({ type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, additionalProperties: false });
const AGENT_GET_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['agentId'], additionalProperties: false });
const AGENT_FILE_LIST_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 }, path: { type: 'string', maxLength: 2000 } }, required: ['agentId'], additionalProperties: false });
const AGENT_FILE_STAT_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 }, path: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['agentId', 'path'], additionalProperties: false });
const AGENT_FILE_READ_TEXT_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 }, path: { type: 'string', minLength: 1, maxLength: 2000 }, maxBytes: { type: 'number', minimum: 1, maximum: 262144 }, encoding: { type: 'string', enum: ['utf8', 'utf-8'] } }, required: ['agentId', 'path'], additionalProperties: false });
const AGENT_FILE_MKDIR_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 }, path: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['agentId', 'path'], additionalProperties: false });
const AGENT_FILE_RENAME_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 }, oldPath: { type: 'string', minLength: 1, maxLength: 2000 }, newPath: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['agentId', 'oldPath', 'newPath'], additionalProperties: false });
const AGENT_FILE_DELETE_SCHEMA = Object.freeze({ type: 'object', properties: { agentId: { type: 'string', minLength: 1, maxLength: 160 }, path: { type: 'string', minLength: 1, maxLength: 2000 }, recursive: { type: 'boolean' } }, required: ['agentId', 'path'], additionalProperties: false });
const AGENT_FILE_WRITE_TEXT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        agentId: { type: 'string', minLength: 1, maxLength: 160 },
        path: { type: 'string', minLength: 1, maxLength: 2000 },
        content: { type: 'string', maxLength: 262144 },
        encoding: { type: 'string', enum: ['utf8', 'utf-8'] },
        append: { type: 'boolean' },
    },
    required: ['agentId', 'path', 'content'],
    additionalProperties: false,
});

function normalizeAgentPath(value = '/', { allowRoot = true } = {}) {
    const raw = String(value || '/').replace(/\\/g, '/').trim();
    if (/^[A-Za-z]:/.test(raw) || raw.includes('\0')) throw new HttpError(400, 'invalid_agent_path', 'Agent 路径格式无效');
    const segments = raw.split('/').filter(Boolean);
    let depth = 0;
    for (const segment of segments) {
        if (segment === '.') continue;
        if (segment === '..') {
            depth -= 1;
            if (depth < 0) throw new HttpError(400, 'invalid_agent_path', 'Agent 路径不能逃逸共享根目录');
        } else depth += 1;
    }
    const normalized = path.normalize(raw.startsWith('/') ? raw : `/${raw}`);
    if (!allowRoot && normalized === '/') throw new HttpError(400, 'invalid_agent_path', '此操作不允许使用 Agent 根目录');
    return normalized;
}

function publicAgent(info = {}) {
    return {
        agentId: String(info.agentId || ''),
        deviceId: String(info.deviceId || ''),
        deviceName: String(info.deviceName || ''),
        platform: String(info.platform || 'unknown'),
        online: !!info.online,
        readOnly: info.readOnly !== false,
        shareName: String(info.shareName || info.deviceName || ''),
        capabilities: { ...(info.capabilities || {}) },
        protocolVersion: Number(info.protocolVersion || 1),
        maxInflight: Number(info.maxInflight || 1),
        maxChunkSize: Number(info.maxChunkSize || 0),
        appVersion: String(info.appVersion || ''),
        connectedAt: Number(info.connectedAt || 0),
        lastSeenAt: Number(info.lastSeenAt || 0),
    };
}

function requireOwnedAgent(manager, user, agentId) {
    if (!manager || !user || !manager.isAgentOwnedByUser(String(agentId), user)) {
        throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Agent 不存在、离线或无权访问');
    }
    const info = manager.getAgentInfo(String(agentId));
    if (!info?.online) throw new HttpError(503, 'agent_offline', 'Agent 当前离线', true);
    return info;
}

async function readText(manager, user, args) {
    const info = requireOwnedAgent(manager, user, args.agentId);
    const filePath = normalizeAgentPath(args.path, { allowRoot: false });
    const stat = await manager.callAgent(args.agentId, 'stat', { path: filePath });
    if (stat?.isDir) throw new HttpError(400, 'agent_path_is_directory', 'Agent 路径是目录，不能按文本读取');
    const maxBytes = Math.max(1, Math.min(262144, Number(args.maxBytes) || 65536));
    const requested = Math.min(maxBytes, Math.max(0, Number(stat?.size) || maxBytes));
    let handle = '';
    try {
        const opened = await manager.callAgent(args.agentId, 'open', { path: filePath, mode: 'read' });
        handle = String(opened?.handle || '');
        if (!handle) throw new HttpError(502, 'agent_open_failed', 'Agent 未返回文件句柄', true);
        let data;
        if (info.capabilities?.binaryRead === true) data = await manager.callAgentBinaryReadCached(args.agentId, { handle, offset: 0, length: requested });
        else throw new HttpError(426, 'agent_binary_read_required', 'Agent 版本不支持安全二进制读取，请升级 Agent');
        const text = Buffer.from(data || []).toString('utf8');
        return { agent: publicAgent(info), path: filePath, text, bytesRead: Buffer.byteLength(text, 'utf8'), size: Number(stat?.size || 0), truncated: Number(stat?.size || 0) > requested, mtime: Number(stat?.mtime || 0) };
    } finally {
        if (handle) await manager.callAgent(args.agentId, 'close', { handle }).catch(() => {});
    }
}

async function callAgentV2(manager, agentId, method, params = {}) {
    if (typeof manager.callAgentV2 !== 'function') {
        throw new HttpError(501, 'agent_v2_required', '当前 Agent 管理器不支持 writeBinary');
    }
    const inv = manager.callAgentV2(agentId, method, params);
    return inv?.promise ? inv.promise : inv;
}

async function writeText(manager, user, args) {
    const info = requireOwnedAgent(manager, user, args.agentId);
    const readOnly = info.readOnly === true || info?.share?.readOnly === true;
    if (readOnly) throw new HttpError(403, 'agent_read_only', 'Agent 共享目录只读，不能写入');
    const filePath = normalizeAgentPath(args.path, { allowRoot: false });
    const content = String(args.content || '');
    const maxBytes = 262144;
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length > maxBytes) throw new HttpError(400, 'agent_write_too_large', `写入内容超过 ${maxBytes} bytes`);
    let offset = 0;
    let mode = 'writeTruncate';
    if (args.append === true) {
        try {
            const stat = await manager.callAgent(args.agentId, 'stat', { path: filePath });
            if (stat?.isDir) throw new HttpError(400, 'agent_path_is_directory', 'Agent 路径是目录，不能写入文本');
            offset = Math.max(0, Number(stat?.size || 0));
            mode = 'write';
        } catch (err) {
            if (err?.status === 400) throw err;
            mode = 'writeTruncate';
            offset = 0;
        }
    }
    let handle = '';
    try {
        const opened = await callAgentV2(manager, args.agentId, 'open', { path: filePath, mode });
        handle = String(opened?.handle || opened?.result?.handle || '');
        if (!handle) {
            // fallback to legacy open RPC if v2 open shape differs
            const legacy = await manager.callAgent(args.agentId, 'open', { path: filePath, mode });
            handle = String(legacy?.handle || '');
        }
        if (!handle) throw new HttpError(502, 'agent_open_failed', 'Agent 未返回可写句柄', true);
        const chunkSize = Math.max(16 * 1024, Math.min(256 * 1024, Number(info.maxChunkSize || 256 * 1024) || 256 * 1024));
        let written = 0;
        while (written < buffer.length) {
            const slice = buffer.subarray(written, Math.min(buffer.length, written + chunkSize));
            await callAgentV2(manager, args.agentId, 'writeBinary', {
                handle,
                offset: offset + written,
                data: slice,
            });
            written += slice.length;
        }
        return {
            agent: publicAgent(info),
            path: filePath,
            bytes: buffer.length,
            append: args.append === true,
            mode,
        };
    } finally {
        if (handle) {
            try { await callAgentV2(manager, args.agentId, 'close', { handle }); }
            catch { await manager.callAgent(args.agentId, 'close', { handle }).catch(() => {}); }
        }
    }
}

module.exports = {
    AGENT_LIST_SCHEMA,
    AGENT_GET_SCHEMA,
    AGENT_FILE_LIST_SCHEMA,
    AGENT_FILE_STAT_SCHEMA,
    AGENT_FILE_READ_TEXT_SCHEMA,
    AGENT_FILE_MKDIR_SCHEMA,
    AGENT_FILE_RENAME_SCHEMA,
    AGENT_FILE_DELETE_SCHEMA,
    AGENT_FILE_WRITE_TEXT_SCHEMA,
    normalizeAgentPath,
    publicAgent,
    requireOwnedAgent,
    readText,
    writeText,
};

