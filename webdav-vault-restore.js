'use strict';

const { openPlainArchive } = require('./webdav-backup-provider');
const {
    detectVaultEnvelope,
    unwrapVaultArchive,
    WebDavVaultPasswordError,
} = require('./webdav-vault-password');

const RESTORE_COLLECTIONS = Object.freeze([
    'connections', 'proxies', 'sshKeys', 'jumpHosts', 'notes',
]);

function emptyCounts() {
    return Object.fromEntries(RESTORE_COLLECTIONS.map((name) => [name, 0]));
}

function noteIdOf(row) {
    return String(row?.id || row?.noteId || row?.note_id || '');
}

function resourceIdOf(row) {
    return String(row?.id || '');
}

function applyNotes(notesService, user, records) {
    let count = 0;
    for (const row of records || []) {
        const id = noteIdOf(row);
        if (!id) continue;
        const patch = {
            id,
            title: row.title,
            content: row.content,
            groupPath: row.groupPath || row.group_path,
            tags: row.tags,
            linkedConnectionIds: row.linkedConnectionIds || row.linked_connection_ids,
            shareWithUsers: row.shareWithUsers,
            shareWithAdmins: row.shareWithAdmins,
            allowAiRead: row.allowAiRead,
            allowAiWrite: row.allowAiWrite,
        };
        const ctx = { remoteMerge: true };
        try {
            const current = notesService.get(user, id, { includeContent: false });
            notesService.update(user, id, {
                ...patch,
                expectedRevision: Number(current.revision) || 1,
            }, ctx);
        } catch {
            notesService.create(user, patch, ctx);
        }
        count += 1;
    }
    return count;
}

function applyOwned(resourceService, user, type, records) {
    let count = 0;
    for (const row of records || []) {
        const id = resourceIdOf(row);
        if (!id) continue;
        const ctx = { remoteMerge: true };
        if (type === 'connection') {
            const existing = resourceService.storage.getConnectionById(id);
            if (existing && existing.ownerUserId === user.userId) {
                resourceService.updateConnection(user, id, () => ({ ...existing, ...row, id }), ctx);
            } else {
                resourceService.createConnection(user, { ...row, id }, ctx);
            }
            count += 1;
            continue;
        }
        try {
            resourceService.updateOwned(user, type, id, { ...row, id }, ctx);
        } catch {
            resourceService.createOwned(user, type, { ...row, id }, ctx);
        }
        count += 1;
    }
    return count;
}

function applyUserSnapshot(payload, {
    user,
    notesService = null,
    resourceService = null,
} = {}) {
    if (!user?.userId) throw new TypeError('applyUserSnapshot requires user');
    const collections = payload && typeof payload === 'object' ? (payload.collections || payload) : {};
    const restored = emptyCounts();
    if (notesService) restored.notes = applyNotes(notesService, user, collections.notes);
    if (resourceService) {
        restored.connections = applyOwned(resourceService, user, 'connection', collections.connections);
        restored.proxies = applyOwned(resourceService, user, 'proxy', collections.proxies);
        restored.sshKeys = applyOwned(resourceService, user, 'sshKey', collections.sshKeys);
        restored.jumpHosts = applyOwned(resourceService, user, 'jumpHost', collections.jumpHosts);
    }
    return { ok: true, restored };
}

async function openVaultPayload(body, vaultPassword) {
    const kind = detectVaultEnvelope(body);
    if (kind !== 'password-wrapped') {
        const err = new WebDavVaultPasswordError('webdav_vault_password_invalid');
        throw err;
    }
    const zip = unwrapVaultArchive(body, vaultPassword);
    return openPlainArchive(zip);
}

module.exports = {
    RESTORE_COLLECTIONS,
    applyUserSnapshot,
    openVaultPayload,
};
