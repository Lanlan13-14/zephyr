'use strict';

const { openPlainArchive } = require('./webdav-backup-provider');
const { detectVaultEnvelope, unwrapVaultArchive, WebDavVaultPasswordError } = require('./webdav-vault-password');
const RESTORE_COLLECTIONS = Object.freeze(['connections', 'proxies', 'sshKeys', 'jumpHosts', 'notes']);
const OWNER_FIELDS = ['ownerId', 'ownerUserId', 'owner_id', 'owner_user_id', 'userId', 'user_id'];
function restoreError(code, message, status = 400) {
    return Object.assign(new Error(message), { code, status, retryable: false });
}
function idOf(row, type) { return String(type === 'notes' ? row.id || row.noteId || row.note_id || '' : row.id || ''); }
function assertOwner(row, userId, existing = false) {
    for (const field of OWNER_FIELDS) {
        if (row[field] != null && String(row[field]) !== userId) {
            throw restoreError(existing ? 'webdav_restore_conflict' : 'webdav_backup_scope_invalid',
                existing ? 'An existing resource id belongs to another account' : 'Record is outside the restore user scope', existing ? 409 : 400);
        }
    }
}
function resourceRow(resources, type, id) {
    const storage = resources.storage;
    if (type === 'connection') return storage.getConnectionById(id);
    if (type === 'proxy') return storage.getProxyRaw(id);
    if (type === 'sshKey') return storage.getSshKeyRaw(id);
    if (type === 'jumpHost') return storage.listJumpHosts().find((item) => item.id === id) || null;
    throw restoreError('webdav_backup_format_invalid', 'Unknown restore type');
}
function requireService(present, name) {
    if (!present) throw restoreError('webdav_restore_unavailable', `Restore requires ${name}`, 503);
}
function applyUserSnapshot(payload, { user, notesService = null, resourceService = null } = {}) {
    if (!user?.userId) throw new TypeError('applyUserSnapshot requires user');
    const userId = String(user.userId);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw restoreError('webdav_backup_format_invalid', 'Invalid snapshot');
    }
    assertOwner(payload, userId);
    const collections = payload.collections || payload;
    const records = {};
    // Validate every collection and every existing id BEFORE the first write.
    // createOwned is an upsert: a catch-all update/create fallback steals rows.
    const typeFor = { proxies: 'proxy', sshKeys: 'sshKey', jumpHosts: 'jumpHost', connections: 'connection' };
    for (const name of RESTORE_COLLECTIONS) {
        const rows = collections[name] ?? [];
        if (!Array.isArray(rows)) throw restoreError('webdav_backup_format_invalid', 'Invalid collection');
        if (rows.length) requireService(name === 'notes' ? notesService : resourceService, name === 'notes' ? 'NotesService' : 'ResourceService');
        const seen = new Set();
        records[name] = rows.map((row) => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw restoreError('webdav_backup_format_invalid', 'Invalid record');
            assertOwner(row, userId);
            const id = idOf(row, name);
            if (!id || seen.has(id)) throw restoreError('webdav_backup_format_invalid', 'Missing or duplicate record id');
            seen.add(id);
            const existing = name === 'notes'
                ? notesService.stmtGet.get(id)
                : resourceRow(resourceService, typeFor[name], id);
            if (existing) assertOwner(existing, userId, true);
            return { row, id, existing };
        });
    }
    const restored = Object.fromEntries(RESTORE_COLLECTIONS.map((name) => [name, 0]));
    // Publish restoration as a local mutation, including owned-sync outbox.
    // Dependencies precede connections; jump hosts can refer to connections.
    const ctx = {};
    for (const name of ['proxies', 'sshKeys', 'connections', 'jumpHosts', 'notes']) {
        for (const { row, id, existing } of records[name]) {
            if (name === 'notes') {
                const patch = { id, title: row.title, content: row.content,
                    groupPath: row.groupPath ?? row.group_path, tags: row.tags,
                    linkedConnectionIds: row.linkedConnectionIds,
                    shareWithUsers: false, shareWithAdmins: false,
                    allowAiRead: false, allowAiWrite: false };
                if (existing) {
                    if (existing.deleted_at) notesService.restore(user, id, ctx);
                    const current = notesService.get(user, id, { includeContent: false });
                    notesService.update(user, id, { ...patch, expectedRevision: current.revision }, ctx);
                } else notesService.create(user, patch, ctx);
            } else {
                // Restore private; an archive cannot grant new sharing rights.
                const data = { ...row, id, ownerUserId: userId, visibility: 'private', shareWithUsers: false, shareWithAdmins: false };
                if (name === 'connections') {
                    if (existing) resourceService.updateConnection(user, id, (current) => ({ ...current, ...data }), ctx);
                    else resourceService.createConnection(user, data, ctx);
                } else if (existing) resourceService.updateOwned(user, typeFor[name], id, data, ctx);
                else resourceService.createOwned(user, typeFor[name], data, ctx);
            }
            restored[name] += 1;
        }
    }
    const unsupportedCollections = Object.keys(collections).filter((name) => !RESTORE_COLLECTIONS.includes(name) && Array.isArray(collections[name]) && collections[name].length > 0);
    return { ok: true, restored, unsupportedCollections };
}
async function openVaultPayload(body, vaultPassword) {
    if (detectVaultEnvelope(body) !== 'password-wrapped') throw new WebDavVaultPasswordError('webdav_vault_password_invalid');
    return openPlainArchive(unwrapVaultArchive(body, vaultPassword));
}
module.exports = { RESTORE_COLLECTIONS, applyUserSnapshot, openVaultPayload };
