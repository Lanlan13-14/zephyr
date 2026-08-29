'use strict';

/* Reverse-proxy bridge from the Node server to the Go Link service.
 *
 * The ZSL/2 protocol core lives once, in zephyr-link (Go). The Node server keeps
 * owning the public HTTP/WSS surface and enrollment DB, but it no longer seals or
 * opens Link frames — it forwards bytes to the Go service, which holds the session
 * table. This is what makes server, desktop and mobile run the same protocol.
 *
 * Layout the Go side serves (cmd/zephyr-link-server):
 *   POST /link/handshake        ZSL/2 responder handshake
 *   POST /link/frame            sealed frame round-trip (HTTP fallback)
 *   GET  /link/state            session liveness
 *   POST /link/dial             (unused on the server; embedded nodes only)
 *   GET  /healthz               liveness
 *   POST /admin/register-device enrolment -> Link device registration
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname);

function defaultBinPath() {
    const exe = process.platform === 'win32' ? 'zephyr-link-server.exe' : 'zephyr-link-server';
    return path.join(REPO, 'bin', exe);
}

/* Find a runnable Go Link server binary. Returns null when absent — the caller then
 * keeps the Link surface closed (503) rather than falling back to a divergent
 * in-process implementation. */
function resolveBin() {
    if (process.env.ZEPHYR_LINK_GO_BIN) return process.env.ZEPHYR_LINK_GO_BIN;
    for (const p of [defaultBinPath(), '/usr/local/bin/zephyr-link-server']) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

class GoLinkProcess {
    constructor({ log, adminToken = '', syncBridgeUrl = '', syncBridgeToken = '' } = {}) {
        this.log = log || (() => {});
        this.proc = null;
        this.addr = null;
        /* Loopback admin token must be supplied by the supervisor per process start
         * (generated in memory in server.js). No operator-facing env var exists. */
        if (!adminToken) throw new Error('link-admin-token-required');
        this.adminToken = adminToken;
        this.syncBridgeUrl = syncBridgeUrl;
        this.syncBridgeToken = syncBridgeToken;
        this.starting = null;
    }

    async ensureStarted() {
        if (this.addr) return this.addr;
        if (this.starting) return this.starting;
        this.starting = this._start().finally(() => { this.starting = null; });
        return this.starting;
    }

    async _start() {
        const bin = resolveBin();
        if (!bin) throw Object.assign(new Error('link-go-binary-missing'), { code: 'link_go_missing' });
        const proc = spawn(bin, [], {
            env: {
                ...process.env,
                ZEPHYR_LINK_ADDR: '127.0.0.1:0',
                ZEPHYR_LINK_ADMIN_TOKEN: this.adminToken,
                /* The owned-sync lane bridges back to this Node process's single
                 * sync core over loopback. Empty URL leaves the lane unregistered,
                 * which makes a SYNC_OP a clean dispatch error rather than a hang. */
                ZEPHYR_LINK_SYNC_BRIDGE: this.syncBridgeUrl,
                ZEPHYR_LINK_SYNC_TOKEN: this.syncBridgeToken,
            },
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        this.proc = proc;
        this.addr = await new Promise((resolve, reject) => {
            let buf = '';
            const onData = (chunk) => {
                buf += chunk.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl !== -1) {
                    const line = buf.slice(0, nl).trim();
                    proc.stdout.off('data', onData);
                    resolve(line);
                }
            };
            proc.stdout.on('data', onData);
            proc.on('exit', (code) => reject(Object.assign(new Error('link-go-exited-' + code), { code: 'link_go_exited' })));
            proc.on('error', reject);
            setTimeout(() => reject(new Error('link-go-readiness-timeout')), 10000).unref();
        });
        proc.on('exit', () => { this.addr = null; this.proc = null; });
        this.log('[link-v2] go link service up at', this.addr);
        return this.addr;
    }

    stop() {
        if (this.proc) { try { this.proc.kill('SIGTERM'); } catch {} this.proc = null; }
        this.addr = null;
        this.startPromise = null;
    }
}

/* One shared process handle for the whole server. */
const shared = { proc: null };
function sharedProcess(log, cfg = {}) {
    if (!shared.proc) shared.proc = new GoLinkProcess({ log, ...cfg });
    return shared.proc;
}

/* Called on server shutdown so the Go child never outlives its supervisor (and so
 * test restarts do not leak processes that hold the readiness-port race open). */
function stopLinkV2Go() {
    if (shared.proc) { shared.proc.stop(); shared.proc = null; }
}

function createLinkV2GoProxy({ log, enrollments, adminToken, syncBridgeUrl, syncBridgeToken } = {}) {
    const proc = sharedProcess(log, { adminToken, syncBridgeUrl, syncBridgeToken });
    // Devices the Go service is known to hold this process lifetime, so we only
    // re-register once per device per restart instead of on every handshake.
    const registered = new Set();

    async function registerDevice(deviceId) {
        if (!deviceId) return;
        /* Registering the device with the Go transport is a hard precondition for the very
         * first handshake: RequireEnrollment rejects every frame from an unknown device, so a
         * silently dropped registration here presents as "bound client cannot sync" on the
         * phone and as "already-bound device missing" on the server UI. Retry with backoff
         * instead of swallowing the error; the admin route is idempotent so retries are safe. */
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const addr = await proc.ensureStarted();
                const [host, port] = addr.split(':');
                const ok = await new Promise((resolve) => {
                    const body = JSON.stringify({ deviceId });
                    const req = http.request({
                        host, port: Number(port),
                        path: '/admin/register-device', method: 'POST',
                        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-link-admin': proc.adminToken },
                    }, (res) => {
                        res.resume();
                        resolve(res.statusCode >= 200 && res.statusCode < 300);
                    });
                    req.on('error', () => resolve(false));
                    req.setTimeout(5000, () => { req.destroy(new Error('register-device timeout')); });
                    req.write(body); req.end();
                });
                if (ok) return;
                log('[link-v2] register-device attempt ' + (attempt + 1) + ' failed, retrying');
            } catch (e) {
                log('[link-v2] register-device attempt ' + (attempt + 1) + ' error: ' + (e && e.message));
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
        const failure = new Error('link-device-registration-failed');
        failure.code = 'link_device_registration_failed';
        throw failure;
    }

    function forward(clientReq, clientRes, goPath, parsedBody) {
        (async () => {
            const addr = await proc.ensureStarted();
            const [host, port] = addr.split(':');
            const send = (payload) => {
                const req = http.request({
                    host, port: Number(port), path: goPath, method: clientReq.method,
                    headers: { 'content-type': clientReq.headers['content-type'] || 'application/json', 'content-length': payload.length },
                }, (goRes) => {
                    clientRes.status(goRes.statusCode || 502);
                    clientRes.set('content-type', goRes.headers['content-type'] || 'application/json');
                    goRes.pipe(clientRes);
                });
                req.on('error', (e) => clientRes.status(502).json({ ok: false, error: { code: 'link_unreachable', message: String(e.message || e), retryable: true } }));
                req.write(payload); req.end();
            };
            if (parsedBody !== undefined) {
                send(Buffer.from(JSON.stringify(parsedBody)));
                return;
            }
            // The global express.json() runs before this router and already consumed the
            // stream into req.body for JSON payloads — re-serialise that instead of waiting
            // on a stream that will never emit 'end' again.
            if (clientReq.body !== undefined && clientReq.readableEnded) {
                send(Buffer.from(JSON.stringify(clientReq.body)));
                return;
            }
            const chunks = [];
            clientReq.on('data', (c) => chunks.push(c));
            clientReq.on('end', () => send(Buffer.concat(chunks)));
            clientReq.on('error', () => clientRes.status(400).end());
        })().catch((e) => {
            const code = (e && e.code) || 'link_go_unavailable';
            clientRes.status(503).json({ ok: false, error: { code, message: 'Link 服务未就绪', retryable: true } });
        });
    }

    // Before forwarding a handshake, make sure the Go service holds the device. The
    // device table lives in Node's enrollment store (SQLite); the Go service restarts
    // empty, so we re-register any consumed device the first time it handshakes after
    // a restart. An unenrolled device is left to fail closed at the Go side.
    async function ensureDevice(deviceId) {
        if (!deviceId || registered.has(deviceId)) return;
        if (!enrollments || typeof enrollments.deviceById !== 'function') return;
        const row = enrollments.deviceById(deviceId);
        if (!row) return; // not consumed -> Go will reject; do not register unknowns
        await registerDevice(deviceId);
        registered.add(deviceId);
    }

    function router() {
        const express = require('express');
        const r = express.Router();
        r.post('/handshake', express.json({ limit: '64kb' }), (req, res) => {
            const deviceId = String((req.body && req.body.deviceId) || '');
            ensureDevice(deviceId)
                .then(() => forward(req, res, '/link/handshake', req.body))
                .catch((error) => {
                    log('[link-v2] handshake registration failed for ' + deviceId + ': ' + (error && error.message));
                    if (!res.headersSent) {
                        res.status(503).json({
                            ok: false,
                            error: {
                                code: (error && error.code) || 'link_device_registration_failed',
                                message: 'Link 设备注册未就绪，请重试',
                                retryable: true,
                            },
                        });
                    }
                });
        });
        r.post('/push', (req, res) => forward(req, res, '/link/frame'));
        r.get('/state', (req, res) => {
            const sessionId = String(req.query.sessionId || '');
            forward(req, res, '/link/state?sessionId=' + encodeURIComponent(sessionId));
        });
        return r;
    }

    return { router, registerDevice, _proc: proc };
}

/* WSS relay: the client terminates TLS+WS at Node; Node opens a second WS to the Go
 * service and shuttles messages both ways. Frame payloads are ZSL/2 ciphertext that
 * only the Go service and the device can read — Node never inspects them. */
function proxyLinkV2Stream(ws, req) {
    (async () => {
        const WebSocket = require('ws');
        const proc = sharedProcess();
        const addr = await proc.ensureStarted();
        const url = new URL(req.url || '/', 'http://localhost');
        const sessionId = url.searchParams.get('sessionId') || '';
        if (!sessionId) { try { ws.close(1008, 'session-required'); } catch {} return; }
        const upstream = new WebSocket('ws://' + addr + '/link/stream?sessionId=' + encodeURIComponent(sessionId));
        const queue = [];
        upstream.on('open', () => { for (const m of queue) upstream.send(m); queue.length = 0; });
        upstream.on('message', (data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
        upstream.on('close', () => { try { ws.close(1000, 'upstream-closed'); } catch {} });
        upstream.on('error', () => { try { ws.close(1011, 'link-upstream-error'); } catch {} });
        ws.on('message', (data) => {
            if (upstream.readyState === upstream.OPEN) upstream.send(data);
            else queue.push(data);
        });
        ws.on('close', () => { try { upstream.close(); } catch {} });
        ws.on('error', () => { try { upstream.close(); } catch {} });
    })().catch(() => { try { ws.close(1011, 'link-unavailable'); } catch {} });
}

module.exports = { createLinkV2GoProxy, proxyLinkV2Stream, GoLinkProcess, stopLinkV2Go };
