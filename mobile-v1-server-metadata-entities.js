/*
 * Canonical services and mobile projections for server-owned metadata.
 *
 * This module deliberately never exposes a broad storage row. A service must
 * prove the invariants required by its registry entity before an adapter is
 * installed, and every projection is an allow-list. That keeps future SMTP,
 * account-security, credential, filesystem and request-metadata columns out of
 * the mobile mirror by default.
 */
'use strict';

const { isDeepStrictEqual } = require('util');
const { MobileStoreError } = require('./mobile-v1-store');
const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

const CAPABILITIES = Object.freeze({
    SETTINGS_READ: 'mobile.serverSettings.read',
    SETTINGS_UPDATE: 'mobile.serverSettings.update',
    SETTINGS_AI_UPDATE: 'mobile.serverSettings.ai.update',
    BACKUP_READ: 'mobile.backupMetadata.read',
    BACKUP_UPDATE: 'mobile.backupMetadata.update',
    ACTIVITY_READ: 'mobile.activityEvent.read',
});

const REQUIRED_SERVICE_CAPABILITIES = Object.freeze([
    'safeProjection',
    'stableRevisions',
    'ownerScopedReads',
    'atomicChangeFeed',
]);

const SERVICE_OPERATIONS = Object.freeze({
    serverSettings: Object.freeze(['readServerSettings', 'updateServerSettings']),
    backupMetadata: Object.freeze(['listBackupMetadata', 'readBackupMetadata', 'updateBackupMetadata']),
    activityEvent: Object.freeze(['listActivityEventsForUser', 'readActivityEventForUser']),
});

const INACCESSIBLE = 'resource_not_found_or_inaccessible';
const SERVER_SETTINGS_SECTION = 'default';
const SECRETISH_KEY = /(?:pass(?:word)?|secret|token|sid|session|smtp|totp|backup(?:key)?|private(?:key)?|credential|authorization|cookie|user[-_]?agent|(?:api|access|refresh|encryption)[_-]?key|(?:file|directory|storage)[_-]?path|(?:file|storage)[_-]?uri)/i;
const MOBILE_ACTIVITY_MESSAGES = Object.freeze({
    remote_command: '远程命令已执行',
    success: '活动已完成',
    warning: '活动需要注意',
    error: '活动失败',
    info: '活动已记录',
});

const APPEARANCE_COLOR_KEYS = Object.freeze([
    'bgMain', 'bgCard', 'primary', 'primaryHover', 'text', 'textSecondary',
    'border', 'danger', 'success', 'warning',
]);
const AI_PERMISSION_KEYS = Object.freeze([
    'webSearch', 'webFetch', 'browser', 'remoteExecute', 'fileRead', 'fileWrite',
    'codeEdit', 'memory', 'env',
]);
const AI_CONTEXT_KEYS = Object.freeze([
    'windowTokens', 'maxInputChars', 'keepMessages', 'toolResultChars',
    'memoryItems', 'maxToolRounds',
]);

function unavailable(message = 'This mobile capability is not available') {
    return new MobileStoreError('unsupported_scope', message, 400);
}

function inaccessible() {
    return new MobileStoreError(INACCESSIBLE, 'Resource not found or inaccessible', 404);
}

function can(authorize, user, capability) {
    try { return authorize(user, capability) === true; } catch { return false; }
}

function positiveRevision(value) {
    return Math.max(1, Math.floor(Number(value) || 1));
}

function registrySpec(registry, entityType) {
    return (registry?.entities || []).find((entry) => entry?.type === entityType) || null;
}

function blockedStatus(value) {
    return /^(?:blocked|required|requires)-/i.test(String(value || '').trim());
}

function getServerMetadataSyncCapability({ registry, entityType, service } = {}) {
    const spec = registrySpec(registry, entityType);
    if (!spec) {
        return { enabled: false, code: 'server_metadata_registry_missing', reason: `${entityType} is absent from the entity registry.` };
    }
    if (blockedStatus(spec.status)) {
        return {
            enabled: false,
            code: 'server_metadata_registry_blocked',
            reason: `${entityType} is not enabled by the registry (${spec.status || 'no status'}).`,
        };
    }
    if (!service) {
        return { enabled: false, code: 'server_metadata_service_unavailable', reason: `${entityType} has no canonical service.` };
    }
    const missingCapabilities = REQUIRED_SERVICE_CAPABILITIES.filter(
        (name) => service.mobileSyncCapabilities?.[name] !== true,
    );
    if (missingCapabilities.length) {
        return {
            enabled: false,
            code: 'server_metadata_capability_missing',
            reason: `${entityType} cannot prove its mobile sync invariants.`,
            missing: missingCapabilities,
        };
    }
    const missingOperations = (SERVICE_OPERATIONS[entityType] || []).filter(
        (name) => typeof service[name] !== 'function',
    );
    if (missingOperations.length) {
        return {
            enabled: false,
            code: 'server_metadata_service_incomplete',
            reason: `${entityType} is missing canonical service operations.`,
            missing: missingOperations,
        };
    }
    return { enabled: true, code: null, reason: null };
}

function safeObject(value, depth = 0) {
    if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return {};
    const output = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
        if (SECRETISH_KEY.test(key)) continue;
        if (entry && typeof entry === 'object') {
            if (Array.isArray(entry)) {
                output[key] = entry
                    .filter((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))
                    .slice(0, 200);
            } else {
                output[key] = safeObject(entry, depth + 1);
            }
        } else if (entry == null || ['string', 'number', 'boolean'].includes(typeof entry)) {
            output[key] = entry;
        }
    }
    return output;
}

function enumValue(value, allowed, fallback) {
    const string = String(value || '');
    return allowed.includes(string) ? string : fallback;
}

function boundedNumber(value, fallback, min, max, { integer = false } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const bounded = Math.max(min, Math.min(max, number));
    return integer ? Math.floor(bounded) : bounded;
}

function projectAppearance(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const customColors = {};
    for (const key of APPEARANCE_COLOR_KEYS) {
        const color = String(source.customColors?.[key] || '');
        if (/^#[0-9a-f]{6}$/i.test(color)) customColors[key] = color;
    }
    const terminalBackground = source.terminalBackground && typeof source.terminalBackground === 'object'
        ? source.terminalBackground
        : {};
    const rdp = source.rdp && typeof source.rdp === 'object' ? source.rdp : {};
    const fontColors = source.terminalFontColors && typeof source.terminalFontColors === 'object'
        ? source.terminalFontColors
        : {};
    const output = {
        brandName: String(source.brandName || 'Zephyr').slice(0, 40) || 'Zephyr',
        theme: enumValue(source.theme, ['light', 'dark', 'auto'], 'auto'),
        autoThemeEnabled: source.autoThemeEnabled !== false,
        colorScheme: enumValue(source.colorScheme, ['frost', 'lava', 'asagi', 'cyber', 'custom'], 'frost'),
        customThemeMode: enumValue(source.customThemeMode, ['light', 'dark', 'auto'], 'dark'),
        customColors,
        terminalBackground: {
            /* The URL/data URI is a blob reference, not server settings metadata. */
            type: enumValue(terminalBackground.type, ['none', 'upload', 'url'], 'none'),
            fit: enumValue(terminalBackground.fit, ['cover', 'contain', 'auto'], 'cover'),
            opacity: boundedNumber(terminalBackground.opacity, 0.35, 0, 1),
            blur: boundedNumber(terminalBackground.blur, 0, 0, 20),
        },
        terminalFontColor: /^#[0-9a-f]{6}$/i.test(String(source.terminalFontColor || ''))
            ? String(source.terminalFontColor)
            : '',
        terminalFontColors: {
            dark: /^#[0-9a-f]{6}$/i.test(String(fontColors.dark || '')) ? String(fontColors.dark) : '',
            light: /^#[0-9a-f]{6}$/i.test(String(fontColors.light || '')) ? String(fontColors.light) : '',
        },
        rdp: {
            defaultResolution: enumValue(
                rdp.defaultResolution,
                ['auto', '1920x1080', '2560x1440', '3840x2160', '7680x4320'],
                '1920x1080',
            ),
            defaultQuality: enumValue(rdp.defaultQuality, ['balanced', 'performance', 'quality'], 'balanced'),
            defaultFps: [30, 45, 60, 120, 144].includes(Number(rdp.defaultFps)) ? Number(rdp.defaultFps) : 60,
        },
    };
    /* A short built-in glyph is display metadata. Large data-image icons stay
     * server-only and are expected to move through the blob plane. */
    const icon = String(source.brandIcon || '');
    if (icon && icon.length <= 32 && !/^data:/i.test(icon)) output.brandIcon = icon;
    return output;
}

function appearancePatch(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const projected = projectAppearance(source);
    const output = {};
    for (const key of [
        'brandName', 'theme', 'autoThemeEnabled', 'colorScheme', 'customThemeMode',
        'terminalFontColor', 'brandIcon',
    ]) {
        if (Object.prototype.hasOwnProperty.call(source, key)
            && Object.prototype.hasOwnProperty.call(projected, key)) output[key] = projected[key];
    }
    if (Object.prototype.hasOwnProperty.call(source, 'customColors')
        && Object.keys(projected.customColors).length) output.customColors = projected.customColors;
    for (const key of ['terminalBackground', 'terminalFontColors', 'rdp']) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const nested = {};
        for (const child of Object.keys(source[key] || {})) {
            if (Object.prototype.hasOwnProperty.call(projected[key], child)) nested[child] = projected[key][child];
        }
        if (Object.keys(nested).length) output[key] = nested;
    }
    return output;
}

function projectNotes(value) {
    return { enabled: value?.enabled === true };
}

function projectAi(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const permissions = {};
    for (const key of AI_PERMISSION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source.permissions || {}, key)) {
            permissions[key] = source.permissions[key] === true;
        }
    }
    const context = {};
    for (const key of AI_CONTEXT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(source.context || {}, key)) continue;
        context[key] = boundedNumber(source.context[key], 0, 0, 10_000_000, { integer: true });
    }
    return {
        enabled: source.enabled === true,
        permissions,
        context,
        memory: {
            enabled: source.memory?.enabled === true,
            maxItems: boundedNumber(source.memory?.maxItems, 0, 0, 100_000, { integer: true }),
        },
    };
}

function projectServerSettings(source, serverId) {
    const settings = source?.settings && typeof source.settings === 'object' ? source.settings : (source || {});
    const resolvedServerId = String(source?.serverId || serverId || '');
    if (!resolvedServerId) return null;
    return {
        sectionKey: String(source?.sectionKey || SERVER_SETTINGS_SECTION),
        serverId: resolvedServerId,
        revision: positiveRevision(source?.revision),
        updatedAt: Math.max(0, Number(source?.updatedAt) || 0),
        requiredRole: String(source?.requiredRole || 'admin'),
        appearance: projectAppearance(settings.appearance),
        notes: projectNotes(settings.notes),
        ai: projectAi(settings.ai),
    };
}

function projectBackupMetadata(row, serverId) {
    if (!row || typeof row !== 'object') return null;
    const backupId = String(row.backupId || row.id || '');
    const resolvedServerId = String(row.serverId || serverId || '');
    if (!backupId || !resolvedServerId) return null;
    return {
        backupId,
        serverId: resolvedServerId,
        revision: positiveRevision(row.revision),
        createdAt: Math.max(0, Number(row.createdAt) || 0),
        size: Math.max(0, Number(row.size) || 0),
        sha256: /^[a-f\d]{64}$/i.test(String(row.sha256 || '')) ? String(row.sha256).toLowerCase() : '',
        appVersion: String(row.appVersion || '').slice(0, 80),
        encryptionAlgorithm: String(row.encryptionAlgorithm || '').slice(0, 120),
        jobStatus: String(row.jobStatus || '').slice(0, 80),
        label: String(row.label || '').slice(0, 200),
        retentionHint: String(row.retentionHint || '').slice(0, 200),
    };
}

function projectActivityEvent(row, user) {
    if (!row || !user) return null;
    const owner = String(row.userId || '');
    const bound = String(user.userId || '');
    const username = String(user.username || '');
    if (!owner || (owner !== bound && (!username || owner !== username))) return null;
    const id = String(row.id || '');
    if (!id) return null;
    const type = String(row.type || 'info').slice(0, 80);
    return {
        id,
        userId: bound,
        time: Math.max(0, Number(row.time) || 0),
        /* Activity text can include arbitrary server output or old command
         * bodies. Mobile transports a fixed label from this allow-list, never
         * the persisted message, so the bootstrap, change feed, and outbox
         * share the same non-heuristic boundary. */
        message: MOBILE_ACTIVITY_MESSAGES[type] || MOBILE_ACTIVITY_MESSAGES.info,
        type,
        category: String(row.category || '').slice(0, 80),
        outcome: String(row.outcome || '').slice(0, 80),
        protocol: String(row.protocol || '').slice(0, 40),
        connectionId: String(row.connectionId || '').slice(0, 200),
    };
}

function valueAtPath(source, field) {
    let current = source;
    for (const part of String(field || '').split('.')) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function hasPath(source, field) {
    return valueAtPath(source, field) !== undefined;
}

function metadataPatch(patch) {
    const output = {};
    for (const field of ['label', 'retentionHint']) {
        if (Object.prototype.hasOwnProperty.call(patch || {}, field)) {
            output[field] = String(patch[field] || '').slice(0, 200);
        }
    }
    return output;
}

function settingsPatch(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    const output = {};
    if (Object.prototype.hasOwnProperty.call(source, 'appearance')) {
        const appearance = appearancePatch(source.appearance);
        if (Object.keys(appearance).length) output.appearance = appearance;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'notes')) {
        if (Object.prototype.hasOwnProperty.call(source.notes || {}, 'enabled')) {
            output.notes = projectNotes(source.notes);
        }
    }
    const ai = {};
    if (hasPath(source, 'ai.enabled')) ai.enabled = valueAtPath(source, 'ai.enabled') === true;
    if (hasPath(source, 'ai.permissions')) ai.permissions = projectAi({ permissions: valueAtPath(source, 'ai.permissions') }).permissions;
    if (hasPath(source, 'ai.context')) ai.context = projectAi({ context: valueAtPath(source, 'ai.context') }).context;
    if (hasPath(source, 'ai.memory.enabled')) ai.memory = { enabled: valueAtPath(source, 'ai.memory.enabled') === true };
    if (hasPath(source, 'ai.memory.maxItems')) {
        ai.memory = {
            ...(ai.memory || {}),
            maxItems: boundedNumber(valueAtPath(source, 'ai.memory.maxItems'), 0, 0, 100_000, { integer: true }),
        };
    }
    if (Object.keys(ai).length) output.ai = ai;
    return output;
}

function mergeCanonicalSettings(current, patch) {
    const output = {};
    if (patch.appearance) {
        output.appearance = {
            ...(current.appearance || {}),
            ...patch.appearance,
            customColors: { ...(current.appearance?.customColors || {}), ...(patch.appearance.customColors || {}) },
            terminalBackground: {
                ...(current.appearance?.terminalBackground || {}),
                ...(patch.appearance.terminalBackground || {}),
            },
            terminalFontColors: {
                ...(current.appearance?.terminalFontColors || {}),
                ...(patch.appearance.terminalFontColors || {}),
            },
            rdp: { ...(current.appearance?.rdp || {}), ...(patch.appearance.rdp || {}) },
        };
    }
    if (patch.notes) output.notes = { ...(current.notes || {}), ...patch.notes };
    if (patch.ai) {
        output.ai = {
            ...(current.ai || {}),
            ...patch.ai,
            permissions: { ...(current.ai?.permissions || {}), ...(patch.ai.permissions || {}) },
            context: { ...(current.ai?.context || {}), ...(patch.ai.context || {}) },
            memory: { ...(current.ai?.memory || {}), ...(patch.ai.memory || {}) },
        };
    }
    return output;
}

function settingsComparable(row) {
    return row ? { appearance: row.appearance, notes: row.notes, ai: row.ai } : null;
}

function settingsChangeRow(row) {
    if (!row) return null;
    return {
        sectionKey: row.sectionKey,
        revision: row.revision,
        updatedAt: row.updatedAt,
        requiredRole: row.requiredRole,
        appearance: row.appearance,
        notes: row.notes,
        'ai.enabled': row.ai.enabled,
        'ai.permissions': row.ai.permissions,
        'ai.context': row.ai.context,
        'ai.memory.enabled': row.ai.memory.enabled,
        'ai.memory.maxItems': row.ai.memory.maxItems,
    };
}

class CanonicalServerSettingsService {
    constructor({ db, storage, changeBridge, serverId, now = () => Date.now() } = {}) {
        if (!db || !storage?.getSettings || !storage?.updateSettings) {
            throw new TypeError('CanonicalServerSettingsService requires db and settings storage');
        }
        this.db = db;
        this.storage = storage;
        this.changeBridge = changeBridge || getMobileV1ChangeBridge(db);
        this.serverId = typeof serverId === 'function'
            ? serverId
            : () => String(serverId || this.changeBridge.store.serverId());
        this.now = now;
        this.mobileSyncCapabilities = Object.freeze({
            safeProjection: true,
            stableRevisions: true,
            ownerScopedReads: true,
            atomicChangeFeed: true,
        });
        this._ensureSchema();
    }

    _ensureSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS mobile_server_settings_state (
            section_key TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`);
        this.db.prepare(`INSERT OR IGNORE INTO mobile_server_settings_state
            (section_key, revision, updated_at) VALUES (?, 1, 0)`).run(SERVER_SETTINGS_SECTION);
    }

    _state() {
        return this.db.prepare(`SELECT revision, updated_at FROM mobile_server_settings_state
            WHERE section_key = ?`).get(SERVER_SETTINGS_SECTION) || { revision: 1, updated_at: 0 };
    }

    readServerSettings() {
        const state = this._state();
        return {
            sectionKey: SERVER_SETTINGS_SECTION,
            serverId: String(this.serverId() || ''),
            revision: positiveRevision(state.revision),
            updatedAt: Math.max(0, Number(state.updated_at) || 0),
            requiredRole: 'admin',
            settings: this.storage.getSettings(),
        };
    }

    _runMutation(write, {
        actorUserId,
        actorDeviceId = null,
        expectedRevision = null,
        mutationReceipt = null,
    } = {}) {
        const owner = String(actorUserId || '');
        if (!owner) throw inaccessible();
        return this.db.transaction(() => {
            const beforeRaw = this.readServerSettings();
            const before = projectServerSettings(beforeRaw, this.serverId());
            if (expectedRevision != null && Number(expectedRevision) !== before.revision) {
                throw new MobileStoreError('revision_conflict', 'Server settings revision conflict', 409, {
                    details: { expectedRevision: Number(expectedRevision), currentRevision: before.revision },
                });
            }
            const result = write(beforeRaw.settings);
            const preview = projectServerSettings({ ...this.readServerSettings(), settings: this.storage.getSettings() }, this.serverId());
            if (isDeepStrictEqual(settingsComparable(before), settingsComparable(preview))) return result;

            const updatedAt = this.now();
            const changed = this.db.prepare(`UPDATE mobile_server_settings_state
                SET revision = revision + 1, updated_at = ?
                WHERE section_key = ? AND revision = ?`).run(updatedAt, SERVER_SETTINGS_SECTION, before.revision);
            if (Number(changed.changes || 0) !== 1) {
                throw new MobileStoreError('revision_conflict', 'Server settings changed concurrently', 409);
            }
            const after = projectServerSettings(this.readServerSettings(), this.serverId());
            this.changeBridge.recordMutation({
                entityType: 'serverSettings',
                entityId: SERVER_SETTINGS_SECTION,
                action: 'upsert',
                user: { userId: owner },
                before: settingsChangeRow(before),
                after: settingsChangeRow(after),
                revision: after.revision,
                actorDeviceId,
                mutationReceipt,
            });
            return result;
        })();
    }

    updateServerSettings(patch, context = {}) {
        const safe = settingsPatch(patch);
        if (!Object.keys(safe).length) throw unavailable('No mobile-editable server setting was supplied');
        this._runMutation((current) => {
            this.storage.updateSettings(mergeCanonicalSettings(current, safe));
            return true;
        }, context);
        return this.readServerSettings();
    }

    runExternalUpdate(write, context = {}) {
        if (typeof write !== 'function') throw new TypeError('External settings write must be a function');
        return this._runMutation(() => write(), context);
    }
}

class CanonicalActivityEventService {
    constructor({ db, storage, changeBridge } = {}) {
        if (!db || !storage?.addActivity) {
            throw new TypeError('CanonicalActivityEventService requires db and activity storage');
        }
        this.db = db;
        this.storage = storage;
        this.changeBridge = changeBridge || getMobileV1ChangeBridge(db);
        this.mobileSyncCapabilities = Object.freeze({
            safeProjection: true,
            stableRevisions: true,
            ownerScopedReads: true,
            atomicChangeFeed: true,
        });
    }

    listActivityEventsForUser(userId, { limit = 500 } = {}) {
        const capped = Math.max(1, Math.min(500, Number(limit) || 500));
        const keys = this.ownerKeys(userId);
        if (!keys.length) return [];
        const placeholders = keys.map(() => '?').join(', ');
        return this.db.prepare(`SELECT id, userId, time, message, type, category, outcome, protocol, connectionId
            FROM activities WHERE userId IN (${placeholders}) ORDER BY time DESC LIMIT ?`).all(...keys, capped);
    }

    readActivityEventForUser(userId, eventId) {
        const keys = this.ownerKeys(userId);
        if (!keys.length) return null;
        const placeholders = keys.map(() => '?').join(', ');
        return this.db.prepare(`SELECT id, userId, time, message, type, category, outcome, protocol, connectionId
            FROM activities WHERE userId IN (${placeholders}) AND id = ?`).get(...keys, String(eventId || '')) || null;
    }

    /**
     * Historical activity rows stored username in `userId`. Match both the
     * canonical userId and username so One can project those rows instead of
     * emitting an empty payload that freezes the change cursor.
     */
    ownerKeys(userId) {
        const id = String(userId || '');
        if (!id) return [];
        const keys = [id];
        try {
            const user = this.storage.getUserById(id) || this.storage.getUser(id);
            if (user?.userId && !keys.includes(user.userId)) keys.push(user.userId);
            if (user?.username && !keys.includes(user.username)) keys.push(user.username);
        } catch {
            /* Storage lookups must not take the change page down. */
        }
        return keys;
    }

    appendActivityEvent(event) {
        const rawOwner = event?.userId ? String(event.userId) : null;
        let resolved = null;
        if (rawOwner) {
            try {
                resolved = this.storage.getUserById(rawOwner) || this.storage.getUser(rawOwner) || null;
            } catch {
                resolved = null;
            }
        }
        const canonicalUserId = resolved?.userId || rawOwner;
        const row = { ...event, userId: canonicalUserId || null };
        return this.db.transaction(() => {
            this.storage.addActivity(row);
            if (row.userId) {
                recordActivityEvent(this.changeBridge, {
                    userId: String(row.userId),
                    username: resolved?.username || '',
                }, row);
            }
            return row;
        })();
    }
}

function createServerMetadataServices(options = {}) {
    const changeBridge = options.changeBridge || getMobileV1ChangeBridge(options.db);
    return {
        serverSettings: new CanonicalServerSettingsService({ ...options, changeBridge }),
        activityEvents: new CanonicalActivityEventService({ ...options, changeBridge }),
        /* backupMetadata intentionally absent until a durable job/metadata
         * service exists and the registry status no longer starts requires-. */
        backupMetadata: null,
    };
}

function createServerMetadataEntityAdapters({
    registry,
    serverSettings,
    backupMetadata,
    activityEvents,
    authorize = () => false,
    serverId = '',
} = {}) {
    const adapters = new Map();
    const resolvedServerId = () => String(typeof serverId === 'function' ? serverId() : serverId || '');

    const settingsCapability = getServerMetadataSyncCapability({
        registry,
        entityType: 'serverSettings',
        service: serverSettings,
    });
    if (settingsCapability.enabled) {
        const readSettings = (user) => {
            if (!can(authorize, user, CAPABILITIES.SETTINGS_READ)) return null;
            return projectServerSettings(serverSettings.readServerSettings(), resolvedServerId());
        };
        adapters.set('serverSettings', {
            idOf: (row) => row.sectionKey,
            residency: (user, id) => String(id) === SERVER_SETTINGS_SECTION && readSettings(user) ? 'owned' : 'foreign',
            list: (user) => {
                const row = readSettings(user);
                return row ? [row] : [];
            },
            read: (user, id) => String(id) === SERVER_SETTINGS_SECTION ? readSettings(user) : null,
            revisionOf: (row) => positiveRevision(row?.revision),
            create: () => { throw unavailable('Server settings are provisioned by the server'); },
            update: (user, id, patch, mutationContext = {}) => {
                if (String(id) !== SERVER_SETTINGS_SECTION
                    || !can(authorize, user, CAPABILITIES.SETTINGS_UPDATE)) throw inaccessible();
                if (patch?.ai && !can(authorize, user, CAPABILITIES.SETTINGS_AI_UPDATE)) throw inaccessible();
                const before = readSettings(user);
                if (!before) throw inaccessible();
                const safe = settingsPatch(patch);
                if (!Object.keys(safe).length) {
                    throw unavailable('No mobile-editable server setting was supplied');
                }
                const result = serverSettings.updateServerSettings(safe, {
                    actorUserId: user.userId,
                    expectedRevision: before.revision,
                    source: 'mobile',
                    ...mutationContext,
                });
                return projectServerSettings(result || serverSettings.readServerSettings(), resolvedServerId());
            },
            remove: () => { throw unavailable('Server settings reset is not available through sync'); },
            capability: settingsCapability,
        });
    }

    const backupCapability = getServerMetadataSyncCapability({
        registry,
        entityType: 'backupMetadata',
        service: backupMetadata,
    });
    if (backupCapability.enabled) {
        const listBackups = (user) => {
            if (!can(authorize, user, CAPABILITIES.BACKUP_READ)) return [];
            return (backupMetadata.listBackupMetadata({ actorUserId: user.userId }) || [])
                .map((row) => projectBackupMetadata(row, resolvedServerId()))
                .filter(Boolean);
        };
        adapters.set('backupMetadata', {
            idOf: (row) => row.backupId,
            residency: (user, id) => listBackups(user).some((row) => row.backupId === String(id)) ? 'owned' : 'foreign',
            list: listBackups,
            read: (user, id) => {
                if (!can(authorize, user, CAPABILITIES.BACKUP_READ)) return null;
                return projectBackupMetadata(
                    backupMetadata.readBackupMetadata(String(id), { actorUserId: user.userId }),
                    resolvedServerId(),
                );
            },
            revisionOf: (row) => positiveRevision(row?.revision),
            create: () => { throw unavailable('Backups are created only by server jobs'); },
            update: (user, id, patch, mutationContext = {}) => {
                if (!can(authorize, user, CAPABILITIES.BACKUP_UPDATE)) throw inaccessible();
                const current = adapters.get('backupMetadata').read(user, id);
                if (!current) throw inaccessible();
                return projectBackupMetadata(backupMetadata.updateBackupMetadata(
                    String(id),
                    metadataPatch(patch),
                    { actorUserId: user.userId, source: 'mobile', ...mutationContext },
                ), resolvedServerId());
            },
            remove: () => { throw unavailable('Backup deletion requires a server retention job'); },
            capability: backupCapability,
        });
    }

    const activityCapability = getServerMetadataSyncCapability({
        registry,
        entityType: 'activityEvent',
        service: activityEvents,
    });
    if (activityCapability.enabled) {
        const listEvents = (user) => {
            if (!can(authorize, user, CAPABILITIES.ACTIVITY_READ)) return [];
            return (activityEvents.listActivityEventsForUser(String(user.userId), { limit: 500 }) || [])
                .map((row) => projectActivityEvent(row, user))
                .filter(Boolean);
        };
        adapters.set('activityEvent', {
            idOf: (row) => row.id,
            /* Do not infer residency from the 500-row bootstrap window: an
             * older event can still have a live change entry. The owner-scoped
             * point lookup collapses missing and foreign ids without exposing
             * which case occurred. */
            residency: (user, id) => {
                if (!can(authorize, user, CAPABILITIES.ACTIVITY_READ)) return 'foreign';
                return activityEvents.readActivityEventForUser(String(user.userId), String(id))
                    ? 'owned'
                    : 'missing';
            },
            list: listEvents,
            read: (user, id) => {
                if (!can(authorize, user, CAPABILITIES.ACTIVITY_READ)) return null;
                return projectActivityEvent(
                    activityEvents.readActivityEventForUser(String(user.userId), String(id)),
                    user,
                );
            },
            revisionOf: (row) => positiveRevision(row?.revision || row?.time),
            create: () => { throw unavailable('Activity events are server append-only'); },
            update: () => { throw unavailable('Activity events are server append-only'); },
            remove: () => { throw unavailable('Activity events are server append-only'); },
            capability: activityCapability,
        });
    }
    return adapters;
}

function recordActivityEvent(changeBridge, user, event) {
    const row = projectActivityEvent(event, user);
    if (!row) throw new TypeError('Activity event must belong to its owner');
    return changeBridge.recordMutation({
        entityType: 'activityEvent',
        entityId: row.id,
        action: 'upsert',
        user,
        after: row,
        revision: positiveRevision(event.revision || event.time),
    });
}

module.exports = {
    CAPABILITIES,
    REQUIRED_SERVICE_CAPABILITIES,
    SERVER_SETTINGS_SECTION,
    CanonicalActivityEventService,
    CanonicalServerSettingsService,
    createServerMetadataEntityAdapters,
    createServerMetadataServices,
    getServerMetadataSyncCapability,
    projectActivityEvent,
    projectBackupMetadata,
    projectServerSettings,
    recordActivityEvent,
    settingsPatch,
};
