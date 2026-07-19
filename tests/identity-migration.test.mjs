import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* Multi-user identity migration tests (FREEZE plan §18.1/§21.2).
 * Runs storage.js against an isolated temp data dir. */

let tmpDir;
let storage;

function hashPasswordStub(password, salt = 'testsalt') {
    const hash = crypto.pbkdf2Sync(String(password), salt, 1000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
}

function boot() {
    storage.init({ hashPassword: hashPasswordStub });
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-identity-'));
    process.env.ZEPHYR_DATA_DIR = tmpDir;
    process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = path.join(tmpDir, 'crypto', 'test-keypair.json');
    storage = await import('../storage.js');
    boot();
});

after(() => {
    try { storage.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('first boot creates admin with immutable userId, role and status', () => {
    const admin = storage.getUser('admin');
    assert.ok(admin, 'default admin exists');
    assert.ok(admin.userId && admin.userId.length >= 32, 'userId assigned');
    assert.equal(admin.role, 'admin', 'legacy single-user installs become admin');
    assert.equal(admin.status, 'active');
});

test('identity migration is idempotent across re-init', () => {
    const before = storage.getUser('admin');
    storage.close();
    boot();
    const after = storage.getUser('admin');
    assert.equal(after.userId, before.userId, 'userId must be stable across restarts');
    assert.equal(after.role, 'admin');
});

test('legacy rows without identity get backfilled; existing ids never change', () => {
    const db = storage.rawDb();
    db.prepare("INSERT INTO users (username, passwordHash, createdAt, updatedAt) VALUES ('legacybob','x',1,1)").run();
    db.prepare("UPDATE users SET userId = NULL, role = NULL, status = NULL").run();
    storage.close();
    boot();
    const bob = storage.getUser('legacybob');
    assert.ok(bob.userId, 'missing userId backfilled');
    assert.equal(bob.role, 'admin', 'pre-multi-user users become admin (preserves old full access)');
    assert.equal(bob.status, 'active');
    const adminId = storage.getUser('admin').userId;
    storage.close();
    boot();
    assert.equal(storage.getUser('admin').userId, adminId, 'existing userId is never rewritten');
    assert.equal(storage.getUser('legacybob').userId, bob.userId);
});

test('passkeys and reset codes migrate from username to userId', () => {
    const admin = storage.getUser('admin');
    let db = storage.rawDb();
    db.prepare("INSERT INTO passkeys (id, username, credentialId, publicKey, createdAt) VALUES ('pk1','admin','cred1','pk',1)").run();
    db.prepare("INSERT INTO password_reset_codes (id, username, email, codeHash, expiresAt, createdAt) VALUES ('rc1','admin','a@b.c','h',1,1)").run();
    db.prepare('UPDATE passkeys SET userId = NULL').run();
    db.prepare('UPDATE password_reset_codes SET userId = NULL').run();
    storage.close();
    boot();
    db = storage.rawDb(); // rawDb() re-resolves the reopened handle
    const pk = db.prepare("SELECT userId FROM passkeys WHERE id='pk1'").get();
    const rc = db.prepare("SELECT userId FROM password_reset_codes WHERE id='rc1'").get();
    assert.equal(pk.userId, admin.userId);
    assert.equal(rc.userId, admin.userId);
});

test('createUser defaults to plain user role; getUserById resolves', () => {
    const u = storage.createUser({ username: 'alice', passwordHash: hashPasswordStub('pw'), email: 'a@x.y' });
    assert.equal(u.role, 'user', 'new users are NOT admin by default');
    assert.equal(u.status, 'active');
    assert.ok(u.userId);
    const byId = storage.getUserById(u.userId);
    assert.equal(byId.username, 'alice');
    const admin = storage.createUser({ username: 'ops', passwordHash: hashPasswordStub('pw'), role: 'admin' });
    assert.equal(admin.role, 'admin');
});

test('saveUsersStore preserves identity of existing users', () => {
    const alice = storage.getUser('alice');
    const store = storage.getUsersStore();
    store.users = store.users.filter((u) => u.username !== 'ops'); // drop ops
    storage.saveUsersStore(store);
    const after = storage.getUser('alice');
    assert.equal(after.userId, alice.userId, 'userId survives legacy whole-store rewrite');
    assert.equal(after.role, 'user', 'role survives');
    assert.equal(storage.getUser('ops'), null);
});

test('renameUser keeps userId and moves passkeys', () => {
    const bob = storage.getUser('legacybob');
    const renamed = storage.renameUser('legacybob', 'robert');
    assert.equal(renamed.userId, bob.userId, 'rename must not change identity');
    assert.equal(storage.getUser('legacybob'), null);
    assert.equal(storage.getUserById(bob.userId).username, 'robert');
});

test('updateUserById can suspend and change role', () => {
    const alice = storage.getUser('alice');
    const updated = storage.updateUserById(alice.userId, { status: 'suspended' });
    assert.equal(updated.status, 'suspended');
    const promoted = storage.updateUserById(alice.userId, { role: 'admin', status: 'active' });
    assert.equal(promoted.role, 'admin');
    assert.equal(promoted.status, 'active');
});
