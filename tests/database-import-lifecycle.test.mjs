import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import importAuthStateModule from '../database-import-auth-state.js';
import importJournalModule from '../database-import-install-journal.js';
import sqliteDriverModule from '../sqlite-driver.js';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const { invalidateImportedAuthenticationState } = importAuthStateModule;
const {
    CLEANUP_NAME,
    JOURNAL_NAME,
    beginImportInstall,
    commitImportInstall,
    installPreparedImport,
} = importJournalModule;
const { createDatabase } = sqliteDriverModule;

const ROOT = path.resolve(import.meta.dirname, '..');
const FIRST_PASSWORD = 'import-lifecycle-first-pass';
const SECOND_PASSWORD = 'import-lifecycle-second-pass';
const BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64url');
const secureDataFixtures = new Map();

function createServerDataDir(prefix) {
    const fixture = createSecureTestDataDir(prefix);
    secureDataFixtures.set(fixture.dataDir, fixture);
    return fixture.dataDir;
}

function removeServerDataDir(dataDir) {
    const fixture = secureDataFixtures.get(dataDir);
    if (fixture) {
        secureDataFixtures.delete(dataDir);
        removeSecureTestDataDir(fixture);
        return;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
}

async function freePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    return port;
}

async function startServer(fault, options = {}) {
    const dataDir = options.dataDir
        ? path.resolve(options.dataDir)
        : createServerDataDir('zephyr-import-lifecycle-');
    const removeDataOnStop = options.removeDataOnStop ?? !options.dataDir;
    const port = await freePort();
    const aiPort = await freePort();
    const env = {
        ...process.env,
        HTTP_ENABLED: 'true',
        HTTPS_ENABLED: 'false',
        PORT: String(port),
        ZEPHYR_BIND_HOST: '127.0.0.1',
        ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${aiPort}`,
        ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${aiPort}`,
        ZEPHYR_DATA_DIR: dataDir,
        ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(dataDir, 'crypto', 'key.json'),
        ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
        ENCRYPTION_KEY: BACKUP_ENCRYPTION_KEY,
        ZEPHYR_BACKUP_KEY_PROVENANCE: 'operator-attested-csprng-v1',
        WEBDAV_BACKUP_KEY: crypto.randomBytes(32).toString('base64url'),
        WEBDAV_CREDENTIAL_KEY: crypto.randomBytes(32).toString('base64url'),
        NODE_ENV: 'test',
        ZEPHYR_IMPORT_TEST_FAULTS: fault,
        ZEPHYR_IMPORT_HARD_KILL_STAGE: options.hardKillStage || '',
    };
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output.slice(-3000)}`);
        try {
            const response = await fetch(`${base}/healthz`);
            if (response.ok) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (Date.now() >= deadline) throw new Error(`server startup timeout:\n${output.slice(-3000)}`);

    async function stop() {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await new Promise((resolve) => {
                const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8_000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        if (removeDataOnStop) removeServerDataDir(dataDir);
    }

    async function request(route, { method = 'GET', cookie = '', body, form, headers = {} } = {}) {
        const response = await fetch(`${base}${route}`, {
            method,
            headers: {
                ...(cookie ? { cookie } : {}),
                ...(method === 'GET' ? {} : { origin: base }),
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...headers,
            },
            body: form || (body === undefined ? undefined : JSON.stringify(body)),
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { response, status: response.status, text, json };
    }

    async function login(password) {
        const result = await request('/api/auth/login', {
            method: 'POST',
            body: { username: 'admin', password },
        });
        return {
            ...result,
            cookie: (result.response.headers.get('set-cookie') || '').split(';')[0],
        };
    }

    let initial = { cookie: options.cookie || '' };
    let changed = { json: null };
    if (options.initializeAccount !== false) {
        initial = await login('admin');
        assert.equal(initial.status, 200, initial.text);
        changed = await request('/api/auth/change-password', {
            method: 'POST',
            cookie: initial.cookie,
            body: { currentPassword: 'admin', newPassword: FIRST_PASSWORD },
        });
        assert.equal(changed.status, 200, changed.text);
    }
    return {
        base,
        child,
        dataDir,
        login,
        output: () => output,
        request,
        stop,
        cookie: initial.cookie,
        firstPasswordRollbackUrl: changed.json?.rollbackUrl || '',
    };
}

async function exportBackup(server) {
    const response = await fetch(`${server.base}/api/data/export`, {
        headers: { cookie: server.cookie },
    });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
}

async function importBackup(server, archive, password) {
    const stepUp = await server.request('/api/data/import/grant', {
        method: 'POST',
        cookie: server.cookie,
        body: { password },
    });
    assert.equal(stepUp.status, 200, stepUp.text);
    assert.match(String(stepUp.json?.grant || ''), /^[A-Za-z0-9_-]{43}$/);
    const form = new FormData();
    form.append('backup', new Blob([archive]), 'backup.zip.enc');
    return server.request('/api/data/import', {
        method: 'POST',
        cookie: server.cookie,
        form,
        headers: { 'x-zephyr-backup-import-grant': stepUp.json.grant },
    });
}

async function waitForPathMissing(file, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (fs.existsSync(file) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !fs.existsSync(file);
}

function seedArchivedAuthenticationState(server, {
    email,
    resetCode,
    refreshCredential,
    deviceId,
    deeplinkToken,
    passkeyCredentialId,
}) {
    const db = createDatabase(path.join(server.dataDir, 'zephyr.db'), { forceBuiltin: true });
    try {
        const user = db.prepare('SELECT userId, username FROM users WHERE username = ?').get('admin');
        assert.ok(user?.userId);
        const now = Date.now();
        db.prepare('UPDATE users SET email = ? WHERE username = ?').run(email, 'admin');
        db.prepare(`INSERT INTO password_reset_codes
            (id, username, email, codeHash, expiresAt, used, createdAt, attemptCount, userId)
            SELECT ?, username, ?, ?, ?, 0, ?, 0, userId FROM users WHERE username = ?`).run(
            crypto.randomUUID(),
            email,
            crypto.createHash('sha256').update(resetCode).digest('hex'),
            now + 10 * 60 * 1000,
            now,
            'admin',
        );
        db.prepare(`INSERT INTO mobile_devices
            (device_id, owner_user_id, owner_username_compat, token_id, device_name, platform,
             app_version, encryption_public_key, signing_public_jwk, refresh_token_hash,
             refresh_generation, enabled, automatic_enabled, sync_interval_sec, config_revision,
             registry_hash, last_acked_cursor, last_sync_at, last_seen_at, created_at,
             revoked_at, revoke_reason)
            VALUES (?, ?, ?, 'import-token', 'Archived phone', 'ios', '1', ?, '{}', ?, 7,
                    1, 1, 300, 1, 'archived-registry', 0, NULL, ?, ?, NULL, NULL)`).run(
            deviceId,
            user.userId,
            user.username,
            Buffer.alloc(1184),
            crypto.createHash('sha256').update(refreshCredential).digest('hex'),
            now,
            now,
        );
        db.prepare(`INSERT INTO mobile_device_proof_challenges
            (nonce_hash, owner_user_id, device_id, method, canonical_path, body_sha256,
             usage, proof_timestamp, created_at, expires_at, consumed_at)
            VALUES ('archived-proof', ?, ?, 'POST', '/api/mobile/v1/sync/push', ?,
                    'access', ?, ?, ?, NULL)`).run(
            user.userId,
            deviceId,
            '0'.repeat(64),
            Math.floor(now / 1000),
            now,
            now + 30_000,
        );
        db.prepare(`INSERT INTO mobile_sensitive_grants
            (grant_hash, owner_user_id, action, target_hash, expires_at, consumed_at, created_at, request_id)
            VALUES ('archived-grant', ?, 'device.bind', 'archived-target', ?, NULL, ?, 'archived-request')`).run(
            user.userId,
            now + 30_000,
            now,
        );
        db.prepare(`INSERT INTO passkeys
            (id, username, credentialId, publicKey, counter, transports, createdAt, lastUsedAt, userId)
            VALUES ('archived-passkey', ?, ?, 'archived-public-key', 0, '[]', ?, NULL, ?)`).run(
            user.username,
            passkeyCredentialId,
            now,
            user.userId,
        );
        db.prepare(`INSERT INTO deeplink_tokens
            (token_hash, user_id, source, draft_json, credential_enc, expires_at, consumed_at, created_at)
            VALUES (?, ?, 'ssh', ?, NULL, ?, NULL, ?)`).run(
            crypto.createHash('sha256').update(deeplinkToken).digest('hex'),
            user.userId,
            JSON.stringify({ name: 'Archived deeplink', protocol: 'SSH', host: '127.0.0.1', port: 22 }),
            now + 10 * 60 * 1000,
            now,
        );
    } finally {
        db.close();
    }
}

async function openAuthenticatedSshSocket(server) {
    const ws = new WebSocket(server.base.replace(/^http/, 'ws') + '/ssh', {
        headers: { cookie: server.cookie, origin: server.base },
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authenticated websocket open timed out')), 10_000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return ws;
}

async function openAgentSocket(server, token) {
    const ws = new WebSocket(server.base.replace(/^http/, 'ws') + '/agent/files');
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('agent websocket open timed out')), 10_000);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const acknowledgement = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('agent authentication timed out')), 10_000);
        ws.on('message', (raw) => {
            let message = null;
            try { message = JSON.parse(raw.toString()); } catch {}
            if (message?.type !== 'hello_ack') return;
            clearTimeout(timer);
            resolve(message);
        });
    });
    ws.send(JSON.stringify({
        type: 'hello',
        protocolVersion: 2,
        token,
        deviceId: 'import-agent-device',
        deviceName: 'Import test agent',
        capabilities: { read: true, binaryRead: true },
        share: { name: 'Import test agent', readOnly: true },
    }));
    return { ws, acknowledgement: await acknowledgement };
}

test('import authentication invalidation is all-or-nothing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-auth-state-'));
    const db = createDatabase(path.join(directory, 'state.db'), { forceBuiltin: true });
    try {
        db.exec(`
            CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, revoked_at INTEGER, revoke_reason TEXT);
            CREATE TABLE password_reset_codes (id TEXT PRIMARY KEY, used INTEGER NOT NULL);
            CREATE TABLE password_rollback_tokens (id TEXT PRIMARY KEY, used INTEGER NOT NULL);
            CREATE TABLE mobile_devices (
                device_id TEXT PRIMARY KEY, refresh_token_hash TEXT, refresh_generation INTEGER NOT NULL,
                revoked_at INTEGER, revoke_reason TEXT
            );
            CREATE TABLE mobile_device_proof_challenges (nonce_hash TEXT PRIMARY KEY);
            CREATE TABLE mobile_sensitive_grants (grant_hash TEXT PRIMARY KEY);
            CREATE TABLE passkeys (id TEXT PRIMARY KEY);
            CREATE TABLE deeplink_tokens (
                token_hash TEXT PRIMARY KEY, credential_enc TEXT, consumed_at INTEGER
            );
            CREATE TABLE encrypted_client_tokens (
                id TEXT PRIMARY KEY, secret_ciphertext TEXT NOT NULL, secret_digest BLOB,
                revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            );
            INSERT INTO auth_sessions VALUES ('old-sid', NULL, NULL);
            INSERT INTO password_reset_codes VALUES ('reset', 0);
            INSERT INTO password_rollback_tokens VALUES ('rollback', 0);
            INSERT INTO mobile_devices VALUES ('phone', 'refresh-hash', 3, NULL, NULL);
            INSERT INTO mobile_device_proof_challenges VALUES ('proof');
            INSERT INTO mobile_sensitive_grants VALUES ('grant');
            INSERT INTO passkeys VALUES ('passkey');
            INSERT INTO deeplink_tokens VALUES ('deeplink', 'encrypted-secret', NULL);
            INSERT INTO encrypted_client_tokens VALUES ('client-token', 'encrypted-token', X'0102', 2, 100, NULL);
        `);

        assert.throws(() => invalidateImportedAuthenticationState(db, {
            now: 1234,
            beforeCommit: () => { throw new Error('injected revoke failure'); },
        }), /injected revoke failure/);
        assert.equal(db.prepare('SELECT revoked_at FROM auth_sessions').get().revoked_at, null);
        assert.equal(db.prepare('SELECT used FROM password_reset_codes').get().used, 0);
        assert.equal(db.prepare('SELECT used FROM password_rollback_tokens').get().used, 0);
        assert.deepEqual({ ...db.prepare('SELECT refresh_token_hash, refresh_generation, revoked_at FROM mobile_devices').get() }, {
            refresh_token_hash: 'refresh-hash',
            refresh_generation: 3,
            revoked_at: null,
        });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_device_proof_challenges').get().count, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_sensitive_grants').get().count, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM passkeys').get().count, 1);
        assert.deepEqual({ ...db.prepare('SELECT credential_enc, consumed_at FROM deeplink_tokens').get() }, {
            credential_enc: 'encrypted-secret',
            consumed_at: null,
        });
        assert.deepEqual({ ...db.prepare(`SELECT secret_ciphertext, hex(secret_digest) AS digest,
            revision, updated_at, deleted_at FROM encrypted_client_tokens`).get() }, {
            secret_ciphertext: 'encrypted-token',
            digest: '0102',
            revision: 2,
            updated_at: 100,
            deleted_at: null,
        });

        const changed = invalidateImportedAuthenticationState(db, { now: 5678 });
        assert.deepEqual(changed, {
            sessions: 1,
            resetCodes: 1,
            rollbackTokens: 1,
            mobileDevices: 1,
            proofChallenges: 1,
            sensitiveGrants: 1,
            passkeys: 1,
            deeplinks: 1,
            clientTokens: 1,
        });
        assert.deepEqual({ ...db.prepare('SELECT revoked_at, revoke_reason FROM auth_sessions').get() }, {
            revoked_at: 5678,
            revoke_reason: 'database-import',
        });
        assert.equal(db.prepare('SELECT used FROM password_reset_codes').get().used, 1);
        assert.equal(db.prepare('SELECT used FROM password_rollback_tokens').get().used, 1);
        assert.deepEqual({ ...db.prepare(`SELECT refresh_token_hash, refresh_generation, revoked_at, revoke_reason
            FROM mobile_devices`).get() }, {
            refresh_token_hash: null,
            refresh_generation: 4,
            revoked_at: 5678,
            revoke_reason: 'database-import',
        });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_device_proof_challenges').get().count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mobile_sensitive_grants').get().count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM passkeys').get().count, 0);
        assert.deepEqual({ ...db.prepare('SELECT credential_enc, consumed_at FROM deeplink_tokens').get() }, {
            credential_enc: null,
            consumed_at: 5678,
        });
        assert.deepEqual({ ...db.prepare(`SELECT secret_ciphertext, secret_digest,
            revision, updated_at, deleted_at FROM encrypted_client_tokens`).get() }, {
            secret_ciphertext: '',
            secret_digest: null,
            revision: 3,
            updated_at: 5678,
            deleted_at: 5678,
        });

        const legacyDb = createDatabase(path.join(directory, 'legacy.db'), { forceBuiltin: true });
        try {
            legacyDb.exec(`
                CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, revoked_at INTEGER, revoke_reason TEXT);
                CREATE TABLE password_reset_codes (id TEXT PRIMARY KEY, used INTEGER NOT NULL);
                CREATE TABLE password_rollback_tokens (id TEXT PRIMARY KEY, used INTEGER NOT NULL);
                INSERT INTO auth_sessions VALUES ('legacy-sid', NULL, NULL);
                INSERT INTO password_reset_codes VALUES ('legacy-reset', 0);
                INSERT INTO password_rollback_tokens VALUES ('legacy-rollback', 0);
            `);
            assert.deepEqual(invalidateImportedAuthenticationState(legacyDb, { now: 6789 }), {
                sessions: 1,
                resetCodes: 1,
                rollbackTokens: 1,
                mobileDevices: 0,
                proofChallenges: 0,
                sensitiveGrants: 0,
                passkeys: 0,
                deeplinks: 0,
                clientTokens: 0,
            });
        } finally {
            legacyDb.close();
        }
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('committed import revokes archived auth capabilities and tears down live session runtimes', async () => {
    const server = await startServer('');
    let socket = null;
    let agentSocket = null;
    try {
        const resetEmail = 'import-reset@example.test';
        const resetCode = 'old-import-reset-code';
        const refreshCredential = 'archived-mobile-refresh-credential';
        const deviceId = 'archived-device-1234567890';
        const deeplinkToken = 'archived-deeplink-token';
        const passkeyCredentialId = 'archived-passkey-credential';
        seedArchivedAuthenticationState(server, {
            email: resetEmail,
            resetCode,
            refreshCredential,
            deviceId,
            deeplinkToken,
            passkeyCredentialId,
        });
        const createdClientToken = await server.request('/api/rdp/file-agent-tokens', {
            method: 'POST',
            cookie: server.cookie,
            body: { name: 'Archived client token' },
        });
        assert.equal(createdClientToken.status, 200, createdClientToken.text);
        const clientToken = createdClientToken.json?.token?.token;
        assert.ok(clientToken);
        const agent = await openAgentSocket(server, clientToken);
        agentSocket = agent.ws;
        assert.equal(agent.acknowledgement.ok, true);
        const archive = await exportBackup(server);
        const rollbackToken = new URL(server.firstPasswordRollbackUrl).searchParams.get('token');
        assert.ok(rollbackToken, 'password change must expose the rollback token in this test configuration');

        const changedAgain = await server.request('/api/auth/change-password', {
            method: 'POST',
            cookie: server.cookie,
            body: { currentPassword: FIRST_PASSWORD, newPassword: SECOND_PASSWORD },
        });
        assert.equal(changedAgain.status, 200, changedAgain.text);

        socket = await openAuthenticatedSshSocket(server);
        const socketClosed = new Promise((resolve) => socket.once('close', resolve));
        const agentSocketClosed = new Promise((resolve) => agentSocket.once('close', resolve));
        const imported = await importBackup(server, archive, SECOND_PASSWORD);
        assert.equal(imported.status, 200, imported.text);
        assert.match(imported.response.headers.get('set-cookie') || '', /zephyr_sid=;/);
        await Promise.race([
            socketClosed,
            new Promise((_, reject) => setTimeout(() => reject(new Error('session websocket survived import')), 5_000)),
        ]);
        await Promise.race([
            agentSocketClosed,
            new Promise((_, reject) => setTimeout(() => reject(new Error('authenticated agent survived import')), 5_000)),
        ]);

        const oldSession = await server.request('/api/auth/me', { cookie: server.cookie });
        assert.equal(oldSession.status, 401, 'SID stored in the imported archive must not become live again');
        const rollback = await server.request('/api/auth/password-rollback', {
            method: 'POST',
            body: { token: rollbackToken },
        });
        assert.equal(rollback.status, 400, rollback.text);
        assert.equal(rollback.json?.code, 'rollback_invalid');
        const reset = await server.request('/api/auth/forgot-password/reset', {
            method: 'POST',
            body: { email: resetEmail, code: resetCode, newPassword: 'should-not-apply' },
        });
        assert.equal(reset.status, 400, reset.text);
        const refresh = await server.request('/api/mobile/v1/devices/refresh', {
            method: 'POST',
            body: { deviceId, refreshCredential },
        });
        assert.equal(refresh.status, 403, refresh.text);
        assert.equal(refresh.json?.error?.code, 'client_revoked');
        const relogin = await server.login(FIRST_PASSWORD);
        assert.equal(relogin.status, 200);
        const passkey = await server.request('/api/passkeys/login/options', {
            method: 'POST',
            body: { username: 'admin' },
        });
        assert.equal(passkey.status, 400, passkey.text);
        const deeplink = await server.request(`/api/deeplinks/${deeplinkToken}`, { cookie: relogin.cookie });
        assert.equal(deeplink.status, 410, deeplink.text);
        const replayedAgent = await openAgentSocket(server, clientToken);
        assert.equal(replayedAgent.acknowledgement.ok, false);
        assert.equal(replayedAgent.acknowledgement.error?.code, 'unauthorized');
        try { replayedAgent.ws.terminate(); } catch {}
        assert.notEqual((await server.login('should-not-apply')).status, 200);
    } finally {
        try { socket?.terminate(); } catch {}
        try { agentSocket?.terminate(); } catch {}
        await server.stop();
    }
});

test('authentication-state invalidation failure restores the previous database before reopening', async () => {
    const server = await startServer('import_auth_state_revocation');
    try {
        const archive = await exportBackup(server);
        const changedAgain = await server.request('/api/auth/change-password', {
            method: 'POST',
            cookie: server.cookie,
            body: { currentPassword: FIRST_PASSWORD, newPassword: SECOND_PASSWORD },
        });
        assert.equal(changedAgain.status, 200, changedAgain.text);

        const imported = await importBackup(server, archive, SECOND_PASSWORD);
        assert.equal(imported.status, 400, imported.text);
        assert.match(imported.text, /import_auth_state_revocation/);
        assert.equal((await server.request('/api/auth/me', { cookie: server.cookie })).status, 200);
        assert.equal((await server.login(SECOND_PASSWORD)).status, 200);
        assert.notEqual((await server.login(FIRST_PASSWORD)).status, 200);
    } finally {
        await server.stop();
    }
});

test('a post-install failure restores the old database and rebuilds all runtimes', async () => {
    const server = await startServer('after_database_install');
    try {
        const archive = await exportBackup(server);
        const changedAgain = await server.request('/api/auth/change-password', {
            method: 'POST',
            cookie: server.cookie,
            body: { currentPassword: FIRST_PASSWORD, newPassword: SECOND_PASSWORD },
        });
        assert.equal(changedAgain.status, 200, changedAgain.text);

        const imported = await importBackup(server, archive, SECOND_PASSWORD);
        assert.equal(imported.status, 400, imported.text);
        assert.match(imported.text, /after_database_install/);

        const health = await fetch(`${server.base}/healthz`);
        assert.equal(health.status, 200, server.output());
        assert.equal((await server.login(SECOND_PASSWORD)).status, 200, 'rollback must preserve the newer live password');
        assert.notEqual((await server.login(FIRST_PASSWORD)).status, 200, 'failed candidate must not remain installed');
    } finally {
        await server.stop();
    }
});

test('audit failure cannot turn a committed import into a reported failure', async () => {
    const server = await startServer('activity_audit');
    try {
        const archive = await exportBackup(server);
        const imported = await importBackup(server, archive, FIRST_PASSWORD);
        assert.equal(imported.status, 200, imported.text);
        assert.equal(imported.json?.ok, true);
        assert.match(server.output(), /import committed but audit write failed/);

        const health = await fetch(`${server.base}/healthz`);
        assert.equal(health.status, 200, server.output());
        assert.equal((await server.login(FIRST_PASSWORD)).status, 200);
    } finally {
        await server.stop();
    }
});

test('rollback reconstruction failure terminates the process instead of reopening traffic', async () => {
    const server = await startServer('after_database_install,rollback_reopen');
    try {
        const archive = await exportBackup(server);
        await assert.rejects(importBackup(server, archive, FIRST_PASSWORD));
        const exitCode = server.child.exitCode === null
            ? await new Promise((resolve) => server.child.once('exit', resolve))
            : server.child.exitCode;
        assert.equal(exitCode, 70);
        assert.match(server.output(), /import rollback failed; terminating process/);
    } finally {
        await server.stop();
    }
});

test('a live import retries deferred journal cleanup and releases its exact lease', async () => {
    const server = await startServer('import:journal:finalize:unlinked');
    try {
        const archive = await exportBackup(server);
        const imported = await importBackup(server, archive, FIRST_PASSWORD);
        assert.equal(imported.status, 200, imported.text);
        assert.equal(fs.existsSync(path.join(server.dataDir, JOURNAL_NAME)), false);
        assert.equal(
            await waitForPathMissing(path.join(server.dataDir, CLEANUP_NAME)),
            true,
            'the request cleanup must release the exact lease after retry succeeds',
        );
        assert.equal((await fetch(`${server.base}/healthz`)).status, 200, server.output());
    } finally {
        await server.stop();
    }
});

test('permanent terminal cleanup failure fails closed and startup recovery owns the lease', async () => {
    const dataDir = createServerDataDir('zephyr-import-finalization-fatal-');
    let server = null;
    let restarted = null;
    try {
        server = await startServer('import:sensitive_cleanup:scrubbed', {
            dataDir,
            removeDataOnStop: false,
        });
        const archive = await exportBackup(server);
        await assert.rejects(importBackup(server, archive, FIRST_PASSWORD));
        const exit = await waitForChildExit(server.child, 15_000);
        assert.equal(exit, 70, server.output());
        assert.match(server.output(), /import rollback failed; terminating process/);
        assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), true);
        assert.equal(fs.existsSync(path.join(dataDir, CLEANUP_NAME)), true);

        restarted = await startServer('', {
            dataDir,
            initializeAccount: false,
            removeDataOnStop: true,
        });
        assert.equal((await restarted.login(FIRST_PASSWORD)).status, 200, restarted.output());
        assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), false);
        assert.equal(fs.existsSync(path.join(dataDir, CLEANUP_NAME)), false);
    } finally {
        if (server?.child?.exitCode === null) {
            try { server.child.kill('SIGKILL'); } catch {}
        }
        if (restarted) await restarted.stop();
        else removeServerDataDir(dataDir);
    }
});

async function waitForChildExit(child, timeoutMs = 15_000) {
    if (child.exitCode !== null) return child.exitCode;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hard-killed import process did not exit')), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve(code ?? signal);
        });
    });
}

async function verifyHardKilledImportRecovery(stage, expectedPassword, rejectedPassword) {
    const dataDir = createServerDataDir('zephyr-import-server-crash-');
    let server = null;
    let restarted = null;
    try {
        server = await startServer('', {
            dataDir,
            hardKillStage: stage,
            removeDataOnStop: false,
        });
        const archivedCookie = server.cookie;
        const archive = await exportBackup(server);

        const logout = await server.request('/api/auth/logout', {
            method: 'POST',
            cookie: archivedCookie,
            body: {},
        });
        assert.equal(logout.status, 200, logout.text);
        const current = await server.login(FIRST_PASSWORD);
        assert.equal(current.status, 200, current.text);
        const changedAgain = await server.request('/api/auth/change-password', {
            method: 'POST',
            cookie: current.cookie,
            body: { currentPassword: FIRST_PASSWORD, newPassword: SECOND_PASSWORD },
        });
        assert.equal(changedAgain.status, 200, changedAgain.text);
        const importer = await server.login(SECOND_PASSWORD);
        assert.equal(importer.status, 200, importer.text);
        server.cookie = importer.cookie;

        await assert.rejects(importBackup(server, archive, SECOND_PASSWORD));
        await waitForChildExit(server.child);

        restarted = await startServer('', {
            dataDir,
            initializeAccount: false,
            removeDataOnStop: true,
        });
        const replay = await restarted.request('/api/auth/me', { cookie: archivedCookie });
        assert.equal(replay.status, 401, `${stage}: archived SID replayed after crash recovery`);
        assert.equal((await restarted.login(expectedPassword)).status, 200, restarted.output());
        assert.notEqual((await restarted.login(rejectedPassword)).status, 200, restarted.output());
        assert.equal(fs.existsSync(path.join(dataDir, '.zephyr-import-journal.v1.json')), false);
        assert.deepEqual(
            fs.readdirSync(dataDir).filter((name) => (
                /^\.zephyr-import-/.test(name)
                && name !== '.zephyr-import-journal-auth.v1.key'
            )),
            [],
            `${stage}: restart must finish import cleanup before listening`,
        );
    } finally {
        if (server?.child?.exitCode === null) {
            try { server.child.kill('SIGKILL'); } catch {}
        }
        if (restarted) await restarted.stop();
        else removeServerDataDir(dataDir);
    }
}

test('server restart rolls back a hard kill after the database rename without replaying archived credentials', async () => {
    await verifyHardKilledImportRecovery(
        'install:new:database:renamed',
        SECOND_PASSWORD,
        FIRST_PASSWORD,
    );
});

test('server restart completes a durably committed import without replaying archived credentials', async () => {
    await verifyHardKilledImportRecovery(
        'after_journal_committed',
        FIRST_PASSWORD,
        SECOND_PASSWORD,
    );
});

let crossKeyDonorPromise = null;

function crossKeyDonorArchive() {
    if (crossKeyDonorPromise) return crossKeyDonorPromise;
    crossKeyDonorPromise = (async () => {
        const donor = await startServer('');
        try {
            const credentials = {
                email: 'cross-key-import@example.test',
                resetCode: 'cross-key-reset-code',
                refreshCredential: 'cross-key-mobile-refresh',
                deviceId: 'cross-key-device-1234567890',
                deeplinkToken: 'cross-key-deeplink-token',
                passkeyCredentialId: 'cross-key-passkey-id',
            };
            seedArchivedAuthenticationState(donor, credentials);
            const db = createDatabase(path.join(donor.dataDir, 'zephyr.db'), { forceBuiltin: true });
            try {
                db.prepare(`UPDATE users SET totpEnabled = 1, totpSecret = ? WHERE username = ?`)
                    .run('JBSWY3DPEHPK3PXP', 'admin');
            } finally {
                db.close();
            }
            const clientTokenResponse = await donor.request('/api/rdp/file-agent-tokens', {
                method: 'POST',
                cookie: donor.cookie,
                body: { name: 'Cross-key archived token' },
            });
            assert.equal(clientTokenResponse.status, 200, clientTokenResponse.text);
            const clientToken = clientTokenResponse.json?.token?.token;
            assert.ok(clientToken);
            const connection = await donor.request('/api/connections', {
                method: 'POST',
                cookie: donor.cookie,
                body: {
                    name: 'Cross-key encrypted connection',
                    protocol: 'SSH',
                    host: '127.0.0.1',
                    port: 22,
                    username: 'root',
                    password: 'cross-key-encrypted-password',
                },
            });
            assert.equal(connection.status, 200, connection.text);
            const rollbackToken = new URL(donor.firstPasswordRollbackUrl).searchParams.get('token');
            assert.ok(rollbackToken);
            return {
                archive: await exportBackup(donor),
                archivedCookie: donor.cookie,
                clientToken,
                connectionId: connection.json?.connection?.id,
                credentials,
                donorKeySha256: crypto.createHash('sha256')
                    .update(fs.readFileSync(path.join(donor.dataDir, 'crypto', 'key.json')))
                    .digest('hex'),
                rollbackToken,
            };
        } finally {
            await donor.stop();
        }
    })();
    return crossKeyDonorPromise;
}

async function assertCrossKeyCredentialsRevoked(server, donor, loginCookie) {
    assert.equal((await server.request('/api/auth/me', { cookie: donor.archivedCookie })).status, 401);
    const rollback = await server.request('/api/auth/password-rollback', {
        method: 'POST',
        body: { token: donor.rollbackToken },
    });
    assert.equal(rollback.status, 400, rollback.text);
    const reset = await server.request('/api/auth/forgot-password/reset', {
        method: 'POST',
        body: {
            email: donor.credentials.email,
            code: donor.credentials.resetCode,
            newPassword: 'cross-key-replayed-password',
        },
    });
    assert.equal(reset.status, 400, reset.text);
    const refresh = await server.request('/api/mobile/v1/devices/refresh', {
        method: 'POST',
        body: {
            deviceId: donor.credentials.deviceId,
            refreshCredential: donor.credentials.refreshCredential,
        },
    });
    assert.equal(refresh.status, 403, refresh.text);
    const passkey = await server.request('/api/passkeys/login/options', {
        method: 'POST',
        body: { username: 'admin' },
    });
    assert.equal(passkey.status, 400, passkey.text);
    const deeplink = await server.request(`/api/deeplinks/${donor.credentials.deeplinkToken}`, {
        cookie: loginCookie,
    });
    assert.equal(deeplink.status, 410, deeplink.text);
    const replayedAgent = await openAgentSocket(server, donor.clientToken);
    assert.equal(replayedAgent.acknowledgement.ok, false);
    assert.equal(replayedAgent.acknowledgement.error?.code, 'unauthorized');
    try { replayedAgent.ws.terminate(); } catch {}
    assert.notEqual((await server.login('cross-key-replayed-password')).status, 200);
}

async function verifyCrossKeyHardKill(stage, expectedGeneration) {
    const donor = await crossKeyDonorArchive();
    const dataDir = createServerDataDir('zephyr-import-cross-key-');
    let recipient = null;
    let restarted = null;
    try {
        recipient = await startServer('', {
            dataDir,
            hardKillStage: stage,
            removeDataOnStop: false,
        });
        const current = await recipient.login(FIRST_PASSWORD);
        assert.equal(current.status, 200, current.text);
        const changed = await recipient.request('/api/auth/change-password', {
            method: 'POST',
            cookie: current.cookie,
            body: { currentPassword: FIRST_PASSWORD, newPassword: SECOND_PASSWORD },
        });
        assert.equal(changed.status, 200, changed.text);
        const importer = await recipient.login(SECOND_PASSWORD);
        assert.equal(importer.status, 200, importer.text);
        recipient.cookie = importer.cookie;
        const recipientKeySha256 = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(dataDir, 'crypto', 'key.json')))
            .digest('hex');
        assert.notEqual(recipientKeySha256, donor.donorKeySha256, 'fixture keys must really differ');

        await assert.rejects(importBackup(recipient, donor.archive, SECOND_PASSWORD));
        await waitForChildExit(recipient.child);
        restarted = await startServer('', {
            dataDir,
            initializeAccount: false,
            removeDataOnStop: true,
        });

        const expectedPassword = expectedGeneration === 'new' ? FIRST_PASSWORD : SECOND_PASSWORD;
        const rejectedPassword = expectedGeneration === 'new' ? SECOND_PASSWORD : FIRST_PASSWORD;
        const login = await restarted.login(expectedPassword);
        assert.equal(login.status, 200, `${stage}: ${restarted.output()}`);
        assert.equal(login.json?.requiresTotp, undefined, `${stage}: imported TOTP must be invalidated`);
        assert.notEqual((await restarted.login(rejectedPassword)).status, 200, restarted.output());
        const installedKeySha256 = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(dataDir, 'crypto', 'key.json')))
            .digest('hex');
        assert.equal(
            installedKeySha256,
            expectedGeneration === 'new' ? donor.donorKeySha256 : recipientKeySha256,
            `${stage}: data key and SQLite generation diverged`,
        );

        if (expectedGeneration === 'new') {
            const reveal = await restarted.request(`/api/connections/${donor.connectionId}/open`, {
                method: 'POST',
                cookie: login.cookie,
                body: { purpose: 'reveal', secret: FIRST_PASSWORD },
            });
            assert.equal(reveal.status, 200, `${stage}: ${reveal.text}`);
            assert.equal(reveal.json?.connection?.password, 'cross-key-encrypted-password');
            await assertCrossKeyCredentialsRevoked(restarted, donor, login.cookie);
        } else {
            const connections = await restarted.request('/api/connections', { cookie: login.cookie });
            assert.equal(connections.status, 200, connections.text);
            assert.equal(
                connections.json?.connections?.some((row) => row.id === donor.connectionId),
                false,
                `${stage}: uncommitted donor database became visible`,
            );
            assert.equal((await restarted.request('/api/auth/me', { cookie: donor.archivedCookie })).status, 401);
        }
    } finally {
        if (recipient?.child?.exitCode === null) {
            try { recipient.child.kill('SIGKILL'); } catch {}
        }
        if (restarted) await restarted.stop();
        else removeServerDataDir(dataDir);
    }
}

test('real SQLite and different ML-KEM key recover together across hard-kill commit boundaries', async () => {
    for (const [stage, expectedGeneration] of [
        ['install:new:key:renamed', 'old'],
        ['install:new:key:target_fsynced', 'old'],
        ['install:new:database:renamed', 'old'],
        ['after_journal_committed', 'new'],
    ]) {
        await verifyCrossKeyHardKill(stage, expectedGeneration);
    }
});

function canConnect(port) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        const finish = (value) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(100, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

test('an authenticated journal state downgrade exits before HTTP, HTTPS or AI-host listeners can accept traffic', async () => {
    const dataDir = createServerDataDir('zephyr-import-recovery-fail-');
    let initializer = null;
    let child = null;
    try {
        initializer = await startServer('', {
            dataDir,
            removeDataOnStop: false,
        });
        await initializer.stop();
        initializer = null;
        const databaseFile = path.join(dataDir, 'zephyr.db');
        const candidateFile = path.join(dataDir, 'journal-tamper-candidate.db');
        fs.copyFileSync(databaseFile, candidateFile);
        const transaction = beginImportInstall({
            dataDir,
            databaseFile,
            candidateDatabaseFile: candidateFile,
            keyFile: path.join(dataDir, 'crypto', 'key.json'),
            keyChanged: false,
        });
        installPreparedImport(transaction);
        assert.throws(
            () => commitImportInstall(transaction, {
                faultInjector(stage) {
                    if (stage === 'after_journal_committed') throw new Error('preserve committed journal');
                },
            }),
            /preserve committed journal/,
        );
        const journalFile = path.join(dataDir, '.zephyr-import-journal.v1.json');
        const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
        assert.equal(journal.state, 'COMMITTED');
        journal.state = 'INSTALLED';
        fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

        const listenerPorts = [];
        while (listenerPorts.length < 3) {
            const candidate = await freePort();
            if (!listenerPorts.includes(candidate)) listenerPorts.push(candidate);
        }
        const [httpPort, httpsPort, aiPort] = listenerPorts;
        child = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: {
                ...process.env,
                HTTP_ENABLED: 'true',
                HTTPS_ENABLED: 'true',
                PORT: String(httpPort),
                HTTPS_PORT: String(httpsPort),
                ZEPHYR_BIND_HOST: '127.0.0.1',
                ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${aiPort}`,
                ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${aiPort}`,
                ZEPHYR_DATA_DIR: dataDir,
                ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(dataDir, 'crypto', 'key.json'),
                ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
                ENCRYPTION_KEY: BACKUP_ENCRYPTION_KEY,
                ZEPHYR_BACKUP_KEY_PROVENANCE: 'operator-attested-csprng-v1',
                NODE_ENV: 'test',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const accepted = new Map([[httpPort, false], [httpsPort, false], [aiPort, false]]);
        const probe = setInterval(() => {
            for (const port of accepted.keys()) {
                void canConnect(port).then((open) => {
                    if (open) accepted.set(port, true);
                });
            }
        }, 5);
        const exit = await waitForChildExit(child, 15_000);
        clearInterval(probe);
        await new Promise((resolve) => setTimeout(resolve, 150));
        for (const port of accepted.keys()) {
            if (await canConnect(port)) accepted.set(port, true);
        }
        assert.notEqual(exit, 0, output);
        assert.match(output, /database import journal is invalid|database import journal authentication failed|database_import_recovery_failed/);
        assert.deepEqual([...accepted.values()], [false, false, false], output);
    } finally {
        if (initializer) await initializer.stop();
        if (child?.exitCode === null) {
            try { child.kill('SIGKILL'); } catch {}
        }
        removeServerDataDir(dataDir);
    }
});
