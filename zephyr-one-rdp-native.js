/*
 * zephyr-one-rdp-native.js — native FreeRDP surface for Zephyr One.
 *
 * Only loaded when ZEPHYR_ONE_EMBEDDED=1, so the browser product's RDP path
 * (Go→WASM in a Worker over /rdp-proxy) is untouched at runtime.
 *
 * Why this exists: One is a Tauri desktop app, so it can link the reference RDP
 * implementation instead of reimplementing the protocol in WASM. That brings
 * CredSSP/NLA, every codec FreeRDP ships, OS-native audio (rdpsnd), cliprdr and
 * — the point of this change — real RDPDR drive redirection, which is what makes
 * folder mapping an actual mapped drive in the remote session rather than a
 * hand-rolled file list.
 *
 *   WebView (zephyr-one-rdp.html)
 *     │  WebSocket /zephyr-one-rdp        (session-cookie authenticated)
 *     ▼
 *   this module
 *     │  stdio, length-prefixed binary frames
 *     ▼
 *   zephyr-one-rdp helper (Rust)  ──►  C shim  ──►  libfreerdp  ──►  RDP host
 *
 * Credential handling is strictly better than the browser path: the password is
 * decrypted here and written to the child's stdin pipe. It never reaches the
 * browser, and it is never an argv element (argv is world-readable via ps).
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ── wire protocol ─────────────────────────────────────────────────────────
 * Must stay in lockstep with native/zephyr-one-rdp/src/proto.rs. The contract
 * test asserts these values so a change on one side fails loudly. */
const MSG = Object.freeze({
    CONFIG: 0x00,
    MOUSE: 0x01,
    MOUSE_EX: 0x02,
    SCANCODE: 0x03,
    UNICODE: 0x04,
    SYNC: 0x05,
    RESIZE: 0x06,
    CLIPBOARD: 0x07,
    FULL_FRAME: 0x08,
    STOP: 0x09,
    FRAME: 0x81,
    EVENT: 0x82,
});

/* Messages the browser is allowed to originate. CONFIG is excluded on purpose:
 * it carries credentials and is assembled server-side, so accepting one from
 * the page would let it redirect the session or swap the mapped folder. */
const CLIENT_ALLOWED = new Set([
    MSG.MOUSE, MSG.MOUSE_EX, MSG.SCANCODE, MSG.UNICODE,
    MSG.SYNC, MSG.RESIZE, MSG.CLIPBOARD, MSG.FULL_FRAME, MSG.STOP,
]);

const WS_PATH = '/zephyr-one-rdp';

/* A full 4K RGBA frame is 3840*2160*4 ≈ 33 MB; allow one plus header slack so a
 * desynchronised stream cannot make Node buffer without bound. */
const MAX_HELPER_FRAME = 40 * 1024 * 1024;

const PICKER_TTL_MS = 2 * 60 * 1000;

/**
 * Locate the helper binary.
 *
 * ZEPHYR_ONE_RDP_HELPER is what the Tauri shell sets, and it wins: only the
 * shell knows where the bundle put the sidecar. The rest are development
 * fallbacks, ordered most-specific first.
 *
 * @param {{env?: object, cwd?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {string|null}
 */
function resolveHelperPath(opts = {}) {
    const env = opts.env || process.env;
    const cwd = opts.cwd || process.cwd();
    const exists = opts.exists || ((p) => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
    });

    const fromEnv = String(env.ZEPHYR_ONE_RDP_HELPER || '').trim();
    if (fromEnv && exists(fromEnv)) return fromEnv;

    const exe = process.platform === 'win32' ? 'zephyr-one-rdp.exe' : 'zephyr-one-rdp';
    const candidates = [
        path.join(cwd, exe),
        path.join(cwd, 'bin', exe),
        path.join(cwd, '..', 'native', 'zephyr-one-rdp', 'target', 'release', exe),
        path.join(cwd, '..', 'native', 'zephyr-one-rdp', 'target', 'debug', exe),
        path.join(cwd, 'native', 'zephyr-one-rdp', 'target', 'release', exe),
        path.join(cwd, 'native', 'zephyr-one-rdp', 'target', 'debug', exe),
    ];
    for (const candidate of candidates) {
        if (exists(candidate)) return candidate;
    }
    return null;
}

/**
 * Frame one message for the helper: u32 LE body length, then the body.
 * @param {number} kind
 * @param {Buffer|Uint8Array} [payload]
 * @returns {Buffer}
 */
function encodeFrame(kind, payload) {
    const body = payload && payload.length ? Buffer.from(payload) : Buffer.alloc(0);
    const out = Buffer.allocUnsafe(4 + 1 + body.length);
    out.writeUInt32LE(1 + body.length, 0);
    out[4] = kind;
    if (body.length) body.copy(out, 5);
    return out;
}

/**
 * Pull every complete frame out of an accumulating buffer.
 *
 * Split out and unit-tested because stdio delivers arbitrary chunk boundaries:
 * a 33 MB frame always arrives in pieces, and getting this wrong desynchronises
 * the stream permanently rather than dropping one frame.
 *
 * @param {Buffer} buffer
 * @returns {{frames: Buffer[], rest: Buffer, error: string|null}} frames are
 *   message bodies with the length prefix already stripped.
 */
function pumpFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (buffer.length - offset >= 4) {
        const len = buffer.readUInt32LE(offset);
        if (len === 0 || len > MAX_HELPER_FRAME) {
            return {
                frames,
                rest: Buffer.alloc(0),
                error: `helper frame length ${len} out of range`,
            };
        }
        if (buffer.length - offset - 4 < len) break;
        frames.push(buffer.subarray(offset + 4, offset + 4 + len));
        offset += 4 + len;
    }
    return { frames, rest: buffer.subarray(offset), error: null };
}

/**
 * Per-connection folder mapping, stored outside the shared connection record.
 *
 * The mapped folder is an absolute path on *this* machine. Putting it in the
 * connection record would push a machine-local path into a schema the browser
 * product also reads and syncs, where it means nothing. Keeping it in One's own
 * data dir means the shared schema is unchanged.
 */
class MappingStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.cache = null;
    }

    _load() {
        if (this.cache) return this.cache;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            this.cache = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            this.cache = {};
        }
        return this.cache;
    }

    get(connectionId) {
        const entry = this._load()[String(connectionId)];
        if (!entry || typeof entry !== 'object') return null;
        return {
            folder: String(entry.folder || ''),
            deviceName: String(entry.deviceName || ''),
            readOnly: !!entry.readOnly,
        };
    }

    set(connectionId, { folder, deviceName, readOnly }) {
        const all = this._load();
        all[String(connectionId)] = {
            folder: String(folder || ''),
            deviceName: String(deviceName || ''),
            readOnly: !!readOnly,
        };
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2));
        return all[String(connectionId)];
    }

    remove(connectionId) {
        const all = this._load();
        delete all[String(connectionId)];
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2));
    }
}

/**
 * Folder-picker handoff between the WebView and the Tauri shell.
 *
 * The settings UI runs on the loopback core's origin, which Tauri treats as a
 * remote origin — it cannot invoke a Tauri command. So the page files a request
 * here, the Rust shell polls for it, opens the OS folder dialog, and posts the
 * chosen path back. Same polling shape the shell already uses to follow the
 * product's colour scheme.
 *
 * The browser's own showDirectoryPicker() is not an option: it yields an opaque
 * handle, never a filesystem path, and FreeRDP's drive addin needs a real path.
 */
class PickerQueue {
    constructor({ ttlMs = PICKER_TTL_MS, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.pending = new Map();
        this.seq = 0;
    }

    request(username) {
        this.sweep();
        this.seq += 1;
        const id = `pick-${this.now()}-${this.seq}`;
        this.pending.set(id, {
            id,
            username: String(username || ''),
            createdAt: this.now(),
            state: 'pending',
            path: '',
            error: '',
        });
        return id;
    }

    /** Oldest still-pending request for the shell to act on. */
    claim() {
        this.sweep();
        for (const entry of this.pending.values()) {
            if (entry.state === 'pending') {
                entry.state = 'claimed';
                return { id: entry.id, username: entry.username };
            }
        }
        return null;
    }

    resolve(id, folderPath, error) {
        const entry = this.pending.get(String(id));
        if (!entry) return false;
        entry.state = 'done';
        entry.path = String(folderPath || '');
        entry.error = String(error || '');
        return true;
    }

    /** Poll from the page. Removes the entry once a terminal answer is read. */
    poll(id) {
        this.sweep();
        const entry = this.pending.get(String(id));
        if (!entry) return { state: 'unknown', path: '', error: '' };
        if (entry.state === 'done') {
            this.pending.delete(entry.id);
            return { state: 'done', path: entry.path, error: entry.error };
        }
        return { state: entry.state, path: '', error: '' };
    }

    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, entry] of [...this.pending.entries()]) {
            if (entry.createdAt < cutoff) this.pending.delete(id);
        }
    }
}

const RESOLUTIONS = Object.freeze({
    '1080p': [1920, 1080],
    '2K': [2560, 1440],
    '4K': [3840, 2160],
    '8K': [7680, 4320],
});

/**
 * Resolve the desktop size to request.
 *
 * RDP encodes width/height as UINT16 and several codec paths dislike odd
 * widths, so the result is clamped to the DISPLAY_CONTROL range and made even.
 * The shim clamps again; doing it here means the value the UI reports and the
 * value FreeRDP receives agree.
 */
function resolveGeometry(setting, viewport) {
    let width;
    let height;
    if (String(setting || 'auto') === 'auto') {
        width = Number(viewport && viewport.width) || 1920;
        height = Number(viewport && viewport.height) || 1080;
    } else {
        const preset = RESOLUTIONS[String(setting)];
        [width, height] = preset || RESOLUTIONS['1080p'];
    }
    const clamp = (value) => {
        let v = Math.round(Number(value) || 0);
        if (v < 200) v = 200;
        if (v > 8192) v = 8192;
        return v & ~1;
    };
    return { width: clamp(width), height: clamp(height) };
}

/**
 * Build the JSON config for the helper's first frame.
 *
 * `resolved` is the output of the core's own credential resolution, so the
 * native path and the browser path agree on which secret a connection uses.
 * The connection record's stored password is deliberately not consulted: it is
 * an encrypted blob, and reading it here would either leak ciphertext or
 * duplicate decryption logic that already exists.
 */
function buildHelperConfig({ conn, resolved, mapping, viewport }) {
    const geometry = resolveGeometry(conn.rdpResolution, viewport);

    let username = String((resolved && resolved.username) || conn.username || '');
    let domain = String((resolved && resolved.domain) || conn.rdpDomain || '');
    const domainMatch = username.match(/^([^\\]+)\\(.+)$/);
    if (!domain && domainMatch) {
        domain = domainMatch[1];
        username = domainMatch[2];
    }

    const quality = String(conn.rdpQuality || 'balanced');
    const folder = mapping ? String(mapping.folder || '') : '';
    let deviceName = mapping ? String(mapping.deviceName || '') : '';
    if (folder && !deviceName) {
        /* Default the share name to the folder's own basename: that is what the
         * user already recognises, and an empty name would make the shim refuse
         * the mapping outright. */
        deviceName = path.basename(folder) || 'Zephyr';
    }

    return {
        host: String(conn.host || ''),
        port: Number(conn.port) || 3389,
        username,
        password: String((resolved && resolved.password) || ''),
        domain,
        width: geometry.width,
        height: geometry.height,
        colorDepth: 32,
        /* auto lets FreeRDP negotiate NLA→TLS→RDP, which is what reaches the
         * widest set of hosts. */
        security: 'auto',
        ignoreCertificate: true,
        audioMode: String(conn.rdpSoundMode || 'local'),
        microphone: !!conn.rdpMicrophone,
        clipboard: conn.rdpClipboard !== false,
        driveName: conn.rdpStorage ? deviceName : '',
        drivePath: conn.rdpStorage ? folder : '',
        driveReadOnly: mapping ? !!mapping.readOnly : false,
        dynamicResolution: true,
        /* RDPGFX/H.264 is a real win on slow links, but Alpine's FreeRDP is
         * built without an H.264 decoder, so requesting it there negotiates a
         * codec nothing can decode. Tie it to the quality knob the UI already
         * exposes rather than forcing it on. */
        gfx: quality === 'quality',
        disableWallpaper: quality === 'performance',
        disableThemes: quality === 'performance',
        disableMenuAnims: quality === 'performance',
        disableFullWindowDrag: quality === 'performance',
        allowFontSmoothing: quality !== 'performance',
        maxFps: Math.max(1, Math.min(240, Number(conn.rdpFps) || 30)),
    };
}

/**
 * Mount the native RDP surface.
 *
 * Everything the module needs from the core is injected rather than imported,
 * so the contract test drives it with stubs and a change to a core internal
 * fails here loudly instead of silently at runtime.
 */
function attach({
    app,
    server,
    httpsServer,
    WebSocketServer,
    dataDir,
    currentSession,
    requireUser,
    rejectSocket,
    findConnection,
    resolveCredentials,
    logger = console,
    helperPath = undefined,
}) {
    const mappings = new MappingStore(path.join(dataDir, 'zephyr-one-rdp-mappings.json'));
    const pickers = new PickerQueue();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

    /* ── folder mapping REST ── */

    app.get('/api/one/rdp/storage-mapping/:id', requireUser, (req, res) => {
        const found = mappings.get(req.params.id);
        res.json(found || { folder: '', deviceName: '', readOnly: false });
    });

    app.post('/api/one/rdp/storage-mapping/:id', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const folder = String(body.folder || '').trim();
        const deviceName = String(body.deviceName || '').trim();

        /* Validate while the picker is still on screen. Without this the folder
         * looks accepted and the failure only surfaces as an unexplained
         * connect error later — FreeRDP's add_device_channel stats the path and
         * fails the whole settings assembly when it is gone. */
        if (folder) {
            let stat = null;
            try {
                stat = fs.statSync(folder);
            } catch {
                return res.status(400).json({ error: `映射文件夹不存在：${folder}` });
            }
            if (!stat.isDirectory()) {
                return res.status(400).json({ error: `映射目标不是文件夹：${folder}` });
            }
        }
        if (deviceName && /[\\/:]/.test(deviceName)) {
            return res.status(400).json({ error: '设备名称不能包含 \\ / : 字符' });
        }

        if (!folder && !deviceName) {
            mappings.remove(req.params.id);
            return res.json({ folder: '', deviceName: '', readOnly: false });
        }
        res.json(mappings.set(req.params.id, {
            folder,
            deviceName,
            readOnly: !!body.readOnly,
        }));
    });

    /* ── native folder picker handoff ── */

    app.post('/api/one/rdp/pick-folder', requireUser, (req, res) => {
        res.json({ id: pickers.request(req.session && req.session.username) });
    });

    app.get('/api/one/rdp/pick-folder/:id', requireUser, (req, res) => {
        res.json(pickers.poll(req.params.id));
    });

    /* Polled by the Tauri shell, which is the only party that can open a native
     * dialog. Kept behind requireUser like every other route: the shell rides
     * the same adopted local session as the WebView. */
    app.get('/api/one/rdp/picker-queue', requireUser, (req, res) => {
        res.json(pickers.claim() || { id: '', username: '' });
    });

    app.post('/api/one/rdp/picker-queue/:id', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const ok = pickers.resolve(req.params.id, body.path, body.error);
        res.json({ ok });
    });

    /* ── session ── */

    wss.on('connection', (ws, req) => {
        const url = new URL(req.url || WS_PATH, `http://${req.headers.host || 'localhost'}`);
        const connectionId = String(url.searchParams.get('connectionId') || '').trim();
        const viewport = {
            width: Number(url.searchParams.get('width')) || 0,
            height: Number(url.searchParams.get('height')) || 0,
        };
        const session = req.authSession || {};

        const fail = (message) => {
            try {
                ws.send(JSON.stringify({ type: 'error', message }));
            } catch { /* socket already gone */ }
            try { ws.close(1011, 'rdp-native'); } catch { /* already closed */ }
        };

        if (!connectionId) return fail('缺少 connectionId');

        let conn;
        try {
            conn = findConnection(connectionId, session);
        } catch (error) {
            return fail(`无权访问该连接：${error && error.message ? error.message : error}`);
        }
        if (!conn) return fail('连接不存在');
        if (String(conn.protocol || 'SSH').toUpperCase() !== 'RDP') {
            return fail('非 RDP 连接');
        }

        const binary = resolveHelperPath(
            helperPath ? { env: { ZEPHYR_ONE_RDP_HELPER: helperPath } } : undefined,
        );
        if (!binary) {
            return fail('未找到本机 RDP 组件（zephyr-one-rdp）。请重新安装 Zephyr One。');
        }

        let resolved;
        try {
            resolved = resolveCredentials(conn);
        } catch (error) {
            return fail(`无法读取连接凭据：${error && error.message ? error.message : error}`);
        }

        const mapping = conn.rdpStorage ? mappings.get(connectionId) : null;
        if (conn.rdpStorage && (!mapping || !mapping.folder)) {
            return fail('已启用文件夹映射，但尚未选择要映射的文件夹。请在连接设置里选择文件夹。');
        }

        const config = buildHelperConfig({ conn, resolved, mapping, viewport });

        let child;
        try {
            child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
            return fail(`无法启动本机 RDP 组件：${error.message}`);
        }

        let closed = false;
        const shutdown = (reason) => {
            if (closed) return;
            closed = true;
            try {
                if (child.stdin.writable) {
                    child.stdin.write(encodeFrame(MSG.STOP));
                    child.stdin.end();
                }
            } catch { /* pipe already gone */ }
            /* The helper aborts its connect and exits on STOP. The timer is the
             * backstop for a helper wedged in a syscall, so a closed tab cannot
             * leave an orphan holding the mapped folder open. */
            setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* already dead */ }
            }, 3000).unref?.();
            try { ws.close(1000, String(reason || 'closed')); } catch { /* closed */ }
        };

        /* Credentials go over the pipe, never argv: argv is world-readable. */
        try {
            child.stdin.write(encodeFrame(MSG.CONFIG, Buffer.from(JSON.stringify(config), 'utf8')));
        } catch (error) {
            shutdown('config-write-failed');
            return fail(`无法向本机 RDP 组件发送配置：${error.message}`);
        }

        let pendingOut = Buffer.alloc(0);
        child.stdout.on('data', (chunk) => {
            pendingOut = pendingOut.length ? Buffer.concat([pendingOut, chunk]) : chunk;
            const { frames, rest, error } = pumpFrames(pendingOut);
            pendingOut = rest;
            for (const body of frames) {
                if (ws.readyState !== ws.OPEN) return;
                /* Forwarded verbatim, minus the length prefix: WebSocket already
                 * frames, so re-prefixing would make the page strip a header the
                 * transport just guaranteed. */
                try { ws.send(body, { binary: true }); } catch { return; }
            }
            if (error) {
                logger.warn?.('[one-rdp] helper stream desynchronised', { connectionId, error });
                shutdown('helper-stream-error');
            }
        });

        /* FreeRDP's own diagnostics. Kept, because a TLS/NLA rejection is only
         * ever explained here. */
        let stderrTail = '';
        child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
        });

        child.on('error', (error) => {
            logger.warn?.('[one-rdp] helper spawn error', { connectionId, error: error.message });
            fail(`本机 RDP 组件启动失败：${error.message}`);
            shutdown('spawn-error');
        });

        child.on('exit', (code, signal) => {
            if (code) {
                logger.warn?.('[one-rdp] helper exited', {
                    connectionId, code, signal, stderr: stderrTail.slice(-1200),
                });
            }
            if (!closed && ws.readyState === ws.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        type: 'helper-exit', code, signal, detail: stderrTail.slice(-1200),
                    }));
                } catch { /* closing */ }
            }
            shutdown('helper-exit');
        });

        ws.on('message', (data, isBinary) => {
            if (!isBinary || closed) return;
            const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (!body.length) return;
            /* Reject anything the page has no business sending — above all
             * CONFIG, which would let it point the session somewhere else. */
            if (!CLIENT_ALLOWED.has(body[0])) {
                logger.warn?.('[one-rdp] rejected client message', { kind: body[0] });
                return;
            }
            try {
                if (child.stdin.writable) {
                    const out = Buffer.allocUnsafe(4 + body.length);
                    out.writeUInt32LE(body.length, 0);
                    body.copy(out, 4);
                    child.stdin.write(out);
                }
            } catch { /* pipe closed; exit handler cleans up */ }
        });

        ws.on('close', () => shutdown('ws-close'));
        ws.on('error', () => shutdown('ws-error'));

        logger.info?.('[one-rdp] session started', {
            connectionId,
            user: session.username,
            host: config.host,
            drive: config.drivePath ? `${config.driveName} → ${config.drivePath}` : 'none',
        });
    });

    /* Intercept the upgrade before the core's own handler, which destroys any
     * path not in its table. Wrapping instead of editing that table keeps the
     * routing for this endpoint inside this module. */
    const intercept = (target) => {
        if (!target) return;
        const previous = target.listeners('upgrade').slice();
        target.removeAllListeners('upgrade');
        target.on('upgrade', (req, socket, head) => {
            let pathname = '';
            try {
                pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
            } catch {
                pathname = req.url || '';
            }
            if (pathname !== WS_PATH) {
                for (const listener of previous) listener.call(target, req, socket, head);
                return;
            }
            const session = currentSession(req);
            if (!session || session.mustChangePassword) {
                rejectSocket(socket, session ? 403 : 401, session ? 'Forbidden' : 'Unauthorized');
                return;
            }
            req.authSession = session;
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        });
    };
    intercept(server);
    intercept(httpsServer);

    return { wss, mappings, pickers };
}

module.exports = {
    attach,
    MSG,
    CLIENT_ALLOWED,
    WS_PATH,
    MAX_HELPER_FRAME,
    resolveHelperPath,
    encodeFrame,
    pumpFrames,
    MappingStore,
    PickerQueue,
    resolveGeometry,
    buildHelperConfig,
};
