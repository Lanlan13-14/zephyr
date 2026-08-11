import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function challenge() {
    return crypto.randomBytes(32).toString('hex');
}

function readinessProof(startupChallenge, probe, port) {
    return crypto.createHmac('sha256', Buffer.from(startupChallenge, 'hex'))
        .update(Buffer.from('zephyr-one-ready-v1\0', 'utf8'))
        .update(Buffer.from(probe, 'hex'))
        .update('\0', 'utf8')
        .update(String(port), 'utf8')
        .digest('hex');
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
            ENCRYPTION_KEY: 'embedded-bootstrap-auth-test-key',
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
            const response = await fetch(`http://127.0.0.1:${port}/healthz`);
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

function requestWithHost(port, requestPath, host) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method: 'GET',
            headers: { Host: host },
        }, (response) => {
            response.resume();
            response.on('end', () => resolve(response));
        });
        request.on('error', reject);
        request.end();
    });
}

function requestUpgrade(port, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
                ...headers,
            },
        });
        request.on('response', (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('upgrade', (_response, socket) => {
            socket.destroy();
            resolve(101);
        });
        request.on('error', reject);
        request.end();
    });
}

test('embedded loopback requires a one-time bootstrap capability', { timeout: 180000 }, async () => {
    const dataFixture = createSecureTestDataDir('zephyr-bootstrap-auth-');
    const dataDir = dataFixture.dataDir;
    const port = 40200 + Math.floor(Math.random() * 300);
    const firstChallenge = challenge();
    let core = null;
    let restarted = null;
    let hosted = null;
    let hostedDataDir = '';
    let hostedDataFixture = null;

    try {
        core = await startCore({ port, dataDir, startupChallenge: firstChallenge });
        const base = `http://127.0.0.1:${port}`;

        const probe = challenge();
        const ready = await fetch(`${base}/healthz`, {
            headers: { 'x-zephyr-one-ready-probe': probe },
        });
        assert.equal(ready.status, 200);
        assert.equal(
            ready.headers.get('x-zephyr-one-ready-proof'),
            readinessProof(firstChallenge, probe, port),
            'readiness must prove possession of the process-local challenge',
        );
        assert.equal(core.log().includes(firstChallenge), false, 'the challenge must not enter logs');

        const rebound = await requestWithHost(port, '/healthz', `attacker.invalid:${port}`);
        assert.equal(rebound.statusCode, 421, 'DNS-rebinding Host values must be rejected');

        const anonymousMe = await fetch(`${base}/api/auth/me`);
        assert.equal(anonymousMe.status, 401, 'loopback reachability must not adopt a session');
        const anonymousExport = await fetch(`${base}/api/data/export`);
        assert.equal(anonymousExport.status, 401, 'data GET requires the bootstrap cookie');
        const anonymousReveal = await fetch(`${base}/api/proxies/missing/open`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(anonymousReveal.status, 403, 'a raw no-Origin reveal must fail CSRF validation');

        const wrong = await fetch(`${base}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': challenge() },
        });
        assert.equal(wrong.status, 403);
        assert.match(wrong.headers.get('cache-control') || '', /no-store/);
        assert.equal(wrong.headers.get('referrer-policy'), 'no-referrer');

        const attempts = await Promise.all([
            fetch(`${base}/__zephyr_one/bootstrap`, {
                method: 'POST',
                headers: { 'x-zephyr-one-bootstrap-challenge': firstChallenge },
            }),
            fetch(`${base}/__zephyr_one/bootstrap`, {
                method: 'POST',
                headers: { 'x-zephyr-one-bootstrap-challenge': firstChallenge },
            }),
        ]);
        assert.deepEqual(attempts.map((response) => response.status).sort(), [204, 403],
            'the challenge must have exactly one winner under concurrent exchange');
        const winner = attempts.find((response) => response.status === 204);
        const cookieHeader = winner.headers.get('set-cookie') || '';
        const cookie = cookieHeader.split(';')[0];
        assert.match(cookieHeader, /HttpOnly/i);
        assert.match(cookieHeader, /SameSite=Strict/i);
        assert.equal(winner.headers.get('location'), null,
            'native bootstrap must not navigate through a capability URL');
        assert.match(winner.headers.get('cache-control') || '', /no-store/);
        assert.equal(winner.headers.get('referrer-policy'), 'no-referrer');

        const replay = await fetch(`${base}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': firstChallenge },
        });
        assert.equal(replay.status, 403, 'a consumed challenge must not be replayable');
        const authenticated = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
        assert.equal(authenticated.status, 200, 'the exchanged Strict cookie must start the WebView session');
        const embeddedRdpProxy = await requestUpgrade(port, '/rdp-proxy?target=127.0.0.1%3A3389', {
            cookie,
            origin: base,
        });
        assert.equal(embeddedRdpProxy, 404,
            'embedded mode must never expose the browser/WASM RDP proxy fallback');
        const cookieWithoutOrigin = await fetch(`${base}/api/proxies/missing/open`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(cookieWithoutOrigin.status, 403, 'a session cookie does not replace an Origin proof');

        await stopCore(core);
        core = null;
        const secondChallenge = challenge();
        restarted = await startCore({ port, dataDir, startupChallenge: secondChallenge });
        const staleAfterRestart = await fetch(`${base}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': firstChallenge },
        });
        assert.equal(staleAfterRestart.status, 403, 'a previous core challenge must die with that process');
        const staleSessionAfterRestart = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
        assert.equal(staleSessionAfterRestart.status, 401,
            'a persisted WebView cookie must not bypass OS unlock after a core restart');
        const freshAfterRestart = await fetch(`${base}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': secondChallenge },
        });
        assert.equal(freshAfterRestart.status, 204, 'a restarted core accepts only its fresh challenge');

        const hostedPort = port + 500;
        hostedDataFixture = createSecureTestDataDir('zephyr-hosted-auth-');
        hostedDataDir = hostedDataFixture.dataDir;
        hosted = await startCore({
            port: hostedPort,
            dataDir: hostedDataDir,
            embedded: false,
        });
        const hostedLogin = await fetch(`http://127.0.0.1:${hostedPort}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin' }),
        });
        assert.notEqual(hostedLogin.status, 403,
            'hosted clients retain the existing no-Origin compatibility behavior');
        const hostedRdpProxy = await requestUpgrade(
            hostedPort,
            '/rdp-proxy?target=127.0.0.1%3A3389',
        );
        assert.equal(hostedRdpProxy, 401,
            'hosted mode must retain the RDP proxy and reach its existing session gate');
    } finally {
        await stopCore(core);
        await stopCore(restarted);
        await stopCore(hosted);
        try { removeSecureTestDataDir(dataFixture); } catch {}
        try { removeSecureTestDataDir(hostedDataFixture); } catch {}
    }
});
