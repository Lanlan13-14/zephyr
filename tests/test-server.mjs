import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Shared helper: boot the real Zephyr server against an isolated temp data
 * dir for HTTP-level integration tests. */

const REPO = path.resolve(import.meta.dirname, '..');
let nextPort = 39200 + Math.floor(Math.random() * 400);

export class TestServer {
    constructor() {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-test-'));
        this.port = nextPort++;
        this.proc = null;
        this.instanceId = null;
    }

    async start() {
        const env = {
            ...process.env,
            HTTP_ENABLED: 'true',
            HTTPS_ENABLED: 'false',
            PORT: String(this.port),
            ZEPHYR_DATA_DIR: this.dir,
            ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(this.dir, 'crypto', 'key.json'),
            ENCRYPTION_KEY: 'integration-test-key',
            NODE_ENV: 'production',
        };
        this.proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        this.proc.stdout.on('data', (d) => { log += d; });
        this.proc.stderr.on('data', (d) => { log += d; });
        const deadline = Date.now() + 45000;
        while (true) {
            if (this.proc.exitCode !== null) throw new Error(`server exited (${this.proc.exitCode}):\n${log.slice(-2000)}`);
            try {
                const r = await fetch(this.url('/healthz'));
                if (r.ok) {
                    this.instanceId = (await r.json()).instanceId;
                    return this;
                }
            } catch {}
            if (Date.now() > deadline) {
                await this.stop();
                throw new Error(`server did not become healthy:\n${log.slice(-3000)}`);
            }
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    url(p) { return `http://127.0.0.1:${this.port}${p}`; }

    async stop() {
        if (!this.proc || this.proc.exitCode !== null) return;
        this.proc.kill('SIGTERM');
        await new Promise((resolve) => {
            const t = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {}; resolve(); }, 8000);
            this.proc.once('exit', () => { clearTimeout(t); resolve(); });
        });
    }

    async cleanup() {
        await this.stop();
        fs.rmSync(this.dir, { recursive: true, force: true });
    }

    /* login helper: returns a cookie header value */
    async login(username, password) {
        const res = await fetch(this.url('/api/auth/login'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(body)}`);
        const raw = res.headers.get('set-cookie') || '';
        const m = raw.match(/zephyr_sid=([^;]+)/);
        if (!m) throw new Error('no session cookie issued');
        return { cookie: `zephyr_sid=${m[1]}`, body };
    }

    /* first-boot convenience: login admin/admin and set a real password */
    async bootstrapAdmin(newPassword = 'admin-test-pass-1') {
        const { cookie } = await this.login('admin', 'admin');
        const res = await fetch(this.url('/api/auth/change-password'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ currentPassword: 'admin', newPassword }),
        });
        if (res.status !== 200) throw new Error(`bootstrap change-password failed: ${await res.text()}`);
        return { cookie, password: newPassword };
    }

    async api(cookie, method, p, body) {
        const res = await fetch(this.url(p), {
            method,
            headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch {}
        return { status: res.status, body: json };
    }
}
