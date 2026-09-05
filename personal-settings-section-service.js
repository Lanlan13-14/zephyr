'use strict';

const { isDeepStrictEqual } = require('util');
const { HttpError } = require('./authz');
const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

const PERSONAL_EDITABLE_FIELDS = Object.freeze([
    'appearance.theme',
    'appearance.autoThemeEnabled',
    'appearance.colorScheme',
    'appearance.customThemeMode',
    'appearance.customColors',
    'appearance.terminalBackground',
    'appearance.terminalFontColor',
    'appearance.terminalFontColors',
    'appearance.rdp',
    'terminal.maxWindows',
    'terminal.minimizedKeepAlive',
    'terminal.smartbarOrder',
    'terminal.shortcutPlatform',
    'terminal.allowLigatures',
    'notes.enabled',
    'notes.editorMode',
    'notes.fontSize',
    'workspace.defaultView',
    'workspace.sessionPersistence',
    'ai.panelLayout',
    'ai.assistantName',
]);

const PERSONAL_OPAQUE_FIELDS = Object.freeze([
    'appearance.customCss',
    'mail.notifyLogin',
]);

const PERSONAL_SYNC_FIELDS = Object.freeze([
    ...PERSONAL_EDITABLE_FIELDS,
    ...PERSONAL_OPAQUE_FIELDS,
]);

const EDITABLE_SET = new Set(PERSONAL_EDITABLE_FIELDS);
const OPAQUE_SET = new Set(PERSONAL_OPAQUE_FIELDS);
const SYNC_SET = new Set(PERSONAL_SYNC_FIELDS);
const SECTION_KEYS = Object.freeze([...new Set(PERSONAL_SYNC_FIELDS.map((field) => field.split('.')[0]))]);
const CUSTOM_COLOR_KEYS = new Set([
    'bgMain', 'bgCard', 'primary', 'primaryHover', 'text', 'textSecondary',
    'border', 'danger', 'success', 'warning',
]);
const OBJECT_FIELD_KEYS = new Map([
    ['appearance.customColors', CUSTOM_COLOR_KEYS],
    ['appearance.terminalBackground', new Set(['type', 'url', 'fit', 'opacity', 'blur'])],
    ['appearance.terminalFontColors', new Set(['dark', 'light'])],
    ['appearance.rdp', new Set(['defaultResolution', 'defaultQuality', 'defaultFps'])],
]);

function asUser(userOrId) {
    if (userOrId && typeof userOrId === 'object') return userOrId;
    return { userId: String(userOrId || '') };
}

function sectionOf(field) {
    return String(field || '').split('.')[0];
}

function parseValue(value) {
    try { return JSON.parse(value); } catch { return value; }
}

function setPath(target, path, value) {
    const parts = String(path).split('.');
    let current = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const key = parts[index];
        if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
        current = current[key];
    }
    current[parts[parts.length - 1]] = value;
}

function getPath(target, path) {
    let current = target;
    for (const part of String(path).split('.')) {
        if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function sanitizeSyncValue(field, value, { strict = false } = {}) {
    if (value === null || value === undefined) return value;
    const allowedKeys = OBJECT_FIELD_KEYS.get(field);
    if (allowedKeys) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            if (strict) throw new HttpError(400, 'invalid_settings', `${field} must be an object.`);
            return undefined;
        }
        const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
        if (strict && unknown.length) {
            throw new HttpError(400, 'invalid_settings', `${field} contains unknown keys.`);
        }
        const clean = {};
        for (const key of allowedKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const item = value[key];
            if (item && typeof item === 'object') {
                if (strict) throw new HttpError(400, 'invalid_settings', `${field}.${key} must be scalar.`);
                continue;
            }
            if (field === 'appearance.customColors' && !/^#[0-9a-f]{6}$/i.test(String(item || ''))) {
                if (strict) throw new HttpError(400, 'invalid_settings', `${field}.${key} must be a six-digit hex color.`);
                continue;
            }
            clean[key] = item;
        }
        return clean;
    }
    if (field === 'terminal.smartbarOrder') {
        if (typeof value === 'string') return value.slice(0, 80);
        if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string')) {
            if (strict) throw new HttpError(400, 'invalid_settings', `${field} must be a string or string array.`);
            return undefined;
        }
        return value.map((item) => item.slice(0, 80));
    }
    if (value && typeof value === 'object') {
        if (strict) throw new HttpError(400, 'invalid_settings', `${field} must be a scalar value.`);
        return undefined;
    }
    return value;
}

function conflict() {
    return new HttpError(409, 'revision_conflict', 'The settings section changed on another client. Reload it and retry.');
}

function invalidSection() {
    return new HttpError(400, 'invalid_settings', 'Unknown personal settings section.');
}

class PersonalSettingsSectionService {
    constructor(db, now = () => Date.now(), options = {}) {
        if (!db) throw new TypeError('PersonalSettingsSectionService requires a SQLite db');
        if (now && typeof now === 'object') {
            options = now;
            now = () => Date.now();
        }
        this.db = db;
        this.now = typeof now === 'function' ? now : () => Date.now();
        this._ensureSchema();
        this.mobileChangeBridge = options.mobileChangeBridge === false
            ? null
            : (options.mobileChangeBridge || getMobileV1ChangeBridge(db));
        this._prepare();
        this._migrateSectionMetadata();
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_setting_sections (
                user_id TEXT NOT NULL,
                section_key TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL,
                reset_at INTEGER,
                PRIMARY KEY (user_id, section_key)
            );
            CREATE INDEX IF NOT EXISTS idx_user_setting_sections_active
                ON user_setting_sections(user_id, reset_at, section_key);
        `);
    }

    _prepare() {
        this.stmtMetadata = this.db.prepare(`SELECT * FROM user_setting_sections
            WHERE user_id = ? AND section_key = ?`);
        this.stmtListMetadata = this.db.prepare(`SELECT * FROM user_setting_sections
            WHERE user_id = ? AND reset_at IS NULL ORDER BY section_key ASC`);
        this.stmtSectionValues = this.db.prepare(`SELECT key, value FROM user_settings
            WHERE user_id = ? AND (key = ? OR key LIKE ?)`);
        this.stmtDeleteField = this.db.prepare(`DELETE FROM user_settings
            WHERE user_id = ? AND (key = ? OR key LIKE ?)`);
        this.stmtPutField = this.db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
        this.stmtInsertMetadata = this.db.prepare(`INSERT INTO user_setting_sections
            (user_id, section_key, revision, updated_at, reset_at) VALUES (?, ?, ?, ?, ?)`);
        this.stmtAdvanceMetadata = this.db.prepare(`UPDATE user_setting_sections
            SET revision=revision+1, updated_at=?, reset_at=?
            WHERE user_id=? AND section_key=? AND revision=?`);
    }

    _migrateSectionMetadata() {
        let rows;
        try {
            rows = this.db.prepare(`SELECT user_id, key, updated_at FROM user_settings
                WHERE key <> 'snippets'`).all();
        } catch {
            return;
        }
        const latest = new Map();
        for (const row of rows) {
            const sectionKey = sectionOf(row.key);
            if (!SECTION_KEYS.includes(sectionKey)) continue;
            const mapKey = `${row.user_id}\u0000${sectionKey}`;
            const previous = latest.get(mapKey);
            if (!previous || Number(row.updated_at) > previous.updatedAt) {
                latest.set(mapKey, {
                    userId: String(row.user_id), sectionKey,
                    updatedAt: Number(row.updated_at) || Number(this.now()),
                });
            }
        }
        const insert = this.db.prepare(`INSERT OR IGNORE INTO user_setting_sections
            (user_id, section_key, revision, updated_at, reset_at) VALUES (?, ?, 1, ?, NULL)`);
        this.db.transaction(() => {
            for (const item of latest.values()) insert.run(item.userId, item.sectionKey, item.updatedAt);
        })();
    }

    _metadata(userId, sectionKey) {
        return this.stmtMetadata.get(String(userId), String(sectionKey)) || null;
    }

    _fieldValues(userId, sectionKey) {
        const nested = {};
        const rows = this.stmtSectionValues.all(String(userId), String(sectionKey), `${sectionKey}.%`)
            .slice()
            .sort((left, right) => String(left.key).length - String(right.key).length);
        for (const row of rows) setPath(nested, row.key, parseValue(row.value));
        const values = {};
        for (const field of PERSONAL_SYNC_FIELDS) {
            if (sectionOf(field) !== sectionKey) continue;
            const value = getPath(nested, field);
            if (value !== undefined) {
                const sanitized = sanitizeSyncValue(field, value);
                if (sanitized !== undefined) values[field] = sanitized;
            }
        }
        return values;
    }

    _wireRow(userId, metadata) {
        if (!metadata || metadata.reset_at != null) return null;
        const values = this._fieldValues(userId, metadata.section_key);
        if (!Object.keys(values).length) return null;
        return {
            sectionKey: metadata.section_key,
            userId: String(userId),
            revision: Math.max(1, Number(metadata.revision) || 1),
            updatedAt: Number(metadata.updated_at) || 0,
            ...values,
        };
    }

    _deletedRow(userId, metadata) {
        if (!metadata || metadata.reset_at == null) return null;
        return {
            sectionKey: metadata.section_key,
            userId: String(userId),
            revision: Math.max(1, Number(metadata.revision) || 1),
            updatedAt: Number(metadata.updated_at) || 0,
            deletedAt: Number(metadata.reset_at),
        };
    }

    list(userOrId) {
        const user = asUser(userOrId);
        return this.stmtListMetadata.all(String(user.userId))
            .map((metadata) => this._wireRow(user.userId, metadata))
            .filter(Boolean);
    }

    read(userOrId, sectionKey, { includeReset = false } = {}) {
        const user = asUser(userOrId);
        if (!SECTION_KEYS.includes(String(sectionKey))) return null;
        const metadata = this._metadata(user.userId, sectionKey);
        if (includeReset && metadata?.reset_at != null) return this._deletedRow(user.userId, metadata);
        return this._wireRow(user.userId, metadata);
    }

    residency(userOrId, sectionKey) {
        const user = asUser(userOrId);
        return this._metadata(user.userId, sectionKey) ? 'owned' : 'missing';
    }

    currentRevision(userOrId, sectionKey) {
        const user = asUser(userOrId);
        return Math.max(0, Number(this._metadata(user.userId, sectionKey)?.revision || 0));
    }

    _validatePatch(sectionKey, patch, source) {
        if (!SECTION_KEYS.includes(String(sectionKey))) throw invalidSection();
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new HttpError(400, 'invalid_settings', 'Settings patch must be an object.');
        }
        const normalized = {};
        for (const [field, value] of Object.entries(patch)) {
            if (!SYNC_SET.has(field) || sectionOf(field) !== sectionKey) {
                throw new HttpError(400, 'invalid_settings', `Unknown personal settings field: ${field}`);
            }
            if (source === 'mobile' && OPAQUE_SET.has(field)) {
                throw new HttpError(403, 'settings_key_forbidden', `Mobile clients cannot write opaque field ${field}.`);
            }
            normalized[field] = sanitizeSyncValue(field, value, { strict: true });
        }
        return normalized;
    }

    _runMobileMutation(meta, write) {
        if (!this.mobileChangeBridge) return write();
        return this.db.transaction(() => {
            const result = write();
            const after = meta.action === 'delete' ? null : result;
            const recorded = this.mobileChangeBridge.recordMutation({ ...meta, after });

            /* Opaque fields are server-authored but still travel down to One.
             * MobileV1ChangeBridge intentionally computes only client-editable
             * fields, so extend the already-recorded row when this canonical
             * Web mutation changed an opaque value. Store.appendChange dedupes
             * the same entity/action/revision row and replaces its field mask;
             * no second cursor or wake event is allocated. */
            if (meta.action === 'upsert' && after) {
                const before = meta.before || {};
                const changedFields = PERSONAL_SYNC_FIELDS.filter((field) => (
                    !isDeepStrictEqual(before[field], after[field])
                ));
                if (changedFields.some((field) => OPAQUE_SET.has(field))) {
                    const revision = Math.max(1, Number(after.revision) || Number(recorded?.revision) || 1);
                    this.mobileChangeBridge.store.appendChange({
                        ownerUserId: String(after.userId || meta.user?.userId || ''),
                        entityType: 'oneUserSettings',
                        entityId: String(after.sectionKey || meta.entityId || ''),
                        action: 'upsert',
                        revision,
                        fieldMask: changedFields,
                        actorDeviceId: meta.actorDeviceId == null ? null : String(meta.actorDeviceId),
                    });
                    this.mobileChangeBridge.store.setEntityVersion({
                        ownerUserId: String(after.userId || meta.user?.userId || ''),
                        entityType: 'oneUserSettings',
                        entityId: String(after.sectionKey || meta.entityId || ''),
                        revision,
                        deletedAt: null,
                    });
                    this.mobileChangeBridge.store.setFieldRevisions({
                        ownerUserId: String(after.userId || meta.user?.userId || ''),
                        entityType: 'oneUserSettings',
                        entityId: String(after.sectionKey || meta.entityId || ''),
                        fields: changedFields,
                        revision,
                        changedAt: Date.now(),
                    });
                }
            }
            return result;
        })();
    }

    patchSection(userOrId, sectionKey, patch, {
        expectedRevision,
        source = 'web',
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        const user = asUser(userOrId);
        sectionKey = String(sectionKey || '');
        const normalized = this._validatePatch(sectionKey, patch, source);
        const metadata = this._metadata(user.userId, sectionKey);
        const before = this._wireRow(user.userId, metadata);
        const deletedBefore = this._deletedRow(user.userId, metadata);
        const logicalBefore = before || deletedBefore;
        const currentRevision = Number(metadata?.revision || 0);
        if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) throw conflict();
        if (!Object.keys(normalized).length) return before;

        const currentValues = before ? Object.fromEntries(
            PERSONAL_SYNC_FIELDS
                .filter((field) => sectionOf(field) === sectionKey && Object.prototype.hasOwnProperty.call(before, field))
                .map((field) => [field, before[field]]),
        ) : {};
        const nextValues = { ...currentValues };
        for (const [field, value] of Object.entries(normalized)) {
            if (value === null || value === undefined) delete nextValues[field];
            else nextValues[field] = value;
        }
        if (isDeepStrictEqual(currentValues, nextValues)) return before;
        if (!metadata && !Object.keys(nextValues).length) return null;

        const action = Object.keys(nextValues).length ? 'upsert' : 'delete';
        return this._runMobileMutation({
            entityType: 'oneUserSettings', entityId: sectionKey, action, user,
            before: logicalBefore,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const timestamp = Number(this.now());
            for (const [field, value] of Object.entries(normalized)) {
                this.stmtDeleteField.run(String(user.userId), field, `${field}.%`);
                if (value !== null && value !== undefined) {
                    this.stmtPutField.run(String(user.userId), field, JSON.stringify(value), timestamp);
                }
            }

            const nextRevision = currentRevision + 1 || 1;
            const resetAt = action === 'delete' ? timestamp : null;
            if (metadata) {
                const result = this.stmtAdvanceMetadata.run(
                    timestamp, resetAt, String(user.userId), sectionKey, currentRevision,
                );
                if (Number(result.changes || 0) !== 1) throw conflict();
            } else {
                this.stmtInsertMetadata.run(String(user.userId), sectionKey, nextRevision, timestamp, resetAt);
            }
            return action === 'delete' ? true : this.read(user, sectionKey);
        });
    }

    resetSection(userOrId, sectionKey, {
        expectedRevision,
        source = 'web',
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        const user = asUser(userOrId);
        sectionKey = String(sectionKey || '');
        if (!SECTION_KEYS.includes(sectionKey)) throw invalidSection();
        if (source === 'mobile' && PERSONAL_OPAQUE_FIELDS.some((field) => sectionOf(field) === sectionKey)) {
            throw new HttpError(
                403,
                'settings_key_forbidden',
                'This section contains opaque server-authored values and cannot be reset by a mobile client.',
            );
        }
        const current = this.read(user, sectionKey);
        if (!current) throw new HttpError(404, 'resource_not_found_or_inaccessible', 'The settings section is already at its default.');
        const reset = {};
        for (const field of PERSONAL_SYNC_FIELDS) {
            if (sectionOf(field) === sectionKey && Object.prototype.hasOwnProperty.call(current, field)) reset[field] = null;
        }
        return this.patchSection(user, sectionKey, reset, {
            expectedRevision,
            source,
            actorDeviceId,
            mutationReceipt,
        });
    }

    restoreSection(userOrId, sectionKey, {
        expectedRevision,
        source = 'mobile',
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        const user = asUser(userOrId);
        sectionKey = String(sectionKey || '');
        if (!SECTION_KEYS.includes(sectionKey)) throw invalidSection();
        const metadata = this._metadata(user.userId, sectionKey);
        const before = this._deletedRow(user.userId, metadata);
        if (!before) throw new HttpError(404, 'resource_not_found_or_inaccessible', 'The settings section is not reset.');
        if (expectedRevision !== undefined && Number(expectedRevision) !== before.revision) throw conflict();
        if (source === 'mobile' && PERSONAL_OPAQUE_FIELDS.some((field) => sectionOf(field) === sectionKey)) {
            throw new HttpError(403, 'settings_key_forbidden', 'A mobile client cannot restore an opaque settings section.');
        }
        return this._runMobileMutation({
            entityType: 'oneUserSettings', entityId: sectionKey, action: 'upsert', user, before,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const timestamp = Number(this.now());
            const result = this.stmtAdvanceMetadata.run(
                timestamp, null, String(user.userId), sectionKey, before.revision,
            );
            if (Number(result.changes || 0) !== 1) throw conflict();
            const restored = {
                sectionKey,
                userId: String(user.userId),
                revision: before.revision + 1,
                updatedAt: timestamp,
            };
            return restored;
        });
    }
}

module.exports = {
    PersonalSettingsSectionService,
    PERSONAL_EDITABLE_FIELDS,
    PERSONAL_OPAQUE_FIELDS,
    PERSONAL_SYNC_FIELDS,
    SECTION_KEYS,
    EDITABLE_SET,
    OPAQUE_SET,
    sectionOf,
    getPath,
    setPath,
    sanitizeSyncValue,
};
