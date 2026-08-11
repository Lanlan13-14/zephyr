import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

/* Stage 1 acceptance (FREEZE plan §4.7): after a Node process restart, a valid
 * cookie must keep working for both plain API calls and /ssh upgrade auth.
 * Boots the real server twice against the same data dir. */

const REPO = path.resolve(import.meta.dirname, '..');
let tmpDir;
let dataFixture;
let child = null;
let port = 39100 + Math.floor(Math.random() * 500);
let aiHostPort = port + 1000;

function startServer() {
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
            ENCRYPTION_KEY: 'session-restart-test-key',
            NODE_ENV: 'production',
        };
        const proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        proc.stdout.on('data', (d) => { log += d; });
        proc.stderr.on('data', (d) => { log += d; });
        const deadline = Date.now() + 45000;
        const poll = async () => {
            if (proc.exitCode !== null) return reject(new Error(`server exited early (${proc.exitCode}):\n${log.slice(-2000)}`));
            try {
                const r = await fetch(`http://127.0.0.1:${port}/healthz`);
                if (r.ok) {
                    const body = await r.json();
                    proc._instanceId = body.instanceId;
                    return resolve(proc);
                }
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

function cookieFrom(res) {
    const raw = res.headers.get('set-cookie') || '';
    const m = raw.match(/zephyr_sid=([^;]+)/);
    return m ? `zephyr_sid=${m[1]}` : '';
}

before(async () => {
    dataFixture = createSecureTestDataDir('zephyr-srv-restart-');
    tmpDir = dataFixture.dataDir;
});

after(async () => {
    await stopServer(child);
    removeSecureTestDataDir(dataFixture);
});

test('login → restart → same cookie still authenticated; instanceId changes', async (t) => {
    child = await startServer();
    const firstInstance = child._instanceId;
    assert.ok(firstInstance, 'healthz reports instanceId');

    // default admin/admin; default-password change is required before other APIs
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(loginRes.status, 200, `login failed: ${await loginRes.text()}`);
    const cookie = cookieFrom(loginRes);
    assert.ok(cookie, 'session cookie issued');

    const pwRes = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ currentPassword: 'admin', newPassword: 'restart-test-pass-1' }),
    });
    assert.equal(pwRes.status, 200, `change-password failed: ${await pwRes.text()}`);

    const me1 = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { cookie } });
    assert.equal(me1.status, 200);
    const me1Body = await me1.json();
    assert.ok(me1Body.user.userId, 'me returns immutable userId');
    assert.equal(me1Body.user.role, 'admin');

    // — simulate service restart: kill the process, boot a fresh one, same data dir —
    await stopServer(child);
    port += 1;
    child = await startServer();
    const secondInstance = child._instanceId;
    assert.notEqual(secondInstance, firstInstance, 'restart must produce a new instanceId');

    const me2 = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { cookie } });
    assert.equal(me2.status, 200, 'valid cookie must survive a process restart (persistent sessions)');
    const me2Body = await me2.json();
    assert.equal(me2Body.user.userId, me1Body.user.userId, 'identity is stable across restart');

    // session listing works after restart
    const sessionsRes = await fetch(`http://127.0.0.1:${port}/api/me/sessions`, { headers: { cookie } });
    assert.equal(sessionsRes.status, 200);
    const { sessions } = await sessionsRes.json();
    assert.ok(sessions.length >= 1, 'at least the current session is listed');
    assert.ok(sessions.some((s) => s.current), 'current session is marked');

    // a second login, then revoking it must not kill the first session
    const login2 = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'restart-test-pass-1' }),
    });
    const cookie2 = cookieFrom(login2);
    assert.ok(cookie2);
    const list2 = await (await fetch(`http://127.0.0.1:${port}/api/me/sessions`, { headers: { cookie } })).json();
    const other = list2.sessions.find((s) => !s.current);
    assert.ok(other, 'second session visible');
    const del = await fetch(`http://127.0.0.1:${port}/api/me/sessions/${other.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(del.status, 200);
    const me3 = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { cookie: cookie2 } });
    assert.equal(me3.status, 401, 'revoked session is rejected');
    const me4 = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { cookie } });
    assert.equal(me4.status, 200, 'other sessions are unaffected by targeted revoke');

    // logout revokes persistently (verify across another restart)
    const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    await stopServer(child);
    port += 1;
    child = await startServer();
    const me5 = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { cookie } });
    assert.equal(me5.status, 401, 'logout revocation survives restart');
});
