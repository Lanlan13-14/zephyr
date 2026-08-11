import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { MobileV1ChangeBridge } = require(path.join(root, 'mobile-v1-change-bridge.js'));
const { UserSettingsService } = require(path.join(root, 'user-settings-service.js'));
const { createPersonalEntityAdapters } = require(path.join(root, 'mobile-v1-personal-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-personal-sync-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`CREATE TABLE user_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);
  let timestamp = 1_800_000_000_000;
  const now = () => ++timestamp;
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const service = new UserSettingsService(db, { getSettings: () => ({}) }, now, {
    mobileChangeBridge: bridge,
  });
  return {
    db,
    bridge,
    service,
    adapters: createPersonalEntityAdapters({ userSettingsService: service }),
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('snippet rows have stable ids, optimistic revisions, isolated owners and durable tombstones', () => {
  const context = fresh();
  try {
    const alice = { userId: 'alice' };
    const bob = { userId: 'bob' };
    context.service.putUserOverrides(alice.userId, {
      snippets: [{ id: 'same-id', name: 'Alice uptime', command: 'uptime', revision: 1 }],
    });
    context.service.putUserOverrides(bob.userId, {
      snippets: [{ id: 'same-id', name: 'Bob uptime', command: 'uptime -p', revision: 1 }],
    });

    assert.equal(context.service.snippetService.read(alice, 'same-id').name, 'Alice uptime');
    assert.equal(context.service.snippetService.read(bob, 'same-id').name, 'Bob uptime');
    assert.deepEqual(
      context.bridge.store.changePage(alice.userId, 0, 20).changes.map((change) => change.entityId),
      ['same-id'],
    );
    assert.deepEqual(
      context.bridge.store.changePage(bob.userId, 0, 20).changes.map((change) => change.entityId),
      ['same-id'],
    );

    const originalCursor = context.bridge.store.latestCursor(alice.userId);
    assert.throws(
      () => context.service.snippetService.update(alice, 'same-id', { command: 'stale' }, { expectedRevision: 0 }),
      (error) => error.code === 'revision_conflict',
    );
    assert.equal(context.bridge.store.latestCursor(alice.userId), originalCursor);

    context.service.putUserOverrides(alice.userId, {
      snippets: [{ id: 'same-id', name: 'Alice uptime', command: 'uptime -p', revision: 2 }],
    });
    context.service.putUserOverrides(alice.userId, { snippets: [] });
    const history = context.bridge.store.changePage(alice.userId, 0, 20).changes;
    assert.deepEqual(history.map((change) => [change.action, change.revision]), [
      ['upsert', 1],
      ['upsert', 2],
      ['delete', 3],
    ]);
    assert.equal(history[2].tombstone.lastKnownName, 'Alice uptime');
    assert.ok(!JSON.stringify(history[2]).includes('uptime -p'));
    const deleted = context.service.snippetService.read(alice, 'same-id', { includeDeleted: true });
    assert.equal(deleted.revision, 3);
    assert.ok(deleted.deletedAt);
    assert.deepEqual(
      JSON.parse(context.db.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='snippets'").get('alice').value),
      [],
      'the non-canonical compatibility projection stays current for WebDAV backups',
    );
  } finally {
    context.cleanup();
  }
});

test('legacy snippet migration uses deterministic ids and never resurrects a deleted row', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-snippet-migrate-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  try {
    db.exec(`CREATE TABLE user_settings (
      user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    )`);
    db.prepare('INSERT INTO user_settings VALUES (?, ?, ?, ?)').run(
      'alice',
      'snippets',
      JSON.stringify([{ name: 'legacy', command: 'whoami' }]),
      123,
    );
    const bridge = new MobileV1ChangeBridge({ db, registry });
    const first = new UserSettingsService(db, { getSettings: () => ({}) }, () => 500, { mobileChangeBridge: bridge });
    const migrated = first.snippetService.list('alice');
    assert.equal(migrated.length, 1);
    assert.match(migrated[0].id, /^legacy-[a-f0-9]{32}$/);
    first.snippetService.remove('alice', migrated[0].id, { expectedRevision: 1 });

    const second = new UserSettingsService(db, { getSettings: () => ({}) }, () => 600, { mobileChangeBridge: bridge });
    assert.deepEqual(second.snippetService.list('alice'), []);
    assert.equal(second.snippetService.read('alice', migrated[0].id, { includeDeleted: true }).revision, 2);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('personal adapters carry the bound device actor outside entity payloads', () => {
  const context = fresh();
  try {
    const user = { userId: 'alice' };
    const mutationContext = { actorDeviceId: 'device-personal-adapter' };
    const snippet = context.adapters.get('snippet').create(
      user,
      'device-snippet',
      { name: 'Device snippet', command: 'pwd' },
      mutationContext,
    );
    const settings = context.adapters.get('oneUserSettings').create(
      user,
      'notes',
      { 'notes.enabled': true },
      mutationContext,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(snippet, 'actorDeviceId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(settings, 'actorDeviceId'), false);
    assert.deepEqual(
      context.bridge.store.changePage(user.userId, 0, 20).changes.map((change) => change.actorDeviceId),
      [mutationContext.actorDeviceId, mutationContext.actorDeviceId],
    );
  } finally {
    context.cleanup();
  }
});

test('personal settings use section revisions and exact dotted field masks', () => {
  const context = fresh();
  try {
    context.service.putUserOverrides('alice', {
      appearance: {
        theme: 'dark',
        customColors: { primary: '#13a36f', bgMain: '#111111' },
        customCss: '.private-style { display: none; }',
      },
      terminal: { maxWindows: 6 },
    });
    const appearance = context.service.personalSettingsService.read('alice', 'appearance');
    const terminal = context.service.personalSettingsService.read('alice', 'terminal');
    assert.equal(appearance.revision, 1);
    assert.equal(appearance['appearance.theme'], 'dark');
    assert.deepEqual(appearance['appearance.customColors'], { bgMain: '#111111', primary: '#13a36f' });
    assert.equal(appearance['appearance.customCss'], '.private-style { display: none; }');
    assert.equal(terminal.revision, 1);

    const changes = context.bridge.store.changePage('alice', 0, 20).changes;
    assert.deepEqual(changes.map((change) => change.entityId), ['appearance', 'terminal']);
    assert.deepEqual(changes[0].fieldMask.sort(), [
      'appearance.customColors',
      'appearance.customCss',
      'appearance.theme',
    ]);
    assert.deepEqual(changes[1].fieldMask, ['terminal.maxWindows']);

    context.service.putUserOverrides('alice', { terminal: { allowLigatures: true } });
    assert.equal(context.service.personalSettingsService.read('alice', 'terminal').revision, 2);
    assert.deepEqual(
      context.bridge.store.changePage('alice', changes[1].changeSeq, 20).changes[0].fieldMask,
      ['terminal.allowLigatures'],
    );
  } finally {
    context.cleanup();
  }
});

test('mobile adapters cannot write or indirectly reset opaque settings', () => {
  const context = fresh();
  try {
    context.service.putUserOverrides('alice', {
      appearance: { theme: 'dark', customCss: 'body { color: red; }' },
      mail: { notifyLogin: true },
      terminal: { maxWindows: 4 },
    });
    const adapter = context.adapters.get('oneUserSettings');
    assert.ok(adapter);
    assert.throws(
      () => adapter.update({ userId: 'alice' }, 'appearance', { 'appearance.customCss': 'body{}' }),
      (error) => error.code === 'settings_key_forbidden',
    );
    assert.throws(
      () => adapter.remove({ userId: 'alice' }, 'appearance'),
      (error) => error.code === 'settings_key_forbidden',
    );
    assert.throws(
      () => adapter.remove({ userId: 'alice' }, 'mail'),
      (error) => error.code === 'settings_key_forbidden',
    );
    const mailChange = context.bridge.store.changePage('alice', 0, 20).changes
      .find((change) => change.entityId === 'mail');
    assert.deepEqual(mailChange.fieldMask, ['mail.notifyLogin']);

    const mutationContext = { actorDeviceId: 'device-personal-1' };
    adapter.remove({ userId: 'alice' }, 'terminal', mutationContext);
    assert.equal(adapter.read({ userId: 'alice' }, 'terminal'), null);
    const restored = adapter.restore({ userId: 'alice' }, 'terminal', mutationContext);
    assert.equal(restored.revision, 3);
    const recreated = adapter.create(
      { userId: 'alice' },
      'terminal',
      { 'terminal.maxWindows': 8 },
      mutationContext,
    );
    assert.equal(recreated.revision, 4);
    const terminalChanges = context.bridge.store.changePage('alice', 0, 20).changes
      .filter((change) => change.entityId === 'terminal');
    assert.deepEqual(terminalChanges.map((change) => [change.action, change.revision]), [
      ['upsert', 1],
      ['delete', 2],
      ['upsert', 4],
    ]);
    assert.deepEqual(terminalChanges.map((change) => change.actorDeviceId), [
      null,
      mutationContext.actorDeviceId,
      mutationContext.actorDeviceId,
    ]);
    assert.ok(!JSON.stringify(context.bridge.pendingWakeEvents()).includes('body { color: red; }'));
  } finally {
    context.cleanup();
  }
});

test('object-valued settings cannot smuggle undeclared secret-shaped keys into sync', () => {
  const context = fresh();
  try {
    assert.throws(
      () => context.service.putUserOverrides('alice', {
        appearance: { customColors: { primary: '#123456', apiToken: 'must-not-sync' } },
      }),
      (error) => error.code === 'invalid_settings',
    );
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM user_settings').get().count, 0);
    assert.equal(context.bridge.store.latestCursor('alice'), 0);
  } finally {
    context.cleanup();
  }
});

test('stale section replay is rejected without moving the cursor', () => {
  const context = fresh();
  try {
    const sections = context.service.personalSettingsService;
    sections.patchSection('alice', 'notes', { 'notes.enabled': true }, { expectedRevision: 0, source: 'mobile' });
    sections.patchSection('alice', 'notes', { 'notes.fontSize': 16 }, { expectedRevision: 1, source: 'mobile' });
    const cursor = context.bridge.store.latestCursor('alice');
    assert.throws(
      () => sections.patchSection('alice', 'notes', { 'notes.enabled': false }, { expectedRevision: 1, source: 'mobile' }),
      (error) => error.code === 'revision_conflict',
    );
    assert.equal(context.bridge.store.latestCursor('alice'), cursor);
    assert.equal(sections.read('alice', 'notes')['notes.enabled'], true);
  } finally {
    context.cleanup();
  }
});

test('feed failure atomically rolls back settings rows, revisions and wake events', () => {
  const context = fresh();
  try {
    context.db.exec(`CREATE TRIGGER reject_personal_change BEFORE INSERT ON mobile_sync_changes
      BEGIN SELECT RAISE(ABORT, 'feed unavailable'); END;`);
    assert.throws(
      () => context.service.putUserOverrides('alice', {
        notes: { enabled: true },
        workspace: { defaultView: 'connections' },
      }),
      /feed unavailable/,
    );
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM user_settings').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM user_setting_sections').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM mobile_sync_changes').get().count, 0);
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM mobile_change_outbox').get().count, 0);
  } finally {
    context.cleanup();
  }
});

test('personal adapter projections preserve contract owner fields without leaking helper aliases', () => {
  const context = fresh();
  try {
    context.service.putUserOverrides('alice', { notes: { enabled: true } });
    const adapter = context.adapters.get('oneUserSettings');
    const row = adapter.list({ userId: 'alice' })[0];
    assert.equal(row.userId, 'alice');
    assert.equal(row.ownerUserId, 'alice');
    assert.equal(Object.keys(row).includes('ownerUserId'), false);
    assert.equal(JSON.stringify(row).includes('ownerUserId'), false);
    assert.ok(context.adapters.has('snippet'));
  } finally {
    context.cleanup();
  }
});
