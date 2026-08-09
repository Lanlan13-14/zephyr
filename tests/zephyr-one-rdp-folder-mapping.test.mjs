import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * RDP folder mapping for Zephyr One.
 *
 * b0e5a9c removed the sidecar RDP helper and took two things with it that were
 * never helper-specific, only mounted there: the per-connection mapping store
 * and the folder-picker handoff. That left three live references dangling —
 * src-tauri/src/rdp_picker/mod.rs polling GET /api/one/rdp/picker-queue every
 * 300ms against a route that no longer existed, the #rdpStorageFolder /
 * #rdpStorageDeviceName / #rdpStourceFolderPickBtn controls in app.html with no
 * handler, and a 文件夹映射 switch that still persisted while nothing honoured it.
 *
 * These tests cover the restored module: the store, the queue state machine, the
 * path containment that keeps the byte route inside the mapped folder, the
 * enumeration caps, and the wiring that makes the shell's poll resolve again.
 */

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const mod = require('../zephyr-one-rdp-storage.js');
const { MappingStore, PickerQueue, listFolder, resolveInside, mountRoutes } = mod;

const SERVER_JS = read('server.js');
const OVERLAY_JS = read('zephyr-one-rdp-settings.js');
const CLIENT_JS = read('public/rdp-wasm-client.js');
const PICKER_RS = read('zephyr_one/src-tauri/src/rdp_picker/mod.rs');

/** Fresh temp dir per case; the store writes a real file. */
function tmp() {
    return mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-rdp-'));
}
function store(dir) {
    return new MappingStore({ filePath: path.join(dir, 'map.json') });
}

/* ── MappingStore ──────────────────────────────────────────────────────── */

test('an unmapped connection reads as empty rather than undefined', () => {
    const dir = tmp();
    try {
        // The editor reads this on every modal open, including for connections
        // that were never mapped, so it has to be a shape not a null.
        assert.deepEqual(store(dir).get('c1'), { folder: '', deviceName: '' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mapping round-trips through the file', () => {
    const dir = tmp();
    try {
        const s = store(dir);
        s.set('c1', { folder: dir, deviceName: 'PHONE' });
        // Re-read through a second instance: the first could have answered from
        // memory and hidden a broken write.
        assert.deepEqual(store(dir).get('c1'), { folder: dir, deviceName: 'PHONE' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clearing the folder deletes the entry instead of storing a blank', () => {
    const dir = tmp();
    try {
        const s = store(dir);
        s.set('c1', { folder: dir, deviceName: 'PHONE' });
        const cleared = s.set('c1', { folder: '', deviceName: 'PHONE' });
        // Otherwise toggling 文件夹映射 off and on again would silently restore a
        // path the user believed they had removed.
        assert.deepEqual(cleared, { folder: '', deviceName: '' });
        assert.deepEqual(s.get('c1'), { folder: '', deviceName: '' });
        assert.equal(JSON.parse(readFileSync(path.join(dir, 'map.json'), 'utf8')).c1, undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mappings are per connection', () => {
    const dir = tmp();
    try {
        const s = store(dir);
        s.set('c1', { folder: dir, deviceName: 'ONE' });
        s.set('c2', { folder: os.tmpdir(), deviceName: 'TWO' });
        assert.equal(s.get('c1').deviceName, 'ONE');
        assert.equal(s.get('c2').deviceName, 'TWO');
        s.remove('c1');
        assert.equal(s.get('c1').folder, '');
        assert.equal(s.get('c2').deviceName, 'TWO', 'removing one must not touch the other');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt mapping file does not stop the editor from opening', () => {
    const dir = tmp();
    try {
        writeFileSync(path.join(dir, 'map.json'), '{ this is not json');
        const s = store(dir);
        assert.deepEqual(s.get('c1'), { folder: '', deviceName: '' });
        // And it must recover on the next write rather than staying broken.
        s.set('c1', { folder: dir, deviceName: 'PHONE' });
        assert.equal(store(dir).get('c1').deviceName, 'PHONE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stored values are trimmed', () => {
    const dir = tmp();
    try {
        const s = store(dir);
        s.set('c1', { folder: '  ' + dir + '  ', deviceName: '  PHONE  ' });
        assert.deepEqual(s.get('c1'), { folder: dir, deviceName: 'PHONE' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a whitespace-only folder counts as cleared', () => {
    const dir = tmp();
    try {
        const s = store(dir);
        s.set('c1', { folder: dir, deviceName: 'PHONE' });
        s.set('c1', { folder: '   ', deviceName: 'PHONE' });
        assert.equal(s.get('c1').folder, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ── PickerQueue ───────────────────────────────────────────────────────── */

test('a filed request is claimable exactly once', () => {
    const q = new PickerQueue();
    const id = q.request('root');
    assert.deepEqual(q.claim(), { id, username: 'root' });
    // Two shells, or one shell polling twice before the dialog closes, must not
    // both open a chooser for the same request.
    assert.equal(q.claim(), null);
});

test('an empty queue claims to nothing', () => {
    assert.equal(new PickerQueue().claim(), null);
});

test('the picked path comes back through poll and is then forgotten', () => {
    const q = new PickerQueue();
    const id = q.request('root');
    q.claim();
    assert.equal(q.resolve(id, 'C:\\Users\\Test\\Shared'), true);
    assert.deepEqual(q.poll(id), { status: 'done', path: 'C:\\Users\\Test\\Shared', error: '' });
    // Terminal answers are read once. A stale id must not be answerable twice,
    // or a second modal open would inherit the previous pick.
    assert.equal(q.poll(id).status, 'unknown');
});

test('a cancelled dialog is reported, not left to time out', () => {
    const q = new PickerQueue();
    const id = q.request('root');
    q.claim();
    q.resolve(id, '', 'cancelled');
    const answer = q.poll(id);
    assert.equal(answer.status, 'done');
    assert.equal(answer.error, 'cancelled');
    assert.equal(answer.path, '');
});

test('a claimed but unanswered request still reads as pending', () => {
    const q = new PickerQueue();
    const id = q.request('root');
    q.claim();
    // The page polls while the OS chooser is open; it must keep waiting rather
    // than treating claimed as an answer.
    assert.deepEqual(q.poll(id), { status: 'pending', path: '', error: '' });
});

test('an unknown id is refused rather than invented', () => {
    const q = new PickerQueue();
    assert.equal(q.resolve('pick-nope', 'C:\\x'), false);
    assert.equal(q.poll('pick-nope').status, 'unknown');
});

test('requests expire so a dismissed dialog cannot pin one forever', () => {
    let now = 1_000_000;
    const q = new PickerQueue({ ttlMs: 5_000, now: () => now });
    const id = q.request('root');
    now += 5_001;
    assert.equal(q.claim(), null, 'an expired request must not be claimable');
    assert.equal(q.poll(id).status, 'unknown');
});

test('a request inside the TTL survives', () => {
    let now = 1_000_000;
    const q = new PickerQueue({ ttlMs: 5_000, now: () => now });
    const id = q.request('root');
    now += 4_999;
    assert.equal(q.claim().id, id);
});

test('ids stay unique when two requests land in the same millisecond', () => {
    // now() is frozen, so only the sequence counter separates them. Colliding
    // ids would let one pick resolve the other request.
    const q = new PickerQueue({ now: () => 42 });
    assert.notEqual(q.request('root'), q.request('root'));
});

test('the oldest pending request is claimed first', () => {
    let now = 1_000;
    const q = new PickerQueue({ now: () => (now += 1) });
    const first = q.request('a');
    q.request('b');
    assert.equal(q.claim().id, first);
});

/* ── path containment ──────────────────────────────────────────────────── */

test('a plain name inside the mapped folder resolves', () => {
    const dir = tmp();
    try {
        writeFileSync(path.join(dir, 'a.txt'), 'hello');
        assert.equal(resolveInside(dir, 'a.txt'), path.join(dir, 'a.txt'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a nested path inside the folder resolves', () => {
    const dir = tmp();
    try {
        mkdirSync(path.join(dir, 'sub'));
        writeFileSync(path.join(dir, 'sub', 'b.txt'), 'x');
        assert.equal(resolveInside(dir, 'sub/b.txt'), path.join(dir, 'sub', 'b.txt'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dot-dot escape is refused', () => {
    const dir = tmp();
    try {
        // The name arrives from the page, so traversal is an input to reject,
        // not an accident to tolerate.
        assert.equal(resolveInside(dir, '../outside.txt'), null);
        assert.equal(resolveInside(dir, 'sub/../../outside.txt'), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an absolute path outside the folder is refused', () => {
    const dir = tmp();
    try {
        const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
        assert.equal(resolveInside(dir, outside), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an embedded NUL is refused', () => {
    const dir = tmp();
    try {
        // path.resolve would happily build this and fs would throw a raw errno.
        assert.equal(resolveInside(dir, 'a\u0000.txt'), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty name is refused', () => {
    const dir = tmp();
    try {
        assert.equal(resolveInside(dir, ''), null);
        assert.equal(resolveInside(dir, undefined), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a name that does not exist is refused', () => {
    const dir = tmp();
    try {
        assert.equal(resolveInside(dir, 'missing.txt'), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a sibling folder sharing the prefix is not inside', () => {
    const base = tmp();
    try {
        const share = path.join(base, 'share');
        const secret = path.join(base, 'share-secret');
        mkdirSync(share);
        mkdirSync(secret);
        writeFileSync(path.join(secret, 'k.txt'), 'x');
        // startsWith(root) alone would accept share-secret as being inside
        // share. The separator in the comparison is what stops it.
        assert.equal(resolveInside(share, '../share-secret/k.txt'), null);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a symlink pointing out of the folder is refused', (t) => {
    const base = tmp();
    try {
        const share = path.join(base, 'share');
        const outside = path.join(base, 'outside');
        mkdirSync(share);
        mkdirSync(outside);
        writeFileSync(path.join(outside, 'secret.txt'), 'x');
        try {
            symlinkSync(path.join(outside, 'secret.txt'), path.join(share, 'link.txt'));
        } catch {
            // Windows needs SeCreateSymbolicLinkPrivilege. Skip rather than
            // pretend the case was covered.
            t.skip('symlink creation not permitted here');
            return;
        }
        // A plain string comparison on the unresolved path would accept this;
        // realpath is what catches it.
        assert.equal(resolveInside(share, 'link.txt'), null);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a folder that does not exist yields null rather than throwing', () => {
    assert.equal(resolveInside(path.join(os.tmpdir(), 'zephyr-one-absent-' + Date.now()), 'a.txt'), null);
});

/* ── enumeration ───────────────────────────────────────────────────────── */

test('the mapped folder lists its files with real sizes, sorted', () => {
    const dir = tmp();
    try {
        writeFileSync(path.join(dir, 'b.txt'), 'bb');
        writeFileSync(path.join(dir, 'a.txt'), 'a');
        const listed = listFolder(dir);
        assert.equal(listed.ok, true);
        // Stable order so the remote file list does not reshuffle between
        // sessions for no reason.
        assert.deepEqual(listed.files.map((f) => f.name), ['a.txt', 'b.txt']);
        assert.deepEqual(listed.files.map((f) => f.size), [1, 2]);
        assert.equal(listed.totalBytes, 3);
        assert.equal(listed.truncated, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub-directories are listed but not descended', () => {
    const dir = tmp();
    try {
        mkdirSync(path.join(dir, 'sub'));
        writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'deep');
        writeFileSync(path.join(dir, 'top.txt'), 'top');
        const listed = listFolder(dir);
        const sub = listed.files.find((f) => f.name === 'sub');
        assert.ok(sub, 'the directory must be reported');
        assert.equal(sub.isDir, true);
        assert.equal(sub.size, 0);
        // The WASM engine takes a flat list, so descending would advertise a
        // tree it cannot represent.
        assert.equal(listed.files.some((f) => f.name === 'deep.txt'), false);
        assert.equal(listed.totalBytes, 3, 'directory bytes must not be counted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the file-count cap reports truncation instead of dropping silently', () => {
    const dir = tmp();
    try {
        for (let i = 0; i < 5; i += 1) writeFileSync(path.join(dir, 'f' + i + '.txt'), 'x');
        const listed = listFolder(dir, { maxFiles: 3 });
        assert.equal(listed.files.length, 3);
        // The UI can only tell the user which files made it if the cap is
        // reported rather than applied quietly.
        assert.equal(listed.truncated, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the byte cap reports truncation', () => {
    const dir = tmp();
    try {
        writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(100));
        writeFileSync(path.join(dir, 'b.txt'), 'y'.repeat(100));
        const listed = listFolder(dir, { maxBytes: 150 });
        assert.equal(listed.files.length, 1);
        assert.equal(listed.totalBytes, 100);
        assert.equal(listed.truncated, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable folder is an error with a reason, not an empty share', () => {
    const listed = listFolder(path.join(os.tmpdir(), 'zephyr-one-absent-' + Date.now()));
    assert.equal(listed.ok, false);
    // An empty list would read as a working mapping of an empty folder, which
    // is exactly the confusion this avoids.
    assert.match(listed.error, /无法读取映射文件夹/);
});

test('an empty folder is a valid empty share', () => {
    const dir = tmp();
    try {
        const listed = listFolder(dir);
        assert.equal(listed.ok, true);
        assert.deepEqual(listed.files, []);
        assert.equal(listed.totalBytes, 0);
        assert.equal(listed.truncated, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the caps are bounded, since every shared byte is held in memory twice', () => {
    // Once page-side in rdpStorageFiles, once more by the structured clone into
    // the Worker. Unbounded here is an out-of-memory bug, not a slow share.
    assert.ok(mod.MAX_SHARED_FILES > 0 && mod.MAX_SHARED_FILES <= 1000);
    assert.ok(mod.MAX_SHARED_BYTES > 0 && mod.MAX_SHARED_BYTES <= 1024 * 1024 * 1024);
    assert.ok(mod.MAX_FILE_BYTES > 0 && mod.MAX_FILE_BYTES <= mod.MAX_SHARED_BYTES);
});

/* ── route wiring ──────────────────────────────────────────────────────── */

/** Record what mountRoutes registers, without standing up express. */
function fakeApp() {
    const routes = [];
    const record = (method) => (routePath, ...handlers) => {
        routes.push({ method, path: routePath, handlers });
    };
    return { routes, get: record('GET'), post: record('POST'), delete: record('DELETE') };
}

test('every endpoint the page and the shell call is mounted', () => {
    const app = fakeApp();
    const dir = tmp();
    try {
        const result = mountRoutes(app, {
            requireUser: (req, res, next) => next(),
            getSessionUser: () => ({ username: 'root' }),
            dataDir: dir,
        });
        const mounted = app.routes.map((r) => r.method + ' ' + r.path);
        for (const expected of [
            'GET /api/one/rdp/storage-mapping/:connectionId',
            'POST /api/one/rdp/storage-mapping/:connectionId',
            'DELETE /api/one/rdp/storage-mapping/:connectionId',
            'GET /api/one/rdp/storage-files/:connectionId',
            'GET /api/one/rdp/storage-file/:connectionId',
            'POST /api/one/rdp/pick-folder',
            'GET /api/one/rdp/pick-folder/:id',
            'GET /api/one/rdp/picker-queue',
            'POST /api/one/rdp/picker-queue/:id',
        ]) {
            assert.ok(mounted.includes(expected), expected + ' must be mounted');
        }
        assert.ok(result.mappings instanceof MappingStore);
        assert.ok(result.pickers instanceof PickerQueue);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no route is reachable without authentication', () => {
    const app = fakeApp();
    const dir = tmp();
    const requireUser = (req, res, next) => next();
    try {
        mountRoutes(app, { requireUser, getSessionUser: () => null, dataDir: dir });
        // These routes read the filesystem of the machine running the core. An
        // unauthenticated one is an arbitrary file read.
        for (const route of app.routes) {
            assert.equal(
                route.handlers[0],
                requireUser,
                route.method + ' ' + route.path + ' must sit behind requireUser',
            );
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the mapping file lands in the data dir it was given', () => {
    const dir = tmp();
    try {
        const { mappings } = mountRoutes(fakeApp(), {
            requireUser: (req, res, next) => next(),
            getSessionUser: () => null,
            dataDir: dir,
        });
        assert.equal(path.dirname(mappings.filePath), dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ── server integration ────────────────────────────────────────────────── */

test('the shell watcher now has the endpoints it polls', () => {
    /* This is the regression the module exists to fix. rdp_picker/mod.rs polls
     * one URL and posts to another; both had no route after b0e5a9c, so the
     * watcher 404d every 300ms for the life of the process. Deriving the paths
     * from the Rust source means renaming one side fails here. */
    assert.match(PICKER_RS, /api\/one\/rdp\/picker-queue/, 'the watcher must still poll this');
    const source = read('zephyr-one-rdp-storage.js');
    assert.match(source, /app\.get\('\/api\/one\/rdp\/picker-queue'/);
    assert.match(source, /app\.post\('\/api\/one\/rdp\/picker-queue\/:id'/);
});

test('server.js mounts the module only in embedded mode', () => {
    assert.match(SERVER_JS, /require\('\.\/zephyr-one-rdp-storage'\)/);
    const at = SERVER_JS.indexOf('mountOneRdpFolderMapping(app');
    assert.ok(at > 0, 'the mount call must exist');
    /* Load-bearing gate, not tidiness: these routes serve bytes out of an
     * absolute directory on the machine running the core. In One that is the
     * user's own desktop session. On a hosted Zephyr it is the server, which
     * would make any logged-in account an arbitrary file reader. */
    const guard = SERVER_JS.lastIndexOf('if (ZEPHYR_ONE_EMBEDDED) {', at);
    assert.ok(guard > 0 && guard < at, 'the mount must sit inside an embedded-only guard');
});

test('the overlay script is served only in embedded mode', () => {
    const at = SERVER_JS.indexOf("app.get('/zephyr-one-rdp-settings.js'");
    assert.ok(at > 0, 'the overlay route must exist');
    const body = SERVER_JS.slice(at, at + 600);
    assert.match(body, /if \(!ZEPHYR_ONE_EMBEDDED\) return next\(\);/);
});

/* ── page surface ──────────────────────────────────────────────────────── */

test('the overlay only calls endpoints the module actually mounts', () => {
    const app = fakeApp();
    const dir = tmp();
    try {
        mountRoutes(app, {
            requireUser: (req, res, next) => next(),
            getSessionUser: () => null,
            dataDir: dir,
        });
        /* Derived from the source rather than hard-coded, so a renamed route on
         * either side fails here instead of at runtime in the WebView. */
        const mountedPrefixes = app.routes.map((r) => r.path.replace(/\/:[^/]+$/, ''));
        const called = [...OVERLAY_JS.matchAll(/'(\/api\/one\/rdp\/[^']*)'/g)]
            .map((m) => m[1].replace(/\/$/, ''));
        assert.ok(called.length >= 2, 'the overlay must call the mapping and picker routes');
        for (const url of called) {
            assert.ok(
                mountedPrefixes.includes(url),
                url + ' is called by the overlay but not mounted',
            );
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the overlay wires the three controls app.js leaves alone', () => {
    /* rdp-folder-mapping-ui.test.mjs asserts app.js does *not* wire these: the
     * shared browser build cannot, since it can never learn a real path. That
     * makes this file the only thing that gives them behaviour. */
    assert.match(OVERLAY_JS, /rdpStorageFolderPickBtn/);
    assert.match(OVERLAY_JS, /rdpStorageFolder/);
    assert.match(OVERLAY_JS, /rdpStorageDeviceName/);
    assert.match(OVERLAY_JS, /addEventListener\('click'/);
});

test('the client loads the mapped folder at connect time', () => {
    assert.match(CLIENT_JS, /async function loadOneMappedFolder\(connectionId\)/);
    assert.match(CLIENT_JS, /await loadOneMappedFolder\(connectionId\)/);
    // Without this the mapping would be stored and never advertised.
    assert.match(CLIENT_JS, /storage-files\//);
    assert.match(CLIENT_JS, /storage-file\//);
});

test('the loader names nothing that is scoped inside initFilePanel', () => {
    /* connect() runs at module scope; setFilesHint, syncLocalFilesToRemote,
     * formatBytes and updatePendingFileList are all declared inside
     * initFilePanel(). Naming one from the loader is a ReferenceError, and `?.()`
     * would not save it — optional-call guards a null *value*, never an
     * undeclared binding. */
    const at = CLIENT_JS.indexOf('async function loadOneMappedFolder');
    assert.ok(at > 0);
    const end = CLIENT_JS.indexOf('\nasync function rdpStoragePickFiles', at);
    assert.ok(end > at, 'the loader must be followed by rdpStoragePickFiles');
    const body = CLIENT_JS.slice(at, end);
    for (const nested of ['setFilesHint', 'syncLocalFilesToRemote', 'updatePendingFileList', 'formatBytes']) {
        assert.equal(body.includes(nested), false, nested + ' is not in scope there');
    }
});

test('the loader replaces the shared list rather than appending to it', () => {
    const at = CLIENT_JS.indexOf('async function loadOneMappedFolder');
    const body = CLIENT_JS.slice(at, CLIENT_JS.indexOf('\nasync function rdpStoragePickFiles', at));
    // restartRdpWorkerInPlace() re-runs connect(), so appending would duplicate
    // every file on an in-place resize reconnect.
    assert.match(body, /rdpStorageFiles = loaded;/);
    assert.equal(/rdpStorageFiles\.push/.test(body), false);
});

test('the overlay script is injected into the embedded page once', () => {
    const { applyEmbeddedSurface, EMBED_RDP_SETTINGS_SCRIPT, countOccurrences } =
        require('../zephyr-one-embed-surface.js');
    const appHtml = read('public/app.html');
    const { html } = applyEmbeddedSurface(appHtml);
    assert.equal(countOccurrences(html, EMBED_RDP_SETTINGS_SCRIPT), 1);
    // After app.js, because the overlay queries markup app.js has already wired.
    assert.ok(html.indexOf(EMBED_RDP_SETTINGS_SCRIPT) > html.indexOf('app.js'));
    // Idempotent: sendEmbeddedAppPage transforms on every request.
    const { html: again } = applyEmbeddedSurface(html);
    assert.equal(countOccurrences(again, EMBED_RDP_SETTINGS_SCRIPT), 1);
});

