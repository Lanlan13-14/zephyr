'use strict';

/**
 * Share-root path jail for Agent file operations (ZEPHYR-LINK §8 / D15).
 * Resolve existing path components one at a time so an escaping parent symlink
 * cannot hide behind a non-existing final leaf.
 */

const fs = require('fs');
const path = require('path');

const WIN32_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function fail(reason) { return { ok: false, code: 'path_escape', reason }; }
function isWin32(opts) { return opts?.win32 === true || opts?.platform === 'win32'; }
function api(platformWin32) { return platformWin32 ? path.win32 : path.posix; }
function hasNul(value) { return value.includes('\0'); }
function looksAbsolute(requested, platformWin32) {
    if (!platformWin32) return requested.startsWith('/');
    return /^[A-Za-z]:[\\/]/.test(requested) || requested.startsWith('\\\\')
        || requested.startsWith('//') || requested.startsWith('/') || requested.startsWith('\\');
}
function reservedWin32Segment(segment) {
    return WIN32_RESERVED.has(String(segment || '').split('.')[0].toUpperCase());
}

function resolveUnderShare(shareRoot, requestedPath, opts = {}) {
    const platformWin32 = isWin32(opts);
    const p = api(platformWin32);
    if (typeof shareRoot !== 'string' || !shareRoot.trim()) return fail('share root missing');
    if (typeof requestedPath !== 'string') return fail('path not a string');
    if (hasNul(requestedPath) || hasNul(shareRoot)) return fail('nul');
    if (looksAbsolute(requestedPath, platformWin32)) return fail('absolute path');
    if (platformWin32 && requestedPath.includes(':')) return fail('ads');

    const rootResolved = p.resolve(shareRoot);
    const joined = p.resolve(rootResolved, requestedPath);
    const relative = p.relative(rootResolved, joined);
    if (relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) {
        return fail('escapes share root');
    }
    if (platformWin32 && relative.split(/[\\/]/).filter(Boolean).some(reservedWin32Segment)) {
        return fail('reserved name');
    }

    const realFn = typeof opts.realpath === 'function' ? opts.realpath : (target) => {
        try { return fs.realpathSync(target); } catch { return null; }
    };
    let realRoot;
    try { realRoot = fs.realpathSync(rootResolved); } catch { realRoot = rootResolved; }
    const inside = (target) => {
        const rel = p.relative(realRoot, target);
        return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
    };

    let absolute = joined;
    let candidate = rootResolved;
    const parts = relative === '' ? [] : relative.split(p.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
        candidate = p.join(candidate, parts[index]);
        let real;
        try { real = realFn(candidate); } catch { real = null; }
        if (real) {
            if (!inside(real)) return fail('symlink escape');
            absolute = real;
        }
    }
    return { ok: true, relative: relative === '' ? '.' : relative, absolute };
}

module.exports = { resolveUnderShare };
