import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1ChangeBridge } = require(path.join(repoRoot, 'mobile-v1-change-bridge.js'));
const { NotesService } = require(path.join(repoRoot, 'notes-service.js'));
const { publishAcceptedPushWake } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const {
  AppChangeWakeHub,
  registerAppChangeWakeRoute,
  APP_CHANGE_WAKE_ROUTE,
} = require(path.join(repoRoot, 'app-change-wake-hub.js'));
const { AppChangeWakeRuntime } = require(path.join(repoRoot, 'app-change-wake-runtime.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const allowedTypes = registry.entities.map((entity) => entity.type);

class FakeRequest extends EventEmitter {
  constructor({ headers = {}, query = {} } = {}) {
    super();
    this.headers = headers;
    this.query = query;
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.chunks = [];
    this.statusCode = 200;
    this.destroyed = false;
    this.writableEnded = false;
    this.acceptWrites = true;
    this.jsonBody = null;
  }

  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); }
  flushHeaders() {}
  status(value) { this.statusCode = Number(value); return this; }
  json(value) { this.jsonBody = value; this.writableEnded = true; return this; }
  write(value) { this.chunks.push(String(value)); return this.acceptWrites; }
  end() { this.writableEnded = true; }
}

function parsedEvents(response) {
  return response.chunks.join('').split('\n\n').map((frame) => {
    const event = frame.match(/^event: ([^\n]+)$/m)?.[1];
    const id = frame.match(/^id: ([^\n]+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    if (!event || !data) return null;
    return { event, id, data: JSON.parse(data), frame };
  }).filter(Boolean);
}

function subscribe(hub, ownerUserId, options = {}) {
  const req = new FakeRequest(options);
  const res = new FakeResponse();
  const user = {
    userId: ownerUserId,
    sessionIdentity: options.sessionIdentity || `${ownerUserId}-session`,
  };
  if (typeof options.sessionIsLive === 'function') user.sessionIsLive = options.sessionIsLive;
  assert.equal(hub.subscribe(req, res, user), true);
  return { req, res };
}

async function waitForFlush(ms = 25) {
  // Commit verification is a microtask because canonical writes may be nested
  // in a wider synchronous transaction. Start the timer only after it ran.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createFixture({ coalesceMs = 5, backpressureTimeoutMs = 1_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-app-change-wake-'));
  const db = createDatabase(path.join(dir, 'wake.db'), { forceBuiltin: true });
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
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const authz = {
    can() { return false; },
    audit() {},
    listSubjectGrants() { return []; },
  };
  const notes = new NotesService(db, authz, () => Date.now(), { mobileChangeBridge: bridge });
  const hub = new AppChangeWakeHub({
    allowedEntityTypes: allowedTypes,
    heartbeatMs: 60_000,
    coalesceMs,
    backpressureTimeoutMs,
  });
  const runtime = new AppChangeWakeRuntime({ hub });
  runtime.bind(db, { bridge });
  return {
    dir, db, bridge, notes, hub, runtime,
    close() {
      runtime.close();
      try { db.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('web writes wake every same-owner tab without leaking to another owner or exposing row data', async () => {
  const fixture = createFixture();
  try {
    const tabA = subscribe(fixture.hub, 'alice');
    const tabB = subscribe(fixture.hub, 'alice');
    const bob = subscribe(fixture.hub, 'bob');
    tabA.res.chunks.length = 0;
    tabB.res.chunks.length = 0;
    bob.res.chunks.length = 0;

    fixture.notes.create(
      { userId: 'alice', role: 'user' },
      { id: 'secret-note-id', title: 'private title', content: 'SECRET_CONTENT_CANARY' },
    );
    await waitForFlush();

    for (const tab of [tabA, tabB]) {
      const events = parsedEvents(tab.res);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'change');
      assert.deepEqual(Object.keys(events[0].data).sort(), ['entityTypes', 'reason', 'sequence']);
      assert.equal(events[0].data.reason, 'change');
      assert.deepEqual(events[0].data.entityTypes, ['note']);
      assert.equal(Number(events[0].id), events[0].data.sequence);
      assert.doesNotMatch(events[0].frame, /secret-note-id|private title|SECRET_CONTENT_CANARY|entityId|payload|fieldMask/);
    }
    assert.equal(parsedEvents(bob.res).length, 0);
    fixture.notes.create(
      { userId: 'bob', role: 'user' },
      { id: 'bob-note', title: 'Bob only', content: 'BOB_SECRET' },
    );
    await waitForFlush();
    assert.equal(parsedEvents(tabA.res).length, 1, 'Bob writes never wake Alice');
    const [bobEvent] = parsedEvents(bob.res);
    assert.equal(bobEvent.data.sequence, 1, 'wake sequence is account-local, not a global activity counter');
    assert.deepEqual(bobEvent.data.entityTypes, ['note']);
  } finally {
    fixture.close();
  }
});

test('an accepted mobile push wakes the browser through its explicit post-commit seam', async () => {
  const fixture = createFixture();
  try {
    const browser = subscribe(fixture.hub, 'alice');
    browser.res.chunks.length = 0;
    const changeSeq = fixture.db.transaction(() => fixture.bridge.store.appendChange({
      ownerUserId: 'alice',
      entityType: 'note',
      entityId: 'from-mobile',
      action: 'upsert',
      revision: 1,
      fieldMask: ['title'],
      actorDeviceId: 'bound-device-1',
      tombstone: null,
    }))();
    assert.equal(publishAcceptedPushWake(fixture.bridge, 'alice', {
      status: 'accepted',
      changeSeq,
    }), true);
    await waitForFlush();
    const [event] = parsedEvents(browser.res);
    assert.equal(event.data.sequence, 1);
    assert.deepEqual(event.data.entityTypes, ['note']);
    assert.doesNotMatch(event.frame, /bound-device-1|from-mobile|title/);
  } finally {
    fixture.close();
  }
});

test('an outer transaction rollback emits no browser wake even after a nested canonical mutation queued a candidate', async () => {
  const fixture = createFixture();
  try {
    const browser = subscribe(fixture.hub, 'alice');
    browser.res.chunks.length = 0;
    assert.throws(() => fixture.db.transaction(() => {
      fixture.notes.create(
        { userId: 'alice', role: 'user' },
        { id: 'rolled-back', title: 'Never committed', content: 'ROLLBACK_SECRET' },
      );
      throw new Error('force outer rollback');
    })(), /force outer rollback/);
    await waitForFlush();
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 0);
    assert.equal(parsedEvents(browser.res).length, 0);
    assert.doesNotMatch(browser.res.chunks.join(''), /rolled-back|Never committed|ROLLBACK_SECRET/);
  } finally {
    fixture.close();
  }
});

test('bursts coalesce by owner and cursor reconnect receives one bounded resync hint', async () => {
  const fixture = createFixture({ coalesceMs: 15 });
  try {
    const browser = subscribe(fixture.hub, 'alice');
    browser.res.chunks.length = 0;
    for (let index = 0; index < 25; index += 1) {
      fixture.notes.create(
        { userId: 'alice', role: 'user' },
        { id: `burst-${index}`, title: `Burst ${index}`, content: `secret-${index}` },
      );
    }
    await waitForFlush(45);
    const events = parsedEvents(browser.res);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data.entityTypes, ['note']);
    const latest = events[0].data.sequence;
    assert.equal(latest, fixture.bridge.store.latestCursor('alice'));

    const reconnected = subscribe(fixture.hub, 'alice', { query: { cursor: '0' } });
    const replay = parsedEvents(reconnected.res).at(-1);
    assert.equal(replay.data.reason, 'reconnect');
    assert.equal(replay.data.sequence, latest);
    assert.deepEqual(replay.data.entityTypes, ['note']);

    const current = subscribe(fixture.hub, 'alice', { query: { cursor: String(latest) } });
    assert.deepEqual(parsedEvents(current.res).at(-1).data, {
      sequence: latest,
      reason: 'connected',
      entityTypes: [],
    });

    const invalidReq = new FakeRequest({ query: { cursor: '-1' } });
    const invalidRes = new FakeResponse();
    assert.equal(fixture.hub.subscribe(invalidReq, invalidRes, {
      userId: 'alice', sessionIdentity: 'alice-invalid-cursor-session',
    }), false);
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.jsonBody.code, 'invalid_change_wake_cursor');
  } finally {
    fixture.close();
  }
});

test('backpressure retains only a coalesced latest hint and database rebind disconnects stale streams', async () => {
  const fixture = createFixture({ coalesceMs: 1 });
  try {
    const browser = subscribe(fixture.hub, 'alice');
    browser.res.chunks.length = 0;
    browser.res.acceptWrites = false;
    fixture.hub.publish({ ownerUserId: 'alice', sequence: 10, entityTypes: ['note'] });
    await waitForFlush(10);
    assert.equal(parsedEvents(browser.res).length, 1);
    for (let sequence = 11; sequence <= 30; sequence += 1) {
      fixture.hub.publish({ ownerUserId: 'alice', sequence, entityTypes: ['connection'] });
    }
    await waitForFlush(10);
    assert.equal(parsedEvents(browser.res).length, 1, 'blocked response is never written repeatedly');
    browser.res.acceptWrites = true;
    browser.res.emit('drain');
    const drained = parsedEvents(browser.res);
    assert.equal(drained.length, 2);
    assert.equal(drained[1].data.sequence, 30);
    assert.deepEqual(drained[1].data.entityTypes, ['connection']);

    fixture.runtime.unbind({ disconnect: true });
    assert.equal(browser.res.writableEnded, true);
    assert.equal(fixture.hub.clientCount, 0);
  } finally {
    fixture.close();
  }
});

test('session revocation generation closes only the revoked browser stream before heartbeat or publish', async () => {
  const fixture = createFixture({ coalesceMs: 1 });
  try {
    const revoked = subscribe(fixture.hub, 'alice', { sessionIdentity: 'alice-session-a' });
    const stillLive = subscribe(fixture.hub, 'alice', { sessionIdentity: 'alice-session-b' });
    const anotherOwner = subscribe(fixture.hub, 'bob', { sessionIdentity: 'bob-session' });
    revoked.res.chunks.length = 0;
    stillLive.res.chunks.length = 0;
    anotherOwner.res.chunks.length = 0;

    assert.equal(fixture.hub.invalidateSession('alice', 'alice-session-a'), 1);
    assert.equal(revoked.res.writableEnded, true);
    fixture.hub._heartbeat();
    fixture.hub.publish({ ownerUserId: 'alice', sequence: 9, entityTypes: ['note'] });
    await waitForFlush(10);

    assert.equal(parsedEvents(revoked.res).length, 0, 'a revoked stream never receives a later wake');
    assert.equal(parsedEvents(stillLive.res).length, 1, 'another session for the same owner stays live');
    assert.equal(parsedEvents(anotherOwner.res).length, 0, 'a session revocation never crosses owner boundaries');
  } finally {
    fixture.close();
  }
});

test('heartbeat closes an expired in-memory session before another wake can be written', async () => {
  const fixture = createFixture({ coalesceMs: 1 });
  let live = true;
  try {
    const browser = subscribe(fixture.hub, 'alice', {
      sessionIdentity: 'alice-expiring-session',
      sessionIsLive: () => live,
    });
    browser.res.chunks.length = 0;
    live = false;
    fixture.hub._heartbeat();
    fixture.hub.publish({ ownerUserId: 'alice', sequence: 13, entityTypes: ['note'] });
    await waitForFlush(10);
    assert.equal(browser.res.writableEnded, true);
    assert.equal(parsedEvents(browser.res).length, 0);
  } finally {
    fixture.close();
  }
});

test('account deletion closes all owner streams and rejects any later wake while preserving other owners', async () => {
  const fixture = createFixture({ coalesceMs: 1 });
  try {
    const alice = subscribe(fixture.hub, 'alice', { sessionIdentity: 'alice-session' });
    const bob = subscribe(fixture.hub, 'bob', { sessionIdentity: 'bob-session' });
    alice.res.chunks.length = 0;
    bob.res.chunks.length = 0;

    assert.equal(fixture.runtime.deleteUserState('alice'), 1);
    assert.equal(alice.res.writableEnded, true);
    fixture.hub.publish({ ownerUserId: 'alice', sequence: 11, entityTypes: ['note'] });
    fixture.hub.publish({ ownerUserId: 'bob', sequence: 12, entityTypes: ['note'] });
    await waitForFlush(10);

    assert.equal(parsedEvents(alice.res).length, 0);
    assert.equal(parsedEvents(bob.res).length, 1);
  } finally {
    fixture.close();
  }
});

test('idle owner state is bounded by durable cursors and reconnects fall back to a safe resync hint', () => {
  let now = 0;
  const durable = new Map();
  const hub = new AppChangeWakeHub({
    allowedEntityTypes: ['note'],
    heartbeatMs: 60_000,
    coalesceMs: 0,
    idleStateTtlMs: 1_000,
    maxIdleOwnerStates: 64,
    now: () => now,
  });
  hub.setSequenceResolver((ownerUserId) => durable.get(ownerUserId) || 0);
  try {
    for (let index = 0; index < 20_000; index += 1) {
      const ownerUserId = `owner-${index}`;
      durable.set(ownerUserId, index + 1);
      hub.publish({ ownerUserId, sequence: index + 1, entityTypes: ['note'] });
      hub._flushOwner(ownerUserId);
    }
    assert.equal(hub.currentSequence.size, 20_000);
    assert.equal(hub.history.size, 20_000);
    assert.equal(hub.sweepIdleState(), 19_936, 'LRU cap trims old idle owners before their TTL');
    assert.equal(hub.currentSequence.size, 64);
    assert.equal(hub.currentSequence.has('owner-0'), false);
    assert.equal(hub.currentSequence.has('owner-19999'), true);

    now += 1_001;
    assert.equal(hub.sweepIdleState(), 64);
    assert.equal(hub.currentSequence.size, 0);
    assert.equal(hub.history.size, 0);
    assert.equal(hub.ownerActivity.size, 0);

    const reconnected = subscribe(hub, 'owner-42', {
      sessionIdentity: 'owner-42-session',
      query: { cursor: '0' },
    });
    assert.deepEqual(parsedEvents(reconnected.res).at(-1).data, {
      sequence: 43,
      reason: 'reconnect',
      entityTypes: ['note'],
    });

    hub._connectionAllowed('rate-limited-owner');
    assert.equal(hub.connectionAttempts.size, 2);
    now += 60_001;
    hub.sweepIdleState();
    assert.equal(hub.connectionAttempts.size, 0, 'expired connection-attempt buckets do not retain owners');
  } finally {
    hub.close();
  }
});

test('route registration preserves requireUser as the authentication gate', () => {
  const calls = [];
  const app = { get(pathname, ...handlers) { calls.push({ pathname, handlers }); } };
  const hub = new AppChangeWakeHub({ allowedEntityTypes: ['note'], heartbeatMs: 60_000 });
  try {
    const requireUser = () => {};
    assert.equal(registerAppChangeWakeRoute(app, { requireUser, hub }), APP_CHANGE_WAKE_ROUTE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/api/me/change-wake');
    assert.equal(calls[0].handlers[0], requireUser);
  } finally {
    hub.close();
  }
});

test('database generation bind advances each owner cursor so equal imported counters still resync', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  db.exec(`
    CREATE TABLE users (userId TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO users VALUES ('alice', 'active'), ('bob', 'active'), ('deleted-user', 'deleted');
  `);
  const bridge = new MobileV1ChangeBridge({ db, registry });
  const hub = new AppChangeWakeHub({ allowedEntityTypes: allowedTypes, heartbeatMs: 60_000 });
  const runtime = new AppChangeWakeRuntime({ hub });
  try {
    runtime.bind(db, { bridge });
    assert.deepEqual(db.prepare(`SELECT owner_user_id, sequence FROM app_change_wake_sequences
      ORDER BY owner_user_id`).all().map((row) => ({ ...row })), [
      { owner_user_id: 'alice', sequence: 1 },
      { owner_user_id: 'bob', sequence: 1 },
    ]);
    runtime.bind(db, { bridge });
    assert.deepEqual(db.prepare(`SELECT owner_user_id, sequence FROM app_change_wake_sequences
      ORDER BY owner_user_id`).all().map((row) => ({ ...row })), [
      { owner_user_id: 'alice', sequence: 2 },
      { owner_user_id: 'bob', sequence: 2 },
    ]);
  } finally {
    runtime.close();
    db.close();
  }
});
