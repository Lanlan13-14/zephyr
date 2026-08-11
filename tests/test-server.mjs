import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

/* Shared helper: boot the real Zephyr server against an isolated temp data
 * dir for HTTP-level integration tests. */

const REPO = path.resolve(import.meta.dirname, '..');
const MAX_BIND_ATTEMPTS = 3;

async function closeReservation(server) {
    if (!server.listening) return;
    await new Promise((resolve) => server.close(resolve));
}

async function reserveLoopbackPorts(count) {
    const reservations = [];
    try {
        for (let i = 0; i < count; i += 1) {
            const reservation = net.createServer();
            reservation.unref();
            await new Promise((resolve, reject) => {
                reservation.once('error', reject);
                reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
            });
            reservations.push(reservation);
        }
        const ports = reservations.map((reservation) => {
            const address = reservation.address();
            if (!address || typeof address === 'string') throw new Error('loopback port reservation has no TCP address');
            return address.port;
        });
        return {
            ports,
            release: () => Promise.all(reservations.map(closeReservation)),
        };
    } catch (error) {
        await Promise.all(reservations.map(closeReservation));
        throw error;
    }
}

function isRetryableBindFailure(error) {
    return /listen E(?:ADDRINUSE|ACCES)\b/.test(String(error?.message || ''));
}

export class TestServer {
    constructor() {
        this.dataFixture = createSecureTestDataDir('zephyr-test-');
        this.dir = this.dataFixture.dataDir;
        this.port = null;
        this.aiHostPort = null;
        this.proc = null;
        this.instanceId = null;
    }

    async start() {
        let lastBindError = null;
        for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt += 1) {
            const reservation = await reserveLoopbackPorts(2);
            [this.port, this.aiHostPort] = reservation.ports;
            await reservation.release();
            try {
                return await this.startOnce();
            } catch (error) {
                await this.stop();
                if (!isRetryableBindFailure(error) || attempt === MAX_BIND_ATTEMPTS) throw error;
                lastBindError = error;
            }
        }
        throw lastBindError;
    }

    async startOnce() {
        const env = {
            ...process.env,
            HTTP_ENABLED: 'true',
            HTTPS_ENABLED: 'false',
            PORT: String(this.port),
            ZEPHYR_BIND_HOST: '127.0.0.1',
            ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${this.aiHostPort}`,
            ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${this.aiHostPort}`,
            ZEPHYR_DATA_DIR: this.dir,
            ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(this.dir, 'crypto', 'key.json'),
            ENCRYPTION_KEY: 'integration-test-key',
            NODE_ENV: 'production',
        };
        this.proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
        // Safety net: if the test runner is killed (SIGKILL, timeout, Ctrl-C)
        // before `after` runs, the spawned server.js must not become an orphan
        // holding the port. Register on the process and on common fatal signals.
        const procRef = this.proc;
        const killHard = () => { try { procRef.kill('SIGKILL'); } catch {} };
        const fatalSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        const removeParentHooks = () => {
            process.removeListener('exit', killHard);
            for (const sig of fatalSignals) process.removeListener(sig, killHard);
        };
        process.once('exit', killHard);
        for (const sig of fatalSignals) process.once(sig, killHard);
        procRef.once('exit', removeParentHooks);
        let log = '';
        this.proc.stdout.on('data', (d) => { log += d; });
        this.proc.stderr.on('data', (d) => {
            log += d;
            // Forward server stderr to the test process so crashes are visible
            // in test output instead of being swallowed.
            process.stderr.write(`[server:${this.port}] ${d}`);
        });
        // If the server dies unexpectedly, surface why.
        this.proc.on('exit', (code, signal) => {
            if (code !== null && code !== 0) {
                process.stderr.write(`[server:${this.port}] exited code=${code}\n${log.slice(-1500)}\n`);
            }
        });
        const deadline = Date.now() + 45000;
        while (true) {
            if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
                throw new Error(`server exited (${this.proc.exitCode ?? this.proc.signalCode}):\n${log.slice(-2000)}`);
            }
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
        const proc = this.proc;
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
        proc.kill('SIGTERM');
        await new Promise((resolve) => {
            const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; resolve(); }, 8000);
            proc.once('exit', () => { clearTimeout(t); resolve(); });
        });
    }

    async cleanup() {
        await this.stop();
        removeSecureTestDataDir(this.dataFixture);
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
