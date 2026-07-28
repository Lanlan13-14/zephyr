'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./authz');

const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12MB single file
const MAX_SESSION_FILES = 80;
const TEXT_INLINE_MAX = 64 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_MIME = new Set([
    'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css', 'text/javascript',
    'application/json', 'application/xml', 'application/x-yaml', 'text/yaml',
]);
const DOC_MIME = new Set(['application/pdf']);

function safeName(name) {
    const base = path.basename(String(name || 'file')).replace(/[^\w.\-()+@\u4e00-\u9fff]+/g, '_');
    return base.slice(0, 120) || 'file';
}

function kindFor(mime, name) {
    const m = String(mime || '').toLowerCase();
    if (IMAGE_MIME.has(m) || /\.(png|jpe?g|webp|gif)$/i.test(name)) return 'image';
    if (m === 'application/pdf' || /\.pdf$/i.test(name)) return 'document';
    if (TEXT_MIME.has(m) || /\.(txt|md|csv|json|ya?ml|log|conf|ini|sh|py|go|js|ts|css|html)$/i.test(name)) return 'text';
    return 'document';
}

function sessionRoot(dataDir, userId, sessionId) {
    const u = String(userId || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    const s = String(sessionId || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    if (!u || !s) throw new HttpError(400, 'bad_session', 'sessionId required');
    return path.join(dataDir, 'ai-sessions', u, s);
}

async function ensureSessionDirs(dataDir, userId, sessionId) {
    const root = sessionRoot(dataDir, userId, sessionId);
    for (const sub of ['uploads', 'workspace', 'outputs', 'ocr', 'spillover']) {
        await fsp.mkdir(path.join(root, sub), { recursive: true });
    }
    return root;
}

class AiSessionFs {
    constructor({ dataDir, maxFileBytes = MAX_FILE_BYTES, maxSessionFiles = MAX_SESSION_FILES } = {}) {
        this.dataDir = dataDir || path.join(process.cwd(), 'data');
        this.maxFileBytes = maxFileBytes;
        this.maxSessionFiles = maxSessionFiles;
    }

    root(userId, sessionId) {
        return sessionRoot(this.dataDir, userId, sessionId);
    }

    async ensure(userId, sessionId) {
        return ensureSessionDirs(this.dataDir, userId, sessionId);
    }

    metaPath(userId, sessionId) {
        return path.join(this.root(userId, sessionId), 'uploads', 'index.json');
    }

    async _readIndex(userId, sessionId) {
        const p = this.metaPath(userId, sessionId);
        try {
            const raw = await fsp.readFile(p, 'utf8');
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    async _writeIndex(userId, sessionId, list) {
        await this.ensure(userId, sessionId);
        const p = this.metaPath(userId, sessionId);
        await fsp.writeFile(p, JSON.stringify(list, null, 2));
    }

    async listAttachments(userId, sessionId) {
        return this._readIndex(userId, sessionId);
    }

    async getAttachment(userId, sessionId, id) {
        const list = await this._readIndex(userId, sessionId);
        const item = list.find((x) => x.id === id);
        if (!item) throw new HttpError(404, 'attachment_not_found', '附件不存在');
        return item;
    }

    async putAttachment(userId, sessionId, { name, mime, buffer }) {
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            throw new HttpError(400, 'empty_file', '空文件');
        }
        if (buffer.length > this.maxFileBytes) {
            throw new HttpError(413, 'file_too_large', `单文件不能超过 ${Math.floor(this.maxFileBytes / 1024 / 1024)}MB`);
        }
        const list = await this._readIndex(userId, sessionId);
        if (list.length >= this.maxSessionFiles) {
            throw new HttpError(400, 'session_file_quota', '本会话附件数量已达上限');
        }
        await this.ensure(userId, sessionId);
        const id = crypto.randomBytes(12).toString('hex');
        const safe = safeName(name);
        const mimeType = String(mime || 'application/octet-stream').toLowerCase();
        const kind = kindFor(mimeType, safe);
        const fileName = `${id}_${safe}`;
        const rel = path.join('uploads', fileName);
        const abs = path.join(this.root(userId, sessionId), rel);
        // path traversal guard
        if (!abs.startsWith(this.root(userId, sessionId))) {
            throw new HttpError(400, 'bad_path', '非法路径');
        }
        await fsp.writeFile(abs, buffer);
        const entry = {
            id,
            name: safe,
            mime: mimeType,
            size: buffer.length,
            kind,
            path: rel,
            createdAt: Date.now(),
        };
        list.push(entry);
        await this._writeIndex(userId, sessionId, list);
        return entry;
    }

    async deleteAttachment(userId, sessionId, id) {
        const list = await this._readIndex(userId, sessionId);
        const item = list.find((x) => x.id === id);
        if (!item) throw new HttpError(404, 'attachment_not_found', '附件不存在');
        const abs = path.join(this.root(userId, sessionId), item.path);
        try { await fsp.unlink(abs); } catch { /* ignore */ }
        const next = list.filter((x) => x.id !== id);
        await this._writeIndex(userId, sessionId, next);
        return true;
    }

    async readAttachmentBytes(userId, sessionId, id) {
        const item = await this.getAttachment(userId, sessionId, id);
        const abs = path.join(this.root(userId, sessionId), item.path);
        const data = await fsp.readFile(abs);
        return { item, data };
    }

    /**
     * Build provider.Message parts for a set of attachment ids.
     * Images become image_url data URLs when model accepts image.
     */
    _resolveWorkspacePath(userId, sessionId, relativePath = '', { allowUploads = true, writable = false } = {}) {
        const root = this.root(userId, sessionId);
        const rel = String(relativePath || '').replace(/^\/+/, '').replace(/\\/g, '/');
        if (!rel || rel.includes('..')) throw new HttpError(400, 'bad_path', '非法路径');
        const first = rel.split('/')[0];
        const allowed = writable
            ? new Set(['workspace', 'outputs'])
            : new Set(allowUploads ? ['uploads', 'workspace', 'outputs', 'ocr', 'spillover'] : ['workspace', 'outputs', 'ocr']);
        if (!allowed.has(first)) throw new HttpError(400, 'bad_path', `路径必须位于 ${[...allowed].join('/')}`);
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(root + path.sep) && abs !== root) throw new HttpError(400, 'bad_path', '非法路径');
        return { abs, rel };
    }

    async listWorkspace(userId, sessionId, { dir = '' } = {}) {
        await this.ensure(userId, sessionId);
        const root = this.root(userId, sessionId);
        const targetRel = String(dir || '').replace(/^\/+/, '') || '';
        const targetAbs = targetRel
            ? this._resolveWorkspacePath(userId, sessionId, targetRel, { allowUploads: true }).abs
            : root;
        const entries = await fsp.readdir(targetAbs, { withFileTypes: true });
        const items = [];
        for (const ent of entries) {
            if (ent.name === 'index.json' && (!targetRel || targetRel === 'uploads')) continue;
            const rel = path.posix.join(targetRel || '', ent.name);
            const abs = path.join(targetAbs, ent.name);
            let size = 0;
            try {
                const st = await fsp.stat(abs);
                size = st.size;
            } catch { /* ignore */ }
            items.push({
                name: ent.name,
                path: rel.replace(/\\/g, '/'),
                type: ent.isDirectory() ? 'dir' : 'file',
                size,
            });
        }
        return { root: 'session', dir: targetRel || '.', items };
    }

    async readWorkspaceFile(userId, sessionId, relativePath, { offset = 0, limit = 120000 } = {}) {
        const { abs, rel } = this._resolveWorkspacePath(userId, sessionId, relativePath, { allowUploads: true });
        const data = await fsp.readFile(abs);
        const start = Math.max(0, Number(offset) || 0);
        const max = Math.min(Math.max(1, Number(limit) || 120000), 200000);
        const slice = data.subarray(start, start + max);
        const text = slice.toString('utf8');
        return {
            path: rel,
            size: data.length,
            offset: start,
            bytes: slice.length,
            truncated: start + slice.length < data.length,
            content: text,
        };
    }

    async writeWorkspaceFile(userId, sessionId, relativePath, content = '') {
        await this.ensure(userId, sessionId);
        const { abs, rel } = this._resolveWorkspacePath(userId, sessionId, relativePath, { writable: true });
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const buf = Buffer.from(String(content ?? ''), 'utf8');
        if (buf.length > this.maxFileBytes) {
            throw new HttpError(413, 'file_too_large', `单文件不能超过 ${Math.floor(this.maxFileBytes / 1024 / 1024)}MB`);
        }
        await fsp.writeFile(abs, buf);
        return { path: rel, size: buf.length, written: true };
    }

    async buildUserParts(userId, sessionId, attachmentIds = [], { allowImage = true, textInlineMax = TEXT_INLINE_MAX } = {}) {
        const parts = [];
        const inventory = [];
        for (const id of attachmentIds) {
            const { item, data } = await this.readAttachmentBytes(userId, sessionId, id);
            inventory.push({
                id: item.id,
                name: item.name,
                mime: item.mime,
                size: item.size,
                kind: item.kind,
            });
            if (item.kind === 'image' && allowImage) {
                const mime = IMAGE_MIME.has(item.mime) ? item.mime : 'image/png';
                const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
                parts.push({ type: 'text', text: `[attached image: ${item.id} | ${item.name}]` });
                parts.push({ type: 'image_url', imageUrl: dataUrl, mimeType: mime });
            } else if (item.kind === 'text' && data.length <= textInlineMax) {
                parts.push({
                    type: 'text',
                    text: `[attached text: ${item.id} | ${item.name}]\n${data.toString('utf8')}`,
                });
            } else {
                parts.push({
                    type: 'text',
                    text: `[attached file: ${item.id} | ${item.name} | ${item.mime} | ${item.size} bytes — use workspace/attachment tools to read]`,
                });
            }
        }
        if (inventory.length) {
            parts.push({ type: 'text', text: `附件清单：${JSON.stringify(inventory)}` });
        }
        return { parts, inventory };
    }
}

module.exports = {
    AiSessionFs,
    kindFor,
    safeName,
    MAX_FILE_BYTES,
    TEXT_INLINE_MAX,
    IMAGE_MIME,
    DOC_MIME,
};
