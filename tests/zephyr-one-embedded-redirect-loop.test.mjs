import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function challenge() {
    return crypto.randomBytes(32).toString('hex');
}

async function startCore({ port, dataDir, startupChallenge, embedded = true }) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: REPO,
        env: {
            ...process.env,
            HTTP_ENABLED: 'true',
            HTTPS_ENABLED: 'false',
            PORT: String(port),
            PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
            ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${port + 1000}`,
            ZEPHYR_DATA_DIR: dataDir,
            ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
            ZEPHYR_ONE_EMBEDDED: embedded ? '1' : '0',
            ...(startupChallenge ? { ZEPHYR_ONE_STARTUP_CHALLENGE: startupChallenge } : {}),
            ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN: 'true',
            ENCRYPTION_KEY: 'embedded-redirect-loop-test-key',
            NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early (${child.exitCode}):\n${log.slice(-3000)}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok) return { child, log: () => log };
        } catch {}
        await sleep(200);
    }
    child.kill('SIGKILL');
    throw new Error(`server did not become healthy:\n${log.slice(-3000)}`);
}

async function stopCore(core) {
    if (!core?.child || core.child.exitCode !== null) return;
    core.child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => core.child.once('exit', resolve)),
        sleep(5000).then(() => core.child.kill('SIGKILL')),
    ]);
}

function cookieFrom(response) {
    return (response.headers.get('set-cookie') || '').split(';')[0];
}

test('embedded mode breaks the / -> /app.html -> / redirect loop', { timeout: 180000 }, async () => {
    const fixture = createSecureTestDataDir('zephyr-redirect-loop-');
    const dataDir = fixture.dataDir;
    const port = 40600 + Math.floor(Math.random() * 300);
    const base = `http://127.0.0.1:${port}`;
    let core = null;
    let restarted = null;
    let hosted = null;
    let hostedFixture = null;

    try {
        const firstChallenge = challenge();
        core = await startCore({ port, dataDir, startupChallenge: firstChallenge });

        // Unauthenticated "/" must NOT bounce to /app.html (which would bounce
        // back to "/" forever). It serves the self-repair document instead.
        const root = await fetch(`${base}/`);
        assert.equal(root.status, 200, 'embedded / with no session must serve the recovery document');
        const rootBody = await root.text();
        assert.match(rootBody, /zephyr-one-recovery/, 'recovery document must load the self-repair script');
        assert.match(rootBody, /<p id="msg"><\/p>/, 'recovery document keeps its status node');

        // The auth bounce is still present on the app surface: unauthenticated
        // /app.html redirects home, and home no longer loops back.
        const appBounce = await fetch(`${base}/app.html`, { redirect: 'manual' });
        assert.equal(appBounce.status, 302, 'unauthenticated /app.html must redirect home');
        assert.equal(appBounce.headers.get('location'), '/', 'unauthenticated /app.html must point at /');
        const appBounceFollow = await fetch(`${base}/app.html`);
        assert.equal(appBounceFollow.status, 200, 'following the app.html bounce must terminate at the recovery document');
        assert.match(await appBounceFollow.text(), /zephyr-one-recovery/);

        // The recovery script is served only to the embedded core.
        const script = await fetch(`${base}/zephyr-one-recovery.js`);
        assert.equal(script.status, 200);
        assert.match(await script.text(), /zephyr-one:restart/);

        // A recover request with no live session is refused (no capability re-mint).
        const noSidRecover = await fetch(`${base}/__zephyr_one/recover`, { method: 'POST' });
        assert.equal(noSidRecover.status, 404, 'recover without a live session must be refused');

        // A real bootstrap mint a session, after which "/" bounces into the app
        // and /app.html serves the embedded surface (no loop on the happy path).
        const boot = await fetch(`${base}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': firstChallenge },
        });
        assert.equal(boot.status, 204, 'bootstrap must succeed');
        const cookie = cookieFrom(boot);
        assert.match(cookie, /^zephyr_sid=/);

        const authedRoot = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' });
        assert.equal(authedRoot.status, 302, 'authenticated / must redirect to /app.html');
        assert.equal(authedRoot.headers.get('location'), '/app.html');
        const authedApp = await fetch(`${base}/app.html`, { headers: { cookie } });
        assert.equal(authedApp.status, 200, 'authenticated /app.html must serve the embedded app');

        // Now simulate the WebView-outlives-core case: restart the core. Every
        // persisted session is revoked, so the old cookie must land on the
        // recovery document (not an endless 302 chain).
        await stopCore(core);
        core = null;
        const secondChallenge = challenge();
        restarted = await startCore({ port, dataDir, startupChallenge: secondChallenge });
        const staleRoot = await fetch(`${base}/`, { headers: { cookie } });
        assert.equal(staleRoot.status, 200, 'dead cookie on restarted core must not loop');
        assert.match(await staleRoot.text(), /zephyr-one-recovery/);
        const staleApp = await fetch(`${base}/app.html`, { headers: { cookie }, redirect: 'manual' });
        assert.equal(staleApp.status, 302, 'dead cookie must still bounce /app.html home');
        assert.equal(staleApp.headers.get('location'), '/');
        const staleRecover = await fetch(`${base}/__zephyr_one/recover`, {
            method: 'POST',
            headers: { cookie },
        });
        assert.equal(staleRecover.status, 404, 'a revoked session must not be silently re-minted');
        const staleAppFollow = await fetch(`${base}/app.html`, { headers: { cookie } });
        assert.equal(staleAppFollow.status, 200, 'dead-cookie redirect chain must terminate at recovery');
        assert.match(await staleAppFollow.text(), /zephyr-one-recovery/);

        // The hosted (web) core is untouched: "/" serves the real index page and
        // there is no embedded recovery route at all.
        const hostedPort = port + 500;
        hostedFixture = createSecureTestDataDir('zephyr-redirect-hosted-');
        hosted = await startCore({ port: hostedPort, dataDir: hostedFixture.dataDir, embedded: false });
        const hostedRoot = await fetch(`http://127.0.0.1:${hostedPort}/`);
        assert.equal(hostedRoot.status, 200, 'hosted / must still serve the login/index page');
        assert.doesNotMatch(await hostedRoot.text(), /zephyr-one-recovery/, 'hosted core must not serve the recovery document');
        const hostedRecover = await fetch(`http://127.0.0.1:${hostedPort}/__zephyr_one/recover`, { method: 'POST' });
        assert.equal(hostedRecover.status, 404, 'hosted core must not expose the embedded recover route');
        // The SPA catch-all answers unknown GETs with the index page, so assert
        // on content: the embedded recovery script must never reach a hosted core.
        const hostedScript = await fetch(`http://127.0.0.1:${hostedPort}/zephyr-one-recovery.js`);
        assert.doesNotMatch(await hostedScript.text(), /zephyr-one:restart/, 'hosted core must not serve the embedded recovery script');
    } finally {
        await stopCore(core);
        await stopCore(restarted);
        await stopCore(hosted);
        try { removeSecureTestDataDir(fixture); } catch {}
        try { removeSecureTestDataDir(hostedFixture); } catch {}
    }
});
