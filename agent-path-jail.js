'use strict';

/**
 * Share-root path jail for Agent file operations (ZEPHYR-LINK §8 / D15).
 * String normalization first; optional realpath only when the target exists.
 */

const fs = require('fs');
const path = require('path');

const WIN32_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function fail(reason) {
    return { ok: false, code: 'path_escape', reason };
}

function isWin32(opts) {
    if (opts && opts.win32 === true) return true;
    if (opts && opts.platform === 'win32') return true;
    return false;
}

function api(platformWin32) {
    return platformWin32 ? path.win32 : path.posix;
}

function hasNul(value) {
    return value.includes('\0');
}

function looksAbsolute(requested, platformWin32) {
    if (platformWin32) {
        if (/^[A-Za-z]:[\\/]/.test(requested)) return true;
        if (requested.startsWith('\\\\') || requested.startsWith('//')) return true;
        if (requested.startsWith('/') || requested.startsWith('\\')) return true;
        return false;
    }
    return requested.startsWith('/');
}

function hasAds(requested) {
    return requested.includes(':');
}

function reservedWin32Segment(segment) {
    const base = String(segment || '').split('.')[0].toUpperCase();
    return WIN32_RESERVED.has(base);
}

function resolveUnderShare(shareRoot, requestedPath, opts = {}) {
    const platformWin32 = isWin32(opts);
    const p = api(platformWin32);
    if (typeof shareRoot !== 'string' || !shareRoot.trim()) {
        return fail('share root missing');
    }
    if (requestedPath == null) return fail('path missing');
    if (typeof requestedPath !== 'string') return fail('path not a string');
    if (hasNul(requestedPath) || hasNul(shareRoot)) return fail('nul');

    const requested = requestedPath;
    if (looksAbsolute(requested, platformWin32)) return fail('absolute path');
    if (platformWin32 && (requested.startsWith('\\\\') || requested.startsWith('//'))) {
        return fail('unc');
    }
    if (platformWin32 && hasAds(requested) && !/^[A-Za-z]:$/.test(requested)) {
        return fail('ads');
    }

    const rootResolved = p.resolve(shareRoot);
    const joined = p.resolve(rootResolved, requested);
    const relative = p.relative(rootResolved, joined);
    if (relative.startsWith('..') || p.isAbsolute(relative)) return fail('escapes share root');

    if (platformWin32) {
        const segments = relative.split(/[\\/]/).filter(Boolean);
        if (segments.some(reservedWin32Segment)) return fail('reserved name');
    }

    let absolute = joined;
    if (typeof opts.realpath === 'function' || opts.followSymlinks === true) {
        const realFn = typeof opts.realpath === 'function' ? opts.realpath : (target) => {
            try { return fs.realpathSync(target); } catch { return null; }
        };
        const real = realFn(joined);
        if (real) {
            const realRoot = (() => {
                try { return fs.realpathSync(rootResolved); } catch { return rootResolved; }
            })();
            const realRel = p.relative(realRoot, real);
            if (realRel.startsWith('..') || p.isAbsolute(realRel)) return fail('symlink escape');
            absolute = real;
        }
    }

    return {
        ok: true,
        relative: relative === '' ? '.' : relative,
        absolute,
    };
}

module.exports = {
    resolveUnderShare,
};
