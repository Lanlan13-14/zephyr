'use strict';
/*
 * notes-service.js — owner/ACL/revision notes (FREEZE plan §6, §18.5).
 * Independent of AI Memory. Soft-delete with 30-day retention target.
 */
const crypto = require('crypto');
const { CAP, HttpError } = require('./authz');
const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

const TITLE_MAX = 200;
const CONTENT_MAX = 1024 * 1024;
const TAGS_MAX = 100;
const LINKS_MAX = 100;

function parseJson(value, fallback) {
    try { return JSON.parse(value || ''); } catch { return fallback; }
}

class NotesService {
    /**
     * @param {import('better-sqlite3').Database} db
     * @param {import('./authz').Authz} authz
     * @param {() => number} [now]
     */
    constructor(db, authz, now = () => Date.now(), options = {}) {
        if (now && typeof now === 'object') {
            options = now;
            now = () => Date.now();
        }
        this.db = db;
        this.authz = authz;
        this.now = now;
        this.getUserById = typeof authz?.getUserById === 'function'
            ? authz.getUserById.bind(authz)
            : null;
        if (!this.getUserById) {
            const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
            if (userColumns.has('userId') && userColumns.has('status')) {
                const lookupUser = db.prepare('SELECT userId, status FROM users WHERE userId = ?');
                this.getUserById = (userId) => lookupUser.get(String(userId || '')) || null;
            }
        }
        this.mobileChangeBridge = options.mobileChangeBridge === false
            ? null
            : (options.mobileChangeBridge || getMobileV1ChangeBridge(db));
        this.stmtInsert = db.prepare(`INSERT INTO notes
            (note_id, owner_user_id, title, content, group_path, tags_json, linked_connection_ids_json, sort_order, revision, created_at, updated_at, deleted_at, visibility, share_with_users, share_with_admins, allow_ai, allow_ai_read, allow_ai_write)
            VALUES (@noteId, @ownerUserId, @title, @content, @groupPath, @tagsJson, @linkedJson, @sortOrder, 1, @createdAt, @updatedAt, NULL, @visibility, @shareWithUsers, @shareWithAdmins, @allowAi, @allowAiRead, @allowAiWrite)`);
        this.stmtGet = db.prepare('SELECT * FROM notes WHERE note_id = ?');
        this.stmtUpdate = db.prepare(`UPDATE notes SET title=@title, content=@content, group_path=@groupPath, tags_json=@tagsJson,
            linked_connection_ids_json=@linkedJson, sort_order=@sortOrder, revision=@revision, updated_at=@updatedAt,
            visibility=@visibility, share_with_users=@shareWithUsers, share_with_admins=@shareWithAdmins,
            allow_ai=@allowAi, allow_ai_read=@allowAiRead, allow_ai_write=@allowAiWrite
            WHERE note_id=@noteId AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtSoftDelete = db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE note_id = ? AND deleted_at IS NULL');
        this.stmtRestore = db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ?, revision = revision + 1 WHERE note_id = ? AND deleted_at IS NOT NULL');
        this.stmtListOwner = db.prepare('SELECT * FROM notes WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?');
        this.stmtListTrash = db.prepare('SELECT * FROM notes WHERE owner_user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?');
        this.stmtSearch = db.prepare(`SELECT * FROM notes WHERE owner_user_id = ? AND deleted_at IS NULL
            AND (title LIKE ? OR content LIKE ? OR tags_json LIKE ?) ORDER BY updated_at DESC LIMIT ?`);
        this.stmtCountOwner = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE owner_user_id = ? AND deleted_at IS NULL');
        this.stmtGroups = db.prepare(`SELECT group_path AS groupPath, COUNT(*) AS count FROM notes
            WHERE owner_user_id = ? AND deleted_at IS NULL GROUP BY group_path ORDER BY group_path`);
        this.stmtListUserState = db.prepare('SELECT * FROM notes WHERE owner_user_id = ? ORDER BY created_at ASC, note_id ASC');
        this.stmtScrubUserNote = db.prepare(`UPDATE notes SET
            title = '', content = '', group_path = '', tags_json = '[]', linked_connection_ids_json = '[]',
            sort_order = NULL, revision = ?, updated_at = ?, visibility = 'private',
            share_with_users = 0, share_with_admins = 0,
            allow_ai = 0, allow_ai_read = 0, allow_ai_write = 0
            WHERE note_id = ? AND owner_user_id = ?`);
        this.stmtDeleteUserNote = db.prepare('DELETE FROM notes WHERE note_id = ? AND owner_user_id = ?');
    }

    _runMobileMutation(meta, write) {
        return this.mobileChangeBridge ? this.mobileChangeBridge.runMutation(meta, write) : write();
    }

    _isActiveUserId(userId) {
        if (!userId) return false;
        // Lightweight isolated consumers may not have a users table. The
        // production database always resolves status through canonical Authz.
        if (!this.getUserById) return true;
        try {
            return this.getUserById(String(userId))?.status === 'active';
        } catch {
            return false;
        }
    }

    _assertActiveUser(user) {
        if (!user?.userId || !this._isActiveUserId(user.userId)) {
            throw new HttpError(403, 'account_suspended', 'Account is not active');
        }
    }

    _ownerIsActive(row) {
        return !!row && this._isActiveUserId(row.owner_user_id);
    }

    /** Securely destroy every note owned by an account in the caller's tx. */
    deleteUserState(userId) {
        const ownerUserId = String(userId || '');
        if (!ownerUserId) throw new TypeError('deleteUserState requires a user id');
        return this.db.transaction(() => {
            const rows = this.stmtListUserState.all(ownerUserId);
            for (const row of rows) {
                const revision = Math.max(1, Number(row.revision) || 1) + 1;
                this.stmtScrubUserNote.run(revision, Number(this.now()), row.note_id, ownerUserId);
                const scrubbed = this.stmtGet.get(row.note_id);
                if (this.mobileChangeBridge) {
                    this.mobileChangeBridge.recordMutation({
                        entityType: 'note',
                        entityId: row.note_id,
                        action: 'delete',
                        user: { userId: ownerUserId },
                        before: this._row(scrubbed, { includeContent: true }),
                        after: null,
                        revision,
                    });
                }
                this.stmtDeleteUserNote.run(row.note_id, ownerUserId);
            }
            return { deleted: rows.length };
        })();
    }

    _row(row, { includeContent = true } = {}) {
        if (!row) return null;
        const out = {
            noteId: row.note_id,
            ownerUserId: row.owner_user_id,
            title: row.title,
            groupPath: row.group_path || '',
            tags: parseJson(row.tags_json, []),
            linkedConnectionIds: parseJson(row.linked_connection_ids_json, []),
            sortOrder: row.sort_order == null ? null : Number(row.sort_order),
            revision: Number(row.revision),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
            shareWithUsers: !!row.share_with_users,
            shareWithAdmins: !!row.share_with_admins,
            allowAiRead: !!(row.allow_ai_read || row.allow_ai),
            allowAiWrite: !!row.allow_ai_write,
            // Legacy combined flag: true if either read or write is allowed.
            allowAi: !!(row.allow_ai_read || row.allow_ai_write || row.allow_ai),
            visibility: row.visibility || 'private',
        };
        if (includeContent) out.content = row.content || '';
        else out.preview = String(row.content || '').slice(0, 240);
        return out;
    }

    _assertSize(fields) {
        if (fields.title != null && String(fields.title).length > TITLE_MAX) throw new HttpError(400, 'title_too_long', `标题最长 ${TITLE_MAX} 字符`);
        if (fields.content != null && Buffer.byteLength(String(fields.content), 'utf8') > CONTENT_MAX) throw new HttpError(400, 'content_too_large', '笔记内容过大');
        if (fields.tags && fields.tags.length > TAGS_MAX) throw new HttpError(400, 'too_many_tags', `标签最多 ${TAGS_MAX} 个`);
        if (fields.linkedConnectionIds && fields.linkedConnectionIds.length > LINKS_MAX) throw new HttpError(400, 'too_many_links', `关联连接最多 ${LINKS_MAX} 个`);
    }

    _canRead(user, row) {
        if (!row || row.deleted_at || !this._ownerIsActive(row)) return false;
        if (!this._isActiveUserId(user?.userId)) return false;
        if (row.owner_user_id === user.userId) return true;
        // shareWithAdmins: only admins can see
        if (row.share_with_admins && user.role === 'admin') return true;
        // shareWithUsers: any authenticated user can see
        if (row.share_with_users) return true;
        return this.authz.can(user, CAP.VIEW, 'note', row.note_id, { ownerUserId: row.owner_user_id });
    }

    _canWrite(user, row) {
        if (!row || row.deleted_at || !this._ownerIsActive(row)) return false;
        if (!this._isActiveUserId(user?.userId)) return false;
        if (row.owner_user_id === user.userId) return true;
        return this.authz.can(user, CAP.EDIT, 'note', row.note_id, { ownerUserId: row.owner_user_id });
    }

    _aiFlags(row = {}) {
        const read = !!(row.allow_ai_read || row.allow_ai);
        const write = !!(row.allow_ai_write || 0);
        return { read, write };
    }

    /** AI may only touch notes the owner explicitly allowed (read and/or write). */
    assertAiAccess(user, noteId, { write = false } = {}) {
        const row = this.stmtGet.get(String(noteId || ''));
        if (row && !row.deleted_at && !this._ownerIsActive(row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Note does not exist or is inaccessible');
        }
        if (!row || row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        if (write && !this._canWrite(user, row)) throw new HttpError(403, 'forbidden_resource_edit', '当前账号没有编辑此笔记的权限');
        if (!write && !this._canRead(user, row)) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        const flags = this._aiFlags(row);
        if (write && !flags.write) {
            throw new HttpError(403, 'note_ai_write_disabled', '该笔记未允许 AI 编辑；请在笔记共享设置中开启「允许 AI 编辑」');
        }
        if (!write && !flags.read) {
            throw new HttpError(403, 'note_ai_read_disabled', '该笔记未允许 AI 读取；请在笔记共享设置中开启「允许 AI 读取」');
        }
        return this._row(row, { includeContent: true });
    }

    listForAi(user, options = {}) {
        const result = this.list(user, options);
        const notes = (result.notes || []).filter((note) => note.allowAiRead === true);
        return { ...result, notes, total: notes.length };
    }

    create(user, data = {}, mutationContext = {}) {
        this._assertActiveUser(user);
        return this._runMobileMutation({
            entityType: 'note', entityId: data.id, action: 'upsert', user, before: null,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => this._create(user, data));
    }

    _create(user, {
        id,
        title, content = '', groupPath = '', tags = [], linkedConnectionIds = [],
        shareWithUsers = false, shareWithAdmins = false,
        allowAi, allowAiRead, allowAiWrite,
    } = {}) {
        title = String(title || '').trim() || '未命名笔记';
        content = String(content || '');
        groupPath = String(groupPath || '').replace(/\.\./g, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
        tags = Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, TAGS_MAX) : [];
        linkedConnectionIds = Array.isArray(linkedConnectionIds) ? linkedConnectionIds.map(String).filter(Boolean).slice(0, LINKS_MAX) : [];
        this._assertSize({ title, content, tags, linkedConnectionIds });
        const nowTs = this.now();
        const noteId = String(id || '').trim() || crypto.randomUUID();
        const shareWithUsersVal = shareWithUsers ? 1 : 0;
        const shareWithAdminsVal = shareWithAdmins ? 1 : 0;
        // allowAi is a legacy alias that sets both when specific flags are omitted.
        let allowAiReadVal = allowAiRead !== undefined ? (allowAiRead ? 1 : 0)
            : (allowAi !== undefined ? (allowAi ? 1 : 0) : 0);
        let allowAiWriteVal = allowAiWrite !== undefined ? (allowAiWrite ? 1 : 0)
            : (allowAi !== undefined ? (allowAi ? 1 : 0) : 0);
        // Write implies read so AI can verify after edit; no-read forces no-write.
        if (allowAiWriteVal) allowAiReadVal = 1;
        if (!allowAiReadVal) allowAiWriteVal = 0;
        const allowAiVal = (allowAiReadVal || allowAiWriteVal) ? 1 : 0;
        this.stmtInsert.run({
            noteId,
            ownerUserId: user.userId,
            title,
            content,
            groupPath,
            tagsJson: JSON.stringify(tags),
            linkedJson: JSON.stringify(linkedConnectionIds),
            sortOrder: null,
            createdAt: nowTs,
            updatedAt: nowTs,
            visibility: shareWithUsersVal ? 'shared' : shareWithAdminsVal ? 'admin' : 'private',
            shareWithUsers: shareWithUsersVal,
            shareWithAdmins: shareWithAdminsVal,
            allowAi: allowAiVal,
            allowAiRead: allowAiReadVal,
            allowAiWrite: allowAiWriteVal,
        });
        this.authz.audit({
            actorUserId: user.userId, resourceType: 'note', resourceId: noteId, action: 'note.create', outcome: 'success',
            metadata: { title, allowAiRead: !!allowAiReadVal, allowAiWrite: !!allowAiWriteVal },
        });
        return this.get(user, noteId);
    }

    get(user, noteId, { includeContent = true } = {}) {
        const row = this.stmtGet.get(String(noteId));
        if (!row || !this._canRead(user, row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        }
        return this._row(row, { includeContent });
    }

    update(user, noteId, patch = {}, mutationContext = {}) {
        const beforeRow = this.stmtGet.get(String(noteId));
        const before = beforeRow ? this._row(beforeRow, { includeContent: true }) : null;
        return this._runMobileMutation({
            entityType: 'note', entityId: noteId, action: 'upsert', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => this._update(user, noteId, patch));
    }

    _update(user, noteId, patch = {}) {
        const row = this.stmtGet.get(String(noteId));
        if (row && !row.deleted_at && !this._ownerIsActive(row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Note does not exist or is inaccessible');
        }
        if (!row || row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        if (!this._canWrite(user, row)) throw new HttpError(403, 'forbidden_resource_edit', '当前账号没有编辑此笔记的权限');
        const expectedRevision = Number(patch.expectedRevision);
        if (!Number.isInteger(expectedRevision)) throw new HttpError(400, 'revision_required', '更新必须携带 expectedRevision');
        const shareWithUsers = patch.shareWithUsers !== undefined ? (patch.shareWithUsers ? 1 : 0) : (row.share_with_users || 0);
        const shareWithAdmins = patch.shareWithAdmins !== undefined ? (patch.shareWithAdmins ? 1 : 0) : (row.share_with_admins || 0);
        const prevFlags = this._aiFlags(row);
        let allowAiRead = patch.allowAiRead !== undefined ? (patch.allowAiRead ? 1 : 0)
            : (patch.allowAi !== undefined ? (patch.allowAi ? 1 : 0) : (prevFlags.read ? 1 : 0));
        let allowAiWrite = patch.allowAiWrite !== undefined ? (patch.allowAiWrite ? 1 : 0)
            : (patch.allowAi !== undefined ? (patch.allowAi ? 1 : 0) : (prevFlags.write ? 1 : 0));
        // Write implies read; turning off read also turns off write.
        if (allowAiWrite && !allowAiRead) allowAiRead = 1;
        if (!allowAiRead) allowAiWrite = 0;
        const allowAi = (allowAiRead || allowAiWrite) ? 1 : 0;
        const next = {
            noteId: row.note_id,
            title: patch.title !== undefined ? String(patch.title).trim() || '未命名笔记' : row.title,
            content: patch.content !== undefined ? String(patch.content) : row.content,
            groupPath: patch.groupPath !== undefined ? String(patch.groupPath || '').replace(/\.\./g, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/') : row.group_path,
            tags: patch.tags !== undefined ? (Array.isArray(patch.tags) ? patch.tags.map(String).filter(Boolean).slice(0, TAGS_MAX) : []) : parseJson(row.tags_json, []),
            linkedConnectionIds: patch.linkedConnectionIds !== undefined
                ? (Array.isArray(patch.linkedConnectionIds) ? patch.linkedConnectionIds.map(String).filter(Boolean).slice(0, LINKS_MAX) : [])
                : parseJson(row.linked_connection_ids_json, []),
            sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) : row.sort_order,
            expectedRevision,
            revision: expectedRevision + 1,
            updatedAt: this.now(),
            visibility: shareWithUsers ? 'shared' : shareWithAdmins ? 'admin' : 'private',
            shareWithUsers,
            shareWithAdmins,
            allowAi,
            allowAiRead,
            allowAiWrite,
        };
        this._assertSize(next);
        const result = this.stmtUpdate.run({
            ...next,
            tagsJson: JSON.stringify(next.tags),
            linkedJson: JSON.stringify(next.linkedConnectionIds),
        });
        if (result.changes === 0) {
            throw new HttpError(409, 'note_revision_conflict', '笔记已被其他人更新，请重新加载', false);
        }
        this.authz.audit({ actorUserId: user.userId, resourceType: 'note', resourceId: noteId, action: 'note.update', outcome: 'success', metadata: { revision: next.revision } });
        return this.get(user, noteId);
    }

    delete(user, noteId, mutationContext = {}) {
        const beforeRow = this.stmtGet.get(String(noteId));
        const before = beforeRow ? this._row(beforeRow, { includeContent: true }) : null;
        return this._runMobileMutation({
            entityType: 'note', entityId: noteId, action: 'delete', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => this._delete(user, noteId));
    }

    _delete(user, noteId) {
        const row = this.stmtGet.get(String(noteId));
        if (row && !row.deleted_at && !this._ownerIsActive(row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Note does not exist or is inaccessible');
        }
        if (!row || row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        if (row.owner_user_id !== user.userId && !this.authz.can(user, CAP.DELETE, 'note', noteId, { ownerUserId: row.owner_user_id })) {
            throw new HttpError(403, 'forbidden_resource_delete', '当前账号没有删除此笔记的权限');
        }
        this.stmtSoftDelete.run(this.now(), this.now(), String(noteId));
        this.authz.audit({ actorUserId: user.userId, resourceType: 'note', resourceId: noteId, action: 'note.delete', outcome: 'success' });
        return true;
    }

    /* Permanently destroy a note.
     * Default: only notes already in trash (FREEZE §6.3 second step).
     * force/allowActive: skip trash and hard-delete an active note (user-confirmed). */
    purge(user, noteId, { allowActive = false } = {}) {
        const beforeRow = this.stmtGet.get(String(noteId));
        const write = () => this._purge(user, noteId, { allowActive });
        if (beforeRow && !beforeRow.deleted_at) {
            return this._runMobileMutation({
                entityType: 'note', entityId: noteId, action: 'delete', user,
                before: this._row(beforeRow, { includeContent: true }),
            }, write);
        }
        return this.db.transaction(write)();
    }

    _purge(user, noteId, { allowActive = false } = {}) {
        const row = this.stmtGet.get(String(noteId));
        if (row && !this._ownerIsActive(row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Note does not exist or is inaccessible');
        }
        if (!row) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在');
        if (!row.deleted_at && !allowActive) {
            throw new HttpError(409, 'note_not_in_trash', '笔记不在回收站，无法彻底删除');
        }
        if (row.owner_user_id !== user.userId && !this.authz.can(user, CAP.DELETE, 'note', noteId, { ownerUserId: row.owner_user_id })) {
            throw new HttpError(403, 'forbidden_resource_delete', '当前账号没有删除此笔记的权限');
        }
        this.db.prepare('DELETE FROM notes WHERE note_id = ?').run(String(noteId));
        this.authz.audit({
            actorUserId: user.userId,
            resourceType: 'note',
            resourceId: noteId,
            action: allowActive && !row.deleted_at ? 'note.purge_permanent' : 'note.purge',
            outcome: 'success',
        });
        return true;
    }

    /** Soft-delete or permanent-purge many notes (owner-scoped). */
    bulk(user, { noteIds = [], action = 'trash' } = {}) {
        this._assertActiveUser(user);
        const ids = [...new Set((noteIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 200);
        if (!ids.length) return { ok: true, affected: 0, action };
        let affected = 0;
        const tx = this.db.transaction((items) => {
            for (const id of items) {
                try {
                    if (action === 'trash') {
                        this.delete(user, id);
                        affected += 1;
                    } else if (action === 'restore') {
                        this.restore(user, id);
                        affected += 1;
                    } else if (action === 'purge') {
                        this.purge(user, id, { allowActive: false });
                        affected += 1;
                    } else if (action === 'purge_permanent') {
                        this.purge(user, id, { allowActive: true });
                        affected += 1;
                    }
                } catch (_) {
                    // skip unauthorized / missing rows
                }
            }
        });
        tx(ids);
        this.authz.audit({
            actorUserId: user.userId,
            action: `note.bulk_${action}`,
            outcome: 'success',
            metadata: { requested: ids.length, affected },
        });
        return { ok: true, affected, action };
    }

    /* Empty the trash for the calling user (permanently destroy all their
     * soft-deleted notes). */
    emptyTrash(user) {
        this._assertActiveUser(user);
        const rows = this.db.prepare('SELECT note_id FROM notes WHERE owner_user_id = ? AND deleted_at IS NOT NULL').all(user.userId);
        if (!rows.length) return { purged: 0 };
        const stmt = this.db.prepare('DELETE FROM notes WHERE note_id = ? AND owner_user_id = ?');
        const tx = this.db.transaction((items) => {
            for (const r of items) stmt.run(r.note_id, user.userId);
        });
        tx(rows);
        this.authz.audit({ actorUserId: user.userId, action: 'note.empty_trash', outcome: 'success', metadata: { count: rows.length } });
        return { purged: rows.length };
    }

    restore(user, noteId, mutationContext = {}) {
        const beforeRow = this.stmtGet.get(String(noteId));
        const before = beforeRow ? this._row(beforeRow, { includeContent: true }) : null;
        return this._runMobileMutation({
            entityType: 'note', entityId: noteId, action: 'upsert', user, before,
            actorDeviceId: mutationContext.actorDeviceId,
            mutationReceipt: mutationContext.mutationReceipt,
        }, () => this._restore(user, noteId));
    }

    _restore(user, noteId) {
        const row = this.stmtGet.get(String(noteId));
        if (row && !this._ownerIsActive(row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', 'Note does not exist or is inaccessible');
        }
        if (!row || !row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不在回收站');
        if (row.owner_user_id !== user.userId) throw new HttpError(403, 'forbidden_resource_edit', '只能恢复自己的笔记');
        this.stmtRestore.run(this.now(), String(noteId));
        return this.get(user, noteId);
    }

    list(user, { q = '', group = null, tag = null, connectionId = null, limit = 50, offset = 0, trash = false, includeContent = false } = {}) {
        this._assertActiveUser(user);
        limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        offset = Math.max(Number(offset) || 0, 0);
        let rows;
        if (trash) {
            rows = this.stmtListTrash.all(user.userId, limit);
        } else if (q) {
            const like = `%${String(q).slice(0, 100)}%`;
            rows = this.stmtSearch.all(user.userId, like, like, like, limit);
        } else {
            rows = this.stmtListOwner.all(user.userId, limit, offset);
        }
        // Include notes other users have shared with this user:
        // 1. ACL grants (CAP.VIEW / DISCOVER)
        if (!trash) {
            const granted = this.authz.listSubjectGrants(user.userId, { resourceType: 'note' })
                .filter((g) => g.capabilities.includes(CAP.VIEW) || g.capabilities.includes(CAP.DISCOVER));
            for (const g of granted) {
                if (rows.some((r) => r.note_id === g.resourceId)) continue;
                const row = this.stmtGet.get(g.resourceId);
                if (row && !row.deleted_at) rows.push(row);
            }
            // 2. share_with_users — any authenticated user sees these
            const byFlag = user.role === 'admin'
                ? this.db.prepare('SELECT * FROM notes WHERE owner_user_id != ? AND deleted_at IS NULL AND (share_with_users = 1 OR share_with_admins = 1) ORDER BY updated_at DESC LIMIT 200').all(user.userId)
                : this.db.prepare('SELECT * FROM notes WHERE owner_user_id != ? AND deleted_at IS NULL AND share_with_users = 1 ORDER BY updated_at DESC LIMIT 200').all(user.userId);
            for (const row of byFlag) {
                if (!rows.some((r) => r.note_id === row.note_id)) rows.push(row);
            }
        }
        rows = rows.filter((row) => this._ownerIsActive(row));
        if (group != null) {
            const g = String(group);
            rows = rows.filter((r) => (r.group_path || '') === g);
        }
        if (tag) {
            const t = String(tag);
            rows = rows.filter((r) => parseJson(r.tags_json, []).includes(t));
        }
        if (connectionId) {
            const cid = String(connectionId);
            rows = rows.filter((r) => parseJson(r.linked_connection_ids_json, []).includes(cid));
        }
        return {
            notes: rows.map((r) => this._row(r, { includeContent: includeContent === true })),
            total: trash ? rows.length : this.stmtCountOwner.get(user.userId).c,
        };
    }

    /**
     * Owner-complete note projection for mobile bootstrap/changes.
     *
     * The web list path redacts `content` to a 240-char preview so the library
     * page stays cheap. Sync must send the full body: One stores the payload as
     * the offline mirror, and a title-only page is a durable data loss, not a
     * UI convenience. Trash stays off this list: a bootstrap upsert would
     * clear deletedAt on the device. Restore still arrives as a later change.
     */
    listOwnedForSync(user) {
        this._assertActiveUser(user);
        const rows = this.stmtListUserState.all(user.userId);
        return rows
            .filter((row) => this._ownerIsActive(row) && !row.deleted_at)
            .map((row) => this._row(row, { includeContent: true }));
    }

    groups(user) {
        this._assertActiveUser(user);
        return this.stmtGroups.all(user.userId).map((r) => ({ groupPath: r.groupPath || '', count: Number(r.count) }));
    }

    /* Rename a group path for all of the user's notes in that group (§6.4.2).
     * Sub-paths are NOT rewritten (e.g. ops/runbooks -> dev/runbooks only
     * affects notes whose group_path === 'ops/runbooks', not 'ops/runbooks/old'). */
    renameGroup(user, oldPath, newPath) {
        this._assertActiveUser(user);
        const oldSafe = String(oldPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const newSafe = String(newPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!oldSafe) throw new HttpError(400, 'invalid_group', '分组路径不能为空');
        const rows = this.db.prepare('SELECT note_id, revision FROM notes WHERE owner_user_id = ? AND group_path = ? AND deleted_at IS NULL')
            .all(user.userId, oldSafe);
        this.db.transaction(() => {
            for (const row of rows) {
                this.update(user, row.note_id, { groupPath: newSafe, expectedRevision: Number(row.revision) });
            }
        })();
        this.authz.audit({ actorUserId: user.userId, action: 'note.rename_group', outcome: 'success', metadata: { from: oldSafe, to: newSafe, affected: rows.length } });
        return { renamed: rows.length };
    }

    /* Delete a group: move all its notes to ungrouped (§6.4.2). */
    deleteGroup(user, groupPath) {
        this._assertActiveUser(user);
        const safe = String(groupPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!safe) throw new HttpError(400, 'invalid_group', '分组路径不能为空');
        const rows = this.db.prepare('SELECT note_id, revision FROM notes WHERE owner_user_id = ? AND group_path = ? AND deleted_at IS NULL')
            .all(user.userId, safe);
        this.db.transaction(() => {
            for (const row of rows) {
                this.update(user, row.note_id, { groupPath: '', expectedRevision: Number(row.revision) });
            }
        })();
        this.authz.audit({ actorUserId: user.userId, action: 'note.delete_group', outcome: 'success', metadata: { group: safe, affected: rows.length } });
        return { moved: rows.length };
    }

    /** Import a single markdown file. Filename → title, optional directory → group. */
    importMarkdown(user, { filename, content, groupPath = '' } = {}) {
        const base = String(filename || 'import.md').replace(/[\\/]+/g, '/').split('/').pop();
        const title = base.replace(/\.md$/i, '').slice(0, TITLE_MAX) || '导入笔记';
        const safeGroup = String(groupPath || '').replace(/\.\./g, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        return this.create(user, { title, content: String(content || ''), groupPath: safeGroup });
    }

    exportMarkdown(user, noteId) {
        const note = this.get(user, noteId, { includeContent: true });
        const safeName = note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'note';
        // Prepend a title heading so the exported file is self-describing
        const body = `# ${note.title}\n\n${note.content || ''}`;
        return { filename: `${safeName}.md`, content: body, title: note.title };
    }
}

module.exports = { NotesService, TITLE_MAX, CONTENT_MAX };
