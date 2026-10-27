import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { NotesService } = require(path.join(repoRoot, 'notes-service.js'));
const { ResourceService } = require(path.join(repoRoot, 'resource-service.js'));
const { Authz } = require(path.join(repoRoot, 'authz.js'));
const { connectionDefaults } = require(path.join(repoRoot, 'mobile-v1-entities.js'));
const { MobileV1ChangeBridge } = require(path.join(repoRoot, 'mobile-v1-change-bridge.js'));

function inSqliteTx(db) {
  return db.inTransaction === true || db.isTransaction === true;
}

function freshNotes({ onOwnedMutation = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-outbox-atomic-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  db.exec(`
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
  `);
  const authz = {
    can() { return false; },
    audit() {},
    listSubjectGrants() { return []; },
  };
  const notes = new NotesService(db, authz, () => 1_700_000_000_000, {
    onOwnedMutation,
  });
  return {
    db,
    notes,
    store: notes.mobileChangeBridge.store,
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function countTable(db, table, where = '', params = []) {
  const sql = where
    ? `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) AS count FROM ${table}`;
  return db.prepare(sql).get(...params).count;
}

test('note create succeeds with the row committed and insideTx invoked in the same transaction', () => {
  let insideTxCalls = 0;
  let sawOpenTx = false;
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    const original = ctx.notes.mobileChangeBridge.runMutation.bind(ctx.notes.mobileChangeBridge);
    ctx.notes.mobileChangeBridge.runMutation = (meta, write) => original({
      ...meta,
      insideTx: (args) => {
        insideTxCalls += 1;
        sawOpenTx = inSqliteTx(ctx.db);
        if (typeof meta.insideTx === 'function') meta.insideTx(args);
      },
    }, write);

    const created = ctx.notes.create(user, { id: 'note-ok', title: 'Atomic', content: 'body' });
    assert.equal(created.noteId, 'note-ok');
    assert.equal(countTable(ctx.db, 'notes'), 1);
    assert.equal(countTable(ctx.db, 'mobile_sync_changes', 'entity_id = ?', ['note-ok']), 1);
    assert.equal(insideTxCalls, 1);
    assert.equal(sawOpenTx, true, 'insideTx must run before the change-bridge transaction commits');
  } finally {
    ctx.cleanup();
  }
});

test('insideTx throw rolls back the note row and the change feed together', () => {
  const ctx = freshNotes({
    onOwnedMutation() {
      throw new Error('outbox_fail');
    },
  });
  try {
    const user = { userId: 'account-1', role: 'user' };
    assert.throws(
      () => ctx.notes.create(user, { id: 'must-rollback', title: 'No partial commit' }),
      /outbox_fail/,
    );
    assert.equal(countTable(ctx.db, 'notes'), 0);
    assert.equal(countTable(ctx.db, 'mobile_sync_changes'), 0);
    assert.equal(countTable(ctx.db, 'mobile_change_outbox'), 0);
    assert.equal(countTable(ctx.db, 'notes', 'note_id = ?', ['must-rollback']), 0);
  } finally {
    ctx.cleanup();
  }
});

test('a later insideTx failure does not undo a previously committed note', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    ctx.notes.create(user, { id: 'kept', title: 'Kept' });
    ctx.notes.onOwnedMutation = () => {
      throw new Error('outbox_fail');
    };
    assert.throws(
      () => ctx.notes.create(user, { id: 'lost', title: 'Lost' }),
      /outbox_fail/,
    );
    assert.equal(countTable(ctx.db, 'notes', 'note_id = ?', ['kept']), 1);
    assert.equal(countTable(ctx.db, 'notes', 'note_id = ?', ['lost']), 0);
    assert.equal(countTable(ctx.db, 'mobile_sync_changes', 'entity_id = ?', ['kept']), 1);
    assert.equal(countTable(ctx.db, 'mobile_sync_changes', 'entity_id = ?', ['lost']), 0);
  } finally {
    ctx.cleanup();
  }
});

test('remoteMerge true update does not call Desktop enqueue', () => {
  let enqueue = 0;
  const sync = {
    binding: { deviceId: 'd' },
    recordLocalMutation() { enqueue += 1; },
  };
  function notifyOwnedLinkMutation(event) {
    if (!sync || typeof sync.recordLocalMutation !== 'function') return;
    if (!sync.binding) return;
    if (event && event.remoteMerge === true) return;
    sync.recordLocalMutation(event);
  }
  const ctx = freshNotes({ onOwnedMutation: notifyOwnedLinkMutation });
  try {
    const user = { userId: 'account-1', role: 'user' };
    const created = ctx.notes.create(user, { id: 'note-merge', title: 'Local', content: 'body' });
    assert.equal(enqueue, 1);
    ctx.notes.update(user, created.noteId, {
      title: 'From remote',
      expectedRevision: created.revision,
    }, { remoteMerge: true });
    assert.equal(enqueue, 1, 'pull-applied remoteMerge must not re-enqueue');
    assert.equal(ctx.db.prepare('SELECT title FROM notes WHERE note_id = ?').get(created.noteId).title, 'From remote');
  } finally {
    ctx.cleanup();
  }
});

test('notes restore goes through _runMobileMutation and rolls back with the outbox', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    const created = ctx.notes.create(user, { id: 'note-restore', title: 'Lifecycle', content: 'body' });
    ctx.notes.delete(user, created.noteId);
    const trashed = ctx.db.prepare('SELECT deleted_at, revision FROM notes WHERE note_id = ?').get(created.noteId);
    assert.ok(trashed.deleted_at);
    assert.equal(Number(trashed.revision), 2);

    ctx.notes.onOwnedMutation = () => {
      throw new Error('outbox_fail');
    };
    assert.throws(() => ctx.notes.restore(user, created.noteId), /outbox_fail/);
    const stillTrashed = ctx.db.prepare('SELECT deleted_at, revision FROM notes WHERE note_id = ?').get(created.noteId);
    assert.ok(stillTrashed.deleted_at, 'restore must not commit without the outbox');
    assert.equal(Number(stillTrashed.revision), 2);
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS c FROM mobile_sync_changes WHERE entity_id = ? AND action = 'upsert' AND revision = 3").get(created.noteId).c,
      0,
    );

    ctx.notes.onOwnedMutation = null;
    const restored = ctx.notes.restore(user, created.noteId);
    assert.equal(restored.revision, 3);
    assert.equal(restored.deletedAt, null);
  } finally {
    ctx.cleanup();
  }
});

test('MobileV1ChangeBridge.runMutation invokes insideTx before COMMIT and rolls back when it throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-bridge-insideTx-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  db.exec(`CREATE TABLE notes (
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
  );`);
  try {
    const bridge = new MobileV1ChangeBridge({ db });
    const user = { userId: 'account-1' };
    const insert = db.prepare(`INSERT INTO notes
      (note_id, owner_user_id, title, content, group_path, tags_json, linked_connection_ids_json,
       revision, created_at, updated_at, visibility, share_with_users, share_with_admins, allow_ai, allow_ai_read, allow_ai_write)
      VALUES (?, ?, ?, '', '', '[]', '[]', 1, 1, 1, 'private', 0, 0, 0, 0, 0)`);

    let observedTx = false;
    assert.throws(() => bridge.runMutation({
      entityType: 'note',
      entityId: 'n-tx',
      action: 'upsert',
      user,
      before: null,
      insideTx({ result, after }) {
        observedTx = inSqliteTx(db);
        assert.equal(result.noteId, 'n-tx');
        assert.equal(after.noteId, 'n-tx');
        throw new Error('outbox_fail');
      },
    }, () => {
      insert.run('n-tx', user.userId, 'Inside');
      return { noteId: 'n-tx', ownerUserId: user.userId, title: 'Inside', revision: 1 };
    }), /outbox_fail/);
    assert.equal(observedTx, true);
    assert.equal(countTable(db, 'notes'), 0);
    assert.equal(countTable(db, 'mobile_sync_changes'), 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ResourceService connection create rolls back when Desktop enqueue throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-resource-atomic-'));
  const previousDataDir = process.env.ZEPHYR_DATA_DIR;
  const previousKeyFile = process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE;
  const previousBuiltinSqlite = process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
  process.env.ZEPHYR_DATA_DIR = dir;
  process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = path.join(dir, 'crypto', 'data-key.json');
  process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = '1';
  const storagePath = path.join(repoRoot, 'storage.js');
  delete require.cache[require.resolve(storagePath)];
  const storage = require(storagePath);
  try {
    storage.init({
      hashPassword(password, salt = 'atomic-test') {
        return `${salt}:${crypto.createHash('sha256').update(String(password)).digest('hex')}`;
      },
    });
    const authz = new Authz(storage.rawDb(), { getUserById: (id) => storage.getUserById(id) });
    const sync = {
      binding: { deviceId: 'd' },
      recordLocalMutation() { throw new Error('outbox_fail'); },
    };
    function notifyOwnedLinkMutation(event) {
      if (!sync || typeof sync.recordLocalMutation !== 'function') return;
      if (!sync.binding) return;
      if (event && event.remoteMerge === true) return;
      sync.recordLocalMutation(event);
    }
    const resources = new ResourceService(storage, authz, {
      onOwnedMutation: notifyOwnedLinkMutation,
    });
    const adminRow = storage.getUser('admin');
    const user = { userId: adminRow.userId, username: adminRow.username, role: 'admin', status: 'active' };
    const db = storage.rawDb();
    assert.throws(
      () => resources.createConnection(user, connectionDefaults('connection-rollback', {
        name: 'Must roll back', host: '127.0.0.1', protocol: 'SSH',
      })),
      /outbox_fail/,
    );
    assert.equal(storage.getConnectionById('connection-rollback'), null);
    assert.equal(countTable(db, 'connections', 'id = ?', ['connection-rollback']), 0);
    assert.equal(countTable(db, 'mobile_sync_changes', 'entity_id = ?', ['connection-rollback']), 0);
  } finally {
    try { storage.close(); } catch {}
    if (previousDataDir === undefined) delete process.env.ZEPHYR_DATA_DIR;
    else process.env.ZEPHYR_DATA_DIR = previousDataDir;
    if (previousKeyFile === undefined) delete process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE;
    else process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = previousKeyFile;
    if (previousBuiltinSqlite === undefined) delete process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
    else process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = previousBuiltinSqlite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ephemeral connection create skips Desktop enqueue and still commits the row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-resource-eph-'));
  const previousDataDir = process.env.ZEPHYR_DATA_DIR;
  const previousKeyFile = process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE;
  const previousBuiltinSqlite = process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
  process.env.ZEPHYR_DATA_DIR = dir;
  process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = path.join(dir, 'crypto', 'data-key.json');
  process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = '1';
  const storagePath = path.join(repoRoot, 'storage.js');
  delete require.cache[require.resolve(storagePath)];
  const storage = require(storagePath);
  try {
    storage.init({
      hashPassword(password, salt = 'atomic-eph') {
        return `${salt}:${crypto.createHash('sha256').update(String(password)).digest('hex')}`;
      },
    });
    const authz = new Authz(storage.rawDb(), { getUserById: (id) => storage.getUserById(id) });
    let enqueue = 0;
    const resources = new ResourceService(storage, authz, {
      onOwnedMutation() { enqueue += 1; },
    });
    const adminRow = storage.getUser('admin');
    const user = { userId: adminRow.userId, username: adminRow.username, role: 'admin', status: 'active' };
    const created = resources.createConnection(user, {
      ...connectionDefaults('connection-eph', {
        name: 'One shot', host: '127.0.0.1', protocol: 'SSH',
      }),
      ephemeral: true,
    });
    assert.equal(created.ephemeral, true);
    assert.equal(enqueue, 0);
    assert.ok(storage.getConnectionById('connection-eph'));
    const db = storage.rawDb();
    assert.equal(countTable(db, 'mobile_sync_changes', 'entity_id = ?', ['connection-eph']), 0);
  } finally {
    try { storage.close(); } catch {}
    if (previousDataDir === undefined) delete process.env.ZEPHYR_DATA_DIR;
    else process.env.ZEPHYR_DATA_DIR = previousDataDir;
    if (previousKeyFile === undefined) delete process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE;
    else process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = previousKeyFile;
    if (previousBuiltinSqlite === undefined) delete process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
    else process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = previousBuiltinSqlite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
