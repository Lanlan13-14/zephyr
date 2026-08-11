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
 *   The native queue is authenticated separately from the adopted web session.
 *   The core stores the selected path atomically and returns only display
 *   metadata to the page.
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

function canonicalDirectory(folderPath) {
    const requested = String(folderPath || '').trim();
    if (!requested || requested.includes('\u0000') || !path.isAbsolute(requested)) return null;
    try {
        if (fs.lstatSync(requested).isSymbolicLink()) return null;
        const canonical = fs.realpathSync(requested);
        if (!fs.statSync(canonical).isDirectory()) return null;
        return canonical;
    } catch {
        return null;
    }
}

function folderLabel(folder) {
    const canonical = String(folder || '');
    return path.basename(canonical) || (canonical ? 'Selected folder' : '');
}

function publicMapping(mapping) {
    const folder = String(mapping && mapping.folder || '');
    return {
        configured: Boolean(folder),
        folderLabel: folderLabel(folder),
        deviceName: String(mapping && mapping.deviceName || ''),
    };
}

/**
 * Folder-picker handoff between the WebView page and the Tauri shell.
 *
 * States: pending (filed, unclaimed) -> claimed (shell has the dialog open)
 * -> done (path or error recorded). poll() removes a done entry as it is read,
 * so a stale id cannot be answered twice.
 */
class PickerQueue {
    constructor({
        ttlMs = PICKER_TTL_MS,
        now = () => Date.now(),
        onSelected = () => true,
    } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.onSelected = onSelected;
        this.pending = new Map();
        this.seq = 0;
    }

    request({ userId, username, connectionId }) {
        this.sweep();
        const uid = String(userId || '');
        const cid = String(connectionId || '');
        if (!uid || !cid) return null;
        this.seq += 1;
        const id = 'pick-' + this.now() + '-' + this.seq;
        this.pending.set(id, {
            id,
            userId: uid,
            username: String(username || ''),
            connectionId: cid,
            createdAt: this.now(),
            state: 'pending',
            selected: false,
            folderLabel: '',
            error: '',
        });
        return id;
    }

    /** Oldest still-pending request, marked claimed so two shells cannot race. */
    claim(userId) {
        this.sweep();
        const uid = String(userId || '');
        for (const entry of this.pending.values()) {
            if (entry.state === 'pending' && entry.userId === uid) {
                entry.state = 'claimed';
                return { id: entry.id, username: entry.username };
            }
        }
        return null;
    }

    inspect(id, userId) {
        this.sweep();
        const entry = this.pending.get(String(id));
        if (!entry || entry.userId !== String(userId || '')) return null;
        return { connectionId: entry.connectionId, state: entry.state };
    }

    resolve(id, folderPath, error, userId) {
        this.sweep();
        const entry = this.pending.get(String(id));
        if (!entry || entry.userId !== String(userId || '') || entry.state !== 'claimed') return false;
        const rawError = String(error || '');
        const reportedError = rawError ? (rawError === 'cancelled' ? 'cancelled' : 'picker_failed') : '';
        let canonical = '';
        if (!reportedError) {
            canonical = canonicalDirectory(folderPath) || '';
            if (!canonical) return false;
            if (this.onSelected(entry, canonical) !== true) return false;
        }
        entry.state = 'done';
        entry.selected = Boolean(canonical);
        entry.folderLabel = folderLabel(canonical);
        entry.error = reportedError;
        return true;
    }

    poll(id, userId) {
        this.sweep();
        const entry = this.pending.get(String(id));
        if (!entry || entry.userId !== String(userId || '')) {
            return { status: 'unknown', selected: false, folderLabel: '', error: '' };
        }
        if (entry.state === 'done') {
            this.pending.delete(entry.id);
            return {
                status: 'done',
                selected: entry.selected,
                folderLabel: entry.folderLabel,
                error: entry.error,
            };
        }
        return { status: 'pending', selected: false, folderLabel: '', error: '' };
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
    if (!clean || clean.includes('\u0000') || path.isAbsolute(clean)) return null;
    let root;
    try {
        if (fs.lstatSync(folder).isSymbolicLink()) return null;
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
    if (!isPathInside(root, real)) return null;
    return real;
}

function isPathInside(root, target) {
    const relative = path.relative(root, target);
    return Boolean(relative) && relative !== '..'
        && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function hasSymlinkComponent(root, target) {
    const relative = path.relative(root, target);
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..' + path.sep) || relative === '..') {
        return true;
    }
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    }
    return false;
}

function sameOpenedFile(handleStat, pathStat) {
    return String(handleStat.dev) === String(pathStat.dev)
        && String(handleStat.ino) === String(pathStat.ino);
}

/**
 * Opens a regular file without trusting the pre-open realpath result. The
 * second path/identity check detects a symlink or rename swap between lookup
 * and open; Linux additionally exposes the kernel's path for the open handle.
 */
function openFileInside(folder, name, { maxBytes = MAX_FILE_BYTES } = {}) {
    const clean = String(name || '');
    if (!clean || clean.includes('\u0000') || path.isAbsolute(clean)) return null;
    let root;
    let candidate;
    let fd = null;
    try {
        if (fs.lstatSync(folder).isSymbolicLink()) return null;
        root = fs.realpathSync(folder);
        candidate = path.resolve(root, clean);
        if (!isPathInside(root, candidate) || hasSymlinkComponent(root, candidate)) return null;

        const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
        fd = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
        const handleStat = fs.fstatSync(fd);
        if (!handleStat.isFile() || handleStat.size > maxBytes) {
            fs.closeSync(fd);
            return handleStat.size > maxBytes ? { tooLarge: true } : null;
        }

        const afterPath = fs.realpathSync(candidate);
        if (!isPathInside(root, afterPath) || hasSymlinkComponent(root, candidate)) {
            fs.closeSync(fd);
            return null;
        }
        const afterStat = fs.statSync(afterPath);
        if (!sameOpenedFile(handleStat, afterStat)) {
            fs.closeSync(fd);
            return null;
        }

        if (process.platform === 'linux') {
            const handlePath = fs.realpathSync(`/proc/self/fd/${fd}`);
            if (!isPathInside(root, handlePath)) {
                fs.closeSync(fd);
                return null;
            }
        }
        return { fd, path: afterPath, size: handleStat.size };
    } catch {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
        }
        return null;
    }
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
        const canonical = canonicalDirectory(folder);
        if (!canonical) throw new Error('mapped folder is missing or is a symbolic link');
        entries = fs.readdirSync(canonical, { withFileTypes: true });
        folder = canonical;
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
 * @param {Function} deps.authorizeConnection enforces connection capabilities
 * @param {Function} deps.verifyNativePicker verifies the native shell request
 * @param {string}   deps.dataDir where the mapping file is written
 * @param {object}   [deps.logger]
 * @returns {{mappings: MappingStore, pickers: PickerQueue}}
 */
function mountRoutes(app, {
    requireUser,
    getSessionUser,
    authorizeConnection,
    verifyNativePicker,
    dataDir,
    logger = console,
}) {
    const mappings = new MappingStore({
        filePath: path.join(dataDir, 'one-rdp-folder-mappings.json'),
    });
    const pickers = new PickerQueue({
        onSelected(entry, folder) {
            try {
                const current = mappings.get(entry.connectionId);
                mappings.set(entry.connectionId, {
                    folder,
                    deviceName: current.deviceName || folderLabel(folder),
                });
                return true;
            } catch {
                return false;
            }
        },
    });

    const idOf = (req) => String(req.params.connectionId || '').trim();
    const userOf = (req) => (getSessionUser ? getSessionUser(req) : req.user) || null;
    const accessError = (res, error) => res.status(Number(error && error.status) || 403).json({
        ok: false,
        error: error && error.message ? error.message : 'connection access denied',
        code: error && error.code ? error.code : 'rdp_storage_forbidden',
    });
    const requireConnection = (req, res, connectionId, capability) => {
        const user = userOf(req);
        if (!user || !user.userId) {
            accessError(res, { status: 403, code: 'rdp_storage_identity_required', message: 'stable user identity required' });
            return null;
        }
        if (typeof authorizeConnection !== 'function') {
            accessError(res, { status: 503, code: 'rdp_storage_authz_unavailable', message: 'connection authorization unavailable' });
            return null;
        }
        try {
            const allowed = authorizeConnection(user, connectionId, capability);
            if (!allowed || (allowed && typeof allowed.then === 'function')) {
                accessError(res, { status: 404, code: 'rdp_storage_connection_not_found', message: 'connection not found' });
                return null;
            }
            return user;
        } catch (error) {
            accessError(res, error);
            return null;
        }
    };
    const nativePickerAllowed = (req, action, fields = []) => {
        try {
            return typeof verifyNativePicker === 'function'
                && verifyNativePicker(req, action, fields) === true;
        } catch {
            return false;
        }
    };

    app.get('/api/one/rdp/storage-mapping/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        if (!requireConnection(req, res, connectionId, 'view')) return undefined;
        res.json({ ok: true, ...publicMapping(mappings.get(connectionId)) });
    });

    app.post('/api/one/rdp/storage-mapping/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        if (!requireConnection(req, res, connectionId, 'edit')) return undefined;
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const allowedFields = new Set(['enabled', 'deviceName']);
        if (Object.keys(body).some((field) => !allowedFields.has(field))) {
            return res.status(400).json({
                ok: false,
                code: 'mapping_metadata_only',
                error: 'mapping updates accept display metadata only',
            });
        }
        if (body.enabled !== true) {
            mappings.remove(connectionId);
            return res.json({ ok: true, configured: false, folderLabel: '', deviceName: '' });
        }
        const existing = mappings.get(connectionId);
        if (!existing.folder) {
            return res.status(409).json({
                ok: false,
                code: 'native_picker_selection_required',
                error: 'select a folder with the native picker first',
            });
        }
        const saved = mappings.set(connectionId, {
            folder: existing.folder,
            deviceName: body.deviceName,
        });
        return res.json({ ok: true, ...publicMapping(saved) });
    });

    app.delete('/api/one/rdp/storage-mapping/:connectionId', requireUser, (req, res) => {
        const connectionId = idOf(req);
        if (!connectionId) return res.status(400).json({ ok: false, error: '缺少连接 id' });
        if (!requireConnection(req, res, connectionId, 'edit')) return undefined;
        mappings.remove(connectionId);
        res.json({ ok: true });
    });

    /* ── picker handoff ──────────────────────────────────────────────────── */

    /* Page side: file a request, then poll it. */
    app.post('/api/one/rdp/pick-folder', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const connectionId = String(body.connectionId || '').trim();
        if (!connectionId) return res.status(400).json({ ok: false, error: 'connection id required' });
        const user = requireConnection(req, res, connectionId, 'edit');
        if (!user) return undefined;
        const id = pickers.request({ userId: user.userId, username: user.username, connectionId });
        res.json({ ok: true, id });
    });

    app.get('/api/one/rdp/pick-folder/:id', requireUser, (req, res) => {
        const user = userOf(req);
        if (!user || !user.userId) return res.status(403).json({ ok: false, error: 'stable user identity required' });
        const entry = pickers.inspect(req.params.id, user.userId);
        if (!entry) {
            return res.json({ ok: true, status: 'unknown', selected: false, folderLabel: '', error: '' });
        }
        if (!requireConnection(req, res, entry.connectionId, 'edit')) return undefined;
        res.json({ ok: true, ...pickers.poll(req.params.id, user.userId) });
    });

    /* Shell side. requireUser identifies the account, while verifyNativePicker
     * proves the caller is the shell rather than page JavaScript in that same
     * adopted session. The verifier is deliberately required and fail-closed. */
    app.get('/api/one/rdp/picker-queue', requireUser, (req, res) => {
        if (!nativePickerAllowed(req, 'rdp_picker.claim')) {
            return res.status(403).json({ ok: false, code: 'native_picker_auth_required', error: 'native picker authentication required' });
        }
        const user = userOf(req);
        if (!user || !user.userId) return res.status(403).json({ ok: false, error: 'stable user identity required' });
        res.json(pickers.claim(user.userId) || { id: '', username: '' });
    });

    app.post('/api/one/rdp/picker-queue/:id', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (!nativePickerAllowed(req, 'rdp_picker.resolve', [req.params.id, body.path, body.error])) {
            return res.status(403).json({ ok: false, code: 'native_picker_auth_required', error: 'native picker authentication required' });
        }
        const user = userOf(req);
        if (!user || !user.userId) return res.status(403).json({ ok: false, error: 'stable user identity required' });
        const entry = pickers.inspect(req.params.id, user.userId);
        if (!entry) return res.status(404).json({ ok: false, error: 'picker request not found' });
        if (!requireConnection(req, res, entry.connectionId, 'edit')) return undefined;
        const ok = pickers.resolve(req.params.id, body.path, body.error, user.userId);
        if (!ok) logger.warn?.('[one-rdp] picker result for unknown id', { id: req.params.id });
        res.status(ok ? 200 : 400).json({ ok });
    });

    return { mappings, pickers };
}

module.exports = {
    mountRoutes,
    MappingStore,
    PickerQueue,
    canonicalDirectory,
    folderLabel,
    publicMapping,
    listFolder,
    resolveInside,
    openFileInside,
    PICKER_TTL_MS,
    MAX_SHARED_FILES,
    MAX_SHARED_BYTES,
    MAX_FILE_BYTES,
};
