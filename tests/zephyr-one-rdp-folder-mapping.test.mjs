import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync as fsRealpath, closeSync } from 'node:fs';
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
const crypto = require('node:crypto');

const mod = require('../zephyr-one-rdp-storage.js');
const { ShellRequestAuthenticator, signedShellMessage } = require('../zephyr-one-security.js');
const {
    MappingStore,
    PickerQueue,
    listFolder,
    resolveInside,
    openFileInside,
    mountRoutes,
} = mod;

const SERVER_JS = read('server.js');
const OVERLAY_JS = read('zephyr-one-rdp-settings.js');
const CLIENT_JS = read('public/rdp-wasm-client.js');
const PICKER_RS = read('zephyr_one/src-tauri/src/rdp_picker/mod.rs');
const SHELL_SECRET = '0123456789abcdef'.repeat(4);
const SHELL_INSTANCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function signedPickerRequest(action, fields, req = {}, {
    secret = SHELL_SECRET,
    shellInstance = SHELL_INSTANCE,
    timestamp = String(Date.now()),
    nonce = crypto.randomBytes(20).toString('hex'),
} = {}) {
    const message = signedShellMessage(action, timestamp, nonce, shellInstance, fields);
    const mac = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
    const headers = {
        'x-zephyr-one-shell-instance': shellInstance,
        'x-zephyr-one-shell-timestamp': timestamp,
        'x-zephyr-one-shell-nonce': nonce,
        'x-zephyr-one-shell-mac': mac,
    };
    return {
        ...req,
        headers,
        get(name) { return headers[String(name).toLowerCase()] || ''; },
    };
}

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
    const id = q.request({ userId: 'u1', username: 'root', connectionId: 'c1' });
    assert.deepEqual(q.claim('u1'), { id, username: 'root' });
    // Two shells, or one shell polling twice before the dialog closes, must not
    // both open a chooser for the same request.
    assert.equal(q.claim('u1'), null);
});

test('an empty queue claims to nothing', () => {
    assert.equal(new PickerQueue().claim('u1'), null);
});

test('a picked path is persisted by the core while poll returns only display metadata', () => {
    const dir = tmp();
    try {
        let selected = null;
        const q = new PickerQueue({
            onSelected(entry, folder) {
                selected = { connectionId: entry.connectionId, folder };
                return true;
            },
        });
        const id = q.request({ userId: 'u1', username: 'root', connectionId: 'c1' });
        q.claim('u1');
        assert.equal(q.resolve(id, dir, '', 'u1'), true);
        const answer = q.poll(id, 'u1');
        assert.equal(answer.status, 'done');
        assert.equal(answer.selected, true);
        assert.equal(answer.folderLabel, path.basename(fsRealpath(dir)));
        assert.deepEqual(selected, { connectionId: 'c1', folder: fsRealpath(dir) });
        assert.equal('path' in answer, false);
        assert.equal('capability' in answer, false);
        assert.equal(answer.error, '');
        assert.equal(q.poll(id, 'u1').status, 'unknown');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cancelled dialog is reported, not left to time out', () => {
    const q = new PickerQueue();
    const id = q.request({ userId: 'u1', username: 'root', connectionId: 'c1' });
    q.claim('u1');
    q.resolve(id, '', 'cancelled', 'u1');
    const answer = q.poll(id, 'u1');
    assert.equal(answer.status, 'done');
    assert.equal(answer.error, 'cancelled');
    assert.equal(answer.selected, false);
    assert.equal(answer.folderLabel, '');
});

test('a claimed but unanswered request still reads as pending', () => {
    const q = new PickerQueue();
    const id = q.request({ userId: 'u1', username: 'root', connectionId: 'c1' });
    q.claim('u1');
    // The page polls while the OS chooser is open; it must keep waiting rather
    // than treating claimed as an answer.
    assert.deepEqual(q.poll(id, 'u1'), {
        status: 'pending', selected: false, folderLabel: '', error: '',
    });
});

test('an unknown id is refused rather than invented', () => {
    const q = new PickerQueue();
    assert.equal(q.resolve('pick-nope', 'C:\\x', '', 'u1'), false);
    assert.equal(q.poll('pick-nope', 'u1').status, 'unknown');
});

test('requests expire so a dismissed dialog cannot pin one forever', () => {
    let now = 1_000_000;
    const q = new PickerQueue({ ttlMs: 5_000, now: () => now });
    const id = q.request({ userId: 'u1', username: 'root', connectionId: 'c1' });
    now += 5_001;
    assert.equal(q.claim('u1'), null, 'an expired request must not be claimable');
    assert.equal(q.poll(id, 'u1').status, 'unknown');
});

test('a request inside the TTL survives', () => {
    let now = 1_000_000;
    const q = new PickerQueue({ ttlMs: 5_000, now: () => now });
    const id = q.request({ userId: 'u1', username: 'root', connectionId: 'c1' });
    now += 4_999;
    assert.equal(q.claim('u1').id, id);
});

test('ids stay unique when two requests land in the same millisecond', () => {
    // now() is frozen, so only the sequence counter separates them. Colliding
    // ids would let one pick resolve the other request.
    const q = new PickerQueue({ now: () => 42 });
    assert.notEqual(
        q.request({ userId: 'u1', username: 'root', connectionId: 'c1' }),
        q.request({ userId: 'u1', username: 'root', connectionId: 'c1' }),
    );
});

test('the oldest pending request is claimed first', () => {
    let now = 1_000;
    const q = new PickerQueue({ now: () => (now += 1) });
    const first = q.request({ userId: 'u1', username: 'a', connectionId: 'c1' });
    q.request({ userId: 'u1', username: 'b', connectionId: 'c2' });
    assert.equal(q.claim('u1').id, first);
});

test('picker requests cannot be claimed, resolved, or polled by another account', () => {
    const q = new PickerQueue();
    const id = q.request({ userId: 'alice-id', username: 'alice', connectionId: 'c1' });
    assert.equal(q.claim('bob-id'), null);
    assert.equal(q.inspect(id, 'bob-id'), null);
    assert.equal(q.poll(id, 'bob-id').status, 'unknown');
    assert.equal(q.claim('alice-id').id, id);
    assert.equal(q.resolve(id, '', 'cancelled', 'bob-id'), false);
    assert.equal(q.resolve(id, '', 'cancelled', 'alice-id'), true);
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

test('the opened-file path rejects a symlink escape and returns a verified handle', (t) => {
    const base = tmp();
    try {
        const share = path.join(base, 'share');
        const outside = path.join(base, 'outside');
        mkdirSync(share);
        mkdirSync(outside);
        writeFileSync(path.join(share, 'safe.txt'), 'safe');
        writeFileSync(path.join(outside, 'secret.txt'), 'secret');

        const opened = openFileInside(share, 'safe.txt');
        assert.ok(opened && Number.isInteger(opened.fd));
        assert.equal(opened.size, 4);
        closeSync(opened.fd);

        try {
            symlinkSync(path.join(outside, 'secret.txt'), path.join(share, 'escape.txt'));
        } catch {
            t.skip('symlink creation not permitted here');
            return;
        }
        assert.equal(openFileInside(share, 'escape.txt'), null);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the opened-file path rejects an escaping directory link', (t) => {
    const base = tmp();
    try {
        const share = path.join(base, 'share');
        const outside = path.join(base, 'outside');
        mkdirSync(share);
        mkdirSync(outside);
        writeFileSync(path.join(outside, 'secret.txt'), 'secret');
        try {
            symlinkSync(outside, path.join(share, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            t.skip('directory link creation not permitted here');
            return;
        }
        assert.equal(openFileInside(share, 'escape/secret.txt'), null);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('verified file opening enforces its byte ceiling before streaming', () => {
    const dir = tmp();
    try {
        writeFileSync(path.join(dir, 'large.txt'), '12345');
        assert.deepEqual(openFileInside(dir, 'large.txt', { maxBytes: 4 }), { tooLarge: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

function fakeResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        setHeader(name, value) { this.headers[name] = value; },
        end() { return this; },
    };
}

function invokeRoute(app, method, routePath, req) {
    const route = app.routes.find((candidate) => candidate.method === method && candidate.path === routePath);
    assert.ok(route, `${method} ${routePath} must exist`);
    const res = fakeResponse();
    route.handlers.at(-1)(req, res);
    return res;
}

function secureRouteHarness(dir, options = {}) {
    const app = fakeApp();
    const connections = new Map([
        ['c-alice', { id: 'c-alice', ownerUserId: 'alice-id' }],
        ['c-alice-2', { id: 'c-alice-2', ownerUserId: 'alice-id' }],
    ]);
    const authorizeConnection = options.authorizeConnection || ((user, id, capability) => {
        const connection = connections.get(id);
        if (!connection) throw Object.assign(new Error('connection not found'), { status: 404, code: 'not_found' });
        const owner = connection.ownerUserId === user.userId;
        const granted = Array.isArray(user.capabilities) && user.capabilities.includes(capability);
        if (!owner && !granted) throw Object.assign(new Error('connection not found'), { status: 404, code: 'not_found' });
        return connection;
    });
    const result = mountRoutes(app, {
        requireUser: (req, res, next) => next(),
        getSessionUser: (req) => req.user,
        authorizeConnection,
        verifyNativePicker: options.verifyNativePicker,
        dataDir: dir,
        logger: options.logger,
    });
    return { app, ...result };
}

test('mapping routes reject cross-account and unknown connections', () => {
    const dir = tmp();
    try {
        const { app } = secureRouteHarness(dir);
        const bob = { userId: 'bob-id', username: 'bob', capabilities: [] };
        for (const [method, routePath] of [
            ['GET', '/api/one/rdp/storage-mapping/:connectionId'],
            ['POST', '/api/one/rdp/storage-mapping/:connectionId'],
            ['DELETE', '/api/one/rdp/storage-mapping/:connectionId'],
        ]) {
            const denied = invokeRoute(app, method, routePath, {
                user: bob,
                params: { connectionId: 'c-alice' },
                query: { name: 'safe.txt' },
                body: {},
            });
            assert.equal(denied.statusCode, 404, `${method} ${routePath} cross-account`);

            const missing = invokeRoute(app, method, routePath, {
                user: { userId: 'alice-id', username: 'alice' },
                params: { connectionId: 'missing' },
                query: { name: 'safe.txt' },
                body: {},
            });
            assert.equal(missing.statusCode, 404, `${method} ${routePath} unknown connection`);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an explicit connection capability preserves legitimate shared access', () => {
    const dir = tmp();
    try {
        const { app } = secureRouteHarness(dir);
        const bob = { userId: 'bob-id', username: 'bob', capabilities: ['view', 'use'] };
        const mapping = invokeRoute(app, 'GET', '/api/one/rdp/storage-mapping/:connectionId', {
            user: bob,
            params: { connectionId: 'c-alice' },
        });
        assert.equal(mapping.statusCode, 200);
        assert.deepEqual(mapping.body, {
            ok: true, configured: false, folderLabel: '', deviceName: '',
        });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('page mapping updates cannot submit an absolute folder path', () => {
    const dir = tmp();
    try {
        const { app, mappings } = secureRouteHarness(dir);
        const response = invokeRoute(app, 'POST', '/api/one/rdp/storage-mapping/:connectionId', {
            user: { userId: 'alice-id', username: 'alice' },
            params: { connectionId: 'c-alice' },
            body: { enabled: true, folder: dir, deviceName: 'SHARE' },
        });
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.code, 'mapping_metadata_only');
        assert.equal(mappings.get('c-alice').folder, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native picker resolution atomically stores the path before page polling', () => {
    const dir = tmp();
    try {
        const { app, mappings } = secureRouteHarness(dir, {
            verifyNativePicker: () => true,
        });
        const alice = { userId: 'alice-id', username: 'alice' };
        const request = invokeRoute(app, 'POST', '/api/one/rdp/pick-folder', {
            user: alice,
            params: {},
            body: { connectionId: 'c-alice' },
        });
        const id = request.body.id;
        invokeRoute(app, 'GET', '/api/one/rdp/picker-queue', { user: alice, params: {} });
        const resolved = invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', {
            user: alice,
            params: { id },
            body: { path: dir, error: '' },
        });
        assert.equal(resolved.statusCode, 200);
        assert.equal(mappings.get('c-alice').folder, fsRealpath(dir));
        const polled = invokeRoute(app, 'GET', '/api/one/rdp/pick-folder/:id', {
            user: alice,
            params: { id },
        });
        assert.equal(polled.body.selected, true);
        assert.equal('path' in polled.body, false);
        assert.equal('capability' in polled.body, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native picker queue endpoints fail closed without native request authentication', () => {
    const dir = tmp();
    try {
        const { app, pickers } = secureRouteHarness(dir);
        const user = { userId: 'alice-id', username: 'alice' };
        const id = pickers.request({ userId: user.userId, username: user.username, connectionId: 'c-alice' });
        const response = invokeRoute(app, 'GET', '/api/one/rdp/picker-queue', {
            user,
            params: {},
        });
        assert.equal(response.statusCode, 403);
        assert.equal(response.body.code, 'native_picker_auth_required');

        const resolve = invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', {
            user,
            params: { id },
            body: { path: dir, error: '' },
        });
        assert.equal(resolve.statusCode, 403);
        assert.equal(resolve.body.code, 'native_picker_auth_required');
        assert.equal(pickers.inspect(id, user.userId).state, 'pending');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native picker shell authentication binds action and resolve fields and rejects replay', () => {
    const dir = tmp();
    try {
        const shellAuth = new ShellRequestAuthenticator({
            secret: SHELL_SECRET,
            shellInstance: SHELL_INSTANCE,
        });
        const { app, pickers, mappings } = secureRouteHarness(dir, {
            verifyNativePicker: (req, action, fields) => shellAuth.verify(req, action, fields).ok === true,
        });
        const user = { userId: 'alice-id', username: 'alice' };
        const id = pickers.request({ userId: user.userId, username: user.username, connectionId: 'c-alice' });

        const wrongAction = signedPickerRequest('unlock.claim', [], { user, params: {} });
        assert.equal(invokeRoute(app, 'GET', '/api/one/rdp/picker-queue', wrongAction).statusCode, 403);

        const signedClaim = signedPickerRequest('rdp_picker.claim', [], { user, params: {} });
        const claimed = invokeRoute(app, 'GET', '/api/one/rdp/picker-queue', signedClaim);
        assert.equal(claimed.statusCode, 200);
        assert.equal(claimed.body.id, id);
        assert.equal(
            invokeRoute(app, 'GET', '/api/one/rdp/picker-queue', signedClaim).statusCode,
            403,
            'claim nonce replay must be rejected',
        );

        const body = { path: dir, error: '' };
        const signedResolve = signedPickerRequest(
            'rdp_picker.resolve',
            [id, body.path, body.error],
            { user, params: { id }, body },
        );
        assert.equal(
            invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', {
                ...signedResolve,
                params: { id: id + '-substituted' },
            }).statusCode,
            403,
            'request id substitution must invalidate the MAC',
        );
        assert.equal(
            invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', {
                ...signedResolve,
                body: { path: path.join(dir, 'substituted'), error: '' },
            }).statusCode,
            403,
            'path substitution must invalidate the MAC',
        );
        assert.equal(
            invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', {
                ...signedResolve,
                body: { path: dir, error: 'substituted' },
            }).statusCode,
            403,
            'error substitution must invalidate the MAC',
        );

        assert.equal(
            invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', signedResolve).statusCode,
            200,
        );
        assert.equal(
            invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', signedResolve).statusCode,
            403,
            'resolve nonce replay must be rejected before queue state is consulted',
        );
        const publicResult = pickers.poll(id, user.userId);
        assert.equal(publicResult.selected, true);
        assert.equal('path' in publicResult, false);
        assert.equal(mappings.get('c-alice').folder, fsRealpath(dir));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('picker path and error values are not written to native resolve logs', () => {
    const dir = tmp();
    try {
        const shellAuth = new ShellRequestAuthenticator({
            secret: SHELL_SECRET,
            shellInstance: SHELL_INSTANCE,
        });
        const logs = [];
        const { app, pickers } = secureRouteHarness(dir, {
            verifyNativePicker: (req, action, fields) => shellAuth.verify(req, action, fields).ok === true,
            logger: { warn: (...values) => logs.push(values) },
        });
        const user = { userId: 'alice-id', username: 'alice' };
        const id = pickers.request({ userId: user.userId, username: user.username, connectionId: 'c-alice' });
        const pathMarker = 'C:\\PRIVATE_PICKER_PATH';
        const errorMarker = 'PRIVATE_PICKER_ERROR';
        const request = signedPickerRequest(
            'rdp_picker.resolve',
            [id, pathMarker, errorMarker],
            { user, params: { id }, body: { path: pathMarker, error: errorMarker } },
        );

        assert.equal(invokeRoute(app, 'POST', '/api/one/rdp/picker-queue/:id', request).statusCode, 400);
        const rendered = JSON.stringify(logs);
        assert.equal(rendered.includes(pathMarker), false);
        assert.equal(rendered.includes(errorMarker), false);
        assert.doesNotMatch(PICKER_RS, /eprintln!\([^;]*\{(?:path|error)\}/s);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('connection routes fail closed when the authorization seam is not wired', () => {
    const dir = tmp();
    try {
        const app = fakeApp();
        mountRoutes(app, {
            requireUser: (req, res, next) => next(),
            getSessionUser: (req) => req.user,
            dataDir: dir,
        });
        const response = invokeRoute(app, 'GET', '/api/one/rdp/storage-mapping/:connectionId', {
            user: { userId: 'alice-id', username: 'alice' },
            params: { connectionId: 'c-alice' },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.body.code, 'rdp_storage_authz_unavailable');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
    const mount = SERVER_JS.slice(at, at + 1_500);
    assert.match(mount, /authorizeConnection:\s*authorizeOneRdpConnection/);
    assert.match(mount, /verifyNativePicker:/);
    assert.match(mount, /oneSecurity\.verifyShellRequest\(/);
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

test('embedded core does not mount the retired renderer file bridge', () => {
    const storage = read('zephyr-one-rdp-storage.js');
    assert.doesNotMatch(storage, /app\.get\('\/api\/one\/rdp\/storage-files/);
    assert.doesNotMatch(storage, /app\.get\('\/api\/one\/rdp\/storage-file/);
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
