import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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

function makeStorage(seedUsers, seedData = {}) {
    const users = new Map(seedUsers.map((u) => [u.userId, { ...u }]));
    const ownedData = Object.fromEntries(Object.entries(seedData).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
    const storage = {
        ownedData,
        listUsers() { return [...users.values()]; },
        getUser(username) {
            return [...users.values()].find((u) => u.username === username) || null;
        },
        getUserById(userId) {
            return users.get(String(userId)) || null;
        },
        createUser(fields) {
            const userId = randomUUID();
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
        archiveDeletedUsername(userId) {
            const old = users.get(String(userId));
            if (!old || old.status !== 'deleted') return null;
            const archived = { ...old, username: `${old.username}#deleted:${old.userId}` };
            users.set(String(userId), archived);
            return { ...archived };
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
                prepare(sql) {
                    return {
                        run(...params) {
                            const deleted = /^DELETE FROM (connections|proxies|ssh_keys|jump_hosts) WHERE ownerUserId = \?$/i.exec(sql);
                            if (deleted && ownedData[deleted[1]]) {
                                ownedData[deleted[1]] = ownedData[deleted[1]].filter((row) => row.ownerUserId !== params[0]);
                            }
                        },
                    };
                },
            };
        },
    };
    return storage;
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

test('createUser recreates a soft-deleted username with a fresh identity', () => {
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
    assert.notEqual(second.userId, 'user-old');
    assert.match(second.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(storage.getUserById('user-old').status, 'deleted');
    assert.equal(storage.getUserById('user-old').username, 'recycle-me#deleted:user-old');
    assert.ok(svc.listUsers().some((u) => u.username === 'recycle-me' && u.status === 'active'));
    assert.ok(authz.events.some((e) => e.action === 'user.create'
        && e.targetUserId === second.userId
        && e.metadata?.previousUserId === 'user-old'));
    assert.ok(sessionStore.revoked.some((r) => r.userId === 'user-old' && r.reason === 'user-recreated'));
});

test('source contracts keep list filter and recycle path', () => {
    assert.match(userServiceSrc, /filter\(\(u\) => u && u\.status !== 'deleted'\)/);
    assert.match(userServiceSrc, /existing\.status !== 'deleted'/);
    assert.match(userServiceSrc, /recycled:\s*true/);
    assert.match(appJs, /status !== 'deleted'/);
    assert.match(appJs, /const visible = \(Array\.isArray\(users\) \? users : \[\]\)\.filter/);
});

test('delete and same-name recreation run synchronous lifecycle cleanup inside their transactions', () => {
    const storage = makeStorage([
        {
            userId: 'admin-1', username: 'admin', role: 'admin', status: 'active',
            isSuperAdmin: true, email: '', defaultPassword: false, passwordHash: 'x',
        },
        {
            userId: 'user-old', username: 'cleanup-me', role: 'user', status: 'active',
            isSuperAdmin: false, email: '', defaultPassword: false, passwordHash: 'y',
        },
    ]);
    let transactionDepth = 0;
    const originalRawDb = storage.rawDb.bind(storage);
    storage.rawDb = () => {
        const db = originalRawDb();
        db.transaction = (fn) => () => {
            transactionDepth += 1;
            try { return fn(); } finally { transactionDepth -= 1; }
        };
        return db;
    };
    const calls = [];
    const lifecycle = {
        beforeDeleteUser({ userId }) {
            assert.equal(transactionDepth, 1);
            calls.push(['delete', userId]);
        },
        beforeRecreateUser({ userId }) {
            assert.equal(transactionDepth, 1);
            calls.push(['recreate', userId]);
        },
    };
    const sessionStore = makeSessionStore();
    const revokeAllForUser = sessionStore.revokeAllForUser.bind(sessionStore);
    sessionStore.revokeAllForUser = (userId, reason) => {
        assert.equal(transactionDepth, 1);
        return revokeAllForUser(userId, reason);
    };
    const svc = new UserService(storage, () => sessionStore, makeAuthz(), hashPassword, lifecycle);
    const actor = storage.getUserById('admin-1');
    svc.deleteUser(actor, 'user-old');
    svc.createUser(actor, { username: 'cleanup-me', password: 'new-pass', mustChangePassword: false });
    assert.deepEqual(calls, [['delete', 'user-old'], ['recreate', 'user-old']]);
});

test('delete-resources and same-name recreation keep all old user-scoped data isolated', () => {
    const storage = makeStorage([
        {
            userId: 'admin-1', username: 'admin', role: 'admin', status: 'active',
            isSuperAdmin: true, email: '', defaultPassword: false, passwordHash: 'x',
        },
        {
            userId: 'user-old', username: 'isolated', role: 'user', status: 'active',
            isSuperAdmin: false, email: '', defaultPassword: false, passwordHash: 'y',
        },
    ], {
        connections: [{ id: 'connection-old', ownerUserId: 'user-old' }],
        proxies: [{ id: 'proxy-old', ownerUserId: 'user-old' }],
        notes: [{ id: 'note-old', ownerUserId: 'user-old' }],
        userSettings: [{ key: 'theme', userId: 'user-old' }],
        workspaces: [{ id: 'workspace-old', userId: 'user-old' }],
        webdavSnapshots: [{ id: 'snapshot-old', userId: 'user-old' }],
    });
    let transactionDepth = 0;
    const originalRawDb = storage.rawDb.bind(storage);
    storage.rawDb = () => {
        const db = originalRawDb();
        db.transaction = (fn) => () => {
            transactionDepth += 1;
            try { return fn(); } finally { transactionDepth -= 1; }
        };
        return db;
    };
    const lifecycleCalls = [];
    const lifecycle = {
        beforeDeleteUser({ userId }) {
            assert.equal(transactionDepth, 1);
            lifecycleCalls.push(['delete', userId]);
            storage.ownedData.webdavSnapshots = storage.ownedData.webdavSnapshots.filter((row) => row.userId !== userId);
        },
        beforeRecreateUser({ userId }) {
            assert.equal(transactionDepth, 1);
            lifecycleCalls.push(['recreate', userId]);
            storage.ownedData.webdavSnapshots = storage.ownedData.webdavSnapshots.filter((row) => row.userId !== userId);
        },
    };
    const sessionStore = makeSessionStore();
    const revokeAllForUser = sessionStore.revokeAllForUser.bind(sessionStore);
    sessionStore.revokeAllForUser = (userId, reason) => {
        assert.equal(transactionDepth, 1);
        return revokeAllForUser(userId, reason);
    };
    const svc = new UserService(storage, () => sessionStore, makeAuthz(), hashPassword, lifecycle);
    const actor = storage.getUserById('admin-1');

    svc.deleteUser(actor, 'user-old', { resourcePolicy: 'delete-resources' });
    const recreated = svc.createUser(actor, {
        username: 'isolated', password: 'new-pass', mustChangePassword: false,
    });

    assert.notEqual(recreated.userId, 'user-old');
    assert.deepEqual(lifecycleCalls, [['delete', 'user-old'], ['recreate', 'user-old']]);
    assert.deepEqual(storage.ownedData.connections, []);
    assert.deepEqual(storage.ownedData.proxies, []);
    assert.deepEqual(storage.ownedData.webdavSnapshots, []);
    assert.equal(storage.ownedData.notes[0].ownerUserId, 'user-old');
    assert.equal(storage.ownedData.userSettings[0].userId, 'user-old');
    assert.equal(storage.ownedData.workspaces[0].userId, 'user-old');
    assert.equal(storage.getUserById('user-old').status, 'deleted');
    assert.equal(sessionStore.revoked.every((entry) => entry.userId === 'user-old'), true);
});

test('async lifecycle wrappers compose around transactional delete and recreation without exposing passwords', async () => {
    const storage = makeStorage([
        {
            userId: 'admin-1', username: 'admin', role: 'admin', status: 'active',
            isSuperAdmin: true, email: '', defaultPassword: false, passwordHash: 'x',
        },
        {
            userId: 'user-old', username: 'composed', role: 'user', status: 'active',
            isSuperAdmin: false, email: '', defaultPassword: false, passwordHash: 'y',
        },
    ]);
    const calls = [];
    const record = (name) => (context) => {
        calls.push(name);
        assert.equal(JSON.stringify(context).includes('never-log-this-password'), false);
    };
    const lifecycle = {
        prepareDeleteUser: [record('delete.prepare.1'), record('delete.prepare.2')],
        beforeDeleteUser: [record('delete.transaction.1'), record('delete.transaction.2')],
        afterDeleteUser: [record('delete.after.1'), record('delete.after.2')],
        prepareRecreateUser: [record('recreate.prepare.1'), record('recreate.prepare.2')],
        beforeRecreateUser: [record('recreate.transaction.1'), record('recreate.transaction.2')],
        afterRecreateUser: [record('recreate.after.1'), record('recreate.after.2')],
    };
    const service = new UserService(storage, () => makeSessionStore(), makeAuthz(), hashPassword, lifecycle);
    const actor = storage.getUserById('admin-1');
    await service.deleteUserWithLifecycle(actor, 'user-old');
    const recreated = await service.createUserWithLifecycle(actor, {
        username: 'composed',
        password: 'never-log-this-password',
        mustChangePassword: false,
    });

    assert.notEqual(recreated.userId, 'user-old');
    assert.deepEqual(calls, [
        'delete.prepare.1', 'delete.prepare.2',
        'delete.transaction.1', 'delete.transaction.2',
        'delete.after.1', 'delete.after.2',
        'recreate.prepare.1', 'recreate.prepare.2',
        'recreate.transaction.1', 'recreate.transaction.2',
        'recreate.after.1', 'recreate.after.2',
    ]);
});

test('failed account transactions run composed abort hooks and release the lifecycle lock', async () => {
    const storage = makeStorage([
        {
            userId: 'admin-1', username: 'admin', role: 'admin', status: 'active',
            isSuperAdmin: true, email: '', defaultPassword: false, passwordHash: 'x',
        },
        {
            userId: 'user-fail', username: 'rollback', role: 'user', status: 'active',
            isSuperAdmin: false, email: '', defaultPassword: false, passwordHash: 'y',
        },
    ]);
    const calls = [];
    let injectFailure = true;
    const lifecycle = {
        prepareDeleteUser: [() => calls.push('prepare.1'), () => calls.push('prepare.2')],
        beforeDeleteUser: [
            () => calls.push('transaction.1'),
            () => {
                calls.push('transaction.2');
                if (injectFailure) throw new Error('injected transaction failure');
            },
        ],
        abortDeleteUser: [() => calls.push('abort.1'), () => calls.push('abort.2')],
        afterDeleteUser: () => calls.push('after'),
    };
    const service = new UserService(storage, () => makeSessionStore(), makeAuthz(), hashPassword, lifecycle);
    const actor = storage.getUserById('admin-1');
    await assert.rejects(
        service.deleteUserWithLifecycle(actor, 'user-fail'),
        /injected transaction failure/,
    );
    assert.equal(storage.getUserById('user-fail').status, 'active');
    assert.deepEqual(calls, [
        'prepare.1', 'prepare.2', 'transaction.1', 'transaction.2', 'abort.1', 'abort.2',
    ]);

    injectFailure = false;
    await service.deleteUserWithLifecycle(actor, 'user-fail');
    assert.equal(storage.getUserById('user-fail').status, 'deleted');
    assert.equal(calls.at(-1), 'after');
});
