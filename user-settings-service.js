'use strict';
/*
 * user-settings-service.js — three-layer settings (FREEZE plan §15):
 *   systemSettings  — platform runtime / security (admin only)
 *   adminDefaults   — brand & appearance defaults (admin writes; users read)
 *   userSettings    — personal overrides (per userId)
 *
 * Merge order: system force > user override (allowed keys) > admin default > built-in.
 */
const { HttpError } = require('./authz');

/* Keys ordinary users may put into their personal override bag. Anything else
 * is rejected on PUT /api/me/settings. */
const USER_ALLOWED_KEYS = new Set([
    'appearance.theme',
    'appearance.autoThemeEnabled',
    'appearance.colorScheme',
    'appearance.customThemeMode',
    'appearance.customColors',
    'appearance.customCss',
    'appearance.terminalBackground',
    'appearance.terminalFontColor',
    'terminal.maxWindows',
    'terminal.minimizedKeepAlive',
    'terminal.smartbarOrder',
    'terminal.shortcutPlatform',
    'snippets',
    'notes.enabled',
    'notes.editorMode',
    'notes.fontSize',
    'workspace.defaultView',
    'ai.panelLayout',
    'ai.assistantName',
]);

/* Platform security / system keys ordinary users must never write. */
const SYSTEM_ONLY_KEYS = new Set([
    'security', 'captcha', 'mail', 'dataManage', 'beian', 'version',
    'ai.enabled', 'ai.providers', 'ai.permissions', 'ai.sensitive',
]);

function flatten(obj, prefix = '', out = {}) {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        out[prefix] = obj;
        return out;
    }
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
        else out[path] = v;
    }
    return out;
}

function unflatten(flat) {
    const out = {};
    for (const [path, value] of Object.entries(flat || {})) {
        const parts = path.split('.');
        let cur = out;
        for (let i = 0; i < parts.length - 1; i++) {
            cur[parts[i]] = cur[parts[i]] || {};
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
    }
    return out;
}

function deepMerge(base, override) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? base : override;
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [k, v] of Object.entries(override)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

class UserSettingsService {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {object} storage  for getSettings/updateSettings (system + admin defaults still live there for Stage 3)
     * @param {() => number} [now]
     */
    constructor(db, storage, now = () => Date.now()) {
        this.db = db;
        this.storage = storage;
        this.now = now;
        this.stmtGetAll = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?');
        this.stmtGet = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?');
        this.stmtPut = db.prepare('INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
        this.stmtDelete = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?');
        this.stmtClear = db.prepare('DELETE FROM user_settings WHERE user_id = ?');
    }

    getUserOverrides(userId) {
        const flat = {};
        for (const row of this.stmtGetAll.all(String(userId))) {
            try { flat[row.key] = JSON.parse(row.value); } catch { flat[row.key] = row.value; }
        }
        return unflatten(flat);
    }

    /**
     * Write personal overrides. Only USER_ALLOWED_KEYS are accepted.
     * Returns the new override bag (not the merged view).
     */
    putUserOverrides(userId, patch) {
        if (!patch || typeof patch !== 'object') throw new HttpError(400, 'invalid_settings', '设置格式错误');
        const flat = flatten(patch);
        const rejected = [];
        for (const key of Object.keys(flat)) {
            if (SYSTEM_ONLY_KEYS.has(key) || SYSTEM_ONLY_KEYS.has(key.split('.')[0])) {
                rejected.push(key);
                continue;
            }
            // allow exact match or a prefix of an allowed key path (e.g. appearance.customColors.primary)
            const allowed = USER_ALLOWED_KEYS.has(key)
                || [...USER_ALLOWED_KEYS].some((a) => key === a || key.startsWith(`${a}.`));
            if (!allowed) {
                rejected.push(key);
                continue;
            }
            if (flat[key] === null || flat[key] === undefined) {
                this.stmtDelete.run(String(userId), key);
            } else {
                this.stmtPut.run(String(userId), key, JSON.stringify(flat[key]), this.now());
            }
        }
        if (rejected.length && rejected.length === Object.keys(flat).length) {
            throw new HttpError(403, 'settings_key_forbidden', `不允许修改: ${rejected.slice(0, 5).join(', ')}`);
        }
        return this.getUserOverrides(userId);
    }

    /**
     * Effective settings for a user: admin defaults + personal overrides.
     * System security/mail/captcha are only included for admins.
     */
    effective(user) {
        const global = this.storage.getSettings() || {};
        const overrides = this.getUserOverrides(user.userId);
        // Users never receive other users' secrets; strip AI provider keys for non-owners.
        const base = { ...global };
        if (user.role !== 'admin') {
            // Drop system-only surfaces from the personal view.
            delete base.security;
            delete base.captcha;
            delete base.mail;
            delete base.dataManage;
            if (base.ai) {
                base.ai = {
                    ...base.ai,
                    providers: (base.ai.providers || []).map((p) => ({
                        id: p.id, name: p.name, enabled: p.enabled, models: p.models, baseUrl: p.baseUrl,
                        // never return apiKey to non-admin
                        hasApiKey: !!p.apiKey,
                        apiKey: '',
                    })),
                    envVars: (base.ai.envVars || []).map((e) => ({ id: e.id, name: e.name, hasValue: !!e.value, value: '' })),
                };
            }
        }
        return deepMerge(base, overrides);
    }
}

module.exports = {
    UserSettingsService,
    USER_ALLOWED_KEYS,
    SYSTEM_ONLY_KEYS,
    flatten,
    unflatten,
    deepMerge,
};
