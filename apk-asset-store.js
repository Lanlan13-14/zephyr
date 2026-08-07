'use strict';

const path = require('path');

function normalizeAssetPath(value) {
    let decoded;
    try {
        decoded = decodeURIComponent(String(value || ''));
    } catch {
        return null;
    }
    const normalized = path.posix.normalize(`/${decoded.replace(/\\/g, '/')}`).slice(1);
    if (!normalized || normalized === '.') return '';
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
    return normalized;
}

class ApkAssetStore {
    constructor(apkPath, prefix = 'assets/zephyr-public') {
        this.apkPath = path.resolve(apkPath);
        this.prefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
        this._entriesPromise = null;
    }

    async entries() {
        if (!this._entriesPromise) {
            const { Open } = require('unzipper');
            this._entriesPromise = Open.file(this.apkPath).then((directory) => {
                const entries = new Map();
                const prefix = this.prefix ? `${this.prefix}/` : '';
                for (const entry of directory.files) {
                    const entryPath = String(entry.path || '').replace(/\\/g, '/');
                    if (entry.type !== 'File' || !entryPath.startsWith(prefix)) continue;
                    const relative = normalizeAssetPath(entryPath.slice(prefix.length));
                    if (relative) entries.set(relative, entry);
                }
                return entries;
            });
        }
        return this._entriesPromise;
    }

    async entry(relativePath) {
        const relative = normalizeAssetPath(relativePath);
        if (!relative) return null;
        return (await this.entries()).get(relative) || null;
    }

    async readText(relativePath) {
        const entry = await this.entry(relativePath);
        if (!entry) return null;
        return (await entry.buffer()).toString('utf8');
    }

    async send(req, res, relativePath, setHeaders) {
        const entry = await this.entry(relativePath);
        if (!entry) return false;

        const safePath = normalizeAssetPath(relativePath);
        if (typeof setHeaders === 'function') setHeaders(res, safePath);
        res.type(safePath);
        res.setHeader('Accept-Ranges', 'bytes');

        const total = Number(entry.uncompressedSize) || 0;
        const range = String(req?.headers?.range || '');
        if (range && total > 0) {
            const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
            if (!match) {
                res.status(416).setHeader('Content-Range', `bytes */${total}`);
                res.end();
                return true;
            }
            let start = match[1] ? Number(match[1]) : 0;
            let end = match[2] ? Number(match[2]) : total - 1;
            if (!match[1] && match[2]) {
                const suffix = Math.max(0, Number(match[2]));
                start = Math.max(0, total - suffix);
                end = total - 1;
            }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) {
                res.status(416).setHeader('Content-Range', `bytes */${total}`);
                res.end();
                return true;
            }
            end = Math.min(end, total - 1);
            const bytes = await entry.buffer();
            const part = bytes.subarray(start, end + 1);
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
            res.setHeader('Content-Length', String(part.length));
            if (req.method === 'HEAD') res.end();
            else res.end(part);
            return true;
        }

        if (total > 0) res.setHeader('Content-Length', String(total));
        if (req?.method === 'HEAD') {
            res.end();
            return true;
        }
        const stream = entry.stream();
        stream.on('error', (error) => {
            if (!res.headersSent) res.status(500);
            res.destroy(error);
        });
        stream.pipe(res);
        return true;
    }

    middleware(options = {}) {
        const root = normalizeAssetPath(options.root || '') || '';
        const index = options.index === false ? null : String(options.index || 'index.html');
        return async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            let relative = normalizeAssetPath(req.path || req.url || '');
            if (relative === null) return res.status(400).end();
            if (!relative && index) relative = index;
            const target = root ? path.posix.join(root, relative || '') : relative;
            try {
                if (!(await this.send(req, res, target, options.setHeaders))) next();
            } catch (error) {
                next(error);
            }
        };
    }
}

function createApkAssetStore(apkPath, prefix) {
    const value = String(apkPath || '').trim();
    return value ? new ApkAssetStore(value, prefix) : null;
}

module.exports = { ApkAssetStore, createApkAssetStore, normalizeAssetPath };
