const express = require('express');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
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
// archiver@8 is ESM-only and replaces the archiver(format, options) factory
// with per-format classes (ZipArchive/TarArchive/JsonArchive). Load lazily
// via dynamic import from CJS and expose a compatible factory.
let archiverModulePromise = null;
function loadArchiver() {
    if (!archiverModulePromise) {
        archiverModulePromise = import('archiver').then((m) => {
            const ctors = { zip: m.ZipArchive, tar: m.TarArchive, json: m.JsonArchive };
            return (format, options) => {
                const Ctor = ctors[format];
                if (!Ctor) throw new Error(`不支持的压缩格式: ${format}`);
                return new Ctor(options);
            };
        });
    }
    return archiverModulePromise;
}
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
const { SessionStore, sha256: sessionTokenHash } = require('./session-store');
const { Authz, CAP, HttpError } = require('./authz');
const { ResourceService } = require('./resource-service');
const { SharingService } = require('./sharing-service');
const { UserService } = require('./user-service');
const { WorkspaceService } = require('./workspace-service');
const { UserSettingsService } = require('./user-settings-service');
const { NotesService } = require('./notes-service');
const { DeepLinkService } = require('./deeplink-service');
const { WorkerBridge } = require('./worker-bridge');
const { TerminalHistoryService } = require('./terminal-history-service');
const { AiPolicyService } = require('./ai-policy');
const { AiProviderService } = require('./ai-provider-service');
const secretCrypto = require('./secret-crypto');
const { handleEditorLspConnection } = require('./editor-lsp-server');
const { getAppVersion, getAgentRelease } = require('./version');
const {
    dialTelnet,
    filterIac,
    sendNaws,
    attachIacEngine,
    createTelnetAutoLogin,
    createTelnetDecoder,
    classifyTerminalClose,
    defaultPort: protocolDefaultPort,
} = require('./telnet-transport');
const {
    registerAiRoutes,
    mergeZephyrDefaultSkills,
    normalizeAiSettingsInput,
    safeAiSettings,
    formatAiContextForPrompt,
    selectPromptMemories,
} = require('./ai-agent-service');
const {
    AiRuntimeBridge,
    registerAiHostRoutes,
} = require('./ai-runtime-bridge');
const { buildIntentRoutingHint } = require('./ai-intent-routing');
const { parseLoopbackListen } = require('./ai-host-listener');
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
const { FileAgentManager } = require('./file-agent-manager');
const terminalSessionTools = require('./ai-terminal-session-tools');
const { FileTransferGateway } = require('./file-transfer-ws');
const { attachRdpProxyBridge } = require('./server/rdp-proxy-bridge');
const { negotiateRdpTls } = require('./server/rdp-cert-probe');

const HTTP_ENABLED = process.env.HTTP_ENABLED === 'true';
const PORT = process.env.PORT || 3000;
const HTTPS_ENABLED = process.env.HTTPS_ENABLED !== 'false';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || process.env.ZEPHYR_HTTPS_PORT || 3443);
const SSH_STATS_ENABLED = process.env.SSH_STATS_ENABLED !== 'false';
const APP_VERSION = getAppVersion();
const AGENT_RELEASE = getAgentRelease();
const app = express();
const aiHostApp = express();
const AI_HOST_LISTEN = String(process.env.ZEPHYR_AI_HOST_LISTEN || '127.0.0.1:3080');
let aiHostServer = null;

function applyCrossOriginIsolationHeaders(req, res, next) {
    // rdp-wasm WASM client uses SharedArrayBuffer for Go runtime.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
}
app.use(applyCrossOriginIsolationHeaders);

const DATA_DIR = process.env.ZEPHYR_DATA_DIR
    ? path.resolve(process.env.ZEPHYR_DATA_DIR)
    : path.join(__dirname, 'data');
const HTTPS_DIR = process.env.ZEPHYR_HTTPS_DIR
    ? path.resolve(process.env.ZEPHYR_HTTPS_DIR)
    : path.join(DATA_DIR, 'https');
const HTTPS_KEY_FILE = process.env.HTTPS_KEY_FILE || process.env.SSL_KEY_FILE || path.join(HTTPS_DIR, 'zephyr.key');
const HTTPS_CERT_FILE = process.env.HTTPS_CERT_FILE || process.env.SSL_CERT_FILE || path.join(HTTPS_DIR, 'zephyr.crt');
const HTTPS_CERT_CN = process.env.HTTPS_CERT_CN || process.env.PUBLIC_HOST || 'localhost';
const DB_FILE = path.join(DATA_DIR, 'zephyr.db');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const terminalHistory = new TerminalHistoryService({
    root: process.env.TERMINAL_HISTORY_DIR || path.join(DATA_DIR, 'terminal-history'),
    maxSessionBytes: Number(process.env.TERMINAL_HISTORY_SEGMENT_BYTES) || undefined,
    maxReplayBytes: Number(process.env.TERMINAL_HISTORY_REPLAY_BYTES) || undefined,
    maxSegments: Number(process.env.TERMINAL_HISTORY_MAX_SEGMENTS) || undefined,
    maxUserBytes: Number(process.env.TERMINAL_HISTORY_USER_BYTES) || undefined,
    retentionMs: Number(process.env.TERMINAL_HISTORY_RETENTION_MS) || undefined,
});
const ephemeralConnectionCleanupTimer = setInterval(() => {
    try {
        const removed = storage.cleanupExpiredEphemeralConnections?.() || 0;
        if (removed) console.info('[ephemeral] cleaned orphan one-shot connections', { removed });
    } catch (error) {
        console.warn('[ephemeral] cleanup failed', { error: error.message });
    }
}, 30 * 60 * 1000);
ephemeralConnectionCleanupTimer.unref?.();
try { storage.cleanupExpiredEphemeralConnections?.(); } catch {}

const terminalHistoryCleanupTimer = setInterval(() => {
    try { terminalHistory.cleanupExpired(); } catch (error) { console.warn('[TERMINAL-HISTORY] cleanup failed', { error: error.message }); }
}, 6 * 60 * 60 * 1000);
terminalHistoryCleanupTimer.unref?.();
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

/* ─── File Agent Manager ─── */
const fileAgentManager = new FileAgentManager({
    log: console.log,
    tokenFile: path.join(DATA_DIR, 'agent-tokens.json'),
});
let fileTransferGateway = null;

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
const resetVerifyHits = new Map();
/** Max failed TOTP checks per tempToken before the token is burned. */
const TOTP_TEMP_MAX_FAILURES = 5;
/** Max failed reset-token checks before the token is burned. */
const RESET_TOKEN_MAX_ATTEMPTS = 5;
/** Sliding window for reset verify rate limit (per IP). */
const RESET_VERIFY_WINDOW_MS = 10 * 60 * 1000;
const RESET_VERIFY_MAX_PER_WINDOW = 20;
/* Password rollback (notification link) — one-time token restores the hash
 * captured before a password change. Dedicated fixed-window limiter so a
 * leaked-link guessing burst can't burn the forgot-password budget. */
const PASSWORD_ROLLBACK_TTL_MS = 24 * 60 * 60 * 1000;
const rollbackVerifyHits = new Map();
const ROLLBACK_VERIFY_WINDOW_MS = 10 * 60 * 1000;
const ROLLBACK_VERIFY_MAX_PER_WINDOW = 10;
/** WebAuthn login challenge TTL. */
const WEBAUTHN_LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/* Short-lived RDP proxy grants for "临时连接" forms that never hit the host library.
 * Keyed by userId → [{ host, port, expiresAt }]. Max TTL 2 minutes. */
const ephemeralRdpTargetGrants = new Map();
const EPHEMERAL_RDP_GRANT_TTL_MS = 2 * 60 * 1000;

function pruneEphemeralRdpGrants(userId) {
    const list = ephemeralRdpTargetGrants.get(userId);
    if (!list?.length) {
        ephemeralRdpTargetGrants.delete(userId);
        return [];
    }
    const now = Date.now();
    const next = list.filter((g) => g && g.expiresAt > now);
    if (next.length) ephemeralRdpTargetGrants.set(userId, next);
    else ephemeralRdpTargetGrants.delete(userId);
    return next;
}

function grantEphemeralRdpTarget(userId, host, port) {
    const cleanHost = String(host || '').trim().toLowerCase();
    const cleanPort = Number(port) || 3389;
    if (!userId || !cleanHost) throw new Error('临时 RDP 目标无效');
    const next = pruneEphemeralRdpGrants(userId).filter(
        (g) => !(g.host === cleanHost && g.port === cleanPort)
    );
    next.push({ host: cleanHost, port: cleanPort, expiresAt: Date.now() + EPHEMERAL_RDP_GRANT_TTL_MS });
    ephemeralRdpTargetGrants.set(userId, next);
    return { host: cleanHost, port: cleanPort, ttlMs: EPHEMERAL_RDP_GRANT_TTL_MS };
}

function hasEphemeralRdpTargetGrant(userId, host, port) {
    const cleanHost = String(host || '').trim().toLowerCase();
    const cleanPort = Number(port) || 3389;
    return pruneEphemeralRdpGrants(userId).some((g) => g.host === cleanHost && g.port === cleanPort);
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function wsSendJSON(targetWs, obj) {
    if (targetWs?.readyState === targetWs?.OPEN) {
        targetWs.send(JSON.stringify(obj));
    }
}

function flushSshSessionHistory(session) {
    if (!session?.historyPending?.length) return;
    const chunks = session.historyPending;
    session.historyPending = [];
    session.historyPendingBytes = 0;
    if (session.historyFlushTimer) clearTimeout(session.historyFlushTimer);
    session.historyFlushTimer = 0;
    try { terminalHistory.appendOutput(session.userId, session.id, Buffer.concat(chunks)); }
    catch (err) { console.warn('[TERMINAL-HISTORY] append failed', { sessionId: session.id, error: err.message }); }
}

function flushAllSshSessionHistory() {
    for (const session of sshTerminalSessions.values()) flushSshSessionHistory(session);
}
process.once('exit', flushAllSshSessionHistory);
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        flushAllSshSessionHistory();
        process.exit(signal === 'SIGTERM' ? 0 : 130);
    });
}

function queueSshSessionHistory(session, bytes) {
    if (!session.historyPending) session.historyPending = [];
    session.historyPending.push(Buffer.from(bytes));
    session.historyPendingBytes = (session.historyPendingBytes || 0) + bytes.length;
    if (session.historyPendingBytes >= 64 * 1024) return flushSshSessionHistory(session);
    if (!session.historyFlushTimer) {
        session.historyFlushTimer = setTimeout(() => flushSshSessionHistory(session), 50);
        session.historyFlushTimer.unref?.();
    }
}

function appendSshSessionBuffer(session, data) {
    if (!session || session.closed || !data) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const text = bytes.toString('utf8');
    // Keep only a tiny hot replay window in Node heap. The authoritative
    // history is the append-only journal under DATA_DIR/terminal-history.
    session.outputBuffer.push(text);
    let total = session.outputBuffer.reduce((sum, item) => sum + Buffer.byteLength(item, 'utf8'), 0);
    while (total > 64 * 1024 && session.outputBuffer.length > 1) {
        total -= Buffer.byteLength(session.outputBuffer.shift(), 'utf8');
    }
    queueSshSessionHistory(session, bytes);
    session.lastActive = Date.now();
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

const SSH_DETACHED_SESSION_TTL_MS = Math.max(
    5 * 60 * 1000,
    Number(process.env.SSH_DETACHED_SESSION_TTL_MS) || (6 * 60 * 60 * 1000),
);

function destroySshTerminalSession(sessionOrId, reason = 'session-destroy') {
    const session = typeof sessionOrId === 'string' ? sshTerminalSessions.get(sessionOrId) : sessionOrId;
    if (!session || session.closed) return;
    session.closed = true;
    sshTerminalSessions.delete(session.id);
    for (const entry of session.dockerLogStreams?.values?.() || []) {
        const stream = entry?.stream || entry;
        try { stream?.close?.(); } catch {}
        try { stream?.end?.(); } catch {}
        try { stream?.destroy?.(); } catch {}
    }
    session.dockerLogStreams?.clear?.();
    for (const upload of session.sftpUploadStreams?.values?.() || []) {
        try { upload.stream?.end?.(); } catch {}
        try { upload.stream?.destroy?.(); } catch {}
    }
    session.sftpUploadStreams?.clear?.();
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
    flushSshSessionHistory(session);
    try { terminalHistory.close(session.userId, session.id, reason); } catch {}
    const protocol = String(session.protocol || 'SSH').toUpperCase();
    const classified = classifyTerminalClose(reason, protocol);
    broadcastSshSession(session, {
        type: 'close',
        message: classified.message,
        code: classified.code,
        remote: classified.remote,
        protocol,
        reason: String(reason || ''),
    });
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
    // Telnet: stop auto-login + IAC engine (keepalive) then destroy TCP.
    if (session.telnetAutoLogin) {
        try { session.telnetAutoLogin.cancel?.(); } catch {}
        session.telnetAutoLogin = null;
    }
    if (session.telnetIac) {
        try { session.telnetIac.destroy?.(); } catch {}
        session.telnetIac = null;
    }
    if (session.telnetSocket) {
        try { session.telnetSocket.destroy?.(); } catch {}
        session.telnetSocket = null;
    }
    if (session.routedTcpForward) {
        try { session.routedTcpForward.close?.(); } catch {}
        session.routedTcpForward = null;
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

/* Unique per-process identifier; lets clients distinguish "service restarted"
 * from "my session is invalid" (FREEZE plan §4.6). */
const INSTANCE_ID = crypto.randomUUID();

/* Persistent auth sessions (FREEZE plan §4.6/§18.1): cookie carries a random
 * SID, SQLite stores only SHA-256(SID). Sliding idle TTL + absolute TTL.
 * Legacy SESSION_TTL_SECONDS / REMEMBER_SESSION_TTL_SECONDS still work and map
 * to the idle TTLs. */
const SESSION_IDLE_TTL_MS = Math.max(5 * 60000, Number(process.env.SESSION_IDLE_TTL_SECONDS || process.env.SESSION_TTL_SECONDS || 24 * 60 * 60) * 1000);
const SESSION_ABSOLUTE_TTL_MS = Math.max(SESSION_IDLE_TTL_MS, Number(process.env.SESSION_ABSOLUTE_TTL_SECONDS || 7 * 24 * 60 * 60) * 1000);
const REMEMBER_IDLE_TTL_MS = Math.max(SESSION_IDLE_TTL_MS, Number(process.env.REMEMBER_SESSION_IDLE_TTL_SECONDS || process.env.REMEMBER_SESSION_TTL_SECONDS || 30 * 24 * 60 * 60) * 1000);
const REMEMBER_ABSOLUTE_TTL_MS = Math.max(REMEMBER_IDLE_TTL_MS, Number(process.env.REMEMBER_SESSION_ABSOLUTE_TTL_SECONDS || 90 * 24 * 60 * 60) * 1000);
let sessionStore = new SessionStore(storage.rawDb(), {
    idleTtlMs: SESSION_IDLE_TTL_MS,
    absoluteTtlMs: SESSION_ABSOLUTE_TTL_MS,
    rememberIdleTtlMs: REMEMBER_IDLE_TTL_MS,
    rememberAbsoluteTtlMs: REMEMBER_ABSOLUTE_TTL_MS,
});
setInterval(() => { try { sessionStore.gc(); } catch {} }, 10 * 60 * 1000).unref();

/* Unified authorization (FREEZE plan §19.1) — every route/WS/tool goes through
 * these services; no route may re-implement role or ownership checks. */
const authz = new Authz(storage.rawDb(), { getUserById: (id) => storage.getUserBrief(id) });
const resourceService = new ResourceService(storage, authz);
const sharingService = new SharingService(authz, storage, resourceService);
const userService = new UserService(storage, () => sessionStore, authz, hashPassword);
const workspaceService = new WorkspaceService(storage.rawDb(), { resources: resourceService });
const userSettingsService = new UserSettingsService(storage.rawDb(), storage);
const notesService = new NotesService(storage.rawDb(), authz);
const deepLinkService = new DeepLinkService(storage.rawDb());
const workerBridge = new WorkerBridge({
    storage,
    resources: resourceService,
    deepLink: deepLinkService,
    authz,
});
const aiRuntimeBridge = new AiRuntimeBridge({
    storage,
    resources: resourceService,
    authz,
});
const aiPolicyService = new AiPolicyService(storage.rawDb(), { storage, userSettings: userSettingsService });
const aiProviderService = new AiProviderService(storage.rawDb(), { storage, secretCrypto });
fileTransferGateway = new FileTransferGateway({ fileAgentManager, authz, storage, log: console.log });
setInterval(() => { try { deepLinkService.gc(); } catch {} }, 5 * 60 * 1000).unref();
setInterval(() => { try { workspaceService.gcStale(); } catch {} }, 60 * 60 * 1000).unref();

function reopenStorage() {
    storage.close();
    storage.init({ hashPassword });
    // Prepared statements inside the session store / authz reference the old
    // Database handle; rebuild every service against the reopened one.
    sessionStore = new SessionStore(storage.rawDb(), {
        idleTtlMs: SESSION_IDLE_TTL_MS,
        absoluteTtlMs: SESSION_ABSOLUTE_TTL_MS,
        rememberIdleTtlMs: REMEMBER_IDLE_TTL_MS,
        rememberAbsoluteTtlMs: REMEMBER_ABSOLUTE_TTL_MS,
    });
    rebuildAuthServices();
}

function rebuildAuthServices() {
    Object.assign(authz, new Authz(storage.rawDb(), { getUserById: (id) => storage.getUserBrief(id) }));
    Object.assign(resourceService, new ResourceService(storage, authz));
    Object.assign(sharingService, new SharingService(authz, storage, resourceService));
    Object.assign(userService, new UserService(storage, () => sessionStore, authz, hashPassword));
    Object.assign(workspaceService, new WorkspaceService(storage.rawDb(), { resources: resourceService }));
    Object.assign(userSettingsService, new UserSettingsService(storage.rawDb(), storage));
    Object.assign(notesService, new NotesService(storage.rawDb(), authz));
    Object.assign(deepLinkService, new DeepLinkService(storage.rawDb()));
    Object.assign(workerBridge, new WorkerBridge({ storage, resources: resourceService, deepLink: deepLinkService, authz }));
    Object.assign(aiPolicyService, new AiPolicyService(storage.rawDb(), { storage, userSettings: userSettingsService }));
    Object.assign(aiProviderService, new AiProviderService(storage.rawDb(), { storage, secretCrypto }));
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

/* Resolve the app session from the persistent SQLite-backed store.
 * SQLite is authoritative, so sessions survive process restarts; the in-memory
 * cache inside SessionStore is only a hot path. */
function currentSession(req) {
    const sid = parseCookies(req).zephyr_sid;
    if (!sid) return null;
    return sessionStore.resolve(sid);
}

/* Lightweight structured auth error; keeps the legacy `error` string field so
 * existing clients keep working while new clients can branch on `code`. */
function authError(res, status, code, message, retryable = false) {
    return res.status(status).json({ error: message, code, retryable });
}

function isPasswordChangeAllowedPath(req) {
    return req.path === '/api/auth/me'
        || req.path === '/api/auth/change-password'
        || req.path === '/api/auth/change-password/request-code'
        || req.path === '/api/auth/logout';
}

function requirePageAuth(req, res, next) {
    const session = currentSession(req);
    if (!session || session.mustChangePassword) return res.redirect('/');
    req.session = session;
    next();
}

/* Multi-user middlewares (FREEZE plan §19.1): requireUser attaches the full
 * identity (immutable userId + role); requireAdmin gates platform APIs. */
function requireUser(req, res, next) {
    const session = currentSession(req);
    if (!session) return authError(res, 401, 'app_session_expired', '未登录或会话已过期', false);
    if (session.mustChangePassword && !isPasswordChangeAllowedPath(req)) {
        return res.status(403).json({ error: '请先修改默认密码', code: 'must_change_password', mustChangePassword: true, retryable: false });
    }
    const user = storage.getUserBrief(session.userId);
    if (!user || user.status === 'deleted') return authError(res, 401, 'app_session_expired', '未登录或会话已过期', false);
    if (user.status === 'suspended') return authError(res, 403, 'account_suspended', '账号已被停用，请联系管理员', false);
    req.session = session;
    req.user = { userId: user.userId, username: user.username, role: user.role, status: user.status, email: user.email || '', isSuperAdmin: !!user.isSuperAdmin };
    next();
}

function requireAdmin(req, res, next) {
    requireUser(req, res, () => {
        if (req.user.role !== 'admin') return authError(res, 403, 'forbidden_admin_required', '需要管理员权限', false);
        next();
    });
}

function requireSuperAdmin(req, res, next) {
    requireUser(req, res, () => {
        if (req.user.role !== 'admin' || !req.user.isSuperAdmin) {
            return authError(res, 403, 'super_admin_required', '需要超级管理员权限', false);
        }
        next();
    });
}

/** Uniform HttpError → response mapping (structured codes, §19.7). */
function handleServiceError(res, err, fallbackStatus = 500) {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    console.error('[service-error]', err);
    return res.status(fallbackStatus).json({ error: err.message || '服务器内部错误', code: err?.code || 'internal_error', retryable: !!err?.retryable, field: err?.field || '' });
}

/** req.user equivalent for WebSocket handlers (identity bound at upgrade). */
function userFromAuthSession(req) {
    if (!req.authSession) return null;
    const user = storage.getUserBrief(req.authSession.userId);
    if (!user || user.status !== 'active') return null;
    return { userId: user.userId, username: user.username, role: user.role, status: user.status, email: user.email || '' };
}

function certificateAltNames() {
    const names = new Set(['DNS:localhost', 'IP:127.0.0.1']);
    const addHost = (value) => {
        const host = String(value || '').trim();
        if (!host) return;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) names.add(`IP:${host}`);
        else names.add(`DNS:${host}`);
    };
    addHost(HTTPS_CERT_CN);
    try {
        for (const iface of Object.values(os.networkInterfaces() || {})) {
            for (const addr of iface || []) {
                if (addr && addr.family === 'IPv4' && !addr.internal) addHost(addr.address);
            }
        }
    } catch {}
    for (const item of String(process.env.HTTPS_CERT_ALT_NAMES || '').split(',')) {
        const v = item.trim();
        if (!v) continue;
        if (/^(DNS|IP):/i.test(v)) names.add(v);
        else addHost(v);
    }
    return Array.from(names).join(',');
}

function ensureHttpsCertificate() {
    if (!HTTPS_ENABLED) return null;
    try { fs.mkdirSync(path.dirname(HTTPS_KEY_FILE), { recursive: true }); } catch {}
    try { fs.mkdirSync(path.dirname(HTTPS_CERT_FILE), { recursive: true }); } catch {}
    const hasMountedCert = fs.existsSync(HTTPS_KEY_FILE) && fs.existsSync(HTTPS_CERT_FILE);
    if (!hasMountedCert) {
        try {
            const altNames = certificateAltNames();
            execFileSync('openssl', [
                'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', String(process.env.HTTPS_CERT_DAYS || 3650),
                '-keyout', HTTPS_KEY_FILE, '-out', HTTPS_CERT_FILE,
                '-subj', `/CN=${HTTPS_CERT_CN}`,
                '-addext', `subjectAltName=${altNames}`,
            ], { stdio: 'ignore' });
            console.info('[https] generated self-signed certificate', { key: HTTPS_KEY_FILE, cert: HTTPS_CERT_FILE, altNames });
        } catch (err) {
            console.warn('[https] failed to generate self-signed certificate', { error: err.message, key: HTTPS_KEY_FILE, cert: HTTPS_CERT_FILE });
            return null;
        }
    } else {
        console.info('[https] using HTTPS certificate', { key: HTTPS_KEY_FILE, cert: HTTPS_CERT_FILE, mounted: true });
    }
    try {
        return { key: fs.readFileSync(HTTPS_KEY_FILE), cert: fs.readFileSync(HTTPS_CERT_FILE) };
    } catch (err) {
        console.warn('[https] failed to read HTTPS certificate', { error: err.message, key: HTTPS_KEY_FILE, cert: HTTPS_CERT_FILE });
        return null;
    }
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
    /* Ensure RDP settings have defaults for old connections that were created
     * before these fields existed — prevents toggles from appearing off. */
    if (String(copy.protocol || '').toUpperCase() === 'RDP') {
        if (copy.rdpClipboard === undefined) copy.rdpClipboard = true;
        if (copy.rdpSoundMode === undefined) copy.rdpSoundMode = 'local';
        if (copy.rdpResolution === undefined) copy.rdpResolution = '1080p';
        if (copy.rdpQuality === undefined) copy.rdpQuality = 'balanced';
        if (copy.rdpFps === undefined) copy.rdpFps = 30;
        if (copy.rdpTouchMode === undefined) copy.rdpTouchMode = 'direct';
        if (copy.rdpTouchSensitivity === undefined) copy.rdpTouchSensitivity = 1.5;
        if (copy.rdpMicrophone === undefined) copy.rdpMicrophone = false;
        if (copy.rdpCamera === undefined) copy.rdpCamera = false;
        if (copy.rdpStorage === undefined) copy.rdpStorage = false;
        if (copy.rdpLocation === undefined) copy.rdpLocation = false;
    }
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
        // After ready fires, onError is removed. But ssh2 can still emit
        // 'error' on a ready client if the socket dies mid-handshake or
        // during teardown - that would crash the process (unhandled 'error').
        // Keep a permanent safety handler that logs and suppresses post-ready
        // errors (the caller already owns the client lifecycle).
        client.on('error', (err) => {
            if (!settled) return; // pre-ready errors go through onError -> finish
            console.warn('[SSH-DIAG] ssh client post-ready error suppressed', {
                connectionId: conn?.id || '',
                label,
                code: err.code || '',
                level: err.level || '',
                message: err.message,
            });
        });
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
    const connections = storage.listAllConnectionRows();
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
    if (/ECONNREFUSED|refused/i.test(msg)) return { code: 'refused', message: 'RDP 端口被拒绝' };
    if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH|unreachable|No route/i.test(msg)) return { code: 'unreachable', message: '网络不可达或主机不存在' };
    return { code: 'unknown', message: msg };
}

async function testRDPConnection(conn, timeout = 10000) {
    const started = Date.now();
    const targetPort = Number(conn.port) || 3389;
    let routedForward = null;
    let socket = null;
    try {
        routedForward = await createRoutedTcpForward(conn, targetPort, timeout);
        const effectiveHost = routedForward?.host || conn.host;
        const effectivePort = routedForward?.port || targetPort;
        const route = routedForward?.route || `${conn.host}:${targetPort}`;

        /* Full-path test: TCP connect + send X.224 Connection Request +
         * wait for X.224 Connection Confirm. This tests the complete
         * network path including all jump hosts/proxies, and verifies
         * the target is actually an RDP server (not just an open port). */
        socket = new net.Socket();
        socket.setNoDelay(true);

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('RDP 连接超时')); }, timeout);
            socket.once('error', (err) => { clearTimeout(timer); reject(err); });
            socket.once('connect', () => {
                /* Send X.224 Connection Request (CR) per MS-RDPBCGR 2.2.1.1 */
                const cr = Buffer.from([
                    0x03, 0x00, 0x00, 0x13, // TPKT: version=3, length=19
                    0x0E,                   // X.224: length indicator
                    0xE0,                   // CR (Connection Request)
                    0x00, 0x00,             // dst-ref
                    0x00, 0x00,             // src-ref
                    0x00,                   // class 0
                    0x01, 0x00, 0x08, 0x00, // RDP Negotiation Request: type=1, flags=0, length=8
                    0x03, 0x00, 0x00, 0x00, // requestedProtocols: TLS | CredSSP
                ]);
                socket.write(cr);

                /* Wait for X.224 Connection Confirm (CC) */
                const chunks = [];
                const onData = (chunk) => {
                    chunks.push(chunk);
                    const buf = Buffer.concat(chunks);
                    if (buf.length >= 4) {
                        const tpktLen = (buf[2] << 8) | buf[3];
                        if (buf.length >= tpktLen) {
                            clearTimeout(timer);
                            socket.removeListener('data', onData);
                            /* Check X.224 CC code (0xD0) */
                            if (buf.length >= 6 && buf[5] === 0xD0) {
                                resolve();
                            } else {
                                reject(new Error('RDP 服务器拒绝连接'));
                            }
                        }
                    }
                };
                socket.on('data', onData);
            });
            socket.connect(effectivePort, effectiveHost);
        });
        return { ok: true, code: 'success', message: `RDP 连接成功（${route}）`, durationMs: Date.now() - started };
    } catch (err) {
        const classified = classifyRdpError(err);
        console.warn('[rdp-test]', 'connection failed', { target: conn.host, code: classified.code, error: classified.message });
        return { ok: false, ...classified, durationMs: Date.now() - started };
    } finally {
        try { socket?.destroy?.(); } catch {}
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

/* Telnet connectivity test (FREEZE plan §5.6): open the configured direct,
 * proxy, or SSH-jump TCP route and perform the normal initial IAC negotiation.
 * The probe closes immediately after reachability is confirmed. */
async function testTelnetConnection(conn, timeout = 10000) {
    const started = Date.now();
    let routedForward = null;
    let socket = null;
    try {
        routedForward = await createRoutedTcpForward(conn, Number(conn.port) || 23, timeout);
        const effectiveHost = routedForward?.host || String(conn.host || '');
        const effectivePort = routedForward?.port || Number(conn.port) || 23;
        socket = await dialTelnet({ host: effectiveHost, port: effectivePort }, { timeout });
        return {
            ok: true,
            code: 'success',
            message: routedForward?.route ? `Telnet 端口可达（${routedForward.route}）` : 'Telnet 端口可达',
            durationMs: Date.now() - started,
        };
    } catch (err) {
        return {
            ok: false,
            code: /timeout|超时/i.test(String(err?.message || '')) ? 'timeout' : 'connect_failed',
            message: err?.message || 'Telnet 连接失败',
            durationMs: Date.now() - started,
        };
    } finally {
        try { socket?.destroy?.(); } catch {}
        try { routedForward?.close?.(); } catch {}
    }
}

function testSSHConnection(conn, timeout = 10000) {    return new Promise((resolve) => {
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

function addActivity(message, userId = null) {
    storage.addActivity({ id: crypto.randomUUID(), time: Date.now(), message, type: 'info', userId });
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
    // Latest Zephyr Agent release link, baked at image build time from the
    // newest agent-v* GitHub release so the About/Agent settings pages do not
    // force users to jump between Docker (v*) and Agent (agent-v*) tags.
    copy.agentRelease = AGENT_RELEASE;
    if (copy.mail?.pass) copy.mail.pass = '******';
    if (copy.captcha?.secretKey) copy.captcha.secretKey = '******';
    if (copy.captcha?.tencentAppSecretKey) copy.captcha.tencentAppSecretKey = '******';
    if (copy.captcha?.tencentSecretKey) copy.captcha.tencentSecretKey = '******';
    if (copy.captcha?.aliyunAccessKeySecret) copy.captcha.aliyunAccessKeySecret = '******';
    if (copy.ai) {
        copy.ai = safeAiSettings(copy.ai);
        copy.ai.skills = mergeZephyrDefaultSkills(copy.ai.skills || []);
    }
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
            blur: Math.max(0, Math.min(20, Number(terminalBg.blur ?? 0))),
        };
        const normalizeHexServer = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '';
        const invertHexServer = (value) => {
            const hex = normalizeHexServer(value);
            if (!hex) return '';
            const n = parseInt(hex.slice(1), 16);
            const r = 255 - ((n >> 16) & 255);
            const g = 255 - ((n >> 8) & 255);
            const b = 255 - (n & 255);
            return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        };
        const rawTerminalFontColors = body.appearance.terminalFontColors || currentAppearance.terminalFontColors || {};
        const legacyRawTerminalFontColor = body.appearance.terminalFontColor !== undefined ? body.appearance.terminalFontColor : (currentAppearance.terminalFontColor ?? '');
        const terminalFontDark = normalizeHexServer(rawTerminalFontColors.dark || legacyRawTerminalFontColor);
        const terminalFontLightRaw = normalizeHexServer(rawTerminalFontColors.light || '');
        const terminalFontColors = terminalFontDark ? { dark: terminalFontDark, light: terminalFontLightRaw || invertHexServer(terminalFontDark) } : { dark: '', light: '' };
        const terminalFontColor = terminalFontColors.dark;
        const rawRdp = body.appearance.rdp || currentAppearance.rdp || {};
        const rdp = {
            ...(currentAppearance.rdp || {}),
            ...rawRdp,
            defaultResolution: ['auto', '1920x1080', '2560x1440', '3840x2160', '7680x4320'].includes(rawRdp.defaultResolution) ? rawRdp.defaultResolution : (currentAppearance.rdp?.defaultResolution || '1920x1080'),
            defaultQuality: ['balanced', 'performance', 'quality'].includes(String(rawRdp.defaultQuality || '').toLowerCase()) ? String(rawRdp.defaultQuality).toLowerCase() : 'balanced',
            defaultFps: [30, 45, 60, 120, 144].includes(Number(rawRdp.defaultFps)) ? Number(rawRdp.defaultFps) : (Number(currentAppearance.rdp?.defaultFps) || 60),
        };
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
            terminalFontColors,
            rdp,
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

function publicAppearanceSettings(settings = storage.getSettings()) {
    const appearance = settings?.appearance || {};
    return {
        appearance: {
            brandName: String(appearance.brandName || 'Zephyr').slice(0, 40) || 'Zephyr',
            brandIcon: String(appearance.brandIcon || '🌬️'),
            colorScheme: appearance.colorScheme || 'frost',
            theme: appearance.theme || 'auto',
        },
    };
}

function updateSettingsSection(req, res, section) {
    const value = req.body?.[section] ?? req.body ?? {};
    const normalized = normalizeSettingsInput({ [section]: value });
    if (section === 'security' && normalized.security?.ipWhitelistEnabled && !ipAllowed(clientIp(req), normalized.security.ipWhitelist)) {
        return res.status(400).json({ error: '当前 IP 不在白名单内，已阻止启用以避免误锁' });
    }
    const patch = { [section]: normalized[section] };
    if (section === 'beian') {
        patch.icp = normalized.icp;
        patch.icpUrl = normalized.icpUrl;
        patch.policeBeian = normalized.policeBeian;
        patch.policeBeianUrl = normalized.policeBeianUrl;
        patch.showBeian = normalized.showBeian;
    }
    const settings = storage.updateSettings(patch);
    addActivity(`更新系统设置：${section}`, req.user.userId);
    if (req.user.isSuperAdmin) return res.json(safeSettings(settings));
    if (section === 'appearance') return res.json({ appearance: settings.appearance || {} });
    if (section === 'notes') return res.json({ notes: settings.notes || {} });
    if (section === 'beian') {
        return res.json({
            beian: settings.beian || {},
            icp: settings.icp || '',
            icpUrl: settings.icpUrl || '',
            policeBeian: settings.policeBeian || '',
            policeBeianUrl: settings.policeBeianUrl || '',
            showBeian: settings.showBeian !== false,
        });
    }
    return res.json({ [section]: settings[section] || {} });
}

function secureCookieFlag(req) {
    const origin = configuredPublicOrigin(req);
    return origin.startsWith('https://') || requestProto(req) === 'https' ? '; Secure' : '';
}

function sessionClearCookie(req) {
    return `zephyr_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookieFlag(req)}`;
}

function createSession(req, res, user, { remember = false } = {}) {
    const { sid } = sessionStore.create({
        userId: user.userId,
        username: user.username,
        remember,
        mustChangePassword: !!user.defaultPassword,
        userAgent: req.headers['user-agent'] || '',
        ip: clientIp(req),
    });
    const maxAgeSeconds = remember ? Math.floor(REMEMBER_ABSOLUTE_TTL_MS / 1000) : '';
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
    const recipients = new Set();
    if (mail.adminEmail) recipients.add(String(mail.adminEmail).trim());

    const user = username ? storage.getUser(username) : null;
    if (user?.email) {
        let wantsNotification = mail.notifyLoginToUser !== false || !!user.isSuperAdmin;
        try {
            const overrides = userSettingsService.getUserOverrides(user.userId);
            if (overrides?.mail?.notifyLogin !== undefined) wantsNotification = !!overrides.mail.notifyLogin;
        } catch {}
        if (wantsNotification) recipients.add(String(user.email).trim());
    }
    recipients.delete('');
    if (!recipients.size) return;

    const title = success ? 'Zephyr 登录成功通知' : 'Zephyr 登录失败通知';
    const text = [
        title,
        '',
        `时间：${new Date().toLocaleString()}`,
        `账号：${username || '-'}`,
        `IP 地址：${ip}`,
        `地区：${region || '-'}`,
        success ? '' : `失败原因：${reason || '-'}`,
        `User-Agent：${userAgent || '-'}`,
    ].filter(Boolean).join('\n');
    for (const to of recipients) {
        sendMail(title, text, to).catch((err) => console.error('[MAIL] 登录通知发送失败:', { to, error: err.message }));
    }
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

function securityLockParams() {
    const sec = storage.getSettings().security || {};
    return {
        enabled: sec.bruteForceEnabled !== false,
        maxFailures: Math.max(1, Number(sec.bruteForceMaxFailures) || 5),
        banMs: Math.max(60 * 1000, (Number(sec.bruteForceBanMinutes) || 15) * 60000),
    };
}

function isAccountLocked(user) {
    return !!(user && user.lockedUntil && Number(user.lockedUntil) > Date.now());
}

/** Account-level lockout (users.failedLoginCount / lockedUntil). Complements IP bans. */
function recordAccountLoginFailure(user) {
    if (!user?.username) return null;
    const { enabled, maxFailures, banMs } = securityLockParams();
    if (!enabled) return user;
    const failedLoginCount = (Number(user.failedLoginCount) || 0) + 1;
    const lockedUntil = failedLoginCount >= maxFailures ? Date.now() + banMs : null;
    return storage.updateUser(user.username, { failedLoginCount, lockedUntil });
}

function clearAccountLoginFailure(user) {
    if (!user?.username) return null;
    if (!(Number(user.failedLoginCount) > 0) && !user.lockedUntil) return user;
    return storage.updateUser(user.username, { failedLoginCount: 0, lockedUntil: null });
}

function timingSafeEqualStr(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) {
        const dummy = crypto.createHash('sha256').update(left).digest();
        crypto.timingSafeEqual(dummy, dummy);
        return false;
    }
    return crypto.timingSafeEqual(left, right);
}

function pruneWebauthnLoginChallenges(nowTs = Date.now()) {
    for (const [key, state] of webauthnChallenges.entries()) {
        if (!String(key).startsWith('login:')) continue;
        if (!state?.createdAt || nowTs - state.createdAt > WEBAUTHN_LOGIN_CHALLENGE_TTL_MS) {
            webauthnChallenges.delete(key);
        }
    }
}

function webauthnChallengeFromBody(body) {
    try {
        const raw = body?.response?.clientDataJSON;
        if (!raw) return '';
        const json = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
        return String(json.challenge || '');
    } catch {
        return '';
    }
}

function takeResetVerifySlot(ip) {
    const nowTs = Date.now();
    const key = String(ip || 'unknown');
    const hits = (resetVerifyHits.get(key) || []).filter((t) => nowTs - t < RESET_VERIFY_WINDOW_MS);
    if (hits.length >= RESET_VERIFY_MAX_PER_WINDOW) {
        resetVerifyHits.set(key, hits);
        return false;
    }
    hits.push(nowTs);
    resetVerifyHits.set(key, hits);
    return true;
}

function takeRollbackVerifySlot(ip) {
    const nowTs = Date.now();
    const key = String(ip || 'unknown');
    const hits = (rollbackVerifyHits.get(key) || []).filter((t) => nowTs - t < ROLLBACK_VERIFY_WINDOW_MS);
    if (hits.length >= ROLLBACK_VERIFY_MAX_PER_WINDOW) {
        rollbackVerifyHits.set(key, hits);
        return false;
    }
    hits.push(nowTs);
    rollbackVerifyHits.set(key, hits);
    return true;
}

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
    const archiver = await loadArchiver();
    return new Promise((resolve, reject) => {
        const chunks = []; const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('data', (c) => chunks.push(c)); archive.on('error', reject); archive.on('end', () => resolve(Buffer.concat(chunks)));
        Object.entries(files).forEach(([name, content]) => archive.append(content, { name })); archive.finalize();
    });
}

initData();
app.use(express.json({ limit: '24mb' }));
app.use(requireSameOrigin);
aiHostApp.use(express.json({ limit: '24mb' }));

app.post('/api/auth/login', async (req, res) => {
    const { username, password, captchaToken, remember } = req.body || {};
    const guard = checkLoginGuards(req);
    const ua = req.headers['user-agent'] || '';
    if (!guard.ok) { await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: guard.reason }); return res.status(403).json({ error: guard.reason }); }
    const s = storage.getSettings();
    if (!(await verifyCaptcha(s.captcha?.provider, captchaToken, guard.ip))) { recordLoginFailure(guard.ip); await notifyLogin({ username, ip: guard.ip, userAgent: ua, success: false, reason: 'CAPTCHA 错误' }); return res.status(400).json({ error: '人机验证失败' }); }
    const user = storage.getUser(username);
    if (user && isAccountLocked(user)) {
        recordLoginFailure(guard.ip);
        await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: false, reason: '账号临时锁定' });
        return res.status(429).json({ error: '登录失败次数过多，账号已临时锁定，请稍后再试', code: 'account_locked' });
    }
    if (!user || !verifyPassword(password, user.passwordHash)) {
        recordLoginFailure(guard.ip);
        if (user) recordAccountLoginFailure(user);
        await notifyLogin({ username: username || '', ip: guard.ip, userAgent: ua, success: false, reason: '密码错误' });
        return res.status(401).json({ error: '账号或密码错误' });
    }
    if (user.status === 'suspended') {
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: false, reason: '账号已停用' });
        return authError(res, 403, 'account_suspended', '账号已被停用，请联系管理员', false);
    }
    if (user.status === 'deleted') {
        recordLoginFailure(guard.ip);
        return authError(res, 401, 'invalid_credentials', '账号或密码错误', false);
    }
    if (!defaultPasswordRemoteLoginAllowed(req, user)) {
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: false, reason: '默认密码禁止公网登录' });
        return res.status(403).json({ error: '默认密码只允许从本机或内网登录，请先在安全环境修改默认密码' });
    }
    if (user.totpEnabled) {
        const tempToken = crypto.randomUUID();
        tempTotpTokens.set(tempToken, {
            username: user.username,
            userId: user.userId,
            createdAt: Date.now(),
            ip: guard.ip,
            userAgent: ua,
            remember: !!remember,
            failures: 0,
        });
        return res.json({ ok: true, requireTotp: true, tempToken });
    }
    clearAccountLoginFailure(user);
    recordLoginSuccess(guard.ip);
    createSession(req, res, user, { remember: !!remember });
    try { storage.rawDb().prepare('UPDATE users SET lastLoginAt = ? WHERE userId = ?').run(Date.now(), user.userId); } catch {}
    addActivity(`用户登录：${user.username}`, user.userId);
    await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: true, reason: '' });
    res.json({ ok: true, user: { username: user.username }, mustChangePassword: !!user.defaultPassword });
});

app.post('/api/auth/totp/verify', async (req, res) => {
    const { tempToken, code } = req.body || {};
    const guard = checkLoginGuards(req);
    if (!guard.ok) return res.status(403).json({ error: guard.reason, code: 'login_guard_blocked' });
    const tmp = tempTotpTokens.get(tempToken);
    if (!tmp || Date.now() - tmp.createdAt > 5 * 60000) {
        if (tempToken) tempTotpTokens.delete(tempToken);
        return res.status(400).json({ error: '验证会话已过期' });
    }
    const user = storage.getUser(tmp.username);
    if (!user || user.status === 'deleted') {
        tempTotpTokens.delete(tempToken);
        return res.status(401).json({ error: '动态验证码错误' });
    }
    if (user.status === 'suspended') {
        tempTotpTokens.delete(tempToken);
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        return authError(res, 403, 'account_suspended', '账号已被停用，请联系管理员', false);
    }
    if (isAccountLocked(user)) {
        tempTotpTokens.delete(tempToken);
        recordLoginFailure(guard.ip);
        return res.status(429).json({ error: '登录失败次数过多，账号已临时锁定，请稍后再试', code: 'account_locked' });
    }
    if (!user.totpSecret || !verifySync({ secret: user.totpSecret, token: String(code || '') }).valid) {
        tmp.failures = (Number(tmp.failures) || 0) + 1;
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        await notifyLogin({ username: tmp.username, ip: guard.ip, userAgent: tmp.userAgent, success: false, reason: 'TOTP 错误' });
        if (tmp.failures >= TOTP_TEMP_MAX_FAILURES) {
            tempTotpTokens.delete(tempToken);
            return res.status(401).json({ error: '动态验证码错误次数过多，请重新登录', code: 'totp_temp_exhausted' });
        }
        tempTotpTokens.set(tempToken, tmp);
        return res.status(401).json({ error: '动态验证码错误' });
    }
    tempTotpTokens.delete(tempToken);
    clearAccountLoginFailure(user);
    recordLoginSuccess(guard.ip);
    createSession(req, res, user, { remember: !!tmp.remember });
    try { storage.rawDb().prepare('UPDATE users SET lastLoginAt = ? WHERE userId = ?').run(Date.now(), user.userId); } catch {}
    addActivity(`用户登录：${user.username}`, user.userId);
    await notifyLogin({ username: user.username, ip: guard.ip, userAgent: tmp.userAgent, success: true, reason: '' });
    res.json({ ok: true, user: { username: user.username }, mustChangePassword: !!user.defaultPassword });
});

app.post('/api/auth/forgot-password/request', async (req, res) => {
    const ip = clientIp(req), nowTs = Date.now();
    const hits = (resetRequestHits.get(ip) || []).filter((t) => nowTs - t < 10 * 60000);
    if (hits.length >= 5) return res.json({ ok: true, message: '如果邮箱匹配，重置令牌将发送到邮箱' });
    resetRequestHits.set(ip, [...hits, nowTs]);
    const { email, captchaToken } = req.body || {}, s = storage.getSettings();
    if (!(await verifyCaptcha(s.captcha?.provider, captchaToken, ip))) return res.json({ ok: true, message: '如果邮箱匹配，重置令牌将发送到邮箱' });
    /* Per-user reset (FREEZE plan §11.3): match the target user by their own
     * email; the response is uniform either way so account existence is not
     * leaked. Token is 128-bit random and bound to that user's userId + email. */
    const wanted = String(email || '').trim().toLowerCase();
    const target = wanted ? storage.listUsers().find((u) => u.email && String(u.email).toLowerCase() === wanted && u.status === 'active') : null;
    if (target) {
        const token = crypto.randomBytes(16).toString('base64url');
        storage.createResetCode({
            id: crypto.randomUUID(),
            username: target.username,
            email: target.email,
            codeHash: sha256(token),
            expiresAt: Date.now() + 10 * 60000,
            createdAt: Date.now(),
        });
        try { storage.rawDb().prepare('UPDATE password_reset_codes SET userId = ? WHERE username = ? AND (userId IS NULL OR userId = \'\')').run(target.userId, target.username); } catch {}
        sendMail(
            'Zephyr 密码重置令牌',
            `Zephyr 密码重置令牌：${token}\n有效期：10 分钟。\n请在重置页粘贴完整令牌。令牌仅可尝试有限次数，用后作废。`,
            target.email,
        ).catch((err) => console.error('[MAIL] 重置令牌发送失败:', err.message));
    }
    res.json({ ok: true, message: '如果邮箱匹配，重置令牌将发送到邮箱' });
});

app.post('/api/auth/forgot-password/reset', (req, res) => {
    const { email, code, newPassword } = req.body || {};
    const ip = clientIp(req);
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
    if (!takeResetVerifySlot(ip)) {
        recordLoginFailure(ip);
        return res.status(429).json({ error: '重置尝试过于频繁，请稍后再试', code: 'reset_rate_limited' });
    }
    const wanted = String(email || '').trim().toLowerCase();
    const user = wanted ? storage.listUsers().find((u) => u.email && String(u.email).toLowerCase() === wanted) : null;
    const rec = user ? storage.findResetCode(user.username, user.email) : null;
    const presented = String(code || '').trim();
    const hashOk = !!(rec && timingSafeEqualStr(rec.codeHash, sha256(presented)));
    if (!user || !rec || rec.expiresAt < Date.now() || !hashOk) {
        recordLoginFailure(ip);
        if (rec && rec.expiresAt >= Date.now()) {
            const attempts = storage.recordResetCodeAttempt(rec.id);
            if (attempts >= RESET_TOKEN_MAX_ATTEMPTS) storage.markResetCodeUsed(rec.id);
        }
        if (user) recordAccountLoginFailure(user);
        return res.status(400).json({ error: '重置令牌无效或已过期' });
    }
    if ((Number(rec.attemptCount) || 0) >= RESET_TOKEN_MAX_ATTEMPTS) {
        storage.markResetCodeUsed(rec.id);
        recordLoginFailure(ip);
        return res.status(400).json({ error: '重置令牌无效或已过期' });
    }
    storage.updateUser(user.username, {
        passwordHash: hashPassword(newPassword),
        defaultPassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
    });
    storage.markResetCodeUsed(rec.id);
    storage.invalidateResetCodesForUser(user.username);
    sessionStore.revokeAllForUser(user.userId, 'password-reset');
    sessionStore.setMustChangePassword(user.userId, false);
    recordLoginSuccess(ip);
    addActivity('通过邮箱重置令牌重置密码', user.userId);
    res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req).zephyr_sid;
    if (sid) sessionStore.revoke(sid, 'logout');
    res.setHeader('Set-Cookie', sessionClearCookie(req));
    res.json({ ok: true });
});

app.get('/api/auth/me', requireUser, (req, res) => {
    res.json({
        user: { username: req.user.username, userId: req.user.userId, role: req.user.role, isSuperAdmin: req.user.isSuperAdmin },
        mustChangePassword: !!req.session.mustChangePassword,
        instanceId: INSTANCE_ID,
    });
});

app.post('/api/auth/change-password/request-code', requireUser, async (req, res) => {
    const user = storage.getUserById(req.session.userId) || storage.getUser(req.session.username);
    if (!user) return res.status(400).json({ error: '用户不存在' });
    const s = storage.getSettings();
    const mail = s.mail || {};
    if (!mail.enabled || !mail.host) return res.status(400).json({ error: '邮件通知未启用，请联系管理员' });
    if (!user.email) return res.status(400).json({ error: '当前账号未设置邮箱，请先在个人信息中填写' });

    const ip = clientIp(req);
    const hits = (resetRequestHits.get(ip) || []).filter((t) => Date.now() - t < 10 * 60000);
    if (hits.length >= 5) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    resetRequestHits.set(ip, [...hits, Date.now()]);

    const token = crypto.randomBytes(16).toString('base64url');
    storage.createResetCode({
        id: crypto.randomUUID(),
        username: user.username,
        email: user.email,
        codeHash: sha256(token),
        expiresAt: Date.now() + 10 * 60000,
        createdAt: Date.now(),
    });
    try { storage.rawDb().prepare('UPDATE password_reset_codes SET userId = ? WHERE username = ? AND (userId IS NULL OR userId = \'\')').run(user.userId, user.username); } catch {}
    sendMail(
        'Zephyr 修改密码验证码',
        `您正在修改登录密码。\n验证码：${token}\n有效期：10 分钟。\n如非本人操作，请立即修改密码。`,
        user.email,
    ).catch((err) => console.error('[MAIL] 改密码验证码发送失败:', err.message));
    res.json({ ok: true, message: '验证码已发送到您的邮箱' });
});

app.post('/api/auth/change-password', requireUser, async (req, res) => {
    const { currentPassword, newPassword, totpCode, emailCode } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
    const user = storage.getUserById(req.session.userId) || storage.getUser(req.session.username);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) return res.status(400).json({ error: '当前密码错误' });

    /* Security gate (FREEZE plan §11.3 enhanced):
     * - TOTP enabled: must provide a valid TOTP code.
     *   If email is also configured + mail enabled: must ALSO provide an
     *   email verification code (both factors required).
     * - TOTP disabled + email configured: must provide an email verification
     *   code (proving control of the account's email, like forgot-password).
     * - TOTP disabled + no email: degrade to currentPassword-only, but log
     *   a warning so admins can identify accounts without 2FA. */
    if (user.totpEnabled) {
        const code = String(totpCode || '').trim();
        if (!code) return res.status(400).json({ error: '请输入两步验证动态码', code: 'totp_required' });
        if (!verifySync({ secret: user.totpSecret || '', token: code }).valid) {
            return res.status(400).json({ error: '两步验证动态码错误', code: 'totp_invalid' });
        }
    }
    if (!user.totpEnabled && !user.email) {
        console.warn('[security] change-password without 2FA or email (no email on account)', { username: user.username });
    }
    /* Email verification: required when TOTP is off (as the sole second factor),
     * OR when TOTP is on AND the account has email (defense-in-depth: both factors). */
    const needEmailCode = !!user.email;
    if (needEmailCode) {
        const s2 = storage.getSettings();
        const mail2 = s2.mail || {};
        if (mail2.enabled && mail2.host) {
            const code = String(emailCode || '').trim();
            if (!code) return res.status(400).json({ error: '请输入邮箱验证码', code: 'email_code_required' });
            const rec = storage.findResetCode(user.username, user.email);
            const hashOk = !!(rec && rec.expiresAt >= Date.now() && timingSafeEqualStr(rec.codeHash, sha256(code)));
            if (!rec || !hashOk) {
                if (rec && rec.expiresAt >= Date.now()) {
                    const attempts = storage.recordResetCodeAttempt(rec.id);
                    if (attempts >= RESET_TOKEN_MAX_ATTEMPTS) storage.markResetCodeUsed(rec.id);
                }
                return res.status(400).json({ error: '邮箱验证码无效或已过期', code: 'email_code_invalid' });
            }
            storage.markResetCodeUsed(rec.id);
        } else if (!user.totpEnabled) {
            console.warn('[security] change-password without 2FA or email (mail disabled)', { username: user.username });
        }
    } else if (!user.totpEnabled) {
        console.warn('[security] change-password without 2FA or email (no email on account)', { username: user.username });
    }

    /* Rollback token: capture the pre-change hash so the notification link can
     * restore it if this change wasn't made by the account owner. One live
     * token per user, single use, 24h expiry. */
    const rollbackToken = crypto.randomBytes(24).toString('base64url');
    const rollbackExpiresAt = Date.now() + PASSWORD_ROLLBACK_TTL_MS;
    storage.createPasswordRollbackToken({
        id: crypto.randomUUID(),
        userId: user.userId,
        username: user.username,
        tokenHash: sha256(rollbackToken),
        oldPasswordHash: user.passwordHash,
        expiresAt: rollbackExpiresAt,
        createdAt: Date.now(),
        createdIp: clientIp(req),
    });
    const rollbackUrl = `${publicOrigin(req)}/password-rollback?token=${rollbackToken}`;

    storage.updateUser(user.username, { passwordHash: hashPassword(newPassword), defaultPassword: false });
    /* Password change invalidates every other session (FREEZE plan §11.3);
     * the current session survives and its must-change flag clears. */
    const sid = parseCookies(req).zephyr_sid;
    sessionStore.revokeAllForUser(user.userId, 'password-changed', { exceptSid: sid || '' });
    sessionStore.setMustChangePassword(user.userId, false);
    req.session.mustChangePassword = false;
    addActivity('修改登录密码');

    /* Success notification. With a bound mailbox the rollback link travels by
     * email only; without one the response carries it so the UI can show it
     * in-app (the only remaining notification channel). Server has no
     * per-user locale (UI language lives in localStorage), so the email is
     * bilingual zh-CN/en. */
    let notifiedByEmail = false;
    const s3 = storage.getSettings();
    const mail3 = s3.mail || {};
    if (user.email && mail3.enabled && mail3.host) {
        const changedAt = new Date().toLocaleString('zh-CN', { hour12: false });
        const expiresAtText = new Date(rollbackExpiresAt).toLocaleString('zh-CN', { hour12: false });
        const text = [
            '您的 Zephyr 账号密码刚刚被修改。',
            '如果这是您本人的操作，请忽略此邮件。',
            '如果这不是您本人的操作，请立即点击以下链接恢复到修改前的密码（链接仅可使用一次）：',
            rollbackUrl,
            `链接有效期至：${expiresAtText}（24 小时）`,
            '',
            `账号：${user.username}`,
            `操作时间：${changedAt}`,
            `IP 地址：${clientIp(req)}`,
            '',
            '---',
            '',
            'Your Zephyr account password was just changed.',
            'If this was you, you can ignore this email.',
            'If this was NOT you, click the link below immediately to restore your previous password (the link can be used only once):',
            rollbackUrl,
            `Link valid until: ${expiresAtText} (24 hours)`,
            '',
            `Account: ${user.username}`,
            `Time: ${changedAt}`,
            `IP address: ${clientIp(req)}`,
        ].join('\n');
        try {
            await sendMail('Zephyr 密码修改通知 / Password Change Notification', text, user.email);
            notifiedByEmail = true;
        } catch (err) {
            console.error('[MAIL] 密码修改通知发送失败:', { username: user.username, error: err.message });
        }
    }
    res.json({
        ok: true,
        notifiedByEmail,
        rollbackExpiresAt,
        ...(notifiedByEmail ? {} : { rollbackUrl }),
    });
});

/* One-time rollback link from the password-change notification. Public: the
 * whole point is that the owner may be locked out while an attacker holds the
 * new password, so the token itself is the capability. */
app.post('/api/auth/password-rollback', async (req, res) => {
    const ip = clientIp(req);
    if (!takeRollbackVerifySlot(ip)) {
        return res.status(429).json({ error: '尝试过于频繁，请稍后再试', code: 'rollback_rate_limited' });
    }
    const token = String(req.body?.token || '').trim();
    const rec = token ? storage.findPasswordRollbackTokenByHash(sha256(token)) : null;
    if (!rec || rec.expiresAt < Date.now()) {
        return res.status(400).json({ error: '恢复链接无效或已过期', code: 'rollback_invalid' });
    }
    const user = storage.getUserById(rec.userId) || storage.getUser(rec.username);
    if (!user) {
        return res.status(400).json({ error: '恢复链接无效或已过期', code: 'rollback_invalid' });
    }
    storage.updateUser(user.username, { passwordHash: rec.oldPasswordHash, defaultPassword: false });
    storage.markPasswordRollbackTokenUsed(rec.id);
    storage.invalidateResetCodesForUser(user.username);
    /* A rollback means the change was hostile: kill EVERY session, including
     * the attacker's, and clear any forced must-change flag. */
    sessionStore.revokeAllForUser(user.userId, 'password-rollback');
    sessionStore.setMustChangePassword(user.userId, false);
    addActivity('通过恢复链接回滚密码', user.userId);
    console.warn('[security] password rolled back via notification link', { username: user.username, ip });

    const s = storage.getSettings();
    const mail = s.mail || {};
    if (user.email && mail.enabled && mail.host) {
        const text = [
            '您的 Zephyr 账号密码已通过恢复链接恢复到修改前的状态，所有会话均已退出。',
            '请使用之前的密码重新登录，并建议尽快开启 TOTP 两步验证。',
            '如果这次恢复不是您本人的操作，请立即联系管理员。',
            '',
            `账号：${user.username}`,
            `操作时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
            `IP 地址：${ip}`,
            '',
            '---',
            '',
            'Your Zephyr account password was restored to its previous state via the recovery link. All sessions have been signed out.',
            'Please sign in with your previous password. Enabling TOTP two-factor authentication is recommended.',
            'If you did not perform this recovery, contact your administrator immediately.',
            '',
            `Account: ${user.username}`,
            `Time: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
            `IP address: ${ip}`,
        ].join('\n');
        sendMail('Zephyr 密码已恢复 / Password Restored', text, user.email)
            .catch((err) => console.error('[MAIL] 密码恢复确认邮件发送失败:', { username: user.username, error: err.message }));
    }
    res.json({ ok: true });
});

app.get('/api/me/sessions', requireUser, (req, res) => {
    const currentHash = sessionTokenHash(parseCookies(req).zephyr_sid || '');
    const sessions = sessionStore.listForUser(req.session.userId).map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        remember: s.remember,
        current: s.id === currentHash,
    }));
    res.json({ sessions });
});

app.delete('/api/me/sessions/:id', requireUser, (req, res) => {
    const targetId = String(req.params.id || '');
    const currentHash = sessionTokenHash(parseCookies(req).zephyr_sid || '');
    if (targetId === currentHash) return res.status(400).json({ error: '不能撤销当前会话，请使用退出登录', code: 'cannot_revoke_current' });
    const ok = sessionStore.revokeForUser(req.session.userId, targetId, 'user-revoked');
    if (!ok) return res.status(404).json({ error: '会话不存在', code: 'not_found' });
    res.json({ ok: true });
});

/* ─── Multi-user bootstrap (FREEZE plan §19.2) ─── */
app.get('/api/me/bootstrap', requireUser, (req, res) => {
    const user = storage.getUserById(req.user.userId);
    const connections = resourceService.listConnections(req.user);
    const shared = sharingService.listSharedWithMe(req.user, { resourceType: 'connection' });
    const clientId = String(req.query.clientId || '').slice(0, 80);
    const workspaces = clientId
        ? workspaceService.list(req.user.userId, { clientId })
        : workspaceService.list(req.user.userId).slice(0, 10);
    const globalSettings = storage.getSettings();
    res.json({
        user: {
            userId: user.userId,
            username: user.username,
            role: user.role,
            status: user.status,
            email: user.email || '',
            totpEnabled: !!user.totpEnabled,
            isSuperAdmin: !!user.isSuperAdmin,
        },
        instanceId: INSTANCE_ID,
        settings: userSettingsService.effective(req.user),
        workspaces,
        resources: {
            connections: connections.length,
            sharedConnections: shared.length,
        },
        policies: {
            aiEnabled: !!globalSettings.ai?.enabled,
            notesEnabled: !!(globalSettings.notes && globalSettings.notes.enabled),
        },
    });
});

/* ─── Personal settings (FREEZE plan §15) ─── */
function withRuntimeMeta(settings) {
    const result = {
        ...settings,
        version: APP_VERSION,
        agentRelease: AGENT_RELEASE,
    };
    if (result.ai) {
        result.ai = {
            ...result.ai,
            skills: mergeZephyrDefaultSkills(result.ai.skills || []),
        };
    }
    return result;
}

app.get('/api/me/settings', requireUser, (req, res) => {
    res.json({
        settings: withRuntimeMeta(userSettingsService.effective(req.user)),
        overrides: userSettingsService.getUserOverrides(req.user.userId),
    });
});

app.put('/api/me/settings', requireUser, (req, res) => {
    try {
        const overrides = userSettingsService.putUserOverrides(req.user.userId, req.body || {});
        res.json({
            ok: true,
            overrides,
            settings: withRuntimeMeta(userSettingsService.effective(req.user)),
        });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

/* ─── Workspaces (FREEZE plan §14) ─── */
app.get('/api/me/workspaces', requireUser, (req, res) => {
    const clientId = req.query.clientId ? String(req.query.clientId) : null;
    res.json({ workspaces: workspaceService.list(req.user.userId, { clientId }) });
});

app.get('/api/me/workspaces/:id', requireUser, (req, res) => {
    try {
        res.json({ workspace: workspaceService.get(req.user.userId, req.params.id) });
    } catch (err) {
        handleServiceError(res, err, 404);
    }
});

app.put('/api/me/workspaces/:id', requireUser, (req, res) => {
    try {
        const body = req.body || {};
        const workspace = workspaceService.put(req.user, {
            workspaceId: req.params.id === 'new' ? undefined : req.params.id,
            clientId: body.clientId,
            name: body.name,
            state: body.state,
            expectedRevision: body.expectedRevision,
        });
        res.json({ workspace });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

function handleWorkspaceRestore(req, res) {
    try {
        res.json(workspaceService.restore(req.user, req.params.id));
    } catch (err) {
        handleServiceError(res, err, 404);
    }
}
// Accept both POST and GET. Early clients called restore with GET and silently
// failed (Express 404), so refresh never reopened terminal sessions.
app.post('/api/me/workspaces/:id/restore', requireUser, handleWorkspaceRestore);
app.get('/api/me/workspaces/:id/restore', requireUser, handleWorkspaceRestore);

app.delete('/api/me/workspaces/:id', requireUser, (req, res) => {
    try {
        workspaceService.delete(req.user.userId, req.params.id);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 404);
    }
});

/* ─── Notes (FREEZE plan §6) ─── */
app.get('/api/notes', requireUser, (req, res) => {
    try {
        res.json(notesService.list(req.user, {
            q: req.query.q,
            group: req.query.group,
            tag: req.query.tag,
            connectionId: req.query.connectionId,
            limit: req.query.limit,
            offset: req.query.offset,
            trash: req.query.trash === '1' || req.query.trash === 'true',
        }));
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/notes/groups', requireUser, (req, res) => {
    res.json({ groups: notesService.groups(req.user) });
});

app.post('/api/notes/groups/rename', requireUser, (req, res) => {
    try {
        res.json(notesService.renameGroup(req.user, req.body?.oldPath, req.body?.newPath));
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/notes/groups/delete', requireUser, (req, res) => {
    try {
        res.json(notesService.deleteGroup(req.user, req.body?.groupPath));
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/notes', requireUser, (req, res) => {
    try {
        res.json({ note: notesService.create(req.user, req.body || {}) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/notes/:id', requireUser, (req, res) => {
    try {
        res.json({ note: notesService.get(req.user, req.params.id) });
    } catch (err) {
        handleServiceError(res, err, 404);
    }
});

app.put('/api/notes/:id', requireUser, (req, res) => {
    try {
        res.json({ note: notesService.update(req.user, req.params.id, req.body || {}) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.delete('/api/notes/:id', requireUser, (req, res) => {
    try {
        notesService.delete(req.user, req.params.id);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/notes/:id/restore', requireUser, (req, res) => {
    try {
        res.json({ note: notesService.restore(req.user, req.params.id) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.delete('/api/notes/:id/purge', requireUser, (req, res) => {
    try {
        const force = req.query.force === '1'
            || req.query.force === 'true'
            || req.query.permanent === '1'
            || req.query.permanent === 'true'
            || req.body?.force === true
            || req.body?.permanent === true;
        notesService.purge(req.user, req.params.id, { allowActive: !!force });
        res.json({ ok: true, permanent: !!force });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/notes/bulk', requireUser, (req, res) => {
    try {
        res.json(notesService.bulk(req.user, req.body || {}));
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/notes/trash/empty', requireUser, (req, res) => {
    try {
        res.json(notesService.emptyTrash(req.user));
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/notes/import-markdown', requireUser, (req, res) => {
    try {
        res.json({ note: notesService.importMarkdown(req.user, req.body || {}) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/notes/:id/export.md', requireUser, (req, res) => {
    try {
        const file = notesService.exportMarkdown(req.user, req.params.id);
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        // RFC 5987: ASCII fallback filename + UTF-8 encoded filename* for
        // non-ASCII titles (emoji, Chinese). Node rejects non-ASCII in header values.
        const asciiName = file.filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
        const utf8Name = encodeURIComponent(file.filename);
        res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
        res.send(file.content);
    } catch (err) {
        handleServiceError(res, err, 404);
    }
});

/* ─── Deep Link prepare/test (FREEZE plan §5) ─── */
app.post('/api/deeplinks/prepare', requireUser, (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const result = deepLinkService.prepare(req.user, req.body?.uri);
        res.json(result);
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/deeplinks/:token', requireUser, (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(deepLinkService.peek(req.user, req.params.token));
    } catch (err) {
        handleServiceError(res, err, 404);
    }
});

app.post('/api/deeplinks/:token/test', requireUser, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const { draft, credential } = deepLinkService.forTest(req.user, req.params.token, req.body?.overrides || {});
        if (String(draft.protocol || '').toUpperCase() === 'TELNET') {
            // Telnet test: just verify host:port reachability (no full IAC
            // negotiation needed for a connectivity test).
            const timeoutMs = Math.max(1000, Math.min(Number(req.body?.timeoutSeconds || 10) * 1000, 30000));
            const result = await testTelnetConnection({ host: draft.host, port: draft.port }, timeoutMs);
            return res.status(result.ok ? 200 : 400).json(result);
        }
        const conn = {
            host: draft.host,
            port: draft.port,
            username: draft.username,
            password: (req.body?.credentialOverride?.password) || credential?.password || '',
            privateKey: req.body?.credentialOverride?.privateKey || '',
            protocol: draft.protocol || 'SSH',
            connectionMode: 'direct',
        };
        const timeoutMs = Math.max(1000, Math.min(Number(req.body?.timeoutSeconds || 10) * 1000, 30000));
        const result = String(conn.protocol).toUpperCase() === 'SSH'
            ? await testSSHConnection(conn, timeoutMs)
            : { ok: false, code: 'unsupported_protocol', message: `不支持的协议：${conn.protocol}`, durationMs: 0 };
        res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

/* ─── Persistent worker bridge (FREEZE plan §14) ───
 * Node stays in the control plane: authenticate, resolve ACL+secrets, issue a
 * one-time ticket. The browser then connects to the Go worker directly; the
 * terminal byte stream never transits Node. */
app.get('/api/terminal-history/:sessionId', requireUser, (req, res) => {
    try {
        const beforeSeq = req.query.beforeSeq == null ? Infinity : Number(req.query.beforeSeq);
        const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
        const records = terminalHistory.readRecords(req.user.userId, req.params.sessionId, { beforeSeq, limit });
        res.json({ sessionId: req.params.sessionId, records, hasMore: records.length === limit });
    } catch (err) {
        res.status(400).json({ error: err.message, code: 'terminal_history_read_failed' });
    }
});

app.get('/api/terminal-history/:sessionId/tail', requireUser, (req, res) => {
    try {
        const maxBytes = Math.max(1024, Math.min(2 * 1024 * 1024, Number(req.query.maxBytes) || undefined));
        res.json(terminalHistory.replayTail(req.user.userId, req.params.sessionId, maxBytes));
    } catch (err) {
        res.status(400).json({ error: err.message, code: 'terminal_history_tail_failed' });
    }
});


let terminalHistoryIndexerPromise = null;
async function getTerminalHistoryIndexer() {
    if (!terminalHistoryIndexerPromise) {
        terminalHistoryIndexerPromise = import('./terminal-history-indexer.mjs')
            .then(({ TerminalHistoryIndexer }) => new TerminalHistoryIndexer({ history: terminalHistory, root: path.join(DATA_DIR, 'terminal-history') }))
            .catch((error) => { terminalHistoryIndexerPromise = null; throw error; });
    }
    return terminalHistoryIndexerPromise;
}

const terminalHistoryIndexTimer = setInterval(() => {
    void getTerminalHistoryIndexer()
        .then((indexer) => indexer.indexAllSessions())
        .catch((error) => console.warn('[TERMINAL-HISTORY] background index failed', { error: error.message }));
}, Math.max(1000, Number(process.env.TERMINAL_HISTORY_INDEX_INTERVAL_MS) || 5000));
terminalHistoryIndexTimer.unref?.();

app.get('/api/terminal-history/:sessionId/lines', requireUser, async (req, res) => {
    try {
        const indexer = await getTerminalHistoryIndexer();
        const page = await indexer.readPage(req.user.userId, req.params.sessionId, {
            beforeSeq: req.query.beforeSeq == null ? Infinity : Number(req.query.beforeSeq),
            afterSeq: req.query.afterSeq == null ? null : Number(req.query.afterSeq),
            limit: Number(req.query.limit) || 200,
        });
        res.json({ ok: true, sessionId: req.params.sessionId, ...page });
    } catch (error) {
        console.error('[TERMINAL-HISTORY] logical-line index failed', { sessionId: req.params.sessionId, error: error.message });
        res.status(500).json({ error: 'terminal_history_index_failed' });
    }
});

app.post('/api/worker/ticket', requireUser, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const body = req.body || {};
        let result;
        if (body.transientToken) {
            result = await workerBridge.issueForTransient(req.user, String(body.transientToken), body.overrides || {});
        } else if (body.connectionId) {
            result = await workerBridge.issueForConnection(req.user, String(body.connectionId));
        } else {
            return res.status(400).json({ error: '需要 connectionId 或 transientToken', code: 'invalid_request' });
        }
        authz.audit({
            actorUserId: req.user.userId,
            action: 'worker.ticket_issued',
            outcome: 'success',
            metadata: { source: body.transientToken ? 'transient' : 'saved', host: result.workerWsUrl ? 'redacted' : '' },
        });
        res.json(result);
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/worker/sessions', requireUser, async (req, res) => {
    /* Only admins see the full live-session list; regular users see only
     * their own (filtered server-side by the worker on userId claim). */
    try {
        const data = await workerBridge.listSessions();
        const sessions = req.user.role === 'admin'
            ? (data.sessions || [])
            : (data.sessions || []).filter((s) => s.userId === req.user.userId);
        res.json({ sessions, enabled: workerBridge.enabled });
    } catch (err) {
        handleServiceError(res, err, 500);
    }
});

app.post('/api/worker/sessions/:id/kill', requireUser, async (req, res) => {
    try {
        const data = await workerBridge.listSessions();
        const target = (data.sessions || []).find((s) => s.id === req.params.id);
        if (!target) throw new HttpError(404, 'session_not_found', '会话不存在');
        if (target.userId !== req.user.userId && req.user.role !== 'admin') {
            throw new HttpError(403, 'forbidden_resource_control', '无权操作此会话');
        }
        await workerBridge.killSession(req.params.id);
        authz.audit({ actorUserId: req.user.userId, resourceType: 'terminalSession', resourceId: req.params.id, action: 'worker.kill_session', outcome: 'success' });
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

/* ─── Resource sharing (FREEZE plan §19.4) ─── */
app.get('/api/resources/:type/:id/shares', requireUser, (req, res) => {
    try {
        res.json({ shares: sharingService.listShares(req.user, req.params.type, req.params.id) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.put('/api/resources/:type/:id/shares', requireUser, (req, res) => {
    try {
        const results = sharingService.putShares(req.user, req.params.type, req.params.id, req.body?.shares || []);
        res.json({ ok: true, results });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.delete('/api/resources/:type/:id/shares/:subjectId', requireUser, (req, res) => {
    try {
        sharingService.deleteShare(req.user, req.params.type, req.params.id, req.params.subjectId);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/me/shared', requireUser, (req, res) => {
    res.json({ shares: sharingService.listSharedWithMe(req.user) });
});

/* ─── Admin: user management (FREEZE plan §19.3) ─── */
app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json({ users: userService.listUsers() });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
    try {
        const user = userService.createUser(req.user, req.body || {});
        res.json({ user });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/admin/users/:userId', requireAdmin, (req, res) => {
    try {
        const user = userService.getUser(req.params.userId);
        const grants = authz.listSubjectGrants(req.params.userId).map((g) => {
            const raw = resourceService._rawResource(g.resourceType, g.resourceId);
            return { ...g, resourceExists: !!raw, resourceName: raw?.name || '' };
        });
        res.json({ user, grants });
    } catch (err) {
        handleServiceError(res, err, 404);
    }
});

app.patch('/api/admin/users/:userId', requireAdmin, (req, res) => {
    try {
        const user = userService.updateUser(req.user, req.params.userId, req.body || {});
        res.json({ user });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/admin/users/:userId/suspend', requireAdmin, (req, res) => {
    try {
        res.json({ user: userService.suspendUser(req.user, req.params.userId) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/admin/users/:userId/reactivate', requireAdmin, (req, res) => {
    try {
        res.json({ user: userService.reactivateUser(req.user, req.params.userId) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/admin/users/:userId/transfer-super-admin', requireAdmin, (req, res) => {
    try {
        res.json({ user: userService.transferSuperAdmin(req.user, req.params.userId) });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/admin/users/:userId/force-password-reset', requireAdmin, (req, res) => {
    try {
        userService.forcePasswordReset(req.user, req.params.userId, req.body || {});
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/admin/users/:userId/revoke-sessions', requireAdmin, (req, res) => {
    try {
        const count = userService.revokeSessions(req.user, req.params.userId);
        res.json({ ok: true, revoked: count });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.delete('/api/admin/users/:userId', requireAdmin, (req, res) => {
    try {
        userService.deleteUser(req.user, req.params.userId, { resourcePolicy: String(req.body?.resourcePolicy || 'transfer-to-admin') });
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.put('/api/admin/users/:userId/grants', requireAdmin, (req, res) => {
    try {
        const target = storage.getUserBrief(req.params.userId);
        if (!target) throw new HttpError(404, 'user_not_found', '用户不存在');
        const desired = Array.isArray(req.body?.grants) ? req.body.grants : [];
        const results = [];
        const byResource = new Map();
        for (const g of desired) {
            const key = `${g.resourceType}:${g.resourceId}`;
            if (!byResource.has(key)) byResource.set(key, g);
        }
        for (const g of byResource.values()) {
            const raw = resourceService._rawResource(String(g.resourceType), String(g.resourceId));
            authz.assertCan(req.user, CAP.SHARE, String(g.resourceType), String(g.resourceId), raw || { ownerUserId: '' }, { resourceExists: !!raw });
            const caps = Array.isArray(g.capabilities) ? g.capabilities : [];
            if (!caps.length) {
                authz.revoke({ resourceType: g.resourceType, resourceId: g.resourceId, subjectId: target.userId, revokedByUserId: req.user.userId });
                results.push({ resourceType: g.resourceType, resourceId: g.resourceId, revoked: true });
            } else {
                const granted = authz.grant({
                    resourceType: String(g.resourceType),
                    resourceId: String(g.resourceId),
                    subjectId: target.userId,
                    capabilities: caps,
                    grantedByUserId: req.user.userId,
                    expiresAt: g.expiresAt || null,
                });
                results.push({ resourceType: g.resourceType, resourceId: g.resourceId, capabilities: granted });
            }
        }
        res.json({ ok: true, results });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json({ events: authz.listAuditEvents({ limit }) });
});

app.post('/api/security/totp/setup', requireUser, async (req, res) => {
    const user = storage.getUser(req.session.username); const secret = generateSecret();
    const otpauth = generateURI({ label: user.username, issuer: 'Zephyr', secret }); const qr = await QRCode.toDataURL(otpauth);
    req.session.pendingTotpSecret = secret; res.json({ secret, qr });
});
app.post('/api/security/totp/enable', requireUser, (req, res) => {
    const secret = req.session.pendingTotpSecret; if (!secret || !verifySync({ secret, token: String(req.body?.code || '') }).valid) return res.status(400).json({ error: '动态验证码错误' });
    storage.updateUser(req.session.username, { totpEnabled: true, totpSecret: secret }); delete req.session.pendingTotpSecret; addActivity('开启 TOTP 两步验证'); res.json({ ok: true });
});
app.post('/api/security/totp/disable', requireUser, (req, res) => {
    const user = storage.getUser(req.session.username); const { currentPassword, code } = req.body || {};
    if (!verifyPassword(currentPassword, user.passwordHash) || !verifySync({ secret: user.totpSecret || '', token: String(code || '') }).valid) return res.status(400).json({ error: '密码或动态验证码错误' });
    storage.updateUser(user.username, { totpEnabled: false, totpSecret: null }); addActivity('关闭 TOTP 两步验证'); res.json({ ok: true });
});
app.get('/api/security/status', requireUser, (req, res) => { const u = storage.getUser(req.user.username); res.json({ user: { username: u.username, email: u.email || '', totpEnabled: !!u.totpEnabled }, passkeys: storage.listPasskeys(u.username).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) }); });
app.put('/api/security/profile', requireUser, (req, res) => {
    const nextUsername = String(req.body?.username || '').trim();
    if (!nextUsername) return res.status(400).json({ error: '用户名不能为空' });
    if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(nextUsername)) return res.status(400).json({ error: '用户名需为 2-32 位字母、数字或 ._@-' });
    try {
        let u = storage.updateUser(req.session.username, { email: String(req.body?.email || '') });
        if (nextUsername !== req.session.username) {
            u = storage.renameUser(req.session.username, nextUsername);
            /* Identity follows the immutable userId; live sessions only need
             * their display username refreshed (FREEZE plan §18.1). */
            sessionStore.renameUser(u.userId, u.username);
            req.session.username = nextUsername;
            addActivity(`修改登录用户名：${nextUsername}`);
        }
        res.json({ user: { username: u.username, email: u.email || '', totpEnabled: !!u.totpEnabled } });
    } catch (err) {
        res.status(400).json({ error: err.message || '修改资料失败' });
    }
});

app.get('/api/connections', requireUser, (req, res) => {
    /* Owner-aware list: own resources + explicitly shared ones (§19.4). */
    try {
        const activities = req.user.role === 'admin'
            ? storage.getActivities()
            : storage.getActivitiesForUser(req.user.userId);
        res.json({ connections: resourceService.listConnections(req.user), activities });
    } catch (err) {
        handleServiceError(res, err, 500);
    }
});

app.get('/api/activities', requireUser, (req, res) => {
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || 0;
    const userId = req.user.role === 'admin' ? '' : req.user.userId;
    res.json({ activities: storage.queryActivities({ userId, from, to, limit: 500 }) });
});

app.post('/api/connections', requireUser, (req, res) => {
    const body = req.body || {};
    const protocol = String(body.protocol || 'SSH').toUpperCase();
    const ephemeralCreate = !!body.ephemeral;
    // Ephemeral one-shots may omit display name (auto-filled below).
    if ((!ephemeralCreate && !body.name) || !body.host || (protocol === 'SSH' && !body.username)) {
        return res.status(400).json({ error: protocol === 'SSH' ? '名称、主机、用户名不能为空' : '名称、主机不能为空' });
    }
    const ephemeral = !!body.ephemeral;
    const conn = {
        id: crypto.randomUUID(),
        name: String(body.name || '').trim() || `${protocol} ${String(body.host || '').trim()}`,
        host: String(body.host).trim(),
        port: Number(body.port) || protocolDefaultPort(protocol),
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
        shareWithUsers: ephemeral ? false : !!body.shareWithUsers,
        shareWithAdmins: ephemeral ? false : !!body.shareWithAdmins,
        ephemeral,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
        lastConnectedAt: null,
    };
    /* RDP-specific settings */
    if (protocol === 'RDP') {
        conn.rdpSoundMode = ['local', 'remote', 'off'].includes(body.rdpSoundMode) ? body.rdpSoundMode : 'local';
        conn.rdpClipboard = body.rdpClipboard !== false;
        conn.rdpMicrophone = !!body.rdpMicrophone;
        conn.rdpLocation = !!body.rdpLocation;
        conn.rdpStorage = !!body.rdpStorage;
        conn.rdpCamera = !!body.rdpCamera;
        conn.rdpResolution = ['auto', '1080p', '2K', '4K', '8K'].includes(body.rdpResolution) ? body.rdpResolution : '1080p';
        conn.rdpQuality = ['balanced', 'performance', 'quality'].includes(body.rdpQuality) ? body.rdpQuality : 'balanced';
        conn.rdpFps = [30, 45, 60, 120, 144].includes(Number(body.rdpFps)) ? Number(body.rdpFps) : 30;
        conn.rdpPipeline = 'worker-gpu-v2';
        conn.rdpTouchMode = body.rdpTouchMode === 'relative' ? 'relative' : 'direct';
        conn.rdpTouchSensitivity = Math.max(0.5, Math.min(3, Number(body.rdpTouchSensitivity) || 1.5));
        conn.rdpDomain = String(body.rdpDomain || '').trim();
    }
    applyConnectionRouteFields(conn, body);
    if (protocol === 'TELNET') {
        // Telnet cannot use SSH target credentials, but its raw TCP connection
        // may travel through a proxy or an SSH jump chain. Username/password
        // remain encrypted at rest and are used only for in-band auto-login.
        conn.sshKeyId = '';
        conn.privateKey = '';
    }
    if (body.encoding !== undefined) conn.encoding = String(body.encoding || 'utf-8');
    else if (protocol === 'TELNET' && !conn.encoding) conn.encoding = 'utf-8';
    try {
        const saved = resourceService.createConnection(req.user, conn);
        addActivity(`新增连接：${conn.name}`, req.user.userId);
        res.json({ connection: saved });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.put('/api/connections/:id', requireUser, (req, res) => {
    const body = req.body || {};
    try {
        const saved = resourceService.updateConnection(req.user, req.params.id, (conn) => {
            ['name', 'host', 'username', 'remark'].forEach((key) => { if (body[key] !== undefined) conn[key] = String(body[key]); });
            if (body.port !== undefined) conn.port = Number(body.port) || protocolDefaultPort(body.protocol || conn.protocol);
            if (body.protocol !== undefined) conn.protocol = String(body.protocol).toUpperCase();
            if (body.tags !== undefined) conn.tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : String(body.tags || '').split(',').map((v) => v.trim()).filter(Boolean);
            if (body.sshKeyId !== undefined) conn.sshKeyId = String(body.sshKeyId || '');
            if (body.shareWithUsers !== undefined) conn.shareWithUsers = !!body.shareWithUsers;
            if (body.shareWithAdmins !== undefined) conn.shareWithAdmins = !!body.shareWithAdmins;
            applyConnectionRouteFields(conn, body);
            if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
            if (String(conn.protocol || '').toUpperCase() === 'TELNET') {
                conn.sshKeyId = '';
                conn.privateKey = '';
                // Telnet password is in-band auto-login material — allow update.
                if (body.encoding !== undefined) conn.encoding = String(body.encoding || 'utf-8');
            } else {
                if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
                if (body.encoding !== undefined) conn.encoding = String(body.encoding || 'utf-8');
            }
            if (String(conn.protocol || '').toUpperCase() === 'RDP') {
                if (body.rdpSoundMode !== undefined) conn.rdpSoundMode = ['local', 'remote', 'off'].includes(body.rdpSoundMode) ? body.rdpSoundMode : 'local';
                if (body.rdpClipboard !== undefined) conn.rdpClipboard = body.rdpClipboard !== false;
                if (body.rdpMicrophone !== undefined) conn.rdpMicrophone = !!body.rdpMicrophone;
                if (body.rdpLocation !== undefined) conn.rdpLocation = !!body.rdpLocation;
                if (body.rdpStorage !== undefined) conn.rdpStorage = !!body.rdpStorage;
                if (body.rdpCamera !== undefined) conn.rdpCamera = !!body.rdpCamera;
                if (body.rdpResolution !== undefined) conn.rdpResolution = ['auto', '1080p', '2K', '4K', '8K'].includes(body.rdpResolution) ? body.rdpResolution : '1080p';
                if (body.rdpQuality !== undefined) conn.rdpQuality = ['balanced', 'performance', 'quality'].includes(body.rdpQuality) ? body.rdpQuality : 'balanced';
                if (body.rdpFps !== undefined) conn.rdpFps = [30, 45, 60, 120, 144].includes(Number(body.rdpFps)) ? Number(body.rdpFps) : 30;
                if (body.rdpPipeline !== undefined) conn.rdpPipeline = 'worker-gpu-v2';
                if (body.rdpTouchMode !== undefined) conn.rdpTouchMode = body.rdpTouchMode === 'relative' ? 'relative' : 'direct';
                if (body.rdpTouchSensitivity !== undefined) conn.rdpTouchSensitivity = Math.max(0.5, Math.min(3, Number(body.rdpTouchSensitivity) || 1.5));
                if (body.rdpDomain !== undefined) conn.rdpDomain = String(body.rdpDomain || '').trim();
            }
            return conn;
        });
        addActivity(`编辑连接：${saved.name}`, req.user.userId);
        res.json({ connection: saved });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.delete('/api/connections/:id', requireUser, (req, res) => {
    try {
        resourceService.deleteConnection(req.user, req.params.id);
        addActivity(`删除连接：${req.params.id}`, req.user.userId);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.post('/api/connections/:id/open', requireUser, (req, res) => {
    try {
        const reveal = req.body?.purpose === 'reveal' || req.body?.secret !== undefined;
        if (reveal) {
            const auth = verifySensitiveAccess(req, req.body?.secret);
            const conn = resourceService.getConnection(req.user, req.params.id, { reveal: true });
            authz.audit({ actorUserId: req.user.userId, resourceType: 'connection', resourceId: req.params.id, action: 'resource.reveal_secret', outcome: 'success', metadata: { method: auth.method } });
            console.info('[secret-open] reveal connection secrets', { connectionId: conn.id, name: conn.name, authMethod: auth.method });
            return res.json({ connection: { ...conn, jumpHostIds: normalizeJumpHostIds(conn) } });
        }
        /* Connect intent requires the `use` capability (§12.3). */
        const raw = storage.getConnectionById(req.params.id);
        authz.assertCan(req.user, CAP.USE, 'connection', req.params.id, raw || { ownerUserId: '' }, { resourceExists: !!raw });
        resourceService.markConnected(req.user, req.params.id);
        addActivity(`打开连接：${raw.name}`, req.user.userId);
        res.json({ connection: resourceService.getConnection(req.user, req.params.id) });
    } catch (err) {
        handleServiceError(res, err, 403);
    }
});

/* Mint a short-lived RDP proxy target grant for ad-hoc temporary connects.
 * Password never leaves the browser form → WASM path; this only authorizes TCP
 * bridging for host:port so /rdp-proxy does not require a saved connection. */
app.post('/api/rdp/ephemeral-grant', requireUser, (req, res) => {
    const host = String(req.body?.host || '').trim();
    const port = Number(req.body?.port) || 3389;
    if (!host) return res.status(400).json({ error: '主机不能为空' });
    try {
        const grant = grantEphemeralRdpTarget(req.user.userId, host, port);
        authz.audit?.({
            actorUserId: req.user.userId,
            action: 'rdp.ephemeral_grant',
            outcome: 'success',
            metadata: { host: grant.host, port: grant.port },
        });
        addActivity(`临时 RDP 连接授权：${grant.host}:${grant.port}`, req.user.userId);
        res.json({ ok: true, ...grant });
    } catch (err) {
        res.status(400).json({ error: err.message || '无法授权临时 RDP 目标' });
    }
});

/* RDP WASM credential endpoint — returns credentials for browser-side RDP connections.
 * Only accessible to authenticated users.  Credentials are never cached on the client. */
app.post('/api/rdp/credentials', requireUser, (req, res) => {
    const connectionId = String(req.body?.connectionId || '').trim();
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    /* RDP runs the protocol in the browser, so credentials must leave the
     * server — gate on the explicit revealSecret capability (§12.3). Shared
     * `use` without revealSecret cannot mint browser-side RDP credentials. */
    const raw = storage.getConnectionById(connectionId);
    try {
        authz.assertCan(req.user, CAP.REVEAL_SECRET, 'connection', connectionId, raw || { ownerUserId: '' }, { resourceExists: !!raw });
    } catch (err) {
        return handleServiceError(res, err, 403);
    }
    const conn = raw;
    if (String(conn.protocol || 'SSH').toUpperCase() !== 'RDP') return res.status(400).json({ error: '非 RDP 连接' });
    const resolved = resolveSshKeyForConnection(conn);
    let username = String(resolved.username || 'Administrator');
    let domain = String(resolved.domain || resolved.rdpDomain || '');
    const domainMatch = username.match(/^([^\\]+)\\(.+)$/);
    if (!domain && domainMatch) { domain = domainMatch[1]; username = domainMatch[2]; }
    console.info('[rdp-credentials]', 'issued', { connectionId, host: conn.host, user: username, sessionUser: req.session?.username });
    res.json({ host: conn.host, port: Number(conn.port) || 3389, username, password: resolved.password || '', domain, rdpSoundMode: conn.rdpSoundMode || 'local', rdpClipboard: conn.rdpClipboard !== false, rdpResolution: conn.rdpResolution || '1080p', rdpQuality: conn.rdpQuality || 'balanced', rdpFps: conn.rdpFps || 30, rdpPipeline: 'worker-gpu-v2', rdpTouchMode: conn.rdpTouchMode === 'relative' ? 'relative' : 'direct', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(conn.rdpTouchSensitivity) || 1.5)), rdpMicrophone: !!conn.rdpMicrophone, rdpLocation: !!conn.rdpLocation, rdpStorage: !!conn.rdpStorage, rdpCamera: !!conn.rdpCamera });
});


/* RDP TLS certificate probe — connects to the target RDP port via TLS,
 * grabs the server certificate details, and returns them so the frontend
 * can show a Windows-style "unable to verify certificate" dialog. */
app.post('/api/rdp/telemetry', requireUser, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const safe = {
        connectionId: String(body.connectionId || '').slice(0, 128),
        kind: String(body.kind || 'snapshot').slice(0, 64),
        stage: String(body.stage || '').slice(0, 128),
        value: String(body.value || '').slice(0, 1000),
        failureReported: Boolean(body.failureReported),
        elapsedMs: Math.max(0, Number(body.elapsedMs) || 0),
        semanticEvents: Math.max(0, Number(body.semanticEvents) || 0),
        bitmapEvents: Math.max(0, Number(body.bitmapEvents) || 0),
        classicBitmaps: Math.max(0, Number(body.classicBitmaps) || 0),
        avc420Events: Math.max(0, Number(body.avc420Events) || 0),
        avc444Events: Math.max(0, Number(body.avc444Events) || 0),
        presentedFrames: Math.max(0, Number(body.presentedFrames) || 0),
        presents: Math.max(0, Number(body.presents) || 0),
        drawFails: Math.max(0, Number(body.drawFails) || 0),
        lastKind: Number(body.lastKind) || 0,
        lastError: String(body.lastError || '').slice(0, 1000),
        bootStage: String(body.bootStage || '').slice(0, 128),
        glRenderer: String(body.glRenderer || '').slice(0, 256),
        decoderBacklog: Math.max(0, Number(body.decoderBacklog) || 0),
        protocol: body.protocol && typeof body.protocol === 'object'
            ? Object.fromEntries(Object.entries(body.protocol).slice(0, 100).map(([k, v]) => [String(k).slice(0, 160), Number(v) || 0]))
            : {},
    };
    console.info('[rdp-telemetry]', safe);
    res.json({ ok: true });
});

app.post('/api/rdp/probe-cert', requireUser, async (req, res) => {
    const connectionId = String(req.body?.connectionId || '').trim();
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    const store = readJSON(CONNECTIONS_FILE, { connections: [] });
    const conn = (store.connections || []).find((c) => c.id === connectionId);
    if (!conn) return res.status(404).json({ error: '连接不存在' });
    if (String(conn.protocol || 'SSH').toUpperCase() !== 'RDP') return res.status(400).json({ error: '非 RDP 连接' });
    const targetPort = Number(conn.port) || 3389;
    let routedForward = null;
    try {
        routedForward = await createRoutedTcpForward(conn, targetPort, 10000);
        const effectiveHost = routedForward?.host || conn.host;
        const effectivePort = routedForward?.port || targetPort;
        const tls = require('tls');
        const certInfo = await new Promise((resolve) => {
            const tcpSocket = net.connect({ host: effectiveHost, port: effectivePort });
            tcpSocket.setTimeout(8000);
            const fail = (error) => {
                tcpSocket.destroy();
                resolve({ hasCert: false, host: conn.host, port: targetPort, error: error?.message || String(error) });
            };
            tcpSocket.once('error', fail);
            tcpSocket.once('timeout', () => fail(new Error('timeout')));
            tcpSocket.once('connect', async () => {
                tcpSocket.removeListener('error', fail);
                try {
                    await negotiateRdpTls(tcpSocket, { timeoutMs: 8000 });
                    const socket = tls.connect({ socket: tcpSocket, servername: net.isIP(conn.host) ? undefined : conn.host, rejectUnauthorized: false });
                    socket.setTimeout(8000);
                    socket.once('secureConnect', () => {
                        const cert = socket.getPeerCertificate();
                        const authorized = socket.authorized;
                        const authError = socket.authorizationError || '';
                        socket.destroy();
                        if (!cert || !cert.subject) { resolve({ hasCert: false, host: conn.host, port: targetPort }); return; }
                        const reasons = [];
                        if (!authorized) {
                            if (/SELF_SIGNED|DEPTH_ZERO/i.test(authError)) reasons.push('不是来自受信任的认证机构');
                            else if (/ERR_TLS_CERT_ALTNAME_INVALID|Hostname|hostname/i.test(authError)) reasons.push('电脑名称不匹配');
                            else if (/EXPIRED|CERT_HAS_EXPIRED/i.test(authError)) reasons.push('证书已过期');
                            else if (authError) reasons.push(authError);
                            if (!reasons.length) reasons.push('不是来自受信任的认证机构');
                        }
                        resolve({ hasCert: true, host: conn.host, port: targetPort, subject: cert.subject?.CN || cert.subject?.O || '', issuer: cert.issuer?.CN || cert.issuer?.O || '', validFrom: cert.valid_from || '', validTo: cert.valid_to || '', fingerprint: cert.fingerprint || '', authorized, reasons });
                    });
                    socket.once('error', (error) => { socket.destroy(); resolve({ hasCert: false, host: conn.host, port: targetPort, error: error.message }); });
                    socket.once('timeout', () => { socket.destroy(); resolve({ hasCert: false, host: conn.host, port: targetPort, error: 'timeout' }); });
                } catch (error) {
                    fail(error);
                }
            });
        });
        res.json(certInfo);
    } catch (err) {
        res.json({ hasCert: false, host: conn.host, port: targetPort, error: err.message });
    } finally {
        try { routedForward?.close?.(); } catch {}
    }
});

app.get('/api/settings/public', requireUser, (req, res) => res.json(publicAppearanceSettings()));
app.get('/api/settings/admin', requireSuperAdmin, (req, res) => res.json(safeSettings(storage.getSettings())));

app.get('/api/settings', requireUser, (req, res) => {
    if (req.user.role === 'admin' && req.user.isSuperAdmin) return res.json(safeSettings(storage.getSettings()));
    return res.json(publicAppearanceSettings());
});

app.put('/api/settings', requireSuperAdmin, (req, res) => {
    const body = normalizeSettingsInput(req.body || {});
    if (body.security?.ipWhitelistEnabled && !ipAllowed(clientIp(req), body.security.ipWhitelist)) return res.status(400).json({ error: '当前 IP 不在白名单内，已阻止启用以避免误锁' });
    const settings = storage.updateSettings(body);
    addActivity('更新系统设置', req.user.userId);
    res.json(safeSettings(settings));
});

app.put('/api/settings/appearance', requireAdmin, (req, res) => updateSettingsSection(req, res, 'appearance'));
app.put('/api/settings/notes', requireAdmin, (req, res) => updateSettingsSection(req, res, 'notes'));
app.put('/api/settings/beian', requireAdmin, (req, res) => updateSettingsSection(req, res, 'beian'));
app.put('/api/settings/security', requireSuperAdmin, (req, res) => updateSettingsSection(req, res, 'security'));
app.put('/api/settings/mail', requireSuperAdmin, (req, res) => updateSettingsSection(req, res, 'mail'));
app.put('/api/settings/captcha', requireSuperAdmin, (req, res) => updateSettingsSection(req, res, 'captcha'));
app.put('/api/settings/ai', requireSuperAdmin, (req, res) => updateSettingsSection(req, res, 'ai'));

app.post('/api/settings/test-mail', requireSuperAdmin, async (req, res) => {
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

app.post('/api/settings/mail/open', requireSuperAdmin, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const mail = storage.getSettings().mail || {};
        console.info('[MAIL] 读取已保存 SMTP 密码:', { ...publicMailDebug(mail), authMethod: auth.method });
        res.json({ pass: mail.pass || '', hasPass: !!mail.pass });
    } catch (err) {
        res.status(403).json({ error: err.message || '验证失败' });
    }
});

app.post('/api/settings/captcha/open', requireSuperAdmin, (req, res) => {
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

app.get('/api/security/ip-bans', requireSuperAdmin, (req, res) => res.json({ bans: storage.listIpBans() }));
app.delete('/api/security/ip-bans/:ip', requireSuperAdmin, (req, res) => { storage.clearIpBan(req.params.ip); res.json({ ok: true }); });
app.get('/api/security/login-events', requireSuperAdmin, (req, res) => res.json({ events: storage.listLoginEvents(100) }));
app.get('/api/security/login-events/mine', requireUser, (req, res) => res.json({ events: storage.listLoginEvents(100, req.user.username) }));
app.delete('/api/security/login-events', requireSuperAdmin, (req, res) => { storage.clearLoginEvents(); addActivity('清理登录事件日志', req.user.userId); res.json({ ok: true }); });
app.delete('/api/activities', requireSuperAdmin, (req, res) => { storage.clearActivities(); res.json({ ok: true }); });

/* Platform tool host for zephyr-ai (Go). Must stay on control plane.
 * deps must match registerAiRoutes so executeAiToolForHost can run the full tool surface. */
const aiHostDeps = {
    storage,
    authz,
    resourceService,
    resources: resourceService,
    aiPolicyService,
    aiProviderService,
    userSettingsService,
    notesService,
    terminalSessions: sshTerminalSessions,
    terminalHistory,
    terminalSessionTools,
    fileAgentManager,
    readJSON,
    writeJSON,
    DATA_DIR,
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
                    : protocol === 'TELNET'
                        ? testTelnetConnection(conn, timeoutMs)
                        : { ok: false, code: 'unsupported_protocol', message: `不支持的协议：${protocol}`, durationMs: 0 };
    },
    addActivity,
    verifySensitiveAccess,
    upload,
    handleServiceError,
};
registerAiHostRoutes(aiHostApp, aiHostDeps);

/* Go AI runtime control API (sessions/runs). Legacy /api/ai/chat remains. */
function handleAiRuntimeError(res, err) {
    const status = err?.status || 500;
    return res.status(status).json({ error: err.message || 'AI runtime error', code: err.code || 'ai_runtime_error' });
}

app.get('/api/ai/runtime/status', requireUser, (req, res) => {
    res.json({
        enabled: !!aiRuntimeBridge.enabled,
        url: process.env.ZEPHYR_AI_URL ? '[set]' : '',
        legacyChat: true,
    });
});

app.post('/api/ai/runtime/sessions', requireUser, async (req, res) => {
    try {
        if (!aiRuntimeBridge.enabled) throw Object.assign(new Error('Go AI 运行时未启用'), { status: 503, code: 'ai_runtime_unavailable' });
        const data = await aiRuntimeBridge.createSession(req.user, { title: req.body?.title, metadata: req.body?.metadata });
        res.json(data);
    } catch (err) { handleAiRuntimeError(res, err); }
});

app.get('/api/ai/runtime/sessions', requireUser, async (req, res) => {
    try {
        if (!aiRuntimeBridge.enabled) return res.json({ ok: true, sessions: [], enabled: false });
        const data = await aiRuntimeBridge.listSessions(req.user);
        res.json({ ...data, enabled: true });
    } catch (err) { handleAiRuntimeError(res, err); }
});

app.get('/api/ai/runtime/sessions/:id/messages', requireUser, async (req, res) => {
    try {
        const data = await aiRuntimeBridge.listMessages(req.user, req.params.id);
        res.json(data);
    } catch (err) { handleAiRuntimeError(res, err); }
});

app.post('/api/ai/runtime/runs', requireUser, async (req, res) => {
    try {
        if (!aiRuntimeBridge.enabled) throw Object.assign(new Error('Go AI 运行时未启用'), { status: 503, code: 'ai_runtime_unavailable' });
        const ai = storage.getSettings().ai || {};
        if (!ai.enabled) return res.status(403).json({ error: 'AI 助理未启用', code: 'ai_disabled' });
        if (aiPolicyService) {
            const policy = aiPolicyService.policyFor(req.user);
            if (policy.mode === 'disabled') return res.status(403).json({ error: 'AI 助理未启用', code: 'ai_disabled' });
        }
        let provider;
        let model = req.body?.model || '';
        if (aiProviderService) {
            const resolved = aiProviderService.resolveForUse(req.user, req.body?.providerId || null, model || null);
            provider = resolved.provider;
            model = resolved.model;
        } else {
            throw Object.assign(new Error('AI Provider 服务不可用'), { status: 503 });
        }
        if (!model) throw Object.assign(new Error('未配置默认模型'), { status: 400 });

        // Provider payload for Go — includes secret; never returned to browser.
        const providerPayload = {
            id: provider.id,
            name: provider.name,
            kind: provider.type || 'openai-compatible',
            baseUrl: provider.baseUrl || '',
            apiKey: provider.apiKey || '',
            defaultModel: provider.defaultModel || model,
            models: provider.models || [],
            apiMode: provider.config?.apiMode || provider.apiMode || 'auto',
            organization: provider.config?.organization || provider.organization || '',
            options: provider.config?.options || provider.options || {},
            timeoutMs: Number(provider.config?.timeoutMs || 120000),
            retries: Number(provider.config?.retries || 1),
        };

        const contextObj = req.body?.context || {};
        if (contextObj?.activeSurface?.kind === 'remote-desktop' && providerPayload.options?.vision === false) {
            return res.status(400).json({ error: '当前模型供应商未启用图片输入，无法读取 RDP/VNC 画面', code: 'vision_required' });
        }
        const contextText = typeof req.body?.contextText === 'string' && req.body.contextText
            ? req.body.contextText
            : formatAiContextForPrompt(contextObj);
        // Memory selection: preserve legacy ranking — do not drop for tokens.
        const memories = Array.isArray(req.body?.memories) && req.body.memories.length
            ? req.body.memories
            : selectPromptMemories(ai, contextObj, Number(ai.context?.memoryItems) || 28);
        const systemCompose = aiRuntimeBridge.buildSystemCompose(ai, contextText, memories, contextObj.locale || 'zh-CN');
        const intentHint = buildIntentRoutingHint(req.body?.message || '');
        if (intentHint) systemCompose.prompt = `${systemCompose.prompt}\n\n${intentHint}`;

        const bodyPerm = req.body?.permission && typeof req.body.permission === 'object' ? req.body.permission : {};
        const aiPerm = ai.permissions || {};
        const perm = {
            mode: bodyPerm.mode || req.body?.permissionMode || aiPerm.mode || (ai.sensitive?.autoConfirm ? 'auto' : 'ask'),
            deny: Array.isArray(bodyPerm.deny) ? bodyPerm.deny : (Array.isArray(req.body?.deny) ? req.body.deny : (aiPerm.deny || [])),
            allow: Array.isArray(bodyPerm.allow) ? bodyPerm.allow : (Array.isArray(req.body?.allow) ? req.body.allow : (aiPerm.allow || [])),
            ask: Array.isArray(bodyPerm.ask) ? bodyPerm.ask : (Array.isArray(req.body?.ask) ? req.body.ask : (aiPerm.ask || [])),
        };

        let sessionId = String(req.body?.sessionId || '').trim();
        if (!sessionId) {
            const created = await aiRuntimeBridge.createSession(req.user, {
                title: String(req.body?.title || '').slice(0, 80) || '新对话',
                metadata: { source: 'runtime' },
            });
            sessionId = created.session?.id || created.sessionId;
        }

        const policy = aiPolicyService ? aiPolicyService.policyFor(req.user) : {};
        const data = await aiRuntimeBridge.startRun(req.user, {
            sessionId,
            provider: providerPayload,
            model,
            message: req.body?.message || '',
            messages: req.body?.messages,
            options: req.body?.options || {},
            maxSteps: req.body?.maxSteps || ai.context?.maxToolRounds || 0,
            permission: perm,
            autoConfirm: !!ai.sensitive?.autoConfirm && req.body?.autoConfirm !== false,
            autoConfirmDelayMs: Number(req.body?.autoConfirmDelayMs ?? ai.sensitive?.autoConfirmDelayMs ?? 2500),
            mode: req.body?.mode || 'standard',
            systemCompose,
            context: req.body?.context || null,
            mcpServers: (Array.isArray(req.body?.mcpServers) ? req.body.mcpServers : (ai.mcpServers || []))
                .filter((s) => s && s.enabled !== false)
                .map((s) => ({
                    name: s.name,
                    type: s.type || 'stdio',
                    command: s.command,
                    args: s.args,
                    env: s.env,
                    url: s.url,
                    headers: s.headers,
                    callTimeoutSeconds: s.callTimeoutSeconds,
                    trustedReadOnlyTools: s.trustedReadOnlyTools,
                })),
            hourlyLimit: policy.quota?.hourlyRequests || 0,
            dailyLimit: policy.quota?.dailyRequests || 0,
            contextWindowTokens: Number(provider.options?.context?.windowTokens || provider.config?.context?.windowTokens || ai.context?.windowTokens || 0),
            outputReserveTokens: Number(req.body?.options?.max_tokens || req.body?.options?.maxTokens || 0),
        });
        // Rewrite SSE path through Node proxy if public AI URL not set
        const ssePath = data.ssePath || `/api/ai/runtime/runs/${data.runId}/events?ticket=${encodeURIComponent(data.ticket || '')}`;
        res.json({
            ok: true,
            runId: data.runId,
            sessionId: data.sessionId || sessionId,
            ticket: data.ticket,
            ssePath: ssePath.startsWith('http') ? ssePath : ssePath,
            sseProxyPath: `/api/ai/runtime/runs/${encodeURIComponent(data.runId)}/events?ticket=${encodeURIComponent(data.ticket || '')}`,
        });
    } catch (err) { handleAiRuntimeError(res, err); }
});

app.post('/api/ai/runtime/runs/:id/abort', requireUser, async (req, res) => {
    try {
        const data = await aiRuntimeBridge.abortRun(req.params.id);
        res.json(data);
    } catch (err) { handleAiRuntimeError(res, err); }
});

app.post('/api/ai/runtime/runs/:id/permission', requireUser, async (req, res) => {
    try {
        // Re-inject provider secret for mid-run resume (never stored in Go resume_json).
        let providerPayload;
        if (aiProviderService && (req.body?.providerId || req.body?.model)) {
            try {
                const resolved = aiProviderService.resolveForUse(req.user, req.body?.providerId || null, req.body?.model || null);
                const provider = resolved.provider;
                providerPayload = {
                    id: provider.id,
                    name: provider.name,
                    kind: provider.type || 'openai-compatible',
                    baseUrl: provider.baseUrl || '',
                    apiKey: provider.apiKey || '',
                    defaultModel: provider.defaultModel || resolved.model,
                    apiMode: provider.config?.apiMode || provider.apiMode || 'auto',
                    organization: provider.config?.organization || '',
                    options: provider.config?.options || provider.options || {},
                };
            } catch (_) { /* resume state may still have enough non-secret fields */ }
        }
        const data = await aiRuntimeBridge.decidePermission(req.params.id, {
            userId: req.user.userId,
            sessionId: req.body?.sessionId || '',
            callId: req.body?.callId || '',
            tool: req.body?.tool || '',
            approve: !!req.body?.approve,
            scope: req.body?.scope || 'once',
            provider: providerPayload,
        });
        res.json(data);
    } catch (err) { handleAiRuntimeError(res, err); }
});

app.post('/api/ai/runtime/runs/:id/capture-image', requireUser, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '8mb' }), async (req, res) => {
    try {
        const callId = String(req.query?.callId || '').trim();
        if (!callId || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'callId and image body required' });
        const result = await aiRuntimeBridge.uploadCaptureImage(req.user, req.params.id, callId, req.body, req.headers['content-type']);
        res.json(result);
    } catch (err) {
        handleAiRuntimeError(res, err);
    }
});

app.post('/api/ai/runtime/runs/:id/capture', requireUser, async (req, res) => {
    try {
        let providerPayload;
        if (aiProviderService && req.body?.providerId) {
            try {
                const resolved = aiProviderService.resolveForUse(req.user, req.body.providerId, req.body?.model || null);
                const provider = resolved.provider;
                providerPayload = {
                    id: provider.id,
                    name: provider.name,
                    kind: provider.type || 'openai-compatible',
                    baseUrl: provider.baseUrl || '',
                    apiKey: provider.apiKey || '',
                    defaultModel: provider.defaultModel || resolved.model,
                    apiMode: provider.config?.apiMode || 'auto',
                    options: provider.config?.options || {},
                };
            } catch (_) {}
        }
        const data = await aiRuntimeBridge.submitCapture(req.params.id, {
            userId: req.user.userId,
            callId: req.body?.callId || '',
            result: req.body?.result ?? req.body?.capture ?? {},
            provider: providerPayload,
        });
        res.json(data);
    } catch (err) { handleAiRuntimeError(res, err); }
});

/** SSE proxy: browser → Node (cookie auth) → Go (ticket). */
app.get('/api/ai/runtime/runs/:id/events', requireUser, async (req, res) => {
    if (!aiRuntimeBridge.enabled) return res.status(503).json({ error: 'AI runtime unavailable' });
    const runId = req.params.id;
    const ticket = String(req.query.ticket || '');
    const url = `${process.env.ZEPHYR_AI_URL}/v1/runs/${encodeURIComponent(runId)}/events?ticket=${encodeURIComponent(ticket)}`;
    try {
        const upstream = await fetch(url, { headers: { accept: 'text/event-stream' } });
        if (!upstream.ok) {
            const text = await upstream.text().catch(() => '');
            return res.status(upstream.status).json({ error: text || upstream.statusText });
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        const reader = upstream.body?.getReader?.();
        if (!reader) {
            // Node fetch body as web stream may differ; fallback arrayBuffer stream
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.write(buf);
            return res.end();
        }
        const dec = new TextDecoder();
        req.on('close', () => { try { reader.cancel(); } catch {} });
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(typeof value === 'string' ? value : dec.decode(value, { stream: true }));
        }
        res.end();
    } catch (err) {
        if (!res.headersSent) res.status(502).json({ error: err.message || 'SSE proxy failed' });
        else try { res.end(); } catch {}
    }
});

registerAiRoutes(app, {
    requireUser,
    storage,
    authz,
    resourceService,
    aiPolicyService,
    aiProviderService,
    userSettingsService,
    notesService,
    terminalSessions: sshTerminalSessions,
    terminalHistory,
    terminalSessionTools,
    fileAgentManager,
    readJSON,
    writeJSON,
    DATA_DIR,
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
                    : protocol === 'TELNET'
                        ? testTelnetConnection(conn, timeoutMs)
                        : { ok: false, code: 'unsupported_protocol', message: `不支持的协议：${protocol}`, durationMs: 0 };
    },
    addActivity,
    verifySensitiveAccess,
    upload,
    handleServiceError,
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

app.get('/api/passkeys', requireUser, (req, res) => res.json({ passkeys: storage.listPasskeys(req.user.username).map((p) => ({ id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) }));
app.post('/api/passkeys/register/options', requireUser, async (req, res) => {
    const origin = publicOrigin(req), rpID = rpIdFromOrigin(origin), user = storage.getUser(req.session.username);
    const options = await generateRegistrationOptions({ rpName: 'Zephyr', rpID, userID: Buffer.from(user.username), userName: user.username, attestationType: 'none', excludeCredentials: storage.listPasskeys(user.username).map((p) => ({ id: p.credentialId, transports: p.transports })) });
    webauthnChallenges.set(`reg:${user.username}`, { challenge: options.challenge, origin, rpID }); res.json(options);
});
app.post('/api/passkeys/register/verify', requireUser, async (req, res) => {
    const state = webauthnChallenges.get(`reg:${req.session.username}`); if (!state) return res.status(400).json({ error: '注册会话已过期' });
    try {
        const result = await verifyRegistrationResponse({ response: req.body, expectedChallenge: state.challenge, expectedOrigin: state.origin, expectedRPID: state.rpID });
        if (!result.verified) return res.status(400).json({ error: 'Passkey 验证失败' });
        const info = result.registrationInfo;
        storage.savePasskey({ id: crypto.randomUUID(), username: req.session.username, credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString('base64'), counter: info.credential.counter || 0, transports: req.body?.response?.transports || [], createdAt: Date.now(), lastUsedAt: null });
        webauthnChallenges.delete(`reg:${req.session.username}`); addActivity('绑定 Passkey'); res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message || 'Passkey 注册失败' }); }
});
app.delete('/api/passkeys/:id', requireUser, (req, res) => { storage.deletePasskey(req.user.username, req.params.id); addActivity('删除 Passkey', req.user.userId); res.json({ ok: true }); });
app.post('/api/passkeys/login/options', async (req, res) => {
    const guard = checkLoginGuards(req);
    if (!guard.ok) return res.status(403).json({ error: guard.reason });
    const origin = publicOrigin(req);
    const rpID = rpIdFromOrigin(origin);
    const requestedUsername = String(req.body?.username || '').trim();
    /* Prefer explicit username; otherwise fall back to every active user's
     * passkeys so multi-user installs are not stuck on getFirstUser(). */
    let passkeys = [];
    if (requestedUsername) {
        const user = storage.getUser(requestedUsername);
        if (!user || user.status !== 'active') return res.status(400).json({ error: '当前账号尚未绑定 Passkey' });
        if (isAccountLocked(user)) return res.status(429).json({ error: '登录失败次数过多，账号已临时锁定，请稍后再试', code: 'account_locked' });
        passkeys = storage.listPasskeys(user.username);
    } else {
        for (const u of storage.listUsers()) {
            if (u.status !== 'active' || isAccountLocked(u)) continue;
            passkeys.push(...storage.listPasskeys(u.username));
        }
    }
    if (!passkeys.length) return res.status(400).json({ error: '当前账号尚未绑定 Passkey' });
    pruneWebauthnLoginChallenges();
    const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })),
    });
    const challengeKey = `login:${options.challenge}`;
    webauthnChallenges.set(challengeKey, {
        challenge: options.challenge,
        origin,
        rpID,
        createdAt: Date.now(),
        username: requestedUsername || '',
    });
    res.json(options);
});
app.post('/api/passkeys/login/verify', async (req, res) => {
    const guard = checkLoginGuards(req);
    const ua = req.headers['user-agent'] || '';
    if (!guard.ok) return res.status(403).json({ error: guard.reason });
    const credId = req.body?.id;
    const passkey = storage.getPasskeyByCredentialId(credId);
    if (!passkey) {
        recordLoginFailure(guard.ip);
        return res.status(400).json({ error: 'Passkey 不存在' });
    }
    pruneWebauthnLoginChallenges();
    const challenge = webauthnChallengeFromBody(req.body) || String(req.body?.challenge || '');
    const challengeKey = challenge ? `login:${challenge}` : '';
    const state = challengeKey ? webauthnChallenges.get(challengeKey) : null;
    if (!state) return res.status(400).json({ error: 'Passkey 登录会话已过期' });
    if (Date.now() - Number(state.createdAt || 0) > WEBAUTHN_LOGIN_CHALLENGE_TTL_MS) {
        webauthnChallenges.delete(challengeKey);
        return res.status(400).json({ error: 'Passkey 登录会话已过期' });
    }
    const user = storage.getUser(passkey.username);
    if (!user || user.status === 'deleted') {
        webauthnChallenges.delete(challengeKey);
        recordLoginFailure(guard.ip);
        return res.status(401).json({ error: '账号或密码错误' });
    }
    if (user.status === 'suspended') {
        webauthnChallenges.delete(challengeKey);
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        return authError(res, 403, 'account_suspended', '账号已被停用，请联系管理员', false);
    }
    if (isAccountLocked(user)) {
        webauthnChallenges.delete(challengeKey);
        recordLoginFailure(guard.ip);
        return res.status(429).json({ error: '登录失败次数过多，账号已临时锁定，请稍后再试', code: 'account_locked' });
    }
    if (!defaultPasswordRemoteLoginAllowed(req, user)) {
        webauthnChallenges.delete(challengeKey);
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: false, reason: '默认密码禁止公网登录' });
        return res.status(403).json({ error: '默认密码只允许从本机或内网登录，请先在安全环境修改默认密码' });
    }
    const origin = publicOrigin(req);
    const rpID = rpIdFromOrigin(origin);
    try {
        const result = await verifyAuthenticationResponse({
            response: req.body,
            expectedChallenge: state.challenge,
            expectedOrigin: state.origin || origin,
            expectedRPID: state.rpID || rpID,
            credential: {
                id: passkey.credentialId,
                publicKey: Buffer.from(passkey.publicKey, 'base64'),
                counter: passkey.counter || 0,
                transports: passkey.transports,
            },
        });
        if (!result.verified) {
            recordLoginFailure(guard.ip);
            recordAccountLoginFailure(user);
            await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: false, reason: 'Passkey 验证失败' });
            return res.status(400).json({ error: 'Passkey 登录失败' });
        }
        webauthnChallenges.delete(challengeKey);
        storage.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter);
        clearAccountLoginFailure(user);
        recordLoginSuccess(guard.ip);
        createSession(req, res, user);
        try { storage.rawDb().prepare('UPDATE users SET lastLoginAt = ? WHERE userId = ?').run(Date.now(), user.userId); } catch {}
        addActivity(`Passkey 登录：${user.username}`, user.userId);
        await notifyLogin({ username: user.username, ip: guard.ip, userAgent: ua, success: true, reason: 'passkey' });
        res.json({ ok: true, mustChangePassword: !!user.defaultPassword });
    } catch (err) {
        recordLoginFailure(guard.ip);
        recordAccountLoginFailure(user);
        res.status(400).json({ error: err.message || 'Passkey 登录失败' });
    }
});

app.get('/api/data/export', requireSuperAdmin, async (req, res) => {
    try { storage.rawDb().pragma('wal_checkpoint(FULL)'); } catch (err) { console.error('[DB] WAL checkpoint failed:', err.message); }
    const files = { 'zephyr.db': fs.readFileSync(path.join(DATA_DIR, 'zephyr.db')), 'manifest.json': JSON.stringify({ app: 'Zephyr', version: APP_VERSION, exportedAt: Date.now(), dataEncryption: secretCrypto.ALG }, null, 2) };
    const keyBackup = secretCrypto.getKeyBackupFile();
    if (keyBackup) files[keyBackup.archivePath] = fs.readFileSync(keyBackup.filePath);
    const encrypted = encryptBuffer(await zipBuffer(files), process.env.ENCRYPTION_KEY);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="zephyr-backup-${stamp}.zip.enc"`); res.end(encrypted);
});
app.post('/api/data/import', requireSuperAdmin, upload.single('backup'), async (req, res) => {
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

app.post('/api/connections/test', requireUser, async (req, res) => {
    const body = req.body || {};
    let conn = null;
    if (body.connectionId) {
        /* Testing a saved connection requires `use`; unsaved ad-hoc tests use
         * the caller-provided credentials only. */
        try {
            conn = { ...resourceService.resolveForConnect(req.user, String(body.connectionId)) };
        } catch (err) {
            return handleServiceError(res, err, 403);
        }
        ['name', 'host', 'username', 'remark'].forEach((key) => { if (body[key] !== undefined) conn[key] = String(body[key]); });
        if (body.port !== undefined) conn.port = Number(body.port) || 22;
        if (body.protocol !== undefined) conn.protocol = String(body.protocol).toUpperCase();
        if (body.sshKeyId !== undefined) conn.sshKeyId = String(body.sshKeyId || '');
        if (body.password !== undefined && body.password !== '******') conn.password = String(body.password || '');
        if (body.privateKey !== undefined && body.privateKey !== '******') conn.privateKey = String(body.privateKey || '');
        applyConnectionRouteFields(conn, body);
    } else {
        conn = { ...body, port: Number(body.port) || protocolDefaultPort(body.protocol) };
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
                : protocol === 'TELNET'
                    ? await testTelnetConnection(conn, timeoutMs)
                    : { ok: false, code: 'unsupported_protocol', message: `不支持的协议：${protocol}`, durationMs: 0 };
    addActivity(`测试连接：${conn.name || conn.host} - ${result.message}`, req.user.userId);
    res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/remote-execute', requireUser, async (req, res) => {
    const { connectionIds, command, timeoutSeconds } = req.body || {};
    if (!Array.isArray(connectionIds) || !connectionIds.length) return res.status(400).json({ error: '请选择服务器' });
    if (!String(command || '').trim()) return res.status(400).json({ error: '请输入命令' });
    /* Batch remote execution requires the `execute` capability per target
     * (§12.3) — use/control alone never authorizes command execution. */
    const targets = [];
    for (const id of connectionIds.map(String)) {
        const conn = storage.getConnectionById(id);
        if (!conn) continue;
        try {
            authz.assertCan(req.user, CAP.EXECUTE, 'connection', conn.id, conn, { resourceExists: true });
            if (conn.protocol === 'SSH') targets.push(resourceService.resolveForConnect(req.user, conn.id));
        } catch (err) {
            targets.push({ __denied: true, connectionId: conn.id, name: conn.name, host: conn.host, error: err.message });
        }
    }
    const started = Date.now();
    const results = await Promise.all(targets.map((conn) => {
        if (conn.__denied) return Promise.resolve({ connectionId: conn.connectionId, name: conn.name, host: conn.host, success: false, error: conn.error, denied: true });
        return runRemoteCommand(conn, String(command), timeoutSeconds);
    }));
    authz.audit({ actorUserId: req.user.userId, action: 'resource.remote_execute', outcome: 'success', metadata: { targets: targets.length, command: String(command).slice(0, 120) } });
    addActivity(`远程执行：${targets.length} 台服务器，命令 ${String(command).slice(0, 40)}`, req.user.userId);
    res.json({ startedAt: started, durationMs: Date.now() - started, results });
});

app.get('/api/proxies', requireUser, (req, res) => res.json({ proxies: resourceService.listOwned(req.user, 'proxy') }));
app.post('/api/proxies', requireUser, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.host || !b.port) return res.status(400).json({ error: '名称、IP、端口不能为空' });
    const proxy = resourceService.createOwned(req.user, 'proxy', { id: crypto.randomUUID(), name: String(b.name), host: String(b.host), port: Number(b.port) || 1080, type: normalizeProxyType(b.type), username: String(b.username || ''), password: String(b.password || ''), createdAt: Date.now(), updatedAt: Date.now() });
    addActivity(`新增代理：${proxy.name}`, req.user.userId);
    res.json({ proxy });
});
app.put('/api/proxies/:id', requireUser, (req, res) => {
    try {
        const old = resourceService.getRawAuthorized(req.user, 'proxy', req.params.id, CAP.EDIT);
        const b = req.body || {};
        const proxy = resourceService.updateOwned(req.user, 'proxy', req.params.id, { name: String(b.name ?? old.name), host: String(b.host ?? old.host), port: Number(b.port ?? old.port) || 1080, type: normalizeProxyType(b.type ?? old.type), username: String(b.username ?? old.username ?? ''), password: b.password === '******' ? old.password : String(b.password ?? old.password ?? ''), updatedAt: Date.now() });
        addActivity(`编辑代理：${proxy.name}`, req.user.userId);
        res.json({ proxy });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});
app.post('/api/proxies/:id/open', requireUser, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const proxy = resourceService.getRawAuthorized(req.user, 'proxy', req.params.id, CAP.REVEAL_SECRET);
        authz.audit({ actorUserId: req.user.userId, resourceType: 'proxy', resourceId: req.params.id, action: 'resource.reveal_secret', outcome: 'success', metadata: { method: auth.method } });
        console.info('[secret-open] reveal proxy', { id: proxy.id, name: proxy.name, hasPassword: !!proxy.password, authMethod: auth.method });
        res.json({ proxy: { ...proxy, hasPassword: !!proxy.password } });
    } catch (err) {
        handleServiceError(res, err, 403);
    }
});
app.delete('/api/proxies/:id', requireUser, (req, res) => {
    try {
        resourceService.deleteOwned(req.user, 'proxy', req.params.id);
        addActivity('删除代理', req.user.userId);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

app.get('/api/ssh-keys', requireUser, (req, res) => res.json({ sshKeys: resourceService.listOwned(req.user, 'sshKey') }));
app.post('/api/ssh-keys', requireUser, (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: '密钥名称不能为空' });
    if (!String(b.privateKey || '').includes('-----BEGIN')) return res.status(400).json({ error: '请填写有效的 SSH 私钥' });
    const sshKey = resourceService.createOwned(req.user, 'sshKey', { id: crypto.randomUUID(), name: String(b.name).trim(), privateKey: String(b.privateKey), passphrase: String(b.passphrase || ''), remark: String(b.remark || ''), createdAt: Date.now(), updatedAt: Date.now() });
    addActivity(`新增 SSH 密钥：${sshKey.name}`, req.user.userId);
    res.json({ sshKey });
});
app.put('/api/ssh-keys/:id', requireUser, (req, res) => {
    try {
        const old = resourceService.getRawAuthorized(req.user, 'sshKey', req.params.id, CAP.EDIT);
        const b = req.body || {};
        const privateKey = b.privateKey === '******' || b.privateKey === undefined ? old.privateKey : String(b.privateKey || '');
        const passphrase = b.passphrase === '******' || b.passphrase === undefined ? old.passphrase : String(b.passphrase || '');
        if (!String((b.name ?? old.name) || '').trim()) return res.status(400).json({ error: '密钥名称不能为空' });
        if (!privateKey.includes('-----BEGIN')) return res.status(400).json({ error: '请填写有效的 SSH 私钥' });
        const sshKey = resourceService.updateOwned(req.user, 'sshKey', req.params.id, { name: String(b.name ?? old.name).trim(), privateKey, passphrase, remark: String(b.remark ?? old.remark ?? ''), updatedAt: Date.now() });
        addActivity(`编辑 SSH 密钥：${sshKey.name}`, req.user.userId);
        res.json({ sshKey });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});
app.post('/api/ssh-keys/:id/open', requireUser, (req, res) => {
    try {
        const auth = verifySensitiveAccess(req, req.body?.secret);
        const key = resourceService.getRawAuthorized(req.user, 'sshKey', req.params.id, CAP.REVEAL_SECRET);
        authz.audit({ actorUserId: req.user.userId, resourceType: 'sshKey', resourceId: req.params.id, action: 'resource.reveal_secret', outcome: 'success', metadata: { method: auth.method } });
        console.info('[secret-open] reveal ssh key', { id: key.id, name: key.name, authMethod: auth.method });
        res.json({ sshKey: { ...key, hasPrivateKey: !!key.privateKey, hasPassphrase: !!key.passphrase } });
    } catch (err) {
        handleServiceError(res, err, 403);
    }
});
app.delete('/api/ssh-keys/:id', requireUser, (req, res) => {
    try {
        resourceService.deleteOwned(req.user, 'sshKey', req.params.id);
        addActivity('删除 SSH 密钥', req.user.userId);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

function ensureSshJumpConnection(connectionId, user) {
    const conn = storage.getConnectionById(String(connectionId || ''));
    if (!conn) throw new Error('跳板机连接不存在或已删除');
    if (String(conn.protocol || 'SSH').toUpperCase() !== 'SSH') throw new Error('跳板机只能选择 SSH 连接，VNC/RDP/TELNET 只能作为目标通过跳板访问');
    if (user) authz.assertCan(user, CAP.USE, 'connection', conn.id, conn, { resourceExists: true });
    return conn;
}

app.get('/api/jump-hosts', requireUser, (req, res) => res.json({ jumpHosts: resourceService.listOwned(req.user, 'jumpHost') }));
app.post('/api/jump-hosts', requireUser, (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.connectionId) return res.status(400).json({ error: '名称和 SSH 连接不能为空' });
    try {
        ensureSshJumpConnection(b.connectionId, req.user);
        const jumpHost = resourceService.createOwned(req.user, 'jumpHost', { id: crypto.randomUUID(), name: String(b.name), connectionId: String(b.connectionId), createdAt: Date.now(), updatedAt: Date.now() });
        addActivity(`新增跳板机：${jumpHost.name}`, req.user.userId);
        res.json({ jumpHost });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});
app.put('/api/jump-hosts/:id', requireUser, (req, res) => {
    try {
        const old = resourceService.getRawAuthorized(req.user, 'jumpHost', req.params.id, CAP.EDIT);
        const b = req.body || {};
        const nextConnectionId = String(b.connectionId ?? old.connectionId);
        ensureSshJumpConnection(nextConnectionId, req.user);
        const jumpHost = resourceService.updateOwned(req.user, 'jumpHost', req.params.id, { name: String(b.name ?? old.name), connectionId: nextConnectionId, updatedAt: Date.now() });
        addActivity(`编辑跳板机：${jumpHost.name}`, req.user.userId);
        res.json({ jumpHost });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});
app.delete('/api/jump-hosts/:id', requireUser, (req, res) => {
    try {
        resourceService.deleteOwned(req.user, 'jumpHost', req.params.id);
        addActivity('删除跳板机', req.user.userId);
        res.json({ ok: true });
    } catch (err) {
        handleServiceError(res, err, 400);
    }
});

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
    const archiver = await loadArchiver();
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
    const isRdpSource = String(clip.sourceType || '') === 'rdp';
    const sameConnection = !isRdpSource && String(clip.sourceConnectionId || '') && String(clip.sourceConnectionId) === String(targetSession.connectionId || '');
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
        if (isRdpSource) {
            // RDP source: files are local on server, upload to SSH target
            console.info('[sftp-clipboard-paste]', 'rdp source paste', { count: clip.items.length, targetDir });
            await withRoutedSftp(targetConnectionConfig, async ({ sftp: targetSftp }) => {
                for (const item of clip.items) {
                    throwIfClipboardTransferCancelled(transfer);
                    const safeName = String(item.name || basenameRemote(item.path)).replace(/[/\\]/g, '_').slice(0, 200);
                    let targetPath = remoteJoin(targetDir, safeName);
                    if (conflictMode === 'skip') {
                        try { await sftpStat(targetSftp, targetPath); continue; } catch {}
                    } else if (conflictMode === 'compatible') {
                        targetPath = await resolveCompatibleRemotePath(targetSftp, targetPath);
                    } else if (conflictMode === 'overwrite') {
                        try { await removeRemotePath(targetConnectionConfig, targetPath); } catch {}
                    }
                    await uploadLocalPathToRemote(targetSftp, item.path, targetPath, (n) => bump(n, item.path), transfer);
                }
            }, transfer);
            loaded = Math.max(total, loaded);
            sendStatus('done', targetDir);
        } else if (sameConnection) {
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
app.get('/api/sftp/preview/:token', requireUser, async (req, res) => {
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

app.get('/api/sftp/media/stream/:token', requireUser, async (req, res) => {
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

app.get('/api/sftp/media/subtitle/:token/:index.vtt', requireUser, async (req, res) => {
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
app.post('/api/sftp/upload/:token', requireUser, async (req, res) => {
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
app.post('/api/sftp/upload/:token/complete', requireUser, async (req, res) => {
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

app.get('/api/sftp/hash/:token', requireUser, async (req, res) => {
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

app.get('/api/sftp/download-progress/:token', requireUser, (req, res) => {
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

app.post('/api/sftp/download-control/:token', requireUser, (req, res) => {
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

app.get('/api/sftp/download/:token', requireUser, async (req, res) => {
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
    // Prefer vendored fork CSS (ime-active cursor, etc.). Fall back to node_modules stock.
    const forkCss = path.join(__dirname, 'public', 'vendor', 'wterm-fork', 'terminal.css');
    const stockCss = path.join(__dirname, 'node_modules', '@wterm', 'dom', 'src', 'terminal.css');
    const file = fs.existsSync(forkCss) ? forkCss : stockCss;
    res.type('text/css').sendFile(file);
});
app.use('/vendor/@wterm', express.static(path.join(__dirname, 'node_modules', '@wterm')));
function sendNoStorePage(res, file) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(path.join(__dirname, 'public', file));
}
const MOTION_DEMO_ENABLE_FILE = '/tmp/zephyr-motion-demo.enabled';
const MOTION_DEMO_FILE = path.join(__dirname, 'internal', 'motion-feel.html');
function requireMotionDemoEnabled(req, res, next) {
    if (!fs.existsSync(MOTION_DEMO_ENABLE_FILE)) return res.status(404).type('text/plain').send('Not Found');
    next();
}
function serveMotionDemo(req, res) {
    if (!fs.existsSync(MOTION_DEMO_ENABLE_FILE)) return res.status(404).type('text/plain').send('Not Found');
    res.set({
        'Cache-Control': 'no-store, private',
        'Pragma': 'no-cache',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
    });
    return res.sendFile(MOTION_DEMO_FILE);
}
app.get('/motion-feel.html', requireMotionDemoEnabled, requireSuperAdmin, serveMotionDemo);
app.get('/motion-feel', requireMotionDemoEnabled, requireSuperAdmin, serveMotionDemo);
app.get('/app.html', requirePageAuth, (req, res) => sendNoStorePage(res, 'app.html'));
app.get('/terminal.html', requirePageAuth, (req, res) => sendNoStorePage(res, 'terminal.html'));
app.get('/rdp.html', requirePageAuth, (req, res) => sendNoStorePage(res, 'rdp.html'));
app.get('/novnc.html', requirePageAuth, (req, res) => sendNoStorePage(res, 'novnc.html'));
app.get('/player.html', requirePageAuth, (req, res) => sendNoStorePage(res, 'player.html'));
/* Deep Link landing page may be hit while logged out; the page itself
 * redirects to login and keeps the sensitive URI in sessionStorage. */
app.get('/open', (req, res) => sendNoStorePage(res, 'open.html'));
app.get('/open.html', (req, res) => sendNoStorePage(res, 'open.html'));
/* Password rollback landing page: reached from the change notification email
 * while the owner may be logged out, so it must stay public. The token in the
 * query string is the only capability; the page itself just POSTs it. */
app.get('/password-rollback', (req, res) => sendNoStorePage(res, 'password-rollback.html'));
app.get('/password-rollback.html', (req, res) => sendNoStorePage(res, 'password-rollback.html'));
app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    setHeaders: (res, filePath) => {
        if (/\.(?:js|mjs|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        if (/\.mjs$/i.test(filePath)) res.type('text/javascript; charset=utf-8');
        if (/\.wasm$/i.test(filePath)) res.type('application/wasm');
        if (/[/\\]vendor[/\\]rdp-wasm[/\\]/i.test(filePath)) {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
}));

// ═══════════════════════════════════════════════════════════════════════
// Cross-tab clipboard file transit — temporary server-side storage so
// large files can be transferred between SSH/RDP tabs without base64
// postMessage (which OOMs on >100MB). Files are streamed, not buffered.
// ═══════════════════════════════════════════════════════════════════════
const CLIPBOARD_TRANSIT_DIR = path.join(os.tmpdir(), 'zephyr-clipboard-transit');
const clipboardTransitTokens = new Map(); // token → { path, name, size, username, expiresAt }
const CLIPBOARD_TRANSIT_TTL = 5 * 60 * 1000; // 5 minutes

// Upload: RDP/SSH tab sends file to server temp storage, gets a download token.
app.post('/api/clipboard/upload', requireUser, (req, res) => {
    const name = String(req.query.name || 'file').replace(/[/\\]/g, '_').slice(0, 255);
    const token = crypto.randomUUID();
    const dir = path.join(CLIPBOARD_TRANSIT_DIR, req.session.username || 'anon');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, token + '-' + name);
    const ws = fs.createWriteStream(filePath);
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; ws.write(chunk); });
    req.on('end', () => {
        ws.end(() => {
            clipboardTransitTokens.set(token, { path: filePath, name, size, username: req.session.username, expiresAt: Date.now() + CLIPBOARD_TRANSIT_TTL });
            res.json({ token, name, size, url: `/api/clipboard/download/${token}` });
        });
    });
    req.on('error', () => { ws.destroy(); res.status(500).json({ error: 'upload failed' }); });
});

// Download: other tab fetches file by token (streamed).
app.get('/api/clipboard/download/:token', requireUser, (req, res) => {
    const token = String(req.params.token || '');
    const entry = clipboardTransitTokens.get(token);
    if (!entry || entry.username !== req.session.username || entry.expiresAt < Date.now()) {
        clipboardTransitTokens.delete(token);
        return res.status(404).send('链接已失效');
    }
    entry.expiresAt = Date.now() + CLIPBOARD_TRANSIT_TTL; // extend on access
    const stat = fs.statSync(entry.path, { throwIfNoEntry: false });
    if (!stat) { clipboardTransitTokens.delete(token); return res.status(404).send('文件已过期'); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${entry.name.replace(/"/g, '_')}"`);
    fs.createReadStream(entry.path).pipe(res);
});

// Periodic cleanup of expired transit files
setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of clipboardTransitTokens) {
        if (entry.expiresAt < now) {
            clipboardTransitTokens.delete(token);
            try { fs.unlinkSync(entry.path); } catch {}
        }
    }
}, 60000);

// 健康检查
let _h264DebugLog = null;
app.post('/api/rdp/h264-debug', requireAdmin, (req, res) => {
    _h264DebugLog = req.body;
    console.info('[h264-debug]', JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
});
app.get('/api/rdp/h264-debug', requireAdmin, (req, res) => {
    res.json(_h264DebugLog || { empty: true });
});

/* Mount file-agent REST API routes before the SPA catch-all. GET routes like
 * /api/rdp/file-agent-tokens must not be swallowed by app.get('*'). */
fileAgentManager.mountRoutes(app, requireUser, (req) => req.user, verifySensitiveAccess);

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, instanceId: INSTANCE_ID, version: APP_VERSION }));

// 兜底路由
app.get('*', (req, res) => {
    if (req.url.startsWith('/internal/')) {
        return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Endpoint not found' } });
    }
    if (req.url.startsWith('/api/')) {
        return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'API endpoint not found' } });
    }
    if (req.url.startsWith('/vendor') || req.url.startsWith('/ssh')) {
        return res.status(404).end();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const httpsOptions = ensureHttpsCertificate();
const httpsServer = httpsOptions ? https.createServer(httpsOptions, app) : null;
const wsServerOptions = {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 10 * 1024 * 1024,
};
const wss = new WebSocketServer(wsServerOptions);
const noVncWss = new WebSocketServer(wsServerOptions);
const editorLspWss = new WebSocketServer(wsServerOptions);
const rdpProxyWss = new WebSocketServer({ ...wsServerOptions, maxPayload: 64 * 1024 * 1024 });
const agentFilesWss = new WebSocketServer({ ...wsServerOptions, maxPayload: 2 * 1024 * 1024 });
const fileTransferWss = new WebSocketServer({ ...wsServerOptions, maxPayload: 2 * 1024 * 1024 });

function handleHttpUpgrade(req, socket, head) {
    let pathname = '';
    try {
        pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
        pathname = req.url || '';
    }

    const targetWss = pathname === '/ssh'
        ? wss
        : pathname === '/rdp-proxy'
            ? rdpProxyWss
            : pathname === '/novnc'
                ? noVncWss
                : pathname === '/editor-lsp'
                    ? editorLspWss
                    : pathname === '/agent/files'
                        ? agentFilesWss
                        : pathname === '/file-transfer'
                            ? fileTransferWss
                            : null;
    if (!targetWss) {
        console.warn('[WS-DIAG] rejected websocket upgrade for unknown path', { url: req.url || '' });
        rejectSocket(socket, 404, 'Not Found');
        return;
    }
    /* /agent/files authenticates via protocol-level token (hello message),
     * not via HTTP session cookie — skip session check for this path. */
    if (targetWss !== agentFilesWss) {
        const session = currentSession(req);
        if (!session || session.mustChangePassword) {
            console.warn('[WS-DIAG] rejected websocket upgrade by session auth', {
                path: pathname,
                hasCookie: /(?:^|;\s*)zephyr_sid=/.test(String(req.headers.cookie || '')),
                hasSession: !!session,
                mustChangePassword: !!session?.mustChangePassword,
                origin: req.headers.origin || '',
            });
            rejectSocket(socket, session?.mustChangePassword ? 403 : 401, session?.mustChangePassword ? 'Forbidden' : 'Unauthorized');
            return;
        }
        /* Bind the verified identity once at upgrade; message handlers below
         * must use req.authSession instead of re-parsing the cookie jar
         * (FREEZE plan §4.6 — no Upgrade/connect double-auth race). */
        req.authSession = session;
        if (pathname === '/rdp-proxy') {
            console.info('[rdp-proxy] websocket upgrade accepted', { user: session.username, origin: req.headers.origin || '' });
        }
    }

    targetWss.handleUpgrade(req, socket, head, (ws) => {
        targetWss.emit('connection', ws, req);
    });
}
server.on('upgrade', handleHttpUpgrade);
if (httpsServer) httpsServer.on('upgrade', handleHttpUpgrade);
editorLspWss.on('connection', handleEditorLspConnection);

/* ─── File Agent WebSocket ─── */
agentFilesWss.on('connection', (ws) => {
    fileAgentManager.handleConnection(ws);
});
fileTransferWss.on('connection', (ws, req) => {
    startSessionWatchdog(ws, req);
    fileTransferGateway.handleConnection(ws, req);
});

/* File-agent REST routes are mounted before the SPA catch-all above. */

function closeWebSocketSafe(ws, code = 1000, reason = '') {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(code, String(reason || '').slice(0, 120));
        else if (ws && ws.readyState === WebSocket.CONNECTING) ws.terminate();
    } catch {}
}

/* Periodically re-validates a long-lived WebSocket's app session against the
 * persistent store (catches cross-process revocations). On expiry the socket
 * closes with 4001 so the client routes to re-login instead of retrying
 * blindly (FREEZE plan §4.6). */
function startSessionWatchdog(ws, req, intervalMs = 5 * 60 * 1000) {
    const sid = parseCookies(req).zephyr_sid;
    if (!sid) return () => {};
    const timer = setInterval(() => {
        let live = null;
        try { live = sessionStore.resolve(sid, { touch: false }); } catch { live = null; }
        if (!live) closeWebSocketSafe(ws, 4001, 'app-session-expired');
    }, intervalMs);
    timer.unref?.();
    ws.on('close', () => clearInterval(timer));
    return () => clearInterval(timer);
}

/* ====================================================================
 * RDP WASM PROXY — WebSocket ↔ TCP bridge for browser-side grdp WASM
 *
 * The browser runs the full RDP protocol stack (Go compiled to WASM).
 * This proxy simply bridges the browser's WebSocket to the target's TCP
 * port 3389.  Zero decoding, zero encoding — pure byte pass-through.
 *
 * URL: /rdp-proxy?target=host:port
 *
 * Authentication is handled by the existing session cookie check in the
 * upgrade handler above.  The target parameter is validated against the
 * user's saved connections for security.
 * ==================================================================== */

rdpProxyWss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/rdp-proxy', `http://${req.headers.host || 'localhost'}`);
    const target = url.searchParams.get('target') || '';
    const flowControlEnabled = url.searchParams.get('flow') === 'v2';

    if (!target || !target.includes(':')) {
        console.warn('[rdp-proxy] rejected: missing or invalid target', { target });
        closeWebSocketSafe(ws, 1008, 'missing target');
        return;
    }

    const [targetHost, targetPortStr] = target.split(':');
    const targetPort = Number(targetPortStr) || 3389;
    // Attach the WS listener immediately. Browser-side Go sends X.224 as soon
    // as WebSocket open resolves; Node EventEmitter does not queue messages for
    // listeners registered after route/TCP setup completes. net.Socket safely
    // buffers bounded writes issued before connect().
    let tcpConn = new net.Socket();
    tcpConn.setKeepAlive(true, 30000);
    tcpConn.setNoDelay(true);
    let routedForward = null;
    let proxyBridge = null;
    let closed = false;

    const cleanup = (reason = 'cleanup') => {
        if (closed) return;
        closed = true;
        try { proxyBridge?.dispose?.(); } catch {}
        try { tcpConn?.destroy?.(); } catch {}
        try { routedForward?.close?.(); } catch {}
        console.info('[rdp-proxy] closed', { target, reason, ...(proxyBridge?.state?.() || {}) });
    };

    ws.on('close', () => cleanup('browser-close'));
    ws.on('error', (err) => { console.warn('[rdp-proxy] ws error', err.message); cleanup('ws-error'); });

    try {
        /* Validate target against ACL-filtered RDP connections for this user. */
        const sessionUser = req.authSession;
        if (!sessionUser) { closeWebSocketSafe(ws, 1008, 'unauthorized'); return; }
        startSessionWatchdog(ws, req);
        const authUser = userFromAuthSession(req);
        if (!authUser) { closeWebSocketSafe(ws, 1008, 'unauthorized'); return; }

        const visible = resourceService.listConnections(authUser, { includeEphemeral: true }).filter((c) => {
            if (String(c.protocol || 'SSH').toUpperCase() !== 'RDP') return false;
            if (!Array.isArray(c.capabilities) || !c.capabilities.includes(CAP.USE)) return false;
            const cHost = String(c.host || '').toLowerCase();
            const cPort = Number(c.port) || 3389;
            return cHost === targetHost.toLowerCase() && cPort === targetPort;
        });
        let conn = visible[0] || null;
        let ephemeralGrant = false;
        if (!conn && hasEphemeralRdpTargetGrant(authUser.userId, targetHost, targetPort)) {
            ephemeralGrant = true;
            conn = {
                host: targetHost,
                port: targetPort,
                protocol: 'RDP',
                connectionMode: 'direct',
                name: `${targetHost}:${targetPort}`,
                transient: true,
                ephemeral: true,
            };
            console.info('[rdp-proxy] accepted ephemeral grant', { target, user: sessionUser.username });
        }

        if (!conn) {
            console.warn('[rdp-proxy] target not found in authorized connections', { target, user: sessionUser.username });
            closeWebSocketSafe(ws, 1008, 'target not found in saved connections');
            return;
        }

        // Validation above is synchronous, so the event loop cannot deliver a
        // WS message before this listener is installed. Attach before the first
        // await to preserve X.224 while avoiding pre-auth socket buffering.
        proxyBridge = attachRdpProxyBridge({
            ws,
            tcpConn,
            flowControlEnabled,
            logger: console,
            onFatal(code, message) {
                if (closed) return;
                console.warn('[rdp-proxy] backpressure fatal', { target, code, message });
                closeWebSocketSafe(ws, 1011, code);
                cleanup(code);
            },
        });

        /* Resolve routing (jump hosts, proxies). Pure grant path is direct-only;
         * saved ephemeral rows still honour their configured route. */
        routedForward = ephemeralGrant ? null : await createRoutedTcpForward(conn, targetPort, 15000);
        const effectiveHost = routedForward ? routedForward.host : targetHost;
        const effectivePort = routedForward ? routedForward.port : targetPort;

        if (closed || ws.readyState !== ws.OPEN) return;

        /* Open the already-bridged TCP socket to the RDP server. */
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err) => {
                if (settled) return;
                settled = true;
                if (err) reject(err); else resolve();
            };
            tcpConn.once('connect', () => finish());
            tcpConn.once('error', (err) => finish(err));
            setTimeout(() => {
                if (!settled) { tcpConn.destroy(); finish(new Error('TCP connect timeout')); }
            }, 15000);
            tcpConn.connect(effectivePort, effectiveHost);
        });

        if (closed || ws.readyState !== ws.OPEN) { tcpConn.destroy(); cleanup('closed-before-ready'); return; }

        console.info('[rdp-proxy] connected', {
            target,
            effective: `${effectiveHost}:${effectivePort}`,
            route: routedForward?.route || 'direct',
            user: sessionUser.username,
        });

        /* ── Bidirectional pipe was attached before async setup ───── */

        tcpConn.on('end', () => {
            if (!closed) {
                closeWebSocketSafe(ws, 1000, 'TCP connection ended');
                cleanup('tcp-end');
            }
        });

        tcpConn.on('error', (err) => {
            if (!closed) {
                console.warn('[rdp-proxy] tcp error', err.message);
                closeWebSocketSafe(ws, 1011, 'TCP error');
                cleanup('tcp-error');
            }
        });

        tcpConn.on('close', () => {
            if (!closed) {
                closeWebSocketSafe(ws, 1000, 'TCP closed');
                cleanup('tcp-close');
            }
        });

    } catch (err) {
        console.error('[rdp-proxy] connection error', { target, error: err.message });
        closeWebSocketSafe(ws, 1011, err.message);
        cleanup('connect-error');
    }
});

/* ====================================================================
 * noVNC PROXY — browser RFB over WebSocket, server-side VNCAuth
 *
 * Browser never receives the VNC password. Zephyr resolves the saved
 * (or ephemeral) connection, dials host/proxy/jump, completes RFB
 * version + None/VNCAuth against the real server, then presents a
 * passwordless "None" security handshake to noVNC and pipes bytes.
 * ==================================================================== */
noVncWss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/novnc', `http://${req.headers.host || 'localhost'}`);
    const connectionId = String(url.searchParams.get('connectionId') || '').trim();
    const tabId = String(url.searchParams.get('tabId') || '').trim();
    let routed = null;
    let reader = null;
    let closed = false;
    let piping = false;
    const pendingFromBrowser = [];

    const cleanup = (reason = 'cleanup') => {
        if (closed) return;
        closed = true;
        try { reader?.close?.(); } catch {}
        try { routed?.socket?.destroy?.(); } catch {}
        (routed?.clients || []).reverse().forEach((client) => { try { client.end(); } catch {} });
        closeWebSocketSafe(ws, 1000, reason);
        console.info('[novnc-ws] closed', { connectionId, tabId, reason });
    };

    ws.binaryType = 'nodebuffer';
    ws.on('close', () => cleanup('browser-close'));
    ws.on('error', (err) => {
        console.warn('[novnc-ws] ws error', err.message);
        cleanup('ws-error');
    });
    // Buffer early client frames until the server-side handshake finishes.
    ws.on('message', (data, isBinary) => {
        if (closed) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (piping && routed?.socket) {
            try { routed.socket.write(buf); } catch (err) {
                console.warn('[novnc-ws] write to vnc failed', err.message);
                cleanup('tcp-write-error');
            }
            return;
        }
        if (pendingFromBrowser.length < 64) pendingFromBrowser.push(buf);
    });

    try {
        const sessionUser = req.authSession;
        if (!sessionUser) { closeWebSocketSafe(ws, 1008, 'unauthorized'); return; }
        startSessionWatchdog(ws, req);
        const authUser = userFromAuthSession(req);
        if (!authUser) { closeWebSocketSafe(ws, 1008, 'unauthorized'); return; }
        if (!connectionId) {
            closeWebSocketSafe(ws, 1008, 'missing connectionId');
            return;
        }

        let conn;
        try {
            conn = resourceService.resolveForConnect(authUser, connectionId);
        } catch (err) {
            console.warn('[novnc-ws] resolve failed', { connectionId, user: sessionUser.username, error: err.message });
            closeWebSocketSafe(ws, 1008, 'forbidden');
            return;
        }
        if (String(conn.protocol || 'SSH').toUpperCase() !== 'VNC') {
            closeWebSocketSafe(ws, 1008, 'not a VNC connection');
            return;
        }
        // Decrypt password for VNCAuth (never forwarded to browser).
        const raw = storage.getConnectionById(connectionId);
        if (raw?.password) conn.password = raw.password;

        console.info('[novnc-ws] connecting', {
            connectionId,
            tabId,
            target: `${conn.host}:${Number(conn.port) || 5900}`,
            mode: conn.connectionMode || 'direct',
            user: sessionUser.username,
            ephemeral: !!conn.ephemeral,
        });

        routed = await openRoutedTcpConnection(conn, Number(conn.port) || 5900, 15000);
        if (closed || ws.readyState !== ws.OPEN) { cleanup('closed-before-ready'); return; }

        reader = new ByteQueue('VNC 服务端');
        const onServerData = (chunk) => {
            if (piping) {
                if (ws.readyState === ws.OPEN) {
                    try { ws.send(chunk, { binary: true }); } catch { cleanup('ws-send-error'); }
                }
                return;
            }
            reader.push(chunk);
        };
        routed.socket.on('data', onServerData);
        routed.socket.on('error', (err) => {
            console.warn('[novnc-ws] tcp error', err.message);
            cleanup('tcp-error');
        });
        routed.socket.on('close', () => cleanup('tcp-close'));

        // ── Server-side RFB handshake + VNCAuth ──────────────────────
        const version = parseRfbVersion(await reader.read(12, 15000, 'VNC 协议版本'));
        routed.socket.write(rfbVersionBytes(Math.min(version.minor || 8, 8)));
        await authenticateVncServer(routed.socket, reader, conn, version, 15000);
        if (closed || ws.readyState !== ws.OPEN) { cleanup('closed-during-auth'); return; }

        // ── Present passwordless RFB to browser noVNC ────────────────
        // Browser sees RFB 003.008 + security type None; password stays server-side.
        const clientQueue = new ByteQueue('noVNC 客户端');
        // Move frames that arrived during the server-side handshake into the
        // structured queue, then rebind so further messages feed the queue
        // (or the TCP socket once piping starts).
        pendingFromBrowser.splice(0).forEach((b) => clientQueue.push(b));
        ws.removeAllListeners('message');
        ws.on('message', (data) => {
            if (closed) return;
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (piping && routed?.socket) {
                try { routed.socket.write(buf); } catch { cleanup('tcp-write-error'); }
                return;
            }
            clientQueue.push(buf);
        });
        const sendClient = (buf) => {
            if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
        };
        const readClient = (size, label) => clientQueue.read(size, 15000, label);

        sendClient(rfbVersionBytes(8));
        parseRfbVersion(await readClient(12, '客户端 RFB 版本')); // validate only
        // security-types: count=1, type=None(1)
        sendClient(Buffer.from([1, 1]));
        const picked = await readClient(1, '客户端安全类型');
        if (picked[0] !== 1) throw new Error(`客户端选择了不支持的安全类型：${picked[0]}`);
        // SecurityResult OK
        sendClient(Buffer.from([0, 0, 0, 0]));
        // ClientInit (1 byte shared-flag) → forward to real server
        const clientInit = await readClient(1, 'ClientInit');
        routed.socket.write(clientInit);

        // ServerInit + everything after: flush any bytes already buffered from
        // the real server, then enter pure bidirectional pipe.
        const buffered = reader.takeBuffered();
        piping = true;
        if (buffered.length && ws.readyState === ws.OPEN) {
            try { ws.send(buffered, { binary: true }); } catch { cleanup('ws-send-error'); return; }
        }
        // Drain any client bytes that arrived between ClientInit and pipe.
        const leftover = clientQueue.takeBuffered();
        if (leftover.length) {
            try { routed.socket.write(leftover); } catch { cleanup('tcp-write-error'); return; }
        }

        console.info('[novnc-ws] ready', {
            connectionId,
            tabId,
            route: routed.route || conn.host,
            user: sessionUser.username,
        });
    } catch (err) {
        console.error('[novnc-ws] connection error', { connectionId, tabId, error: err.message });
        closeWebSocketSafe(ws, 1011, String(err.message || 'vnc proxy error').slice(0, 120));
        cleanup('connect-error');
    }
});

wss.on('connection', (ws, req) => {
    console.log(`[WS] 客户端连接 ${req.socket.remoteAddress}`);
    startSessionWatchdog(ws, req);
    let sshClient = null;
    let sshClients = [];
    let sshStream = null;
    let attachedSshSession = null;
    let sftpStream = null;
    let telnetSocket = null;
    let telnetProtocol = false;
    let statsTimer = null;
    let statsRunning = false;
    let remoteStatsState = {};
    let dockerLogStreams = new Map();
    let sftpUploadStreams = new Map();
    const closeTelnetSocket = (reason = 'cleanup') => {
        if (!telnetSocket) return;
        try { telnetSocket.destroy(); } catch {}
        console.info('[TELNET]', 'socket closed', { reason });
        telnetSocket = null;
        telnetProtocol = false;
    };

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
    let statsSampleSeq = 0;
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
                statsSampleSeq += 1;
                sendJSON({
                    type: 'stats',
                    data: result.stats,
                    sampleSeq: statsSampleSeq,
                    sampledAt: startedAt,
                    durationMs: Date.now() - startedAt,
                });
                console.debug('[STATS] remote stats pushed', { durationMs: Date.now() - startedAt, seq: statsSampleSeq });
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
        for (const entry of dockerLogStreams.values()) {
            const stream = entry?.stream || entry;
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
        if (attachedSshSession) {
            attachedSshSession.attachedWs?.delete(ws);
            attachedSshSession.lastDetachedAt = Date.now();
            console.info('[SSH-SESSION]', 'detach websocket', {
                sessionId: attachedSshSession.id,
                protocol: attachedSshSession.protocol || 'SSH',
                reason,
                remaining: attachedSshSession.attachedWs?.size || 0,
            });
            attachedSshSession = null;
            sshClient = null;
            sshClients = [];
            sshStream = null;
            // Keep telnet TCP alive for resume; only drop the WS-local handle.
            telnetSocket = null;
            telnetProtocol = false;
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
                // Session owns both SSH PTY and Telnet TCP; destroy closes them.
                destroySshTerminalSession(attachedSshSession, reason);
                attachedSshSession = null;
                sshClient = null;
                sshClients = [];
                sshStream = null;
                telnetSocket = null;
                telnetProtocol = false;
            } else {
                // No session object yet (pre-ready failure / ad-hoc) — close local telnet.
                closeTelnetSocket(reason);
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
            // Detach only: keep remote session (SSH PTY / Telnet TCP) for resume.
            detachSshSession(reason);
        }
    };

    function attachSshSession(session, { replay = true } = {}) {
        if (!session || session.closed) return false;
        cleanup({ destroySsh: false, reason: 'attach-existing-session' });
        attachedSshSession = session;
        sshClient = session.sshClient || null;
        sshClients = session.sshClients || [session.sshClient].filter(Boolean);
        sshStream = session.sshStream || null;
        telnetSocket = session.telnetSocket || null;
        telnetProtocol = String(session.protocol || '').toUpperCase() === 'TELNET' || !!session.telnetSocket;
        sftpStream = session.sftpStream || null;
        dockerLogStreams = session.dockerLogStreams || (session.dockerLogStreams = new Map());
        sftpUploadStreams = session.sftpUploadStreams || (session.sftpUploadStreams = new Map());
        session.attachedWs.add(ws);
        session.lastActive = Date.now();
        session.lastDetachedAt = 0;
        ws._sshTerminalSession = session;
        console.info('[SSH-SESSION]', 'attach websocket', {
            sessionId: session.id,
            connectionId: session.connectionId || '',
            protocol: session.protocol || 'SSH',
            attached: session.attachedWs.size,
            replay,
            bufferChunks: session.outputBuffer?.length || 0,
        });
        const pty = session.pty || { cols: 80, rows: 24 };
        // Replay first so the terminal paints previous content as soon as it is ready,
        // then emit ready so the client can treat the surface as fully attached.
        let replayData = '';
        if (replay) {
            try { replayData = terminalHistory.replayTail(session.userId, session.id).data; } catch {}
            if (!replayData && session.outputBuffer.length) replayData = session.outputBuffer.join('');
            if (replayData) sendJSON({ type: 'data', data: replayData, replay: true });
        }
        const protocol = String(session.protocol || 'SSH').toUpperCase();
        sendJSON({
            type: 'ready',
            sessionId: session.id,
            attached: true,
            cols: pty.cols,
            rows: pty.rows,
            replayed: !!replayData,
            protocol,
            ...(protocol === 'TELNET' ? { warning: 'Telnet 未加密；凭据以明文传输' } : {}),
        });
        // Remote stats require an SSH client; Telnet has no remote exec channel.
        if (sshClient) startStatsPush();
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
        const existing = dockerLogStreams.get(key);
        if (existing) {
            sendJSON({ type: 'docker-log-start', container: key, resumed: true });
            for (const data of existing.buffer || []) sendJSON({ type: 'docker-log-data', container: key, data });
            return;
        }
        const command = `docker logs --tail 200 --timestamps -f ${shellQuote(key)}`;
        const ownerSession = attachedSshSession;
        const emit = (payload) => {
            if (ownerSession) broadcastSshSession(ownerSession, payload);
            else sendJSON(payload);
        };
        sshClient.exec(`sh -lc ${JSON.stringify(command)}`, (err, stream) => {
            if (err) {
                emit({ type: 'docker-log-error', container: key, message: err.message });
                return;
            }
            const entry = { stream, buffer: [] };
            dockerLogStreams.set(key, entry);
            emit({ type: 'docker-log-start', container: key });
            const publish = (chunk) => {
                const data = chunk.toString('utf8');
                entry.buffer.push(data);
                while (entry.buffer.length > 200) entry.buffer.shift();
                emit({ type: 'docker-log-data', container: key, data });
            };
            stream.on('data', publish);
            stream.stderr.on('data', publish);
            stream.on('close', (code) => {
                if (dockerLogStreams.get(key) === entry) dockerLogStreams.delete(key);
                emit({ type: 'docker-log-end', container: key, code });
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
                const entry = dockerLogStreams.get(key);
                const stream = entry?.stream || entry;
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

        // ------------------------- SSH / TELNET 连接 -------------------------
        if (msg.type === 'connect') {
            /* Identity was verified once at upgrade; reuse it (no double-auth
             * race between Upgrade and connect — FREEZE plan §4.3). */
            const sessionUser = req.authSession;
            if (!sessionUser) {
                sendJSON({ type: 'error', code: 'app_session_expired', message: '未登录或会话已过期', retryable: false });
                try { ws.close(4001, 'app-session-expired'); } catch {}
                return;
            }
            const { host, port, username, password, privateKey, init, connectionId, transientToken, transientOverrides } = msg;
            const requestedSessionId = String(msg.sessionId || msg.terminalSessionId || msg.tabId || connectionId || crypto.randomUUID());
            const existingSession = sshTerminalSessions.get(requestedSessionId);
            if (existingSession && !existingSession.closed) {
                /* Ownership by immutable userId (renames must not orphan live
                 * sessions); fall back to username for pre-multi-user rows. */
                const sameOwner = existingSession.userId
                    ? existingSession.userId === sessionUser.userId
                    : existingSession.username === sessionUser.username;
                if (!sameOwner) {
                    sendJSON({ type: 'error', code: 'resource_not_found_or_inaccessible', message: '会话不存在或无权访问', retryable: false });
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
                    hasTransientToken: !!transientToken,
                    fallbackTarget: connectionId || transientToken ? '' : `${host || ''}:${port || 22}`,
                    hasFallbackPassword: !!password && password !== '******',
                    hasFallbackPrivateKey: !!privateKey && privateKey !== '******',
                });
                let connectionSource = 'fallback-message';
                let storeConnectionCount = null;
                if (transientToken) {
                    /* One-time Deep Link credential (FREEZE plan §5.4): bound to
                     * userId, atomically consumed, never written to assets. */
                    const authUser = userFromAuthSession(req);
                    if (!authUser) throw new Error('未登录或会话已过期');
                    const consumed = deepLinkService.consume(authUser, String(transientToken), transientOverrides || {});
                    const draftProtocol = String(consumed.draft.protocol || 'SSH').toUpperCase();
                    conn = {
                        host: consumed.draft.host,
                        port: consumed.draft.port || protocolDefaultPort(draftProtocol),
                        username: consumed.draft.username || '',
                        password: consumed.credential?.password || '',
                        privateKey: '',
                        protocol: draftProtocol,
                        connectionMode: 'direct',
                        name: consumed.draft.name || '',
                        transient: true,
                        autoOpenSftp: !!consumed.draft.autoOpenSftp,
                    };
                    connectionSource = 'deeplink-transient';
                } else if (connectionId) {
                    /* Saved-connection connects go through the resource ACL
                     * (§19.4): `use` capability required, dependencies resolved
                     * server-side, secrets never leave the server. */
                    const authUser = userFromAuthSession(req);
                    if (!authUser) throw new Error('未登录或会话已过期');
                    conn = resourceService.resolveForConnect(authUser, String(connectionId));
                    connectionSource = 'acl-resolved';
                    storeConnectionCount = 1;
                } else {
                    /* Ad-hoc / ephemeral connect: form credentials only, never
                     * written to the connection store. Routes and owned SSH
                     * keys are resolved server-side for this session alone. */
                    const authUser = userFromAuthSession(req);
                    if (!authUser) throw new Error('未登录或会话已过期');
                    const fallbackProtocol = String(msg.protocol || 'SSH').toUpperCase();
                    conn = {
                        host,
                        port: port || protocolDefaultPort(fallbackProtocol),
                        username,
                        password: password || '',
                        privateKey: privateKey || '',
                        protocol: fallbackProtocol,
                        connectionMode: 'direct',
                        sshKeyId: String(msg.sshKeyId || ''),
                        proxyId: msg.proxyId || null,
                        jumpHostId: msg.jumpHostId || null,
                        jumpHostIds: Array.isArray(msg.jumpHostIds) ? msg.jumpHostIds : [],
                        transient: true,
                        ephemeral: true,
                        ownerUserId: authUser.userId,
                    };
                    applyConnectionRouteFields(conn, {
                        connectionMode: msg.connectionMode,
                        proxyId: msg.proxyId,
                        jumpHostId: msg.jumpHostId,
                        jumpHostIds: msg.jumpHostIds,
                    });
                    if (fallbackProtocol === 'TELNET') {
                        conn.sshKeyId = '';
                        conn.privateKey = '';
                        // keep password for in-band auto-login; proxy/jump routes
                        // are resolved above with the same dependency ACLs.
                    }
                    if (conn.sshKeyId || conn.connectionMode === 'proxy' || conn.connectionMode === 'jump') {
                        // Reuse dependency ACL checks against the caller's owned/shared deps.
                        resourceService._assertDependenciesUsable(authUser, conn);
                        conn = resourceService._resolveDependencySecrets(authUser, conn);
                    }
                    connectionSource = 'ephemeral-form';
                }
                const protocol = String(conn.protocol || msg.protocol || 'SSH').toUpperCase();
                conn.protocol = protocol;
                // Telnet: host is enough; username is display-only / in-band.
                if (!conn.host) throw new Error('主机不能为空');
                if (protocol !== 'TELNET' && !conn.username) throw new Error('主机和用户名不能为空');
                console.info('[SSH-DIAG] resolved connection config', {
                    connectionId: conn.id || connectionId || '',
                    requestedConnectionId: connectionId || '',
                    source: connectionSource,
                    dataDir: DATA_DIR,
                    dbFile: DB_FILE,
                    storeConnectionCount,
                    name: conn.name || '',
                    target: `${conn.host}:${Number(conn.port) || protocolDefaultPort(protocol)}`,
                    host: conn.host || '',
                    port: Number(conn.port) || protocolDefaultPort(protocol),
                    username: conn.username || '',
                    protocol,
                    mode: conn.connectionMode || 'direct',
                    proxyId: conn.proxyId || '',
                    jumpHostIds: normalizeJumpHostIds(conn),
                    sshKeyId: conn.sshKeyId || '',
                    hasPassword: !!conn.password,
                    hasPrivateKey: !!conn.privateKey,
                });

                const initialRows = Number.isFinite(Number(msg.rows)) ? Math.min(200, Math.max(2, Math.floor(Number(msg.rows)))) : 24;
                const initialCols = Number.isFinite(Number(msg.cols)) ? Math.min(500, Math.max(20, Math.floor(Number(msg.cols)))) : 80;

                if (protocol === 'TELNET') {
                    // FREEZE plan §5.6: Node /ssh is the default Telnet path.
                    // Auth is in-band; we open TCP + IAC negotiate, then wrap
                    // the socket in the same session object SSH uses so attach /
                    // detach / history / detached-TTL all work unchanged.
                    if (connectionId) console.log(`[TELNET] 使用已保存连接 ${conn.name || conn.host}`);
                    const routedForward = await createRoutedTcpForward(conn, Number(conn.port) || 23, 10000);
                    let socket;
                    try {
                        socket = await dialTelnet({
                            host: routedForward?.host || conn.host,
                            port: routedForward?.port || Number(conn.port) || 23,
                        }, { timeout: 10000, cols: initialCols, rows: initialRows });
                    } catch (err) {
                        try { routedForward?.close?.(); } catch {}
                        throw err;
                    }
                    telnetSocket = socket;
                    telnetProtocol = true;
                    socket.setTimeout(0); // live session — no idle timeout kill
                    console.log(`[TELNET] 已连接: ${conn.host}:${Number(conn.port) || 23}${routedForward?.route ? ` (${routedForward.route})` : ''}`);
                    const telnetIac = attachIacEngine(socket, {
                        termType: 'xterm-256color',
                        keepaliveMs: 60000,
                        cols: initialCols,
                        rows: initialRows,
                    });
                    const encoding = String(conn.encoding || msg.encoding || 'utf-8');
                    const telnetDecoder = createTelnetDecoder(encoding);
                    const autoLogin = createTelnetAutoLogin({
                        write: (s) => {
                            if (socket && !socket.destroyed) {
                                try { socket.write(telnetDecoder.encode(String(s))); } catch {}
                            }
                        },
                        username: conn.username || '',
                        password: conn.password || '',
                        timeoutMs: 15000,
                        onDone: (reason) => {
                            console.info('[TELNET]', 'auto-login', { sessionId: requestedSessionId, reason, encoding: telnetDecoder.encoding });
                            // Init command after login attempt (ok or timeout).
                            if (init && typeof init === 'string' && init.trim().length > 0) {
                                try { socket.write(telnetDecoder.encode(init + '\n')); } catch {}
                            }
                        },
                    });
                    const session = {
                        id: requestedSessionId,
                        connectionId: conn.id || connectionId || '',
                        protocol: 'TELNET',
                        encoding: telnetDecoder.encoding,
                        telnetSocket: socket,
                        routedTcpForward: routedForward,
                        telnetIac,
                        telnetDecoder,
                        telnetAutoLogin: autoLogin,
                        sshClient: null,
                        sshClients: [],
                        sshStream: null,
                        attachedWs: new Set([ws]),
                        pty: { rows: initialRows, cols: initialCols },
                        outputBuffer: [],
                        createdAt: Date.now(),
                        lastActive: Date.now(),
                        lastDetachedAt: 0,
                        username: sessionUser.username || '',
                        userId: sessionUser.userId || '',
                        connectionConfig: conn,
                        dockerLogStreams,
                        sftpUploadStreams,
                        closed: false,
                    };
                    attachedSshSession = session;
                    ws._sshTerminalSession = session;
                    sshTerminalSessions.set(session.id, session);
                    try {
                        terminalHistory.open({
                            userId: session.userId,
                            sessionId: session.id,
                            connectionId: session.connectionId,
                            cols: initialCols,
                            rows: initialRows,
                        });
                    } catch (err) {
                        console.warn('[TERMINAL-HISTORY] open failed', { sessionId: session.id, error: err.message });
                    }
                    // Register stream handlers BEFORE ready so any already-buffered
                    // peer banner (e.g. "login: ") is not lost relative to the
                    // client message race after awaiting ready.
                    socket.on('data', (chunk) => {
                        if (session.closed) return;
                        const engine = session.telnetIac;
                        const filtered = engine ? engine.feed(chunk) : filterIac(chunk);
                        if (!filtered.length) return;
                        const decoder = session.telnetDecoder;
                        const text = decoder ? decoder.decode(filtered) : filtered.toString('utf-8');
                        if (!text) return;
                        try { session.telnetAutoLogin?.feed?.(text); } catch {}
                        // History journal stores utf-8 text bytes for search/replay.
                        appendSshSessionBuffer(session, Buffer.from(text, 'utf8'));
                        broadcastSshSession(session, { type: 'data', data: text });
                    });
                    socket.on('error', (err) => {
                        console.error(`[TELNET] 错误: ${err.message}`);
                        if (session.closed) return;
                        // Surface a live error frame, then destroy (which emits classified close).
                        broadcastSshSession(session, {
                            type: 'error',
                            message: `Telnet 连接异常: ${err.message}`,
                            code: 'remote_error',
                            protocol: 'TELNET',
                        });
                        destroySshTerminalSession(session, 'telnet-error');
                        if (attachedSshSession === session) {
                            attachedSshSession = null;
                            telnetSocket = null;
                            telnetProtocol = false;
                        }
                    });
                    socket.on('close', () => {
                        console.log('[TELNET] 连接关闭');
                        if (session.closed) return;
                        // destroy broadcasts the classified close frame; avoid double emit.
                        destroySshTerminalSession(session, 'telnet-close');
                        if (attachedSshSession === session) {
                            attachedSshSession = null;
                            telnetSocket = null;
                            telnetProtocol = false;
                        }
                    });
                    sendJSON({
                        type: 'ready',
                        sessionId: session.id,
                        cols: initialCols,
                        rows: initialRows,
                        protocol: 'TELNET',
                        encoding: session.encoding || 'utf-8',
                        warning: 'Telnet 未加密；凭据以明文传输',
                    });
                    // When credentials are present, init is deferred to auto-login onDone
                    // so it does not type into the login/password prompt.
                    const hasCreds = !!(conn.username || conn.password);
                    if (!hasCreds && init && typeof init === 'string' && init.trim().length > 0) {
                        try { socket.write(telnetDecoder.encode(init + '\n')); } catch {}
                    }
                    return;
                }

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
                        protocol: 'SSH',
                        sshClient,
                        sshClients,
                        sshStream,
                        telnetSocket: null,
                        attachedWs: new Set([ws]),
                        pty: { rows: initialRows, cols: initialCols },
                        outputBuffer: [],
                        createdAt: Date.now(),
                        lastActive: Date.now(),
                        lastDetachedAt: 0,
                        username: sessionUser.username || '',
                        userId: sessionUser.userId || '',
                        connectionConfig: conn,
                        dockerLogStreams,
                        sftpUploadStreams,
                        closed: false,
                    };
                    attachedSshSession = session;
                    ws._sshTerminalSession = session;
                    sshTerminalSessions.set(session.id, session);
                    try { terminalHistory.open({ userId: session.userId, sessionId: session.id, connectionId: session.connectionId, cols: initialCols, rows: initialRows }); } catch (err) {
                        console.warn('[TERMINAL-HISTORY] open failed', { sessionId: session.id, error: err.message });
                    }
                    const pty = session.pty || { rows: initialRows, cols: initialCols };
                    sendJSON({ type: 'ready', sessionId: session.id, cols: pty.cols, rows: pty.rows });

                    // SSH 连接就绪后，启动实时监控推送
                    startStatsPush();

                    stream.on('data', (data) => {
                        const text = data.toString('utf-8');
                        appendSshSessionBuffer(session, data);
                        broadcastSshSession(session, { type: 'data', data: text });
                    });
                    stream.on('close', (code, signal) => {
                        console.log(`[SSH] Shell 关闭 code=${code} signal=${signal}`);
                        broadcastSshSession(session, { type: 'close', message: `Shell 已关闭 (code=${code})` });
                        destroySshTerminalSession(session, `shell-close-${code ?? 'N/A'}`);
                    });
                    stream.stderr.on('data', (data) => {
                        const text = data.toString('utf-8');
                        appendSshSessionBuffer(session, data);
                        broadcastSshSession(session, { type: 'data', data: text });
                    });

                    if (init && typeof init === 'string' && init.trim().length > 0) {
                        stream.write(init + '\n');
                    }
                });
            } catch (err) {
                console.warn('[SSH-DIAG] ssh connection failed before shell', {
                    connectionId: connectionId || '',
                    error: err.message,
                    stack: err.stack,
                });
                const label = String(conn?.protocol || msg.protocol || 'SSH').toUpperCase() === 'TELNET' ? 'Telnet' : 'SSH';
                sendJSON({ type: 'error', message: `${label} 连接失败: ${err.message}` });
                cleanup();
                return;
            }
            return;
        }

        // 输入
        if (msg.type === 'input') {
            const liveTelnet = (attachedSshSession?.telnetSocket && !attachedSshSession.telnetSocket.destroyed)
                ? attachedSshSession.telnetSocket
                : (telnetSocket && !telnetSocket.destroyed ? telnetSocket : null);
            if (liveTelnet) {
                try {
                    const decoder = attachedSshSession?.telnetDecoder;
                    if (decoder) liveTelnet.write(decoder.encode(String(msg.data || '')));
                    else liveTelnet.write(String(msg.data || ''), 'utf-8');
                } catch {}
                if (attachedSshSession) attachedSshSession.lastActive = Date.now();
                return;
            }
            if (sshStream && sshStream.writable) {
                sshStream.write(msg.data);
                if (attachedSshSession) attachedSshSession.lastActive = Date.now();
            }
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
            const liveTelnet = (attachedSshSession?.telnetSocket && !attachedSshSession.telnetSocket.destroyed)
                ? attachedSshSession.telnetSocket
                : (telnetSocket && !telnetSocket.destroyed ? telnetSocket : null);
            if (liveTelnet) {
                try { sendNaws(liveTelnet, cols, rows); } catch {}
                if (attachedSshSession) {
                    attachedSshSession.pty = { rows, cols };
                    attachedSshSession.lastActive = Date.now();
                    flushSshSessionHistory(attachedSshSession);
                    try { terminalHistory.appendResize(attachedSshSession.userId, attachedSshSession.id, cols, rows); } catch {}
                }
                return;
            }
            if (sshStream && sshStream.setWindow) {
                sshStream.setWindow(rows, cols, 0, 0);
                if (attachedSshSession) {
                    attachedSshSession.pty = { rows, cols };
                    attachedSshSession.lastActive = Date.now();
                    flushSshSessionHistory(attachedSshSession);
                    try { terminalHistory.appendResize(attachedSshSession.userId, attachedSshSession.id, cols, rows); } catch {}
                }
            }
            return;
        }

        // 手动请求一帧实时监控数据（打开监控面板时使用）
        if (msg.type === 'stats-subscribe') {
            // Explicit subscribe (FREEZE plan §2.3.2): start periodic push.
            startStatsPush();
            return;
        }
        if (msg.type === 'stats-unsubscribe') {
            // Explicit unsubscribe: stop periodic push without disconnecting SSH.
            stopStatsPush();
            return;
        }
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

        if (msg.type === 'process-signal') {
            if (!sshClient) {
                sendJSON({ type: 'process-action-result', ok: false, message: 'SSH 未连接' });
                return;
            }
            const pid = Math.floor(Number(msg.pid));
            const signal = String(msg.signal || 'TERM').toUpperCase() === 'KILL' ? 'KILL' : 'TERM';
            if (!Number.isFinite(pid) || pid <= 1) {
                sendJSON({ type: 'process-action-result', ok: false, message: 'PID 无效或不允许操作系统关键进程' });
                return;
            }
            try {
                await execRemoteCommand(sshClient, `kill -s ${signal} ${pid}`);
                sendJSON({ type: 'process-action-result', ok: true, pid, signal, message: `${signal === 'KILL' ? '强制结束' : '结束'}进程 ${pid} 的信号已发送` });
            } catch (err) {
                sendJSON({ type: 'process-action-result', ok: false, pid, signal, message: err.message || '进程操作失败' });
            }
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
                    username: req.authSession?.username || '',
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
            const username = req.authSession?.username || '';
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
            const username = req.authSession?.username || '';
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
            const username = req.authSession?.username || '';
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
            const username = req.authSession?.username || '';
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
            const username = req.authSession?.username || '';
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
                        username: req.authSession?.username || '',
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
                username: req.authSession?.username || '',
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
                    username: req.authSession?.username || '',
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
                        username: req.authSession?.username || '',
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
            sftpStream.stat(msg.path, (statErr, stats) => {
                sftpStream.readFile(msg.path, (err, data) => {
                    if (err) {
                        sendJSON({ type: 'sftp-readfile', requestId, path: msg.path, error: err.message });
                        return;
                    }
                    const mtimeMs = stats && stats.mtime
                        ? (stats.mtime instanceof Date ? stats.mtime.getTime() : Number(stats.mtime) * (Number(stats.mtime) < 1e12 ? 1000 : 1))
                        : 0;
                    sendJSON({
                        type: 'sftp-readfile',
                        requestId,
                        path: msg.path,
                        data: Buffer.isBuffer(data) ? data.toString('base64') : '',
                        encoding: 'base64',
                        size: Buffer.isBuffer(data) ? data.length : 0,
                        mtimeMs,
                    });
                });
            });
            return;
        }

        // 编辑文件：保存内容（可选 expectedMtimeMs 乐观锁）
        if (msg.type === 'sftp-writefile') {
            const editorId = String(msg.editorId || '');
            const expected = msg.expectedMtimeMs != null && msg.expectedMtimeMs !== ''
                ? Number(msg.expectedMtimeMs)
                : null;
            const doWrite = () => {
                const writeStream = sftpStream.createWriteStream(msg.path);
                writeStream.on('error', (err) => {
                    sendJSON({ type: 'sftp-writefile', editorId, path: msg.path, success: false, error: err.message });
                });
                const buffer = msg.encoding === 'base64'
                    ? Buffer.from(msg.data || '', 'base64')
                    : Buffer.from(msg.data || '', 'utf8');
                writeStream.end(buffer, () => {
                    sftpStream.stat(msg.path, (statErr, stats) => {
                        const mtimeMs = !statErr && stats && stats.mtime
                            ? (stats.mtime instanceof Date ? stats.mtime.getTime() : Number(stats.mtime) * (Number(stats.mtime) < 1e12 ? 1000 : 1))
                            : Date.now();
                        sendJSON({
                            type: 'sftp-writefile',
                            editorId,
                            path: msg.path,
                            success: true,
                            mtimeMs,
                            size: buffer.length,
                        });
                    });
                });
            };
            if (expected != null && Number.isFinite(expected) && expected > 0) {
                sftpStream.stat(msg.path, (statErr, stats) => {
                    if (statErr) {
                        // new file / missing — allow write
                        return doWrite();
                    }
                    const current = stats.mtime instanceof Date
                        ? stats.mtime.getTime()
                        : Number(stats.mtime) * (Number(stats.mtime) < 1e12 ? 1000 : 1);
                    // 2s skew tolerance for filesystem timestamp precision
                    if (Math.abs(current - expected) > 2000) {
                        return sendJSON({
                            type: 'sftp-writefile',
                            editorId,
                            path: msg.path,
                            success: false,
                            conflict: true,
                            code: 'mtime_conflict',
                            error: '远端文件已被修改',
                            mtimeMs: current,
                            size: Number(stats.size) || 0,
                        });
                    }
                    doWrite();
                });
            } else {
                doWrite();
            }
            return;
        }

        // 工作区文本搜索（当前目录浅层/有界递归）
        if (msg.type === 'sftp-workspace-search') {
            const requestId = String(msg.requestId || '');
            const root = String(msg.path || '.').replace(/\/+$/, '') || '.';
            const query = String(msg.query || '');
            const maxFiles = Math.min(200, Math.max(1, Number(msg.maxFiles) || 80));
            const maxMatches = Math.min(200, Math.max(1, Number(msg.maxMatches) || 60));
            const maxDepth = Math.min(4, Math.max(0, Number(msg.maxDepth) || 2));
            if (!query || query.length > 200) {
                sendJSON({ type: 'sftp-workspace-search', requestId, path: root, error: 'invalid_query', matches: [] });
                return;
            }
            const qLower = query.toLowerCase();
            const matches = [];
            const visited = new Set();
            const listDir = (dir) => new Promise((resolve) => {
                sftpStream.readdir(dir, (err, list) => resolve(err ? [] : (list || [])));
            });
            const readHead = (filePath) => new Promise((resolve) => {
                sftpStream.open(filePath, 'r', (err, handle) => {
                    if (err) return resolve('');
                    const buf = Buffer.alloc(64 * 1024);
                    sftpStream.read(handle, buf, 0, buf.length, 0, (readErr, bytesRead) => {
                        sftpStream.close(handle, () => {});
                        if (readErr || !bytesRead) return resolve('');
                        resolve(buf.slice(0, bytesRead).toString('utf8'));
                    });
                });
            });
            (async () => {
                let filesScanned = 0;
                const walk = async (dir, depth) => {
                    if (matches.length >= maxMatches || filesScanned >= maxFiles) return;
                    if (visited.has(dir)) return;
                    visited.add(dir);
                    const list = await listDir(dir);
                    for (const ent of list) {
                        if (matches.length >= maxMatches || filesScanned >= maxFiles) break;
                        const name = ent.filename || ent.longname || '';
                        if (!name || name === '.' || name === '..') continue;
                        if (name.startsWith('.') && name !== '.env' && name !== '.gitignore') continue;
                        const full = `${dir}/${name}`.replace(/\/+/g, '/');
                        const isDir = (ent.attrs && (ent.attrs.isDirectory?.() || (ent.attrs.mode & 0o170000) === 0o040000))
                            || String(ent.longname || '').startsWith('d');
                        if (isDir) {
                            if (depth < maxDepth && !['node_modules', '.git', 'vendor', 'dist', 'build'].includes(name)) {
                                await walk(full, depth + 1);
                            }
                            continue;
                        }
                        const lower = name.toLowerCase();
                        if (!/\.(txt|md|json|ya?ml|js|ts|jsx|tsx|py|go|rs|java|c|h|cpp|hpp|css|scss|html|xml|toml|ini|conf|cfg|sh|bash|zsh|env|sql|php|rb|swift|kt)$/i.test(lower)
                            && !/^(Dockerfile|Makefile|Jenkinsfile)$/i.test(name)) continue;
                        filesScanned += 1;
                        const text = await readHead(full);
                        if (!text) continue;
                        const lines = text.split(/\r?\n/);
                        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
                            if (lines[i].toLowerCase().includes(qLower)) {
                                matches.push({
                                    path: full,
                                    line: i + 1,
                                    text: lines[i].slice(0, 240),
                                });
                            }
                        }
                    }
                };
                try {
                    await walk(root, 0);
                    sendJSON({ type: 'sftp-workspace-search', requestId, path: root, query, matches, filesScanned });
                } catch (err) {
                    sendJSON({ type: 'sftp-workspace-search', requestId, path: root, error: err.message || String(err), matches });
                }
            })();
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
        // Detach only — keep the SSH PTY + output buffer so refresh can resume.
        cleanup({ destroySsh: false, reason: 'ws-close' });
    });

    ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
        cleanup({ destroySsh: false, reason: 'ws-error' });
    });
});

// GC detached SSH sessions that nobody re-attached within the TTL.
setInterval(() => {
    const now = Date.now();
    for (const session of [...sshTerminalSessions.values()]) {
        if (session.closed) continue;
        const attached = session.attachedWs?.size || 0;
        if (attached > 0) continue;
        const idleFrom = Number(session.lastDetachedAt || session.lastActive || session.createdAt || 0);
        if (idleFrom && now - idleFrom > SSH_DETACHED_SESSION_TTL_MS) {
            destroySshTerminalSession(session, 'detached-ttl');
        }
    }
}, 60 * 1000).unref();

async function startServer() {
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
    const aiHostListen = parseLoopbackListen(AI_HOST_LISTEN);
    aiHostServer = http.createServer(aiHostApp);
    await Promise.all([
        HTTP_ENABLED ? new Promise((resolve) => server.listen(PORT, resolve)) : Promise.resolve(),
        httpsServer ? new Promise((resolve) => httpsServer.listen(HTTPS_PORT, resolve)) : Promise.resolve(),
        new Promise((resolve, reject) => {
            aiHostServer.once('error', reject);
            aiHostServer.listen(aiHostListen.port, aiHostListen.host, resolve);
        }),
    ]);
    console.log(`🔒 Zephyr AI Tool Host 运行在 http://${aiHostListen.host}:${aiHostListen.port}（仅 loopback）`);
    if (HTTP_ENABLED) console.log(`🌬️  Zephyr HTTP 服务运行在 http://localhost:${PORT}`);
    else console.log('🔒 Zephyr HTTP 服务已禁用（设置 HTTP_ENABLED=true 可重新启用）');
    if (httpsServer) console.log(`🔐 Zephyr HTTPS 服务运行在 https://localhost:${HTTPS_PORT}`);
    else if (HTTPS_ENABLED) console.warn('[https] HTTPS requested but disabled because certificate setup failed');
    console.log(`   WebSocket 路径: /ssh`);
    console.log(`   RDP 路径: /rdp-proxy -> WASM grdp (browser-side RDP)`);
    console.log(`   VNC/noVNC 路径: /novnc -> VNC Server`);
    console.log(`   Agent 文件重定向: /agent/files -> Flutter Agent WebSocket`);
}

startServer().catch((err) => {
    console.error('[startup] Zephyr 启动失败:', err);
    process.exit(1);
});
