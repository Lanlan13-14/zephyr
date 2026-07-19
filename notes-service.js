'use strict';
/*
 * notes-service.js — owner/ACL/revision notes (FREEZE plan §6, §18.5).
 * Independent of AI Memory. Soft-delete with 30-day retention target.
 */
const crypto = require('crypto');
const { CAP, HttpError } = require('./authz');

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
    constructor(db, authz, now = () => Date.now()) {
        this.db = db;
        this.authz = authz;
        this.now = now;
        this.stmtInsert = db.prepare(`INSERT INTO notes
            (note_id, owner_user_id, title, content, group_path, tags_json, linked_connection_ids_json, sort_order, revision, created_at, updated_at, deleted_at)
            VALUES (@noteId, @ownerUserId, @title, @content, @groupPath, @tagsJson, @linkedJson, @sortOrder, 1, @createdAt, @updatedAt, NULL)`);
        this.stmtGet = db.prepare('SELECT * FROM notes WHERE note_id = ?');
        this.stmtUpdate = db.prepare(`UPDATE notes SET title=@title, content=@content, group_path=@groupPath, tags_json=@tagsJson,
            linked_connection_ids_json=@linkedJson, sort_order=@sortOrder, revision=@revision, updated_at=@updatedAt
            WHERE note_id=@noteId AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtSoftDelete = db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL');
        this.stmtRestore = db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ?, revision = revision + 1 WHERE note_id = ? AND deleted_at IS NOT NULL');
        this.stmtListOwner = db.prepare('SELECT * FROM notes WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?');
        this.stmtListTrash = db.prepare('SELECT * FROM notes WHERE owner_user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?');
        this.stmtSearch = db.prepare(`SELECT * FROM notes WHERE owner_user_id = ? AND deleted_at IS NULL
            AND (title LIKE ? OR content LIKE ? OR tags_json LIKE ?) ORDER BY updated_at DESC LIMIT ?`);
        this.stmtCountOwner = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE owner_user_id = ? AND deleted_at IS NULL');
        this.stmtGroups = db.prepare(`SELECT group_path AS groupPath, COUNT(*) AS count FROM notes
            WHERE owner_user_id = ? AND deleted_at IS NULL GROUP BY group_path ORDER BY group_path`);
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
        if (!row) return false;
        if (row.owner_user_id === user.userId) return true;
        return this.authz.can(user, CAP.VIEW, 'note', row.note_id, { ownerUserId: row.owner_user_id });
    }

    _canWrite(user, row) {
        if (!row) return false;
        if (row.owner_user_id === user.userId) return true;
        return this.authz.can(user, CAP.EDIT, 'note', row.note_id, { ownerUserId: row.owner_user_id });
    }

    create(user, { title, content = '', groupPath = '', tags = [], linkedConnectionIds = [] } = {}) {
        title = String(title || '').trim() || '未命名笔记';
        content = String(content || '');
        groupPath = String(groupPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        tags = Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, TAGS_MAX) : [];
        linkedConnectionIds = Array.isArray(linkedConnectionIds) ? linkedConnectionIds.map(String).filter(Boolean).slice(0, LINKS_MAX) : [];
        this._assertSize({ title, content, tags, linkedConnectionIds });
        const nowTs = this.now();
        const noteId = crypto.randomUUID();
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
        });
        this.authz.audit({ actorUserId: user.userId, resourceType: 'note', resourceId: noteId, action: 'note.create', outcome: 'success', metadata: { title } });
        return this.get(user, noteId);
    }

    get(user, noteId, { includeContent = true } = {}) {
        const row = this.stmtGet.get(String(noteId));
        if (!row || !this._canRead(user, row)) {
            throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        }
        return this._row(row, { includeContent });
    }

    update(user, noteId, patch = {}) {
        const row = this.stmtGet.get(String(noteId));
        if (!row || row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        if (!this._canWrite(user, row)) throw new HttpError(403, 'forbidden_resource_edit', '当前账号没有编辑此笔记的权限');
        const expectedRevision = Number(patch.expectedRevision);
        if (!Number.isInteger(expectedRevision)) throw new HttpError(400, 'revision_required', '更新必须携带 expectedRevision');
        const next = {
            noteId: row.note_id,
            title: patch.title !== undefined ? String(patch.title).trim() || '未命名笔记' : row.title,
            content: patch.content !== undefined ? String(patch.content) : row.content,
            groupPath: patch.groupPath !== undefined ? String(patch.groupPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : row.group_path,
            tags: patch.tags !== undefined ? (Array.isArray(patch.tags) ? patch.tags.map(String).filter(Boolean).slice(0, TAGS_MAX) : []) : parseJson(row.tags_json, []),
            linkedConnectionIds: patch.linkedConnectionIds !== undefined
                ? (Array.isArray(patch.linkedConnectionIds) ? patch.linkedConnectionIds.map(String).filter(Boolean).slice(0, LINKS_MAX) : [])
                : parseJson(row.linked_connection_ids_json, []),
            sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) : row.sort_order,
            expectedRevision,
            revision: expectedRevision + 1,
            updatedAt: this.now(),
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

    delete(user, noteId) {
        const row = this.stmtGet.get(String(noteId));
        if (!row || row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在或无权访问');
        if (row.owner_user_id !== user.userId && !this.authz.can(user, CAP.DELETE, 'note', noteId, { ownerUserId: row.owner_user_id })) {
            throw new HttpError(403, 'forbidden_resource_delete', '当前账号没有删除此笔记的权限');
        }
        this.stmtSoftDelete.run(this.now(), this.now(), String(noteId));
        this.authz.audit({ actorUserId: user.userId, resourceType: 'note', resourceId: noteId, action: 'note.delete', outcome: 'success' });
        return true;
    }

    /* Permanently destroy a note already in the trash (FREEZE plan §6.3).
     * Regular delete is soft; purge is the irreversible second step. */
    purge(user, noteId) {
        const row = this.stmtGet.get(String(noteId));
        if (!row) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不存在');
        if (!row.deleted_at) throw new HttpError(409, 'note_not_in_trash', '笔记不在回收站，无法彻底删除');
        if (row.owner_user_id !== user.userId && !this.authz.can(user, CAP.DELETE, 'note', noteId, { ownerUserId: row.owner_user_id })) {
            throw new HttpError(403, 'forbidden_resource_delete', '当前账号没有删除此笔记的权限');
        }
        this.db.prepare('DELETE FROM notes WHERE note_id = ?').run(String(noteId));
        this.authz.audit({ actorUserId: user.userId, resourceType: 'note', resourceId: noteId, action: 'note.purge', outcome: 'success' });
        return true;
    }

    /* Empty the trash for the calling user (permanently destroy all their
     * soft-deleted notes). */
    emptyTrash(user) {
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

    restore(user, noteId) {
        const row = this.stmtGet.get(String(noteId));
        if (!row || !row.deleted_at) throw new HttpError(404, 'resource_not_found_or_inaccessible', '笔记不在回收站');
        if (row.owner_user_id !== user.userId) throw new HttpError(403, 'forbidden_resource_edit', '只能恢复自己的笔记');
        this.stmtRestore.run(this.now(), String(noteId));
        return this.get(user, noteId);
    }

    list(user, { q = '', group = null, tag = null, connectionId = null, limit = 50, offset = 0, trash = false } = {}) {
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
        // also include notes shared to this user with discover/view
        const shared = this.authz.listSubjectGrants(user.userId, { resourceType: 'note' })
            .filter((g) => g.capabilities.includes(CAP.VIEW) || g.capabilities.includes(CAP.DISCOVER));
        for (const g of shared) {
            if (rows.some((r) => r.note_id === g.resourceId)) continue;
            const row = this.stmtGet.get(g.resourceId);
            if (row && !row.deleted_at) rows.push(row);
        }
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
            notes: rows.map((r) => this._row(r, { includeContent: false })),
            total: trash ? rows.length : this.stmtCountOwner.get(user.userId).c,
        };
    }

    groups(user) {
        return this.stmtGroups.all(user.userId).map((r) => ({ groupPath: r.groupPath || '', count: Number(r.count) }));
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
        return { filename: `${safeName}.md`, content: note.content, title: note.title };
    }
}

module.exports = { NotesService, TITLE_MAX, CONTENT_MAX };
