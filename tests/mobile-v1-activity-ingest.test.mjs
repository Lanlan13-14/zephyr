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
const {
  ACTIVITY_JOURNAL_CLEAR_ID,
  CanonicalActivityEventService,
  createServerMetadataServices,
  projectActivityEvent,
} = require(path.join(root, 'mobile-v1-server-metadata-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(root, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

function parseStoredValue(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function createActivityFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-activity-ingest-'));
  const db = createDatabase(path.join(directory, 'test.db'), { forceBuiltin: true });
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, time INTEGER NOT NULL, message TEXT NOT NULL, type TEXT,
      userId TEXT, sourceIp TEXT, durationMs INTEGER, category TEXT, outcome TEXT,
      actor TEXT, protocol TEXT, target TEXT, connectionId TEXT
    );
  `);
  const storage = {
    getSettings: () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, parseStoredValue(row.value)])),
    updateSettings: (patch) => {
      const current = storage.getSettings();
      for (const [key, value] of Object.entries(patch || {})) {
        const next = value && typeof value === 'object' && !Array.isArray(value)
          ? { ...(current[key] || {}), ...value }
          : value;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(next));
      }
      return storage.getSettings();
    },
    addActivity: (row) => {
      const existing = db.prepare('SELECT id FROM activities WHERE id=?').get(row.id);
      if (existing) return { inserted: false, id: existing.id };
      db.prepare(`INSERT INTO activities
        (id,time,message,type,userId,sourceIp,durationMs,category,outcome,actor,protocol,target,connectionId)
        VALUES (@id,@time,@message,@type,@userId,@sourceIp,@durationMs,@category,@outcome,@actor,@protocol,@target,@connectionId)`).run({
        type: 'info', userId: null, sourceIp: null, durationMs: null, category: null, outcome: null,
        actor: null, protocol: null, target: null, connectionId: null, ...row,
      });
      return { inserted: true, id: row.id };
    },
    clearActivities: () => {
      const owners = db.prepare('SELECT DISTINCT userId FROM activities WHERE userId IS NOT NULL').all()
        .map((row) => row && row.userId)
        .filter((id) => id != null && String(id).trim() !== '')
        .map((id) => String(id));
      db.prepare('DELETE FROM activities').run();
      return { owners };
    },
  };
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const services = createServerMetadataServices({ db, storage, changeBridge: bridge, now: () => 1_000 });
  return { directory, db, storage, bridge, services };
}

function closeFixture(fixture) {
  try { fixture.db.close(); } catch {}
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test('duplicate activity eventId inserts one row and one change', () => {
  const fixture = createActivityFixture();
  try {
    const event = {
      id: 'dup-1', userId: 'alice', time: 1_100, message: '会话已开始',
      type: 'session_start', protocol: 'SSH', connectionId: 'conn-1',
      outcome: '成功', category: '会话', target: 'host.example:22',
    };
    const first = fixture.services.activityEvents.appendActivityEvent(event);
    const second = fixture.services.activityEvents.appendActivityEvent(event);
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    const rows = fixture.db.prepare('SELECT id FROM activities').all();
    assert.equal(rows.length, 1);
    const changes = fixture.bridge.store.changePage('alice', 0, 20).changes
      .filter((row) => row.entityType === 'activityEvent');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].entityId, 'dup-1');
    assert.equal(changes[0].action, 'upsert');
  } finally {
    closeFixture(fixture);
  }
});

test('two distinct activity ids produce two change rows', () => {
  const fixture = createActivityFixture();
  try {
    fixture.services.activityEvents.appendActivityEvent({
      id: 'a-1', userId: 'alice', time: 1_200, message: '会话已开始', type: 'session_start',
    });
    fixture.services.activityEvents.appendActivityEvent({
      id: 'a-2', userId: 'alice', time: 1_201, message: '会话已结束', type: 'session_end',
    });
    const rows = fixture.db.prepare('SELECT id FROM activities ORDER BY time').all();
    assert.deepEqual(rows.map((row) => row.id), ['a-1', 'a-2']);
    const changes = fixture.bridge.store.changePage('alice', 0, 20).changes
      .filter((row) => row.entityType === 'activityEvent');
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.map((row) => row.entityId).sort(), ['a-1', 'a-2']);
  } finally {
    closeFixture(fixture);
  }
});

test('append session_end records the session_end type used by destroySshTerminalSession', () => {
  const fixture = createActivityFixture();
  try {
    const row = fixture.services.activityEvents.appendActivityEvent({
      id: 'end-1', userId: 'alice', time: 1_300, message: '会话已结束',
      type: 'session_end', protocol: 'SSH', connectionId: 'conn-ssh',
      outcome: '成功', durationMs: 42, target: '10.0.0.1:22', category: '会话',
    });
    assert.equal(row.inserted, true);
    const stored = fixture.services.activityEvents.readActivityEventForUser('alice', 'end-1');
    assert.equal(stored.type, 'session_end');
    assert.equal(stored.protocol, 'SSH');
    const projected = projectActivityEvent(stored, { userId: 'alice' });
    assert.equal(projected.message, '会话已结束');
    assert.equal(projected.type, 'session_end');
  } finally {
    closeFixture(fixture);
  }
});

test('append sftp_upload records the type used by SFTP complete', () => {
  const fixture = createActivityFixture();
  try {
    const row = fixture.services.activityEvents.appendActivityEvent({
      id: 'up-1', userId: 'alice', time: 1_400, message: 'SFTP 上传完成',
      type: 'sftp_upload', protocol: 'SFTP', outcome: '成功',
      target: '/home/alice/out.bin', category: 'SFTP',
    });
    assert.equal(row.inserted, true);
    const stored = fixture.services.activityEvents.readActivityEventForUser('alice', 'up-1');
    assert.equal(stored.type, 'sftp_upload');
    const projected = projectActivityEvent(stored, { userId: 'alice' });
    assert.equal(projected.message, 'SFTP 上传');
    assert.equal(projected.target, '/home/alice/out.bin');
  } finally {
    closeFixture(fixture);
  }
});

test('projection strips canary secrets and commands from activity message', () => {
  const projected = projectActivityEvent({
    id: 'canary-1',
    userId: 'alice',
    time: 1,
    type: 'info',
    message: 'password=hunter2 rm -rf / PROMPT: ...',
  }, { userId: 'alice' });
  const serialized = JSON.stringify(projected);
  assert.equal(projected.message, '活动已记录');
  assert.ok(!serialized.includes('hunter2'));
  assert.ok(!serialized.includes('rm -rf'));
  assert.ok(!serialized.includes('PROMPT'));
});

test('clearAll empties the journal and writes one delete tombstone per owner', () => {
  const fixture = createActivityFixture();
  try {
    fixture.services.activityEvents.appendActivityEvent({
      id: 'alice-1', userId: 'alice', time: 1_500, message: '会话已开始', type: 'session_start',
    });
    fixture.services.activityEvents.appendActivityEvent({
      id: 'bob-1', userId: 'bob', time: 1_501, message: '会话已开始', type: 'session_start',
    });
    const cleared = fixture.services.activityEvents.clearAll();
    assert.deepEqual(cleared.owners.sort(), ['alice', 'bob']);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n, 0);
    assert.equal(fixture.services.activityEvents.listActivityEventsForUser('alice').length, 0);
    const aliceDeletes = fixture.bridge.store.changePage('alice', 0, 20).changes
      .filter((row) => row.entityType === 'activityEvent' && row.action === 'delete');
    assert.equal(aliceDeletes.length, 1);
    assert.equal(aliceDeletes[0].entityId, ACTIVITY_JOURNAL_CLEAR_ID);
    const bobDeletes = fixture.bridge.store.changePage('bob', 0, 20).changes
      .filter((row) => row.entityType === 'activityEvent' && row.action === 'delete');
    assert.equal(bobDeletes.length, 1);
    assert.equal(bobDeletes[0].entityId, ACTIVITY_JOURNAL_CLEAR_ID);
  } finally {
    closeFixture(fixture);
  }
});

test('wrapped storage.clearActivities records the journal-clear tombstone', () => {
  const fixture = createActivityFixture();
  try {
    fixture.services.activityEvents.appendActivityEvent({
      id: 'wrap-1', userId: 'alice', time: 1_600, message: '会话已开始', type: 'session_start',
    });
    fixture.storage.clearActivities();
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n, 0);
    const deletes = fixture.bridge.store.changePage('alice', 0, 20).changes
      .filter((row) => row.action === 'delete' && row.entityId === ACTIVITY_JOURNAL_CLEAR_ID);
    assert.equal(deletes.length, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('server.js statically records session_end, session_start and sftp ingest types', () => {
  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(serverJs, /type:\s*'session_end'/);
  assert.match(serverJs, /type:\s*'session_start'/);
  assert.match(serverJs, /type:\s*'sftp_upload'/);
  assert.match(serverJs, /type:\s*'sftp_download'/);
  assert.match(serverJs, /type:\s*'sftp_delete'/);
  assert.match(serverJs, /type:\s*'sftp_rename'/);
  const destroy = serverJs.slice(
    serverJs.indexOf('function destroySshTerminalSession'),
    serverJs.indexOf('function loadDataEnv'),
  );
  assert.match(destroy, /if\s*\(\s*!session\s*\|\|\s*session\.closed\s*\)\s*return/);
  assert.equal([...destroy.matchAll(/type:\s*'session_end'/g)].length, 1);
  const sshSets = [...serverJs.matchAll(/sshTerminalSessions\.set\(session\.id,\s*session\)/g)];
  assert.equal(sshSets.length, 2, 'SSH and Telnet both register into sshTerminalSessions');
  for (const match of sshSets) {
    const window = serverJs.slice(match.index, match.index + 400);
    assert.match(window, /type:\s*'session_start'/);
  }
});

test('Telnet is covered via shared destroy/create; RDP/VNC have no peer session destroy', () => {
  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const telnetSet = serverJs.indexOf("protocol: 'TELNET'");
  assert.ok(telnetSet > 0);
  const telnetWindow = serverJs.slice(telnetSet, telnetSet + 2500);
  assert.match(telnetWindow, /sshTerminalSessions\.set\(session\.id,\s*session\)/);
  assert.match(telnetWindow, /type:\s*'session_start'/);
  assert.match(serverJs, /destroySshTerminalSession\(session,\s*'telnet-close'\)/);
  assert.doesNotMatch(serverJs, /function destroyRdpTerminalSession/);
  assert.doesNotMatch(serverJs, /function destroyVncTerminalSession/);
  /* RDP/VNC live on dedicated websocket proxies without a peer
   * destroySshTerminalSession, so activity ingest covers SSH+Telnet+SFTP. */
});

test('storage.addActivity is idempotent and still usable when the return value is ignored', () => {
  const fixture = createActivityFixture();
  try {
    const first = fixture.storage.addActivity({
      id: 'raw-1', time: 1, message: 'x', type: 'info', userId: 'alice',
      sourceIp: null, durationMs: null, category: null, outcome: null,
      actor: null, protocol: null, target: null, connectionId: null,
    });
    const second = fixture.storage.addActivity({
      id: 'raw-1', time: 2, message: 'y', type: 'info', userId: 'alice',
      sourceIp: null, durationMs: null, category: null, outcome: null,
      actor: null, protocol: null, target: null, connectionId: null,
    });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n, 1);
  } finally {
    closeFixture(fixture);
  }
});
