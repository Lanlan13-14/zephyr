import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { Authz, CAP } = require(path.join(root, 'authz.js'));
const { ResourceAclMetadataService } = require(path.join(root, 'acl-token-metadata-service.js'));
const { MobileV1ChangeBridge } = require(path.join(root, 'mobile-v1-change-bridge.js'));
const { NotesService } = require(path.join(root, 'notes-service.js'));
const { UserService } = require(path.join(root, 'user-service.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function freshLifecycle() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-deleted-owner-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      userId TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      defaultPassword INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      isSuperAdmin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE connections (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE proxies (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE ssh_keys (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE jump_hosts (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE auth_sessions (
      sid_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, revoked_at INTEGER, revoke_reason TEXT
    );
    CREATE TABLE resource_acl (
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT 'user',
      subject_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      granted_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      PRIMARY KEY (resource_type, resource_id, subject_type, subject_id)
    );
    CREATE TABLE audit_events (
      event_id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      target_user_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE notes (
      note_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      group_path TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
      sort_order REAL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      visibility TEXT NOT NULL DEFAULT 'private',
      share_with_users INTEGER NOT NULL DEFAULT 0,
      share_with_admins INTEGER NOT NULL DEFAULT 0,
      allow_ai INTEGER NOT NULL DEFAULT 0,
      allow_ai_read INTEGER NOT NULL DEFAULT 0,
      allow_ai_write INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE note_delete_probe (
      note_id TEXT PRIMARY KEY, title TEXT, content TEXT, group_path TEXT,
      tags_json TEXT, links_json TEXT, visibility TEXT,
      share_users INTEGER, share_admins INTEGER, allow_ai INTEGER,
      allow_ai_read INTEGER, allow_ai_write INTEGER
    );
    CREATE TRIGGER capture_scrubbed_note BEFORE DELETE ON notes BEGIN
      INSERT INTO note_delete_probe VALUES (
        OLD.note_id, OLD.title, OLD.content, OLD.group_path,
        OLD.tags_json, OLD.linked_connection_ids_json, OLD.visibility,
        OLD.share_with_users, OLD.share_with_admins, OLD.allow_ai,
        OLD.allow_ai_read, OLD.allow_ai_write
      );
    END;
  `);

  let clock = 2_000_000_000_000;
  const insertUser = db.prepare(`INSERT INTO users
    (username, userId, passwordHash, defaultPassword, createdAt, updatedAt, email, role, status, isSuperAdmin)
    VALUES (?, ?, 'hash', 0, ?, ?, '', ?, ?, ?)`);
  insertUser.run('admin', 'admin-id', ++clock, clock, 'admin', 'active', 1);
  insertUser.run('deleted-name', 'target-old', ++clock, clock, 'user', 'active', 0);
  insertUser.run('reader', 'reader-id', ++clock, clock, 'user', 'active', 0);
  db.prepare('INSERT INTO connections VALUES (?, ?)').run('target-connection', 'target-old');
  db.prepare('INSERT INTO connections VALUES (?, ?)').run('admin-connection', 'admin-id');
  db.prepare('INSERT INTO connections VALUES (?, ?)').run('reader-connection', 'reader-id');
  db.prepare('INSERT INTO auth_sessions VALUES (?, ?, NULL, NULL)').run('target-session', 'target-old');

  const normalizeUser = (row) => row ? { ...row, isSuperAdmin: !!row.isSuperAdmin, defaultPassword: !!row.defaultPassword } : null;
  const storage = {
    rawDb: () => db,
    listUsers: () => db.prepare('SELECT * FROM users ORDER BY createdAt').all().map(normalizeUser),
    getUser: (username) => normalizeUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username)),
    getUserById: (userId) => normalizeUser(db.prepare('SELECT * FROM users WHERE userId = ?').get(userId)),
    updateUserById(userId, patch = {}) {
      const current = this.getUserById(userId);
      if (!current) return null;
      db.prepare('UPDATE users SET status = ?, updatedAt = ? WHERE userId = ?')
        .run(patch.status ?? current.status, ++clock, userId);
      return this.getUserById(userId);
    },
    archiveDeletedUsername(userId) {
      const current = this.getUserById(userId);
      if (!current || current.status !== 'deleted') return null;
      db.prepare('UPDATE users SET username = ?, updatedAt = ? WHERE userId = ?')
        .run(`${current.username}#deleted:${userId}`, ++clock, userId);
      return this.getUserById(userId);
    },
    createUser(fields) {
      const userId = crypto.randomUUID();
      insertUser.run(fields.username, userId, ++clock, clock, fields.role || 'user', fields.status || 'active', fields.isSuperAdmin ? 1 : 0);
      return this.getUserById(userId);
    },
  };
  const getUserById = (userId) => storage.getUserById(userId);
  const authz = new Authz(db, { getUserById, now: () => ++clock });
  const resources = {
    _rawResource(type, id) {
      if (type === 'note') {
        const row = db.prepare('SELECT note_id AS id, owner_user_id AS ownerUserId FROM notes WHERE note_id = ?').get(id);
        return row || null;
      }
      if (type === 'connection') {
        return db.prepare('SELECT id, ownerUserId FROM connections WHERE id = ?').get(id) || null;
      }
      return null;
    },
  };
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const acl = new ResourceAclMetadataService({ db, authz, resources, changeBridge: bridge, now: () => ++clock });
  const notes = new NotesService(db, authz, () => ++clock, { mobileChangeBridge: bridge });
  const lifecycle = {
    beforeDeleteUser({ actor, userId }) {
      acl.deleteUserState(userId, { revokedByUserId: actor?.userId });
      notes.deleteUserState(userId);
      // This mirrors the server lifecycle: the deleted identity loses its
      // entire mobile authority/feed, while ACL tombstones owned by another
      // active account must remain outside that cleanup partition.
      bridge.store.deleteUserState(userId);
    },
    beforeRecreateUser({ actor, userId }) {
      acl.deleteUserState(userId, { revokedByUserId: actor?.userId });
      notes.deleteUserState(userId);
      bridge.store.deleteUserState(userId);
    },
  };
  const sessions = { revokeAllForUser() { return 1; }, setMustChangePassword() {} };
  const users = new UserService(storage, () => sessions, authz, (password) => `hash:${password}`, lifecycle);
  return {
    directory, db, storage, authz, bridge, acl, notes, users,
    cleanup() {
      acl.uninstall();
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('deleted-owner notes and ACL state are atomic, scrubbed, tombstoned, and never inherited', () => {
  const context = freshLifecycle();
  try {
    const admin = context.storage.getUserById('admin-id');
    const target = context.storage.getUserById('target-old');
    const reader = context.storage.getUserById('reader-id');
    const active = context.notes.create(target, {
      id: 'active-shared-note', title: 'sensitive title', content: 'sensitive active body',
      groupPath: 'private/group', tags: ['secret-tag'], linkedConnectionIds: ['target-connection'],
      shareWithUsers: true, shareWithAdmins: true, allowAiRead: true, allowAiWrite: true,
    });
    const trashed = context.notes.create(target, {
      id: 'trashed-private-note', title: 'trashed title', content: 'sensitive trash body',
    });
    context.notes.delete(target, trashed.noteId);
    assert.throws(
      () => context.notes.get(target, trashed.noteId),
      (error) => error.code === 'resource_not_found_or_inaccessible',
      'direct get must not read a soft-deleted note',
    );
    context.authz.grant({
      resourceType: 'note', resourceId: active.noteId, subjectId: 'reader-id',
      capabilities: [CAP.DISCOVER, CAP.VIEW], grantedByUserId: 'target-old',
    });
    context.authz.grant({
      resourceType: 'connection', resourceId: 'admin-connection', subjectId: 'target-old',
      capabilities: [CAP.VIEW], grantedByUserId: 'admin-id',
    });
    context.authz.grant({
      resourceType: 'connection', resourceId: 'target-connection', subjectId: 'reader-id',
      capabilities: [CAP.VIEW], grantedByUserId: 'target-old',
    });
    context.authz.grant({
      resourceType: 'connection', resourceId: 'reader-connection', subjectId: 'admin-id',
      capabilities: [CAP.VIEW], grantedByUserId: 'target-old',
    });
    assert.ok(context.notes.list(reader).notes.some((note) => note.noteId === active.noteId));

    const cursorsBeforeFailure = new Map(['admin-id', 'target-old', 'reader-id'].map((id) => [
      id, context.bridge.store.latestCursor(id),
    ]));
    context.db.exec(`CREATE TRIGGER reject_user_delete BEFORE UPDATE OF status ON users
      WHEN NEW.status = 'deleted' BEGIN SELECT RAISE(ABORT, 'injected user delete failure'); END;`);
    assert.throws(
      () => context.users.deleteUser(admin, 'target-old', { resourcePolicy: 'transfer-to-admin' }),
      /injected user delete failure/,
    );

    assert.equal(context.storage.getUserById('target-old').status, 'active');
    assert.equal(context.db.prepare('SELECT ownerUserId FROM connections WHERE id = ?').get('target-connection').ownerUserId, 'target-old');
    assert.equal(context.db.prepare('SELECT content FROM notes WHERE note_id = ?').get(active.noteId).content, 'sensitive active body');
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM resource_acl WHERE revoked_at IS NULL').get().count, 4);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM note_delete_probe').get().count, 0);
    assert.equal(context.db.prepare('SELECT revoked_at FROM auth_sessions WHERE sid_hash = ?').get('target-session').revoked_at, null);
    for (const [ownerUserId, cursor] of cursorsBeforeFailure) {
      assert.equal(context.bridge.store.latestCursor(ownerUserId), cursor);
    }

    context.db.exec('DROP TRIGGER reject_user_delete');
    context.users.deleteUser(admin, 'target-old', { resourcePolicy: 'transfer-to-admin' });
    assert.equal(context.storage.getUserById('target-old').status, 'deleted');
    assert.equal(context.db.prepare('SELECT ownerUserId FROM connections WHERE id = ?').get('target-connection').ownerUserId, 'admin-id');
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM notes WHERE owner_user_id = ?').get('target-old').count, 0);

    const scrubbed = context.db.prepare('SELECT * FROM note_delete_probe ORDER BY note_id').all();
    assert.equal(scrubbed.length, 2);
    for (const row of scrubbed) {
      assert.equal(row.title, '');
      assert.equal(row.content, '');
      assert.equal(row.group_path, '');
      assert.equal(row.tags_json, '[]');
      assert.equal(row.links_json, '[]');
      assert.equal(row.visibility, 'private');
      assert.deepEqual([row.share_users, row.share_admins, row.allow_ai, row.allow_ai_read, row.allow_ai_write], [0, 0, 0, 0, 0]);
    }

    const aclRows = context.db.prepare(`SELECT resource_id, subject_id, granted_by_user_id, revoked_at
      FROM resource_acl ORDER BY resource_id`).all();
    assert.ok(aclRows.find((row) => row.resource_id === active.noteId)?.revoked_at);
    assert.ok(aclRows.find((row) => row.resource_id === 'admin-connection')?.revoked_at);
    assert.ok(aclRows.find((row) => row.resource_id === 'target-connection')?.revoked_at);
    const provenanceOnly = aclRows.find((row) => row.resource_id === 'reader-connection');
    assert.equal(provenanceOnly.granted_by_user_id, 'target-old');
    assert.equal(provenanceOnly.revoked_at, null, 'audit provenance alone must not revoke a grant');
    assert.equal(context.authz.listSubjectGrants('target-old').length, 0);
    assert.equal(context.notes.list(reader).notes.some((note) => note.noteId === active.noteId), false);
    assert.throws(() => context.notes.get(reader, active.noteId), (error) => error.code === 'resource_not_found_or_inaccessible');

    // A deleted account's own feed and device authority are intentionally
    // purged. This must never consume the feed partition of a surviving owner
    // whose resource had granted capabilities to the deleted account.
    assert.deepEqual(context.bridge.store.changePage('target-old', 0, 100).changes, []);
    const adminGrant = context.db.prepare(`SELECT grant_key FROM resource_acl
      WHERE resource_id = ? AND subject_id = ?`).get('admin-connection', 'target-old');
    const adminChanges = context.bridge.store.changePage('admin-id', 0, 100).changes;
    const adminAclTombstone = adminChanges.find((change) => (
      change.action === 'delete'
      && change.entityType === 'resourceAcl'
      && change.entityId === adminGrant.grant_key
    ));
    assert.ok(adminAclTombstone, 'surviving owner must retain the ACL revoke tombstone');
    assert.equal(adminAclTombstone.tombstone?.ownerUserId, 'admin-id');

    const recreated = context.users.createUser(admin, {
      username: 'deleted-name', password: 'new-password', role: 'user', mustChangePassword: false,
    });
    assert.notEqual(recreated.userId, 'target-old');
    assert.deepEqual(context.authz.listSubjectGrants(recreated.userId), []);
    assert.equal(context.notes.list(recreated).notes.length, 0);

    const insertHistorical = context.db.prepare(`INSERT INTO notes
      (note_id, owner_user_id, title, content, group_path, tags_json, linked_connection_ids_json,
       sort_order, revision, created_at, updated_at, deleted_at, visibility, share_with_users,
       share_with_admins, allow_ai, allow_ai_read, allow_ai_write)
      VALUES (?, ?, ?, ?, '', '[]', '[]', NULL, 1, 1, 1, NULL, 'shared', 1, 1, 1, 1, 1)`);
    insertHistorical.run('deleted-owner-orphan', 'target-old', 'historical title', 'historical body');
    insertHistorical.run('missing-owner-orphan', 'missing-user', 'missing title', 'missing body');
    for (const noteId of ['deleted-owner-orphan', 'missing-owner-orphan']) {
      assert.throws(() => context.notes.get(reader, noteId), (error) => error.code === 'resource_not_found_or_inaccessible');
      assert.throws(
        () => context.notes.update(reader, noteId, { expectedRevision: 1, content: 'steal' }),
        (error) => error.code === 'resource_not_found_or_inaccessible',
      );
      assert.throws(
        () => context.notes.delete(reader, noteId),
        (error) => error.code === 'resource_not_found_or_inaccessible',
      );
    }
    const readerIds = context.notes.list(reader).notes.map((note) => note.noteId);
    assert.equal(readerIds.includes('deleted-owner-orphan'), false);
    assert.equal(readerIds.includes('missing-owner-orphan'), false);
  } finally {
    context.cleanup();
  }
});
