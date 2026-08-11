'use strict';

const { USER_ALLOWED_KEYS } = require('./user-settings-service');

const USER_SETTING_BACKUP_KEYS = Object.freeze([...USER_ALLOWED_KEYS].sort());
const SENSITIVE_SETTING_KEY_PARTS = Object.freeze([
    'webdav',
    'password',
    'token',
    'encryption',
    'system',
    'internal',
]);

/*
 * Workspace rows are client-local, while this table gives their portable sync
 * projection a stable account-scoped id.  Keep the backup contract deliberately
 * narrower than the table: projection_json may contain device runtime details
 * and tombstone/feed metadata does not participate in identity recovery.
 */
const PORTABLE_WORKSPACE_IDENTITY_COLLECTION = 'workspacePortableIdentitiesV1';
const PORTABLE_WORKSPACE_IDENTITY_VERSION = 1;
const MAX_PORTABLE_WORKSPACE_IDENTITIES = 4096;
const MAX_PORTABLE_SOURCE_CLIENT_ID_CHARS = 80;
const MAX_PORTABLE_SOURCE_WORKSPACE_ID_CHARS = 256;
const PORTABLE_ID_PATTERN = /^wsp_[A-Za-z0-9_-]{24}$/;

const USER_SETTING_SQL_ALLOWLIST = USER_SETTING_BACKUP_KEYS
    .map(() => '(key=? OR key GLOB ?)')
    .join(' OR ');
const USER_SETTING_SQL_SCOPE = `(${USER_SETTING_SQL_ALLOWLIST}) AND ${SENSITIVE_SETTING_KEY_PARTS
    .map((part) => `instr(lower(key),'${part}')=0`)
    .join(' AND ')}`;
const USER_SETTING_SQL_PARAMS = Object.freeze(USER_SETTING_BACKUP_KEYS
    .flatMap((key) => [key, `${key}.*`]));

function isBackupEligibleUserSettingKey(value) {
    if (typeof value !== 'string' || !value || value.length > 256) return false;
    const normalized = value.toLowerCase();
    if (SENSITIVE_SETTING_KEY_PARTS.some((part) => normalized.includes(part))) return false;
    return USER_SETTING_BACKUP_KEYS.some((allowed) => value === allowed || value.startsWith(`${allowed}.`));
}

function identityText(value, maximum) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum
        && !/[\0-\x1f\x7f]/.test(value);
}

/**
 * Validates the only portable workspace identity representation that may leave
 * an account.  It is intentionally an exact schema so a future column such as
 * projection_json cannot accidentally become backup data.
 */
function normalizePortableWorkspaceIdentityRecord(record, ownerUserId) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.getPrototypeOf(record) !== Object.prototype) return null;
    const expected = ['mappingVersion', 'ownerUserId', 'portableId', 'sourceClientId', 'sourceWorkspaceId'];
    const keys = Object.keys(record).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
    if (record.mappingVersion !== PORTABLE_WORKSPACE_IDENTITY_VERSION
        || record.ownerUserId !== ownerUserId
        || !identityText(record.sourceClientId, MAX_PORTABLE_SOURCE_CLIENT_ID_CHARS)
        || !identityText(record.sourceWorkspaceId, MAX_PORTABLE_SOURCE_WORKSPACE_ID_CHARS)
        || typeof record.portableId !== 'string'
        || !PORTABLE_ID_PATTERN.test(record.portableId)) return null;
    return {
        mappingVersion: PORTABLE_WORKSPACE_IDENTITY_VERSION,
        ownerUserId,
        sourceClientId: record.sourceClientId,
        sourceWorkspaceId: record.sourceWorkspaceId,
        portableId: record.portableId,
    };
}

function normalizePortableWorkspaceIdentityCollection(records, ownerUserId) {
    if (!Array.isArray(records) || records.length > MAX_PORTABLE_WORKSPACE_IDENTITIES) return null;
    const sourceKeys = new Set();
    const portableIds = new Set();
    const normalized = [];
    for (const record of records) {
        const item = normalizePortableWorkspaceIdentityRecord(record, ownerUserId);
        if (!item) return null;
        const sourceKey = `${item.sourceClientId}\0${item.sourceWorkspaceId}`;
        if (sourceKeys.has(sourceKey) || portableIds.has(item.portableId)) return null;
        sourceKeys.add(sourceKey);
        portableIds.add(item.portableId);
        normalized.push(item);
    }
    return normalized;
}

module.exports = {
    MAX_PORTABLE_WORKSPACE_IDENTITIES,
    PORTABLE_WORKSPACE_IDENTITY_COLLECTION,
    PORTABLE_WORKSPACE_IDENTITY_VERSION,
    USER_SETTING_BACKUP_KEYS,
    USER_SETTING_SQL_PARAMS,
    USER_SETTING_SQL_SCOPE,
    isBackupEligibleUserSettingKey,
    normalizePortableWorkspaceIdentityCollection,
    normalizePortableWorkspaceIdentityRecord,
};
