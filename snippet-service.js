'use strict';

const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { HttpError } = require('./authz');
const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');

const MAX_SNIPPETS = 500;
const MAX_ID_CHARS = 120;
const MAX_NAME_CHARS = 60;
const MAX_COMMAND_CHARS = 20000;
const MAX_GROUP_CHARS = 40;

function asUser(userOrId) {
    if (userOrId && typeof userOrId === 'object') return userOrId;
    return { userId: String(userOrId || '') };
}

function conflict() {
    return new HttpError(409, 'revision_conflict', 'The snippet changed on another client. Reload it and retry.');
}

function inaccessible() {
    return new HttpError(404, 'resource_not_found_or_inaccessible', 'The snippet does not exist or is inaccessible.');
}

function stableLegacyId(userId, item, index) {
    const supplied = String(item?.id || '').trim();
    if (supplied) return supplied.slice(0, MAX_ID_CHARS);
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify([String(userId), Number(index), item?.name || '', item?.command || '']))
        .digest('hex')
        .slice(0, 32);
    return `legacy-${digest}`;
}

class SnippetService {
    constructor(db, now = () => Date.now(), options = {}) {
        if (!db) throw new TypeError('SnippetService requires a SQLite db');
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
        this._migrateLegacySettings();
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS snippets (
                owner_user_id TEXT NOT NULL,
                snippet_id TEXT NOT NULL,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT '',
                auto_run INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER,
                PRIMARY KEY (owner_user_id, snippet_id)
            );
            CREATE INDEX IF NOT EXISTS idx_snippets_owner_active
                ON snippets(owner_user_id, deleted_at, updated_at DESC);
        `);
    }

    _prepare() {
        this.stmtList = this.db.prepare(`SELECT * FROM snippets
            WHERE owner_user_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC, snippet_id ASC`);
        this.stmtGet = this.db.prepare(`SELECT * FROM snippets
            WHERE owner_user_id = ? AND snippet_id = ?`);
        this.stmtCountActive = this.db.prepare(`SELECT COUNT(*) AS count FROM snippets
            WHERE owner_user_id = ? AND deleted_at IS NULL`);
        this.stmtCountAny = this.db.prepare(`SELECT COUNT(*) AS count FROM snippets
            WHERE owner_user_id = ?`);
        this.stmtInsert = this.db.prepare(`INSERT INTO snippets
            (owner_user_id, snippet_id, name, command, group_name, auto_run,
             revision, created_at, updated_at, deleted_at)
            VALUES (@ownerUserId, @id, @name, @command, @group, @autoRun,
                    @revision, @createdAt, @updatedAt, NULL)`);
        this.stmtUpdate = this.db.prepare(`UPDATE snippets
            SET name=@name, command=@command, group_name=@group, auto_run=@autoRun,
                revision=revision+1, updated_at=@updatedAt
            WHERE owner_user_id=@ownerUserId AND snippet_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtDelete = this.db.prepare(`UPDATE snippets
            SET revision=revision+1, updated_at=@updatedAt, deleted_at=@deletedAt
            WHERE owner_user_id=@ownerUserId AND snippet_id=@id
              AND revision=@expectedRevision AND deleted_at IS NULL`);
        this.stmtRestore = this.db.prepare(`UPDATE snippets
            SET revision=revision+1, updated_at=@updatedAt, deleted_at=NULL
            WHERE owner_user_id=@ownerUserId AND snippet_id=@id
              AND revision=@expectedRevision AND deleted_at IS NOT NULL`);
        try {
            this.stmtLegacyProjection = this.db.prepare(`INSERT INTO user_settings
                (user_id, key, value, updated_at) VALUES (?, 'snippets', ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE
                SET value=excluded.value, updated_at=excluded.updated_at`);
        } catch {
            this.stmtLegacyProjection = null;
        }
    }

    _migrateLegacySettings() {
        let rows;
        try {
            rows = this.db.prepare(`SELECT user_id, value, updated_at FROM user_settings
                WHERE key = 'snippets'`).all();
        } catch {
            return;
        }
        const insert = this.db.prepare(`INSERT OR IGNORE INTO snippets
            (owner_user_id, snippet_id, name, command, group_name, auto_run,
             revision, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
        this.db.transaction(() => {
            for (const row of rows) {
                if (Number(this.stmtCountAny.get(String(row.user_id))?.count || 0) === 0) {
                    let items;
                    try { items = JSON.parse(row.value); } catch { items = []; }
                    if (!Array.isArray(items)) items = [];
                    const used = new Set();
                    items.slice(0, MAX_SNIPPETS).forEach((item, index) => {
                        try {
                            const normalized = this._normalize(item, null, {
                                id: stableLegacyId(row.user_id, item, index),
                                now: Number(item?.updatedAt || row.updated_at || this.now()),
                            });
                            if (used.has(normalized.id)) return;
                            used.add(normalized.id);
                            insert.run(
                                String(row.user_id), normalized.id, normalized.name, normalized.command,
                                normalized.group, normalized.autoRun ? 1 : 0,
                                Math.max(1, Number(item?.revision) || 1),
                                Number(item?.createdAt || normalized.updatedAt), normalized.updatedAt,
                            );
                        } catch {
                            // Invalid legacy rows stay excluded instead of poisoning startup.
                        }
                    });
                }
                this._syncLegacyProjection(row.user_id);
            }
        })();
    }

    _row(row) {
        if (!row) return null;
        return {
            id: row.snippet_id,
            ownerUserId: row.owner_user_id,
            name: row.name,
            command: row.command,
            group: row.group_name || '',
            autoRun: !!row.auto_run,
            revision: Math.max(1, Number(row.revision) || 1),
            createdAt: Number(row.created_at) || 0,
            updatedAt: Number(row.updated_at) || 0,
            deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
        };
    }

    _normalize(input = {}, old = null, options = {}) {
        const id = String(options.id || input.id || input.snippetId || old?.id || crypto.randomUUID()).trim();
        const name = String(input.name ?? old?.name ?? '').trim();
        const command = String(input.command ?? old?.command ?? '');
        const group = String(input.group ?? old?.group ?? '').trim();
        if (!id || id.length > MAX_ID_CHARS) {
            throw new HttpError(400, 'invalid_snippet', `Snippet id must be 1-${MAX_ID_CHARS} characters.`);
        }
        if (!name || name.length > MAX_NAME_CHARS || !command.trim()
            || command.length > MAX_COMMAND_CHARS || group.length > MAX_GROUP_CHARS) {
            throw new HttpError(400, 'invalid_snippet', 'Snippet fields exceed the allowed limits.');
        }
        const timestamp = Number(options.now || this.now());
        return {
            id,
            name,
            command,
            group,
            autoRun: input.autoRun !== undefined ? !!input.autoRun : !!old?.autoRun,
            createdAt: Number(old?.createdAt || input.createdAt || timestamp),
            updatedAt: timestamp,
        };
    }

    _runMobileMutation(meta, write) {
        return this.mobileChangeBridge ? this.mobileChangeBridge.runMutation(meta, write) : write();
    }

    _syncLegacyProjection(userOrId) {
        if (!this.stmtLegacyProjection) return;
        const user = asUser(userOrId);
        const projection = this.list(user).map(({ deletedAt, ownerUserId, ...item }) => item);
        this.stmtLegacyProjection.run(String(user.userId), JSON.stringify(projection), Number(this.now()));
    }

    list(userOrId) {
        const user = asUser(userOrId);
        return this.stmtList.all(String(user.userId)).map((row) => this._row(row));
    }

    read(userOrId, id, { includeDeleted = false } = {}) {
        const user = asUser(userOrId);
        const row = this._row(this.stmtGet.get(String(user.userId), String(id)));
        if (!row || (!includeDeleted && row.deletedAt != null)) return null;
        return row;
    }

    hasHistory(userOrId) {
        const user = asUser(userOrId);
        return Number(this.stmtCountAny.get(String(user.userId))?.count || 0) > 0;
    }

    residency(userOrId, id) {
        return this.read(userOrId, id, { includeDeleted: true }) ? 'owned' : 'missing';
    }

    create(userOrId, data = {}, { actorDeviceId = null, mutationReceipt = null } = {}) {
        const user = asUser(userOrId);
        const normalized = this._normalize(data);
        return this._runMobileMutation({
            entityType: 'snippet', entityId: normalized.id, action: 'upsert', user, before: null,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            if (this.read(user, normalized.id, { includeDeleted: true })) throw conflict();
            if (Number(this.stmtCountActive.get(String(user.userId))?.count || 0) >= MAX_SNIPPETS) {
                throw new HttpError(409, 'snippet_limit_reached', `At most ${MAX_SNIPPETS} snippets are allowed.`);
            }
            this.stmtInsert.run({
                ownerUserId: String(user.userId), ...normalized, autoRun: normalized.autoRun ? 1 : 0,
                revision: 1,
            });
            this._syncLegacyProjection(user);
            return this.read(user, normalized.id);
        });
    }

    update(userOrId, id, patch = {}, {
        expectedRevision,
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        const user = asUser(userOrId);
        const before = this.read(user, id);
        if (!before) throw inaccessible();
        if (Number(expectedRevision) !== before.revision) throw conflict();
        const next = this._normalize(patch, before, { id: before.id });
        const comparable = (row) => ({
            name: row.name, command: row.command, group: row.group, autoRun: row.autoRun,
        });
        if (isDeepStrictEqual(comparable(before), comparable(next))) return before;
        return this._runMobileMutation({
            entityType: 'snippet', entityId: before.id, action: 'upsert', user, before,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const result = this.stmtUpdate.run({
                ownerUserId: String(user.userId), id: before.id,
                name: next.name, command: next.command, group: next.group,
                autoRun: next.autoRun ? 1 : 0, updatedAt: next.updatedAt,
                expectedRevision: before.revision,
            });
            if (Number(result.changes || 0) !== 1) throw conflict();
            this._syncLegacyProjection(user);
            return this.read(user, before.id);
        });
    }

    remove(userOrId, id, {
        expectedRevision,
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        const user = asUser(userOrId);
        const before = this.read(user, id);
        if (!before) throw inaccessible();
        if (Number(expectedRevision) !== before.revision) throw conflict();
        return this._runMobileMutation({
            entityType: 'snippet', entityId: before.id, action: 'delete', user, before,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const timestamp = Number(this.now());
            const result = this.stmtDelete.run({
                ownerUserId: String(user.userId), id: before.id,
                expectedRevision: before.revision, updatedAt: timestamp, deletedAt: timestamp,
            });
            if (Number(result.changes || 0) !== 1) throw conflict();
            this._syncLegacyProjection(user);
            return true;
        });
    }

    restore(userOrId, id, {
        expectedRevision,
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        const user = asUser(userOrId);
        const before = this.read(user, id, { includeDeleted: true });
        if (!before || before.deletedAt == null) throw inaccessible();
        if (expectedRevision !== undefined && Number(expectedRevision) !== before.revision) throw conflict();
        return this._runMobileMutation({
            entityType: 'snippet', entityId: before.id, action: 'upsert', user, before,
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const result = this.stmtRestore.run({
                ownerUserId: String(user.userId), id: before.id,
                expectedRevision: before.revision, updatedAt: Number(this.now()),
            });
            if (Number(result.changes || 0) !== 1) throw conflict();
            this._syncLegacyProjection(user);
            return this.read(user, before.id);
        });
    }

    replaceAll(userOrId, input) {
        const user = asUser(userOrId);
        if (!Array.isArray(input)) throw new HttpError(400, 'invalid_snippet', 'snippets must be an array.');
        if (input.length > MAX_SNIPPETS) throw new HttpError(409, 'snippet_limit_reached', `At most ${MAX_SNIPPETS} snippets are allowed.`);

        return this.db.transaction(() => {
            const current = this.list(user);
            const currentById = new Map(current.map((item) => [item.id, item]));
            const requested = [];
            const ids = new Set();
            for (const raw of input) {
                const normalized = this._normalize(raw, null, { id: raw?.id || raw?.snippetId });
                if (ids.has(normalized.id)) {
                    throw new HttpError(400, 'invalid_snippet', `Duplicate snippet id: ${normalized.id}`);
                }
                ids.add(normalized.id);
                requested.push({ raw, normalized });
            }

            for (const { raw, normalized } of requested) {
                const old = currentById.get(normalized.id);
                if (!old) {
                    if (Math.max(1, Number(raw?.revision) || 1) !== 1) throw conflict();
                    this.create(user, { ...normalized, id: normalized.id });
                    continue;
                }
                const changed = !isDeepStrictEqual(
                    { name: old.name, command: old.command, group: old.group, autoRun: old.autoRun },
                    { name: normalized.name, command: normalized.command, group: normalized.group, autoRun: normalized.autoRun },
                );
                if (!changed) continue;
                if (Number(raw?.revision) !== old.revision + 1) throw conflict();
                this.update(user, old.id, normalized, { expectedRevision: old.revision });
            }

            for (const old of current) {
                if (!ids.has(old.id)) this.remove(user, old.id, { expectedRevision: old.revision });
            }
            return this.list(user);
        })();
    }
}

module.exports = {
    SnippetService,
    MAX_SNIPPETS,
    MAX_ID_CHARS,
    MAX_NAME_CHARS,
    MAX_COMMAND_CHARS,
    MAX_GROUP_CHARS,
    stableLegacyId,
};
