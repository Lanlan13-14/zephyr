import { spawn } from 'node:child_process';
import https from 'node:https';
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

function httpsFetch(url, init = {}) {
    const parsed = new URL(url);
    const headers = { ...(init.headers || {}) };
    const body = init.body == null ? null : (
        typeof init.body === 'string' || Buffer.isBuffer(init.body)
            ? init.body
            : Buffer.from(String(init.body))
    );
    if (body && !headers['content-length'] && !headers['Content-Length']) {
        headers['content-length'] = String(Buffer.byteLength(body));
    }
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: String(init.method || 'GET').toUpperCase(),
            headers,
            rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const headerBag = new Headers();
                for (const [name, value] of Object.entries(res.headers)) {
                    if (value == null) continue;
                    if (Array.isArray(value)) value.forEach((item) => headerBag.append(name, item));
                    else headerBag.set(name, String(value));
                }
                resolve(new Response(buf, { status: res.statusCode, headers: headerBag }));
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

export class TestServer {
    constructor({ httpsOnly = false, linkInternalPort = null } = {}) {
        this.dataFixture = createSecureTestDataDir('zephyr-test-');
        this.dir = this.dataFixture.dataDir;
        this.port = null;
        this.httpsPort = null;
        this.linkInternalPort = linkInternalPort;
        this.aiHostPort = null;
        this.proc = null;
        this.instanceId = null;
        this.httpsOnly = httpsOnly;
        this.log = '';
        this.agent = null;
    }

    async start() {
        let lastBindError = null;
        for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt += 1) {
            /* HTTPS-only still reserves a PORT so the env looks like Docker:
             * HTTP_ENABLED=false, PORT assigned, nothing listening there. */
            const reservation = await reserveLoopbackPorts(this.httpsOnly ? 3 : 2);
            if (this.httpsOnly) {
                [this.port, this.httpsPort, this.aiHostPort] = reservation.ports;
            } else {
                [this.port, this.aiHostPort] = reservation.ports;
            }
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
            HTTP_ENABLED: this.httpsOnly ? 'false' : 'true',
            HTTPS_ENABLED: this.httpsOnly ? 'true' : 'false',
            PORT: String(this.port),
            HTTPS_PORT: String(this.httpsPort || 3443),
            ZEPHYR_BIND_HOST: '127.0.0.1',
            ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${this.aiHostPort}`,
            ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${this.aiHostPort}`,
            ZEPHYR_DATA_DIR: this.dir,
            ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(this.dir, 'crypto', 'key.json'),
            ENCRYPTION_KEY: 'integration-test-key',
            NODE_ENV: 'production',
        };
        if (this.linkInternalPort != null) {
            env.ZEPHYR_LINK_INTERNAL_PORT = String(this.linkInternalPort);
        }
        this.proc = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
        this.proc.stdout.on('data', (d) => { this.log += d; });
        this.proc.stderr.on('data', (d) => {
            this.log += d;
            process.stderr.write(`[server:${this.port}] ${d}`);
        });
        this.proc.on('exit', (code, signal) => {
            if (code !== null && code !== 0) {
                process.stderr.write(`[server:${this.port}] exited code=${code}\n${this.log.slice(-1500)}\n`);
            }
        });
        const deadline = Date.now() + 45000;
        while (true) {
            if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
                throw new Error(`server exited (${this.proc.exitCode ?? this.proc.signalCode}):\n${this.log.slice(-2000)}`);
            }
            try {
                const r = await this.fetch('/healthz');
                if (r.ok) {
                    this.instanceId = (await r.json()).instanceId;
                    return this;
                }
            } catch {}
            if (Date.now() > deadline) {
                await this.stop();
                throw new Error(`server did not become healthy:\n${this.log.slice(-3000)}`);
            }
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    url(p) {
        if (this.httpsOnly) return `https://127.0.0.1:${this.httpsPort}${p}`;
        return `http://127.0.0.1:${this.port}${p}`;
    }

    fetch(p, init = {}) {
        const url = this.url(p);
        if (!this.httpsOnly) return fetch(url, init);
        return httpsFetch(url, init);
    }

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

    async login(username, password) {
        const res = await this.fetch('/api/auth/login', {
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

    async bootstrapAdmin(newPassword = 'admin-test-pass-1') {
        const { cookie } = await this.login('admin', 'admin');
        const res = await this.fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ currentPassword: 'admin', newPassword }),
        });
        if (res.status !== 200) throw new Error(`bootstrap change-password failed: ${await res.text()}`);
        return { cookie, password: newPassword };
    }

    async api(cookie, method, p, body) {
        const res = await this.fetch(p, {
            method,
            headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch {}
        return { status: res.status, body: json };
    }
}
