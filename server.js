const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { pipeline: streamPipeline } = require('stream/promises');
const { Transform } = require('stream');
const nodemailer = require('nodemailer');
const { TOTP, generateSecret, generateURI, verifySync } = require('otplib');
const QRCode = require('qrcode');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');
const ipaddr = require('ipaddr.js');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { getRemoteStats } = require('./stats');
const storage = require('./storage');
const secretCrypto = require('./secret-crypto');
const { handleEditorLspConnection } = require('./editor-lsp-server');
const { getAppVersion } = require('./version');
const {
    registerAiRoutes,
    normalizeAiSettingsInput,
    safeAiSettings,
} = require('./ai-agent-service');
const {
    getImageExt,
    isBrowserImageExt,
    isPreviewImageExt,
    getBrowserImageContentType,
    ensurePreviewCacheFile,
    cleanupPreviewCache,
} = require('./preview/image/preview-service');
const {
    extname: getMediaExt,
    basenameNoExt: getMediaBasenameNoExt,
    isMediaExt,
    isVideoExt,
    isSubtitleExt,
    directMime,
    mediaCacheKey,
    probeMediaFromStream,
    decidePlayMode,
    ffmpegArgsForMode,
    subtitleToVttArgs,
    cleanupMediaProbeCache,
} = require('./preview/media/media-service');

const PORT = process.env.PORT || 3000;
const SSH_STATS_ENABLED = process.env.SSH_STATS_ENABLED !== 'false';
const APP_VERSION = getAppVersion();
const app = express();

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'zephyr.db');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const sessions = new Map();
const sshTerminalSessions = new Map();
const sftpDownloadTokens = new Map();
const sftpUploadTokens = new Map();
const sftpPreviewTokens = new Map();
const sftpMediaTokens = new Map();
const sftpClipboardByUser = new Map();
const sftpClipboardTransfers = new Map();
const sftpArchiveTransfers = new Map();
const previewCache = new Map();
const mediaProbeCache = new Map();
const PREVIEW_TOKEN_TTL = 10 * 60 * 1000;
const PREVIEW_CACHE_TTL = 30 * 60 * 1000;
const PREVIEW_CACHE_DIR = path.join(os.tmpdir(), 'zephyr-preview-cache');
const MEDIA_TOKEN_TTL = 24 * 60 * 60 * 1000;
const MEDIA_CACHE_TTL = 30 * 60 * 1000;
const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'zephyr-media-cache');
const BROWSER_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif']);
const BROWSER_IMAGE_CONTENT_TYPES = new Map([
    ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'],
    ['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['avif', 'image/avif'],
]);
const PREVIEW_IMAGE_EXTENSIONS = new Set([
    ...BROWSER_IMAGE_EXTENSIONS,
    'tif', 'tiff', 'heic', 'heif', 'jxl', 'jp2', 'j2k', 'bmp', 'dib', 'ico', 'cur', 'icns',
    'psd', 'psb', 'xcf', 'dds', 'tga', 'hdr', 'exr', 'pnm', 'pbm', 'pgm', 'ppm', 'pam',
    'pcx', 'sgi', 'ras', 'sun', 'fits', 'fit', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf',
    'rw2', 'raf', 'pef', 'srw', 'x3f', 'mrw', 'erf', 'kdc', 'dcr', 'mos'
]);
const SFTP_DOWNLOAD_TOKEN_TTL = 24 * 60 * 60 * 1000;
const SFTP_UPLOAD_TOKEN_TTL = 24 * 60 * 60 * 1000;
const SFTP_DOWNLOAD_KEEPALIVE_INTERVAL = 30 * 1000;
const SFTP_UPLOAD_KEEPALIVE_INTERVAL = 30 * 1000;
const tempTotpTokens = new Map();
const webauthnChallenges = new Map();
const resetRequestHits = new Map();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function wsSendJSON(targetWs, obj) {
    if (targetWs?.readyState === targetWs?.OPEN) {
        targetWs.send(JSON.stringify(obj));
    }
}

function appendSshSessionBuffer(session, data) {
    if (!session || !data) return;
    session.outputBuffer.push(String(data));
    let total = session.outputBuffer.reduce((sum, item) => sum + item.length, 0);
    while (total > 512 * 1024 && session.outputBuffer.length > 1) {
        total -= session.outputBuffer.shift().length;
    }
}

function broadcastSshSession(session, obj) {
    if (!session?.attachedWs) return;
    for (const targetWs of [...session.attachedWs]) {
        wsSendJSON(targetWs, obj);
    }
}

function sendTransferEvent(username, payload) {
    for (const session of sshTerminalSessions.values()) {
        if (session.username !== username || session.closed || !session.attachedWs) continue;
        broadcastSshSession(session, { type: 'sftp-transfer-progress', ...payload });
    }
}

function destroySshTerminalSession(sessionOrId, reason = 'session-destroy') {
    const session = typeof sessionOrId === 'string' ? sshTerminalSessions.get(sessionOrId) : sessionOrId;
    if (!session || session.closed) return;
    session.closed = true;
    sshTerminalSessions.delete(session.id);
    for (const [token, download] of sftpDownloadTokens.entries()) {
        if (download.sessionId === session.id) sftpDownloadTokens.delete(token);
    }
    for (const [token, uploadTask] of sftpUploadTokens.entries()) {
        if (uploadTask.sessionId === session.id) {
            sftpUploadTokens.delete(token);
            destroyUploadSession(token);
        }
    }
    for (const [token, previewTask] of sftpPreviewTokens.entries()) {
        if (previewTask.sessionId === session.id) sftpPreviewTokens.delete(token);
    }
    for (const [token, mediaTask] of sftpMediaTokens.entries()) {
        if (mediaTask.sessionId === session.id) sftpMediaTokens.delete(token);
    }
    console.info('[SSH-SESSION]', 'destroy', {
        sessionId: session.id,
        reason,
        attached: session.attachedWs?.size || 0,
        connectionId: session.connectionId || '',
    });
    broadcastSshSession(session, { type: 'close', message: reason === 'client-disconnect' ? '会话已断开' : 'SSH 会话已关闭' });
    for (const targetWs of [...(session.attachedWs || [])]) {
        try { targetWs._sshTerminalSession = null; } catch {}
    }
    session.attachedWs?.clear?.();
    try { session.sshStream?.end?.(); } catch {}
    try { session.sshStream?.destroy?.(); } catch {}
    [...(session.sshClients || [])].reverse().forEach((client) => {
        try { client.end?.(); } catch {}
    });
    if (session.sshClient && !(session.sshClients || []).includes(session.sshClient)) {
        try { session.sshClient.end?.(); } catch {}
    }
}

function loadDataEnv() {
    const envFile = path.join(DATA_DIR, '.env');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, 'ENCRYPTION_KEY=please-change-this-key\nPUBLIC_ORIGIN=http://localhost:3000\n');
    const raw = fs.readFileSync(envFile, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
}
loadDataEnv();

function ensureDataFile(file, fallback) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}

function readJSON(file, fallback) {
    if (file === USERS_FILE) return storage.getUsersStore();
    if (file === CONNECTIONS_FILE) return storage.getConnectionsStore();
    if (file === SETTINGS_FILE) return storage.getSettings();
    ensureDataFile(file, fallback);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
    if (file === USERS_FILE) return storage.saveUsersStore(data);
    if (file === CONNECTIONS_FILE) return storage.saveConnectionsStore(data);
    if (file === SETTINGS_FILE) return storage.updateSettings(data);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt] = stored.split(':');
    return hashPassword(password, salt) === stored;
}

function initData() {
    ensureDataFile(USERS_FILE, {
        users: [{ username: 'admin', passwordHash: hashPassword('admin'), defaultPassword: true, createdAt: Date.now() }]
    });
    ensureDataFile(CONNECTIONS_FILE, { connections: [], activities: [] });
    ensureDataFile(SETTINGS_FILE, { version: APP_VERSION, icp: '', policeBeian: '' });
}

storage.init({ hashPassword });

function reopenStorage() {
    storage.close();
    storage.init({ hashPassword });
}

function parseBackupKeyFile(buffer) {
    if (!buffer?.length) return null;
    try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
}

function restoredKeyMatchesCurrent(currentBuffer, incomingBuffer) {
    if (!incomingBuffer?.length) return false;
    const current = parseBackupKeyFile(currentBuffer);
    const incoming = parseBackupKeyFile(incomingBuffer);
    return Boolean(current?.publicKey && current?.secretKey && incoming?.publicKey && incoming?.secretKey && current.publicKey === incoming.publicKey && current.secretKey === incoming.secretKey);
}

function parseCookies(req) {
    return String(req.headers.cookie || '').split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx > -1) acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1));
        return acc;
    }, {});
}

const SESSION_TTL_MS = Math.max(5 * 60000, Number(process.env.SESSION_TTL_SECONDS || 24 * 60 * 60) * 1000);
const REMEMBER_SESSION_TTL_MS = Math.max(SESSION_TTL_MS, Number(process.env.REMEMBER_SESSION_TTL_SECONDS || 30 * 24 * 60 * 60) * 1000);

function currentSession(req) {
    const sid = parseCookies(req).zephyr_sid;
    if (!sid) return null;
    const session = sessions.get(sid);
    if (!session) return null;
    const ttl = session.remember ? REMEMBER_SESSION_TTL_MS : SESSION_TTL_MS;
    if (Date.now() - Number(session.createdAt || 0) > ttl) {
        sessions.delete(sid);
        return null;
    }
    session.lastSeenAt = Date.now();
    return session;
}

function isPasswordChangeAllowedPath(req) {
    return req.path === '/api/auth/me' || req.path === '/api/auth/change-password' || req.path === '/api/auth/logout';
}

function requireAuth(req, res, next) {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: '未登录' });
    if (session.mustChangePassword && !isPasswordChangeAllowedPath(req)) {
        return res.status(403).json({ error: '请先修改默认密码', mustChangePassword: true });
    }
    req.session = session;
    next();
}

function requirePageAuth(req, res, next) {
    const session = currentSession(req);
    if (!session || session.mustChangePassword) return res.redirect('/');
    req.session = session;
    next();
}

function rejectSocket(socket, statusCode = 401, statusText = 'Unauthorized') {
    try { socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`); } catch {}
    try { socket.destroy(); } catch {}
}

function publicConnection(conn) {
    const copy = { ...conn };
    copy.password = conn.password ? '******' : '';
    copy.privateKey = conn.privateKey ? '******' : '';
    copy.hasPassword = Boolean(conn.password);
    copy.hasPrivateKey = Boolean(conn.privateKey);
    copy.jumpHostIds = normalizeJumpHostIds(conn);
    return copy;
}

function normalizeJumpHostIds(connOrValue) {
    const value = Array.isArray(connOrValue) || typeof connOrValue === 'string' ? connOrValue : connOrValue?.jumpHostIds;
    let ids = [];
    if (Array.isArray(value)) ids = value;
    else if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            ids = Array.isArray(parsed) ? parsed : String(value).split(',');
        } catch {
            ids = value.split(',');
        }
    }
    if (!ids.length && connOrValue?.jumpHostId) ids = [connOrValue.jumpHostId];
    return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}

function applyConnectionRouteFields(conn, body) {
    if (body.connectionMode !== undefined) conn.connectionMode = ['direct', 'proxy', 'jump'].includes(body.connectionMode) ? body.connectionMode : 'direct';
    if (body.proxyId !== undefined) conn.proxyId = body.proxyId || null;
    if (body.jumpHostId !== undefined) conn.jumpHostId = body.jumpHostId || null;
    if (body.jumpHostIds !== undefined) {
        conn.jumpHostIds = normalizeJumpHostIds(body.jumpHostIds);
        conn.jumpHostId = conn.jumpHostIds[0] || conn.jumpHostId || null;
    } else if (conn.jumpHostId && !normalizeJumpHostIds(conn).length) {
        conn.jumpHostIds = [conn.jumpHostId];
    }
    if (conn.connectionMode !== 'proxy') conn.proxyId = null;
    if (conn.connectionMode !== 'jump') {
        conn.jumpHostId = null;
        conn.jumpHostIds = [];
    }
    return conn;
}

function verifySensitiveAccess(req, secretInput) {
    const user = storage.getUser(req.session?.username);
    if (!user) throw new Error('未登录或会话已过期');
    const value = String(secretInput || '').trim();
    if (user.totpEnabled) {
        if (!verifySync({ secret: user.totpSecret || '', token: value }).valid) throw new Error('动态验证码错误');
        return { method: 'totp', username: user.username };
    }
    if (!verifyPassword(value, user.passwordHash)) throw new Error('登录密码错误');
    return { method: 'password', username: user.username };
}

function resolveSshKeyForConnection(conn) {
    if (!conn?.sshKeyId) return conn;
    const key = storage.getSshKeyRaw(conn.sshKeyId);
    if (!key) {
        console.warn('[ssh-key] selected key missing', { connectionId: conn.id, sshKeyId: conn.sshKeyId });
        return conn;
    }
    const resolved = { ...conn };
    if (!resolved.privateKey || resolved.privateKey === '******') resolved.privateKey = key.privateKey || '';
    if ((!resolved.password || resolved.password === '******') && key.passphrase) resolved.password = key.passphrase || '';
    console.debug('[ssh-key] resolved key for connection', { connectionId: conn.id, sshKeyId: conn.sshKeyId, keyName: key.name, hasPrivateKey: !!resolved.privateKey, hasPassphrase: !!key.passphrase });
    return resolved;
}

function buildSSHConfig(conn, timeout = 10000) {
    const resolvedConn = resolveSshKeyForConnection(conn);
    const host = String(resolvedConn.host || '').trim();
    const username = String(resolvedConn.username || '').trim();
    const port = Number(resolvedConn.port) || 22;
    const privateKey = resolvedConn.privateKey && resolvedConn.privateKey !== '******' ? String(resolvedConn.privateKey) : '';
    const password = resolvedConn.password && resolvedConn.password !== '******' ? String(resolvedConn.password) : '';
    const hasPrivateKey = privateKey.includes('-----BEGIN');
    const hasPassword = Boolean(password);
    const cfg = { host, port, username, readyTimeout: timeout, keepaliveInterval: 10000 };
    console.info('[SSH-DIAG] build ssh config', {
        connectionId: resolvedConn.id || '',
        name: resolvedConn.name || '',
        target: `${host}:${port}`,
        username,
        mode: resolvedConn.connectionMode || 'direct',
        sshKeyId: resolvedConn.sshKeyId || '',
        authMethods: { password: hasPassword && !hasPrivateKey, privateKey: hasPrivateKey, passphrase: hasPrivateKey && hasPassword },
        timeout,
    });
    if (!host || !username) throw new Error('主机和用户名不能为空');
    if (hasPrivateKey) {
        cfg.privateKey = privateKey;
        if (hasPassword) cfg.passphrase = password;
    } else if (hasPassword) cfg.password = password;
    else throw new Error(`缺少认证凭据（password=${hasPassword}, privateKey=${hasPrivateKey}, sshKeyId=${resolvedConn.sshKeyId || '-'})`);
    return cfg;
}

function waitForSocket(socket, timeout, label = 'TCP 连接') {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.off('connect', onConnect);
            socket.off('error', onError);
            if (err) reject(err); else resolve(socket);
        };
        const onConnect = () => finish();
        const onError = (err) => finish(err);
        const timer = setTimeout(() => {
            socket.destroy();
            finish(new Error(`${label}超时`));
        }, timeout);
        socket.once('connect', onConnect);
        socket.once('error', onError);
    });
}

function readSocketChunk(socket, timeout) {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err, data) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            if (err) reject(err); else resolve(data);
        };
        const onData = (data) => finish(null, data);
        const onError = (err) => finish(err);
        const timer = setTimeout(() => finish(new Error('SOCKS5 握手超时')), timeout);
        socket.once('data', onData);
        socket.once('error', onError);
    });
}

function normalizeProxyType(type) {
    const value = String(type || 'socks5').toLowerCase();
    return ['socks5', 'http'].includes(value) ? value : 'socks5';
}

async function openSocks5Connection(proxy, targetHost, targetPort, timeout = 10000) {
    if (!proxy?.host || !proxy?.port) throw new Error('代理配置不完整');
    console.debug('[proxy]', 'open SOCKS5 tunnel', { proxyId: proxy.id, proxy: proxy.name || proxy.host, targetHost, targetPort });
    const socket = net.createConnection(Number(proxy.port) || 1080, proxy.host);
    await waitForSocket(socket, timeout, 'SOCKS5 代理');

    const hasAuth = Boolean(proxy.username || proxy.password);
    socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    let chunk = await readSocketChunk(socket, timeout);
    if (chunk[0] !== 0x05 || chunk[1] === 0xff) throw new Error('SOCKS5 代理不支持可用认证方式');

    if (chunk[1] === 0x02) {
        const user = Buffer.from(String(proxy.username || ''));
        const pass = Buffer.from(String(proxy.password || ''));
        if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 用户名或密码过长');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        chunk = await readSocketChunk(socket, timeout);
        if (chunk[1] !== 0x00) throw new Error('SOCKS5 代理认证失败');
    }

    const host = String(targetHost || '');
    const port = Number(targetPort) || 22;
    let addr;
    const ipType = net.isIP(host);
    if (ipType === 4) addr = Buffer.from([0x01, ...host.split('.').map((n) => Number(n))]);
    else {
        const hostBuf = Buffer.from(host);
        if (!hostBuf.length || hostBuf.length > 255) throw new Error('目标主机名无效');
        addr = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
    chunk = await readSocketChunk(socket, timeout);
    if (chunk[1] !== 0x00) throw new Error(`SOCKS5 代理连接目标失败（状态 ${chunk[1]}）`);
    return socket;
}

async function openHttpProxyConnection(proxy, targetHost, targetPort, timeout = 10000) {
    if (!proxy?.host || !proxy?.port) throw new Error('代理配置不完整');
    console.debug('[proxy]', 'open HTTP CONNECT tunnel', { proxyId: proxy.id, proxy: proxy.name || proxy.host, targetHost, targetPort });
    const socket = net.createConnection(Number(proxy.port) || 8080, proxy.host);
    await waitForSocket(socket, timeout, 'HTTP 代理');
    const target = `${targetHost}:${Number(targetPort) || 22}`;
    const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, 'Proxy-Connection: Keep-Alive'];
    if (proxy.username || proxy.password) {
        const token = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');
        headers.push(`Proxy-Authorization: Basic ${token}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    const chunk = await readSocketChunk(socket, timeout);
    const head = chunk.toString('latin1');
    const status = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1];
    if (status !== '200') {
        socket.destroy();
        throw new Error(`HTTP 代理 CONNECT 失败（状态 ${status || 'unknown'}）`);
    }
    return socket;
}

function openProxyConnection(proxy, targetHost, targetPort, timeout = 10000) {
    const type = normalizeProxyType(proxy?.type);
    if (type === 'http') return openHttpProxyConnection(proxy, targetHost, targetPort, timeout);
    return openSocks5Connection(proxy, targetHost, targetPort, timeout);
}

function connectSSHClient(conn, { timeout = 10000, sock = undefined } = {}) {
    return new Promise((resolve, reject) => {
        const client = new Client();
        const label = `${conn?.name || conn?.host || 'unknown'}@${conn?.host || '-'}:${Number(conn?.port) || 22}`;
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            client.off('ready', onReady);
            client.off('error', onError);
            if (err) {
                console.warn('[SSH-DIAG] ssh client connect failed', {
                    connectionId: conn?.id || '',
                    label,
                    code: err.code || '',
                    level: err.level || '',
                    description: err.description || '',
                    message: err.message,
                });
                try { client.end(); } catch {}
                reject(err);
            } else {
                console.info('[SSH-DIAG] ssh client ready', { connectionId: conn?.id || '', label, viaSocket: !!sock });
                resolve(client);
            }
        };
        const onReady = () => finish();
        const onError = (err) => finish(err);
        client.once('ready', onReady);
        client.once('error', onError);
        client.once('end', () => console.info('[SSH-DIAG] ssh client end', { connectionId: conn?.id || '', label }));
        client.once('close', () => console.info('[SSH-DIAG] ssh client close', { connectionId: conn?.id || '', label, settled }));
        try {
            const cfg = buildSSHConfig(conn, timeout);
            if (sock) cfg.sock = sock;
            client.connect(cfg);
        } catch (err) {
            finish(err);
        }
    });
}

function forwardOut(client, host, port) {
    return new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, host, Number(port) || 22, (err, stream) => err ? reject(err) : resolve(stream));
    });
}

function resolveRoutePlan(conn) {
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const connections = store.connections || [];
    const mode = conn.connectionMode || 'direct';
    if (mode === 'proxy') {
        const proxy = storage.getProxyRaw(conn.proxyId);
        if (!proxy) throw new Error('代理配置不存在或已删除');
        return { target: conn, hops: [], firstProxy: proxy };
    }
    if (mode !== 'jump') return { target: conn, hops: [], firstProxy: null };

    const jumpHostIds = normalizeJumpHostIds(conn);
    if (!jumpHostIds.length) throw new Error('未配置跳板机路径');
    if (jumpHostIds.length > 8) throw new Error('跳板机层级过多（最多 8 级）');
    const jumpHostConfigs = storage.listJumpHosts();
    const hops = jumpHostIds.map((rawJumpHostId) => {
        const jumpHostConfig = jumpHostConfigs.find((j) => j.id === rawJumpHostId);
        const jumpConnectionId = jumpHostConfig?.connectionId || rawJumpHostId;
        const hop = connections.find((c) => c.id === jumpConnectionId);
        if (!hop) throw new Error(`跳板机连接不存在或已删除：${jumpHostConfig?.name || rawJumpHostId}`);
        if (hop.id === conn.id) throw new Error('跳板机不能引用当前目标连接');
        if (String(hop.protocol || 'SSH').toUpperCase() !== 'SSH') throw new Error(`跳板机必须是 SSH 连接：${hop.name || hop.host}`);
        return { ...hop, routeName: jumpHostConfig?.name || hop.name || hop.host, jumpHostConfigId: jumpHostConfig?.id || null };
    });
    console.debug('[route-plan]', 'resolved jump route', {
        target: conn.name || conn.host,
        jumpHostIds,
        hops: hops.map((hop) => ({ jumpHostConfigId: hop.jumpHostConfigId, connectionId: hop.id, name: hop.routeName || hop.name, host: hop.host }))
    });
    const firstProxy = hops[0]?.connectionMode === 'proxy' && hops[0].proxyId ? storage.getProxyRaw(hops[0].proxyId) : null;
    if (hops[0]?.connectionMode === 'proxy' && !firstProxy) throw new Error(`首级跳板机代理配置不存在：${hops[0].name}`);
    return { target: conn, hops, firstProxy };
}

async function createRoutedSSHConnection(conn, timeout = 10000) {
    const plan = resolveRoutePlan(conn);
    const clients = [];
    try {
        if (!plan.hops.length) {
            const sock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, conn.host, conn.port, timeout) : undefined;
            const client = await connectSSHClient(conn, { timeout, sock });
            clients.push(client);
            return { client, clients, route: plan.firstProxy ? `代理 ${plan.firstProxy.name || plan.firstProxy.host} -> ${conn.name || conn.host}` : conn.name || conn.host };
        }

        let firstSock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, plan.hops[0].host, plan.hops[0].port, timeout) : undefined;
        let currentClient = await connectSSHClient(plan.hops[0], { timeout, sock: firstSock });
        clients.push(currentClient);
        for (const next of [...plan.hops.slice(1), plan.target]) {
            const tunnel = await forwardOut(currentClient, next.host, next.port);
            currentClient = await connectSSHClient(next, { timeout, sock: tunnel });
            clients.push(currentClient);
        }
        const route = [...plan.hops.map((h) => h.routeName || h.name || h.host), plan.target.name || plan.target.host].join(' -> ');
        return { client: currentClient, clients, route };
    } catch (err) {
        clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        throw err;
    }
}

function listenLocalTcpForward({ route, targetLabel, openTargetStream, onClose }) {
    return new Promise((resolve, reject) => {
        const sockets = new Set();
        const server = net.createServer(async (localSocket) => {
            let remoteSocket = null;
            sockets.add(localSocket);
            localSocket.on('close', () => sockets.delete(localSocket));
            localSocket.on('error', (err) => console.warn('[tcp-forward]', 'local socket error', { route, target: targetLabel, error: err.message }));

            try {
                remoteSocket = await openTargetStream();
                sockets.add(remoteSocket);
                remoteSocket.on('close', () => sockets.delete(remoteSocket));
                remoteSocket.on('error', (err) => console.warn('[tcp-forward]', 'remote socket error', { route, target: targetLabel, error: err.message }));
                localSocket.pipe(remoteSocket);
                remoteSocket.pipe(localSocket);
            } catch (err) {
                console.warn('[tcp-forward]', 'failed to open target stream', { route, target: targetLabel, error: err.message });
                try { localSocket.destroy(err); } catch {}
                try { remoteSocket?.destroy?.(); } catch {}
            }
        });

        const close = () => {
            console.info('[tcp-forward]', 'closing local forward', { route, target: targetLabel });
            try { server.close(); } catch {}
            sockets.forEach((socket) => {
                try { socket.destroy(); } catch {}
            });
            try { onClose?.(); } catch {}
        };

        server.once('error', (err) => {
            close();
            reject(err);
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            console.info('[tcp-forward]', 'local forward ready', { local: `127.0.0.1:${address.port}`, route, target: targetLabel });
            resolve({ host: '127.0.0.1', port: address.port, route, close });
        });
    });
}

async function createRoutedTcpForward(conn, targetPort, timeout = 10000) {
    const plan = resolveRoutePlan(conn);
    const targetHost = String(conn.host || '');
    const port = Number(targetPort) || Number(conn.port) || 0;
    const targetLabel = `${targetHost}:${port}`;
    const clients = [];

    try {
        if (!plan.hops.length) {
            if (!plan.firstProxy) {
                return null;
            }

            const route = `代理 ${plan.firstProxy.name || plan.firstProxy.host} -> ${conn.name || targetLabel}`;
            return await listenLocalTcpForward({
                route,
                targetLabel,
                openTargetStream: () => openProxyConnection(plan.firstProxy, targetHost, port, timeout),
            });
        }

        const firstSock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, plan.hops[0].host, plan.hops[0].port, timeout) : undefined;
        let currentClient = await connectSSHClient(plan.hops[0], { timeout, sock: firstSock });
        clients.push(currentClient);

        for (const hop of plan.hops.slice(1)) {
            const tunnel = await forwardOut(currentClient, hop.host, hop.port);
            currentClient = await connectSSHClient(hop, { timeout, sock: tunnel });
            clients.push(currentClient);
        }

        const route = [...plan.hops.map((h) => h.routeName || h.name || h.host), conn.name || targetLabel].join(' -> ');
        return await listenLocalTcpForward({
            route,
            targetLabel,
            openTargetStream: () => forwardOut(currentClient, targetHost, port),
            onClose: () => clients.reverse().forEach((client) => { try { client.end(); } catch {} }),
        });
    } catch (err) {
        clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        throw err;
    }
}

function reverseBits8(value) {
    let out = 0;
    for (let i = 0; i < 8; i += 1) out = (out << 1) | ((value >> i) & 1);
    return out;
}

function vncAuthResponse(password, challenge) {
    const key = Buffer.alloc(8);
    const raw = Buffer.from(String(password || ''), 'latin1');
    for (let i = 0; i < 8; i += 1) key[i] = reverseBits8(raw[i] || 0);
    const cipher = crypto.createCipheriv('des-ede', Buffer.concat([key, key]), null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(Buffer.from(challenge)), cipher.final()]);
}

class ByteQueue {
    constructor(label = 'stream') {
        this.label = label;
        this.buffers = [];
        this.length = 0;
        this.waiters = [];
        this.closed = false;
        this.error = null;
    }
    push(chunk) {
        if (this.closed) return;
        const buf = Buffer.from(chunk || []);
        if (!buf.length) return;
        this.buffers.push(buf);
        this.length += buf.length;
        this.flush();
    }
    shift(size) {
        const out = Buffer.alloc(size);
        let offset = 0;
        while (offset < size && this.buffers.length) {
            const head = this.buffers[0];
            const take = Math.min(size - offset, head.length);
            head.copy(out, offset, 0, take);
            offset += take;
            this.length -= take;
            if (take === head.length) this.buffers.shift();
            else this.buffers[0] = head.slice(take);
        }
        return out;
    }
    read(size, timeout = 10000, label = '') {
        const wanted = Math.max(0, Number(size) || 0);
        if (this.length >= wanted) return Promise.resolve(this.shift(wanted));
        if (this.closed) return Promise.reject(this.error || new Error(`${label || this.label}已关闭`));
        return new Promise((resolve, reject) => {
            const waiter = { size: wanted, resolve, reject, label: label || this.label, timer: null };
            waiter.timer = setTimeout(() => {
                this.waiters = this.waiters.filter((item) => item !== waiter);
                reject(new Error(`${waiter.label}超时`));
            }, Math.max(1000, Number(timeout) || 10000));
            this.waiters.push(waiter);
            this.flush();
        });
    }
    flush() {
        while (this.waiters.length && this.length >= this.waiters[0].size) {
            const waiter = this.waiters.shift();
            clearTimeout(waiter.timer);
            waiter.resolve(this.shift(waiter.size));
        }
    }
    takeBuffered() {
        const out = this.length ? Buffer.concat(this.buffers, this.length) : Buffer.alloc(0);
        this.buffers = [];
        this.length = 0;
        return out;
    }
    close(err = null) {
        if (this.closed) return;
        this.closed = true;
        this.error = err || new Error(`${this.label}已关闭`);
        this.waiters.splice(0).forEach((waiter) => {
            clearTimeout(waiter.timer);
            waiter.reject(this.error);
        });
    }
}

function parseRfbVersion(buffer) {
    const text = Buffer.from(buffer || []).toString('ascii');
    const match = text.match(/^RFB\s+(\d{3})\.(\d{3})\n$/);
    if (!match) throw new Error(`VNC 服务端返回了非法协议版本：${JSON.stringify(text)}`);
    return { text, major: Number(match[1]), minor: Number(match[2]) };
}

function rfbVersionBytes(minor = 8) {
    const safeMinor = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    return Buffer.from(`RFB 003.${String(safeMinor).padStart(3, '0')}\n`, 'ascii');
}

async function readVncFailureReason(reader, timeout) {
    try {
        const lenBuf = await reader.read(4, timeout, 'VNC 失败原因长度');
        const len = Math.min(lenBuf.readUInt32BE(0), 4096);
        if (!len) return '';
        return (await reader.read(len, timeout, 'VNC 失败原因')).toString('utf8');
    } catch {
        return '';
    }
}

async function authenticateVncServer(socket, reader, conn, version, timeout = 10000) {
    const protocolMinor = Number(version?.minor || 8);
    let securityType = 0;
    if (protocolMinor >= 7) {
        const count = (await reader.read(1, timeout, 'VNC 安全类型数量'))[0];
        if (!count) {
            const reason = await readVncFailureReason(reader, timeout);
            throw new Error(reason || 'VNC 服务端拒绝连接');
        }
        const types = Array.from(await reader.read(count, timeout, 'VNC 安全类型列表'));
        if (types.includes(2) && conn.password) securityType = 2;
        else if (types.includes(1)) securityType = 1;
        else if (types.includes(2)) securityType = 2;
        else throw new Error(`当前 noVNC 代理仅支持 VNC None/VNCAuth，服务端返回安全类型：${types.join(', ')}`);
        socket.write(Buffer.from([securityType]));
    } else {
        const typeBuf = await reader.read(4, timeout, 'VNC 安全类型');
        securityType = typeBuf.readUInt32BE(0);
        if (securityType === 0) {
            const reason = await readVncFailureReason(reader, timeout);
            throw new Error(reason || 'VNC 服务端拒绝连接');
        }
        if (![1, 2].includes(securityType)) throw new Error(`当前 noVNC 代理仅支持 VNC None/VNCAuth，服务端返回安全类型：${securityType}`);
    }

    if (securityType === 2) {
        const challenge = await reader.read(16, timeout, 'VNC 认证挑战');
        socket.write(vncAuthResponse(conn.password || '', challenge));
        const result = (await reader.read(4, timeout, 'VNC 认证结果')).readUInt32BE(0);
        if (result !== 0) {
            const reason = protocolMinor >= 8 ? await readVncFailureReason(reader, timeout) : '';
            throw new Error(reason || 'VNC 密码认证失败');
        }
        return { securityType };
    }

    if (protocolMinor >= 8) {
        const result = (await reader.read(4, timeout, 'VNC 安全结果')).readUInt32BE(0);
        if (result !== 0) {
            const reason = await readVncFailureReason(reader, timeout);
            throw new Error(reason || 'VNC 安全协商失败');
        }
    }
    return { securityType };
}

async function openRoutedTcpConnection(conn, targetPort, timeout = 10000) {
    const plan = resolveRoutePlan(conn);
    const targetHost = String(conn.host || '');
    const port = Number(targetPort) || Number(conn.port) || 0;
    const clients = [];
    try {
        if (!plan.hops.length) {
            const socket = plan.firstProxy ? await openProxyConnection(plan.firstProxy, targetHost, port, timeout) : net.createConnection(port, targetHost);
            if (!plan.firstProxy) await waitForSocket(socket, timeout, 'TCP 连接');
            return { socket, clients, route: plan.firstProxy ? `代理 ${plan.firstProxy.name || plan.firstProxy.host} -> ${conn.name || `${targetHost}:${port}`}` : conn.name || `${targetHost}:${port}` };
        }
        const firstSock = plan.firstProxy ? await openProxyConnection(plan.firstProxy, plan.hops[0].host, plan.hops[0].port, timeout) : undefined;
        let currentClient = await connectSSHClient(plan.hops[0], { timeout, sock: firstSock });
        clients.push(currentClient);
        for (const hop of plan.hops.slice(1)) {
            const tunnel = await forwardOut(currentClient, hop.host, hop.port);
            currentClient = await connectSSHClient(hop, { timeout, sock: tunnel });
            clients.push(currentClient);
        }
        const socket = await forwardOut(currentClient, targetHost, port);
        return { socket, clients, route: [...plan.hops.map((h) => h.routeName || h.name || h.host), conn.name || `${targetHost}:${port}`].join(' -> ') };
    } catch (err) {
        clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        throw err;
    }
}

async function testNoVncConnection(conn, timeout = 10000) {
    const started = Date.now();
    let routed = null;
    let reader = null;
    try {
        routed = await openRoutedTcpConnection(conn, Number(conn.port) || 5900, timeout);
        reader = new ByteQueue('VNC 服务端');
        const onData = (chunk) => reader.push(chunk);
        routed.socket.on('data', onData);
        routed.socket.once('close', () => reader.close(new Error('VNC 服务端已关闭连接')));
        const version = parseRfbVersion(await reader.read(12, timeout, 'VNC 协议版本'));
        routed.socket.write(rfbVersionBytes(Math.min(version.minor || 8, 8)));
        const auth = await authenticateVncServer(routed.socket, reader, conn, version, timeout);
        routed.socket.off('data', onData);
        return { ok: true, code: 'success', message: `VNC 连接成功（noVNC ${routed.route || conn.host}，安全类型 ${auth.securityType === 2 ? 'VNCAuth' : 'None'}）`, durationMs: Date.now() - started };
    } catch (err) {
        const msg = String(err?.message || err || '连接失败');
        const code = /timeout|超时/i.test(msg) ? 'timeout' : /ECONNREFUSED|refused/i.test(msg) ? 'refused' : /auth|认证|password|密码/i.test(msg) ? 'auth_failed' : 'unknown';
        console.warn('[novnc-test]', 'connection failed', { target: conn.host, code, error: msg });
        return { ok: false, code, message: msg, durationMs: Date.now() - started };
    } finally {
        try { reader?.close?.(); } catch {}
        try { routed?.socket?.destroy?.(); } catch {}
        (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
    }
}

function classifyRdpError(err) {
    const msg = String(err?.message || err || '连接失败');
    if (/timed out|timeout|超时/i.test(msg)) return { code: 'timeout', message: 'RDP 连接超时' };
    if (/authentication|auth|logon|password|denied|认证|密码/i.test(msg)) return { code: 'auth_failed', message: 'RDP 认证失败' };
    if (/ECONNREFUSED|refused/i.test(msg)) return { code: 'refused', message: 'RDP 端口被拒绝' };
    if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH|unreachable|No route/i.test(msg)) return { code: 'unreachable', message: '网络不可达或主机不存在' };
    return { code: 'unknown', message: msg };
}

async function testRDPConnection(conn, timeout = 10000) {
    const started = Date.now();
    const targetPort = Number(conn.port) || 3389;
    let routedForward = null;
    let child = null;
    try {
        routedForward = await createRoutedTcpForward(conn, targetPort, timeout);
        const effectiveHost = routedForward?.host || conn.host;
        const effectivePort = routedForward?.port || targetPort;
        await new Promise((resolve, reject) => {
            const args = [
                `/v:${effectiveHost}:${effectivePort}`,
                `/u:${conn.username || 'Administrator'}`,
                `/p:${conn.password || ''}`,
                '/cert:ignore',
                '/auth-only',
                '/log-level:WARN',
            ];
            const timer = setTimeout(() => {
                try { child?.kill('SIGTERM'); } catch {}
                reject(new Error('RDP 认证测试超时'));
            }, timeout);
            child = spawn(process.env.RDP_FREERDP_BIN || 'xfreerdp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
            let errText = '';
            child.stderr?.on('data', (d) => { errText += d.toString('utf8'); });
            child.on('error', reject);
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(errText.trim().slice(0, 300) || `xfreerdp auth-only exited ${code}`));
            });
        });
        return { ok: true, code: 'success', message: `RDP 连接成功（${conn.host}:${targetPort}）`, durationMs: Date.now() - started };
    } catch (err) {
        const classified = classifyRdpError(err);
        console.warn('[rdp-test]', 'connection failed', { target: conn.host, code: classified.code, error: classified.message });
        return { ok: false, ...classified, durationMs: Date.now() - started };
    } finally {
        try { child?.kill('SIGTERM'); } catch {}
        try { routedForward?.close?.(); } catch {}
    }
}

function classifySSHError(err) {
    const msg = String(err?.message || err || '连接失败');
    if (/timed out|timeout/i.test(msg)) return { code: 'timeout', message: '连接超时' };
    if (/authentication|auth|All configured authentication methods failed/i.test(msg)) return { code: 'auth_failed', message: '认证失败' };
    if (/ECONNREFUSED|refused/i.test(msg)) return { code: 'refused', message: '连接被拒绝' };
    if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH|unreachable/i.test(msg)) return { code: 'unreachable', message: '网络不可达或主机不存在' };
    return { code: 'unknown', message: msg };
}

function testSSHConnection(conn, timeout = 10000) {
    return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        let routed = null;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
            resolve({ ...result, durationMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish({ ok: false, ...classifySSHError(new Error('timeout')) }), timeout + 1000);
        createRoutedSSHConnection(conn, timeout)
            .then((result) => { routed = result; finish({ ok: true, code: 'success', message: `连接成功（${result.route}）` }); })
            .catch((err) => finish({ ok: false, ...classifySSHError(err) }));
    });
}

function shellSingleQuote(value) { return "'" + String(value || '').replace(/'/g, "'\\''") + "'"; }

function runRemoteCommand(conn, command, timeoutSeconds = 30, options = {}) {
    return new Promise((resolve) => {
        const signal = options?.signal || null;
        const started = Date.now();
        let settled = false;
        let stdout = '';
        let stderr = '';
        const timeoutMs = Math.max(1, Math.min(Number(timeoutSeconds) || 30, 300)) * 1000;
        let routed = null;
        let activeStream = null;
        let timer = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            try { signal?.removeEventListener?.('abort', abort); } catch {}
            try { activeStream?.destroy?.(); } catch {}
            (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
        };
        const done = (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ connectionId: conn.id, name: conn.name, host: conn.host, stdout, stderr, durationMs: Date.now() - started, ...result });
        };
        const abort = () => done({ status: 'aborted', success: false, error: 'AI 请求已停止' });
        if (signal?.aborted) return abort();
        signal?.addEventListener?.('abort', abort, { once: true });
        timer = setTimeout(() => done({ status: 'timeout', success: false, error: `执行超时（${timeoutSeconds}s）` }), timeoutMs);
        createRoutedSSHConnection(conn, Math.min(timeoutMs, 15000)).then((result) => {
            routed = result;
            if (settled || signal?.aborted) {
                (result?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
                if (!settled) abort();
                return;
            }
            const client = result.client;
            client.exec(`/bin/sh -c ${shellSingleQuote(command)}`, (err, stream) => {
                if (settled || signal?.aborted) {
                    try { stream?.destroy?.(); } catch {}
                    return abort();
                }
                if (err) return done({ status: 'failed', success: false, error: err.message });
                activeStream = stream;
                stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
                stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
                stream.on('close', (code) => done({ status: code === 0 ? 'success' : 'failed', success: code === 0, exitCode: code, error: code === 0 ? '' : (stderr || stdout || `退出码 ${code}`).trim() }));
            });
        }).catch((err) => {
            if (settled) return;
            done({ status: signal?.aborted ? 'aborted' : 'failed', success: false, error: signal?.aborted ? 'AI 请求已停止' : classifySSHError(err).message });
        });
    });
}

function addActivity(message) {
    storage.addActivity({ id: crypto.randomUUID(), time: Date.now(), message, type: 'info' });
}

function trustProxyEnabled() {
    return process.env.TRUST_PROXY === 'true' || process.env.ZEPHYR_TRUST_PROXY === 'true';
}

function requestProto(req) {
    if (trustProxyEnabled()) return String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim() || 'http';
    return req.socket?.encrypted ? 'https' : (req.protocol || 'http');
}

function clientIp(req) {
    const source = trustProxyEnabled() ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : (req.socket.remoteAddress || '');
    return String(source).split(',')[0].trim().replace(/^::ffff:/, '') || 'unknown';
}

function configuredPublicOrigin(req) {
    const configured = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
    if (configured && configured !== 'http://localhost:3000') return configured;
    return `${requestProto(req)}://${req.get('host')}`;
}

function publicOrigin(req) { return configuredPublicOrigin(req); }
function rpIdFromOrigin(origin) { try { return new URL(origin).hostname; } catch { return 'localhost'; } }
function sameOriginAllowed(req) {
    const expected = configuredPublicOrigin(req);
    const values = [req.headers.origin, req.headers.referer].filter(Boolean);
    if (!values.length) return true;
    return values.every((value) => {
        try {
            const got = new URL(String(value));
            const want = new URL(expected);
            return got.protocol === want.protocol && got.host === want.host;
        } catch {
            return false;
        }
    });
}
function requireSameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!sameOriginAllowed(req)) return res.status(403).json({ error: '请求来源不可信' });
    next();
}
function safeSettings(s = storage.getSettings()) {
    const copy = JSON.parse(JSON.stringify(s || {}));
    copy.version = APP_VERSION;
    if (copy.mail?.pass) copy.mail.pass = '******';
    if (copy.captcha?.secretKey) copy.captcha.secretKey = '******';
    if (copy.captcha?.tencentAppSecretKey) copy.captcha.tencentAppSecretKey = '******';
    if (copy.captcha?.tencentSecretKey) copy.captcha.tencentSecretKey = '******';
    if (copy.captcha?.aliyunAccessKeySecret) copy.captcha.aliyunAccessKeySecret = '******';
    if (copy.ai) copy.ai = safeAiSettings(copy.ai);
    return copy;
}
function mergeSecret(oldValue, newValue) { return newValue === '******' ? oldValue : (newValue ?? oldValue ?? ''); }
function normalizeSettingsInput(body) {
    const current = storage.getSettings();
    const next = { ...body };
    if (body.mail) next.mail = { ...(current.mail || {}), ...body.mail, pass: mergeSecret(current.mail?.pass, body.mail.pass) };
    if (body.captcha) next.captcha = {
        ...(current.captcha || {}),
        ...body.captcha,
        provider: normalizeCaptchaProvider(body.captcha.provider || current.captcha?.provider),
        secretKey: mergeSecret(current.captcha?.secretKey, body.captcha.secretKey),
        tencentAppSecretKey: mergeSecret(current.captcha?.tencentAppSecretKey, body.captcha.tencentAppSecretKey),
        tencentSecretKey: mergeSecret(current.captcha?.tencentSecretKey, body.captcha.tencentSecretKey),
        aliyunAccessKeySecret: mergeSecret(current.captcha?.aliyunAccessKeySecret, body.captcha.aliyunAccessKeySecret)
    };
    if (body.ai) {
        next.ai = normalizeAiSettingsInput(current.ai || {}, body.ai || {});
    }
    if (body.appearance) {
        const currentAppearance = current.appearance || {};
        const brandName = String(body.appearance.brandName ?? currentAppearance.brandName ?? 'Zephyr').trim().slice(0, 40) || 'Zephyr';
        const rawIcon = String(body.appearance.brandIcon ?? currentAppearance.brandIcon ?? '🌬️').trim();
        const isAllowedIcon = rawIcon === '🌬️' || /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(rawIcon);
        const colorScheme = ['frost', 'lava', 'asagi', 'cyber', 'custom'].includes(body.appearance.colorScheme) ? body.appearance.colorScheme : (currentAppearance.colorScheme || 'frost');
        const customThemeMode = ['light', 'dark', 'auto'].includes(body.appearance.customThemeMode) ? body.appearance.customThemeMode : (currentAppearance.customThemeMode || 'dark');
        const theme = body.appearance.theme === 'light' || body.appearance.theme === 'dark' ? body.appearance.theme : 'auto';
        const defaultColors = { bgMain: '#101114', bgCard: '#1b1c20', primary: '#0a84ff', primaryHover: '#2997ff', text: '#f4f4f6', textSecondary: '#9a9ca3', border: '#303237', danger: '#ff453a', success: '#32d74b', warning: '#ffd60a' };
        const customColors = Object.fromEntries(Object.entries(defaultColors).map(([key, fallback]) => {
            const value = String(body.appearance.customColors?.[key] || currentAppearance.customColors?.[key] || fallback).trim();
            return [key, /^#[0-9a-f]{6}$/i.test(value) ? value : fallback];
        }));
        const terminalBg = body.appearance.terminalBackground || currentAppearance.terminalBackground || {};
        const terminalBgType = ['none', 'upload', 'url'].includes(terminalBg.type) ? terminalBg.type : 'none';
        const terminalBgUrlRaw = terminalBgType === 'none' ? '' : String(terminalBg.url || '').trim();
        const allowedTerminalBgUrl = /^https?:\/\//i.test(terminalBgUrlRaw) || /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif);base64,/i.test(terminalBgUrlRaw);
        const terminalBackground = {
            type: allowedTerminalBgUrl ? terminalBgType : 'none',
            url: allowedTerminalBgUrl ? terminalBgUrlRaw.slice(0, 20 * 1024 * 1024) : '',
            fit: ['cover', 'contain', 'auto'].includes(terminalBg.fit) ? terminalBg.fit : 'cover',
            opacity: Math.max(0, Math.min(1, Number(terminalBg.opacity ?? 0.35))),
        };
        const rawTerminalFontColor = body.appearance.terminalFontColor !== undefined ? body.appearance.terminalFontColor : (currentAppearance.terminalFontColor ?? '');
        const terminalFontColor = /^#[0-9a-f]{6}$/i.test(String(rawTerminalFontColor || '')) ? String(rawTerminalFontColor) : '';
        next.appearance = {
            ...currentAppearance,
            ...body.appearance,
            brandName,
            brandIcon: isAllowedIcon ? rawIcon : (currentAppearance.brandIcon || '🌬️'),
            theme,
            colorScheme,
            customThemeMode,
            customColors,
            customCss: String(body.appearance.customCss ?? currentAppearance.customCss ?? '').slice(0, 200000),
            customJs: String(body.appearance.customJs ?? currentAppearance.customJs ?? '').slice(0, 200000),
            terminalBackground,
            terminalFontColor,
            autoThemeEnabled: body.appearance.autoThemeEnabled !== false,
        };
        console.info('[appearance-settings]', 'normalized appearance settings', {
            brandName,
            customIcon: next.appearance.brandIcon !== '🌬️',
            theme: next.appearance.theme,
            colorScheme: next.appearance.colorScheme,
            autoThemeEnabled: next.appearance.autoThemeEnabled,
            customCss: !!next.appearance.customCss,
            customJs: !!next.appearance.customJs,
            terminalBackground: next.appearance.terminalBackground.type,
        });
    }
    if (body.beian) {
        next.beian = { ...(current.beian || {}), ...body.beian };
        next.icp = next.beian.icp || '';
        next.icpUrl = next.beian.icpUrl || '';
        next.policeBeian = next.beian.policeBeian || '';
        next.policeBeianUrl = next.beian.policeBeianUrl || '';
        next.showBeian = next.beian.show !== false;
    }
    if (Array.isArray(body.snippets)) {
        next.snippets = body.snippets.slice(0, 500).map((item) => ({
            id: String(item?.id || crypto.randomUUID()).slice(0, 80),
            name: String(item?.name || '').slice(0, 60),
            command: String(item?.command || '').slice(0, 20000),
            group: String(item?.group || '').slice(0, 40),
            autoRun: !!item?.autoRun,
            updatedAt: Number(item?.updatedAt || Date.now()),
        })).filter((item) => item.name && item.command.trim());
    }
    return next;
}

function secureCookieFlag(req) {
    const origin = configuredPublicOrigin(req);
    return origin.startsWith('https://') || requestProto(req) === 'https' ? '; Secure' : '';
}

function sessionClearCookie(req) {
    return `zephyr_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookieFlag(req)}`;
}

function createSession(req, res, user, { remember = false } = {}) {
    const sid = crypto.randomUUID();
    sessions.set(sid, { username: user.username, createdAt: Date.now(), lastSeenAt: Date.now(), remember: !!remember, mustChangePassword: !!user.defaultPassword });
    const maxAgeSeconds = remember ? Math.floor(REMEMBER_SESSION_TTL_MS / 1000) : '';
    const maxAge = maxAgeSeconds ? `; Max-Age=${maxAgeSeconds}` : '';
    res.setHeader('Set-Cookie', `zephyr_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax${secureCookieFlag(req)}${maxAge}`);
    return sid;
}

function isPrivateOrLocalIp(ip) {
    try {
        if (!ip || ip === 'unknown') return true;
        const addr = ipaddr.parse(ip);
        const range = addr.range();
        return ['private', 'loopback', 'linkLocal', 'uniqueLocal', 'unspecified'].includes(range);
    } catch {
        return true;
    }
}

async function regionOf(ip) {
    const normalizedIp = String(ip || '').trim();
    if (!normalizedIp || normalizedIp === 'unknown') return '';
    if (isPrivateOrLocalIp(normalizedIp)) {
        console.info('[IP-GEO] 跳过本地/私有地址查询', { ip: normalizedIp });
        return '本地/内网';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
        const url = `http://ip-api.com/json/${encodeURIComponent(normalizedIp)}?fields=status,country,city,message,query`;
        console.info('[IP-GEO] 开始查询 IP 地区', { ip: normalizedIp, provider: 'ip-api.com' });
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== 'success') {
            console.warn('[IP-GEO] 查询失败', { ip: normalizedIp, httpStatus: response.status, status: data.status || '', message: data.message || '' });
            return '未查询';
        }
        const country = String(data.country || '').trim();
        const city = String(data.city || '').trim();
        const region = [country, city].filter(Boolean).join('/');
        console.info('[IP-GEO] 查询成功', { ip: normalizedIp, query: data.query || '', region: region || '未查询' });
        return region || '未查询';
    } catch (err) {
        console.warn('[IP-GEO] 查询异常', { ip: normalizedIp, error: err.message });
        return '未查询';
    } finally {
        clearTimeout(timer);
    }
}
function publicMailDebug(mail = {}, to = '') {
    return {
        enabled: !!mail.enabled,
        host: mail.host || '',
        port: Number(mail.port) || 465,
        secure: mail.secure !== false,
        user: mail.user ? '******' : '',
        from: mail.from || mail.user || '',
        to: to || mail.adminEmail || '',
        hasPass: !!mail.pass,
    };
}
function validateMailConfig(mail = {}, to = '') {
    const recipient = String(to || mail.adminEmail || '').trim();
    if (!mail.enabled) throw new Error('邮件通知未启用，请先保存并启用邮件通知');
    if (!mail.host) throw new Error('SMTP Host 未配置');
    if (!recipient) throw new Error('收件人邮箱未配置，请填写后台管理员邮箱');
    if (!mail.from && !mail.user) throw new Error('发件人或 SMTP 用户名未配置');
    return recipient;
}
function mailTransport(mail) {
    console.debug('[MAIL] 创建 SMTP 传输器:', publicMailDebug(mail));
    return nodemailer.createTransport({ host: mail.host, port: Number(mail.port) || 465, secure: mail.secure !== false, auth: mail.user ? { user: mail.user, pass: mail.pass || '' } : undefined });
}
async function sendMail(subject, text, to) {
    const mail = storage.getSettings().mail || {};
    const recipient = validateMailConfig(mail, to);
    const info = await mailTransport(mail).sendMail({ from: mail.from || mail.user, to: recipient, subject, text });
    console.info('[MAIL] 邮件发送成功:', { to: recipient, subject, messageId: info?.messageId || '' });
    return { ok: true, messageId: info?.messageId || '' };
}
async function notifyLogin({ username, ip, userAgent, success, reason }) {
    const s = storage.getSettings();
    const mail = s.mail || {};
    const region = mail.geoLookupEnabled ? await regionOf(ip) : '';
    storage.addLoginEvent({ id: crypto.randomUUID(), username, ip, region, userAgent, success, reason, time: Date.now() });
    if (!mail.enabled || (success && !mail.notifyLoginSuccess) || (!success && !mail.notifyLoginFailure)) return;
    const title = success ? 'Zephyr 登录成功通知' : 'Zephyr 登录失败通知';
    const text = `${title}\n\n时间：${new Date().toLocaleString()}\n账号：${username || '-'}\nIP地址：${ip}\n地区：${region || '-'}\n${success ? '' : `失败原因：${reason || '-'}\n`}User-Agent：${userAgent || '-'}`;
    sendMail(title, text).catch((err) => console.error('[MAIL] 登录通知失败:', err.message));
}

function normalizeCaptchaProvider(provider) {
    const value = String(provider || 'turnstile').toLowerCase();
    if (value === 'recaptcha' || value === 'google-recaptcha') return 'google';
    if (['turnstile', 'hcaptcha', 'google', 'tencent', 'aliyun'].includes(value)) return value;
    return 'turnstile';
}

function parseCaptchaToken(token) {
    if (typeof token !== 'string') return token || {};
    try { return JSON.parse(token); } catch { return token; }
}

function hmacSha256(key, value, encoding) {
    return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function tencentTc3Sign({ secretId, secretKey, service, host, action, version, region = '', payload }) {
    const algorithm = 'TC3-HMAC-SHA256';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const hashedRequestPayload = sha256Hex(payload);
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
    const secretDate = hmacSha256(`TC3${secretKey}`, date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign, 'hex');
    return {
        authorization: `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        timestamp,
        region,
        version
    };
}

async function verifyTencentCaptcha(captcha, token, remoteIp) {
    const parsed = parseCaptchaToken(token);
    const ticket = parsed?.ticket || parsed?.Ticket || '';
    const randstr = parsed?.randstr || parsed?.Randstr || '';
    const captchaAppId = captcha.tencentCaptchaAppId || captcha.siteKey || '';
    const appSecretKey = captcha.tencentAppSecretKey || captcha.secretKey || '';
    const secretId = captcha.tencentSecretId || process.env.TENCENT_SECRET_ID || '';
    const secretKey = captcha.tencentSecretKey || process.env.TENCENT_SECRET_KEY || '';
    if (!ticket || !randstr || !captchaAppId || !appSecretKey) return { ok: false, message: '腾讯云验证码参数不完整' };

    const payload = JSON.stringify({ CaptchaType: 9, Ticket: ticket, Randstr: randstr, CaptchaAppId: Number(captchaAppId) || captchaAppId, AppSecretKey: appSecretKey, UserIp: remoteIp || '' });

    if (!secretId || !secretKey) {
        const params = new URLSearchParams({ aid: captchaAppId, AppSecretKey: appSecretKey, Ticket: ticket, Randstr: randstr, UserIP: remoteIp || '' });
        const response = await fetch('https://ssl.captcha.qq.com/ticket/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
        const data = await response.json().catch(() => ({}));
        return { ok: data.response === '1' || data.CaptchaCode === 1, message: data.err_msg || data.CaptchaMsg || '' };
    }

    const host = 'captcha.tencentcloudapi.com';
    const service = 'captcha';
    const action = 'DescribeCaptchaResult';
    const version = '2019-07-22';
    const signed = tencentTc3Sign({ secretId, secretKey, service, host, action, version, payload });
    const response = await fetch(`https://${host}`, {
        method: 'POST',
        headers: {
            Authorization: signed.authorization,
            'Content-Type': 'application/json; charset=utf-8',
            Host: host,
            'X-TC-Action': action,
            'X-TC-Timestamp': String(signed.timestamp),
            'X-TC-Version': signed.version,
            ...(signed.region ? { 'X-TC-Region': signed.region } : {})
        },
        body: payload
    });
    const data = await response.json().catch(() => ({}));
    const result = data.Response || {};
    return { ok: Number(result.CaptchaCode) === 1, message: result.CaptchaMsg || data.Response?.Error?.Message || '' };
}

function aliyunPercentEncode(value) {
    return encodeURIComponent(String(value)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function parseAliyunAccessKeys(captcha) {
    const rawSecret = captcha.aliyunAccessKeySecret || captcha.secretKey || '';
    const rawId = captcha.aliyunAccessKeyId || process.env.ALIYUN_ACCESS_KEY_ID || '';
    if (rawSecret.includes(':')) {
        const [accessKeyId, ...secretParts] = rawSecret.split(':');
        return { accessKeyId: accessKeyId.trim(), accessKeySecret: secretParts.join(':').trim() };
    }
    return { accessKeyId: rawId, accessKeySecret: rawSecret };
}

async function verifyAliyunCaptcha(captcha, token) {
    const captchaVerifyParam = typeof token === 'string' ? token : JSON.stringify(token || {});
    const { accessKeyId, accessKeySecret } = parseAliyunAccessKeys(captcha);
    if (!captchaVerifyParam || !accessKeyId || !accessKeySecret) return { ok: false, message: '阿里云验证码参数不完整：Secret Key 请填写 AccessKeyId:AccessKeySecret，或通过环境变量 ALIYUN_ACCESS_KEY_ID 提供 AccessKeyId' };
    const params = {
        AccessKeyId: accessKeyId,
        Action: 'VerifyCaptcha',
        CaptchaVerifyParam: captchaVerifyParam,
        Format: 'JSON',
        RegionId: captcha.aliyunRegionId || process.env.ALIYUN_CAPTCHA_REGION || 'cn-shanghai',
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: new Date().toISOString(),
        Version: '2023-03-05'
    };
    const canonicalizedQuery = Object.keys(params).sort().map((key) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`).join('&');
    const stringToSign = `GET&%2F&${aliyunPercentEncode(canonicalizedQuery)}`;
    params.Signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
    const url = `https://captcha.cn-shanghai.aliyuncs.com/?${Object.keys(params).sort().map((key) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(params[key])}`).join('&')}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    return { ok: data.Result === true || data.Result?.VerifyResult === true || data.Data?.Result === true || data.Success === true, message: data.Message || data.Code || '' };
}

async function verifyCaptcha(provider, token, remoteIp) {
    const captcha = storage.getSettings().captcha || {};
    if (!captcha.enabled) return true;
    const normalizedProvider = normalizeCaptchaProvider(provider || captcha.provider);
    if (!token) {
        console.warn('[captcha-verify]', 'missing token', { provider: normalizedProvider, remoteIp });
        return false;
    }
    try {
        if (normalizedProvider === 'turnstile' || normalizedProvider === 'hcaptcha' || normalizedProvider === 'google') {
            const url = normalizedProvider === 'turnstile'
                ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
                : normalizedProvider === 'hcaptcha'
                    ? 'https://hcaptcha.com/siteverify'
                    : 'https://www.google.com/recaptcha/api/siteverify';
            const body = new URLSearchParams({ secret: captcha.secretKey || '', response: token, remoteip: remoteIp });
            const r = await fetch(url, { method: 'POST', body });
            const data = await r.json().catch(() => ({}));
            console.info('[captcha-verify]', 'siteverify result', { provider: normalizedProvider, success: !!data.success, errors: data['error-codes'] || [] });
            return !!data.success;
        }
        if (normalizedProvider === 'tencent') {
            const result = await verifyTencentCaptcha(captcha, token, remoteIp);
            console.info('[captcha-verify]', 'tencent result', { success: result.ok, message: result.message || '' });
            return !!result.ok;
        }
        if (normalizedProvider === 'aliyun') {
            const result = await verifyAliyunCaptcha(captcha, token);
            console.info('[captcha-verify]', 'aliyun result', { success: result.ok, message: result.message || '' });
            return !!result.ok;
        }
        console.warn('[captcha-verify]', 'unsupported provider', { provider: normalizedProvider });
        return false;
    } catch (err) {
        console.error('[captcha-verify]', 'verification failed', { provider: normalizedProvider, error: err.message });
        return false;
    }
}

function ipAllowed(ip, listText) {
    const rules = String(listText || '').split(/[\n,\s]+/).map((v) => v.trim()).filter(Boolean);
    if (!rules.length) return true;
    try {
        const addr = ipaddr.parse(ip);
        return rules.some((rule) => {
            try { return rule.includes('/') ? addr.match(ipaddr.parseCIDR(rule)) : addr.toString() === ipaddr.parse(rule).toString(); } catch { return false; }
        });
    } catch { return false; }
}
function checkLoginGuards(req) {
    const ip = clientIp(req), s = storage.getSettings(), sec = s.security || {};
    if (sec.ipWhitelistEnabled && !ipAllowed(ip, sec.ipWhitelist)) return { ok: false, ip, reason: 'IP 不在白名单' };
    const ban = storage.getIpBan(ip);
    if (sec.bruteForceEnabled && ban?.bannedUntil && ban.bannedUntil > Date.now()) return { ok: false, ip, reason: 'IP 已被临时封禁' };
    return { ok: true, ip };
}
function recordLoginFailure(ip) {
    const sec = storage.getSettings().security || {};
    if (!sec.bruteForceEnabled || !ip || ip === 'unknown') return;
    const old = storage.getIpBan(ip) || { ip, failedCount: 0, bannedUntil: null };
    const failedCount = Number(old.failedCount || 0) + 1;
    const max = Number(sec.bruteForceMaxFailures) || 5;
    const bannedUntil = failedCount >= max ? Date.now() + (Number(sec.bruteForceBanMinutes) || 15) * 60000 : old.bannedUntil;
    storage.saveIpBan({ ip, failedCount, bannedUntil, updatedAt: Date.now() });
}
function recordLoginSuccess(ip) { if (ip && ip !== 'unknown') storage.clearIpBan(ip); }

function defaultPasswordRemoteLoginAllowed(req, user) {
    if (!user?.defaultPassword) return true;
    if (process.env.ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN === 'true') return true;
    return isPrivateOrLocalIp(clientIp(req));
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function encryptionKey(password = process.env.ENCRYPTION_KEY || 'please-change-this-key') { return crypto.createHash('sha256').update(String(password)).digest(); }
function encryptBuffer(buffer, password) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(password), iv); const enc = Buffer.concat([cipher.update(buffer), cipher.final()]); return Buffer.concat([Buffer.from('ZEPHYR3'), iv, cipher.getAuthTag(), enc]); }
function decryptBuffer(buffer, password) { const b = Buffer.from(buffer); if (b.slice(0, 7).toString() !== 'ZEPHYR3') throw new Error('备份格式不正确'); const iv = b.slice(7, 19), tag = b.slice(19, 35), enc = b.slice(35); const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(password), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(enc), decipher.final()]); }
async function zipBuffer(files) {
    return new Promise((resolve, reject) => {
        const chunks = []; const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('data', (c) => chunks.push(c)); archive.on('error', reject); archive.on('end', () => resolve(Buffer.concat(chunks)));
        Object.entries(files).forEach(([name, content]) => archive.append(content, { name })); archive.finalize();
    });
}

initData();
app.use(express.json({ limit: '24mb' }));
app.use(requireSameOrigin);

app.post('/api/auth/login', async (req, res) => {
    const { username, password, captchaToken, remember } = req.body || {};
    const guard = checkLoginGuards(req);
    const ua = req.headers['user-agent'] || '';
    if (!guard.ok) { await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: guard.reason }); return res.status(403).json({ error: guard.reason }); }
    const s = storage.getSettings();
    if (!(await verifyCaptcha(s.captcha?.provider, captchaToken, guard.ip))) { recordLoginFailure(guard.ip); await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: 'CAPTCHA 错误' }); return res.status(400).json({ error: '人机验证失败' }); }
    const user = storage.getUser(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
        recordLoginFailure(guard.ip);
        await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: '密码错误' });
        return res.status(401).json({ error: '账号或密码错误' });
    }
    if (!defaultPasswordRemoteLoginAllowed(req, user)) {
        recordLoginFailure(guard.ip);
        await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: false, reason: '默认密码禁止公网登录' });
        return res.status(403).json({ error: '默认密码只允许从本机或内网登录，请先在安全环境修改默认密码' });
    }
    if (user.totpEnabled) {
        const tempToken = crypto.randomUUID();
        tempTotpTokens.set(tempToken, { username: user.username, createdAt: Date.now(), ip: guard.ip, userAgent: ua, remember: !!remember });
        return res.json({ ok: true, requireTotp: true, tempToken });
    }
    recordLoginSuccess(guard.ip);
    createSession(req, res, user, { remember: !!remember });
    addActivity(`用户登录：${user.username}`);
    await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: true, reason: '' });
    res.json({ ok: true, user: { username: user.username }, mustChangePassword: !!user.defaultPassword });
});

app.post('/api/auth/totp/verify', async (req, res) => {
    const { tempToken, code } = req.body || {};
    const tmp = tempTotpTokens.get(tempToken);
    if (!tmp || Date.now() - tmp.createdAt > 5 * 60000) return res.status(400).json({ error: '验证会话已过期' });
    const user = storage.getUser(tmp.username);
    if (!user?.totpSecret || !verifySync({ secret: user.totpSecret, token: String(code || '') }).valid) { recordLoginFailure(tmp.ip); await notifyLogin({ username: tmp.username, ip: tmp.ip, userAgent: tmp.userAgent, success: false, reason: 'TOTP 错误' }); return res.status(401).json({ error: '动态验证码错误' }); }
    tempTotpTokens.delete(tempToken); recordLoginSuccess(tmp.ip); createSession(req, res, user, { remember: !!tmp.remember }); addActivity(`用户登录：${user.username}`); await notifyLogin({ username: user.username, ip: tmp.ip, userAgent: tmp.userAgent, success: true, reason: '' });
    res.json({ ok: true, user: { username: user.username }, mustChangePassword: !!user.defaultPassword });
});

app.post('/api/auth/forgot-password/request', async (req, res) => {
    const ip = clientIp(req), nowTs = Date.now();
    const hits = (resetRequestHits.get(ip) || []).filter((t) => nowTs - t < 10 * 60000);
    if (hits.length >= 5) return res.json({ ok: true, message: '如果邮箱匹配，验证码将发送到邮箱' });
    resetRequestHits.set(ip, [...hits, nowTs]);
    const { email, captchaToken } = req.body || {}, s = storage.getSettings();
    if (!(await verifyCaptcha(s.captcha?.provider, captchaToken, ip))) return res.json({ ok: true, message: '如果邮箱匹配，验证码将发送到邮箱' });
    const user = storage.getFirstUser(); const adminEmail = s.mail?.adminEmail || user?.email || '';
    if (user && adminEmail && String(email || '').trim().toLowerCase() === String(adminEmail).toLowerCase()) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        storage.createResetCode({ id: crypto.randomUUID(), username: user.username, email: adminEmail, codeHash: sha256(code), expiresAt: Date.now() + 10 * 60000, createdAt: Date.now() });
        sendMail('Zephyr 密码重置验证码', `Zephyr 密码重置验证码：${code}\n有效期：10 分钟。`, adminEmail).catch((err) => console.error('[MAIL] 重置验证码发送失败:', err.message));
    }
    res.json({ ok: true, message: '如果邮箱匹配，验证码将发送到邮箱' });
});

app.post('/api/auth/forgot-password/reset', (req, res) => {
    const { email, code, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
    const user = storage.getFirstUser(); const adminEmail = storage.getSettings().mail?.adminEmail || user?.email || '';
    const rec = user ? storage.findResetCode(user.username, adminEmail) : null;
    if (!user || !adminEmail || String(email || '').toLowerCase() !== String(adminEmail).toLowerCase() || !rec || rec.expiresAt < Date.now() || rec.codeHash !== sha256(code)) return res.status(400).json({ error: '验证码无效或已过期' });
    storage.updateUser(user.username, { passwordHash: hashPassword(newPassword), defaultPassword: false }); storage.markResetCodeUsed(rec.id); addActivity('通过邮箱验证码重置密码');
    res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req).zephyr_sid;
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', sessionClearCookie(req));
    res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: { username: req.session.username }, mustChangePassword: !!req.session.mustChangePassword });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
    const data = readJSON(USERS_FILE, { users: [] });
    const user = data.users.find((u) => u.username === req.session.username);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) return res.status(400).json({ error: '当前密码错误' });
    user.passwordHash = hashPassword(newPassword);
    user.defaultPassword = false;
    user.updatedAt = Date.now();
    writeJSON(USERS_FILE, data);
    req.session.mustChangePassword = false;
    res.json({ ok: true });
});

app.post('/api/security/totp/setup', requireAuth, async (req, res) => {
    const user = storage.getUser(req.session.username); const secret = generateSecret();
    const otpauth = generateURI({ label: user.username, issuer: 'Zephyr', secret }); const qr = await QRCode.toDataURL(otpauth);
    req.session.pendingTotpSecret = secret; res.json({ secret, qr });
});
app.post('/api/security/totp/enable', requireAuth, (req, res) => {
    const secret = req.session.pendingTotpSecret; if (!secret || !verifySync({ secret, token: String(req.body?.code || '') }).valid) return res.status(400).json({ error: '动态验证码错误' });
    storage.updateUser(req.session.username, { totpEnabled: true, totpSecret: secret }); delete req.session.pendingTotpSecret; addActivity('开启 TOTP 两步验证'); res.json({ ok: true });
});
app.post('/api/security/totp/disable', requireAuth, (req, res) => {
    const user = storage.getUser(req.session.username); const { currentPassword, code } = req.body || {};
    if (!verifyPassword(currentPassword, user.passwordHash) || !verifySync({ secret: user.totpSecret || '', token: String(code || '') }).valid) return res.status(400).json({ error: '密码或动态验证码错误' });
    storage.updateUser(user.username, { totpEnabled: false, totpSecret: null }); addActivity('关闭 TOTP 两步验证'); res.json({ ok: true });
});
app.get('/api/security/status', requireAuth, (req, res) => { const u = storage.getUser(req.session.username); res.json({ user: { username: u.username, email: u.email || '', totpEnabled: !!u.totpEnabled }, passkeys: storage.listPasskeys(u.username).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) }); });
app.put('/api/security/profile', requireAuth, (req, res) => {
    const nextUsername = String(req.body?.username || '').trim();
    if (!nextUsername) return res.status(400).json({ error: '用户名不能为空' });
    if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(nextUsername)) return res.status(400).json({ error: '用户名需为 2-32 位字母、数字或 ._@-' });
    try {
        let u = storage.updateUser(req.session.username, { email: String(req.body?.email || '') });
        if (nextUsername !== req.session.username) {
            u = storage.renameUser(req.session.username, nextUsername);
            req.session.username = nextUsername;
            addActivity(`修改登录用户名：${nextUsername}`);
        }
        res.json({ user: { username: u.username, email: u.email || '', totpEnabled: !!u.totpEnabled } });
    } catch (err) {
        res.status(400).json({ error: err.message || '修改资料失败' });
    }
});

app.get('/api/connections', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    res.json({ connections: (store.connections || []).map(publicConnection), activities: store.activities || [] });
});

app.post('/api/connections', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const body = req.body || {};
    const protocol = String(body.protocol || 'SSH').toUpperCase();
    if (!body.name || !body.host || (protocol === 'SSH' && !body.username)) return res.status(400).json({ error: protocol === 'SSH' ? '名称、主机、用户名不能为空' : '名称、主机不能为空' });
    const conn = {
        id: crypto.randomUUID(),
        name: String(body.name).trim(),
        host: String(body.host).trim(),
        port: Number(body.port) || (protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : 22),
        protocol,
        username: String(body.username || '').trim(),
        password: String(body.password || ''),
        privateKey: String(body.privateKey || ''),
        sshKeyId: String(body.sshKeyId || ''),
        remark: String(body.remark || ''),
        tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : String(body.tags || '').split(',').map((v) => v.trim()).filter(Boolean),
        connectionMode: ['direct', 'proxy', 'jump'].includes(body.connectionMode) ? body.connectionMode : 'direct',
        proxyId: body.proxyId || null,
        jumpHostId: body.jumpHostId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastConnectedAt: null,
    };
    applyConnectionRouteFields(conn, body);
    store.connections.unshift(conn);
    store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `新增连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ connection: publicConnection(conn) });
});

app.put('/api/connections/:id', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const conn = (store.connections || []).find((c) => c.id === req.params.id);
    if (!conn) return res.status(404).json({ error: '连接不存在' });
    const body = req.body || {};
    ['name', 'host', 'username', 'remark'].forEach((key) => { if (body[key] !== undefined) conn[key] = String(body[key]); });
    if (body.port !== undefined) conn.port = Number(body.port) || 22;
    if (body.protocol !== undefined) conn.protocol = String(body.protocol).toUpperCase();
    if (body.tags !== undefined) conn.tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : String(body.tags || '').split(',').map((v) => v.trim()).filter(Boolean);
    if (body.sshKeyId !== undefined) conn.sshKeyId = String(body.sshKeyId || '');
    applyConnectionRouteFields(conn, body);
    if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
    if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
    conn.updatedAt = Date.now();
    store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `编辑连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ connection: publicConnection(conn) });
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const target = (store.connections || []).find((c) => c.id === req.params.id);
    store.connections = (store.connections || []).filter((c) => c.id !== req.params.id);
    if (target) store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `删除连接：${target.name}` }, ...(store.activities || [])].slice(0, 20);
    writeJSON(CONNECTIONS_FILE, store);
    res.json({ ok: true });
});

app.post('/api/connections/:id/open', requireAuth, (req, res) => {
    const store = readJSON(CONNECTIONS_FILE, { connections: [], activities: [] });
    const conn = (store.connections || []).find((c) => c.id === req.params.id);
    if (!conn) return res.status(404).json({ error: '连接不存在' });
    const reveal = req.body?.purpose === 'reveal' || req.body?.secret !== undefined;
    try {
        if (reveal) {
            const auth = verifySensitiveAccess(req, req.body?.secret);
            console.info('[secret-open] reveal connection secrets', { connectionId: conn.id, name: conn.name, authMethod: auth.method });
            return res.json({ connection: { ...conn, jumpHostIds: normalizeJumpHostIds(conn) } });
        }
        conn.jumpHostIds = normalizeJumpHostIds(conn);
        conn.lastConnectedAt = Date.now();
        store.activities = [{ id: crypto.randomUUID(), time: Date.now(), message: `打开连接：${conn.name}` }, ...(store.activities || [])].slice(0, 20);
        writeJSON(CONNECTIONS_FILE, store);
        res.json({ connection: publicConnection(conn) });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.get('/api/settings', requireAuth, (req, res) => res.json(safeSettings(storage.getSettings())));

app.put('/api/settings', requireAuth, (req, res) => {
    const body = normalizeSettingsInput(req.body || {});
    if (body.security?.ipWhitelistEnabled && !ipAllowed(clientIp(req), body.security.ipWhitelist)) return res.status(400).json({ error: '当前 IP 不在白名单内，已阻止启用以避免误锁' });
    const settings = storage.updateSettings(body);
    addActivity('更新系统设置');
    res.json(safeSettings(settings));
});

app.post('/api/settings/test-mail', requireAuth, async (req, res) => {
    const to = String(req.body?.to || storage.getSettings().mail?.adminEmail || '').trim();
    const mail = storage.getSettings().mail || {};
    console.info('[MAIL] 开始发送测试邮件:', publicMailDebug(mail, to));
    try {
        const result = await sendMail('Zephyr 测试邮件', `这是一封 Zephyr 测试邮件。\n时间：${new Date().toLocaleString()}`, to);
        addActivity(`发送测试邮件：${to || mail.adminEmail}`);
        res.json({ ok: true, message: '测试邮件已发送', messageId: result.messageId || '' });
    } catch (err) {
        console.error('[MAIL] 测试邮件发送失败:', { ...publicMailDebug(mail, to), error: err.message });
        res.status(400).json({ error: err.message || '测试邮件发送失败' });
    }
});

app.post('/api/settings/mail/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const mail = storage.getSettings().mail || {};
        console.info('[MAIL] 读取已保存 SMTP 密码:', { ...publicMailDebug(mail), authMethod: auth.method });
        res.json({ pass: mail.pass || '', hasPass: !!mail.pass });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.post('/api/settings/captcha/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const captcha = storage.getSettings().captcha || {};
        const normalizedProvider = normalizeCaptchaProvider(captcha.provider || 'turnstile');
        const secretKey = captcha.secretKey || captcha.tencentAppSecretKey || captcha.aliyunAccessKeySecret || '';
        console.info('[captcha-open] reveal saved captcha secret', { provider: normalizedProvider, hasSecretKey: !!secretKey, authMethod: auth.method });
        res.json({
            provider: normalizedProvider,
            secretKey,
            tencentAppSecretKey: captcha.tencentAppSecretKey || captcha.secretKey || '',
            tencentSecretKey: captcha.tencentSecretKey || '',
            aliyunAccessKeySecret: captcha.aliyunAccessKeySecret || captcha.secretKey || '',
            hasSecretKey: !!secretKey
        });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.get('/api/security/ip-bans', requireAuth, (req, res) => res.json({ bans: storage.listIpBans() }));
app.delete('/api/security/ip-bans/:ip', requireAuth, (req, res) => { storage.clearIpBan(req.params.ip); res.json({ ok: true }); });
app.get('/api/security/login-events', requireAuth, (req, res) => res.json({ events: storage.listLoginEvents(100) }));
app.delete('/api/security/login-events', requireAuth, (req, res) => { storage.clearLoginEvents(); addActivity('清理登录事件日志'); res.json({ ok: true }); });
app.delete('/api/activities', requireAuth, (req, res) => { storage.clearActivities(); res.json({ ok: true }); });

registerAiRoutes(app, {
    requireAuth,
    storage,
    readJSON,
    writeJSON,
    CONNECTIONS_FILE,
    createRoutedSSHConnection,
    runRemoteCommand,
    testConnection: async (conn, timeoutSeconds = 10) => {
        const protocol = String(conn.protocol || 'SSH').toUpperCase();
        const timeoutMs = Math.max(1000, Math.min(Number(timeoutSeconds || 10) * 1000, 30000));
        return protocol === 'SSH'
            ? testSSHConnection(conn, timeoutMs)
            : protocol === 'VNC'
                ? testNoVncConnection(conn, timeoutMs)
                : protocol === 'RDP'
                    ? testRDPConnection(conn, timeoutMs)
                    : { ok: false, code: 'unsupported_protocol', message: `不支持的协议：${protocol}`, durationMs: 0 };
    },
    addActivity,
    verifySensitiveAccess,
    upload,
});

app.get('/api/public/settings', (req, res) => {
    const s = storage.getSettings();
    const user = storage.getFirstUser();
    const captcha = s.captcha || {};
    const appearance = s.appearance || {};
    res.json({
        defaultUsername: user?.username || 'admin',
        appearance: {
            brandName: String(appearance.brandName || 'Zephyr').slice(0, 40) || 'Zephyr',
            brandIcon: String(appearance.brandIcon || '🌬️'),
            theme: appearance.theme === 'light' || appearance.theme === 'dark' ? appearance.theme : 'auto',
            autoThemeEnabled: appearance.autoThemeEnabled !== false,
            colorScheme: ['frost', 'lava', 'asagi', 'cyber', 'custom'].includes(appearance.colorScheme) ? appearance.colorScheme : 'frost',
            customThemeMode: ['light', 'dark', 'auto'].includes(appearance.customThemeMode) ? appearance.customThemeMode : 'dark',
            customColors: appearance.customColors || {},
            customCss: String(appearance.customCss || ''),
            customJs: String(appearance.customJs || ''),
        },
        icp: s.icp || s.beian?.icp || '',
        icpUrl: s.icpUrl || s.beian?.icpUrl || '',
        policeBeian: s.policeBeian || s.beian?.policeBeian || '',
        policeBeianUrl: s.policeBeianUrl || s.beian?.policeBeianUrl || '',
        showBeian: s.showBeian !== false && s.beian?.show !== false,
        captcha: {
            enabled: !!captcha.enabled,
            provider: normalizeCaptchaProvider(captcha.provider || 'turnstile'),
            siteKey: captcha.siteKey || captcha.tencentCaptchaAppId || captcha.aliyunCaptchaId || captcha.aliyunSceneId || '',
            tencentCaptchaAppId: captcha.tencentCaptchaAppId || captcha.siteKey || '',
            aliyunCaptchaId: captcha.aliyunCaptchaId || captcha.siteKey || '',
            aliyunSceneId: captcha.aliyunSceneId || captcha.siteKey || ''
        }
    });
});

app.get('/api/passkeys', requireAuth, (req, res) => res.json({ passkeys: storage.listPasskeys(req.session.username).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) }));
app.post('/api/passkeys/register/options', requireAuth, async (req, res) => {
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin), user = storage.getUser(req.session.username);
    const options = await generateRegistrationOptions({ rpName: 'Zephyr', rpID, userID: Buffer.from(user.username), userName: user.username, attestationType: 'none', excludeCredentials: storage.listPasskeys(user.username).map((p) => ({ id: p.credentialId, transports: p.transports })) });
    webauthnChallenges.set(`reg:${user.username}`, { challenge: options.challenge, origin, rpID }); res.json(options);
});
app.post('/api/passkeys/register/verify', requireAuth, async (req, res) => {
    const state = webauthnChallenges.get(`reg:${req.session.username}`); if (!state) return res.status(400).json({ error: '注册会话已过期' });
    try {
        const result = await verifyRegistrationResponse({ response: req.body, expectedChallenge: state.challenge, expectedOrigin: state.origin, expectedRPID: state.rpID });
        if (!result.verified) return res.status(400).json({ error: 'Passkey 验证失败' });
        const info = result.registrationInfo;
        storage.savePasskey({ id: crypto.randomUUID(), username: req.session.username, credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString('base64'), counter: info.credential.counter || 0, transports: req.body?.response?.transports || [], createdAt: Date.now(), lastUsedAt: null });
        webauthnChallenges.delete(`reg:${req.session.username}`); addActivity('绑定 Passkey'); res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message || 'Passkey 注册失败' }); }
});
app.delete('/api/passkeys/:id', requireAuth, (req, res) => { storage.deletePasskey(req.session.username, req.params.id); addActivity('删除 Passkey'); res.json({ ok: true }); });
app.post('/api/passkeys/login/options', async (req, res) => {
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin), user = storage.getFirstUser(), passkeys = user ? storage.listPasskeys(user.username) : [];
    if (!passkeys.length) return res.status(400).json({ error: '当前账号尚未绑定 Passkey' });
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })) });
    webauthnChallenges.set('login', { challenge: options.challenge, origin, rpID }); res.json(options);
});
app.post('/api/passkeys/login/verify', async (req, res) => {
    const credId = req.body?.id; const passkey = storage.getPasskeyByCredentialId(credId); if (!passkey) return res.status(400).json({ error: 'Passkey 不存在' });
    const state = webauthnChallenges.get('login');
    if (!state) return res.status(400).json({ error: 'Passkey 登录会话已过期' });
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin);
    try {
        const result = await verifyAuthenticationResponse({ response: req.body, expectedChallenge: state?.challenge || req.body?.challenge, expectedOrigin: state?.origin || origin, expectedRPID: state?.rpID || rpID, credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, 'base64'), counter: passkey.counter || 0, transports: passkey.transports } });
        if (!result.verified) return res.status(400).json({ error: 'Passkey 登录失败' });
        webauthnChallenges.delete('login'); storage.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter); const user = storage.getUser(passkey.username); createSession(req, res, user); addActivity(`Passkey 登录：${user.username}`); res.json({ ok: true, mustChangePassword: !!user.defaultPassword });
    } catch (err) { res.status(400).json({ error: err.message || 'Passkey 登录失败' }); }
});

app.get('/api/data/export', requireAuth, async (req, res) => {
    try { storage.rawDb().pragma('wal_checkpoint(FULL)'); } catch (err) { console.error('[DB] WAL checkpoint failed:', err.message); }
    const files = { 'zephyr.db': fs.readFileSync(path.join(DATA_DIR, 'zephyr.db')), 'manifest.json': JSON.stringify({ app: 'Zephyr', version: APP_VERSION, exportedAt: Date.now(), dataEncryption: secretCrypto.ALG }, null, 2) };
    const keyBackup = secretCrypto.getKeyBackupFile();
    if (keyBackup) files[keyBackup.archivePath] = fs.readFileSync(keyBackup.filePath);
    const encrypted = encryptBuffer(await zipBuffer(files), process.env.ENCRYPTION_KEY);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="zephyr-backup-${stamp}.zip.enc"`); res.end(encrypted);
});
app.post('/api/data/import', requireAuth, upload.single('backup'), async (req, res) => {
    try {
        const { loginPassword, backupPassword } = req.body || {}; const user = storage.getUser(req.session.username);
        if (!verifyPassword(loginPassword, user.passwordHash)) return res.status(403).json({ error: '登录密码错误' });
        if (!req.file?.buffer) return res.status(400).json({ error: '请上传备份文件' });
        const zip = decryptBuffer(req.file.buffer, backupPassword || process.env.ENCRYPTION_KEY); const dir = await unzipper.Open.buffer(zip); const dbEntry = dir.files.find((f) => f.path === 'zephyr.db');
        if (!dbEntry) return res.status(400).json({ error: '备份包缺少 zephyr.db' });
        const keyEntry = dir.files.find((f) => f.path === 'crypto/ml-kem-768-keypair.json');
        const incomingKeyBuffer = keyEntry ? await keyEntry.buffer() : null;
        const oldKeyBackup = secretCrypto.getKeyBackupFile();
        const oldKeyBackupBuffer = oldKeyBackup ? fs.readFileSync(oldKeyBackup.filePath) : null;
        try { storage.rawDb().pragma('wal_checkpoint(FULL)'); } catch {}
        const backupName = path.join(DATA_DIR, `zephyr-before-import-${Date.now()}.db`); fs.copyFileSync(path.join(DATA_DIR, 'zephyr.db'), backupName);
        storage.close();
        try {
            if (incomingKeyBuffer && !restoredKeyMatchesCurrent(oldKeyBackupBuffer, incomingKeyBuffer)) secretCrypto.restoreKeyBackup(incomingKeyBuffer);
            fs.writeFileSync(path.join(DATA_DIR, 'zephyr.db'), await dbEntry.buffer());
            storage.init({ hashPassword });
        } catch (err) {
            if (oldKeyBackupBuffer) secretCrypto.restoreKeyBackup(oldKeyBackupBuffer);
            fs.copyFileSync(backupName, path.join(DATA_DIR, 'zephyr.db'));
            reopenStorage();
            throw err;
        }
        addActivity('导入数据备份');
        res.json({ ok: true, message: '导入完成，数据已重新加载' });
    } catch (err) { res.status(400).json({ error: err.message || '导入失败' }); }
});

app.post('/api/connections/test', requireAuth, async (req, res) => {
    const body = req.body || {};
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    let conn = body.connectionId ? (store.connections || []).find((c) => c.id === body.connectionId) : null;
    if (conn) {
        conn = { ...conn };
        ['name', 'host', 'username', 'remark'].forEach((key) => { if (body[key] !== undefined) conn[key] = String(body[key]); });
        if (body.port !== undefined) conn.port = Number(body.port) || 22;
        if (body.protocol !== undefined) conn.protocol = String(body.protocol).toUpperCase();
        if (body.sshKeyId !== undefined) conn.sshKeyId = String(body.sshKeyId || '');
        if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
        if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
        applyConnectionRouteFields(conn, body);
    } else {
        conn = { ...body, port: Number(body.port) || 22 };
        applyConnectionRouteFields(conn, body);
    }
    const protocol = String(conn.protocol || 'SSH').toUpperCase();
    if (!conn.host || (protocol === 'SSH' && !conn.username)) return res.status(400).json({ error: protocol === 'SSH' ? '主机和用户名不能为空' : '主机不能为空' });
    const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutSeconds || 10) * 1000, 30000));
    const result = protocol === 'SSH'
        ? await testSSHConnection(conn, timeoutMs)
        : protocol === 'VNC'
            ? await testNoVncConnection(conn, timeoutMs)
            : protocol === 'RDP'
                ? await testRDPConnection(conn, timeoutMs)
                : { ok: false, code: 'unsupported_protocol', message: `不支持的协议：${protocol}`, durationMs: 0 };
    addActivity(`测试连接：${conn.name || conn.host} - ${result.message}`);
    res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/remote-execute', requireAuth, async (req, res) => {
    const { connectionIds, command, timeoutSeconds } = req.body || {};
    if (!Array.isArray(connectionIds) || !connectionIds.length) return res.status(400).json({ error: '请选择服务器' });
    if (!String(command || '').trim()) return res.status(400).json({ error: '请输入命令' });
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const targets = (store.connections || []).filter((c) => connectionIds.includes(c.id) && c.protocol === 'SSH');
    const started = Date.now();
    const results = await Promise.all(targets.map((conn) => runRemoteCommand(conn, String(command), timeoutSeconds)));
    addActivity(`远程执行：${targets.length} 台服务器，命令 ${String(command).slice(0, 40)}`);
    res.json({ startedAt: started, durationMs: Date.now() - started, results });
});

app.get('/api/proxies', requireAuth, (req, res) => res.json({ proxies: storage.listProxies() }));
app.post('/api/proxies', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.host || !b.port) return res.status(400).json({ error: '名称、IP、端口不能为空' });
    const proxy = storage.saveProxy({ id: crypto.randomUUID(), name: String(b.name), host: String(b.host), port: Number(b.port) || 1080, type: normalizeProxyType(b.type), username: String(b.username || ''), password: String(b.password || ''), createdAt: Date.now(), updatedAt: Date.now() });
    console.debug('[proxy]', 'saved proxy', { id: proxy.id, name: proxy.name, host: proxy.host, port: proxy.port, type: proxy.type });
    addActivity(`新增代理：${proxy.name}`);
    res.json({ proxy });
});
app.put('/api/proxies/:id', requireAuth, (req, res) => {
    const old = storage.getProxyRaw(req.params.id);
    if (!old) return res.status(404).json({ error: '代理不存在' });
    const b = req.body || {};
    const proxy = storage.saveProxy({ ...old, name: String(b.name ?? old.name), host: String(b.host ?? old.host), port: Number(b.port ?? old.port) || 1080, type: normalizeProxyType(b.type ?? old.type), username: String(b.username ?? old.username ?? ''), password: b.password === '******' ? old.password : String(b.password ?? old.password ?? ''), updatedAt: Date.now() });
    console.debug('[proxy]', 'updated proxy', { id: proxy.id, name: proxy.name, host: proxy.host, port: proxy.port, type: proxy.type });
    addActivity(`编辑代理：${proxy.name}`);
    res.json({ proxy });
});
app.post('/api/proxies/:id/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const proxy = storage.getProxyRaw(req.params.id);
        if (!proxy) return res.status(404).json({ error: '代理不存在' });
        console.info('[secret-open] reveal proxy', { id: proxy.id, name: proxy.name, hasPassword: !!proxy.password, authMethod: auth.method });
        res.json({ proxy: { ...proxy, hasPassword: !!proxy.password } });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});
app.delete('/api/proxies/:id', requireAuth, (req, res) => { storage.deleteProxy(req.params.id); addActivity('删除代理'); res.json({ ok: true }); });

app.get('/api/ssh-keys', requireAuth, (req, res) => res.json({ sshKeys: storage.listSshKeys() }));
app.post('/api/ssh-keys', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: '密钥名称不能为空' });
    if (!String(b.privateKey || '').includes('-----BEGIN')) return res.status(400).json({ error: '请填写有效的 SSH 私钥' });
    const sshKey = storage.saveSshKey({ id: crypto.randomUUID(), name: String(b.name).trim(), privateKey: String(b.privateKey), passphrase: String(b.passphrase || ''), remark: String(b.remark || ''), createdAt: Date.now(), updatedAt: Date.now() });
    console.debug('[ssh-key] saved key', { id: sshKey.id, name: sshKey.name, hasPrivateKey: sshKey.hasPrivateKey, hasPassphrase: sshKey.hasPassphrase });
    addActivity(`新增 SSH 密钥：${sshKey.name}`);
    res.json({ sshKey });
});
app.put('/api/ssh-keys/:id', requireAuth, (req, res) => {
    const old = storage.getSshKeyRaw(req.params.id);
    if (!old) return res.status(404).json({ error: 'SSH 密钥不存在' });
    const b = req.body || {};
    const privateKey = b.privateKey === '******' || b.privateKey === undefined ? old.privateKey : String(b.privateKey || '');
    const passphrase = b.passphrase === '******' || b.passphrase === undefined ? old.passphrase : String(b.passphrase || '');
    if (!String((b.name ?? old.name) || '').trim()) return res.status(400).json({ error: '密钥名称不能为空' });
    if (!privateKey.includes('-----BEGIN')) return res.status(400).json({ error: '请填写有效的 SSH 私钥' });
    const sshKey = storage.saveSshKey({ ...old, name: String(b.name ?? old.name).trim(), privateKey, passphrase, remark: String(b.remark ?? old.remark ?? ''), updatedAt: Date.now() });
    console.debug('[ssh-key] updated key', { id: sshKey.id, name: sshKey.name, hasPrivateKey: sshKey.hasPrivateKey, hasPassphrase: sshKey.hasPassphrase });
    addActivity(`编辑 SSH 密钥：${sshKey.name}`);
    res.json({ sshKey });
});
app.post('/api/ssh-keys/:id/open', requireAuth, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const key = storage.getSshKeyRaw(req.params.id);
        if (!key) return res.status(404).json({ error: 'SSH 密钥不存在' });
        console.info('[secret-open] reveal ssh key', { id: key.id, name: key.name, authMethod: auth.method });
        res.json({ sshKey: { ...key, hasPrivateKey: !!key.privateKey, hasPassphrase: !!key.passphrase } });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});
app.delete('/api/ssh-keys/:id', requireAuth, (req, res) => { storage.deleteSshKey(req.params.id); addActivity('删除 SSH 密钥'); res.json({ ok: true }); });

function ensureSshJumpConnection(connectionId) {
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const conn = (store.connections || []).find((c) => c.id === String(connectionId || ''));
    if (!conn) throw new Error('跳板机连接不存在或已删除');
    if (String(conn.protocol || 'SSH').toUpperCase() !== 'SSH') throw new Error('跳板机只能选择 SSH 连接，VNC/RDP 只能作为目标通过跳板访问');
    return conn;
}

app.get('/api/jump-hosts', requireAuth, (req, res) => res.json({ jumpHosts: storage.listJumpHosts() }));
app.post('/api/jump-hosts', requireAuth, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.connectionId) return res.status(400).json({ error: '名称和 SSH 连接不能为空' });
    try {
        ensureSshJumpConnection(b.connectionId);
        const jumpHost = storage.saveJumpHost({ id: crypto.randomUUID(), name: String(b.name), connectionId: String(b.connectionId), createdAt: Date.now(), updatedAt: Date.now() });
        addActivity(`新增跳板机：${jumpHost.name}`);
        res.json({ jumpHost });
    } catch (err) {
        res.status(400).json({ error: err.message || '跳板机配置无效' });
    }
});
app.put('/api/jump-hosts/:id', requireAuth, (req, res) => {
    const old = storage.listJumpHosts().find((j) => j.id === req.params.id);
    if (!old) return res.status(404).json({ error: '跳板机不存在' });
    const b = req.body || {};
    const nextConnectionId = String(b.connectionId ?? old.connectionId);
    try {
        ensureSshJumpConnection(nextConnectionId);
        const jumpHost = storage.saveJumpHost({ ...old, name: String(b.name ?? old.name), connectionId: nextConnectionId, updatedAt: Date.now() });
        addActivity(`编辑跳板机：${jumpHost.name}`);
        res.json({ jumpHost });
    } catch (err) {
        res.status(400).json({ error: err.message || '跳板机配置无效' });
    }
});
app.delete('/api/jump-hosts/:id', requireAuth, (req, res) => { storage.deleteJumpHost(req.params.id); addActivity('删除跳板机'); res.json({ ok: true }); });

function execRemoteCommand(sshClient, command, { transfer = null } = {}) {
    return new Promise((resolve, reject) => {
        if (!sshClient) return reject(new Error('SSH 未连接'));
        try { throwIfArchiveTransferCancelled(transfer); } catch (err) { reject(err); return; }
        sshClient.exec(`sh -lc ${shellQuote(command)}`, (err, stream) => {
            if (err) return reject(err);
            trackArchiveStream(transfer, stream);
            trackArchiveStream(transfer, stream.stderr);
            if (transfer?.cancelled) {
                try { stream.destroy?.(new Error('用户已取消')); } catch {}
                reject(new Error('用户已取消'));
                return;
            }
            let stdout = '';
            let stderr = '';
            stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            stream.on('close', (code) => {
                if (transfer?.cancelled) { reject(new Error('用户已取消')); return; }
                if (code !== 0) {
                    const message = (stderr || stdout || `远程命令退出码 ${code}`).trim();
                    reject(new Error(message));
                    return;
                }
                resolve(stdout);
            });
        });
    });
}

function shellQuote(value) {
    return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function remoteCommandArg(value) {
    return shellQuote(value);
}

function buildRemoteScript(lines) {
    return (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join('\n');
}

function normalizeClipboardConflictMode(value) {
    const mode = String(value || '').toLowerCase();
    if (mode === 'overwrite' || mode === 'replace') return 'overwrite';
    if (mode === 'skip') return 'skip';
    if (mode === 'compatible' || mode === 'compat' || mode === 'rename') return 'compatible';
    if (mode === 'cancel') return 'cancel';
    return 'ask';
}

function remoteCompatibleNameScript() {
    return 'if [ -e "$dst" ]; then d=$(dirname -- "$dst"); b=$(basename -- "$dst"); case "$b" in *.*) n=${b%.*}; e=.${b##*.};; *) n=$b; e=;; esac; dst="$d/$n-复制$e"; i=2; while [ -e "$dst" ]; do dst="$d/$n-复制$i$e"; i=$((i+1)); done; fi';
}

function remoteSameFileSafeCopyCommand(sourcePath, targetPath, { move = false, conflict = 'compatible' } = {}) {
    const sourceArg = remoteCommandArg(sourcePath);
    const targetArg = remoteCommandArg(targetPath);
    const conflictMode = normalizeClipboardConflictMode(conflict);
    return buildRemoteScript([
        'set -e',
        `src=${sourceArg}`,
        `dst=${targetArg}`,
        '[ -e "$src" ] || { echo "源文件不存在: $src" >&2; exit 2; }',
        conflictMode === 'cancel' || conflictMode === 'ask' ? '[ ! -e "$dst" ] || { echo "目标已存在: $dst" >&2; exit 3; }' : '',
        conflictMode === 'skip' ? '[ ! -e "$dst" ] || exit 0' : '',
        conflictMode === 'compatible' ? remoteCompatibleNameScript() : '',
        conflictMode === 'overwrite' ? '[ ! -e "$dst" ] || rm -rf -- "$dst"' : '',
        move ? 'mv -- "$src" "$dst"' : 'cp -a -- "$src" "$dst"',
    ]);
}

function createProgressReporter({ transferId, username, direction, path: targetPath, phase = '', size = 0, cancellable = false, transfer = null }) {
    const id = transferId || `archive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const total = Number(size) || 0;
    let loaded = 0;
    let lastSent = 0;
    const send = (status = 'active', extra = {}) => {
        const payloadPhase = extra.phase || phase;
        const payloadLoaded = extra.loaded !== undefined ? Number(extra.loaded) || 0 : loaded;
        const payloadSize = extra.size !== undefined ? Number(extra.size) || 0 : total;
        if (transfer) {
            transfer.path = targetPath;
            transfer.direction = direction;
            transfer.phase = payloadPhase;
            transfer.loaded = payloadLoaded;
            transfer.size = payloadSize;
            transfer.status = status;
        }
        if (!username) return;
        const now = Date.now();
        if (status === 'active' && now - lastSent < 300 && payloadLoaded < payloadSize) return;
        lastSent = now;
        sendTransferEvent(username, { transferId: id, direction, path: targetPath, loaded: payloadLoaded, size: payloadSize, status, phase: payloadPhase, cancellable, cancelled: !!transfer?.cancelled, ...extra });
    };
    return {
        id,
        add(bytes = 0, extra = {}) { throwIfArchiveTransferCancelled(transfer); loaded += Number(bytes) || 0; send('active', extra); },
        status(status, extra = {}) { throwIfArchiveTransferCancelled(status === 'error' ? null : transfer); send(status, extra); },
        setPhase(nextPhase, extra = {}) { throwIfArchiveTransferCancelled(transfer); phase = nextPhase || phase; send('active', extra); },
        get loaded() { return loaded; },
        get size() { return total; },
    };
}

function createSftpArchiveTransfer({ id, username = '', path: targetPath = '', operation = '' } = {}) {
    const transferId = id || `archive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const transfer = {
        id: transferId, username, path: targetPath, operation, direction: 'archive', phase: 'prepare',
        loaded: 0, size: 0, status: 'pending', cancelled: false,
        streams: new Set(), children: new Set(), archivers: new Set(), tmpRoots: new Set(),
    };
    sftpArchiveTransfers.set(transferId, transfer);
    return transfer;
}
function finishSftpArchiveTransfer(id) { if (id) sftpArchiveTransfers.delete(id); }
function throwIfArchiveTransferCancelled(transfer) { if (transfer?.cancelled) throw new Error('用户已取消'); }
function trackArchiveStream(transfer, stream) {
    if (!transfer || !stream) return stream;
    transfer.streams.add(stream);
    const cleanup = () => transfer.streams.delete(stream);
    stream.once?.('close', cleanup); stream.once?.('finish', cleanup); stream.once?.('end', cleanup); stream.once?.('error', cleanup);
    return stream;
}
function trackArchiveChild(transfer, child) {
    if (!transfer || !child) return child;
    transfer.children.add(child);
    child.once?.('close', () => transfer.children.delete(child));
    child.once?.('error', () => transfer.children.delete(child));
    return child;
}
function cancelSftpArchiveTransfer(id, reason = '用户已取消') {
    const transfer = sftpArchiveTransfers.get(id);
    if (!transfer) return false;
    if (transfer.cancelled) return true;
    transfer.cancelled = true;
    const err = new Error(reason);
    for (const archive of [...transfer.archivers]) { try { archive.abort?.(); } catch {} }
    for (const stream of [...transfer.streams]) { try { stream.destroy?.(err); } catch {} }
    for (const child of [...transfer.children]) {
        try { child.kill?.('SIGTERM'); } catch {}
        setTimeout(() => { if (!child.killed) { try { child.kill?.('SIGKILL'); } catch {} } }, 1200);
    }
    if (transfer.username) {
        sendTransferEvent(transfer.username, {
            transferId: id, direction: 'archive', path: transfer.path || '', phase: transfer.phase || '',
            loaded: Number(transfer.loaded) || 0, size: Number(transfer.size) || 0,
            status: 'error', cancelled: true, cancellable: true, error: reason,
        });
    }
    setTimeout(() => finishSftpArchiveTransfer(id), 10000);
    return true;
}

function progressTransform(onChunk, transfer = null) {
    return new Transform({
        transform(chunk, encoding, callback) {
            try {
                throwIfArchiveTransferCancelled(transfer);
                onChunk?.(chunk.length || 0);
                throwIfArchiveTransferCancelled(transfer);
            }
            catch (err) { callback(err); return; }
            callback(null, chunk);
        }
    });
}

function isTarArchivePath(targetPath = '') {
    const lower = String(targetPath || '').toLowerCase();
    return lower.endsWith('.tar') || /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(lower);
}

function archiveExtensionOfPath(targetPath = '') {
    const lower = String(targetPath || '').toLowerCase();
    const exts = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tbz2', '.txz', '.zip', '.tar', '.7z', '.rar', '.gz', '.bz2', '.xz'];
    return exts.find((ext) => lower.endsWith(ext)) || '';
}

function stripArchiveExtension(name = '') {
    const ext = archiveExtensionOfPath(name);
    return ext ? String(name).slice(0, -ext.length) : String(name || 'archive');
}

async function runLocalArchiveTool(command, args, { cwd, transfer = null } = {}) {
    return new Promise((resolve, reject) => {
        try { throwIfArchiveTransferCancelled(transfer); } catch (err) { reject(err); return; }
        const child = trackArchiveChild(transfer, spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] }));
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (transfer?.cancelled) { reject(new Error('用户已取消')); return; }
            if (code === 0) resolve();
            else reject(new Error((stderr || `${command} 退出码 ${code}`).trim()));
        });
    });
}

async function runLocalArchiveShell(script, { cwd, transfer = null } = {}) {
    return runLocalArchiveTool('sh', ['-lc', script], { cwd, transfer });
}

function ensureLocalChildPath(root, relativePath) {
    const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = path.posix.normalize(clean);
    if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw new Error(`压缩包包含不安全路径: ${relativePath}`);
    const target = path.resolve(root, ...normalized.split('/'));
    const resolvedRoot = path.resolve(root);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) throw new Error(`压缩包路径越界: ${relativePath}`);
    return target;
}

async function getRemoteTreeSize(sftp, remotePath, transfer = null) {
    throwIfArchiveTransferCancelled(transfer);
    const stats = await sftpStat(sftp, remotePath);
    if (!stats.isDirectory?.()) return Number(stats.size) || 0;
    const list = await sftpReaddir(sftp, remotePath);
    let total = 0;
    for (const entry of list) {
        if (!entry.filename || entry.filename === '.' || entry.filename === '..') continue;
        total += await getRemoteTreeSize(sftp, remoteJoin(remotePath, entry.filename), transfer);
    }
    return total;
}

async function getLocalTreeSize(localPath, transfer = null) {
    throwIfArchiveTransferCancelled(transfer);
    const stats = await fs.promises.stat(localPath);
    if (!stats.isDirectory()) return Number(stats.size) || 0;
    const list = await fs.promises.readdir(localPath, { withFileTypes: true });
    let total = 0;
    for (const entry of list) total += await getLocalTreeSize(path.join(localPath, entry.name), transfer);
    return total;
}

async function downloadRemotePathToLocal(sftp, remotePath, localPath, progress = null, transfer = null) {
    throwIfArchiveTransferCancelled(transfer);
    const stats = await sftpStat(sftp, remotePath);
    if (stats.isDirectory?.()) {
        await fs.promises.mkdir(localPath, { recursive: true });
        const list = await sftpReaddir(sftp, remotePath);
        for (const entry of list) {
            if (!entry.filename || entry.filename === '.' || entry.filename === '..') continue;
            await downloadRemotePathToLocal(sftp, remoteJoin(remotePath, entry.filename), path.join(localPath, entry.filename), progress, transfer);
        }
        return;
    }
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await streamPipeline(trackArchiveStream(transfer, sftp.createReadStream(remotePath)), progressTransform((bytes) => progress?.add?.(bytes, { phase: 'download' }), transfer), trackArchiveStream(transfer, fs.createWriteStream(localPath)));
}

async function uploadLocalPathToRemote(sftp, localPath, remotePath, progress = null, transfer = null) {
    throwIfArchiveTransferCancelled(transfer);
    const stats = await fs.promises.stat(localPath);
    if (stats.isDirectory()) {
        await ensureRemoteDirRecursive(sftp, remotePath);
        const list = await fs.promises.readdir(localPath, { withFileTypes: true });
        for (const entry of list) {
            await uploadLocalPathToRemote(sftp, path.join(localPath, entry.name), remoteJoin(remotePath, entry.name), progress, transfer);
        }
        return;
    }
    await ensureRemoteDirRecursive(sftp, dirnameRemote(remotePath));
    await streamPipeline(trackArchiveStream(transfer, fs.createReadStream(localPath)), progressTransform((bytes) => progress?.add?.(bytes, { phase: 'upload' }), transfer), trackArchiveStream(transfer, sftp.createWriteStream(remotePath)));
}

async function createZipArchiveFromLocal(sourceDir, rootNames, outputPath, transfer = null) {
    await new Promise((resolve, reject) => {
        try { throwIfArchiveTransferCancelled(transfer); } catch (err) { reject(err); return; }
        const output = trackArchiveStream(transfer, fs.createWriteStream(outputPath));
        const archive = archiver('zip', { zlib: { level: 9 } });
        transfer?.archivers?.add?.(archive);
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('end', () => transfer?.archivers?.delete?.(archive));
        archive.on('finish', () => transfer?.archivers?.delete?.(archive));
        archive.pipe(output);
        rootNames.forEach((name) => {
            const local = path.join(sourceDir, name);
            const stats = fs.statSync(local);
            if (stats.isDirectory()) archive.directory(local, name);
            else archive.file(local, { name });
        });
        archive.finalize();
    });
}

async function createSingleFileCompressedArchive(inputPath, outputPath, format, transfer = null) {
    if (format === '.gz') {
        const zlib = require('zlib');
        await streamPipeline(trackArchiveStream(transfer, fs.createReadStream(inputPath)), progressTransform(null, transfer), trackArchiveStream(transfer, zlib.createGzip({ level: 9 })), trackArchiveStream(transfer, fs.createWriteStream(outputPath)));
        return;
    }
    const tool = format === '.bz2' ? 'bzip2' : 'xz';
    await runLocalArchiveShell(`command -v ${tool} >/dev/null 2>&1 || { echo '主端未安装 ${tool}，无法创建 ${format}' >&2; exit 127; }; ${tool} -c -- ${shellQuote(inputPath)} > ${shellQuote(outputPath)}`, { transfer });
}

async function createMainSideArchiveFromRemote(sftp, items, targetPath, { username = '', transferId = '', transfer = null } = {}) {
    const activeTransfer = transfer || createSftpArchiveTransfer({ id: transferId, username, path: targetPath, operation: 'compress' });
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zephyr-sftp-archive-'));
    activeTransfer.tmpRoots?.add?.(tmpRoot);
    const progress = createProgressReporter({ transferId: activeTransfer.id, username, direction: 'archive', path: targetPath, phase: 'prepare', size: 0, cancellable: true, transfer: activeTransfer });
    try {
        const sourceDir = path.join(tmpRoot, 'src');
        const outDir = path.join(tmpRoot, 'out');
        await fs.promises.mkdir(sourceDir, { recursive: true });
        await fs.promises.mkdir(outDir, { recursive: true });
        progress.status('active', { phase: 'scan' });
        const inputSize = (await Promise.all(items.map((remotePath) => getRemoteTreeSize(sftp, remotePath, activeTransfer)))).reduce((sum, value) => sum + value, 0);
        const downloadProgress = createProgressReporter({ transferId: progress.id, username, direction: 'archive', path: targetPath, phase: 'download', size: inputSize, cancellable: true, transfer: activeTransfer });
        const rootNames = [];
        for (const remotePath of items) {
            const name = basenameRemote(remotePath);
            if (!name || name === '/' || rootNames.includes(name)) throw new Error(`压缩项目名称冲突或无效: ${remotePath}`);
            rootNames.push(name);
            await downloadRemotePathToLocal(sftp, remotePath, path.join(sourceDir, name), downloadProgress, activeTransfer);
        }
        progress.status('active', { phase: 'compress', loaded: inputSize, size: inputSize });
        const ext = archiveExtensionOfPath(targetPath);
        const outputPath = path.join(outDir, basenameRemote(targetPath));
        if (ext === '.zip') await createZipArchiveFromLocal(sourceDir, rootNames, outputPath, activeTransfer);
        else if (ext === '.7z') {
            const args = `a -y ${shellQuote(outputPath)} -- ${rootNames.map(shellQuote).join(' ')}`;
            await runLocalArchiveShell(`if command -v 7z >/dev/null 2>&1; then 7z ${args}; elif command -v 7za >/dev/null 2>&1; then 7za ${args}; else echo '主端未安装 7z/7za，无法创建 .7z' >&2; exit 127; fi`, { cwd: sourceDir, transfer: activeTransfer });
        } else if (ext === '.gz' || ext === '.bz2' || ext === '.xz') {
            if (rootNames.length !== 1) throw new Error(`${ext} 只支持单个文件，请改用 .tar.*、.zip 或 .7z`);
            const inputPath = path.join(sourceDir, rootNames[0]);
            const stats = await fs.promises.stat(inputPath);
            if (stats.isDirectory()) throw new Error(`${ext} 只支持单个文件，不能压缩目录`);
            await createSingleFileCompressedArchive(inputPath, outputPath, ext, activeTransfer);
        } else throw new Error('暂不支持该压缩格式');
        const outputSize = await getLocalTreeSize(outputPath, activeTransfer);
        const uploadProgress = createProgressReporter({ transferId: progress.id, username, direction: 'archive', path: targetPath, phase: 'upload', size: outputSize, cancellable: true, transfer: activeTransfer });
        await uploadLocalPathToRemote(sftp, outputPath, targetPath, uploadProgress, activeTransfer);
        uploadProgress.status('done', { phase: 'done', loaded: outputSize, size: outputSize });
    } finally {
        activeTransfer.tmpRoots?.delete?.(tmpRoot);
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
}

async function extractZipArchiveToLocal(archivePath, destDir, transfer = null) {
    const dir = await unzipper.Open.file(archivePath);
    for (const entry of dir.files) {
        throwIfArchiveTransferCancelled(transfer);
        const target = ensureLocalChildPath(destDir, entry.path);
        if (entry.type === 'Directory' || entry.path.endsWith('/')) {
            await fs.promises.mkdir(target, { recursive: true });
        } else {
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            await streamPipeline(trackArchiveStream(transfer, entry.stream()), progressTransform(null, transfer), trackArchiveStream(transfer, fs.createWriteStream(target)));
        }
    }
}

async function extractSingleFileCompressedArchive(archivePath, destDir, ext, transfer = null) {
    const outName = stripArchiveExtension(path.basename(archivePath)) || 'extracted';
    const outputPath = ensureLocalChildPath(destDir, outName);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    if (ext === '.gz') {
        const zlib = require('zlib');
        await streamPipeline(trackArchiveStream(transfer, fs.createReadStream(archivePath)), progressTransform(null, transfer), trackArchiveStream(transfer, zlib.createGunzip()), trackArchiveStream(transfer, fs.createWriteStream(outputPath)));
        return;
    }
    const tool = ext === '.bz2' ? 'bzip2' : 'xz';
    await runLocalArchiveShell(`command -v ${tool} >/dev/null 2>&1 || { echo '主端未安装 ${tool}，无法解压 ${ext}' >&2; exit 127; }; ${tool} -dc -- ${shellQuote(archivePath)} > ${shellQuote(outputPath)}`, { transfer });
}

async function extractMainSideArchiveToRemote(sftp, archivePath, targetDir, { username = '', transferId = '', transfer = null } = {}) {
    const activeTransfer = transfer || createSftpArchiveTransfer({ id: transferId, username, path: archivePath, operation: 'extract' });
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zephyr-sftp-extract-'));
    activeTransfer.tmpRoots?.add?.(tmpRoot);
    const progress = createProgressReporter({ transferId: activeTransfer.id, username, direction: 'archive', path: archivePath, phase: 'prepare', size: 0, cancellable: true, transfer: activeTransfer });
    try {
        const archiveLocal = path.join(tmpRoot, 'archive' + (archiveExtensionOfPath(archivePath) || path.extname(basenameRemote(archivePath)) || '.bin'));
        const outDir = path.join(tmpRoot, 'out');
        await fs.promises.mkdir(outDir, { recursive: true });
        const archiveStats = await sftpStat(sftp, archivePath);
        const archiveSize = Number(archiveStats?.size) || 0;
        const downloadProgress = createProgressReporter({ transferId: progress.id, username, direction: 'archive', path: archivePath, phase: 'download', size: archiveSize, cancellable: true, transfer: activeTransfer });
        await downloadRemotePathToLocal(sftp, archivePath, archiveLocal, downloadProgress, activeTransfer);
        progress.status('active', { phase: 'extract', loaded: archiveSize, size: archiveSize });
        const ext = archiveExtensionOfPath(archivePath);
        if (ext === '.zip') await extractZipArchiveToLocal(archiveLocal, outDir, activeTransfer);
        else if (ext === '.7z') {
            const args = `x -y -o${shellQuote(outDir)} -- ${shellQuote(archiveLocal)}`;
            await runLocalArchiveShell(`if command -v 7z >/dev/null 2>&1; then 7z ${args}; elif command -v 7za >/dev/null 2>&1; then 7za ${args}; else echo '主端未安装 7z/7za，无法解压 .7z' >&2; exit 127; fi`, { transfer: activeTransfer });
        } else if (ext === '.rar') {
            const args = `x -y -o${shellQuote(outDir)} -- ${shellQuote(archiveLocal)}`;
            await runLocalArchiveShell(`if command -v 7z >/dev/null 2>&1; then 7z ${args}; elif command -v unrar >/dev/null 2>&1; then unrar x -o+ -- ${shellQuote(archiveLocal)} ${shellQuote(outDir + path.sep)}; else echo '主端未安装 7z/unrar，无法解压 .rar' >&2; exit 127; fi`, { transfer: activeTransfer });
        } else if (ext === '.gz' || ext === '.bz2' || ext === '.xz') await extractSingleFileCompressedArchive(archiveLocal, outDir, ext, activeTransfer);
        else throw new Error('暂不支持该压缩格式');
        await ensureRemoteDirRecursive(sftp, targetDir);
        const outputSize = await getLocalTreeSize(outDir, activeTransfer);
        const uploadProgress = createProgressReporter({ transferId: progress.id, username, direction: 'archive', path: archivePath, phase: 'upload', size: outputSize, cancellable: true, transfer: activeTransfer });
        const entries = await fs.promises.readdir(outDir, { withFileTypes: true });
        for (const entry of entries) {
            await uploadLocalPathToRemote(sftp, path.join(outDir, entry.name), remoteJoin(targetDir, entry.name), uploadProgress, activeTransfer);
        }
        uploadProgress.status('done', { phase: 'done', loaded: outputSize, size: outputSize });
    } finally {
        activeTransfer.tmpRoots?.delete?.(tmpRoot);
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
}

function remoteArchiveCommand(items, targetPath) {
    const parent = dirnameRemote(items[0]);
    const names = items.map((p) => basenameRemote(p));
    const quotedNames = names.map(shellQuote).join(' ');
    const target = shellQuote(targetPath);
    const targetDir = shellQuote(dirnameRemote(targetPath));
    const parentArg = shellQuote(parent);
    const lower = String(targetPath || '').toLowerCase();
    const ensureDir = `mkdir -p -- ${targetDir}`;
    const needSingle = (fmt) => `test ${items.length} -eq 1 || { echo '${fmt} 只支持单个文件，请改用 .tar.*、.zip 或 .7z' >&2; exit 2; }`;
    let body = '';
    if (lower.endsWith('.zip')) body = `(command -v zip >/dev/null 2>&1 || { echo '远端未安装 zip，无法创建 .zip' >&2; exit 127; }; cd ${parentArg} && zip -r ${target} -- ${quotedNames})`;
    else if (/\.(tar\.gz|tgz)$/.test(lower)) body = `tar -czf ${target} -C ${parentArg} -- ${quotedNames}`;
    else if (/\.(tar\.bz2|tbz2)$/.test(lower)) body = `tar -cjf ${target} -C ${parentArg} -- ${quotedNames}`;
    else if (/\.(tar\.xz|txz)$/.test(lower)) body = `tar -cJf ${target} -C ${parentArg} -- ${quotedNames}`;
    else if (lower.endsWith('.tar')) body = `tar -cf ${target} -C ${parentArg} -- ${quotedNames}`;
    else if (lower.endsWith('.7z')) body = `(command -v 7z >/dev/null 2>&1 && cd ${parentArg} && 7z a -y ${target} -- ${quotedNames} || command -v 7za >/dev/null 2>&1 && cd ${parentArg} && 7za a -y ${target} -- ${quotedNames} || { echo '远端未安装 7z/7za，无法创建 .7z' >&2; exit 127; })`;
    else if (lower.endsWith('.gz')) body = `${needSingle('gzip')} && gzip -c -- ${shellQuote(items[0])} > ${target}`;
    else if (lower.endsWith('.bz2')) body = `${needSingle('bzip2')} && bzip2 -c -- ${shellQuote(items[0])} > ${target}`;
    else if (lower.endsWith('.xz')) body = `${needSingle('xz')} && xz -c -- ${shellQuote(items[0])} > ${target}`;
    else throw new Error('暂不支持该压缩格式，请使用 .zip、.tar、.tar.gz、.tgz、.tar.bz2、.tbz2、.tar.xz、.txz、.7z、.gz、.bz2 或 .xz');
    return `${ensureDir} && ${body}`;
}

function normalizeRemotePath(value) {
    return String(value || '').replace(/\/+/g, '/') || '/';
}
function remoteJoin(dir, name) {
    const base = normalizeRemotePath(dir || '/').replace(/\/+$/, '') || '/';
    return base === '/' ? `/${name}` : `${base}/${name}`;
}
function isDangerousRemotePath(value) {
    const p = normalizeRemotePath(value).trim();
    return !p || p === '/' || p === '.' || p === '..';
}
function basenameRemote(value) {
    return path.posix.basename(normalizeRemotePath(value));
}
function dirnameRemote(value) {
    return path.posix.dirname(normalizeRemotePath(value));
}
function sftpStat(sftp, targetPath) {
    return new Promise((resolve, reject) => sftp.stat(targetPath, (err, stats) => err ? reject(err) : resolve(stats)));
}
function sftpMkdir(sftp, targetPath) {
    return new Promise((resolve, reject) => sftp.mkdir(targetPath, (err) => err && err.code !== 4 ? reject(err) : resolve()));
}
function sftpReaddir(sftp, targetPath) {
    return new Promise((resolve, reject) => sftp.readdir(targetPath, (err, list) => err ? reject(err) : resolve(list || [])));
}
function createSftpClipboardTransfer({ username, opId, mode, targetDir, sendProgress }) {
    const transfer = {
        id: opId,
        username,
        mode,
        targetDir,
        cancelled: false,
        streams: new Set(),
        clients: new Set(),
        sftps: new Set(),
        handles: new Set(),
        chunkSize: 4 * 1024 * 1024,
        parallelism: 4,
        maxParallelism: Math.max(4, Math.min(12, Number(process.env.SFTP_CLIPBOARD_PARALLELISM) || 8)),
        maxChunkSize: Math.max(16 * 1024 * 1024, Math.min(256 * 1024 * 1024, Math.floor((os.freemem?.() || 512 * 1024 * 1024) / 16))),
        minChunkSize: 512 * 1024,
        targetChunkMs: 900,
        lastChunkMs: 0,
        successfulChunks: 0,
        sendProgress,
    };
    sftpClipboardTransfers.set(opId, transfer);
    return transfer;
}

function finishSftpClipboardTransfer(opId) {
    sftpClipboardTransfers.delete(opId);
}

function registerSftpClipboardRoute(transfer, routed, sftp) {
    if (!transfer) return;
    for (const client of routed?.clients || []) transfer.clients.add(client);
    if (routed?.client) transfer.clients.add(routed.client);
    if (sftp) transfer.sftps.add(sftp);
}

function unregisterSftpClipboardRoute(transfer, routed, sftp) {
    if (!transfer) return;
    for (const client of routed?.clients || []) transfer.clients.delete(client);
    if (routed?.client) transfer.clients.delete(routed.client);
    if (sftp) transfer.sftps.delete(sftp);
}

function destroySftpClipboardTransferResources(transfer, reason = '用户已取消') {
    const streams = [...(transfer?.streams || [])];
    const sftps = [...(transfer?.sftps || [])];
    const clients = [...(transfer?.clients || [])];
    for (const handle of [...(transfer?.handles || [])]) {
        try { handle.sftp?.close?.(handle.handle, () => {}); } catch {}
        transfer?.handles?.delete?.(handle);
    }
    for (const stream of streams) {
        try { stream.destroy?.(new Error(reason)); } catch {}
        try { stream.close?.(); } catch {}
        try { stream.end?.(); } catch {}
    }
    for (const sftp of sftps) {
        try { sftp.end?.(); } catch {}
        try { sftp.destroy?.(); } catch {}
    }
    for (const client of clients.reverse()) {
        try { client.end?.(); } catch {}
        try { client.destroy?.(); } catch {}
    }
}

function cancelSftpClipboardTransfer(opId, reason = '用户已取消') {
    const transfer = sftpClipboardTransfers.get(opId);
    if (!transfer) return false;
    if (transfer.cancelled) return true;
    transfer.cancelled = true;
    destroySftpClipboardTransferResources(transfer, reason);
    transfer.sendProgress?.({
        transferId: opId,
        direction: transfer.mode === 'cut' ? 'move' : 'copy',
        path: transfer.targetDir,
        loaded: transfer.loaded || 0,
        size: transfer.total || 0,
        status: 'error',
        error: reason,
        cancellable: true,
    });
    finishSftpClipboardTransfer(opId);
    setImmediate(() => destroySftpClipboardTransferResources(transfer, reason));
    return true;
}

function throwIfClipboardTransferCancelled(transfer) {
    if (transfer?.cancelled) throw new Error('复制已取消');
}

function sftpOpen(sftp, filename, flags, attrs) {
    return new Promise((resolve, reject) => {
        const cb = (err, handle) => err ? reject(err) : resolve(handle);
        if (attrs !== undefined) sftp.open(filename, flags, attrs, cb);
        else sftp.open(filename, flags, cb);
    });
}
function sftpClose(sftp, handle) {
    return new Promise((resolve) => {
        if (!handle) return resolve();
        try { sftp.close(handle, () => resolve()); } catch { resolve(); }
    });
}
function sftpReadChunk(sftp, handle, buffer, length, position) {
    return new Promise((resolve, reject) => {
        sftp.read(handle, buffer, 0, length, position, (err, bytesRead, readBuffer) => err ? reject(err) : resolve({ bytesRead, buffer: readBuffer || buffer }));
    });
}
function sftpWriteChunk(sftp, handle, buffer, length, position) {
    return new Promise((resolve, reject) => {
        sftp.write(handle, buffer, 0, length, position, (err) => err ? reject(err) : resolve());
    });
}
async function sftpHashFile(sftp, filePath, { algorithm = 'sha256', chunkSize = 256 * 1024, transfer = null } = {}) {
    const hash = crypto.createHash(algorithm);
    let handle = null;
    const handleRef = { sftp, handle: null };
    try {
        handle = await sftpOpen(sftp, filePath, 'r');
        handleRef.handle = handle;
        transfer?.handles?.add?.(handleRef);
        let position = 0;
        while (true) {
            throwIfClipboardTransferCancelled(transfer);
            const buffer = Buffer.allocUnsafe(chunkSize);
            const { bytesRead, buffer: readBuffer } = await sftpReadChunk(sftp, handle, buffer, chunkSize, position);
            if (!bytesRead) break;
            hash.update(readBuffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        return hash.digest('hex');
    } finally {
        transfer?.handles?.delete?.(handleRef);
        await sftpClose(sftp, handle);
    }
}

function configureClipboardChunkLimits(transfer, fileSize = 0) {
    if (!transfer) return;
    const size = Number(fileSize) || 0;
    const memoryLimit = Math.max(16 * 1024 * 1024, Math.min(256 * 1024 * 1024, Math.floor((os.freemem?.() || 512 * 1024 * 1024) / 16)));
    const sizeLimit = size >= 8 * 1024 * 1024 * 1024 ? 256 * 1024 * 1024
        : size >= 2 * 1024 * 1024 * 1024 ? 128 * 1024 * 1024
        : size >= 512 * 1024 * 1024 ? 64 * 1024 * 1024
        : size >= 128 * 1024 * 1024 ? 32 * 1024 * 1024
        : 16 * 1024 * 1024;
    transfer.maxChunkSize = Math.max(transfer.minChunkSize || 512 * 1024, Math.min(memoryLimit, sizeLimit));
    transfer.chunkSize = Math.min(Math.max(Number(transfer.chunkSize) || 4 * 1024 * 1024, transfer.minChunkSize || 512 * 1024), transfer.maxChunkSize);
    const maxParallel = Math.max(1, Math.min(Number(transfer.maxParallelism) || 8, Math.floor(memoryLimit / Math.max(transfer.chunkSize, 1)) || 1));
    transfer.parallelism = size >= 1024 * 1024 * 1024 ? Math.min(maxParallel, 8)
        : size >= 256 * 1024 * 1024 ? Math.min(maxParallel, 6)
        : size >= 32 * 1024 * 1024 ? Math.min(maxParallel, 4)
        : 1;
}
async function remotePathExists(sftp, targetPath) {
    try { await sftpStat(sftp, targetPath); return true; } catch { return false; }
}
async function resolveCompatibleRemotePath(sftp, targetPath) {
    if (!(await remotePathExists(sftp, targetPath))) return targetPath;
    const dir = dirnameRemote(targetPath);
    const base = basenameRemote(targetPath);
    const dot = base.lastIndexOf('.');
    const hasExt = dot > 0;
    const name = hasExt ? base.slice(0, dot) : base;
    const ext = hasExt ? base.slice(dot) : '';
    let candidate = remoteJoin(dir, `${name}-复制${ext}`);
    let index = 2;
    while (await remotePathExists(sftp, candidate)) {
        candidate = remoteJoin(dir, `${name}-复制${index}${ext}`);
        index += 1;
    }
    return candidate;
}

async function calculateRemoteTreeProperties(sftp, targetPath, stats = null) {
    const currentStats = stats || await sftpStat(sftp, targetPath);
    if (!currentStats.isDirectory?.()) {
        return { path: targetPath, size: Number(currentStats.size) || 0, fileCount: 1, dirCount: 0 };
    }
    let totalSize = 0;
    let fileCount = 0;
    let dirCount = 1;
    const list = await sftpReaddir(sftp, targetPath);
    for (const entry of list) {
        if (!entry.filename || entry.filename === '.' || entry.filename === '..') continue;
        const childPath = remoteJoin(targetPath, entry.filename);
        const isDir = entry.longname?.startsWith?.('d') || entry.attrs?.isDirectory?.();
        if (isDir) {
            const child = await calculateRemoteTreeProperties(sftp, childPath, entry.attrs);
            totalSize += child.size;
            fileCount += child.fileCount;
            dirCount += child.dirCount;
        } else {
            totalSize += Number(entry.attrs?.size) || 0;
            fileCount += 1;
        }
    }
    return { path: targetPath, size: totalSize, fileCount, dirCount };
}

async function ensureRemoteDirRecursive(sftp, dirPath) {
    const normalized = normalizeRemotePath(dirPath);
    if (!normalized || normalized === '/') return;
    const parts = normalized.split('/').filter(Boolean);
    let cur = normalized.startsWith('/') ? '/' : '';
    for (const part of parts) {
        cur = cur === '/' ? `/${part}` : (cur ? `${cur}/${part}` : part);
        try { await sftpMkdir(sftp, cur); } catch {}
    }
}
async function copyRemoteFileViaMain(sourceSftp, sourcePath, targetSftp, targetPath, onProgress, transfer, stats) {
    throwIfClipboardTransferCancelled(transfer);
    await ensureRemoteDirRecursive(targetSftp, dirnameRemote(targetPath));
    const size = Number(stats?.size) || 0;
    configureClipboardChunkLimits(transfer, size);
    await streamPipeline(
        sourceSftp.createReadStream(sourcePath, { highWaterMark: Number(transfer?.chunkSize) || 4 * 1024 * 1024 }),
        progressTransform((bytes) => { throwIfClipboardTransferCancelled(transfer); onProgress?.(bytes); }),
        targetSftp.createWriteStream(targetPath)
    );
    throwIfClipboardTransferCancelled(transfer);
}

async function copyRemoteTreeViaMain(sourceSftp, sourcePath, targetSftp, targetPath, onProgress, transfer) {
    throwIfClipboardTransferCancelled(transfer);
    const stats = await sftpStat(sourceSftp, sourcePath);
    throwIfClipboardTransferCancelled(transfer);
    if (stats.isDirectory?.()) {
        await ensureRemoteDirRecursive(targetSftp, targetPath);
        const list = await sftpReaddir(sourceSftp, sourcePath);
        for (const entry of list) {
            throwIfClipboardTransferCancelled(transfer);
            if (!entry.filename || entry.filename === '.' || entry.filename === '..') continue;
            await copyRemoteTreeViaMain(sourceSftp, remoteJoin(sourcePath, entry.filename), targetSftp, remoteJoin(targetPath, entry.filename), onProgress, transfer);
        }
        return;
    }
    await copyRemoteFileViaMain(sourceSftp, sourcePath, targetSftp, targetPath, onProgress, transfer, stats);
}

async function removeRemotePath(connectionConfig, targetPath) {
    if (isDangerousRemotePath(targetPath)) throw new Error('拒绝删除空路径或根目录');
    const routed = await createRoutedSSHConnection(connectionConfig, 10000);
    try { await execRemoteCommand(routed.client, `rm -rf -- ${shellQuote(targetPath)}`); }
    finally { [...(routed.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} }); }
}
async function cleanupRemoteTempFile(connectionConfig, targetPath) {
    if (!connectionConfig || !targetPath || !String(targetPath).startsWith('/tmp/zephyr-sftp-')) return;
    try { await removeRemotePath(connectionConfig, targetPath); } catch (err) { console.warn('[sftp-temp-cleanup]', 'failed', { path: targetPath, error: err.message }); }
}
async function withRoutedSftp(connectionConfig, callback, transfer) {
    const routed = await createRoutedSSHConnection(connectionConfig, 10000);
    let sftp = null;
    try {
        throwIfClipboardTransferCancelled(transfer);
        sftp = await new Promise((resolve, reject) => routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp)));
        registerSftpClipboardRoute(transfer, routed, sftp);
        throwIfClipboardTransferCancelled(transfer);
        return await callback({ routed, sftp });
    } finally {
        unregisterSftpClipboardRoute(transfer, routed, sftp);
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    }
}
async function checkSftpClipboardTargetConflicts({ username, targetSession, targetDir }) {
    const clip = sftpClipboardByUser.get(username);
    if (!clip || !Array.isArray(clip.items) || !clip.items.length) throw new Error('剪贴板为空');
    const targetConnectionConfig = targetSession?.connectionConfig;
    if (!targetConnectionConfig) throw new Error('目标 SSH 连接已失效');
    const conflicts = [];
    const checkWithSftp = async (targetSftp) => {
        for (const item of clip.items) {
            const targetPath = remoteJoin(targetDir, basenameRemote(item.path));
            try {
                const stats = await sftpStat(targetSftp, targetPath);
                conflicts.push({ path: targetPath, name: basenameRemote(targetPath), type: stats.isDirectory?.() ? 'd' : '-' });
            } catch {}
        }
    };
    if (targetSession?.sftpStream) {
        await checkWithSftp(targetSession.sftpStream);
    } else {
        await withRoutedSftp(targetConnectionConfig, async ({ sftp }) => checkWithSftp(sftp));
    }
    return { hasConflict: conflicts.length > 0, conflicts, count: conflicts.length };
}

async function pasteSftpClipboard({ username, targetSession, targetDir, mode, conflict = 'ask', sendProgress }) {
    const clip = sftpClipboardByUser.get(username);
    if (!clip || !Array.isArray(clip.items) || !clip.items.length) throw new Error('剪贴板为空');
    const targetConnectionConfig = targetSession?.connectionConfig;
    if (!targetConnectionConfig) throw new Error('目标 SSH 连接已失效');
    const sameConnection = String(clip.sourceConnectionId || '') && String(clip.sourceConnectionId) === String(targetSession.connectionId || '');
    const conflictMode = normalizeClipboardConflictMode(conflict);
    if (conflictMode === 'ask') throw new Error('目标存在同名项目，请选择覆盖、跳过或兼容');
    const opId = crypto.randomUUID();
    const transfer = createSftpClipboardTransfer({ username, opId, mode, targetDir, sendProgress });
    const total = clip.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    transfer.total = total;
    let loaded = 0;
    const sendStatus = (status, currentPath = targetDir, extra = {}) => {
        transfer.loaded = loaded;
        transfer.total = total;
        sendProgress?.({ transferId: opId, direction: mode === 'cut' ? 'move' : 'copy', path: currentPath || targetDir, loaded, size: total, status, cancellable: true, chunkSize: transfer.chunkSize, maxChunkSize: transfer.maxChunkSize, chunkMs: transfer.lastChunkMs, parallelism: transfer.parallelism, ...extra });
    };
    const bump = (n, currentPath = '') => {
        throwIfClipboardTransferCancelled(transfer);
        loaded += Number(n) || 0;
        sendStatus('active', currentPath || targetDir);
    };
    try {
        if (sameConnection) {
            const commands = [];
            for (const item of clip.items) {
                const targetPath = remoteJoin(targetDir, basenameRemote(item.path));
                const command = remoteSameFileSafeCopyCommand(item.path, targetPath, { move: mode === 'cut', conflict });
                commands.push(command);
            }
            console.info('[sftp-clipboard-paste]', 'same connection paste', { count: clip.items.length, targetDir, mode });
            for (const command of commands) await execRemoteCommand(targetSession.sshClient, command);
            loaded = total;
            sendStatus('done', targetDir);
        } else {
            console.info('[sftp-clipboard-paste]', 'cross connection paste via main side', { count: clip.items.length, targetDir, mode });
            await withRoutedSftp(clip.sourceConnectionConfig, async ({ sftp: sourceSftp }) => {
                await withRoutedSftp(targetConnectionConfig, async ({ sftp: targetSftp }) => {
                    for (const item of clip.items) {
                        throwIfClipboardTransferCancelled(transfer);
                        let targetPath = remoteJoin(targetDir, basenameRemote(item.path));
                        if (conflictMode === 'skip') {
                            try { await sftpStat(targetSftp, targetPath); continue; } catch {}
                        } else if (conflictMode === 'compatible') {
                            targetPath = await resolveCompatibleRemotePath(targetSftp, targetPath);
                        } else if (conflictMode === 'overwrite') {
                            try { await removeRemotePath(targetConnectionConfig, targetPath); } catch {}
                        }
                        await copyRemoteTreeViaMain(sourceSftp, item.path, targetSftp, targetPath, (n) => bump(n, item.path), transfer);
                    }
                }, transfer);
            }, transfer);
            loaded = Math.max(total, loaded);
            if (mode === 'cut') {
                for (const item of clip.items) {
                    throwIfClipboardTransferCancelled(transfer);
                    await removeRemotePath(clip.sourceConnectionConfig, item.path);
                }
            }
            sendStatus('done', targetDir);
        }
        if (mode === 'cut') sftpClipboardByUser.delete(username);
    } catch (err) {
        const message = transfer.cancelled ? '复制已取消' : (err.message || '复制失败');
        sendStatus('error', targetDir, { error: message });
        if (transfer.cancelled) throw new Error(message);
        throw err;
    } finally {
        finishSftpClipboardTransfer(opId);
    }
}

function parseJSONLines(raw) {
    return String(raw || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
        });
}

function normalizeDockerMirrors(raw) {
    try {
        const json = JSON.parse(raw || '{}');
        return Array.isArray(json['registry-mirrors']) ? json['registry-mirrors'].filter(Boolean) : [];
    } catch {
        return [];
    }
}

function dockerServiceRestartCommand() {
    return [
        'set -e',
        'if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo -n"; fi',
        'if command -v systemctl >/dev/null 2>&1; then',
        '  $SUDO systemctl restart docker',
        'elif command -v service >/dev/null 2>&1; then',
        '  $SUDO service docker restart',
        'else',
        '  echo "未找到 systemctl/service，无法自动重启 Docker" >&2',
        '  exit 1',
        'fi',
        'echo "Docker 服务已重启"'
    ].join('\n');
}

// 提供静态文件
app.get('/api/sftp/preview/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const previewTask = sftpPreviewTokens.get(token);
    if (!previewTask || previewTask.username !== req.session.username || previewTask.expiresAt < Date.now()) {
        sftpPreviewTokens.delete(token);
        return res.status(404).json({ error: '预览链接已失效' });
    }
    const connectionConfig = previewTask.connectionConfig;
    if (!connectionConfig) {
        sftpPreviewTokens.delete(token);
        return res.status(410).json({ error: '预览连接配置已失效，请重新打开文件管理器后预览' });
    }
    const ext = getImageExt(previewTask.path);
    if (!isPreviewImageExt(ext, PREVIEW_IMAGE_EXTENSIONS)) return res.status(415).json({ error: '当前文件不是已知图片格式' });

    let routed = null;
    let sftp = null;
    const closeConnection = () => {
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    };
    try {
        cleanupPreviewCache(previewCache);
        routed = await createRoutedSSHConnection(connectionConfig, 10000);
        sftp = await new Promise((resolve, reject) => {
            routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp));
        });
        const stats = await new Promise((resolve, reject) => {
            sftp.stat(previewTask.path, (err, nextStats) => err ? reject(err) : resolve(nextStats));
        });
        if (stats.isDirectory?.()) throw new Error('目录不支持图片预览');
        const size = Number(stats.size) || 0;
        const mtime = Number(stats.mtime) || Number(stats.modifyTime) || 0;
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(previewTask.path))}`);
        previewTask.expiresAt = Date.now() + PREVIEW_TOKEN_TTL;

        if (isBrowserImageExt(ext, BROWSER_IMAGE_EXTENSIONS)) {
            res.type(getBrowserImageContentType(ext, BROWSER_IMAGE_CONTENT_TYPES));
            if (size) res.setHeader('Content-Length', String(size));
            const readStream = sftp.createReadStream(previewTask.path);
            readStream.on('error', (err) => {
                closeConnection();
                if (!res.headersSent) res.status(500).end(err.message || '图片预览读取失败');
                else res.destroy(err);
            });
            res.on('close', closeConnection);
            res.on('finish', closeConnection);
            readStream.pipe(res);
            return;
        }

        const result = await ensurePreviewCacheFile({
            cache: { ttl: PREVIEW_CACHE_TTL },
            cacheMap: previewCache,
            cacheDir: PREVIEW_CACHE_DIR,
            sourcePath: previewTask.path,
            sourceSize: size,
            sourceMtime: mtime,
            ext,
            readSourceFile: (inputPath) => new Promise((resolve, reject) => {
                let settled = false;
                const done = (err) => {
                    if (settled) return;
                    settled = true;
                    err ? reject(err) : resolve();
                };
                const readStream = sftp.createReadStream(previewTask.path);
                const writeStream = fs.createWriteStream(inputPath);
                readStream.on('error', done);
                writeStream.on('error', done);
                writeStream.on('finish', () => done());
                readStream.pipe(writeStream);
            }),
        });
        res.type('image/webp');
        res.setHeader('X-Zephyr-Preview-Engine', result.engine || 'unknown');
        res.sendFile(result.outputPath, (err) => {
            closeConnection();
            if (err) console.warn('[sftp-preview]', 'send failed', { path: previewTask.path, error: err.message });
        });
    } catch (err) {
        closeConnection();
        console.warn('[sftp-preview]', 'failed', { path: previewTask?.path || '', error: err.message });
        if (!res.headersSent) res.status(500).json({ error: err.message || '图片预览失败' });
    }
});


function getMediaTask(token, req, res) {
    const mediaTask = sftpMediaTokens.get(String(token || ''));
    if (!mediaTask || mediaTask.username !== req.session.username || mediaTask.expiresAt < Date.now()) {
        sftpMediaTokens.delete(String(token || ''));
        res.status(404).json({ error: '媒体预览链接已失效' });
        return null;
    }
    if (!mediaTask.connectionConfig) {
        sftpMediaTokens.delete(String(token || ''));
        res.status(410).json({ error: '媒体连接配置已失效，请重新打开文件管理器后预览' });
        return null;
    }
    mediaTask.expiresAt = Date.now() + MEDIA_TOKEN_TTL;
    return mediaTask;
}

function openMediaSftp(connectionConfig) {
    return createRoutedSSHConnection(connectionConfig, 10000).then((routed) => new Promise((resolve, reject) => {
        routed.client.sftp((err, sftp) => {
            if (err) {
                [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
                reject(err);
            } else resolve({ routed, sftp });
        });
    }));
}

function closeMediaRouted(routed, sftp) {
    try { sftp?.end?.(); } catch {}
    [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
}

function mediaRangeFromRequest(req, size) {
    const total = Number(size) || 0;
    const raw = String(req.headers.range || '');
    if (!total) return { start: 0, end: 0, partial: false, empty: true };
    if (!raw || !/^bytes=/.test(raw)) return { start: 0, end: total - 1, partial: false };
    const match = raw.match(/bytes=(\d*)-(\d*)/);
    if (!match) return null;
    let start = match[1] === '' ? 0 : Number(match[1]);
    let end = match[2] === '' ? total - 1 : Number(match[2]);
    if (match[1] === '' && Number.isFinite(end)) start = Math.max(0, total - end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) return null;
    end = Math.min(end, total - 1);
    return { start, end, partial: true };
}

function cleanupMediaFileCache() {
    const now = Date.now();
    try { fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true }); } catch {}
    let entries = [];
    try { entries = fs.readdirSync(MEDIA_CACHE_DIR, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(MEDIA_CACHE_DIR, entry.name);
        try {
            const stat = fs.statSync(full);
            if (now - Number(stat.mtimeMs || 0) > MEDIA_CACHE_TTL) fs.unlinkSync(full);
        } catch {}
    }
}

function mediaCacheFilePath(mediaTask, ext) {
    const key = mediaCacheKey([mediaTask.path, String(mediaTask.size || ''), String(mediaTask.mtime || ''), ext || 'media']);
    return path.join(MEDIA_CACHE_DIR, `${key}.${ext || 'bin'}`);
}

function cacheSftpMediaToFile(sftp, mediaTask, ext) {
    cleanupMediaFileCache();
    const target = mediaCacheFilePath(mediaTask, ext);
    return new Promise((resolve, reject) => {
        fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
        fs.stat(target, (statErr, cachedStat) => {
            if (!statErr && Number(cachedStat.size) === Number(mediaTask.size || 0)) {
                fs.utimes(target, new Date(), new Date(), () => resolve(target));
                return;
            }
            const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
            const input = sftp.createReadStream(mediaTask.path);
            const output = fs.createWriteStream(tmp);
            let settled = false;
            const done = (err) => {
                if (settled) return;
                settled = true;
                try { input.destroy(); } catch {}
                try { output.destroy(); } catch {}
                if (err) {
                    try { fs.unlinkSync(tmp); } catch {}
                    reject(err);
                    return;
                }
                fs.rename(tmp, target, (renameErr) => renameErr ? reject(renameErr) : resolve(target));
            };
            input.on('error', done);
            output.on('error', done);
            output.on('finish', () => done());
            input.pipe(output);
        });
    });
}

app.get('/api/sftp/media/stream/:token', requireAuth, async (req, res) => {
    const mediaTask = getMediaTask(req.params.token, req, res);
    if (!mediaTask) return;
    if (!isMediaExt(getMediaExt(mediaTask.path))) return res.status(415).json({ error: '当前文件不是已知媒体格式' });
    let routed = null;
    let sftp = null;
    try {
        ({ routed, sftp } = await openMediaSftp(mediaTask.connectionConfig));
        const stats = await new Promise((resolve, reject) => sftp.stat(mediaTask.path, (err, nextStats) => err ? reject(err) : resolve(nextStats)));
        if (stats.isDirectory?.()) throw new Error('目录不支持媒体预览');
        const size = Number(stats.size) || Number(mediaTask.size) || 0;
        const ext = getMediaExt(mediaTask.path);
        const direct = mediaTask.mode === 'DIRECT';
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(mediaTask.path))}`);
        res.setHeader('X-Zephyr-Media-Mode', mediaTask.mode || 'DIRECT');
        if (direct) {
            const range = mediaRangeFromRequest(req, size);
            if (!range) {
                closeMediaRouted(routed, sftp);
                res.setHeader('Content-Range', `bytes */${size}`);
                return res.status(416).end();
            }
            res.status(range.partial ? 206 : 200);
            res.type(directMime(ext));
            res.setHeader('Accept-Ranges', 'bytes');
            if (size) {
                res.setHeader('Content-Length', String(range.end - range.start + 1));
                if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
            }
            const readStream = sftp.createReadStream(mediaTask.path, range.empty ? undefined : { start: range.start, end: range.end });
            readStream.on('error', (err) => {
                closeMediaRouted(routed, sftp);
                if (!res.headersSent) res.status(500).end(err.message || '媒体读取失败');
                else res.destroy(err);
            });
            res.on('close', () => closeMediaRouted(routed, sftp));
            res.on('finish', () => closeMediaRouted(routed, sftp));
            readStream.pipe(res);
            return;
        }
        res.status(200);
        res.type(isVideoExt(ext) ? 'video/mp4' : 'audio/mp4');
        res.setHeader('Accept-Ranges', 'none');
        const inputPath = await cacheSftpMediaToFile(sftp, mediaTask, ext);
        closeMediaRouted(routed, sftp);
        routed = null;
        sftp = null;
        const args = ffmpegArgsForMode(mediaTask.mode, isVideoExt(ext), inputPath);
        const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-4000); });
        ffmpeg.on('error', (err) => { if (!res.headersSent) res.status(500).end(err.message); else res.destroy(err); });
        ffmpeg.on('close', (code) => {
            if (code && !res.destroyed) console.warn('[sftp-media]', 'ffmpeg exited', { path: mediaTask.path, mode: mediaTask.mode, code, stderr: stderr.trim().slice(-500) });
        });
        ffmpeg.stdout.on('error', () => {});
        res.on('close', () => { try { ffmpeg.kill('SIGKILL'); } catch {} });
        ffmpeg.stdout.pipe(res);
    } catch (err) {
        closeMediaRouted(routed, sftp);
        console.warn('[sftp-media]', 'stream failed', { path: mediaTask?.path || '', error: err.message });
        if (!res.headersSent) res.status(500).json({ error: err.message || '媒体预览失败' });
    }
});

app.get('/api/sftp/media/subtitle/:token/:index.vtt', requireAuth, async (req, res) => {
    const mediaTask = getMediaTask(req.params.token, req, res);
    if (!mediaTask) return;
    let routed = null;
    let sftp = null;
    try {
        ({ routed, sftp } = await openMediaSftp(mediaTask.connectionConfig));
        const subtitle = (mediaTask.subtitles || [])[Number(req.params.index) || 0];
        if (!subtitle) throw new Error('字幕不存在');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.type('text/vtt; charset=utf-8');
        if (subtitle.externalPath) {
            const ext = getMediaExt(subtitle.externalPath);
            if (ext === 'vtt') {
                const rs = sftp.createReadStream(subtitle.externalPath);
                rs.on('error', (err) => { closeMediaRouted(routed, sftp); if (!res.headersSent) res.status(500).end(err.message); else res.destroy(err); });
                res.on('close', () => closeMediaRouted(routed, sftp));
                res.on('finish', () => closeMediaRouted(routed, sftp));
                rs.pipe(res);
                return;
            }
            const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-i', 'pipe:0', '-f', 'webvtt', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
            sftp.createReadStream(subtitle.externalPath).pipe(ffmpeg.stdin);
            ffmpeg.on('close', () => closeMediaRouted(routed, sftp));
            res.on('close', () => { try { ffmpeg.kill('SIGKILL'); } catch {}; closeMediaRouted(routed, sftp); });
            ffmpeg.stdout.pipe(res);
            return;
        }
        const ffmpeg = spawn('ffmpeg', subtitleToVttArgs(subtitle.index || 0), { stdio: ['pipe', 'pipe', 'pipe'] });
        sftp.createReadStream(mediaTask.path).pipe(ffmpeg.stdin);
        ffmpeg.on('close', () => closeMediaRouted(routed, sftp));
        res.on('close', () => { try { ffmpeg.kill('SIGKILL'); } catch {}; closeMediaRouted(routed, sftp); });
        ffmpeg.stdout.pipe(res);
    } catch (err) {
        closeMediaRouted(routed, sftp);
        if (!res.headersSent) res.status(500).end(err.message || '字幕加载失败');
    }
});

// ===== 分片上传 API =====
// POST /api/sftp/upload/:token       — 上传一个分片（X-Upload-Offset 指定偏移）
// POST /api/sftp/upload/:token/complete — 完成上传，关闭句柄并校验

// 存储每个 token 对应的 SFTP session 缓存（conn/file handle）
const sftpUploadSessions = new Map(); // token -> { routed, sftp, fileHandle, totalLoaded, keepaliveTimer, settled }

function getUploadSession(token, uploadTask) {
    let session = sftpUploadSessions.get(token);
    if (session) {
        session.expiresAt = Date.now() + SFTP_UPLOAD_TOKEN_TTL;
        return session;
    }
    return null;
}

async function createUploadSession(token, uploadTask) {
    const connectionConfig = uploadTask.connectionConfig;
    if (!connectionConfig) throw new Error('上传连接配置已失效');

    const routed = await createRoutedSSHConnection(connectionConfig, 10000);
    const sftp = await new Promise((resolve, reject) => {
        routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp));
    });

    // Open file handle for offset writes
    // 断点续传: 如果已有部分数据(offset>0)，用 'r+' 避免 truncate
    // 首次上传用 'w'（create+truncate）
    const isResume = (uploadTask.loaded > 0);
    let fileHandle;
    try {
        fileHandle = await new Promise((resolve, reject) => {
            sftp.open(uploadTask.path, isResume ? 'r+' : 'w', (err, handle) => err ? reject(err) : resolve(handle));
        });
    } catch (openErr) {
        // r+ 失败（文件不存在），降级为 w
        if (isResume) {
            fileHandle = await new Promise((resolve, reject) => {
                sftp.open(uploadTask.path, 'w', (err, handle) => err ? reject(err) : resolve(handle));
            });
        } else {
            throw openErr;
        }
    }

    if (routed?.client?._sock?.setKeepAlive) {
        try { routed.client._sock.setKeepAlive(true, SFTP_UPLOAD_KEEPALIVE_INTERVAL); } catch {}
    }

    let sftpKeepaliveSeq = 0;
    const keepaliveTimer = setInterval(() => {
        if (session.settled) {
            clearInterval(keepaliveTimer);
            return;
        }
        try { routed?.client?._sock?.setKeepAlive?.(true, SFTP_UPLOAD_KEEPALIVE_INTERVAL); } catch {}
        sftpKeepaliveSeq++;
        if (sftpKeepaliveSeq % 2 === 0 && sftp && !session.settled) {
            try { sftp.realpath('.', () => {}); } catch {}
        }
    }, SFTP_UPLOAD_KEEPALIVE_INTERVAL);
    keepaliveTimer.unref?.();

    const session = {
        routed,
        sftp,
        fileHandle,
        totalLoaded: 0,
        keepaliveTimer,
        settled: false,
        expiresAt: Date.now() + SFTP_UPLOAD_TOKEN_TTL,
        username: uploadTask.username,
        path: uploadTask.path,
        uploadId: uploadTask.uploadId || '',
    };
    sftpUploadSessions.set(token, session);
    return session;
}

function destroyUploadSession(token) {
    const session = sftpUploadSessions.get(token);
    if (!session) return;
    session.settled = true;
    if (session.keepaliveTimer) clearInterval(session.keepaliveTimer);
    try {
        if (session.fileHandle) session.sftp.close(session.fileHandle, () => {});
    } catch {}
    try { session.sftp?.end?.(); } catch {}
    [...(session.routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    sftpUploadSessions.delete(token);
}

// 分片上传：每个分片一个 POST，URL query ?offset=N 指定写入位置
// 使用 query 参数而非自定义头，避免 CORS 预检（自定义头+非简单 content-type 触发 OPTIONS）
app.post('/api/sftp/upload/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const uploadTask = sftpUploadTokens.get(token);

    if (!uploadTask || uploadTask.username !== req.session.username || uploadTask.expiresAt < Date.now()) {
        sftpUploadTokens.delete(token);
        destroyUploadSession(token);
        return res.status(404).json({ error: '上传链接已失效' });
    }

    const offset = Number(req.query.offset);
    if (!Number.isFinite(offset) || offset < 0) {
        return res.status(400).json({ error: '缺少或无效的 ?offset 参数' });
    }

    let session = getUploadSession(token, uploadTask);
    if (!session) {
        try {
            session = await createUploadSession(token, uploadTask);
        } catch (err) {
            sftpUploadTokens.delete(token);
            return res.status(410).json({ error: `创建上传会话失败：${err.message}` });
        }
    }

    if (session.settled) {
        return res.status(410).json({ error: '上传会话已结束' });
    }
    if (session.username !== req.session.username) {
        return res.status(403).json({ error: '上传会话用户不匹配' });
    }

    // Collect the body (may arrive in multiple data events)
    const chunks = [];
    let bodyLength = 0;
    req.on('data', (chunk) => {
        chunks.push(chunk);
        bodyLength += chunk.length;
    });

    req.on('end', () => {
        const buffer = Buffer.concat(chunks);

        // Write chunk at offset using low-level sftp.write()
        session.sftp.write(session.fileHandle, buffer, 0, buffer.length, offset, (writeErr) => {
            if (writeErr || session.settled) {
                if (writeErr) {
                    console.warn('[sftp-upload-chunk]', 'write failed', { path: uploadTask.path, offset, size: buffer.length, error: writeErr.message });
                }
                if (!res.headersSent) {
                    return res.status(500).json({ error: writeErr ? `写入分片失败：${writeErr.message}` : '上传会话已结束' });
                }
                return;
            }

            session.totalLoaded = Math.max(session.totalLoaded, offset + buffer.length);
            uploadTask.loaded = session.totalLoaded;
            uploadTask.expiresAt = Date.now() + SFTP_UPLOAD_TOKEN_TTL;

            // Broadcast progress
            sendTransferEvent(uploadTask.username, {
                transferId: uploadTask.uploadId || token,
                direction: 'upload',
                path: uploadTask.path,
                loaded: session.totalLoaded,
                size: Number(uploadTask.size) || 0,
                status: 'active',
            });

            res.json({
                ok: true,
                received: buffer.length,
                offset,
                nextOffset: offset + buffer.length,
                totalLoaded: session.totalLoaded,
                totalSize: Number(uploadTask.size) || 0,
            });
        });
    });

    req.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).json({ error: `读取分片数据失败：${err.message}` });
        }
    });
});

// 完成上传：关闭句柄并校验
app.post('/api/sftp/upload/:token/complete', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const uploadTask = sftpUploadTokens.get(token);
    if (!uploadTask || uploadTask.username !== req.session.username) {
        sftpUploadTokens.delete(token);
        destroyUploadSession(token);
        return res.status(404).json({ error: '上传任务不存在' });
    }

    const session = sftpUploadSessions.get(token);
    if (!session) {
        sftpUploadTokens.delete(token);
        return res.status(410).json({ error: '上传会话不存在或已过期' });
    }

    // Close file handle
    try {
        await new Promise((resolve, reject) => {
            session.sftp.close(session.fileHandle, (err) => err ? reject(err) : resolve());
        });
    } catch (err) {
        console.warn('[sftp-upload-complete]', 'close handle failed', { path: uploadTask.path, error: err.message });
    }

    // Verify via SHA-256 when the browser provided a local digest.
    try {
        const stats = await new Promise((resolve, reject) => {
            session.sftp.stat(uploadTask.path, (err, st) => err ? reject(err) : resolve(st));
        });
        const remoteSize = Number(stats.size) || 0;
        const expectedHash = String(uploadTask.sha256 || '').toLowerCase();
        if (expectedHash) {
            const remoteHash = await sftpHashFile(session.sftp, uploadTask.path);
            if (remoteHash !== expectedHash) {
                destroyUploadSession(token);
                sftpUploadTokens.delete(token);
                return res.status(500).json({
                    error: `上传校验失败：SHA-256 不一致（本地 ${expectedHash}，远端 ${remoteHash}）`,
                    remoteHash,
                    expectedHash,
                });
            }
        }

        uploadTask.loaded = remoteSize;
        uploadTask.status = 'done';
        uploadTask.activeStream = null;
        sendTransferEvent(uploadTask.username, {
            transferId: uploadTask.uploadId || token,
            direction: 'upload',
            path: uploadTask.path,
            loaded: remoteSize,
            size: Number(uploadTask.size) || 0,
            status: 'done',
        });
        destroyUploadSession(token);
        sftpUploadTokens.delete(token);

        res.json({ ok: true, uploadId: uploadTask.uploadId || '', path: uploadTask.path, size: remoteSize, sha256: uploadTask.sha256 || '' });
    } catch (err) {
        console.warn('[sftp-upload-complete]', 'stat failed', { path: uploadTask.path, error: err.message });
        destroyUploadSession(token);
        sftpUploadTokens.delete(token);
        res.status(500).json({ error: `校验远端文件失败：${err.message}` });
    }
});

app.get('/api/sftp/hash/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) {
        return res.status(404).json({ error: '下载任务不存在' });
    }
    const session = sshTerminalSessions.get(download.sessionId);
    const connectionConfig = download.connectionConfig || session?.connectionConfig;
    if (!connectionConfig) return res.status(410).json({ error: '下载连接配置已失效' });
    try {
        const sha256 = await withRoutedSftp(connectionConfig, async ({ sftp }) => sftpHashFile(sftp, download.path));
        download.sha256 = sha256;
        download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
        res.json({ ok: true, path: download.path, size: Number(download.size) || 0, sha256 });
    } catch (err) {
        res.status(500).json({ error: `计算 SHA-256 失败：${err.message}` });
    }
});

app.get('/api/sftp/download-progress/:token', requireAuth, (req, res) => {
    const token = String(req.params.token || '');
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) {
        return res.status(404).json({ error: '下载任务不存在' });
    }
    res.json({
        downloadId: download.downloadId || '',
        path: download.path,
        size: Number(download.size) || 0,
        loaded: Number(download.loaded) || 0,
        status: download.status || 'pending',
    });
});

app.post('/api/sftp/download-control/:token', requireAuth, (req, res) => {
    const token = String(req.params.token || '');
    const action = String(req.body?.action || '').toLowerCase();
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) return res.status(404).json({ error: '下载任务不存在' });
    if (action === 'pause') {
        download.status = 'paused';
        download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
        try { download.activeStream?.destroy?.(); } catch {}
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: Number(download.loaded) || 0, size: Number(download.size) || 0, status: 'paused' });
        return res.json({ ok: true, status: 'paused' });
    }
    if (action === 'cancel') {
        download.status = 'error';
        // fileHandle 不是 stream，destroy() 对它无效；必须直接销毁 HTTP response，
        // 并关闭底层 SFTP/SSH 连接，才能真正终止浏览器原生下载任务。
        try { download.activeResponse?.destroy?.(new Error('download cancelled')); } catch {}
        try { download.activeStream?.destroy?.(); } catch {}
        try { if (download.activeSftp && download.activeFileHandle) download.activeSftp.close(download.activeFileHandle, () => {}); } catch {}
        try { download.activeSftp?.end?.(); } catch {}
        try { [...(download.activeRouted?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} }); } catch {}
        download.activeResponse = null;
        download.activeStream = null;
        download.activeFileHandle = null;
        download.activeSftp = null;
        download.activeRouted = null;
        if (download.cleanupAfterDownload) cleanupRemoteTempFile(download.connectionConfig, download.path);
        sftpDownloadTokens.delete(token);
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: Number(download.loaded) || 0, size: Number(download.size) || 0, status: 'error' });
        return res.json({ ok: true, status: 'cancelled' });
    }
    res.status(400).json({ error: '不支持的操作' });
});

app.get('/api/sftp/download/:token', requireAuth, async (req, res) => {
    const token = String(req.params.token || '');
    const download = sftpDownloadTokens.get(token);
    if (!download || download.username !== req.session.username || download.expiresAt < Date.now()) {
        sftpDownloadTokens.delete(token);
        return res.status(404).send('下载链接已失效');
    }
    const session = sshTerminalSessions.get(download.sessionId);
    const connectionConfig = download.connectionConfig || session?.connectionConfig;
    if (!connectionConfig) {
        sftpDownloadTokens.delete(token);
        return res.status(410).send('下载连接配置已失效，请重新打开文件管理器后下载');
    }
    let routed = null;
    let sftp = null;
    let fileHandle = null;
    try {
        routed = await createRoutedSSHConnection(connectionConfig, 10000);
        sftp = await new Promise((resolve, reject) => {
            routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp));
        });
    } catch (err) {
        if (routed?.clients) routed.clients.reverse().forEach((client) => { try { client.end(); } catch {} });
        sftpDownloadTokens.delete(token);
        return res.status(410).send(`下载专用 SFTP 连接失败：${err.message}`);
    }
    const fileName = String(download.displayName || path.basename(download.path || 'download') || 'download');
    const size = Number(download.size) || 0;
    const range = String(req.headers.range || '');
    let start = 0;
    let end = size > 0 ? size - 1 : undefined;
    let partial = false;
    if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        const rejectRange = () => {
            res.setHeader('Content-Range', `bytes */${size || '*'}`);
            return res.status(416).end();
        };
        if (!match || !size) return rejectRange();
        if (match[1] === '' && match[2] === '') return rejectRange();
        if (match[1] === '') {
            const suffix = Number(match[2]);
            if (!Number.isFinite(suffix) || suffix <= 0) return rejectRange();
            start = Math.max(0, size - suffix);
        } else {
            start = Number(match[1]);
            if (match[2] !== '') end = Number(match[2]);
        }
        if (!Number.isFinite(start) || start < 0 || start >= size || !Number.isFinite(end) || end < start) return rejectRange();
        end = Math.min(end, size - 1);
        partial = true;
    }
    const contentLength = size > 0 && Number.isFinite(end) ? end - start + 1 : size;
    download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
    res.status(partial ? 206 : 200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    if (size > 0) res.setHeader('Content-Length', String(contentLength));
    if (download.sha256 && !partial) res.setHeader('X-Zephyr-SHA256', download.sha256);
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    let keepaliveTimer = null;
    const stopKeepalive = () => {
        if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
    };

    if (routed?.client?._sock?.setKeepAlive) {
        try { routed.client._sock.setKeepAlive(true, SFTP_DOWNLOAD_KEEPALIVE_INTERVAL); } catch {}
    }

    let settled = false;
    let cleanedUp = false;
    let pumpPaused = false;

    const closeDownloadConnection = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    };

    const finalizeDone = () => {
        if (settled) return;
        settled = true;
        download.loaded = size || download.loaded;
        download.status = 'done';
        download.activeStream = null;
        download.activeFileHandle = null;
        download.activeResponse = null;
        download.activeSftp = null;
        download.activeRouted = null;
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: download.loaded, size, status: 'done' });
        stopKeepalive();
        closeDownloadConnection();
        try { if (fileHandle) sftp.close(fileHandle, () => {}); } catch {}
        if (download.cleanupAfterDownload) cleanupRemoteTempFile(connectionConfig, download.path);
        if (!partial || end >= size - 1) setTimeout(() => sftpDownloadTokens.delete(token), 10000);
    };

    const failDownload = (errMessage) => {
        if (settled) return;
        settled = true;
        download.status = 'error';
        download.activeStream = null;
        download.activeFileHandle = null;
        download.activeResponse = null;
        download.activeSftp = null;
        download.activeRouted = null;
        sendTransferEvent(download.username, { transferId: download.downloadId || token, direction: 'download', path: download.path, loaded: Number(download.loaded) || 0, size, status: 'error' });
        stopKeepalive();
        closeDownloadConnection();
        try { if (fileHandle) sftp.close(fileHandle, () => {}); } catch {}
        console.warn('[sftp-download]', 'failed', { path: download.path, range, error: errMessage });
        if (!res.headersSent) res.status(500).send(errMessage || '下载失败');
        else res.destroy();
    };

    // === Fix: Explicit chunked SFTP read (分片读取) using sftp.open() + sftp.read() ===
    // Instead of createReadStream which can silently buffer too much, we read in
    // controlled chunks with keepalive between reads to prevent SSH channel timeout.
    const CHUNK_SIZE = 256 * 1024; // 256KB：兼容 OpenSSH/Dropbear 等 SFTP 服务端的单次 READ 上限，避免大文件/MP4 下载中断

    try {
        fileHandle = await new Promise((resolve, reject) => {
            sftp.open(download.path, 'r', (err, handle) => err ? reject(err) : resolve(handle));
        });
    } catch (err) {
        return failDownload(`打开远端文件失败：${err.message}`);
    }

    download.activeStream = fileHandle;
    download.activeFileHandle = fileHandle;
    download.activeResponse = res;
    download.activeSftp = sftp;
    download.activeRouted = routed;
    download.status = 'active';
    download.loaded = start;

    // Start reading in chunks from the requested start position
    let position = start;
    const readEnd = end != null ? end : (size > 0 ? size - 1 : Infinity);
    let sftpKeepaliveSeq = 0;
    let lastProgressSentAt = 0;

    const pumpNext = () => {
        if (settled || res.destroyed) return;

        const remaining = readEnd - position + 1;
        if (remaining <= 0) {
            // Done reading all chunks
            res.end();
            finalizeDone();
            return;
        }

        const thisChunkSize = Math.min(CHUNK_SIZE, remaining);
        const buf = Buffer.alloc(thisChunkSize);

        sftp.read(fileHandle, buf, 0, thisChunkSize, position, (readErr, bytesRead) => {
            if (settled) return;
            if (readErr) return failDownload(`读取远端文件失败：${readErr.message}`);

            if (bytesRead <= 0) {
                // EOF
                res.end();
                finalizeDone();
                return;
            }

            const data = bytesRead < thisChunkSize ? buf.subarray(0, bytesRead) : buf;
            position += bytesRead;
            download.loaded = Math.min(size || Number.MAX_SAFE_INTEGER, position);
            download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;

            // Progress broadcast (throttled)
            const now = Date.now();
            if (now - lastProgressSentAt > 250) {
                lastProgressSentAt = now;
                sendTransferEvent(download.username, {
                    transferId: download.downloadId || token,
                    direction: 'download',
                    path: download.path,
                    loaded: download.loaded,
                    size,
                    status: 'active',
                });
            }

            // Write to HTTP response with backpressure handling
            pumpPaused = false;
            const canContinue = res.write(data);
            if (!canContinue) {
                pumpPaused = true;
                res.once('drain', () => {
                    pumpPaused = false;
                    pumpNext();
                });
            } else {
                pumpNext();
            }
        });
    };

    // Start the chunked read loop
    pumpNext();

    // Keepalive: TCP + SFTP channel layer
    keepaliveTimer = setInterval(() => {
        if (res.destroyed || settled) {
            stopKeepalive();
            return;
        }
        download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
        try { routed?.client?._sock?.setKeepAlive?.(true, SFTP_DOWNLOAD_KEEPALIVE_INTERVAL); } catch {}
        sftpKeepaliveSeq++;
        if (sftpKeepaliveSeq % 2 === 0 && sftp && !settled) {
            try { sftp.realpath('.', () => {}); } catch {}
        }
    }, SFTP_DOWNLOAD_KEEPALIVE_INTERVAL);
    keepaliveTimer.unref?.();

    res.on('finish', () => {
        if (!settled) finalizeDone();
    });

    res.on('close', () => {
        stopKeepalive();
        try { if (fileHandle) sftp.close(fileHandle, () => {}); } catch {}
        if (download.activeStream === fileHandle) download.activeStream = null;
        if (download.activeFileHandle === fileHandle) download.activeFileHandle = null;
        if (download.activeResponse === res) download.activeResponse = null;
        if (download.activeSftp === sftp) download.activeSftp = null;
        if (download.activeRouted === routed) download.activeRouted = null;
        closeDownloadConnection();
        if (!settled) download.expiresAt = Date.now() + SFTP_DOWNLOAD_TOKEN_TTL;
    });
});

app.use('/vendor/viewerjs', express.static(path.join(__dirname, 'node_modules', 'viewerjs', 'dist')));
app.use('/vendor/novnc', express.static(path.join(__dirname, 'node_modules', '@novnc', 'novnc')));
app.get('/vendor/@wterm/dom/terminal.css', (req, res) => {
    res.type('text/css').sendFile(path.join(__dirname, 'node_modules', '@wterm', 'dom', 'src', 'terminal.css'));
});
app.use('/vendor/@wterm', express.static(path.join(__dirname, 'node_modules', '@wterm')));
app.get('/app.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/terminal.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminal.html')));
app.get('/rdp.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'rdp.html')));
// Serve files from RDP clipboard download temp dir (for SSH→RDP file transfer)
app.get('/api/rdp/clipboard-file', requireAuth, (req, res) => {
    const filePath = String(req.query.path || '');
    const name = String(req.query.name || '');
    if (!filePath || !filePath.startsWith('/tmp/zephyr-clip-')) {
        return res.status(400).json({ error: 'invalid path' });
    }
    try {
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name || path.basename(filePath))}"`);
        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => res.status(500).json({ error: err.message }));
        stream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/novnc.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'novnc.html')));
app.get('/player.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// 健康检查
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// 兜底路由
app.get('*', (req, res) => {
    if (req.url.startsWith('/vendor') || req.url.startsWith('/ssh')) {
        return res.status(404).end();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wsServerOptions = {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 10 * 1024 * 1024,
};
const wss = new WebSocketServer(wsServerOptions);
const noVncWss = new WebSocketServer(wsServerOptions);
const editorLspWss = new WebSocketServer(wsServerOptions);
const rdpH264Wss = new WebSocketServer(wsServerOptions);
const rdpAudioWss = new WebSocketServer(wsServerOptions);

server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
        pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
        pathname = req.url || '';
    }

    const targetWss = pathname === '/ssh' ? wss : pathname === '/rdp-h264' ? rdpH264Wss : pathname === '/rdp-audio' ? rdpAudioWss : pathname === '/novnc' ? noVncWss : pathname === '/editor-lsp' ? editorLspWss : null;
    if (!targetWss) {
        console.warn('[WS-DIAG] rejected websocket upgrade for unknown path', { url: req.url || '' });
        rejectSocket(socket, 404, 'Not Found');
        return;
    }
    const session = currentSession(req);
    if (!session || session.mustChangePassword) {
        rejectSocket(socket, session?.mustChangePassword ? 403 : 401, session?.mustChangePassword ? 'Forbidden' : 'Unauthorized');
        return;
    }

    targetWss.handleUpgrade(req, socket, head, (ws) => {
        targetWss.emit('connection', ws, req);
    });
});

editorLspWss.on('connection', handleEditorLspConnection);

const RDP_STREAM_WIDTH = Number(process.env.RDP_H264_WIDTH || 1280);
const RDP_STREAM_HEIGHT = Number(process.env.RDP_H264_HEIGHT || 720);
const RDP_STREAM_FPS = Number(process.env.RDP_H264_FPS || 30);
const RDP_NATIVE_H264 = process.env.RDP_NATIVE_H264 === 'true';
const RDP_ALLOW_GFX_FALLBACK = process.env.RDP_ALLOW_GFX_FALLBACK === 'true';
const rdpPipes = new Map();
const rdpAudioWorkers = new Map(); // connectionId → pipeline state

function evenClampRdpSize(value, min, max) {
    const n = Math.max(min, Math.min(max, Number(value) || min));
    return Math.max(2, Math.floor(n / 2) * 2);
}
function evenRdpSize(value, min = 2, max = 4096) {
    const n = Math.max(min, Math.min(max, Number(value) || min));
    return Math.max(2, Math.floor(n / 2) * 2);
}

function allocateRdpDisplayNumber() {
    for (let i = 0; i < 80; i++) {
        const n = 100 + ((Date.now() + process.pid + i) % 500);
        if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) return n;
    }
    return 600 + Math.floor(Math.random() * 300);
}

function rdpSpawn(name, args, options = {}) {
    const child = spawn(name, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.on('error', (err) => console.error('[rdp-h264]', `${name} spawn failed`, { error: err.message }));
    return child;
}

function rdpAttachLog(child, label, level = 'info') {
    if (label !== 'ffmpeg' && label !== 'rdp-audio') child.stdout?.on('data', (d) => console.debug('[rdp-h264]', `${label} stdout`, d.toString('utf8').trim()));
    child.stderr?.on('data', (d) => {
        const text = d.toString('utf8').trim();
        if (!text) return;
        if (level === 'warn' || /error|failed|unable|denied/i.test(text)) console.warn('[rdp-h264]', `${label} stderr`, text);
        else console.info('[rdp-h264]', `${label} stderr`, text);
    });
    child.on('exit', (code, signal) => console.warn('[rdp-h264]', `${label} exited`, { code, signal }));
}

async function startRdpH264Pipeline(connId, conn, options = {}) {
    cleanupPipe(connId);
    const originalTargetHost = conn.host;
    const originalTargetPort = Number(conn.port) || 3389;
    let routedForward = null;
    let effectiveConn = conn;
    try {
        routedForward = await createRoutedTcpForward(conn, originalTargetPort, 15000);
        if (routedForward) {
            effectiveConn = { ...conn, host: routedForward.host, port: routedForward.port };
            console.info('[rdp-h264]', 'using routed local forward', { connId, route: routedForward.route, originalTarget: `${originalTargetHost}:${originalTargetPort}`, localTarget: `${routedForward.host}:${routedForward.port}` });
        }
    } catch (err) {
        try { routedForward?.close?.(); } catch {}
        throw err;
    }
    const targetHost = effectiveConn.host;
    const targetPort = Number(effectiveConn.port) || 3389;
    const username = effectiveConn.username || 'Administrator';
    const password = effectiveConn.password || '';
    let streamWidth = evenClampRdpSize(options.width || RDP_STREAM_WIDTH, 800, 2560);
    let streamHeight = evenClampRdpSize(options.height || RDP_STREAM_HEIGHT, 600, 1600);
    const aspectMode = String(options.mode || '').toLowerCase();
    const qualityMode = ['performance', 'balanced', 'quality'].includes(String(options.quality || '').toLowerCase()) ? String(options.quality).toLowerCase() : 'balanced';
    const isPerf = qualityMode === 'performance';
    const isQual = qualityMode === 'quality';
    const forceAspect = (num, den) => {
        const longSide = Math.max(streamWidth, streamHeight);
        const shortSide = Math.min(streamWidth, streamHeight);
        streamWidth = longSide;
        streamHeight = shortSide;
        let unit = Math.max(1, Math.min(Math.floor(streamWidth / num), Math.floor(streamHeight / den)));
        streamWidth = evenRdpSize(num * unit, 800, 2560);
        streamHeight = evenRdpSize(den * unit, 600, 1600);
        if (streamWidth > 2560 || streamHeight > 1600) {
            unit = Math.max(1, Math.min(Math.floor(2560 / num), Math.floor(1600 / den)));
            streamWidth = evenRdpSize(num * unit, 800, 2560);
            streamHeight = evenRdpSize(den * unit, 600, 1600);
        }
    };
    if (aspectMode === '16:9') forceAspect(16, 9);
    else if (aspectMode === '4:3') forceAspect(4, 3);
    streamWidth = evenRdpSize(streamWidth, 800, 2560);
    streamHeight = evenRdpSize(streamHeight, 600, 1600);
    const displayNo = allocateRdpDisplayNumber();
    const xvfbDisp = `:${displayNo}`;
    const fifoPath = `/tmp/zephyr-rdp-h264-${connId}.h264`;
    try { fs.rmSync(fifoPath, { force: true }); } catch {}
    try { require('child_process').execFileSync('mkfifo', [fifoPath]); } catch (err) { console.warn('[rdp-h264]', 'mkfifo failed, native export disabled', { error: err.message }); }
    const shareDir = `/tmp/zephyr-rdp-share-${connId}`;
    try { fs.rmSync(shareDir, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(shareDir, { recursive: true }); } catch {}
    const env = { ...process.env, DISPLAY: xvfbDisp, ZEPHYR_RDP_H264_PIPE: fifoPath, PULSE_SERVER: `unix:/tmp/zephyr-pulse-${connId}/native` };

    let pulseaudio = null;
    const rdpAudioBackend = (() => {
        const pulsePaths = ['/usr/lib/freerdp2/librdpsnd-client-pulse.so', '/usr/lib/freerdp2/rdpsnd-client-pulse.so', '/opt/freerdp-zephyr/lib/freerdp2/librdpsnd-client-pulse.so'];
        if (pulsePaths.some((p) => fs.existsSync(p))) return 'pulse';
        if (fs.existsSync('/usr/lib/freerdp2/librdpsnd-client-alsa.so')) return 'alsa-pulse';
        return '';
    })();
    if (process.env.RDP_AUDIO !== 'false' && rdpAudioBackend) {
        try { fs.rmSync(`/tmp/zephyr-pulse-${connId}`, { recursive: true, force: true }); } catch {}
        try { fs.mkdirSync(`/tmp/zephyr-pulse-${connId}`, { recursive: true }); } catch {}
        const asoundrcPath = `/tmp/zephyr-pulse-${connId}/asoundrc`;
        try {
            fs.writeFileSync(asoundrcPath, 'pcm.!default { type pulse }\nctl.!default { type pulse }\n');
            env.ALSA_CONFIG_PATH = asoundrcPath;
        } catch {}
        pulseaudio = rdpSpawn('pulseaudio', ['--daemonize=no', '--exit-idle-time=-1', '--disallow-exit=true', `--load=module-native-protocol-unix socket=/tmp/zephyr-pulse-${connId}/native auth-anonymous=1`, '--load=module-null-sink sink_name=zephyr_rdp_audio sink_properties=device.description=ZephyrRdpAudio'], { env });
        rdpAttachLog(pulseaudio, 'pulseaudio', 'warn');
        await new Promise((resolve) => setTimeout(resolve, 900));
        console.info('[rdp-audio]', 'audio backend enabled', { connId, backend: rdpAudioBackend });
    }

    const xvfb = rdpSpawn('Xvfb', [xvfbDisp, '-screen', '0', `${streamWidth}x${streamHeight}x24`, '-ac', '+extension', 'RANDR']);
    rdpAttachLog(xvfb, 'Xvfb');
    await new Promise((resolve) => setTimeout(resolve, 700));

    const xfreerdpArgs = [
        `/v:${targetHost}:${targetPort}`,
        `/u:${username}`,
        `/p:${password}`,
        '/cert:ignore',
        `/size:${streamWidth}x${streamHeight}`,
        isPerf ? '/bpp:24' : '/bpp:32',
        isPerf ? '/network:broadband' : isQual ? '/network:lan' : '/network:wan',
        ...(RDP_NATIVE_H264 && !RDP_ALLOW_GFX_FALLBACK ? ['/gfx:AVC444'] : ['+gfx']),
        '+fonts',
        '+clipboard',
        `/drive:zephyr-share,${shareDir}`,
        ...(process.env.RDP_AUDIO === 'false' ? [] : (rdpAudioBackend === 'pulse' ? ['/sound:sys:pulse,format:1,rate:44100,channel:2', '+async-channels'] : rdpAudioBackend === 'alsa-pulse' ? ['/audio-mode:0', '/sound:sys:alsa,format:1,rate:44100,channel:2', '+async-channels'] : [])),
        ...(isPerf
            ? ['-wallpaper', '-themes', '-aero', '-window-drag', '-menu-anims']
            : isQual
                ? ['+wallpaper', '+themes', '+aero', '+window-drag', '+menu-anims']
                : ['+wallpaper', '+themes', '+aero', '-window-drag', '-menu-anims']),
        '-fast-path',
        ...(isQual ? [] : ['-mouse-motion']),
        '/log-level:WARN',
    ];
    const nativeH264 = RDP_NATIVE_H264 && fs.existsSync(fifoPath);
    const xfreerdpBin = nativeH264 ? (process.env.RDP_FREERDP_BIN || 'xfreerdp') : (process.env.RDP_FALLBACK_FREERDP_BIN || '/usr/bin/xfreerdp');
    const xfreerdp = rdpSpawn(xfreerdpBin, xfreerdpArgs, { env });
    rdpAttachLog(xfreerdp, 'xfreerdp', 'warn');

    const x264Preset = isPerf ? 'ultrafast' : isQual ? 'veryfast' : 'superfast';
    const x264Crf = isPerf ? '32' : isQual ? '20' : '26';
    const x264Profile = isQual ? 'main' : 'baseline';
    const x264Params = `repeat-headers=1:scenecut=0:open-gop=0${isQual ? ':ref=2' : ''}`;
    const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'x11grab', '-draw_mouse', '0',
        '-framerate', String(RDP_STREAM_FPS),
        '-video_size', `${streamWidth}x${streamHeight}`,
        '-i', xvfbDisp,
        '-an', '-c:v', 'libx264',
        '-preset', x264Preset, '-tune', 'zerolatency',
        '-profile:v', x264Profile,
        '-crf', x264Crf,
        '-pix_fmt', 'yuv420p',
        '-g', String(RDP_STREAM_FPS), '-keyint_min', String(RDP_STREAM_FPS),
        '-x264-params', x264Params,
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'h264', 'pipe:1',
    ];
    const ffmpeg = nativeH264 ? null : rdpSpawn('ffmpeg', ffmpegArgs, { env });
    if (ffmpeg) rdpAttachLog(ffmpeg, 'ffmpeg', 'warn');

    let activeWindowId = null;
    setTimeout(() => {
        const finder = spawn('xdotool', ['search', '--class', 'xfreerdp'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        finder.stdout.on('data', (d) => { out += d.toString('utf8'); });
        finder.on('close', () => {
            activeWindowId = out.trim().split(/\s+/).find(Boolean) || null;
            if (activeWindowId) console.info('[rdp-h264]', 'xfreerdp window detected', { connId, window: activeWindowId });
        });
    }, 2200);

    const pipe = {
        connId, xvfb, pulseaudio, xfreerdp, ffmpeg, fifoPath, nativeH264, env, width: streamWidth, height: streamHeight, quality: qualityMode, routedForward,
        get activeWindowId() { return activeWindowId; },
        nativeReader: null,
        clients: new Set(),
        audioClients: new Set(),
        audioFfmpeg: null,
        shareDir,
        clipboardTimer: null,
        lastRemoteClipboardText: '',
        startedAt: Date.now(),
        ready: false,
        stopping: false,
    };
    rdpPipes.set(connId, pipe);

    const markReady = () => {
        if (!pipe.ready) console.info('[rdp-h264]', 'pipeline ready', { connId, target: `${targetHost}:${targetPort}`, width: streamWidth, height: streamHeight, quality: qualityMode });
        pipe.ready = true;
    };
    const readyTimer = setTimeout(markReady, 1800);
    xfreerdp.stderr?.on('data', (d) => {
        if (/connected|Logon|GFX|AVC|framebuffer|Desktop/i.test(d.toString('utf8'))) markReady();
    });

    const broadcastH264 = (chunk) => {
        if (chunk.length > 0) markReady();
        for (const client of pipe.clients) {
            if (client.readyState !== client.OPEN) continue;
            if (client.bufferedAmount > 8 * 1024 * 1024) continue;
            try { client.send(chunk, { binary: true }); } catch {}
        }
    };
    if (nativeH264) {
        pipe.nativeReader = fs.createReadStream(fifoPath, { highWaterMark: 512 * 1024 });
        pipe.nativeReader.on('data', broadcastH264);
        pipe.nativeReader.on('error', (err) => console.warn('[rdp-h264]', 'native h264 pipe error', { connId, error: err.message }));
        pipe.nativeReader.on('end', () => console.warn('[rdp-h264]', 'native h264 pipe ended', { connId }));
    } else if (ffmpeg) {
        ffmpeg.stdout.on('data', broadcastH264);
        ffmpeg.on('exit', (code, signal) => {
            clearTimeout(readyTimer);
            const latest = rdpPipes.get(connId);
            if (pipe.stopping || latest !== pipe) return;
            console.warn('[rdp-h264]', 'encoder exited unexpectedly, requesting reconnect', { connId, code, signal });
            for (const client of pipe.clients) {
                try { if (client.readyState === client.OPEN) client.close(1012, 'rdp encoder restarting'); } catch {}
            }
            cleanupPipe(connId);
        });
    }
    xfreerdp.on('exit', (code, signal) => {
        const latest = rdpPipes.get(connId);
        if (pipe.stopping || latest !== pipe) return;
        console.warn('[rdp-h264]', 'xfreerdp exited unexpectedly', { connId, code, signal });
        for (const client of pipe.clients) {
            try { if (client.readyState === client.OPEN) client.close(1011, 'xfreerdp exited'); } catch {}
        }
        cleanupPipe(connId);
    });

    console.info('[rdp-h264]', 'pipeline started', { connId, target: `${targetHost}:${targetPort}`, originalTarget: `${originalTargetHost}:${originalTargetPort}`, route: routedForward?.route || 'direct', mode: nativeH264 ? 'freerdp-avc-export' : 'x11grab-fallback', quality: qualityMode, encoder: nativeH264 ? 'native' : { preset: x264Preset, crf: x264Crf, profile: x264Profile }, xfreerdpArgs: xfreerdpArgs.filter((a) => !a.startsWith('/p:')) });
    return pipe;
}

function shQuote(value) {
    return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function pasteTextIntoRdp(pipe, text, { paste = true } = {}) {
    if (!text || !pipe) return;
    const quoted = shQuote(text);
    const pasteCmd = pipe?.activeWindowId ? `xdotool key --window ${pipe.activeWindowId} --clearmodifiers ctrl+v` : `xdotool key --clearmodifiers ctrl+v`;
    const xclipSet = `printf %s ${quoted} | xclip -selection clipboard -i && printf %s ${quoted} | xclip -selection primary -i`;
    const script = paste ? `(${xclipSet} && ${pasteCmd})` : `(${xclipSet})`;
    const child = spawn('sh', ['-c', script], { env: pipe.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString('utf8'); });
    child.on('close', (code) => {
        if (code !== 0) console.warn('[rdp-h264]', 'rdp clipboard operation failed', { paste, code, window: pipe.activeWindowId || '', error: errText.trim().slice(0, 240) });
        else console.info('[rdp-h264]', 'rdp clipboard operation ok', { paste, length: String(text).length, window: pipe.activeWindowId || '' });
    });
    child.on('error', (err) => console.warn('[rdp-h264]', 'rdp clipboard operation spawn failed', { error: err.message, paste }));
}

async function copySftpClipboardToRdpShare(username, shareDir, pipe, clip) {
    if (!clip || !clip.sourceConnectionConfig) throw new Error('SSH 剪贴板来源无效');
    const routed = await createRoutedSSHConnection(clip.sourceConnectionConfig, 10000);
    let sftp = null;
    try {
        sftp = await new Promise((resolve, reject) => routed.client.sftp((err, nextSftp) => err ? reject(err) : resolve(nextSftp)));
        for (const item of clip.items) {
            const safeName = String(item.name || item.path.split('/').pop() || 'file').replace(/[\\\\/]/g, '_').slice(0, 200);
            const target = path.join(shareDir, safeName);
            await new Promise((resolve, reject) => {
                const readStream = sftp.createReadStream(item.path);
                const writeStream = fs.createWriteStream(target);
                readStream.on('error', reject);
                writeStream.on('error', reject);
                writeStream.on('close', resolve);
                readStream.pipe(writeStream);
            });
            console.info('[rdp-h264]', 'sftp clipboard file copied to share drive', { connId: pipe.connId, name: safeName, size: item.size });
        }
        // Open Explorer to the shared drive
        if (pipe.activeWindowId) {
            const quoted = shQuote('\\\\tsclient\\zephyr-share');
            pasteTextIntoRdp(pipe, quoted, { paste: true });
        }
    } finally {
        try { sftp?.end?.(); } catch {}
        [...(routed?.clients || [])].reverse().forEach((client) => { try { client.end?.(); } catch {} });
    }
}

function readTextFromRdpClipboard(pipe, callback) {
    if (!pipe || !callback) return;
    const cmd = 'xclip -selection clipboard -o 2>/dev/null || xclip -selection primary -o 2>/dev/null || true';
    const child = spawn('sh', ['-c', cmd], { env: pipe.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 1024 * 1024) child.kill('SIGTERM'); });
    child.on('close', () => callback(out));
    child.on('error', () => callback(''));
}

function readRdpClipboardFileList(pipe, callback) {
    if (!pipe || !callback) return;
    // Read text/uri-list from X selection (populated by our patched xfreerdp)
    const cmd = 'xclip -selection clipboard -t text/uri-list -o 2>/dev/null || true';
    const child = spawn('sh', ['-c', cmd], { env: pipe.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 1024 * 1024) child.kill('SIGTERM'); });
    child.on('close', () => {
        const files = [];
        for (const line of out.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('file://')) {
                const filePath = decodeURIComponent(trimed.slice(7));
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile()) {
                        files.push({
                            name: path.basename(filePath),
                            path: filePath,
                            size: stat.size,
                        });
                    }
                } catch {}
            }
        }
        callback(files);
    });
    child.on('error', () => callback([]));
}

function startRdpClipboardWatch(pipe) {
    if (!pipe || pipe.clipboardTimer || process.env.RDP_CLIPBOARD_SYNC === 'false') return;
    pipe.lastRemoteClipboardText = '';
    pipe.lastRemoteClipboardFiles = [];
    const tick = () => {
        if (!rdpPipes.has(pipe.connId) || pipe.clients.size === 0) return;
        readTextFromRdpClipboard(pipe, (text) => {
            if (!text || text === pipe.lastRemoteClipboardText) return;
            pipe.lastRemoteClipboardText = text;
            const payload = JSON.stringify({ type: 'clipboard', text });
            for (const client of pipe.clients) {
                if (client.readyState !== client.OPEN) continue;
                try { client.send(payload); } catch {}
            }
            console.info('[rdp-h264]', 'remote clipboard synced to browser', { connId: pipe.connId, length: text.length });
        });
        // Also check for file clipboard (text/uri-list)
        readRdpClipboardFileList(pipe, (files) => {
            if (!files.length) return;
            const sig = files.map((f) => `${f.name}:${f.size}`).join(',');
            if (sig === pipe.lastRemoteClipboardFiles) return;
            pipe.lastRemoteClipboardFiles = sig;
            const payload = JSON.stringify({ type: 'rdp-remote-files', files });
            for (const client of pipe.clients) {
                if (client.readyState !== client.OPEN) continue;
                try { client.send(payload); } catch {}
            }
            console.info('[rdp-h264]', 'remote clipboard files detected', { connId: pipe.connId, count: files.length });
        });
    };
    pipe.clipboardTimer = setInterval(tick, 1200);
    setTimeout(tick, 600);
}



function handleRdpInput(pipe, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!pipe) return;
    if (!pipe.lastPointer) pipe.lastPointer = { x: Math.round((pipe.width || 1280) / 2), y: Math.round((pipe.height || 720) / 2) };
    const execXdo = (args, opts = {}) => {
        if (!pipe || pipe.xfreerdp?.exitCode !== null || pipe.xfreerdp?.killed) return false;
        const windowId = pipe.activeWindowId;
        const finalArgs = windowId && opts.window !== false ? [...args.slice(0, 1), '--window', windowId, ...args.slice(1)] : args;
        const child = spawn('xdotool', finalArgs, { env: pipe.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let errText = '';
        child.stderr?.on('data', (d) => { errText += d.toString('utf8'); });
        child.on('close', (code) => {
            if (code !== 0) console.warn('[rdp-h264]', 'xdotool failed', { code, args: finalArgs, error: errText.trim().slice(0, 240) });
        });
        child.on('error', (err) => console.warn('[rdp-h264]', 'xdotool spawn failed', { error: err.message, args: finalArgs }));
        return true;
    };
    const movePointer = (x, y) => {
        const px = Math.max(0, Math.min((pipe.width || 1280) - 1, Math.round(Number(x))));
        const py = Math.max(0, Math.min((pipe.height || 720) - 1, Math.round(Number(y))));
        pipe.lastPointer = { x: px, y: py };
        if (pipe.activeWindowId) return execXdo(['mousemove', '--window', pipe.activeWindowId, String(px), String(py)], { window: false });
        return execXdo(['mousemove', String(px), String(py)], { window: false });
    };
    const buttonAction = (action, button) => {
        const b = String(button || 1);
        if (pipe.lastPointer) movePointer(pipe.lastPointer.x, pipe.lastPointer.y);
        return execXdo([action, b]);
    };
    if (msg.type === 'mouse' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        movePointer(msg.x, msg.y);
        if (Date.now() - (pipe.lastInputLogAt || 0) > 1000) { pipe.lastInputLogAt = Date.now(); console.info('[rdp-h264]', 'rdp pointer move', { connId: pipe.connId, x: pipe.lastPointer.x, y: pipe.lastPointer.y, window: pipe.activeWindowId || '' }); }
    } else if (msg.type === 'mousedown' && msg.button !== undefined) {
        buttonAction('mousedown', msg.button);
        console.info('[rdp-h264]', 'rdp pointer down', { connId: pipe.connId, button: msg.button, pos: pipe.lastPointer, window: pipe.activeWindowId || '' });
    } else if (msg.type === 'mouseup' && msg.button !== undefined) {
        buttonAction('mouseup', msg.button);
        console.info('[rdp-h264]', 'rdp pointer up', { connId: pipe.connId, button: msg.button, pos: pipe.lastPointer, window: pipe.activeWindowId || '' });
    } else if (msg.type === 'click' && msg.button !== undefined) {
        buttonAction('click', msg.button);
        console.info('[rdp-h264]', 'rdp pointer click', { connId: pipe.connId, button: msg.button, pos: pipe.lastPointer, window: pipe.activeWindowId || '' });
    } else if (msg.type === 'scroll') {
        if (pipe.lastPointer) movePointer(pipe.lastPointer.x, pipe.lastPointer.y);
        const button = Number(msg.deltaY || 0) > 0 ? '5' : '4';
        const rawDelta = Math.abs(Number(msg.deltaY || msg.deltaX || 0));
        const steps = Math.max(1, Math.min(10, Math.round(rawDelta / 45)));
        for (let i = 0; i < steps; i++) execXdo(['click', button]);
        console.info('[rdp-h264]', 'rdp pointer scroll', { connId: pipe.connId, button, steps, pos: pipe.lastPointer, window: pipe.activeWindowId || '' });
    } else if (msg.type === 'key' && msg.key) {
        execXdo(['key', '--clearmodifiers', String(msg.key)]);
    } else if (msg.type === 'text' && msg.text !== undefined) {
        const text = String(msg.text);
        if (/[^\x00-\x7F]/.test(text) || text.length > 1) pasteTextIntoRdp(pipe, text, { paste: true });
        else pasteTextIntoRdp(pipe, text, { paste: true });
    } else if (msg.type === 'clipboard' && msg.text !== undefined) {
        pasteTextIntoRdp(pipe, String(msg.text), { paste: false });
    } else if (msg.type === 'paste' && msg.text !== undefined) {
        pasteTextIntoRdp(pipe, String(msg.text), { paste: true });
    } else if (msg.type === 'rdp-file-upload' && msg.name && msg.data) {
        try {
            const data = Buffer.from(String(msg.data), 'base64');
            const safeName = String(msg.name).replace(/[/\\]/g, '_').slice(0, 200);
            const p = require('path');
            const filePath = p.join(pipe.shareDir, safeName);
            require('fs').writeFileSync(filePath, data);
            console.info('[rdp-h264]', 'file written to share drive', { connId: pipe.connId, name: safeName, size: data.length });
            for (const client of pipe.clients) {
                if (client.readyState !== client.OPEN) continue;
                try { client.send(JSON.stringify({ type: 'rdp-file-upload-ack', name: safeName, size: data.length })); } catch {}
            }
        } catch (err) {
            console.warn('[rdp-h264]', 'rdp file upload failed', { connId: pipe.connId, error: err.message });
        }
    } else if (msg.type === 'rdp-file-open-share') {
        if (pipe.activeWindowId) execXdo(['key', '--window', pipe.activeWindowId, '--clearmodifiers', 'super+r'], { window: false });
        setTimeout(() => { pasteTextIntoRdp(pipe, '\\\\tsclient\\zephyr-share', { paste: true }); }, 600);
    } else if (msg.type === 'rdp-sftp-clipboard-paste') {
        const username = String(pipe.username || '');
        const clip = sftpClipboardByUser.get(username);
        if (!clip || !Array.isArray(clip.items) || !clip.items.length) {
            for (const client of pipe.clients) {
                if (client.readyState !== client.OPEN) continue;
                try { client.send(JSON.stringify({ type: 'rdp-sftp-clipboard-paste-ack', ok: false, error: 'SSH 剪贴板为空' })); } catch {}
            }
        } else {
            (async () => {
                try {
                    await copySftpClipboardToRdpShare(username, pipe.shareDir, pipe, clip);
                    for (const client of pipe.clients) {
                        if (client.readyState !== client.OPEN) continue;
                        try { client.send(JSON.stringify({ type: 'rdp-sftp-clipboard-paste-ack', ok: true, count: clip.items.length })); } catch {}
                    }
                } catch (err) {
                    for (const client of pipe.clients) {
                        if (client.readyState !== client.OPEN) continue;
                        try { client.send(JSON.stringify({ type: 'rdp-sftp-clipboard-paste-ack', ok: false, error: err.message })); } catch {}
                    }
                }
            })();
        }
    } else if (msg.type === 'resize' && Number.isFinite(msg.width) && Number.isFinite(msg.height)) {
        execXdo(['key', 'F5']);
    }
}


function startIsolatedRdpAudioWorker(connId, conn) {
    if (process.env.RDP_AUDIO !== 'force') return null;
    const existing = rdpAudioWorkers.get(connId);
    if (existing && !existing.stopping) return existing;
    const targetHost = conn.host;
    const targetPort = Number(conn.port) || 3389;
    const username = conn.username || 'Administrator';
    const password = conn.password || '';
    const displayNo = allocateRdpDisplayNumber();
    const xvfbDisp = `:${displayNo}`;
    const pulseDir = `/tmp/zephyr-rdp-audio-${connId}`;
    try { fs.rmSync(pulseDir, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(pulseDir, { recursive: true }); } catch {}
    const env = { ...process.env, DISPLAY: xvfbDisp, PULSE_SERVER: `unix:${pulseDir}/native` };
    try {
        const asoundrcPath = `${pulseDir}/asoundrc`;
        fs.writeFileSync(asoundrcPath, 'pcm.!default { type pulse }\nctl.!default { type pulse }\n');
        env.ALSA_CONFIG_PATH = asoundrcPath;
    } catch {}
    const worker = { connId, clients: new Set(), pulseaudio: null, xvfb: null, xfreerdp: null, ffmpeg: null, stopping: false, startedAt: Date.now() };
    rdpAudioWorkers.set(connId, worker);
    worker.pulseaudio = rdpSpawn('pulseaudio', ['--daemonize=no', '--exit-idle-time=-1', '--disallow-exit=true', `--load=module-native-protocol-unix socket=${pulseDir}/native auth-anonymous=1`, '--load=module-null-sink sink_name=zephyr_rdp_audio sink_properties=device.description=ZephyrRdpAudio'], { env });
    rdpAttachLog(worker.pulseaudio, 'rdp-audio-pulse', 'warn');
    worker.xvfb = rdpSpawn('Xvfb', [xvfbDisp, '-screen', '0', '800x600x24', '-ac']);
    rdpAttachLog(worker.xvfb, 'rdp-audio-xvfb', 'warn');
    setTimeout(() => {
        if (worker.stopping) return;
        const args = [
            `/v:${targetHost}:${targetPort}`, `/u:${username}`, `/p:${password}`, '/cert:ignore', '/size:800x600', '/bpp:16', '/network:lan',
            '-clipboard', '-wallpaper', '-themes', '-aero', '-window-drag', '-menu-anims', '-fonts', '-fast-path', '-mouse-motion',
            '/audio-mode:0', '/sound:sys:alsa,format:1,rate:44100,channel:2', '/log-level:WARN'
        ];
        worker.xfreerdp = rdpSpawn('xfreerdp', args, { env });
        rdpAttachLog(worker.xfreerdp, 'rdp-audio-xfreerdp', 'warn');
        worker.xfreerdp.on('exit', () => cleanupIsolatedRdpAudioWorker(connId));
        console.info('[rdp-audio]', 'isolated audio rdp started', { connId, target: `${targetHost}:${targetPort}`, args: args.filter((a) => !a.startsWith('/p:')) });
    }, 1000);
    setTimeout(() => startIsolatedRdpAudioCapture(worker), 1800);
    return worker;
}

function startIsolatedRdpAudioCapture(worker) {
    if (!worker || worker.stopping || worker.ffmpeg) return;
    const args = ['-hide_banner', '-loglevel', 'warning', '-f', 'pulse', '-i', 'zephyr_rdp_audio.monitor', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-application', 'lowdelay', '-f', 'webm', 'pipe:1'];
    const ff = rdpSpawn('ffmpeg', args, { env: { ...process.env, PULSE_SERVER: `unix:/tmp/zephyr-rdp-audio-${worker.connId}/native` } });
    worker.ffmpeg = ff;
    rdpAttachLog(ff, 'rdp-audio', 'warn');
    ff.stdout.on('data', (chunk) => {
        for (const client of worker.clients || []) {
            if (client.readyState !== client.OPEN) continue;
            if (client.bufferedAmount > 2 * 1024 * 1024) continue;
            try { client.send(chunk, { binary: true }); } catch {}
        }
    });
    ff.on('exit', (code, signal) => { console.info('[rdp-audio]', 'isolated capture exited', { connId: worker.connId, code, signal }); if (worker.ffmpeg === ff) worker.ffmpeg = null; });
    console.info('[rdp-audio]', 'isolated capture started', { connId: worker.connId });
}

function cleanupIsolatedRdpAudioWorker(connId) {
    const w = rdpAudioWorkers.get(connId);
    if (!w) return;
    w.stopping = true;
    try { w.ffmpeg?.kill('SIGTERM'); } catch {}
    try { w.xfreerdp?.kill('SIGTERM'); } catch {}
    try { w.xvfb?.kill('SIGTERM'); } catch {}
    try { w.pulseaudio?.kill('SIGTERM'); } catch {}
    try { fs.rmSync(`/tmp/zephyr-rdp-audio-${connId}`, { recursive: true, force: true }); } catch {}
    rdpAudioWorkers.delete(connId);
    console.info('[rdp-audio]', 'isolated worker cleaned', { connId });
}

function startRdpAudioCapture(pipe) {
    if (!pipe || pipe.audioFfmpeg || process.env.RDP_AUDIO === 'false' || !pipe.pulseaudio) return;
    console.info('[rdp-audio]', 'starting audio capture', { connId: pipe.connId });
    const args = [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'pulse', '-i', 'zephyr_rdp_audio.monitor',
        '-vn', '-ac', '2', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', '96k', '-application', 'lowdelay',
        '-f', 'webm', 'pipe:1',
    ];
    const ff = rdpSpawn('ffmpeg', args, { env: pipe.env });
    pipe.audioFfmpeg = ff;
    rdpAttachLog(ff, 'rdp-audio', 'warn');
    ff.stdout.on('data', (chunk) => {
        for (const client of pipe.audioClients || []) {
            if (client.readyState !== client.OPEN) continue;
            if (client.bufferedAmount > 2 * 1024 * 1024) continue;
            try { client.send(chunk, { binary: true }); } catch {}
        }
    });
    ff.on('exit', (code, signal) => { console.info('[rdp-audio]', 'capture exited', { connId: pipe.connId, code, signal }); if (pipe.audioFfmpeg === ff) pipe.audioFfmpeg = null; });
}

noVncWss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/novnc', `http://${req.headers.host || 'localhost'}`);
    const connId = url.searchParams.get('connectionId') || '';
    const started = Date.now();
    let routed = null;
    let remoteSocket = null;
    let proxying = false;
    let cleaned = false;
    const serverReader = new ByteQueue('VNC 服务端');
    const browserReader = new ByteQueue('noVNC 浏览器');
    const sendBrowser = (chunk) => {
        if (ws.readyState !== ws.OPEN) return false;
        try { ws.send(Buffer.from(chunk), { binary: true }); return true; } catch { return false; }
    };
    const cleanup = (reason = 'cleanup', closeBrowser = false) => {
        if (cleaned) return;
        cleaned = true;
        console.info('[novnc-ws]', 'closing proxy', { connectionId: connId, reason, durationMs: Date.now() - started });
        try { serverReader.close(new Error(reason)); } catch {}
        try { browserReader.close(new Error(reason)); } catch {}
        try { remoteSocket?.destroy?.(); } catch {}
        (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
        if (closeBrowser && ws.readyState === ws.OPEN) {
            const code = /unauthorized|connection not found|not a VNC/i.test(String(reason)) ? 1008 : 1011;
            try { ws.close(code, String(reason).slice(0, 120)); } catch {}
        }
    };

    ws.on('message', (raw) => {
        const chunk = Buffer.from(raw || []);
        if (!chunk.length) return;
        if (proxying) {
            try { remoteSocket?.write?.(chunk); } catch (err) { cleanup(err.message || 'browser-write-failed', true); }
        } else browserReader.push(chunk);
    });
    ws.on('close', () => cleanup('browser-close', false));
    ws.on('error', (err) => cleanup(err.message || 'browser-error', false));

    try {
        const sessionUser = currentSession(req);
        if (!sessionUser) { ws.close(1008, 'unauthorized'); return; }
        const store = readJSON(CONNECTIONS_FILE, { connections: [] });
        const conn = (store.connections || []).find((c) => c.id === connId);
        if (!conn) { ws.close(1008, 'connection not found'); return; }
        if (String(conn.protocol || '').toUpperCase() !== 'VNC') { ws.close(1008, 'not a VNC connection'); return; }

        const timeout = 15000;
        const targetPort = Number(conn.port) || 5900;
        routed = await openRoutedTcpConnection(conn, targetPort, timeout);
        remoteSocket = routed.socket;
        try { remoteSocket.setNoDelay?.(true); } catch {}
        remoteSocket.on('data', (chunk) => { if (proxying) sendBrowser(chunk); else serverReader.push(chunk); });
        remoteSocket.once('close', () => {
            serverReader.close(new Error('VNC 服务端已关闭连接'));
            if (!cleaned && ws.readyState === ws.OPEN) ws.close(proxying ? 1000 : 1011, 'vnc server closed');
            cleanup('vnc-server-close', false);
        });
        remoteSocket.once('error', (err) => {
            serverReader.close(err);
            if (!cleaned && ws.readyState === ws.OPEN) ws.close(1011, err.message || 'vnc server error');
            cleanup(err.message || 'vnc-server-error', false);
        });

        const serverVersion = parseRfbVersion(await serverReader.read(12, timeout, 'VNC 协议版本'));
        const minor = Math.min(serverVersion.minor || 8, 8);
        remoteSocket.write(rfbVersionBytes(minor));
        const auth = await authenticateVncServer(remoteSocket, serverReader, conn, serverVersion, timeout);

        sendBrowser(rfbVersionBytes(minor));
        parseRfbVersion(await browserReader.read(12, timeout, 'noVNC 协议版本'));
        if (minor >= 7) {
            sendBrowser(Buffer.from([1, 1]));
            const selected = (await browserReader.read(1, timeout, 'noVNC 安全类型选择'))[0];
            if (selected !== 1) throw new Error(`noVNC 未选择代理提供的 None 安全类型：${selected}`);
        } else {
            const security = Buffer.alloc(4);
            security.writeUInt32BE(1, 0);
            sendBrowser(security);
        }
        if (minor >= 8) sendBrowser(Buffer.alloc(4));

        const clientInit = await browserReader.read(1, timeout, 'noVNC ClientInit');
        proxying = true;
        remoteSocket.write(clientInit);
        const pendingBrowser = browserReader.takeBuffered();
        if (pendingBrowser.length) remoteSocket.write(pendingBrowser);
        const pendingServer = serverReader.takeBuffered();
        if (pendingServer.length) sendBrowser(pendingServer);
        console.info('[novnc-ws]', 'proxy ready', { connectionId: connId, name: conn.name, target: `${conn.host}:${targetPort}`, route: routed.route || 'direct', rfbVersion: `3.${String(minor).padStart(3, '0')}`, securityType: auth.securityType === 2 ? 'VNCAuth' : 'None' });
    } catch (err) {
        const message = String(err?.message || err || 'noVNC 连接失败');
        console.warn('[novnc-ws]', 'failed to open proxy', { connectionId: connId, error: message });
        cleanup(message, true);
    }
});

rdpH264Wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/rdp-h264', `http://${req.headers.host || 'localhost'}`);
    const connId = url.searchParams.get('connectionId') || 'default';
    try {
        const sessionUser = currentSession(req);
        if (!sessionUser) { ws.close(1008, 'unauthorized'); return; }
        const store = readJSON(CONNECTIONS_FILE, { connections: [] });
        const conn = (store.connections || []).find((c) => c.id === connId);
        if (!conn) { ws.close(1008, 'connection not found'); return; }

        let pipe = rdpPipes.get(connId);
        const requestedWidth = Number(url.searchParams.get('width')) || RDP_STREAM_WIDTH;
        const requestedHeight = Number(url.searchParams.get('height')) || RDP_STREAM_HEIGHT;
        const requestedMode = url.searchParams.get('mode') || '';
        const requestedQuality = ['performance', 'balanced', 'quality'].includes(String(url.searchParams.get('quality') || '').toLowerCase()) ? String(url.searchParams.get('quality')).toLowerCase() : 'balanced';
        if (!pipe) pipe = await startRdpH264Pipeline(connId, conn, { width: requestedWidth, height: requestedHeight, mode: requestedMode, quality: requestedQuality });
        pipe.username = sessionUser?.username || '';
        pipe.clients.add(ws);
        startRdpClipboardWatch(pipe);
        ws.send(JSON.stringify({ type: 'hello', codec: 'avc1.42001f', width: pipe.width || RDP_STREAM_WIDTH, height: pipe.height || RDP_STREAM_HEIGHT, fps: RDP_STREAM_FPS, quality: pipe.quality || requestedQuality }));
        console.info('[rdp-h264]', 'browser attached', { connId, clients: pipe.clients.size });

        ws.on('message', async (raw, isBinary) => {
            if (isBinary) return;
            let msg = null;
            try { msg = JSON.parse(raw.toString('utf8')); } catch {}
            if (msg?.type === 'reconnect' && Number.isFinite(msg.width) && Number.isFinite(msg.height)) {
                const oldPipe = pipe;
                oldPipe.clients.delete(ws);
                const width = evenClampRdpSize(Number(msg.width) || RDP_STREAM_WIDTH, 800, 2560);
                const height = evenClampRdpSize(Number(msg.height) || RDP_STREAM_HEIGHT, 600, 1600);
                const mode = String(msg.mode || '');
                const quality = ['performance', 'balanced', 'quality'].includes(String(msg.quality || '').toLowerCase()) ? String(msg.quality).toLowerCase() : (pipe.quality || requestedQuality);
                try { if (ws.readyState === ws.OPEN) ws.close(1012, `rdp reconnect:${mode}:${width}x${height}:${quality}`); } catch {}
                cleanupPipe(connId);
                return;
            }
            handleRdpInput(pipe, raw);
        });
        ws.on('close', () => {
            pipe.clients.delete(ws);
            console.info('[rdp-h264]', 'browser detached', { connId, clients: pipe.clients.size });
            if (pipe.clients.size === 0) setTimeout(() => {
                const latest = rdpPipes.get(connId);
                if (latest && latest.clients.size === 0) cleanupPipe(connId);
            }, 5000);
        });
        ws.on('error', (err) => console.warn('[rdp-h264]', 'browser websocket error', { connId, error: err.message }));
    } catch (err) {
        console.error('[rdp-h264]', 'connection error', { connId, error: err.message });
        try { ws.close(1011, err.message.slice(0, 120)); } catch {}
    }
});

rdpAudioWss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/rdp-audio', `http://${req.headers.host || 'localhost'}`);
    const connId = url.searchParams.get('connectionId') || 'default';
    try {
        const sessionUser = currentSession(req);
        if (!sessionUser) { ws.close(1008, 'unauthorized'); return; }
        const pipe = rdpPipes.get(connId);
        if (!pipe) { ws.close(1011, 'rdp pipeline not ready'); return; }
        pipe.audioClients.add(ws);
        ws.send(JSON.stringify({ type: 'hello', container: 'webm', codec: 'opus', sampleRate: 48000, channels: 2, mode: 'inline' }));
        startRdpAudioCapture(pipe);
        console.info('[rdp-audio]', 'browser attached', { connId, clients: pipe.audioClients.size, mode: 'inline' });
        ws.on('close', () => {
            pipe.audioClients.delete(ws);
            console.info('[rdp-audio]', 'browser detached', { connId, clients: pipe.audioClients.size, mode: 'inline' });
            if (pipe.audioClients.size === 0 && pipe.audioFfmpeg) { try { pipe.audioFfmpeg.kill('SIGTERM'); } catch {} pipe.audioFfmpeg = null; }
        });
        ws.on('error', (err) => console.warn('[rdp-audio]', 'browser websocket error', { connId, error: err.message }));
    } catch (err) {
        console.error('[rdp-audio]', 'connection error', { connId, error: err.message });
        try { ws.close(1011, err.message.slice(0, 120)); } catch {}
    }
});

function cleanupPipe(connId) {
    const p = rdpPipes.get(connId);
    if (p) {
        p.stopping = true;
        try { p.nativeReader?.destroy(); } catch {}
        try { p.ffmpeg?.kill('SIGTERM'); } catch {}
        try { p.audioFfmpeg?.kill('SIGTERM'); } catch {}
        try { if (p.clipboardTimer) clearInterval(p.clipboardTimer); } catch {}
        try { p.pulseaudio?.kill('SIGTERM'); } catch {}
        try { p.xfreerdp?.kill('SIGTERM'); } catch {}
        try { p.xvfb?.kill('SIGTERM'); } catch {}
        try { p.routedForward?.close?.(); } catch {}
        try { if (p.fifoPath) fs.rmSync(p.fifoPath, { force: true }); } catch {}
        try { if (p.shareDir) fs.rmSync(p.shareDir, { recursive: true, force: true }); } catch {}
        cleanupIsolatedRdpAudioWorker(connId);
        rdpPipes.delete(connId);
        console.info('[rdp-h264]', 'pipeline cleaned', { connId });
    }
}

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    let sshClient = null;
    let sshClients = [];
    let sshStream = null;
    let attachedSshSession = null;
    let sftpStream = null;
    let statsTimer = null;
    let statsRunning = false;
    let remoteStatsState = {};
    const dockerLogStreams = new Map();
    const sftpUploadStreams = new Map();

    const sendJSON = (obj) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    };

    let handleWsMessage = null;
    const pendingWsMessages = [];
    ws.on('message', (raw) => {
        if (handleWsMessage) {
            handleWsMessage(raw);
            return;
        }
        pendingWsMessages.push(raw);
        console.info('[WS-DIAG] queued early message before handler ready', {
            remoteAddress: req.socket.remoteAddress,
            pending: pendingWsMessages.length,
            bytes: Buffer.byteLength(raw.toString()),
        });
    });

    // 启动实时监控推送
    function startStatsPush() {
        if (!SSH_STATS_ENABLED) {
            console.info('[STATS] realtime stats disabled by SSH_STATS_ENABLED=false');
            return;
        }
        if (statsTimer) return;
        console.info('[STATS] realtime stats started');
        const pushStats = async () => {
            if (ws.readyState !== ws.OPEN || !sshClient || statsRunning) return;
            statsRunning = true;
            const startedAt = Date.now();
            try {
                const result = await getRemoteStats(sshClient, remoteStatsState);
                remoteStatsState = result.state;
                sendJSON({ type: 'stats', data: result.stats });
                console.debug('[STATS] remote stats pushed', { durationMs: Date.now() - startedAt });
            } catch (err) {
                console.error('[STATS] 读取远程统计失败:', {
                    message: err.message,
                    code: err.code || '',
                    level: err.level || '',
                    durationMs: Date.now() - startedAt,
                });
                sendJSON({ type: 'stats-error', message: err.message || '读取远程统计失败' });
            } finally {
                statsRunning = false;
            }
        };
        pushStats();
        statsTimer = setInterval(pushStats, 1000);
    }

    // 停止实时推送
    function stopStatsPush() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
        statsRunning = false;
        remoteStatsState = {};
    }

    function stopDockerLogStreams() {
        for (const stream of dockerLogStreams.values()) {
            try { stream.close?.(); } catch {}
            try { stream.end?.(); } catch {}
            try { stream.destroy?.(); } catch {}
        }
        dockerLogStreams.clear();
    }

    function stopSftpUploadStreams() {
        for (const upload of sftpUploadStreams.values()) {
            try { upload.stream?.end?.(); } catch {}
            try { upload.stream?.destroy?.(); } catch {}
        }
        sftpUploadStreams.clear();
    }

    const detachSshSession = (reason = 'ws-detach') => {
        stopStatsPush();
        stopDockerLogStreams();
        stopSftpUploadStreams();
        if (attachedSshSession) {
            attachedSshSession.attachedWs?.delete(ws);
            attachedSshSession.lastDetachedAt = Date.now();
            console.info('[SSH-SESSION]', 'detach websocket', {
                sessionId: attachedSshSession.id,
                reason,
                remaining: attachedSshSession.attachedWs?.size || 0,
            });
            attachedSshSession = null;
            sshClient = null;
            sshClients = [];
            sshStream = null;
        }
        ws._sshTerminalSession = null;
    };

    const cleanup = ({ destroySsh = true, reason = 'cleanup' } = {}) => {
        stopStatsPush();
        stopDockerLogStreams();
        stopSftpUploadStreams();
        if (sftpStream) {
            const closingSftp = sftpStream;
            try { closingSftp.end(); } catch {}
            sftpStream = null;
            if (attachedSshSession?.sftpStream === closingSftp) attachedSshSession.sftpStream = null;
        }
        if (destroySsh) {
            if (attachedSshSession) {
                destroySshTerminalSession(attachedSshSession, reason);
                attachedSshSession = null;
            } else {
                if (sshStream) {
                    try { sshStream.end(); } catch {}
                    sshStream = null;
                }
                if (sshClient) {
                    sshClients.reverse().forEach((client) => { try { client.end(); } catch {} });
                    if (!sshClients.includes(sshClient)) {
                        try { sshClient.end(); } catch {}
                    }
                    sshClient = null;
                    sshClients = [];
                }
            }
        } else {
            detachSshSession(reason);
        }
    };

    function attachSshSession(session, { replay = true } = {}) {
        if (!session || session.closed) return false;
        cleanup({ destroySsh: false, reason: 'attach-existing-session' });
        attachedSshSession = session;
        sshClient = session.sshClient;
        sshClients = session.sshClients || [session.sshClient].filter(Boolean);
        sshStream = session.sshStream;
        sftpStream = session.sftpStream || null;
        session.attachedWs.add(ws);
        session.lastActive = Date.now();
        ws._sshTerminalSession = session;
        console.info('[SSH-SESSION]', 'attach websocket', {
            sessionId: session.id,
            connectionId: session.connectionId || '',
            attached: session.attachedWs.size,
            replay,
        });
        const pty = session.pty || { cols: 80, rows: 24 };
        sendJSON({ type: 'ready', sessionId: session.id, attached: true, cols: pty.cols, rows: pty.rows });
        if (replay && session.outputBuffer.length) {
            sendJSON({ type: 'data', data: session.outputBuffer.join('') });
        }
        startStatsPush();
        return true;
    }

    function execDockerStream(command, onMessage, onComplete) {
        if (!sshClient) {
            onComplete?.(new Error('SSH 未连接'));
            return null;
        }
        sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
            if (err) {
                onComplete?.(err);
                return;
            }
            stream.on('data', (chunk) => onMessage?.(chunk.toString('utf8'), 'stdout'));
            stream.stderr.on('data', (chunk) => onMessage?.(chunk.toString('utf8'), 'stderr'));
            stream.on('close', (code) => onComplete?.(code === 0 ? null : new Error(`远程命令退出码 ${code}`), code));
            return stream;
        });
        return null;
    }

    function startDockerLogStream(container) {
        const key = String(container || '').trim();
        if (!key) {
            sendJSON({ type: 'docker-log-error', message: '缺少容器 ID/名称' });
            return;
        }
        if (dockerLogStreams.has(key)) {
            try { dockerLogStreams.get(key).close?.(); } catch {}
            dockerLogStreams.delete(key);
        }
        const command = `docker logs --tail 200 --timestamps -f ${shellQuote(key)}`;
        sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
            if (err) {
                sendJSON({ type: 'docker-log-error', container: key, message: err.message });
                return;
            }
            dockerLogStreams.set(key, stream);
            sendJSON({ type: 'docker-log-start', container: key });
            stream.on('data', (chunk) => sendJSON({ type: 'docker-log-data', container: key, data: chunk.toString('utf8') }));
            stream.stderr.on('data', (chunk) => sendJSON({ type: 'docker-log-data', container: key, data: chunk.toString('utf8') }));
            stream.on('close', (code) => {
                dockerLogStreams.delete(key);
                sendJSON({ type: 'docker-log-end', container: key, code });
            });
        });
    }

    async function handleDockerMessage(msg) {
        if (!sshClient) {
            sendJSON({ type: 'docker-error', message: 'SSH 未连接' });
            return;
        }
        try {
            if (msg.type === 'docker-check') {
                const raw = await execRemoteCommand(sshClient, [
                    "if command -v docker >/dev/null 2>&1; then",
                    "  echo __DOCKER_INSTALLED__=1; docker --version 2>/dev/null || true;",
                    "  if [ -S /var/run/docker.sock ]; then echo __DOCKER_SOCKET__=1; else echo __DOCKER_SOCKET__=0; fi;",
                    "else echo __DOCKER_INSTALLED__=0; fi"
                ].join(' '));
                sendJSON({
                    type: 'docker-status',
                    installed: raw.includes('__DOCKER_INSTALLED__=1'),
                    socket: raw.includes('__DOCKER_SOCKET__=1'),
                    version: (raw.split('\n').find((line) => line.toLowerCase().startsWith('docker version')) || '').trim(),
                    raw,
                });
                return;
            }

            if (msg.type === 'docker-list-containers') {
                const raw = await execRemoteCommand(sshClient, "docker ps -a --no-trunc --format '{{json .}}'");
                sendJSON({ type: 'docker-containers', containers: parseJSONLines(raw) });
                return;
            }

            if (msg.type === 'docker-list-images') {
                const raw = await execRemoteCommand(sshClient, "docker image ls --no-trunc --format '{{json .}}'");
                sendJSON({ type: 'docker-images', images: parseJSONLines(raw) });
                return;
            }

            if (msg.type === 'docker-container-action') {
                const action = String(msg.action || '');
                const target = String(msg.id || msg.name || '').trim();
                const actionMap = { start: 'start', stop: 'stop', restart: 'restart', remove: 'rm -f' };
                if (!actionMap[action] || !target) throw new Error('容器操作参数不完整');
                const raw = await execRemoteCommand(sshClient, `docker ${actionMap[action]} ${shellQuote(target)}`);
                sendJSON({ type: 'docker-action', action, target, success: true, output: raw });
                return;
            }

            if (msg.type === 'docker-delete-image') {
                const image = String(msg.id || msg.image || '').trim();
                const force = !!msg.force;
                if (!image) throw new Error('缺少镜像 ID/名称');
                const usedBy = await execRemoteCommand(sshClient, `docker ps -a --filter ${shellQuote(`ancestor=${image}`)} --format '{{.ID}} {{.Names}}' || true`);
                if (usedBy.trim() && !force) {
                    sendJSON({ type: 'docker-image-delete', image, success: false, requiresForce: true, usedBy: usedBy.trim() });
                    return;
                }
                const raw = await execRemoteCommand(sshClient, `docker rmi ${force ? '-f ' : ''}${shellQuote(image)}`);
                sendJSON({ type: 'docker-image-delete', image, success: true, output: raw });
                return;
            }

            if (msg.type === 'docker-pull-image') {
                const image = String(msg.image || '').trim();
                if (!image) throw new Error('请输入镜像名，例如 nginx:alpine');
                sendJSON({ type: 'docker-pull-start', image });
                sshClient.exec(`sh -lc ${JSON.stringify(`docker pull ${shellQuote(image)}`)}`, (err, stream) => {
                    if (err) {
                        sendJSON({ type: 'docker-pull-complete', image, success: false, error: err.message });
                        return;
                    }
                    stream.on('data', (chunk) => sendJSON({ type: 'docker-pull-log', image, data: chunk.toString('utf8') }));
                    stream.stderr.on('data', (chunk) => sendJSON({ type: 'docker-pull-log', image, data: chunk.toString('utf8') }));
                    stream.on('close', (code) => sendJSON({ type: 'docker-pull-complete', image, success: code === 0, code }));
                });
                return;
            }

            if (msg.type === 'docker-logs-start') {
                startDockerLogStream(msg.id || msg.name);
                return;
            }

            if (msg.type === 'docker-logs-stop') {
                const key = String(msg.id || msg.name || '').trim();
                const stream = dockerLogStreams.get(key);
                if (stream) {
                    try { stream.close?.(); } catch {}
                    try { stream.end?.(); } catch {}
                    dockerLogStreams.delete(key);
                }
                sendJSON({ type: 'docker-log-end', container: key, code: 0 });
                return;
            }

            if (msg.type === 'docker-mirrors-get') {
                const raw = await execRemoteCommand(sshClient, "if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json; else printf '{}'; fi");
                sendJSON({ type: 'docker-mirrors', mirrors: normalizeDockerMirrors(raw), raw });
                return;
            }

            if (msg.type === 'docker-mirrors-set') {
                const mirrors = Array.isArray(msg.mirrors) ? msg.mirrors.map((v) => String(v).trim()).filter(Boolean) : [];
                const encoded = Buffer.from(JSON.stringify(mirrors), 'utf8').toString('base64');
                const command = `
set -e
PY=$(command -v python3 || command -v python || true)
[ -n "$PY" ] || { echo "目标主机需要 python3/python 才能安全更新 daemon.json" >&2; exit 1; }
TMP=$(mktemp)
OUT=$(mktemp)
if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json > "$TMP"; else printf '{}' > "$TMP"; fi
"$PY" - "$TMP" "$OUT" ${shellQuote(encoded)} <<'PY'
import base64, json, sys
src, out, encoded = sys.argv[1:4]
try:
    with open(src, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
except Exception:
    data = {}
mirrors = json.loads(base64.b64decode(encoded).decode('utf-8'))
data['registry-mirrors'] = mirrors
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\\n')
PY
if [ "$(id -u)" = "0" ]; then
  mkdir -p /etc/docker && cp "$OUT" /etc/docker/daemon.json
else
  sudo -n mkdir -p /etc/docker && sudo -n cp "$OUT" /etc/docker/daemon.json
fi
rm -f "$TMP" "$OUT"
echo "Docker registry-mirrors 已更新，请重启 Docker 服务使配置生效。"
`;
                const raw = await execRemoteCommand(sshClient, command);
                sendJSON({ type: 'docker-mirrors-save', success: true, output: raw, mirrors });
                return;
            }

            if (msg.type === 'docker-restart-service') {
                const raw = await execRemoteCommand(sshClient, dockerServiceRestartCommand());
                sendJSON({ type: 'docker-service-restart', success: true, output: raw });
                return;
            }
        } catch (err) {
            const responseType = msg.type === 'docker-check' ? 'docker-status'
                : msg.type === 'docker-list-containers' ? 'docker-containers'
                : msg.type === 'docker-list-images' ? 'docker-images'
                : msg.type === 'docker-mirrors-get' ? 'docker-mirrors'
                : 'docker-error';
            sendJSON({ type: responseType, success: false, error: err.message, message: err.message, containers: [], images: [] });
        }
    }

    handleWsMessage = async (raw) => {
        const rawText = raw.toString();
        let msg;
        try {
            msg = JSON.parse(rawText);
        } catch (err) {
            console.warn('[WS-DIAG] received non-json message', {
                remoteAddress: req.socket.remoteAddress,
                bytes: Buffer.byteLength(rawText),
                preview: rawText.slice(0, 80),
                error: err.message,
            });
            return;
        }
        console.info('[WS-DIAG] message received', {
            remoteAddress: req.socket.remoteAddress,
            type: msg.type || '',
            hasConnectionId: !!msg.connectionId,
            connectionId: msg.connectionId || '',
            bytes: Buffer.byteLength(rawText),
        });

        // ------------------------- SSH 连接 -------------------------
        if (msg.type === 'connect') {
            const sessionUser = currentSession(req);
            if (!sessionUser) {
                sendJSON({ type: 'error', message: '未登录或会话已过期' });
                try { ws.close(1008, 'unauthorized'); } catch {}
                return;
            }
            const { host, port, username, password, privateKey, init, connectionId } = msg;
            const requestedSessionId = String(msg.sessionId || msg.terminalSessionId || msg.tabId || connectionId || crypto.randomUUID());
            const existingSession = sshTerminalSessions.get(requestedSessionId);
            if (existingSession && !existingSession.closed) {
                if (existingSession.username && existingSession.username !== sessionUser.username) {
                    sendJSON({ type: 'error', message: '会话不属于当前用户' });
                    try { ws.close(1008, 'session-owner-mismatch'); } catch {}
                    return;
                }
                attachSshSession(existingSession, { replay: true });
                return;
            }
            cleanup({ destroySsh: false, reason: 'connect-new-session' });
            let conn;
            try {
                console.info('[SSH-DIAG] connect request received', {
                    remoteAddress: req.socket.remoteAddress,
                    hasConnectionId: !!connectionId,
                    connectionId: connectionId || '',
                    fallbackTarget: connectionId ? '' : `${host || ''}:${port || 22}`,
                    hasFallbackPassword: !!password && password !== '******',
                    hasFallbackPrivateKey: !!privateKey && privateKey !== '******',
                });
                let connectionSource = 'fallback-message';
                let storeConnectionCount = null;
                if (connectionId) {
                    const session = currentSession(req);
                    if (!session) throw new Error('未登录或会话已过期');
                    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
                    storeConnectionCount = (store.connections || []).length;
                    conn = (store.connections || []).find((c) => c.id === connectionId);
                    if (!conn) throw new Error('连接不存在或已删除');
                    connectionSource = 'sqlite-by-connectionId';
                } else {
                    conn = { host, port: port || 22, username, password: password || '', privateKey: privateKey || '', connectionMode: 'direct' };
                }
                if (!conn.host || !conn.username) throw new Error('主机和用户名不能为空');
                console.info('[SSH-DIAG] resolved connection config', {
                    connectionId: conn.id || connectionId || '',
                    requestedConnectionId: connectionId || '',
                    source: connectionSource,
                    dataDir: DATA_DIR,
                    dbFile: DB_FILE,
                    storeConnectionCount,
                    name: conn.name || '',
                    target: `${conn.host}:${Number(conn.port) || 22}`,
                    host: conn.host || '',
                    port: Number(conn.port) || 22,
                    username: conn.username || '',
                    protocol: conn.protocol || 'SSH',
                    mode: conn.connectionMode || 'direct',
                    proxyId: conn.proxyId || '',
                    jumpHostIds: normalizeJumpHostIds(conn),
                    sshKeyId: conn.sshKeyId || '',
                    hasPassword: !!conn.password,
                    hasPrivateKey: !!conn.privateKey,
                });
                if (connectionId) console.log(`[SSH] 使用已保存路由连接 ${conn.name || conn.host}`);
                const routed = await createRoutedSSHConnection(conn, 10000);
                sshClient = routed.client;
                sshClients = routed.clients || [routed.client];
                console.log(`[SSH] 已连接: ${routed.route}`);
                console.info('[SSH-DIAG] ssh ready before shell', {
                    connectionId: conn.id || connectionId || '',
                    route: routed.route,
                    clientCount: sshClients.length,
                });
            } catch (err) {
                console.warn('[SSH-DIAG] ssh connection failed before shell', {
                    connectionId: connectionId || '',
                    error: err.message,
                    stack: err.stack,
                });
                sendJSON({ type: 'error', message: `SSH 连接失败: ${err.message}` });
                cleanup();
                return;
            }

            sshClient.on('error', (err) => {
                console.error(`[SSH] 错误: ${err.message}`);
                if (attachedSshSession) {
                    broadcastSshSession(attachedSshSession, { type: 'error', message: `SSH 连接失败: ${err.message}` });
                    destroySshTerminalSession(attachedSshSession, 'ssh-error');
                } else {
                    sendJSON({ type: 'error', message: `SSH 连接失败: ${err.message}` });
                    cleanup();
                }
            });

            sshClient.on('close', () => {
                console.log('[SSH] 连接关闭');
                if (attachedSshSession) {
                    broadcastSshSession(attachedSshSession, { type: 'close', message: 'SSH 连接已关闭' });
                    destroySshTerminalSession(attachedSshSession, 'ssh-close');
                } else {
                    sendJSON({ type: 'close', message: 'SSH 连接已关闭' });
                    cleanup();
                }
            });

            // 打开 shell
            const initialRows = Number.isFinite(Number(msg.rows)) ? Math.min(200, Math.max(2, Math.floor(Number(msg.rows)))) : 24;
            const initialCols = Number.isFinite(Number(msg.cols)) ? Math.min(500, Math.max(20, Math.floor(Number(msg.cols)))) : 80;
            sshClient.shell({ term: 'xterm-256color', rows: initialRows, cols: initialCols }, (err, stream) => {
                if (err) {
                    console.warn('[SSH-DIAG] shell open failed after ssh ready', {
                        connectionId: conn.id || connectionId || '',
                        target: `${conn.host}:${Number(conn.port) || 22}`,
                        username: conn.username || '',
                        error: err.message,
                        stack: err.stack,
                    });
                    sendJSON({ type: 'error', message: `打开 Shell 失败: ${err.message}` });
                    cleanup();
                    return;
                }
                console.info('[SSH-DIAG] shell opened successfully', {
                    connectionId: conn.id || connectionId || '',
                    target: `${conn.host}:${Number(conn.port) || 22}`,
                    username: conn.username || '',
                });
                sshStream = stream;
                const session = {
                    id: requestedSessionId,
                    connectionId: conn.id || connectionId || '',
                    sshClient,
                    sshClients,
                    sshStream,
                    attachedWs: new Set([ws]),
                    pty: { rows: initialRows, cols: initialCols },
                    outputBuffer: [],
                    createdAt: Date.now(),
                    lastActive: Date.now(),
                    lastDetachedAt: 0,
                    username: sessionUser.username || '',
                    connectionConfig: conn,
                    closed: false,
                };
                attachedSshSession = session;
                ws._sshTerminalSession = session;
                sshTerminalSessions.set(session.id, session);
                const pty = session.pty || { rows: initialRows, cols: initialCols };
                sendJSON({ type: 'ready', sessionId: session.id, cols: pty.cols, rows: pty.rows });

                // SSH 连接就绪后，启动实时监控推送
                startStatsPush();

                stream.on('data', (data) => {
                    const text = data.toString('utf-8');
                    appendSshSessionBuffer(session, text);
                    broadcastSshSession(session, { type: 'data', data: text });
                });
                stream.on('close', (code, signal) => {
                    console.log(`[SSH] Shell 关闭 code=${code} signal=${signal}`);
                    broadcastSshSession(session, { type: 'close', message: `Shell 已关闭 (code=${code})` });
                    destroySshTerminalSession(session, `shell-close-${code ?? 'N/A'}`);
                });
                stream.stderr.on('data', (data) => {
                    const text = data.toString('utf-8');
                    appendSshSessionBuffer(session, text);
                    broadcastSshSession(session, { type: 'data', data: text });
                });

                if (init && typeof init === 'string' && init.trim().length > 0) {
                    stream.write(init + '\n');
                }
            });
            return;
        }

        // 输入
        if (msg.type === 'input') {
            if (sshStream && sshStream.writable) sshStream.write(msg.data);
            return;
        }

        // 窗口大小调整
        if (msg.type === 'resize') {
            const rows = Math.floor(Number(msg.rows));
            const cols = Math.floor(Number(msg.cols));
            if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 2 || cols < 20 || rows > 200 || cols > 500) {
                console.warn('[SSH] 忽略异常 PTY resize', { rows: msg.rows, cols: msg.cols });
                return;
            }
            if (sshStream && sshStream.setWindow) {
                sshStream.setWindow(rows, cols, 0, 0);
                if (attachedSshSession) {
                    attachedSshSession.pty = { rows, cols };
                    attachedSshSession.lastActive = Date.now();
                }
            }
            return;
        }

        // 手动请求一帧实时监控数据（打开监控面板时使用）
        if (msg.type === 'stats-request') {
            if (!sshClient || statsRunning) return;
            statsRunning = true;
            try {
                const result = await getRemoteStats(sshClient, remoteStatsState);
                remoteStatsState = result.state;
                sendJSON({ type: 'stats', data: result.stats });
            } catch (err) {
                console.error('[STATS] 手动读取远程统计失败:', err.message);
                sendJSON({ type: 'stats-error', message: err.message || '读取远程统计失败' });
            } finally {
                statsRunning = false;
            }
            return;
        }

        // 断开
        if (msg.type === 'disconnect') {
            if (attachedSshSession) destroySshTerminalSession(attachedSshSession, 'client-disconnect');
            else cleanup({ destroySsh: true, reason: 'client-disconnect' });
            ws.close();
            return;
        }

        // ------------------------- Docker 操作 -------------------------
        if (typeof msg.type === 'string' && msg.type.startsWith('docker-')) {
            await handleDockerMessage(msg);
            return;
        }

        // ------------------------- SFTP 操作 -------------------------
        // 初始化 SFTP
        if (msg.type === 'sftp-init') {
            if (!sshClient) {
                sendJSON({ type: 'sftp-error', message: 'SSH 未连接' });
                return;
            }
            sshClient.sftp((err, sftp) => {
                if (err) {
                    sendJSON({ type: 'sftp-error', message: `SFTP 初始化失败: ${err.message}` });
                    return;
                }
                sftpStream = sftp;
                if (attachedSshSession) attachedSshSession.sftpStream = sftp;
                sendJSON({ type: 'sftp-ready' });
            });
            return;
        }

        if (!sftpStream) {
            sendJSON({ type: 'sftp-error', message: 'SFTP 会话未建立' });
            return;
        }

        // 列出目录
        if (msg.type === 'sftp-list') {
            const dir = msg.path || '.';
            const requestId = String(msg.requestId || '');
            sftpStream.readdir(dir, (err, list) => {
                if (err) {
                    sendJSON({ type: 'sftp-list', requestId, path: dir, error: err.message, files: [] });
                    return;
                }
                const files = list.map(entry => ({
                    name: entry.filename,
                    type: entry.longname.startsWith('d') ? 'd' : '-',
                    size: entry.attrs.size,
                    modifyTime: entry.attrs.mtime * 1000,
                    rights: entry.longname.substr(0, 10),
                }));
                sendJSON({ type: 'sftp-list', requestId, path: dir, files });
            });
            return;
        }

        if (msg.type === 'sftp-properties') {
            const requestId = String(msg.requestId || '');
            const rawItems = Array.isArray(msg.items) ? msg.items : [];
            const items = rawItems.map((item) => normalizeRemotePath(item.path || '')).filter((p) => p && p !== '/');
            if (!items.length) {
                sendJSON({ type: 'sftp-properties', requestId, success: false, error: '缺少属性路径' });
                return;
            }
            try {
                const results = [];
                for (const itemPath of items) {
                    const stats = await sftpStat(sftpStream, itemPath);
                    const tree = await calculateRemoteTreeProperties(sftpStream, itemPath, stats);
                    results.push({
                        path: itemPath,
                        name: basenameRemote(itemPath),
                        type: stats.isDirectory?.() ? 'd' : '-',
                        size: tree.size,
                        fileCount: tree.fileCount,
                        dirCount: tree.dirCount,
                        modifyTime: (Number(stats.mtime) || Number(stats.modifyTime) || 0) * 1000,
                    });
                }
                sendJSON({
                    type: 'sftp-properties',
                    requestId,
                    success: true,
                    items: results,
                    totalSize: results.reduce((sum, item) => sum + (Number(item.size) || 0), 0),
                    fileCount: results.reduce((sum, item) => sum + (Number(item.fileCount) || 0), 0),
                    dirCount: results.reduce((sum, item) => sum + (Number(item.dirCount) || 0), 0),
                });
            } catch (err) {
                sendJSON({ type: 'sftp-properties', requestId, success: false, error: err.message });
            }
            return;
        }

        // 创建目录
        if (msg.type === 'sftp-mkdir') {
            sftpStream.mkdir(msg.path, (err) => {
                sendJSON({ type: 'sftp-mkdir', path: msg.path, success: !err, error: err ? err.message : null });
            });
            return;
        }

        // 创建空文件
        if (msg.type === 'sftp-touch') {
            const writeStream = sftpStream.createWriteStream(msg.path);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-touch', path: msg.path, success: false, error: err.message });
            });
            writeStream.end('', () => {
                sendJSON({ type: 'sftp-touch', path: msg.path, success: true });
            });
            return;
        }

        // 删除（文件或目录；目录支持递归删除非空内容）
        if (msg.type === 'sftp-delete') {
            const targetPath = String(msg.path || '');
            if (!targetPath || targetPath === '/') {
                console.warn('[sftp-delete]', '拒绝删除危险路径', { path: targetPath });
                sendJSON({ type: 'sftp-delete', path: msg.path, success: false, error: '拒绝删除空路径或根目录' });
                return;
            }

            sftpStream.stat(targetPath, async (err, stats) => {
                if (err) {
                    console.warn('[sftp-delete]', 'stat failed', { path: targetPath, error: err.message });
                    sendJSON({ type: 'sftp-delete', path: targetPath, success: false, error: err.message });
                    return;
                }
                if (stats.isDirectory()) {
                    try {
                        console.info('[sftp-delete]', 'recursive directory delete requested', { path: targetPath });
                        await execRemoteCommand(sshClient, `rm -rf -- ${shellQuote(targetPath)}`);
                        sendJSON({ type: 'sftp-delete', path: targetPath, success: true, error: null });
                    } catch (err2) {
                        console.warn('[sftp-delete]', 'recursive directory delete failed', { path: targetPath, error: err2.message });
                        sendJSON({ type: 'sftp-delete', path: targetPath, success: false, error: err2.message });
                    }
                } else {
                    sftpStream.unlink(targetPath, (err2) => {
                        if (err2) console.warn('[sftp-delete]', 'file delete failed', { path: targetPath, error: err2.message });
                        else console.info('[sftp-delete]', 'file deleted', { path: targetPath });
                        sendJSON({ type: 'sftp-delete', path: targetPath, success: !err2, error: err2 ? err2.message : null });
                    });
                }
            });
            return;
        }

        // 重命名
        if (msg.type === 'sftp-rename') {
            sftpStream.rename(msg.oldPath, msg.newPath, (err) => {
                sendJSON({ type: 'sftp-rename', oldPath: msg.oldPath, newPath: msg.newPath, success: !err, error: err ? err.message : null });
            });
            return;
        }

        // 修改权限
        if (msg.type === 'sftp-chmod') {
            const targetPath = String(msg.path || '');
            const modeText = String(msg.mode || '').trim();
            if (!targetPath || !/^[0-7]{3,4}$/.test(modeText)) {
                sendJSON({ type: 'sftp-chmod', path: targetPath, success: false, error: '权限格式不正确' });
                return;
            }
            sftpStream.chmod(targetPath, parseInt(modeText, 8), (err) => {
                sendJSON({ type: 'sftp-chmod', path: targetPath, mode: modeText, success: !err, error: err ? err.message : null });
            });
            return;
        }

        // 下载文件：签发一次性 HTTP 下载地址，由浏览器通过响应流直接落盘，避免在 WebSocket/JS 内存中拼接大文件。
        if (msg.type === 'sftp-download') {
            const targetPath = String(msg.path || '');
            if (!targetPath) {
                sendJSON({ type: 'sftp-download', path: targetPath, error: '缺少下载路径' });
                return;
            }
            sftpStream.stat(targetPath, (err, stats) => {
                if (err) {
                    sendJSON({ type: 'sftp-download', path: targetPath, error: err.message });
                    return;
                }
                if (stats.isDirectory?.()) {
                    sendJSON({ type: 'sftp-download', path: targetPath, error: '暂不支持直接下载目录' });
                    return;
                }
                const token = crypto.randomBytes(24).toString('hex');
                sftpDownloadTokens.set(token, {
                    sessionId: attachedSshSession?.id || '',
                    username: currentSession(req)?.username || '',
                    connectionConfig: attachedSshSession?.connectionConfig || conn,
                    downloadId: msg.downloadId || '',
                    path: targetPath,
                    size: Number(stats.size) || 0,
                    loaded: 0,
                    status: 'pending',
                    expiresAt: Date.now() + SFTP_DOWNLOAD_TOKEN_TTL,
                });
                sendJSON({ type: 'sftp-download-ready', downloadId: msg.downloadId || '', path: targetPath, url: `/api/sftp/download/${token}`, progressUrl: `/api/sftp/download-progress/${token}`, controlUrl: `/api/sftp/download-control/${token}`, hashUrl: `/api/sftp/hash/${token}`, size: Number(stats.size) || 0 });
            });
            return;
        }


        if (msg.type === 'sftp-clipboard-set') {
            const username = currentSession(req)?.username || '';
            const rawItems = Array.isArray(msg.items) ? msg.items : [];
            const items = rawItems.map((item) => ({
                path: normalizeRemotePath(item.path || ''),
                name: String(item.name || basenameRemote(item.path || '')).slice(0, 255),
                type: item.type === 'd' ? 'd' : '-',
                size: Number(item.size) || 0,
                modifyTime: Number(item.modifyTime) || 0,
            })).filter((item) => item.path && item.path !== '/');
            if (sftpStream && items.length) {
                try {
                    await Promise.all(items.map((item) => sftpStat(sftpStream, item.path)));
                } catch (err) {
                    sendJSON({ type: 'sftp-clipboard-set', success: false, error: `复制失败：源路径无效或不存在（${err.message}）` });
                    return;
                }
            }
            if (!username || !items.length) {
                sendJSON({ type: 'sftp-clipboard-set', success: false, error: '没有可复制的项目' });
                return;
            }
            const mode = msg.mode === 'cut' ? 'cut' : 'copy';
            sftpClipboardByUser.set(username, {
                mode,
                username,
                sourceSessionId: attachedSshSession?.id || '',
                sourceConnectionId: attachedSshSession?.connectionId || '',
                sourceConnectionConfig: attachedSshSession?.connectionConfig || conn,
                items,
                createdAt: Date.now(),
            });
            sendJSON({ type: 'sftp-clipboard-set', success: true, mode, count: items.length });
            return;
        }

        if (msg.type === 'sftp-clipboard-check-conflicts') {
            const username = currentSession(req)?.username || '';
            const targetDir = String(msg.targetDir || msg.path || '.');
            const requestId = String(msg.requestId || '');
            checkSftpClipboardTargetConflicts({ username, targetSession: attachedSshSession, targetDir }).then((result) => {
                sendJSON({ type: 'sftp-clipboard-conflicts', requestId, success: true, targetDir, ...result });
            }).catch((err) => {
                sendJSON({ type: 'sftp-clipboard-conflicts', requestId, success: false, targetDir, error: err.message });
            });
            return;
        }

        if (msg.type === 'sftp-clipboard-paste') {
            const username = currentSession(req)?.username || '';
            const targetDir = String(msg.targetDir || msg.path || '.');
            const clip = sftpClipboardByUser.get(username);
            if (!clip) {
                sendJSON({ type: 'sftp-clipboard-paste', success: false, error: '剪贴板为空' });
                return;
            }
            pasteSftpClipboard({
                username,
                targetSession: attachedSshSession,
                targetDir,
                mode: clip.mode,
                conflict: msg.conflict || 'ask',
                sendProgress: (payload) => sendTransferEvent(username, payload),
            }).then(() => {
                sendJSON({ type: 'sftp-clipboard-paste', success: true, path: targetDir });
            }).catch((err) => {
                console.warn('[sftp-clipboard-paste]', 'failed', { targetDir, error: err.message });
                sendJSON({ type: 'sftp-clipboard-paste', success: false, error: err.message });
            });
            return;
        }

        if (msg.type === 'sftp-clipboard-cancel') {
            const transferId = String(msg.transferId || msg.id || '');
            const ok = transferId ? cancelSftpClipboardTransfer(transferId, '用户已取消') : false;
            sendJSON({ type: 'sftp-clipboard-cancel', success: true, cancelled: ok, transferId });
            return;
        }

        if (msg.type === 'sftp-archive-cancel') {
            const transferId = String(msg.transferId || msg.id || '');
            const ok = transferId ? cancelSftpArchiveTransfer(transferId, '用户已取消') : false;
            sendJSON({ type: 'sftp-archive-cancel', success: true, cancelled: ok, transferId });
            return;
        }

        if (msg.type === 'sftp-compress') {
            const items = Array.isArray(msg.items) ? msg.items.map((item) => normalizeRemotePath(item.path)).filter((p) => p && p !== '/') : [];
            const targetPath = normalizeRemotePath(msg.targetPath || '');
            if (!items.length || !targetPath) {
                sendJSON({ type: 'sftp-compress', success: false, error: '缺少压缩项目或目标路径' });
                return;
            }
            const username = currentSession(req)?.username || '';
            const archiveTransfer = createSftpArchiveTransfer({ id: msg.transferId || '', username, path: targetPath, operation: 'compress' });
            sendTransferEvent(username, { transferId: archiveTransfer.id, direction: 'archive', path: targetPath, loaded: 0, size: 0, status: 'active', phase: 'prepare', cancellable: true });
            const finishArchive = () => finishSftpArchiveTransfer(archiveTransfer.id);
            if (isTarArchivePath(targetPath)) {
                let cmd = '';
                try { cmd = remoteArchiveCommand(items, targetPath); }
                catch (err) { finishArchive(); sendJSON({ type: 'sftp-compress', success: false, error: err.message, transferId: archiveTransfer.id }); return; }
                execRemoteCommand(sshClient, cmd, { transfer: archiveTransfer }).then(() => {
                    if (!archiveTransfer.cancelled) sendTransferEvent(username, { transferId: archiveTransfer.id, direction: 'archive', path: targetPath, loaded: 0, size: 0, status: 'done', phase: 'done', cancellable: true });
                    sendJSON({ type: 'sftp-compress', success: true, path: targetPath, mode: 'remote-tar', transferId: archiveTransfer.id });
                }).catch((err) => sendJSON({ type: 'sftp-compress', success: false, error: err.message, cancelled: !!archiveTransfer.cancelled, transferId: archiveTransfer.id }))
                  .finally(finishArchive);
            } else {
                createMainSideArchiveFromRemote(sftpStream, items, targetPath, { username, transferId: archiveTransfer.id, transfer: archiveTransfer }).then(() => {
                    sendJSON({ type: 'sftp-compress', success: true, path: targetPath, mode: 'main-side', transferId: archiveTransfer.id });
                }).catch((err) => sendJSON({ type: 'sftp-compress', success: false, error: err.message, cancelled: !!archiveTransfer.cancelled, transferId: archiveTransfer.id }))
                  .finally(finishArchive);
            }
            return;
        }

        if (msg.type === 'sftp-extract') {
            const archivePath = normalizeRemotePath(msg.path || '');
            const targetDir = normalizeRemotePath(msg.targetDir || dirnameRemote(archivePath));
            if (!archivePath || !targetDir) {
                sendJSON({ type: 'sftp-extract', success: false, error: '缺少压缩包或解压路径' });
                return;
            }
            const lower = archivePath.toLowerCase();
            const username = currentSession(req)?.username || '';
            const archiveTransfer = createSftpArchiveTransfer({ id: msg.transferId || '', username, path: archivePath, operation: 'extract' });
            sendTransferEvent(username, { transferId: archiveTransfer.id, direction: 'archive', path: archivePath, loaded: 0, size: 0, status: 'active', phase: 'prepare', cancellable: true });
            const finishArchive = () => finishSftpArchiveTransfer(archiveTransfer.id);
            if (isTarArchivePath(archivePath)) {
                let cmd = `mkdir -p -- ${shellQuote(targetDir)} && `;
                if (/\.(tar\.gz|tgz)$/.test(lower)) cmd += `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
                else if (/\.(tar\.bz2|tbz2)$/.test(lower)) cmd += `tar -xjf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
                else if (/\.(tar\.xz|txz)$/.test(lower)) cmd += `tar -xJf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
                else if (lower.endsWith('.tar')) cmd += `tar -xf ${shellQuote(archivePath)} -C ${shellQuote(targetDir)}`;
                else { finishArchive(); sendJSON({ type: 'sftp-extract', success: false, error: '暂不支持该压缩格式', transferId: archiveTransfer.id }); return; }
                execRemoteCommand(sshClient, cmd, { transfer: archiveTransfer }).then(() => {
                    if (!archiveTransfer.cancelled) sendTransferEvent(username, { transferId: archiveTransfer.id, direction: 'archive', path: archivePath, loaded: 0, size: 0, status: 'done', phase: 'done', cancellable: true });
                    sendJSON({ type: 'sftp-extract', success: true, path: archivePath, targetDir, mode: 'remote-tar', transferId: archiveTransfer.id });
                }).catch((err) => sendJSON({ type: 'sftp-extract', success: false, error: err.message, cancelled: !!archiveTransfer.cancelled, transferId: archiveTransfer.id }))
                  .finally(finishArchive);
            } else {
                extractMainSideArchiveToRemote(sftpStream, archivePath, targetDir, { username, transferId: archiveTransfer.id, transfer: archiveTransfer }).then(() => {
                    sendJSON({ type: 'sftp-extract', success: true, path: archivePath, targetDir, mode: 'main-side', transferId: archiveTransfer.id });
                }).catch((err) => sendJSON({ type: 'sftp-extract', success: false, error: err.message, cancelled: !!archiveTransfer.cancelled, transferId: archiveTransfer.id }))
                  .finally(finishArchive);
            }
            return;
        }

        if (msg.type === 'sftp-download-bundle') {
            const items = Array.isArray(msg.items) ? msg.items.map((item) => normalizeRemotePath(item.path)).filter((p) => p && p !== '/') : [];
            if (!items.length) {
                sendJSON({ type: 'sftp-download', downloadId: msg.downloadId || '', error: '没有可下载的项目' });
                return;
            }
            const tmpName = `zephyr-sftp-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tar.gz`;
            const tmpPath = `/tmp/${tmpName}`;
            const parent = dirnameRemote(items[0]);
            const names = items.map((p) => basenameRemote(p));
            const cmd = `tar -czf ${shellQuote(tmpPath)} -C ${shellQuote(parent)} -- ${names.map(shellQuote).join(' ')}`;
            execRemoteCommand(sshClient, cmd).then(() => {
                sftpStream.stat(tmpPath, (err, stats) => {
                    if (err) {
                        sendJSON({ type: 'sftp-download', downloadId: msg.downloadId || '', error: err.message });
                        return;
                    }
                    const token = crypto.randomBytes(24).toString('hex');
                    sftpDownloadTokens.set(token, {
                        sessionId: attachedSshSession?.id || '',
                        username: currentSession(req)?.username || '',
                        connectionConfig: attachedSshSession?.connectionConfig || conn,
                        downloadId: msg.downloadId || '',
                        path: tmpPath,
                        displayName: msg.name || tmpName,
                        size: Number(stats.size) || 0,
                        loaded: 0,
                        status: 'pending',
                        cleanupAfterDownload: true,
                        expiresAt: Date.now() + SFTP_DOWNLOAD_TOKEN_TTL,
                    });
                    sendJSON({ type: 'sftp-download-ready', downloadId: msg.downloadId || '', path: tmpPath, name: msg.name || tmpName, url: `/api/sftp/download/${token}`, progressUrl: `/api/sftp/download-progress/${token}`, controlUrl: `/api/sftp/download-control/${token}`, hashUrl: `/api/sftp/hash/${token}`, size: Number(stats.size) || 0 });
                });
            }).catch((err) => sendJSON({ type: 'sftp-download', downloadId: msg.downloadId || '', error: err.message }));
            return;
        }

        // 上传文件：兼容旧版整包上传；新版使用分片，避免大文件撑爆 WebSocket/内存导致 SSH 断开。
        if (msg.type === 'sftp-upload') {
            const buffer = Buffer.from(msg.data || '', 'base64');
            const writeStream = sftpStream.createWriteStream(msg.path);
            let settled = false;
            writeStream.on('error', (err) => {
                if (settled) return;
                settled = true;
                sendJSON({ type: 'sftp-upload', path: msg.path, success: false, error: err.message });
            });
            writeStream.end(buffer, () => {
                if (settled) return;
                settled = true;
                sendJSON({ type: 'sftp-upload', path: msg.path, success: true });
            });
            return;
        }

        if (msg.type === 'sftp-upload-start') {
            const uploadId = String(msg.uploadId || '');
            const targetPath = String(msg.path || '');
            if (!uploadId) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: targetPath, error: '缺少上传 ID' });
                return;
            }
            if (!targetPath) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: targetPath, error: '缺少上传路径' });
                return;
            }
            const token = crypto.randomBytes(24).toString('hex');
            sftpUploadTokens.set(token, {
                sessionId: attachedSshSession?.id || '',
                username: currentSession(req)?.username || '',
                connectionConfig: attachedSshSession?.connectionConfig || conn,
                uploadId,
                path: targetPath,
                size: Number(msg.size) || 0,
                sha256: String(msg.sha256 || '').toLowerCase(),
                loaded: 0,
                status: 'pending',
                expiresAt: Date.now() + SFTP_UPLOAD_TOKEN_TTL,
            });
            sendJSON({ type: 'sftp-upload-ready', uploadId, path: targetPath, url: `/api/sftp/upload/${token}`, size: Number(msg.size) || 0 });
            return;
        }

        if (msg.type === 'sftp-upload-chunk') {
            const uploadId = String(msg.uploadId || '');
            const upload = sftpUploadStreams.get(uploadId);
            if (!upload || upload.failed) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: msg.path, error: '上传会话不存在' });
                return;
            }
            const offset = Number(msg.offset) || 0;
            if (offset !== upload.offset) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: upload.path, error: `上传偏移错误：期望 ${upload.offset}，收到 ${offset}` });
                return;
            }
            const buffer = Buffer.from(msg.data || '', 'base64');
            upload.offset += buffer.length;
            const next = () => sendJSON({ type: 'sftp-upload-progress', uploadId, path: upload.path, nextOffset: upload.offset, size: upload.size });
            if (!upload.stream.write(buffer)) upload.stream.once('drain', next);
            else next();
            return;
        }

        if (msg.type === 'sftp-upload-cancel') {
            const uploadId = String(msg.uploadId || '');
            for (const [token, uploadTask] of sftpUploadTokens.entries()) {
                if (uploadTask.uploadId !== uploadId) continue;
                uploadTask.status = 'error';
                try { uploadTask.activeStream?.destroy?.(); } catch {}
                sftpUploadTokens.delete(token);
                sendTransferEvent(uploadTask.username, { transferId: uploadId || token, direction: 'upload', path: uploadTask.path, loaded: Number(uploadTask.loaded) || 0, size: Number(uploadTask.size) || 0, status: 'error' });
            }
            const upload = sftpUploadStreams.get(uploadId);
            if (upload) {
                upload.failed = true;
                try { upload.stream?.destroy?.(); } catch {}
                sftpUploadStreams.delete(uploadId);
            }
            sendJSON({ type: 'sftp-upload-error', uploadId, error: '已取消上传' });
            return;
        }

        if (msg.type === 'sftp-upload-complete') {
            const uploadId = String(msg.uploadId || '');
            const upload = sftpUploadStreams.get(uploadId);
            if (!upload || upload.failed) {
                sendJSON({ type: 'sftp-upload-error', uploadId, path: msg.path, error: '上传会话不存在' });
                return;
            }
            upload.ending = true;
            upload.stream.end();
            return;
        }

        // 编辑文件：读取内容
        if (msg.type === 'sftp-preview') {
            const targetPath = String(msg.path || '').trim();
            const ext = path.extname(targetPath).slice(1).toLowerCase();
            if (!targetPath) {
                sendJSON({ type: 'sftp-preview', path: targetPath, error: '缺少预览路径' });
                return;
            }
            if (!PREVIEW_IMAGE_EXTENSIONS.has(ext)) {
                sendJSON({ type: 'sftp-preview', path: targetPath, error: '当前文件不是已知图片格式' });
                return;
            }
            sftpStream.stat(targetPath, (err, stats) => {
                if (err) {
                    sendJSON({ type: 'sftp-preview', path: targetPath, error: err.message });
                    return;
                }
                if (stats.isDirectory?.()) {
                    sendJSON({ type: 'sftp-preview', path: targetPath, error: '目录不支持图片预览' });
                    return;
                }
                const token = crypto.randomBytes(24).toString('hex');
                sftpPreviewTokens.set(token, {
                    path: targetPath,
                    username: currentSession(req)?.username || '',
                    sessionId: attachedSshSession?.id || '',
                    connectionConfig: attachedSshSession?.connectionConfig || conn,
                    size: Number(stats.size) || 0,
                    mtime: Number(stats.mtime) || Number(stats.modifyTime) || 0,
                    expiresAt: Date.now() + PREVIEW_TOKEN_TTL,
                });
                sendJSON({
                    type: 'sftp-preview-ready',
                    path: targetPath,
                    url: `/api/sftp/preview/${token}`,
                    contentType: isBrowserImageExt(ext, BROWSER_IMAGE_EXTENSIONS) ? getBrowserImageContentType(ext, BROWSER_IMAGE_CONTENT_TYPES) : 'image/webp',
                    converted: !isBrowserImageExt(ext, BROWSER_IMAGE_EXTENSIONS),
                    size: Number(stats.size) || 0,
                });
            });
            return;
        }


        if (msg.type === 'sftp-media-preview') {
            const targetPath = String(msg.path || '').trim();
            const ext = getMediaExt(targetPath);
            console.info('[sftp-media-preview]', 'request', { path: targetPath, ext });
            if (!targetPath) {
                sendJSON({ type: 'sftp-media-preview', path: targetPath, error: '缺少媒体路径' });
                return;
            }
            if (!isMediaExt(ext)) {
                sendJSON({ type: 'sftp-media-preview', path: targetPath, error: '当前文件不是已知音视频格式' });
                return;
            }
            sftpStream.stat(targetPath, async (err, stats) => {
                if (err) {
                    sendJSON({ type: 'sftp-media-preview', path: targetPath, error: err.message });
                    return;
                }
                if (stats.isDirectory?.()) {
                    sendJSON({ type: 'sftp-media-preview', path: targetPath, error: '目录不支持媒体预览' });
                    return;
                }
                try {
                    cleanupMediaProbeCache(mediaProbeCache);
                    const size = Number(stats.size) || 0;
                    const mtime = Number(stats.mtime) || Number(stats.modifyTime) || 0;
                    const cacheKey = mediaCacheKey([targetPath, String(size), String(mtime), ext]);
                    let info = null;
                    if (msg.force) mediaProbeCache.delete(cacheKey);
                    const cached = mediaProbeCache.get(cacheKey);
                    if (cached?.info) {
                        cached.expiresAt = Date.now() + 30 * 60 * 1000;
                        info = cached.info;
                    }
                    try {
                        if (!info) info = await probeMediaFromStream(() => sftpStream.createReadStream(targetPath, { start: 0, end: Math.min(size || 16 * 1024 * 1024, 16 * 1024 * 1024) - 1 }), {
                            cacheMap: mediaProbeCache,
                            cacheKey,
                            ext,
                            timeoutMs: 12000,
                        });
                    } catch (probeErr) {
                        info = { container: ext, duration: 0, video: isVideoExt(ext) ? { codec: '', width: 0, height: 0 } : null, audio: { codec: '', channels: 0 }, subtitles: [] };
                    }
                    const mode = decidePlayMode(info, ext, msg.capabilities || {});
                    const token = crypto.randomBytes(24).toString('hex');
                    const dir = dirnameRemote(targetPath);
                    const base = getMediaBasenameNoExt(targetPath).toLowerCase();
                    const subtitles = [...(info.subtitles || [])];
                    const listExternalSubtitles = () => new Promise((resolve) => {
                        sftpStream.readdir(dir, (listErr, list) => {
                            if (listErr || !Array.isArray(list)) return resolve([]);
                            const matched = list.filter((item) => {
                                const name = String(item.filename || item.longname || '');
                                const itemExt = getMediaExt(name);
                                return isSubtitleExt(itemExt) && getMediaBasenameNoExt(name).toLowerCase().startsWith(base);
                            }).slice(0, 8).map((item) => ({
                                index: subtitles.length,
                                external: true,
                                externalPath: (dir.replace(/\/+$/, '') || '/') + '/' + item.filename,
                                language: String(item.filename || '').replace(/^.*?\.([a-z]{2,3})(?:\.[^.]+)?$/i, '$1'),
                                codec: getMediaExt(item.filename),
                            }));
                            resolve(matched);
                        });
                    });
                    subtitles.push(...await listExternalSubtitles());
                    sftpMediaTokens.set(token, {
                        path: targetPath,
                        username: currentSession(req)?.username || '',
                        sessionId: attachedSshSession?.id || '',
                        connectionConfig: attachedSshSession?.connectionConfig || conn,
                        size,
                        mtime,
                        mode,
                        info,
                        subtitles,
                        expiresAt: Date.now() + MEDIA_TOKEN_TTL,
                    });
                    console.info('[sftp-media-preview]', 'ready', { path: targetPath, mode, subtitles: subtitles.length, size });
                    sendJSON({
                        type: 'sftp-media-preview-ready',
                        path: targetPath,
                        kind: isVideoExt(ext) ? 'video' : 'audio',
                        mode,
                        streamUrl: `/api/sftp/media/stream/${token}`,
                        token,
                        subtitles: subtitles.map((sub, index) => ({
                            index,
                            language: sub.language || '',
                            external: !!sub.external,
                            url: `/api/sftp/media/subtitle/${token}/${index}.vtt`,
                        })),
                        info,
                        size,
                    });
                } catch (mediaErr) {
                    sendJSON({ type: 'sftp-media-preview', path: targetPath, error: mediaErr.message || '媒体预览失败' });
                }
            });
            return;
        }

        if (msg.type === 'sftp-readfile') {
            const requestId = String(msg.requestId || '');
            sftpStream.readFile(msg.path, (err, data) => {
                if (err) {
                    sendJSON({ type: 'sftp-readfile', requestId, path: msg.path, error: err.message });
                    return;
                }
                sendJSON({
                    type: 'sftp-readfile',
                    requestId,
                    path: msg.path,
                    data: Buffer.isBuffer(data) ? data.toString('base64') : '',
                    encoding: 'base64',
                    size: Buffer.isBuffer(data) ? data.length : 0,
                });
            });
            return;
        }

        // 编辑文件：保存内容
        if (msg.type === 'sftp-writefile') {
            const writeStream = sftpStream.createWriteStream(msg.path);
            writeStream.on('error', (err) => {
                sendJSON({ type: 'sftp-writefile', editorId: String(msg.editorId || ''), path: msg.path, success: false, error: err.message });
            });
            const buffer = msg.encoding === 'base64'
                ? Buffer.from(msg.data || '', 'base64')
                : Buffer.from(msg.data || '', 'utf8');
            writeStream.end(buffer, () => {
                sendJSON({ type: 'sftp-writefile', editorId: String(msg.editorId || ''), path: msg.path, success: true });
            });
            return;
        }
    };

    if (pendingWsMessages.length) {
        console.info('[WS-DIAG] replay queued early messages', {
            remoteAddress: req.socket.remoteAddress,
            count: pendingWsMessages.length,
        });
        const queued = pendingWsMessages.splice(0);
        queued.forEach((raw) => handleWsMessage(raw));
    }

    ws.on('close', () => {
        console.log('[WS] 客户端断开');
        cleanup({ destroySsh: false, reason: 'ws-close' });
    });

    ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
        cleanup({ destroySsh: false, reason: 'ws-error' });
    });
});

async function startServer() {
    server.listen(PORT, () => {
        let dataDirEntries = [];
        try { dataDirEntries = fs.readdirSync(DATA_DIR).sort(); } catch {}
        console.info('[DATA-DIAG] runtime data directory', {
            dataDir: DATA_DIR,
            dbFile: DB_FILE,
            dbExists: fs.existsSync(DB_FILE),
            envFileExists: fs.existsSync(path.join(DATA_DIR, '.env')),
            entries: dataDirEntries,
            dockerHint: 'Docker 部署请确认宿主机数据卷已挂载到 /app/data，否则连接数据会随容器重建而丢失。',
        });
        console.log(`🌬️  Zephyr 服务运行在 http://localhost:${PORT}`);
        console.log(`   WebSocket 路径: /ssh`);
        console.log(`   RDP/H.264 路径: /rdp-h264 -> xfreerdp/ffmpeg`);
        console.log(`   VNC/noVNC 路径: /novnc -> VNC Server`);
    });
}

startServer().catch((err) => {
    console.error('[startup] Zephyr 启动失败:', err);
    process.exit(1);
});