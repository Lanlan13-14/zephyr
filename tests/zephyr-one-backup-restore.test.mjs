import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import backupModule from '../backup-encryption.js';
import archiveModule from '../backup-archive.js';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

/**
 * Backup / restore must stay usable inside Zephyr One.
 *
 * PRODUCT_REQUIREMENTS.md §3 lists 备份恢复 as a capability One must ship and
 * adds: "服务器设置和备份恢复保留；不能因为它们由主端执行就擅自从 One 移除."
 * The embed CSS used to hide the `data` settings tab, which removed it.
 *
 * A static CSS assertion only proves the tab is visible. It cannot prove the
 * endpoints behind it work, and they have a real reason to fail in One: the
 * session is auto-adopted (the user never types a password), while
 * POST /api/data/import/grant demands requireSuperAdmin *and* verifies the
 * login password before minting the short-lived import authorization. This
 * boots the real server with ZEPHYR_ONE_EMBEDDED=1 and exercises both phases.
 *
 * §8 requires sensitive operations to re-verify the password, so a wrong
 * password must still be rejected — that rejection is a feature, not a bug,
 * and is asserted here so nobody "fixes" it away.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const ADMIN_PASSWORD = 'one-backup-e2e-pass';
const BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64url');
const { CURRENT_MAGIC, encryptBackup } = backupModule;
const { createBackupArchiveBuffer } = archiveModule;

let tmpDir;
let dataFixture;
let child = null;
let base;
let embeddedCookie = '';
const startupChallenge = crypto.randomBytes(32).toString('hex');
/* Same derivation session-restart.test.mjs uses. TestServer's own allocator
 * collides under the parallel default suite; a private high port plus a random
 * offset keeps this file independent of it. */
let port = 39600 + Math.floor(Math.random() * 300);
let aiHostPort = port + 1000;

function startEmbeddedServer() {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            HTTP_ENABLED: 'true',
            HTTPS_ENABLED: 'false',
            PORT: String(port),
            ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${aiHostPort}`,
            ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${aiHostPort}`,
            ZEPHYR_DATA_DIR: tmpDir,
            ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(tmpDir, 'crypto', 'key.json'),
            ENCRYPTION_KEY: BACKUP_ENCRYPTION_KEY,
            ZEPHYR_BACKUP_KEY_PROVENANCE: 'operator-attested-csprng-v1',
            NODE_ENV: 'production',
            // The whole point: Zephyr One's embedded surface.
            ZEPHYR_ONE_EMBEDDED: '1',
            ZEPHYR_ONE_STARTUP_CHALLENGE: startupChallenge,
            ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
        };
        const proc = spawn(process.execPath, ['server.js'], {
            cwd: REPO,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        proc.stdout.on('data', (d) => { log += d; });
        proc.stderr.on('data', (d) => { log += d; });
        proc._log = () => log;
        const deadline = Date.now() + 45000;
        const poll = async () => {
            if (proc.exitCode !== null) {
                return reject(new Error(`server exited early (${proc.exitCode}):\n${log.slice(-2000)}`));
            }
            try {
                const r = await fetch(`http://127.0.0.1:${port}/healthz`);
                if (r.ok) return resolve(proc);
            } catch {}
            if (Date.now() > deadline) {
                try { proc.kill('SIGKILL'); } catch {}
                return reject(new Error(`server did not become healthy:\n${log.slice(-3000)}`));
            }
            setTimeout(poll, 300);
        };
        poll();
    });
}

async function stopServer(proc) {
    if (!proc || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; resolve(); }, 8000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
}

async function issueImportGrant(password) {
    const res = await fetch(`${base}/api/data/import/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: embeddedCookie, origin: base },
        body: JSON.stringify({ password }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(String(body.grant || ''), /^[A-Za-z0-9_-]{43}$/);
    return body.grant;
}

before(async () => {
    dataFixture = createSecureTestDataDir('zephyr-one-backup-');
    tmpDir = dataFixture.dataDir;
    child = await startEmbeddedServer();
    base = `http://127.0.0.1:${port}`;

    /* The auto-adopted session is cookie-less, but import verifies the login
     * password, so the account needs a known one. First login forces rotation;
     * do that through the normal API rather than touching the DB. */
    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(login.status, 200, 'default admin login should succeed on a fresh data dir');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const rotate = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: base },
        body: JSON.stringify({ currentPassword: 'admin', newPassword: ADMIN_PASSWORD }),
    });
    assert.equal(rotate.status, 200, 'first-login password rotation should succeed');

    const bootstrap = await fetch(`${base}/__zephyr_one/bootstrap`, {
        method: 'POST',
        headers: { 'x-zephyr-one-bootstrap-challenge': startupChallenge },
        redirect: 'manual',
    });
    assert.equal(bootstrap.status, 204, 'the desktop bootstrap exchange should succeed');
    embeddedCookie = (bootstrap.headers.get('set-cookie') || '').split(';')[0];
    assert.match(embeddedCookie, /^zephyr_sid=/);
});

after(async () => {
    await stopServer(child);
    if (dataFixture) removeSecureTestDataDir(dataFixture);
});

test('only the bootstrapped One session is a superadmin', async () => {
    const anonymous = await fetch(`${base}/api/auth/me`);
    assert.equal(anonymous.status, 401, 'embedded mode must reject a request without its cookie');
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: embeddedCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user?.isSuperAdmin, true,
        'export/import sit behind requireSuperAdmin; a non-superadmin adoption would 403 both buttons');
});

test('export produces a real encrypted archive for the bootstrapped session', async () => {
    const res = await fetch(`${base}/api/data/export`, { headers: { cookie: embeddedCookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=".*\.zip\.enc"/,
        'the browser needs a filename to save the backup under');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000, `archive looks empty (${buf.length} bytes)`);
    assert.equal(buf.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC), true,
        'new database exports must use the salted ZEPHYR4 envelope');
});

test('import step-up rejects a wrong password before any multipart upload', async () => {
    const res = await fetch(`${base}/api/data/import/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: embeddedCookie, origin: base },
        body: JSON.stringify({ password: 'definitely-not-the-password' }),
    });
    const body = await res.json();
    assert.equal(res.status, 403,
        'One has no local password wall, but restoring data still must re-verify the Zephyr password');
    assert.equal(body.code, 'backup_import_step_up_failed');
});

test('import accepts the correct password and the core survives the reload', async () => {
    const archive = Buffer.from(await (await fetch(`${base}/api/data/export`, {
        headers: { cookie: embeddedCookie },
    })).arrayBuffer());
    const form = new FormData();
    form.append('backup', new Blob([archive]), 'backup.zip.enc');
    const grant = await issueImportGrant(ADMIN_PASSWORD);
    const res = await fetch(`${base}/api/data/import`, {
        method: 'POST',
        headers: { cookie: embeddedCookie, origin: base, 'x-zephyr-backup-import-grant': grant },
        body: form,
    });
    assert.equal(res.status, 200, await res.text());
    const postImportCookie = (res.headers.get('set-cookie') || '').split(';')[0];
    assert.match(postImportCookie, /^zephyr_sid=/);
    assert.notEqual(postImportCookie, embeddedCookie, 'imported and pre-import SIDs must never be reused');
    embeddedCookie = postImportCookie;

    /* Import closes and reopens the SQLite handle. If that throws, the process
     * dies and One shows "Failed to fetch" — the exact class of crash that
     * change-password had. Prove the server is still answering. */
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, 'core must survive the storage reload that import performs');
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: embeddedCookie } });
    assert.equal(me.status, 200, 'One must receive a fresh post-import session after the data reload');
});

test('import rejects a wrong backup password without exposing crypto internals', async () => {
    const archive = Buffer.from(await (await fetch(`${base}/api/data/export`, {
        headers: { cookie: embeddedCookie },
    })).arrayBuffer());
    const form = new FormData();
    form.append('backup', new Blob([archive]), 'backup.zip.enc');
    form.append('backupPassword', crypto.randomBytes(32).toString('base64url'));
    const grant = await issueImportGrant(ADMIN_PASSWORD);
    const res = await fetch(`${base}/api/data/import`, {
        method: 'POST',
        headers: { cookie: embeddedCookie, origin: base, 'x-zephyr-backup-import-grant': grant },
        body: form,
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'backup_authentication_failed');
    assert.doesNotMatch(String(body.error || ''), /openssl|decipher|bad decrypt/i);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('a corrupt database import rolls back without losing the live core or session', async () => {
    const zip = await createBackupArchiveBuffer({
        database: Buffer.from('not-a-sqlite-database'),
        metadata: { app: 'Zephyr', version: 'invalid-test-fixture' },
    });
    const form = new FormData();
    form.append('backup', new Blob([encryptBackup(zip, BACKUP_ENCRYPTION_KEY)]), 'corrupt.zip.enc');
    const grant = await issueImportGrant(ADMIN_PASSWORD);

    const res = await fetch(`${base}/api/data/import`, {
        method: 'POST',
        headers: { cookie: embeddedCookie, origin: base, 'x-zephyr-backup-import-grant': grant },
        body: form,
    });
    assert.equal(res.status, 400, 'invalid SQLite must fail as a controlled import error');

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, 'core must reopen the pre-import database after rollback');
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: embeddedCookie } });
    assert.equal(me.status, 200, 'the pre-import session must survive rollback');
});
