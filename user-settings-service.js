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
const { SnippetService } = require('./snippet-service');
const {
    PersonalSettingsSectionService,
    PERSONAL_SYNC_FIELDS,
} = require('./personal-settings-section-service');
const { AiKnowledgeService } = require('./mobile-v1-ai-knowledge-entities');

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
    'appearance.terminalFontColors',
    'appearance.rdp',
    'terminal.maxWindows',
    'terminal.minimizedKeepAlive',
    'terminal.smartbarOrder',
    'terminal.shortcutPlatform',
    'terminal.allowLigatures',
    'snippets',
    'notes.enabled',
    'notes.editorMode',
    'notes.fontSize',
    'workspace.defaultView',
    'workspace.sessionPersistence',
    'ai.panelLayout',
    'ai.assistantName',
    'mail.notifyLogin',
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

/* Registry fields such as appearance.customColors and appearance.rdp are
 * atomic dotted-mask fields even though their values are objects. */
function flattenPersonalPatch(obj, prefix = '', out = {}) {
    if (prefix && USER_ALLOWED_KEYS.has(prefix)) {
        out[prefix] = obj;
        return out;
    }
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        if (prefix) out[prefix] = obj;
        return out;
    }
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        flattenPersonalPatch(value, path, out);
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
    constructor(db, storage, now = () => Date.now(), options = {}) {
        if (now && typeof now === 'object') {
            options = now;
            now = () => Date.now();
        }
        this.db = db;
        this.storage = storage;
        this.now = now;
        this.stmtGetAll = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?');
        this.stmtGet = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?');
        this.snippetService = options.snippetService || new SnippetService(db, now, {
            mobileChangeBridge: options.mobileChangeBridge,
        });
        this.personalSettingsService = options.personalSettingsService
            || new PersonalSettingsSectionService(db, now, {
                mobileChangeBridge: options.mobileChangeBridge,
            });
        this.aiKnowledgeService = options.aiKnowledgeService
            || new AiKnowledgeService({ db, now, mobileChangeBridge: options.mobileChangeBridge });
    }

    getUserOverrides(userId) {
        const flat = {};
        for (const row of this.stmtGetAll.all(String(userId))) {
            if (row.key === 'snippets') continue;
            try { flat[row.key] = JSON.parse(row.value); } catch { flat[row.key] = row.value; }
        }
        if (this.snippetService.hasHistory(userId) || this.stmtGet.get(String(userId), 'snippets')) {
            flat.snippets = this.snippetService.list(userId);
        }
        return unflatten(flat);
    }

    /**
     * Write personal overrides. Only USER_ALLOWED_KEYS are accepted.
     * Returns the new override bag (not the merged view).
     */
    putUserOverrides(userId, patch) {
        if (!patch || typeof patch !== 'object') throw new HttpError(400, 'invalid_settings', '设置格式错误');
        const flat = flattenPersonalPatch(patch);
        const rejected = [];
        const accepted = new Map();
        for (const key of Object.keys(flat)) {
            const allowed = USER_ALLOWED_KEYS.has(key)
                || (key !== 'snippets' && PERSONAL_SYNC_FIELDS.includes(key));
            if (!allowed && (SYSTEM_ONLY_KEYS.has(key) || SYSTEM_ONLY_KEYS.has(key.split('.')[0]))) {
                rejected.push(key);
                continue;
            }
            if (!allowed) {
                rejected.push(key);
                continue;
            }
            accepted.set(key, flat[key]);
        }
        if (rejected.length && rejected.length === Object.keys(flat).length) {
            throw new HttpError(403, 'settings_key_forbidden', `不允许修改: ${rejected.slice(0, 5).join(', ')}`);
        }
        this.db.transaction(() => {
            if (accepted.has('snippets')) {
                this.snippetService.replaceAll(userId, accepted.get('snippets'));
            }
            const sections = new Map();
            for (const [key, value] of accepted) {
                if (key === 'snippets') continue;
                const sectionKey = key.split('.')[0];
                if (!sections.has(sectionKey)) sections.set(sectionKey, {});
                sections.get(sectionKey)[key] = value;
            }
            for (const [sectionKey, sectionPatch] of sections) {
                this.personalSettingsService.patchSection(userId, sectionKey, sectionPatch, { source: 'web' });
            }
        })();
        return this.getUserOverrides(userId);
    }

    /**
     * Compatibility seam for the existing Web AI form. It accepts the legacy
     * arrays only at the authenticated user's boundary, then stores each row
     * in its account-scoped canonical service. The global settings bag is not
     * a source here, so legacy content can never fan out to every account.
     */
    replaceAiKnowledge(userOrId, ai = {}) {
        const user = typeof userOrId === 'object' ? userOrId : { userId: String(userOrId || '') };
        if (!String(user.userId || '').trim()) throw new HttpError(403, 'resource_not_found_or_inaccessible', 'An account owner is required.');
        if (!ai || typeof ai !== 'object' || Array.isArray(ai)) throw new HttpError(400, 'invalid_ai_knowledge', 'AI settings must be an object.');
        return this.db.transaction(() => {
            const result = {};
            if (Array.isArray(ai.memories)) result.memories = this.aiKnowledgeService.replaceFromWeb(user, 'aiMemory', ai.memories);
            if (Array.isArray(ai.skills)) result.skills = this.aiKnowledgeService.replaceFromWeb(
                user,
                'aiSkill',
                ai.skills.filter((item) => item?.id !== 'zephyr-unified-operator'),
            );
            if (Array.isArray(ai.envVars)) result.envVars = this.aiKnowledgeService.replaceFromWeb(user, 'aiEnv', ai.envVars);
            return result;
        })();
    }

    /** Full account AI view for server-side execution only. Env plaintext is
     * decrypted just in time by AiKnowledgeService and never used by a Web
     * settings response or a mobile change projection. */
    runtimeAi(userOrId) {
        const user = typeof userOrId === 'object' ? userOrId : { userId: String(userOrId || '') };
        const globalAi = (this.storage.getSettings() || {}).ai || {};
        const overrides = this.getUserOverrides(user.userId).ai || {};
        return deepMerge(deepMerge(globalAi, overrides), {
            memories: this.aiKnowledgeService.listForUser(user, 'aiMemory', { forRuntime: true }),
            skills: this.aiKnowledgeService.listForUser(user, 'aiSkill', { forRuntime: true }),
            envVars: this.aiKnowledgeService.listForUser(user, 'aiEnv', { forRuntime: true }),
        });
    }

    /**
     * Effective settings for a user: admin defaults + personal overrides.
     * System security/mail/captcha are only included for admins.
     */
    effective(user) {
        const global = this.storage.getSettings() || {};
        const overrides = this.getUserOverrides(user.userId);
        // Personal settings never carry platform infrastructure or secret values.
        const base = { ...global };
        delete base.security;
        delete base.captcha;
        delete base.mail;
        delete base.dataManage;
        if (base.ai) {
            base.ai = {
                ...base.ai,
                providers: (base.ai.providers || []).map((p) => ({
                    id: p.id, name: p.name, enabled: p.enabled, models: p.models, baseUrl: p.baseUrl,
                    hasApiKey: !!p.apiKey,
                    apiKey: '',
                })),
                // Never fall back to the legacy global arrays here. They lack
                // an owner and would otherwise leak into every account.
                memories: this.aiKnowledgeService.listForUser(user, 'aiMemory'),
                skills: this.aiKnowledgeService.listForUser(user, 'aiSkill'),
                envVars: this.aiKnowledgeService.listForUser(user, 'aiEnv'),
            };
        }
        return deepMerge(base, overrides);
    }
}

module.exports = {
    UserSettingsService,
    USER_ALLOWED_KEYS,
    SYSTEM_ONLY_KEYS,
    flatten,
    flattenPersonalPatch,
    unflatten,
    deepMerge,
};
