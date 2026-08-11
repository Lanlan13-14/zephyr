import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AI_DIR = join(ROOT, 'zephyr-ai');
const BIN = join(tmpdir(), `zephyr-ai-smoke-${process.pid}`);
const PORT = 18450 + (process.pid % 100);
const LISTEN = `127.0.0.1:${PORT}`;
const TOKEN = 'smoke-token';
const GO_ENV = {
    ...process.env,
    PATH: ['/usr/local/go126/bin', process.env.PATH].filter(Boolean).join(delimiter),
};
const GO_PROBE = spawnSync('go', ['version'], { env: GO_ENV, stdio: 'ignore' });
const GO_MISSING = GO_PROBE.error?.code === 'ENOENT';

let child;
let dataDir;

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

async function waitProcessHealth(proc) {
    let onError;
    let onExit;
    const startupFailure = new Promise((_, reject) => {
        onError = (error) => reject(new Error(`failed to start zephyr-ai: ${error.message}`, { cause: error }));
        onExit = (code, signal) => reject(new Error(`zephyr-ai exited before health check with ${code ?? signal}`));
        proc.once('error', onError);
        proc.once('exit', onExit);
    });
    try {
        return await Promise.race([waitHealth(), startupFailure]);
    } finally {
        proc.off('error', onError);
        proc.off('exit', onExit);
    }
}

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

describe('zephyr-ai Go runtime smoke', {
    skip: GO_MISSING ? 'Go toolchain is not installed; skipping optional integration smoke test' : false,
}, () => {
    before(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'zephyr-ai-data-'));
        await new Promise((resolve, reject) => {
            const p = spawn('go', ['build', '-o', BIN, './cmd/zephyr-ai'], {
                cwd: AI_DIR,
                env: GO_ENV,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let err = '';
            p.stderr.on('data', (d) => { err += d; });
            p.once('error', (error) => reject(new Error(`failed to start Go compiler: ${error.message}`, { cause: error })));
            p.once('close', (code, signal) => {
                if (code === 0) resolve();
                else reject(new Error(err || `go build exited with ${code ?? signal}`));
            });
        });
        child = spawn(BIN, [], {
            env: {
                ...process.env,
                ZEPHYR_AI_LISTEN: LISTEN,
                ZEPHYR_AI_ADMIN_TOKEN: TOKEN,
                ZEPHYR_AI_DATA: dataDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        await waitProcessHealth(child);
    });

    after(() => {
        try { child?.kill('SIGTERM'); } catch {}
        try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
        try { rmSync(BIN, { force: true }); } catch {}
    });

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
});
