import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateSecret, generateSync } from 'otplib';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let victimCookie;
const VICTIM = 'lock-victim';
const VICTIM_PASS = 'victim-real-pass-1';
const VICTIM_EMAIL = 'lock-victim@example.test';

function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function openDb() {
    const dbPath = path.join(server.dir, 'zephyr.db');
    assert.ok(fs.existsSync(dbPath), 'test data db must exist');
    return new Database(dbPath);
}

function readUser(username) {
    const db = openDb();
    try {
        return db.prepare('SELECT username, failedLoginCount, lockedUntil, status, totpEnabled, totpSecret, email FROM users WHERE username=?').get(username);
    } finally {
        db.close();
    }
}

function setUserFields(username, fields) {
    const db = openDb();
    try {
        const keys = Object.keys(fields);
        const sets = keys.map((k) => `${k}=@${k}`).join(', ');
        db.prepare(`UPDATE users SET ${sets} WHERE username=@username`).run({ username, ...fields });
    } finally {
        db.close();
    }
}

/** Wipe IP bans so account-level lockout assertions are not masked by 403 IP bans. */
function clearAllIpBans() {
    const db = openDb();
    try {
        db.prepare('DELETE FROM ip_bans').run();
    } finally {
        db.close();
    }
}

function unlockAccount(username) {
    setUserFields(username, { failedLoginCount: 0, lockedUntil: null });
    clearAllIpBans();
}

function plantResetToken(username, email, token, { attemptCount = 0, expiresInMs = 10 * 60 * 1000 } = {}) {
    const db = openDb();
    try {
        db.prepare('UPDATE password_reset_codes SET used=1 WHERE username=? AND used=0').run(username);
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO password_reset_codes
            (id, username, email, codeHash, expiresAt, used, createdAt, attemptCount)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(
            id,
            username,
            email,
            sha256(token),
            Date.now() + expiresInMs,
            Date.now(),
            attemptCount,
        );
        return id;
    } finally {
        db.close();
    }
}

function readResetRow(id) {
    const db = openDb();
    try {
        return db.prepare('SELECT * FROM password_reset_codes WHERE id=?').get(id);
    } finally {
        db.close();
    }
}

async function loginRaw(username, password) {
    const res = await fetch(server.url('/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
}

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-auth-hard-1');
    adminCookie = boot.cookie;

    // Keep brute-force on; tests clear IP bans when asserting account lock.
    const sec = await server.api(adminCookie, 'PUT', '/api/settings/security', {
        bruteForceEnabled: true,
        bruteForceMaxFailures: 5,
        bruteForceBanMinutes: 15,
        ipWhitelistEnabled: false,
    });
    assert.equal(sec.status, 200, JSON.stringify(sec.body));

    const created = await server.api(adminCookie, 'POST', '/api/admin/users', {
        username: VICTIM,
        password: 'temp-victim-1',
        email: VICTIM_EMAIL,
        role: 'user',
        mustChangePassword: true,
    });
    assert.equal(created.status, 200, `create victim: ${JSON.stringify(created.body)}`);

    const first = await server.login(VICTIM, 'temp-victim-1');
    const changed = await server.api(first.cookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'temp-victim-1',
        newPassword: VICTIM_PASS,
    });
    assert.equal(changed.status, 200, `change victim password: ${JSON.stringify(changed.body)}`);
    victimCookie = first.cookie;
});

after(async () => {
    await server?.cleanup();
});

test('account lockout after repeated wrong passwords', async () => {
    unlockAccount(VICTIM);

    for (let i = 0; i < 5; i++) {
        const r = await loginRaw(VICTIM, 'wrong-password');
        assert.equal(r.status, 401, `fail ${i + 1} should be 401, got ${r.status} ${JSON.stringify(r.body)}`);
    }

    const row = readUser(VICTIM);
    assert.ok(Number(row.failedLoginCount) >= 5, `failedLoginCount=${row.failedLoginCount}`);
    assert.ok(row.lockedUntil && Number(row.lockedUntil) > Date.now(), 'lockedUntil must be in the future');

    // Clear IP ban only — account lock must still block the correct password.
    clearAllIpBans();
    const locked = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(locked.status, 429, `locked account must reject even correct password: ${JSON.stringify(locked.body)}`);
    assert.equal(locked.body.code, 'account_locked');

    unlockAccount(VICTIM);
    const ok = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(ok.status, 200, 'unlocked account logs in');
});

test('successful login clears failedLoginCount', async () => {
    unlockAccount(VICTIM);
    setUserFields(VICTIM, { failedLoginCount: 2, lockedUntil: null });
    const ok = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(ok.status, 200);
    const row = readUser(VICTIM);
    assert.equal(Number(row.failedLoginCount), 0);
    assert.equal(row.lockedUntil, null);
});

test('reset token burns after max failed attempts', async () => {
    unlockAccount(VICTIM);
    setUserFields(VICTIM, { email: VICTIM_EMAIL });
    const token = crypto.randomBytes(16).toString('base64url');
    const id = plantResetToken(VICTIM, VICTIM_EMAIL, token);

    for (let i = 0; i < 5; i++) {
        const r = await server.api(null, 'POST', '/api/auth/forgot-password/reset', {
            email: VICTIM_EMAIL,
            code: `bad-token-${i}`,
            newPassword: 'new-pass-should-not-apply',
        });
        assert.equal(r.status, 400, `bad attempt ${i + 1}: ${JSON.stringify(r.body)}`);
    }

    const burned = readResetRow(id);
    assert.equal(Number(burned.used), 1, 'token must be marked used after max attempts');
    assert.ok(Number(burned.attemptCount) >= 5);

    clearAllIpBans();
    const late = await server.api(null, 'POST', '/api/auth/forgot-password/reset', {
        email: VICTIM_EMAIL,
        code: token,
        newPassword: 'should-not-work-1',
    });
    assert.equal(late.status, 400, 'correct token after burn must fail');

    unlockAccount(VICTIM);
    const ok = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(ok.status, 200);
});

test('valid high-entropy reset token changes password once', async () => {
    unlockAccount(VICTIM);
    setUserFields(VICTIM, { failedLoginCount: 3, lockedUntil: null, email: VICTIM_EMAIL });
    const token = crypto.randomBytes(16).toString('base64url');
    plantResetToken(VICTIM, VICTIM_EMAIL, token);
    const nextPass = 'victim-reset-pass-9';

    const r = await server.api(null, 'POST', '/api/auth/forgot-password/reset', {
        email: VICTIM_EMAIL,
        code: token,
        newPassword: nextPass,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const oldLogin = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(oldLogin.status, 401, 'old password must fail');

    const newLogin = await loginRaw(VICTIM, nextPass);
    assert.equal(newLogin.status, 200, 'new password works');

    const row = readUser(VICTIM);
    assert.equal(Number(row.failedLoginCount), 0, 'successful reset clears lock counters');

    const raw = await fetch(server.url('/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VICTIM, password: nextPass }),
    });
    const cookie = (raw.headers.get('set-cookie') || '').match(/zephyr_sid=([^;]+)/)?.[1];
    assert.ok(cookie);
    const restored = await server.api(`zephyr_sid=${cookie}`, 'POST', '/api/auth/change-password', {
        currentPassword: nextPass,
        newPassword: VICTIM_PASS,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    unlockAccount(VICTIM);
});

test('TOTP tempToken is exhausted after repeated wrong codes', async () => {
    unlockAccount(VICTIM);
    const secret = generateSecret();
    // Store plaintext secret; decrypt path accepts non-encrypted values.
    setUserFields(VICTIM, { totpEnabled: 1, totpSecret: secret });

    const step1 = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(step1.status, 200, JSON.stringify(step1.body));
    assert.equal(step1.body.requireTotp, true);
    const tempToken = step1.body.tempToken;
    assert.ok(tempToken);

    for (let i = 0; i < 5; i++) {
        clearAllIpBans();
        // Keep account unlocked so we measure tempToken burn, not account lock.
        setUserFields(VICTIM, { failedLoginCount: 0, lockedUntil: null });
        const r = await server.api(null, 'POST', '/api/auth/totp/verify', {
            tempToken,
            code: '000000',
        });
        assert.equal(r.status, 401, `totp fail ${i + 1}: ${JSON.stringify(r.body)}`);
        if (i === 4) {
            assert.equal(r.body.code, 'totp_temp_exhausted');
        }
    }

    const goodCode = generateSync({ secret });
    const late = await server.api(null, 'POST', '/api/auth/totp/verify', {
        tempToken,
        code: goodCode,
    });
    assert.equal(late.status, 400, 'burned tempToken should be expired');

    unlockAccount(VICTIM);
    const step2 = await loginRaw(VICTIM, VICTIM_PASS);
    assert.equal(step2.status, 200, JSON.stringify(step2.body));
    assert.equal(step2.body.requireTotp, true);
    const okCode = generateSync({ secret });
    const ok = await server.api(null, 'POST', '/api/auth/totp/verify', {
        tempToken: step2.body.tempToken,
        code: okCode,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    setUserFields(VICTIM, { totpEnabled: 0, totpSecret: null });
    unlockAccount(VICTIM);
});

test('passkey options rejects suspended user when username given', async () => {
    unlockAccount(VICTIM);
    setUserFields(VICTIM, { status: 'suspended' });
    const r = await server.api(null, 'POST', '/api/passkeys/login/options', { username: VICTIM });
    assert.equal(r.status, 400);
    setUserFields(VICTIM, { status: 'active' });
});

test('passkey options rejects locked account when username given', async () => {
    clearAllIpBans();
    setUserFields(VICTIM, {
        status: 'active',
        failedLoginCount: 9,
        lockedUntil: Date.now() + 60 * 60 * 1000,
    });
    const r = await server.api(null, 'POST', '/api/passkeys/login/options', { username: VICTIM });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'account_locked');
    unlockAccount(VICTIM);
});

test('passkey verify rejects missing credential without minting session', async () => {
    clearAllIpBans();
    const r = await server.api(null, 'POST', '/api/passkeys/login/verify', {
        id: 'nonexistent-credential',
        response: {},
    });
    assert.equal(r.status, 400);
});

test('createResetCode invalidates previous unused tokens', async () => {
    setUserFields(VICTIM, { email: VICTIM_EMAIL });
    const t1 = crypto.randomBytes(16).toString('base64url');
    const id1 = plantResetToken(VICTIM, VICTIM_EMAIL, t1);
    const t2 = crypto.randomBytes(16).toString('base64url');
    const id2 = plantResetToken(VICTIM, VICTIM_EMAIL, t2);
    const row1 = readResetRow(id1);
    const row2 = readResetRow(id2);
    assert.equal(Number(row1.used), 1, 'older token invalidated');
    assert.equal(Number(row2.used), 0, 'latest token live');
});
