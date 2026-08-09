/*
 * zephyr-one-rdp-storage.js — folder mapping for RDP sessions inside Zephyr One.
 *
 * Restores the two halves that b0e5a9c removed together with the sidecar helper:
 * the mapping store and the folder-picker handoff. Both were collateral damage.
 * They are not helper-specific — the helper only happened to be where they were
 * mounted — and removing them left three live references dangling:
 *
 *   1. src-tauri/src/rdp_picker/mod.rs still polls GET /api/one/rdp/picker-queue
 *      every 300ms and now 404s forever.
 *   2. public/app.html still ships #rdpStorageFolder, #rdpStorageDeviceName and
 *      #rdpStorageFolderPickBtn, none of which had a handler afterwards.
 *   3. The 文件夹映射 switch still persisted, promising a mapping nothing honoured.
 *
 * Why the mapping is stored here rather than on the connection record:
 *   A mapped folder is an absolute path on *this* machine. Browser Zephyr can
 *   never populate it — showDirectoryPicker() yields an opaque handle, never a
 *   path — so adding two columns to the shared schema would add fields only one
 *   client can ever write. The mapping therefore lives in One's own data dir and
 *   the shared schema is left untouched.
 *
 * Why the picker is a polled handoff rather than a Tauri invoke:
 *   The WebView navigates to the loopback core, so the page is a *remote* origin
 *   to Tauri and cannot invoke a command. Granting IPC to a loopback origin
 *   would hand it to any process that can bind a local port. So the page files a
 *   request, the Rust shell claims it, opens the OS dialog, and posts the path
 *   back — the same shape the shell already uses to follow the colour scheme.
 *
 * What the remote session actually receives:
 *   One runs the same WASM RDP engine as browser Zephyr, whose redirection path
 *   (rdpStorageGetFiles / rdpStorageReadFile, fed by bridge.setLocalFiles) takes
 *   a flat list of files held in memory. It is not an RDPDR mount of a live
 *   directory. So this module enumerates the mapped folder and serves those
 *   entries; the engine advertises them to the session. Sub-directories are
 *   reported but not descended, and the UI says so rather than implying a live
 *   disk. A real mount needs the in-process native engine, which is not built.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Folder-pick requests expire so a dismissed dialog cannot pin one forever. */
const PICKER_TTL_MS = 2 * 60 * 1000;

/*
 * Enumeration caps.
 *
 * Every advertised byte is held in memory twice — once page-side in
 * rdpStorageFiles, once more by the structured clone into the Worker — so an
 * unbounded folder is an out-of-memory bug, not a slow one. A share that
 * exceeds either cap is reported as truncated so the UI can say which files
 * made it instead of silently dropping the rest.
 */
const MAX_SHARED_FILES = 200;
const MAX_SHARED_BYTES = 256 * 1024 * 1024;
/** Per-file ceiling for the byte-serving route. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Per-connection {folder, deviceName}, persisted as one JSON file.
 *
 * Synchronous fs on purpose: the file is a few hundred bytes, it is read on
 * modal open and written on save, and an async write here would race a second
 * save of the same connection.
 */
class MappingStore {
    constructor({ filePath }) {
        this.filePath = filePath;
    }

    _load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            /* Missing or corrupt: an unreadable mapping file must not stop the
             * connection editor from opening. */
            return {};
        }
    }

    _persist(all) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2));
    }

    get(connectionId) {
        const entry = this._load()[String(connectionId)];
        if (!entry) return { folder: '', deviceName: '' };
        return {
            folder: String(entry.folder || ''),
            deviceName: String(entry.deviceName || ''),
        };
    }

    /** Empty folder clears the entry rather than storing a blank mapping. */
    set(connectionId, { folder, deviceName }) {
        const key = String(connectionId);
        const all = this._load();
        const cleanFolder = String(folder || '').trim();
        if (!cleanFolder) {
            delete all[key];
            this._persist(all);
            return { folder: '', deviceName: '' };
        }
        all[key] = {
            folder: cleanFolder,
            deviceName: String(deviceName || '').trim(),
        };
        this._persist(all);
        return { ...all[key] };
    }

    remove(connectionId) {
        const all = this._load();
        delete all[String(connectionId)];
        this._persist(all);
    }
}

/**
 * Folder-picker handoff between the WebView page and the Tauri shell.
 *
 * States: pending (filed, unclaimed) -> claimed (shell has the dialog open)
 * -> done (path or error recorded). poll() removes a done entry as it is read,
 * so a stale id cannot be answered twice.
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
        const id = 'pick-' + this.now() + '-' + this.seq;
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

    /** Oldest still-pending request, marked claimed so two shells cannot race. */
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

    poll(id) {
        this.sweep();
        const entry = this.pending.get(String(id));
        if (!entry) return { status: 'unknown', path: '', error: '' };
        if (entry.state === 'done') {
            this.pending.delete(entry.id);
            return { status: 'done', path: entry.path, error: entry.error };
        }
        return { status: 'pending', path: '', error: '' };
    }

    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, entry] of [...this.pending.entries()]) {
            if (entry.createdAt < cutoff) this.pending.delete(id);
        }
    }
}

/**
 * Reject a path that is not inside the mapped folder.
 *
 * The name arrives from the page, so `..` segments and absolute paths have to be
 * refused rather than trusted. realpathSync collapses symlinks too: a link
 * inside the share pointing at C:\\Users would otherwise read outside it. The
 * comparison appends the separator so /srv/share-secret is not accepted as being
 * inside /srv/share.
 *
 * @returns {string|null} the resolved absolute path, or null when it escapes
 */
function resolveInside(folder, name) {
    const clean = String(name || '');
    if (!clean || clean.includes('\u0000')) return null;
    let root;
    try {
        root = fs.realpathSync(folder);
    } catch {
        return null;
    }
    const target = path.resolve(root, clean);
    let real;
    try {
        real = fs.realpathSync(target);
    } catch {
        return null;
    }
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    return real;
}

/**
 * List the shareable entries of a mapped folder.
 *
 * Only the top level. Descending would need recursive size accounting and a
 * directory tree the WASM engine cannot represent anyway, so sub-directories are
 * listed with isDir so the UI can show them as not shared.
 *
 * @returns {{ok: true, files: Array, truncated: boolean, totalBytes: number}
 *          |{ok: false, error: string}}
 */
function listFolder(folder, { maxFiles = MAX_SHARED_FILES, maxBytes = MAX_SHARED_BYTES } = {}) {
    let entries;
    try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (error) {
        return { ok: false, error: '无法读取映射文件夹：' + error.message };
    }

    const files = [];
    let totalBytes = 0;
    let truncated = false;

    /* Stable order so the remote list does not reshuffle between sessions. */
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        if (files.length >= maxFiles) {
            truncated = true;
            break;
        }
        if (entry.isDirectory()) {
            files.push({ name: entry.name, size: 0, isDir: true });
            continue;
        }
        /* Anything that is neither a file nor a directory (socket, fifo, device)
         * has no meaning as a shared file and may block on open. */
        if (!entry.isFile()) continue;
        let stat;
        try {
            stat = fs.statSync(path.join(folder, entry.name));
        } catch {
            continue; /* vanished or unreadable between readdir and stat */
        }
        if (stat.size > MAX_FILE_BYTES) {
            truncated = true;
            continue;
        }
        if (totalBytes + stat.size > maxBytes) {
            truncated = true;
            break;
        }
        totalBytes += stat.size;
        files.push({ name: entry.name, size: stat.size, isDir: false, mtimeMs: stat.mtimeMs });
    }

    return { ok: true, files, truncated, totalBytes };
}

/**
 * Mount the folder-mapping routes.
 *
 * @param {object} app express app
 * @param {object} deps
 * @param {Function} deps.requireUser auth middleware; every route sits behind it
 * @param {Function} deps.getSessionUser (req) => user
 * @param {string}   deps.dataDir where the mapping file is written
 * @param {object}   [deps.logger]
 * @returns {{mappings: MappingStore, pickers: PickerQueue}}
 */
function mountRoutes(app, { requireUser, getSessionUser, dataDir, logger = console }) {
    const mappings = new MappingStore({
        filePath: path.join(dataDir, 'one-rdp-folder-mappings.json'),
    });
    const pickers = new PickerQueue();

    const idOf = (req) => String(req.params.connectionId || '').trim();

    app.get('/api/one/rdp/storage-mapping/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        res.json({ ok: true, ...mappings.get(connectionId) });
    });

    app.post('/api/one/rdp/storage-mapping/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const folder = String(body.folder || '').trim();

        /* Validate before storing. A path that does not exist would otherwise
         * surface as an empty share at connect time, where the user cannot tell
         * a typo from a broken feature. */
        if (folder) {
            let stat;
            try {
                stat = fs.statSync(folder);
            } catch {
                return res.status(400).json({ ok: false, error: '文件夹不存在或无权访问' });
            }
            if (!stat.isDirectory()) {
                return res.status(400).json({ ok: false, error: '所选路径不是文件夹' });
            }
        }

        const saved = mappings.set(connectionId, { folder, deviceName: body.deviceName });
        res.json({ ok: true, ...saved });
    });

    app.delete('/api/one/rdp/storage-mapping/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        mappings.remove(connectionId);
        res.json({ ok: true });
    });

    /*
     * What the RDP session advertises. Returns metadata only; bytes come from
     * the file route below, one request per file, so a large share streams
     * instead of arriving as one enormous JSON body.
     */
    app.get('/api/one/rdp/storage-files/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        const mapping = mappings.get(connectionId);
        if (!mapping.folder) {
            return res.json({ ok: true, folder: '', deviceName: '', files: [], truncated: false, totalBytes: 0 });
        }
        const listed = listFolder(mapping.folder);
        if (!listed.ok) return res.status(400).json({ ok: false, error: listed.error });
        res.json({
            ok: true,
            folder: mapping.folder,
            deviceName: mapping.deviceName,
            files: listed.files,
            truncated: listed.truncated,
            totalBytes: listed.totalBytes,
        });
    });

    app.get('/api/one/rdp/storage-file/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        const mapping = mappings.get(connectionId);
        if (!mapping.folder) return res.status(404).json({ ok: false, error: '未配置映射文件夹' });

        const resolved = resolveInside(mapping.folder, req.query.name);
        if (!resolved) return res.status(400).json({ ok: false, error: '文件名不合法' });

        let stat;
        try {
            stat = fs.statSync(resolved);
        } catch {
            return res.status(404).json({ ok: false, error: '文件不存在' });
        }
        if (!stat.isFile()) return res.status(400).json({ ok: false, error: '不是文件' });
        if (stat.size > MAX_FILE_BYTES) return res.status(413).json({ ok: false, error: '文件过大' });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        /* Streamed rather than readFileSync: this runs on the core's event loop,
         * and a 64MB synchronous read would stall every other request. */
        const stream = fs.createReadStream(resolved);
        stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
        stream.pipe(res);
    });

    /* ── picker handoff ──────────────────────────────────────────────────── */

    /* Page side: file a request, then poll it. */
    app.post('/api/one/rdp/pick-folder', requireUser, (req, res) => {
        const user = getSessionUser ? getSessionUser(req) : null;
        const id = pickers.request(user && user.username);
        res.json({ ok: true, id });
    });

    app.get('/api/one/rdp/pick-folder/:id', requireUser, (req, res) => {
        res.json({ ok: true, ...pickers.poll(req.params.id) });
    });

    /*
     * Shell side. Behind requireUser like every other route: the shell rides the
     * same adopted local session as the WebView, because adoptEmbeddedLocalSession
     * is global middleware and a cookieless loopback request authenticates as the
     * local account.
     */
    app.get('/api/one/rdp/picker-queue', requireUser, (req, res) => {
        res.json(pickers.claim() || { id: '', username: '' });
    });

    app.post('/api/one/rdp/picker-queue/:id', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const ok = pickers.resolve(req.params.id, body.path, body.error);
        if (!ok) logger.warn?.('[one-rdp] picker result for unknown id', { id: req.params.id });
        res.json({ ok });
    });

    return { mappings, pickers };
}

module.exports = {
    mountRoutes,
    MappingStore,
    PickerQueue,
    listFolder,
    resolveInside,
    PICKER_TTL_MS,
    MAX_SHARED_FILES,
    MAX_SHARED_BYTES,
    MAX_FILE_BYTES,
};
