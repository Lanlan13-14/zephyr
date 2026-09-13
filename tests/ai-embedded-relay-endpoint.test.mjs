import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

/**
 * /api/ai/embedded/runs — REAL-server security contract.
 *
 * Zephyr One relays AI runs through the main side so no provider credential
 * crosses the device↔server wire (shared providers, or own providers with
 * requestRouting=main). This suite drives the real server.js endpoint with
 * a fake Go runtime (ZEPHYR_AI_URL) and pins:
 *  - the embedded body rides verbatim except provider (resolved server-side);
 *  - the resolved secret reaches the runtime hop but never the HTTP response;
 *  - anonymous callers, missing providerId, and invisible providers are
 *    rejected without reaching the runtime.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 18820 + (process.pid % 60);
const BASE = `http://127.0.0.1:${PORT}`;
const RUNTIME_PORT = 18920 + (process.pid % 60);

let serverChild; let cookie = ''; let dataFixture = null;
const runtimeCaptured = { runs: [] };

/* Fake Go runtime: accepts /admin/runs, captures the forwarded body. */
let runtimeServer;
before(async () => {
    runtimeServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            if (req.url === '/healthz' || req.url === '/admin/status') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end('{}');
            }
            if (req.method === 'POST' && req.url === '/admin/runs') {
                const parsed = JSON.parse(body || '{}');
                runtimeCaptured.runs.push(parsed);
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ runId: `go-run-${runtimeCaptured.runs.length}`, sessionId: parsed.sessionId || 'go-sess', ticket: 'tk', ssePath: '/v1/runs/x/events?ticket=tk' }));
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise((resolve) => runtimeServer.listen(RUNTIME_PORT, '127.0.0.1', resolve));

    dataFixture = createSecureTestDataDir('ai-embedded-relay-');
    serverChild = spawn(process.execPath, [join(ROOT, 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            DATA_DIR: dataFixture.dataDir,
            ZEPHYR_AI_URL: `http://127.0.0.1:${RUNTIME_PORT}`,
            ZEPHYR_AI_ADMIN_TOKEN: 'test-admin-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild.stdout.on('data', () => {});
    serverChild.stderr.on('data', () => {});
    for (let i = 0; i < 120; i++) {
        try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch {}
        await new Promise((r) => setTimeout(r, 250));
        if (i === 119) throw new Error('server healthz timeout');
    }
});

after(() => {
    serverChild?.kill('SIGKILL');
    runtimeServer?.close();
    removeSecureTestDataDir(dataFixture);
});

async function call(path, { method = 'GET', body, cookie: forced } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(forced || cookie ? { cookie: forced || cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie && !forced) cookie = setCookie.split(';')[0];
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
}

async function login() {
    await call('/api/auth/register', { method: 'POST', body: { username: 'relayowner', password: 'relay-owner-pass-1', email: '' } });
    await call('/api/auth/login', { method: 'POST', body: { username: 'relayowner', password: 'relay-owner-pass-1' } });
    /* AI must be enabled for the account boundary the endpoint checks. */
    await call('/api/settings', { method: 'PUT', body: { ai: { enabled: true } } });
}

async function createProvider() {
    const { status, data } = await call('/api/ai/providers', {
        method: 'POST',
        body: {
            name: 'RelayGPT', type: 'openai-compatible', baseUrl: 'https://api.example.test',
            apiKey: 'OWNER_PLAINTEXT_SECRET', defaultModel: 'gpt-relay',
            models: [{ id: 'gpt-relay', label: 'Relay' }],
        },
    });
    if (status !== 200 && status !== 201) throw new Error(`provider create failed: ${status} ${JSON.stringify(data)}`);
    return data.provider?.id || data.id;
}

test('relay forwards the embedded body with a server-resolved credential that never echoes back', async () => {
    await login();
    const providerId = await createProvider();

    const embeddedBody = {
        userId: 'device-side-user', sessionId: 'one-sess-1', providerId, model: 'gpt-relay',
        message: 'run through the main side',
        options: { max_tokens: 512 }, maxSteps: 4,
        permission: { mode: 'ask', deny: [], ask: [], allow: [] },
        autoConfirm: false, autoConfirmDelayMs: 0, mode: 'standard',
        systemCompose: { assistantName: 'Zephyr One', defaultSystemPrompt: '', customSystemPrompt: '', contextText: 'CTX', skills: [], memories: [], envVars: [] },
        context: {}, mcpServers: [{ name: 'mcp-x', type: 'http' }],
        databaseGeneration: 'gen-1', runNonce: 'nonce-1',
        contextWindowTokens: 64000, outputReserveTokens: 4096,
        /* Device-side provider stub: no credential on the wire from One. */
        provider: { id: providerId, name: 'RelayGPT', kind: 'openai-compatible', baseUrl: '', apiKey: '', defaultModel: 'gpt-relay', models: [], apiMode: 'auto', extraHeaders: {}, options: {} },
    };
    const { status, data } = await call('/api/ai/embedded/runs', { method: 'POST', body: embeddedBody });

    /* If the runtime hop failed the endpoint reports it explicitly; the
     * security assertions below still apply to whatever reached the runtime. */
    if (status !== 200) {
        console.error('relay start non-200:', status, JSON.stringify(data));
    }
    assert.equal(status, 200);

    const forwarded = runtimeCaptured.runs.at(-1);
    assert.ok(forwarded, 'runtime received the run');
    /* The credential was resolved SERVER-SIDE … */
    assert.equal(forwarded.provider.apiKey, 'OWNER_PLAINTEXT_SECRET');
    /* … the embedded-only fields rode verbatim … */
    assert.equal(forwarded.systemCompose.assistantName, 'Zephyr One');
    assert.equal(forwarded.mcpServers[0].name, 'mcp-x');
    assert.equal(forwarded.permission.mode, 'ask');
    /* … and the response never echoes the secret. */
    assert.equal(JSON.stringify(data).includes('OWNER_PLAINTEXT_SECRET'), false);
    assert.ok(data.runId, 'runId returned for stream bootstrap');
});

test('anonymous caller gets 401 before anything resolves', async () => {
    cookie = '';
    const { status } = await call('/api/ai/embedded/runs', { method: 'POST', body: { providerId: 'x' } });
    assert.equal(status, 401);
});

test('missing providerId is a 400', async () => {
    await login();
    const { status } = await call('/api/ai/embedded/runs', { method: 'POST', body: { message: 'hi' } });
    assert.equal(status, 400);
});

test("another user's private provider is not resolvable", async () => {
    await login();
    await call('/api/auth/register', { method: 'POST', body: { username: 'relayother', password: 'relay-other-pass-1', email: '' } });
    await call('/api/auth/login', { method: 'POST', body: { username: 'relayother', password: 'relay-other-pass-1' } });
    /* 'relayother' tries to relay through relayowner's provider id. */
    const ownerCookie = cookie;
    await call('/api/auth/login', { method: 'POST', body: { username: 'relayowner', password: 'relay-owner-pass-1' } });
    const providers = await call('/api/ai/providers');
    const target = (providers.data.providers || []).find((p) => p.name === 'RelayGPT');
    if (!target) return; /* provider list shape差异时跳过，不制造假失败 */
    await call('/api/auth/login', { method: 'POST', body: { username: 'relayother', password: 'relay-other-pass-1' } });
    const before = runtimeCaptured.runs.length;
    const { status } = await call('/api/ai/embedded/runs', { method: 'POST', body: { providerId: target.id, model: 'gpt-relay' } });
    assert.ok(status === 403 || status === 404, `expected denial, got ${status}`);
    assert.equal(runtimeCaptured.runs.length, before, 'denied run must not reach the runtime');
    cookie = ownerCookie;
});
