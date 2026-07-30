import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Soft-delete must drop the user from admin listUsers() so the multi-user
 * panel no longer shows a "deleted" card after DELETE succeeds.
 * Pure unit tests — no better-sqlite3 / real DB required.
 */

const require = createRequire(import.meta.url);
const { UserService } = require('../user-service.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const userServiceSrc = readFileSync(path.join(root, 'user-service.js'), 'utf8');

function hashPassword(password) {
    return `hash:${password}`;
}

function makeAuthz() {
    const events = [];
    return {
        events,
        audit(entry) { events.push(entry); },
    };
}

function makeSessionStore() {
    const revoked = [];
    return {
        revoked,
        revokeAllForUser(userId, reason) {
            revoked.push({ userId, reason });
            return 1;
        },
        setMustChangePassword() {},
    };
}

function makeStorage(seedUsers) {
    const users = new Map(seedUsers.map((u) => [u.userId, { ...u }]));
    return {
        listUsers() { return [...users.values()]; },
        getUser(username) {
            return [...users.values()].find((u) => u.username === username) || null;
        },
        getUserById(userId) {
            return users.get(String(userId)) || null;
        },
        createUser(fields) {
            const userId = `u-${users.size + 1}`;
            const row = {
                userId,
                username: fields.username,
                passwordHash: fields.passwordHash,
                email: fields.email || '',
                role: fields.role || 'user',
                status: fields.status || 'active',
                defaultPassword: !!fields.defaultPassword,
                isSuperAdmin: !!fields.isSuperAdmin,
                totpEnabled: false,
                totpSecret: null,
                failedLoginCount: 0,
                lockedUntil: null,
                createdAt: 1,
                updatedAt: 1,
                lastLoginAt: null,
            };
            users.set(userId, row);
            return { ...row };
        },
        updateUserById(userId, values) {
            const old = users.get(String(userId));
            if (!old) return null;
            const next = { ...old, ...values, updatedAt: (old.updatedAt || 0) + 1 };
            users.set(String(userId), next);
            return { ...next };
        },
        rawDb() {
            const self = this;
            return {
                transaction(fn) { return () => fn(); },
                prepare() {
                    return {
                        run() { /* resource transfer / session revoke no-ops in unit test */ },
                    };
                },
            };
        },
    };
}

test('listUsers excludes soft-deleted users after deleteUser', () => {
    const storage = makeStorage([
        {
            userId: 'admin-1',
            username: 'admin',
            role: 'admin',
            status: 'active',
            isSuperAdmin: true,
            email: '',
            defaultPassword: false,
            passwordHash: 'x',
        },
        {
            userId: 'user-aili',
            username: 'aili',
            role: 'user',
            status: 'active',
            isSuperAdmin: false,
            email: '',
            defaultPassword: true,
            passwordHash: 'y',
        },
    ]);
    const sessionStore = makeSessionStore();
    const authz = makeAuthz();
    const svc = new UserService(storage, () => sessionStore, authz, hashPassword);
    const actor = storage.getUserById('admin-1');

    const before = svc.listUsers();
    assert.ok(before.some((u) => u.userId === 'user-aili'));
    assert.equal(before.some((u) => u.status === 'deleted'), false);

    svc.deleteUser(actor, 'user-aili', { resourcePolicy: 'transfer-to-admin' });
    assert.equal(storage.getUserById('user-aili').status, 'deleted');

    const after = svc.listUsers();
    assert.equal(after.some((u) => u.userId === 'user-aili'), false);
    assert.equal(after.some((u) => u.username === 'aili'), false);
    assert.ok(authz.events.some((e) => e.action === 'user.delete'));
});

test('createUser recycles soft-deleted username', () => {
    const storage = makeStorage([
        {
            userId: 'admin-1',
            username: 'admin',
            role: 'admin',
            status: 'active',
            isSuperAdmin: true,
            email: '',
            defaultPassword: false,
            passwordHash: 'x',
        },
        {
            userId: 'user-old',
            username: 'recycle-me',
            role: 'user',
            status: 'deleted',
            isSuperAdmin: false,
            email: 'old@x.y',
            defaultPassword: true,
            passwordHash: 'old',
            totpEnabled: true,
            totpSecret: 'secret',
            failedLoginCount: 3,
            lockedUntil: 999,
        },
    ]);
    const sessionStore = makeSessionStore();
    const authz = makeAuthz();
    const svc = new UserService(storage, () => sessionStore, authz, hashPassword);
    const actor = storage.getUserById('admin-1');

    assert.equal(svc.listUsers().some((u) => u.username === 'recycle-me'), false);

    const second = svc.createUser(actor, {
        username: 'recycle-me',
        password: 'newpass99',
        email: 'r@x.y',
        role: 'user',
        mustChangePassword: false,
    });
    assert.equal(second.username, 'recycle-me');
    assert.equal(second.status, 'active');
    assert.equal(second.email, 'r@x.y');
    assert.equal(second.userId, 'user-old', 'reuses soft-deleted row id');
    assert.ok(svc.listUsers().some((u) => u.username === 'recycle-me' && u.status === 'active'));
    assert.ok(authz.events.some((e) => e.action === 'user.create' && e.metadata?.recycled === true));
    assert.ok(sessionStore.revoked.some((r) => r.userId === 'user-old' && r.reason === 'user-recreated'));
});

test('source contracts keep list filter and recycle path', () => {
    assert.match(userServiceSrc, /filter\(\(u\) => u && u\.status !== 'deleted'\)/);
    assert.match(userServiceSrc, /existing\.status !== 'deleted'/);
    assert.match(userServiceSrc, /recycled:\s*true/);
    assert.match(appJs, /status !== 'deleted'/);
    assert.match(appJs, /const visible = \(Array\.isArray\(users\) \? users : \[\]\)\.filter/);
});
