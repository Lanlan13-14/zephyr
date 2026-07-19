import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SessionStore, sha256 } from '../session-store.js';

const DDL = `
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  revoke_reason TEXT,
  user_agent_hash TEXT,
  ip_prefix TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(idle_expires_at, absolute_expires_at);
`;

function makeStore(now, opts = {}) {
    const db = new Database(':memory:');
    db.exec(DDL);
    const store = new SessionStore(db, {
        idleTtlMs: 90 * 1000,
        absoluteTtlMs: 10 * 60 * 1000,
        rememberIdleTtlMs: 60 * 60 * 1000,
        rememberAbsoluteTtlMs: 24 * 60 * 60 * 1000,
        now,
        ...opts,
    });
    return { db, store };
}

test('create returns a sid and only the hash is persisted', () => {
    let nowTs = 1_000_000;
    const { db, store } = makeStore(() => nowTs);
    const { sid, session } = store.create({ userId: 'u1', username: 'alice', userAgent: 'agent', ip: '192.168.1.20' });
    assert.ok(sid.length >= 32);
    assert.equal(session.userId, 'u1');
    const row = db.prepare('SELECT * FROM auth_sessions').get();
    assert.equal(row.token_hash, sha256(sid));
    assert.ok(!JSON.stringify(row).includes(sid), 'raw sid must never be persisted');
    assert.equal(row.ip_prefix, '192.168.1.0/24');
    assert.equal(row.user_agent_hash, sha256('agent'));
});

test('resolve slides idle expiry but persists at most once per minute', () => {
    let nowTs = 1_000_000;
    const { db, store } = makeStore(() => nowTs);
    const { sid } = store.create({ userId: 'u1', username: 'alice' });
    nowTs += 30 * 1000; // +30s: within touch interval (60s) → no DB write
    store.resolve(sid);
    let row = db.prepare('SELECT last_seen_at, idle_expires_at FROM auth_sessions').get();
    assert.equal(Number(row.last_seen_at), 1_000_000, 'within 60s the DB row must not be rewritten');
    nowTs += 31 * 1000; // +61s total → touch persists, idle slides by idleTtl (90s)
    const s = store.resolve(sid);
    row = db.prepare('SELECT last_seen_at, idle_expires_at FROM auth_sessions').get();
    assert.equal(Number(row.last_seen_at), nowTs);
    assert.equal(Number(row.idle_expires_at), nowTs + 90 * 1000);
    assert.equal(s.idleExpiresAt, nowTs + 90 * 1000);
});

test('idle expiry invalidates the session; absolute expiry caps sliding', () => {
    let nowTs = 1_000_000;
    const { store } = makeStore(() => nowTs);
    const { sid } = store.create({ userId: 'u1', username: 'alice' });
    nowTs += 91 * 1000; // beyond 90s idle TTL without any touch
    assert.equal(store.resolve(sid), null, 'idle timeout must expire the session');

    const { sid: sid2 } = store.create({ userId: 'u1', username: 'alice' });
    // touch every 61s: always within the 90s idle window → stays alive…
    for (let i = 0; i < 9; i++) { nowTs += 61 * 1000; assert.ok(store.resolve(sid2), `touch ${i} should stay alive`); }
    // …until the 10min absolute cap is crossed even while actively sliding
    // (created at 1_091_000 + 10×61s = 1_701_000 > absolute expiry 1_691_000)
    nowTs += 61 * 1000;
    assert.equal(store.resolve(sid2), null, 'absolute TTL must cap an actively-sliding session');
});

test('remember-me sessions use the longer TTL pair', () => {
    let nowTs = 1_000_000;
    const { store } = makeStore(() => nowTs);
    const { session } = store.create({ userId: 'u1', username: 'alice', remember: true });
    assert.equal(session.idleExpiresAt - nowTs, 60 * 60 * 1000);
    assert.equal(session.absoluteExpiresAt - nowTs, 24 * 60 * 60 * 1000);
});

test('a fresh store instance (process restart) still resolves the session', () => {
    let nowTs = 1_000_000;
    const db = new Database(':memory:');
    db.exec(DDL);
    const store1 = new SessionStore(db, { idleTtlMs: 60000, absoluteTtlMs: 600000, now: () => nowTs });
    const { sid } = store1.create({ userId: 'u1', username: 'alice' });
    // simulate process restart: brand-new store, empty cache, same DB
    const store2 = new SessionStore(db, { idleTtlMs: 60000, absoluteTtlMs: 600000, now: () => nowTs });
    const s = store2.resolve(sid);
    assert.ok(s, 'session must survive process restart');
    assert.equal(s.userId, 'u1');
    assert.equal(s.persisted, true);
});

test('revoke wins over cache and survives restart; revokeAllForUser honors exceptSid', () => {
    let nowTs = 1_000_000;
    const db = new Database(':memory:');
    db.exec(DDL);
    const store = new SessionStore(db, { idleTtlMs: 60000, absoluteTtlMs: 600000, now: () => nowTs });
    const a = store.create({ userId: 'u1', username: 'alice' });
    const b = store.create({ userId: 'u1', username: 'alice' });
    const c = store.create({ userId: 'u2', username: 'bob' });

    store.revoke(a.sid, 'logout');
    assert.equal(store.resolve(a.sid), null);
    const store2 = new SessionStore(db, { idleTtlMs: 60000, absoluteTtlMs: 600000, now: () => nowTs });
    assert.equal(store2.resolve(a.sid), null, 'revocation must persist across restart');

    const revoked = store2.revokeAllForUser('u1', 'password-changed', { exceptSid: b.sid });
    assert.equal(revoked, 0, 'a was already revoked; b is excluded');
    assert.ok(store2.resolve(b.sid), 'exceptSid session stays live');
    assert.ok(store2.resolve(c.sid), 'other users are untouched');
    assert.equal(store2.revokeAllForUser('u1', 'suspend'), 1);
    assert.equal(store2.resolve(b.sid), null);
});

test('mustChangePassword flag persists and clears per user', () => {
    let nowTs = 1_000_000;
    const { db, store } = makeStore(() => nowTs);
    const { sid } = store.create({ userId: 'u1', username: 'alice', mustChangePassword: true });
    assert.equal(store.resolve(sid).mustChangePassword, true);
    const store2 = new SessionStore(db, { now: () => nowTs });
    assert.equal(store2.resolve(sid).mustChangePassword, true, 'flag must persist across restart');
    store2.setMustChangePassword('u1', false);
    assert.equal(store2.resolve(sid).mustChangePassword, false);
    const row = db.prepare('SELECT must_change_password FROM auth_sessions').get();
    assert.equal(row.must_change_password, 0);
});

test('listForUser exposes token hash id but never the raw sid', () => {
    let nowTs = 1_000_000;
    const { store } = makeStore(() => nowTs);
    const { sid } = store.create({ userId: 'u1', username: 'alice' });
    store.create({ userId: 'u1', username: 'alice' });
    store.create({ userId: 'u2', username: 'bob' });
    const list = store.listForUser('u1');
    assert.equal(list.length, 2);
    for (const item of list) {
        assert.ok(item.id && item.id.length === 64, 'id is the sha256 hash');
        assert.notEqual(item.id, sid);
        assert.ok(!('sid' in item) || item.sid == null);
    }
    assert.equal(store.listForUser('u2').length, 1);
});

test('renameUser updates live and persisted session usernames', () => {
    let nowTs = 1_000_000;
    const { db, store } = makeStore(() => nowTs);
    const { sid } = store.create({ userId: 'u1', username: 'alice' });
    store.renameUser('u1', 'alice2');
    assert.equal(store.resolve(sid).username, 'alice2');
    const store2 = new SessionStore(db, { now: () => nowTs });
    assert.equal(store2.resolve(sid).username, 'alice2');
});

test('gc removes expired and revoked rows', () => {
    let nowTs = 1_000_000;
    const { db, store } = makeStore(() => nowTs);
    store.create({ userId: 'u1', username: 'alice' });
    const { sid } = store.create({ userId: 'u1', username: 'alice' });
    store.revoke(sid, 'logout');
    nowTs += 20 * 60 * 1000; // everything expired
    const removed = store.gc();
    assert.equal(removed, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM auth_sessions').get().c, 0);
});

test('concurrent double-resolve after expiry returns null exactly once semantics', () => {
    let nowTs = 1_000_000;
    const { store } = makeStore(() => nowTs);
    const { sid } = store.create({ userId: 'u1', username: 'alice' });
    nowTs += 91 * 1000; // beyond the 90s idle TTL
    assert.equal(store.resolve(sid), null);
    assert.equal(store.resolve(sid), null, 'repeat resolve stays null without resurrecting');
});
