import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * POST /api/data/import demands requireSuperAdmin *and* verifies the login
 * password. So this boots the real server with ZEPHYR_ONE_EMBEDDED=1 and
 * exercises both endpoints end to end.
 *
 * §8 requires sensitive operations to re-verify the password, so a wrong
 * password must still be rejected — that rejection is a feature, not a bug,
 * and is asserted here so nobody "fixes" it away.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const ADMIN_PASSWORD = 'one-backup-e2e-pass';

let tmpDir;
let child = null;
let base;
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
            ENCRYPTION_KEY: 'one-backup-restore-test-key',
            NODE_ENV: 'production',
            // The whole point: Zephyr One's embedded surface.
            ZEPHYR_ONE_EMBEDDED: '1',
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

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-backup-'));
    child = await startEmbeddedServer();
    base = `http://127.0.0.1:${port}`;

    /* The auto-adopted session is cookie-less, but import verifies the login
     * password, so the account needs a known one. First login forces rotation;
     * do that through the normal API rather than touching the DB. */
    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(login.status, 200, 'default admin login should succeed on a fresh data dir');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const rotate = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ currentPassword: 'admin', newPassword: ADMIN_PASSWORD }),
    });
    assert.equal(rotate.status, 200, 'first-login password rotation should succeed');
});

after(async () => {
    await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the auto-adopted One session is a superadmin, so requireSuperAdmin passes', async () => {
    // No cookie at all: this is exactly what the WebView sends on first paint.
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200, 'embedded mode must adopt a session without a cookie');
    const body = await res.json();
    assert.equal(body.user?.isSuperAdmin, true,
        'export/import sit behind requireSuperAdmin; a non-superadmin adoption would 403 both buttons');
});

test('export produces a real encrypted archive without any cookie', async () => {
    const res = await fetch(`${base}/api/data/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=".*\.zip\.enc"/,
        'the browser needs a filename to save the backup under');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000, `archive looks empty (${buf.length} bytes)`);
});

test('import rejects a wrong password — §8 sensitive-operation gate stays', async () => {
    const archive = Buffer.from(await (await fetch(`${base}/api/data/export`)).arrayBuffer());
    const form = new FormData();
    // multer is configured as upload.single('backup'); any other field name is
    // rejected with LIMIT_UNEXPECTED_FILE before the handler ever runs.
    form.append('backup', new Blob([archive]), 'backup.zip.enc');
    form.append('loginPassword', 'definitely-not-the-password');
    const res = await fetch(`${base}/api/data/import`, { method: 'POST', body: form });
    assert.equal(res.status, 403,
        'One has no local password wall, but restoring data still must re-verify the Zephyr password');
});

test('import accepts the correct password and the core survives the reload', async () => {
    const archive = Buffer.from(await (await fetch(`${base}/api/data/export`)).arrayBuffer());
    const form = new FormData();
    form.append('backup', new Blob([archive]), 'backup.zip.enc');
    form.append('loginPassword', ADMIN_PASSWORD);
    const res = await fetch(`${base}/api/data/import`, { method: 'POST', body: form });
    assert.equal(res.status, 200, await res.text());

    /* Import closes and reopens the SQLite handle. If that throws, the process
     * dies and One shows "Failed to fetch" — the exact class of crash that
     * change-password had. Prove the server is still answering. */
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, 'core must survive the storage reload that import performs');
    const me = await fetch(`${base}/api/auth/me`);
    assert.equal(me.status, 200, 'session adoption must still work after the data reload');
});
