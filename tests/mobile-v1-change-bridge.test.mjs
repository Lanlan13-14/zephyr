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
const { resolveEntityRegistry } = require(path.join(repoRoot, 'mobile-v1-change-bridge.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function freshNotes({ allowSharedWrite = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-change-bridge-'));
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
    can() { return allowSharedWrite; },
    audit() {},
    listSubjectGrants() { return []; },
  };
  const notes = new NotesService(db, authz, () => 1_700_000_000_000);
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

test('the flat staged core resolves mobile-contracts without the repository tree', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-change-bridge-stage-'));
  try {
    for (const filename of ['mobile-v1-change-bridge.js', 'mobile-v1-store.js', 'mobile-v1-entities.js']) {
      fs.copyFileSync(path.join(repoRoot, filename), path.join(stage, filename));
    }
    const stagedRegistryPath = path.join(stage, 'mobile-contracts', 'registries', 'entity-registry.json');
    fs.mkdirSync(path.dirname(stagedRegistryPath), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
      stagedRegistryPath,
    );

    const stagedRequire = createRequire(path.join(stage, 'probe.cjs'));
    const stagedBridge = stagedRequire(path.join(stage, 'mobile-v1-change-bridge.js'));
    const resolved = stagedBridge.resolveEntityRegistry();
    assert.equal(resolved.version, registry.version);
    assert.deepEqual(resolved.entities.map((entity) => entity.type), registry.entities.map((entity) => entity.type));

    fs.writeFileSync(stagedRegistryPath, '{broken json', 'utf8');
    assert.throws(
      () => stagedBridge.resolveEntityRegistry(),
      (error) => error.message.includes('Invalid JSON') && error.message.includes(stagedRegistryPath),
      'a malformed staged registry must identify the selected file',
    );
    fs.rmSync(stagedRegistryPath, { force: true });
    assert.throws(
      () => stagedBridge.resolveEntityRegistry(),
      (error) => error.message.includes('not found')
        && error.message.includes(path.join(stage, 'mobile-contracts'))
        && error.message.includes(path.join(stage, 'zephyr_one', 'mobile', 'contracts')),
      'a missing registry must report every deterministic candidate',
    );
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('an injected registry takes precedence over filesystem resolution', () => {
  const injected = { version: 99, entities: [] };
  assert.equal(resolveEntityRegistry({
    registry: injected,
    registryPath: path.join(repoRoot, 'does-not-exist.json'),
  }), injected);
  assert.throws(
    () => resolveEntityRegistry({ registryPath: path.join(repoRoot, 'does-not-exist.json') }),
    /Unable to read mobile entity registry.*does-not-exist\.json/,
  );
});

test('canonical service calls used by Web and AI emit whitelisted account-isolated changes', () => {
  const ctx = freshNotes();
  try {
    const u1 = { userId: 'account-1', role: 'user' };
    const u2 = { userId: 'account-2', role: 'user' };
    const first = ctx.notes.create(u1, { id: 'note-web', title: 'Web', content: 'first', allowAi: true });
    ctx.notes.create(u2, { id: 'note-other', title: 'Other', content: 'private' });
    ctx.notes.update(u1, first.noteId, {
      title: 'AI edit', content: 'second', expectedRevision: first.revision,
    });

    const page = ctx.store.changePage(u1.userId, 0, 50);
    assert.deepEqual(page.changes.map((change) => change.entityId), ['note-web', 'note-web']);
    assert.equal(ctx.store.changePage(u2.userId, 0, 50).changes.length, 1);
    const editable = new Set(registry.entities.find((entity) => entity.type === 'note').editableFields);
    for (const change of page.changes) {
      assert.equal(change.actorDeviceId, null, 'Web and AI writes have no device actor');
      assert.ok(change.fieldMask.length > 0);
      for (const field of change.fieldMask) assert.ok(editable.has(field), `${field} must be registry-editable`);
      assert.ok(!change.fieldMask.includes('allowAi'), 'opaque compatibility fields stay out of fieldMask');
      assert.ok(!change.fieldMask.includes('ownerUserId'));
      assert.ok(!change.fieldMask.includes('revision'));
      assert.ok(!change.fieldMask.includes('deletedAt'));
    }
  } finally {
    ctx.cleanup();
  }
});

test('an explicit mobile mutation actor is recorded without entering the canonical entity', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    const mutationReceipt = {};
    const note = ctx.notes.create(
      user,
      { id: 'note-device', title: 'Device edit', content: 'body' },
      { actorDeviceId: 'device-bound-1', mutationReceipt },
    );
    assert.equal(Object.prototype.hasOwnProperty.call(note, 'actorDeviceId'), false);

    const changes = ctx.store.changePage(user.userId, 0, 20).changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].actorDeviceId, 'device-bound-1');
    assert.equal(mutationReceipt.changeSeq, changes[0].changeSeq);
    assert.equal(ctx.store.latestCursor(user.userId), changes[0].changeSeq);
    assert.equal(ctx.store.wakeOutboxPage().length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('a device actor editing a shared row advances only the immutable owner account feed', () => {
  const ctx = freshNotes({ allowSharedWrite: true });
  try {
    const owner = { userId: 'owner-account', role: 'user' };
    const editor = { userId: 'editor-account', role: 'user' };
    const note = ctx.notes.create(owner, { id: 'shared-note', title: 'Owner title', content: 'body' });
    ctx.notes.update(
      editor,
      note.noteId,
      { title: 'Shared edit', expectedRevision: note.revision },
      { actorDeviceId: 'shared-editor-device' },
    );

    const ownerChanges = ctx.store.changePage(owner.userId, 0, 20).changes;
    assert.equal(ownerChanges.length, 2);
    assert.equal(ownerChanges[1].actorDeviceId, 'shared-editor-device');
    assert.equal(ctx.store.changePage(editor.userId, 0, 20).changes.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test('a repeated no-op service mutation does not allocate a new cursor', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    const note = ctx.notes.create(user, { id: 'note-noop', title: 'Same', content: 'body' });
    const cursor = ctx.store.latestCursor(user.userId);
    const repeated = ctx.notes.update(user, note.noteId, {
      title: note.title,
      content: note.content,
      expectedRevision: note.revision,
    });
    assert.equal(repeated.revision, 2, 'canonical optimistic revision still advances');
    assert.equal(ctx.store.latestCursor(user.userId), cursor, 'no editable value changed');
    assert.equal(ctx.store.getEntityVersion(user.userId, 'note', note.noteId).revision, 2);
  } finally {
    ctx.cleanup();
  }
});

test('delete and restore produce a tombstone followed by a higher-revision upsert', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    const note = ctx.notes.create(user, { id: 'note-lifecycle', title: 'Lifecycle', content: 'body' });
    ctx.notes.delete(user, note.noteId);
    const deletedRow = ctx.db.prepare('SELECT revision, deleted_at FROM notes WHERE note_id = ?').get(note.noteId);
    assert.equal(Number(deletedRow.revision), 2);
    assert.ok(deletedRow.deleted_at);
    const restored = ctx.notes.restore(user, note.noteId);
    assert.equal(restored.revision, 3);

    const changes = ctx.store.changePage(user.userId, 0, 20).changes;
    assert.deepEqual(changes.map((change) => [change.action, change.revision]), [
      ['upsert', 1], ['delete', 2], ['upsert', 3],
    ]);
    assert.deepEqual(changes[1].tombstone, {
      entityType: 'note',
      entityId: note.noteId,
      ownerUserId: user.userId,
      deletedRevision: 2,
      deletedAt: changes[1].tombstone.deletedAt,
      deletedBy: 'canonical',
      lastKnownName: 'Lifecycle',
    });
    assert.ok(changes[2].fieldMask.includes('title'), 'restore reprojects the removed row');
  } finally {
    ctx.cleanup();
  }
});

test('a feed failure rolls the canonical write and wake event back together', () => {
  const ctx = freshNotes();
  try {
    ctx.db.exec(`CREATE TRIGGER reject_mobile_change BEFORE INSERT ON mobile_sync_changes
      BEGIN SELECT RAISE(ABORT, 'feed unavailable'); END;`);
    const user = { userId: 'account-1', role: 'user' };
    assert.throws(
      () => ctx.notes.create(user, { id: 'must-rollback', title: 'No partial commit' }),
      /feed unavailable/,
    );
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, 0);
  } finally {
    ctx.cleanup();
  }
});

test('mobile push append merges into the canonical revision instead of allocating another cursor', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    const note = ctx.notes.create(user, { id: 'note-mobile', title: 'From mobile', content: 'body' });
    const canonicalSeq = ctx.store.latestCursor(user.userId);
    const pushSeq = ctx.store.appendChange({
      ownerUserId: user.userId,
      entityType: 'note',
      entityId: note.noteId,
      action: 'upsert',
      revision: note.revision,
      fieldMask: ['title'],
      actorDeviceId: 'device-1',
    });
    assert.equal(pushSeq, canonicalSeq);
    const rows = ctx.db.prepare('SELECT * FROM mobile_sync_changes WHERE owner_user_id = ?').all(user.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_device_id, 'device-1');
    assert.deepEqual(JSON.parse(rows[0].field_mask_json), ['title']);
    assert.equal(ctx.store.wakeOutboxPage().length, 1, 'dedupe also keeps one wake event');
  } finally {
    ctx.cleanup();
  }
});

test('the future wake outbox exposes routing and cursor only', () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'account-1', role: 'user' };
    ctx.notes.create(user, { id: 'note-outbox', title: 'Sensitive title', content: 'secret body' });
    const events = ctx.notes.mobileChangeBridge.pendingWakeEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), ['createdAt', 'outboxId', 'ownerUserId', 'throughCursor']);
    assert.ok(!JSON.stringify(events).includes('note-outbox'));
    assert.ok(!JSON.stringify(events).includes('Sensitive title'));
    assert.ok(!JSON.stringify(events).includes('secret body'));
    assert.equal(ctx.notes.mobileChangeBridge.acknowledgeWakeEvents([events[0].outboxId]), 1);
    assert.deepEqual(ctx.notes.mobileChangeBridge.pendingWakeEvents(), []);
  } finally {
    ctx.cleanup();
  }
});

test('resource service mutations used by Web and AI enter the same feed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-resource-bridge-'));
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
      hashPassword(password, salt = 'bridge-test') {
        return `${salt}:${crypto.createHash('sha256').update(String(password)).digest('hex')}`;
      },
    });
    const authz = new Authz(storage.rawDb(), { getUserById: (id) => storage.getUserById(id) });
    const resources = new ResourceService(storage, authz);
    const adminRow = storage.getUser('admin');
    const user = { userId: adminRow.userId, username: adminRow.username, role: 'admin', status: 'active' };

    const connection = resources.createConnection(user, connectionDefaults('connection-web', {
      name: 'Web host', host: '127.0.0.1', protocol: 'SSH', password: 'never-in-feed',
      privateKey: 'connection-private-key-canary',
    }), { changedSecretFields: ['password', 'privateKey'] });
    resources.updateConnection(user, connection.id, (row) => ({
      ...row, password: 'replacement-password-canary',
    }), { changedSecretFields: ['password'] });
    assert.throws(
      () => resources.updateConnection(user, connection.id, (row) => ({
        ...row, password: 'must-rollback-invalid-secret-mask',
      }), { changedSecretFields: ['ownerUserId'] }),
      (error) => error.code === 'invalid_request',
    );
    assert.equal(storage.getConnectionById(connection.id).password, 'replacement-password-canary');
    assert.equal(storage.getConnectionById(connection.id).revision, 2);
    const proxy = resources.createOwned(user, 'proxy', {
      id: 'proxy-ai', name: 'AI proxy', host: '127.0.0.1', port: 1080,
      type: 'socks5', username: '', password: 'never-in-feed',
      createdAt: Date.now(), updatedAt: Date.now(),
    }, { changedSecretFields: ['password'] });
    resources.updateOwned(user, 'proxy', proxy.id, {
      password: 'replacement-proxy-password-canary', updatedAt: Date.now(),
    }, { changedSecretFields: ['password'] });
    resources.updateOwned(user, 'proxy', proxy.id, { name: 'AI proxy updated', updatedAt: Date.now() });
    resources.deleteOwned(user, 'proxy', proxy.id);
    const sshKey = resources.createOwned(user, 'sshKey', {
      id: 'ssh-key-web', name: 'Web SSH key', privateKey: 'ssh-private-key-canary',
      passphrase: 'ssh-passphrase-canary', remark: '', createdAt: Date.now(), updatedAt: Date.now(),
    }, { changedSecretFields: ['privateKey', 'passphrase'] });
    resources.updateOwned(user, 'sshKey', sshKey.id, {
      passphrase: '', updatedAt: Date.now(),
    }, { changedSecretFields: ['passphrase'] });
    const jumpHost = resources.createOwned(user, 'jumpHost', {
      id: 'jump-host-web', name: 'Web jump host', connectionId: connection.id,
      createdAt: Date.now(), updatedAt: Date.now(),
    });

    const store = resources.mobileChangeBridge.store;
    const changes = store.changePage(user.userId, 0, 20).changes;
    assert.equal(changes.find((change) => change.entityType === 'connection' && change.revision === 2).fieldMask.length, 0);
    assert.equal(changes.find((change) => change.entityType === 'proxy' && change.revision === 2).fieldMask.length, 0);
    assert.equal(changes.find((change) => change.entityType === 'sshKey' && change.revision === 2).fieldMask.length, 0);
    assert.equal(changes.find((change) => change.entityId === jumpHost.id).revision, 1);
    assert.equal(store.fieldRevisions(user.userId, 'connection', connection.id).get('password'), 2);
    assert.equal(store.fieldRevisions(user.userId, 'connection', connection.id).get('privateKey'), 1);
    assert.equal(store.fieldRevisions(user.userId, 'proxy', proxy.id).get('password'), 2);
    assert.equal(store.fieldRevisions(user.userId, 'sshKey', sshKey.id).get('privateKey'), 1);
    assert.equal(store.fieldRevisions(user.userId, 'sshKey', sshKey.id).get('passphrase'), 2);
    for (const change of changes.filter((item) => item.action === 'upsert')) {
      assert.ok(!change.fieldMask.includes('password'));
      assert.ok(!change.fieldMask.includes('privateKey'));
      assert.ok(!change.fieldMask.includes('passphrase'));
      assert.ok(!change.fieldMask.includes('ownerUserId'));
    }
    const publicSurface = JSON.stringify({ changes, outbox: resources.mobileChangeBridge.pendingWakeEvents() });
    for (const forbidden of [
      'never-in-feed', 'connection-private-key-canary', 'replacement-password-canary',
      'replacement-proxy-password-canary', 'ssh-private-key-canary', 'ssh-passphrase-canary',
    ]) assert.equal(publicSurface.includes(forbidden), false);
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
