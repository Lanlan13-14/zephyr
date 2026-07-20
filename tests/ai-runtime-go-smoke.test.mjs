import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const AI_DIR = join(ROOT, 'zephyr-ai');
const BIN = join(tmpdir(), `zephyr-ai-smoke-${process.pid}`);
const DATA = mkdtempSync(join(tmpdir(), 'zephyr-ai-data-'));
const PORT = 18450 + (process.pid % 100);
const LISTEN = `127.0.0.1:${PORT}`;
const TOKEN = 'smoke-token';

let child;

async function waitHealth(ms = 8000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        try {
            const r = await fetch(`http://${LISTEN}/healthz`);
            if (r.ok) return r.json();
        } catch {}
        await sleep(100);
    }
    throw new Error('zephyr-ai healthz timeout');
}

before(async () => {
    // build
    await new Promise((resolve, reject) => {
        const p = spawn('go', ['build', '-o', BIN, './cmd/zephyr-ai'], {
            cwd: AI_DIR,
            env: { ...process.env, PATH: `/usr/local/go126/bin:${process.env.PATH || ''}` },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err || `build ${code}`))));
    });
    child = spawn(BIN, [], {
        env: {
            ...process.env,
            ZEPHYR_AI_LISTEN: LISTEN,
            ZEPHYR_AI_ADMIN_TOKEN: TOKEN,
            ZEPHYR_AI_DATA: DATA,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth();
});

after(() => {
    try { child?.kill('SIGTERM'); } catch {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch {}
    try { rmSync(BIN, { force: true }); } catch {}
});

function admin(path, { method = 'GET', body } = {}) {
    return fetch(`http://${LISTEN}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-ai-admin': TOKEN },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(data)}`);
        return data;
    });
}

test('healthz reports event protocol', async () => {
    const h = await fetch(`http://${LISTEN}/healthz`).then((r) => r.json());
    assert.equal(h.ok, true);
    assert.equal(h.service, 'zephyr-ai');
    assert.equal(h.eventProtocol, 1);
});

test('session create list messages empty', async () => {
    const created = await admin('/admin/sessions', {
        method: 'POST',
        body: { userId: 'u-smoke', title: 't1' },
    });
    assert.ok(created.session?.id);
    const list = await admin(`/admin/sessions?userId=u-smoke`);
    assert.ok(list.sessions.some((s) => s.id === created.session.id));
    const msgs = await admin(`/admin/sessions/${created.session.id}/messages?userId=u-smoke`);
    assert.deepEqual(msgs.messages || [], []);
});
