'use strict';

const pathPosix = require('path').posix;

const SFTP_LIST_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        path: { type: 'string', maxLength: 4000 },
        limit: { type: 'number', minimum: 1, maximum: 1000 },
    },
    required: ['connectionId'],
    additionalProperties: false,
});

const SFTP_STAT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        path: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    required: ['connectionId', 'path'],
    additionalProperties: false,
});

const SFTP_MKDIR_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        path: { type: 'string', minLength: 1, maxLength: 4000 },
        recursive: { type: 'boolean' },
    },
    required: ['connectionId', 'path'],
    additionalProperties: false,
});

const SFTP_RENAME_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        oldPath: { type: 'string', minLength: 1, maxLength: 4000 },
        newPath: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    required: ['connectionId', 'oldPath', 'newPath'],
    additionalProperties: false,
});

const SFTP_DELETE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        path: { type: 'string', minLength: 1, maxLength: 4000 },
        recursive: { type: 'boolean' },
    },
    required: ['connectionId', 'path'],
    additionalProperties: false,
});

const SFTP_CHMOD_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        path: { type: 'string', minLength: 1, maxLength: 4000 },
        mode: { type: 'string', minLength: 3, maxLength: 6, description: 'octal mode like 644 or 0755' },
    },
    required: ['connectionId', 'path', 'mode'],
    additionalProperties: false,
});

function normalizeRemotePath(value = '/', { allowRoot = true } = {}) {
    const raw = String(value || '/').replace(/\\/g, '/').trim() || '/';
    if (raw.includes('\0')) {
        const error = new Error('远程路径无效');
        error.code = 'invalid_remote_path';
        throw error;
    }
    if (raw.split('/').some((part) => part === '..')) {
        const error = new Error('远程路径不能包含 .. 段');
        error.code = 'invalid_remote_path';
        throw error;
    }
    const normalized = pathPosix.normalize(raw.startsWith('/') ? raw : `/${raw}`);
    if (normalized.split('/').some((part) => part === '..') || normalized.includes('\0')) {
        const error = new Error('远程路径不能包含 .. 段');
        error.code = 'invalid_remote_path';
        throw error;
    }
    if (!allowRoot && (normalized === '/' || normalized === '')) {
        const error = new Error('不允许操作根路径');
        error.code = 'invalid_remote_path';
        throw error;
    }
    return normalized === '' ? '/' : normalized;
}

function modeFromString(mode = '') {
    const text = String(mode || '').trim();
    if (!/^[0-7]{3,4}$/.test(text)) {
        const error = new Error('mode 必须是 3–4 位八进制，例如 644 或 0755');
        error.code = 'invalid_mode';
        throw error;
    }
    return parseInt(text, 8);
}

function publicSftpEntry(item = {}, parentPath = '/') {
    const name = String(item.filename || item.name || '');
    const longname = String(item.longname || '');
    const attrs = item.attrs || item.attributes || {};
    const mode = Number(attrs.mode || 0);
    const isDir = (mode & 0o170000) === 0o040000 || longname.startsWith('d');
    const isLink = (mode & 0o170000) === 0o120000 || longname.startsWith('l');
    const fullPath = name === '.' || name === '..'
        ? name
        : pathPosix.join(parentPath === '/' ? '/' : parentPath, name);
    return {
        name,
        path: fullPath,
        type: isDir ? 'd' : (isLink ? 'l' : 'f'),
        size: Number(attrs.size || 0),
        mtime: Number(attrs.mtime || 0),
        atime: Number(attrs.atime || 0),
        mode: mode ? (mode & 0o777).toString(8).padStart(3, '0') : '',
        uid: Number(attrs.uid || 0),
        gid: Number(attrs.gid || 0),
    };
}

function publicSftpStat(targetPath = '/', attrs = {}) {
    const mode = Number(attrs.mode || 0);
    const isDir = (mode & 0o170000) === 0o040000;
    const isLink = (mode & 0o170000) === 0o120000;
    return {
        path: targetPath,
        type: isDir ? 'd' : (isLink ? 'l' : 'f'),
        size: Number(attrs.size || 0),
        mtime: Number(attrs.mtime || 0),
        atime: Number(attrs.atime || 0),
        mode: mode ? (mode & 0o777).toString(8).padStart(3, '0') : '',
        uid: Number(attrs.uid || 0),
        gid: Number(attrs.gid || 0),
    };
}

function sftpReaddir(sftp, targetPath) {
    return new Promise((resolve, reject) => {
        sftp.readdir(targetPath, (err, list) => (err ? reject(err) : resolve(list || [])));
    });
}

function sftpMkdir(sftp, targetPath) {
    return new Promise((resolve, reject) => {
        sftp.mkdir(targetPath, (err) => (err ? reject(err) : resolve()));
    });
}

function sftpRename(sftp, oldPath, newPath) {
    return new Promise((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
    });
}

function sftpUnlink(sftp, targetPath) {
    return new Promise((resolve, reject) => {
        sftp.unlink(targetPath, (err) => (err ? reject(err) : resolve()));
    });
}

function sftpRmdir(sftp, targetPath) {
    return new Promise((resolve, reject) => {
        sftp.rmdir(targetPath, (err) => (err ? reject(err) : resolve()));
    });
}

function sftpChmod(sftp, targetPath, mode) {
    return new Promise((resolve, reject) => {
        sftp.chmod(targetPath, mode, (err) => (err ? reject(err) : resolve()));
    });
}

async function sftpMkdirRecursive(sftp, targetPath) {
    const normalized = normalizeRemotePath(targetPath, { allowRoot: false });
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current += `/${part}`;
        try {
            await sftpMkdir(sftp, current);
        } catch (err) {
            const code = Number(err?.code || 0);
            // already exists
            if (code === 4 || /Failure|exists|EEXIST/i.test(String(err?.message || ''))) continue;
            // if path exists as file/dir, try stat
            try {
                await new Promise((resolve, reject) => sftp.stat(current, (e, st) => (e ? reject(e) : resolve(st))));
                continue;
            } catch {
                throw err;
            }
        }
    }
    return normalized;
}

async function sftpDeleteRecursive(sftp, targetPath, { maxEntries = 5000 } = {}) {
    const normalized = normalizeRemotePath(targetPath, { allowRoot: false });
    let removed = 0;
    async function walk(p) {
        if (removed >= maxEntries) {
            const error = new Error(`递归删除条目超过上限 ${maxEntries}`);
            error.code = 'sftp_delete_limit';
            throw error;
        }
        let attrs;
        try {
            attrs = await new Promise((resolve, reject) => sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st))));
        } catch (err) {
            if (Number(err?.code) === 2) return;
            throw err;
        }
        const mode = Number(attrs.mode || 0);
        const isDir = (mode & 0o170000) === 0o040000;
        if (!isDir) {
            await sftpUnlink(sftp, p);
            removed += 1;
            return;
        }
        const list = await sftpReaddir(sftp, p);
        for (const item of list) {
            if (item.filename === '.' || item.filename === '..') continue;
            await walk(pathPosix.join(p, item.filename));
        }
        await sftpRmdir(sftp, p);
        removed += 1;
    }
    await walk(normalized);
    return { path: normalized, removed };
}

module.exports = {
    SFTP_LIST_SCHEMA,
    SFTP_STAT_SCHEMA,
    SFTP_MKDIR_SCHEMA,
    SFTP_RENAME_SCHEMA,
    SFTP_DELETE_SCHEMA,
    SFTP_CHMOD_SCHEMA,
    normalizeRemotePath,
    modeFromString,
    publicSftpEntry,
    publicSftpStat,
    sftpReaddir,
    sftpMkdir,
    sftpRename,
    sftpUnlink,
    sftpRmdir,
    sftpChmod,
    sftpMkdirRecursive,
    sftpDeleteRecursive,
};
