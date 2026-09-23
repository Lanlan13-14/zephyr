'use strict';

/**
 * Desktop counterpart of Android's EmbeddedLinkProcess + EmbeddedLinkApi.
 *
 * Android dials an Agent bastion through a loopback zephyr-link-embed child:
 * the child owns the ZSL/2 session and the one-relay splice, and the host
 * only signs the handshake and keeps the upgraded socket. The desktop core
 * already has the device key (zephyr-one-link-sync.js) but its sync path is
 * plain HTTPS, so a jumpHostIds entry of `agent:<id>` used to look for an
 * Agent connected to *this* machine and fail. This module is that missing
 * child: One → main → Agent, same wire as the phone.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const HANDSHAKE_PROOF_PREFIX = 'zephyr-zsl2-handshake-v1';

function linkEmbedName() {
    return process.platform === 'win32' ? 'zephyr-link-embed.exe' : 'zephyr-link-embed';
}

function resolveEmbedBin() {
    if (process.env.ZEPHYR_LINK_EMBED_BIN && fs.existsSync(process.env.ZEPHYR_LINK_EMBED_BIN)) {
        return process.env.ZEPHYR_LINK_EMBED_BIN;
    }
    const name = linkEmbedName();
    const roots = [
        path.join(__dirname, 'desktop-runtime'),
        path.join(process.resourcesPath || '', 'desktop-runtime'),
        path.join(__dirname, 'bin'),
    ];
    for (const root of roots) {
        const candidate = path.join(root, name);
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function handshakeProof(privateKeyPem, deviceId, transcript) {
    const payload = Buffer.concat([
        Buffer.from(HANDSHAKE_PROOF_PREFIX, 'utf8'),
        Buffer.from([0]),
        Buffer.from(String(deviceId), 'utf8'),
        Buffer.from([0]),
        Buffer.isBuffer(transcript) ? transcript : Buffer.from(transcript),
    ]);
    return crypto.sign('sha256', payload, {
        key: privateKeyPem,
        dsaEncoding: 'ieee-p1363',
    }).toString('base64');
}

function postJson(baseUrl, pathname, body, timeoutMs = 20000) {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const url = new URL(pathname, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    return new Promise((resolve, reject) => {
        const req = http.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
                resolve({ status: res.statusCode || 0, data, raw });
            });
        });
        req.on('timeout', () => req.destroy(new Error('link embed request timeout')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

class LinkEmbedProcess {
    constructor({ bin, log = () => {} } = {}) {
        this.bin = bin || resolveEmbedBin();
        this.log = log;
        this.child = null;
        this.baseUrl = '';
        this.starting = null;
    }

    async ensureStarted() {
        if (this.child && this.child.exitCode == null && this.baseUrl) return this.baseUrl;
        if (this.starting) return this.starting;
        this.starting = this._start().finally(() => { this.starting = null; });
        return this.starting;
    }

    _start() {
        if (!this.bin || !fs.existsSync(this.bin)) {
            return Promise.reject(Object.assign(
                new Error('安装包缺少 zephyr-link-embed，无法经由 Agent 跳板'),
                { code: 'link_embed_missing' },
            ));
        }
        return new Promise((resolve, reject) => {
            const child = spawn(this.bin, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            this.child = child;
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };
            let buffer = '';
            child.stdout.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const line = buffer.split('\n').find((row) => row.trim());
                if (!line || settled) return;
                settled = true;
                this.baseUrl = `http://${line.trim()}`;
                resolve(this.baseUrl);
            });
            child.stderr.on('data', (chunk) => {
                const text = chunk.toString('utf8').trim();
                if (text) this.log('[one-link-embed]', text);
            });
            child.once('error', fail);
            child.once('exit', (code) => {
                this.baseUrl = '';
                fail(new Error(`zephyr-link-embed 退出 (${code})`));
            });
            setTimeout(() => fail(new Error('zephyr-link-embed 启动超时')), 8000);
        });
    }

    stop() {
        const child = this.child;
        this.child = null;
        this.baseUrl = '';
        if (!child) return;
        try { child.stdin.end(); } catch { /* already gone */ }
        try { child.kill(); } catch { /* already gone */ }
    }
}

class OneLinkInitiator {
    /**
     * @param {object} opts
     * @param {() => ({serverUrl:string, deviceId:string, privateKeyPem:string, allowInsecureTls?:boolean}|null)} opts.getIdentity
     */
    constructor({ getIdentity, process = null, log = () => {} } = {}) {
        this.getIdentity = getIdentity;
        this.process = process || new LinkEmbedProcess({ log });
        this.log = log;
        this.sessionId = '';
        this.initiatorReady = false;
        this.dialing = null;
    }

    async ensureSession() {
        const identity = this.getIdentity ? this.getIdentity() : null;
        if (!identity?.serverUrl || !identity.deviceId || !identity.privateKeyPem) {
            const err = new Error('尚未绑定主端，无法经由 Agent 跳板');
            err.code = 'unbound';
            throw err;
        }
        if (this.sessionId && this.initiatorReady) return this.sessionId;
        if (this.dialing) return this.dialing;
        this.dialing = this._dial(identity).finally(() => { this.dialing = null; });
        return this.dialing;
    }

    async _dial(identity) {
        const base = await this.process.ensureStarted();
        const peer = `${String(identity.serverUrl).replace(/\/+$/, '')}/api/link/v2`;
        const hello = await postJson(base, '/link/dial', {
            serverUrl: peer,
            deviceId: identity.deviceId,
            insecure: identity.allowInsecureTls === true,
        });
        if (!hello.data?.ok) {
            const message = hello.data?.error?.message || hello.raw || 'Link 握手失败';
            throw Object.assign(new Error(message), { code: hello.data?.error?.code || 'link_unavailable' });
        }
        let sessionId = hello.data.sessionId;
        if (hello.data.pending) {
            const transcript = Buffer.from(String(hello.data.transcript || ''), 'base64');
            const proof = handshakeProof(identity.privateKeyPem, identity.deviceId, transcript);
            const finished = await postJson(base, '/link/dial/finish', { sessionId, proof });
            if (!finished.data?.ok) {
                const message = finished.data?.error?.message || 'Link 握手签名被拒绝';
                throw Object.assign(new Error(message), { code: finished.data?.error?.code || 'proof_required' });
            }
            sessionId = finished.data.sessionId || sessionId;
        }
        const started = await postJson(base, '/link/tunnel/initiator/start', {
            sessionId,
            peerUrl: peer,
        });
        if (!started.data?.ok) {
            const message = started.data?.error?.message || 'Agent 跳板通道建立失败';
            throw Object.assign(new Error(message), { code: started.data?.error?.code || 'initiator_start_failed' });
        }
        this.sessionId = sessionId;
        this.initiatorReady = true;
        return sessionId;
    }

    /**
     * Open a TCP socket whose bytes ride One → main → Agent → host:port.
     * Mirrors EmbeddedLinkApi.dialInitiator: raw HTTP so the leftover socket
     * after the 101 is the tunnel.
     */
    async dial(agentId, host, port) {
        try {
            return await this._dialRelay(agentId, host, port);
        } catch (error) {
            if (!String(error.message || '').includes('initiator stream is not started')) throw error;
            this.initiatorReady = false;
            this.sessionId = '';
            return this._dialRelay(agentId, host, port);
        }
    }

    async _dialRelay(agentId, host, port) {
        await this.ensureSession();
        const base = await this.process.ensureStarted();
        const loopback = new URL(base);
        const payload = JSON.stringify({
            agentId: String(agentId || ''),
            host: String(host || ''),
            port: Number(port) || 0,
        });
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host: loopback.hostname, port: Number(loopback.port) });
            const fail = (error) => {
                try { socket.destroy(); } catch { /* already closed */ }
                reject(error);
            };
            socket.setTimeout(12000, () => fail(new Error('Agent 跳板拨号超时')));
            socket.once('error', fail);
            socket.once('connect', () => {
                const request = [
                    'POST /link/tunnel/initiator/dial HTTP/1.1',
                    `Host: ${loopback.host}`,
                    'Content-Type: application/json',
                    'Connection: Upgrade',
                    'Upgrade: tcp',
                    `Content-Length: ${Buffer.byteLength(payload)}`,
                    '',
                    payload,
                ].join('\r\n');
                socket.write(request);
            });
            let buffer = Buffer.alloc(0);
            const onData = (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) return;
                socket.off('data', onData);
                const head = buffer.slice(0, end).toString('latin1');
                const status = head.split('\r\n')[0].split(' ')[1];
                const rest = buffer.slice(end + 4);
                if (status !== '101') {
                    const detail = rest.toString('utf8');
                    let message = `Agent 跳板拨号失败 (${status || 'unknown'})`;
                    try {
                        const parsed = JSON.parse(detail);
                        if (parsed?.error?.message) message = parsed.error.message;
                    } catch { /* non-json body */ }
                    fail(Object.assign(new Error(message), { code: 'initiator_dial_failed' }));
                    return;
                }
                socket.setTimeout(0);
                if (rest.length) socket.unshift(rest);
                resolve(socket);
            };
            socket.on('data', onData);
        });
    }

    stop() {
        this.initiatorReady = false;
        this.sessionId = '';
        this.process.stop();
    }
}

module.exports = {
    LinkEmbedProcess,
    OneLinkInitiator,
    handshakeProof,
    resolveEmbedBin,
    linkEmbedName,
};
