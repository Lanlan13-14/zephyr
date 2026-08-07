/*
 * Contract tests for the Zephyr One native RDP bridge.
 *
 * What these are for, specifically:
 *   - The wire protocol constants must equal the Rust helper's. A silent drift
 *     here turns every input into a rejected or misread message, and nothing
 *     else in the stack would notice.
 *   - Frame reassembly must survive arbitrary stdio chunk boundaries. A 33 MB
 *     frame always arrives split; getting it wrong desynchronises the stream
 *     permanently instead of dropping one frame.
 *   - The password must come from the core's credential resolver and never from
 *     the stored (encrypted) connection field.
 *   - CONFIG must be unacceptable from the browser: accepting one would let the
 *     page retarget the session or swap the mapped folder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../zephyr-one-rdp-native.js');
const {
    MSG, CLIENT_ALLOWED, WS_PATH, MAX_HELPER_FRAME,
    resolveHelperPath, encodeFrame, pumpFrames,
    MappingStore, PickerQueue, resolveGeometry, buildHelperConfig,
} = bridge;

function tempDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `zephyr-one-rdp-${label}-`));
}

/* ── wire protocol ─────────────────────────────────────────────────────── */

test('message type constants match native/zephyr-one-rdp/src/proto.rs', () => {
    assert.equal(MSG.CONFIG, 0x00);
    assert.equal(MSG.MOUSE, 0x01);
    assert.equal(MSG.MOUSE_EX, 0x02);
    assert.equal(MSG.SCANCODE, 0x03);
    assert.equal(MSG.UNICODE, 0x04);
    assert.equal(MSG.SYNC, 0x05);
    assert.equal(MSG.RESIZE, 0x06);
    assert.equal(MSG.CLIPBOARD, 0x07);
    assert.equal(MSG.FULL_FRAME, 0x08);
    assert.equal(MSG.STOP, 0x09);
    assert.equal(MSG.FRAME, 0x81);
    assert.equal(MSG.EVENT, 0x82);
});

test('the browser may not originate CONFIG', () => {
    assert.equal(CLIENT_ALLOWED.has(MSG.CONFIG), false,
        'CONFIG carries credentials and the target host; it must be server-built');
    assert.equal(CLIENT_ALLOWED.has(MSG.FRAME), false, 'FRAME is helper→host only');
    assert.equal(CLIENT_ALLOWED.has(MSG.EVENT), false, 'EVENT is helper→host only');
    for (const kind of [MSG.MOUSE, MSG.SCANCODE, MSG.UNICODE, MSG.SYNC,
        MSG.RESIZE, MSG.CLIPBOARD, MSG.FULL_FRAME, MSG.STOP]) {
        assert.equal(CLIENT_ALLOWED.has(kind), true, `kind 0x${kind.toString(16)} must be allowed`);
    }
});

test('encodeFrame writes a u32 LE length that counts the kind byte', () => {
    const frame = encodeFrame(MSG.MOUSE, Buffer.from([1, 2, 3, 4, 5, 6]));
    assert.equal(frame.readUInt32LE(0), 7, 'length = 1 kind byte + 6 payload bytes');
    assert.equal(frame[4], MSG.MOUSE);
    assert.deepEqual([...frame.subarray(5)], [1, 2, 3, 4, 5, 6]);
    assert.equal(frame.length, 11);
});

test('encodeFrame handles payloadless messages', () => {
    const frame = encodeFrame(MSG.STOP);
    assert.equal(frame.readUInt32LE(0), 1);
    assert.equal(frame[4], MSG.STOP);
    assert.equal(frame.length, 5);
});

/* ── frame reassembly ──────────────────────────────────────────────────── */

test('pumpFrames strips the length prefix and returns bodies', () => {
    const wire = Buffer.concat([
        encodeFrame(MSG.FRAME, Buffer.from('abc')),
        encodeFrame(MSG.EVENT, Buffer.from('{}')),
    ]);
    const { frames, rest, error } = pumpFrames(wire);
    assert.equal(error, null);
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 2);
    assert.equal(frames[0][0], MSG.FRAME);
    assert.equal(frames[0].subarray(1).toString(), 'abc');
    assert.equal(frames[1][0], MSG.EVENT);
    assert.equal(frames[1].subarray(1).toString(), '{}');
});

test('pumpFrames reassembles across every possible split point', () => {
    const wire = Buffer.concat([
        encodeFrame(MSG.FRAME, Buffer.from('hello-frame')),
        encodeFrame(MSG.EVENT, Buffer.from('{"type":"connected"}')),
    ]);
    for (let cut = 0; cut <= wire.length; cut++) {
        const first = pumpFrames(wire.subarray(0, cut));
        assert.equal(first.error, null, `split ${cut} reported an error early`);
        const second = pumpFrames(Buffer.concat([first.rest, wire.subarray(cut)]));
        assert.equal(second.error, null, `split ${cut} reported an error late`);
        const total = first.frames.length + second.frames.length;
        assert.equal(total, 2, `split ${cut} yielded ${total} frames, want 2`);
        const bodies = [...first.frames, ...second.frames];
        assert.equal(bodies[0].subarray(1).toString(), 'hello-frame');
        assert.equal(bodies[1].subarray(1).toString(), '{"type":"connected"}');
    }
});

test('pumpFrames holds an incomplete header instead of guessing', () => {
    const wire = encodeFrame(MSG.FRAME, Buffer.from('xyz'));
    const { frames, rest, error } = pumpFrames(wire.subarray(0, 3));
    assert.equal(error, null);
    assert.equal(frames.length, 0);
    assert.equal(rest.length, 3, 'the partial header must be retained');
});

test('pumpFrames rejects an out-of-range length rather than buffering forever', () => {
    const bogus = Buffer.alloc(8);
    bogus.writeUInt32LE(MAX_HELPER_FRAME + 1, 0);
    const { error } = pumpFrames(bogus);
    assert.ok(error, 'an oversized length prefix must be reported');

    const zero = Buffer.alloc(8);
    zero.writeUInt32LE(0, 0);
    assert.ok(pumpFrames(zero).error, 'a zero length prefix is invalid: the kind byte is mandatory');
});

/* ── helper discovery ──────────────────────────────────────────────────── */

test('the shell-provided helper path wins over every fallback', () => {
    const found = resolveHelperPath({
        env: { ZEPHYR_ONE_RDP_HELPER: '/opt/zephyr/zephyr-one-rdp' },
        cwd: '/somewhere',
        exists: (p) => p === '/opt/zephyr/zephyr-one-rdp' || p === '/somewhere/zephyr-one-rdp',
    });
    assert.equal(found, '/opt/zephyr/zephyr-one-rdp');
});

test('a non-existent env override falls through to the development paths', () => {
    const found = resolveHelperPath({
        env: { ZEPHYR_ONE_RDP_HELPER: '/nope/zephyr-one-rdp' },
        cwd: '/core',
        exists: (p) => p === path.join('/core', 'bin', 'zephyr-one-rdp'),
    });
    assert.equal(found, path.join('/core', 'bin', 'zephyr-one-rdp'));
});

test('resolveHelperPath reports absence rather than a guessed path', () => {
    assert.equal(resolveHelperPath({ env: {}, cwd: '/core', exists: () => false }), null);
});

/* ── geometry ──────────────────────────────────────────────────────────── */

test('named resolutions map to their pixel sizes', () => {
    assert.deepEqual(resolveGeometry('1080p', {}), { width: 1920, height: 1080 });
    assert.deepEqual(resolveGeometry('2K', {}), { width: 2560, height: 1440 });
    assert.deepEqual(resolveGeometry('4K', {}), { width: 3840, height: 2160 });
    assert.deepEqual(resolveGeometry('8K', {}), { width: 7680, height: 4320 });
});

test('auto follows the viewport, and every result is even and in range', () => {
    assert.deepEqual(resolveGeometry('auto', { width: 1365, height: 767 }),
        { width: 1364, height: 766 });
    assert.deepEqual(resolveGeometry('auto', { width: 10, height: 10 }),
        { width: 200, height: 200 }, 'below DISPLAY_CONTROL_MIN must clamp up');
    assert.deepEqual(resolveGeometry('auto', { width: 99999, height: 99999 }),
        { width: 8192, height: 8192 }, 'above DISPLAY_CONTROL_MAX must clamp down');
    assert.deepEqual(resolveGeometry('auto', {}), { width: 1920, height: 1080 },
        'a missing viewport must not produce a zero-sized desktop');
});

test('an unknown resolution name degrades to 1080p instead of zero', () => {
    assert.deepEqual(resolveGeometry('banana', {}), { width: 1920, height: 1080 });
});

/* ── config assembly ───────────────────────────────────────────────────── */

const baseConn = Object.freeze({
    id: 'c1',
    protocol: 'RDP',
    host: '10.0.0.5',
    port: 3389,
    username: 'Administrator',
    password: 'ENCRYPTED-BLOB-DO-NOT-USE',
    rdpStorage: true,
    rdpClipboard: true,
    rdpFps: 30,
    rdpQuality: 'balanced',
    rdpResolution: '1080p',
    rdpSoundMode: 'local',
});

test('the password comes from the resolver, never from the stored record', () => {
    const config = buildHelperConfig({
        conn: baseConn,
        resolved: { username: 'Administrator', password: 'from-vault' },
        mapping: { folder: '/data/share', deviceName: 'Share' },
        viewport: {},
    });
    assert.equal(config.password, 'from-vault');
    assert.ok(!JSON.stringify(config).includes('ENCRYPTED-BLOB-DO-NOT-USE'),
        'the encrypted record field must never reach the helper');
});

test('a DOMAIN\\user username is split into domain and user', () => {
    const config = buildHelperConfig({
        conn: baseConn,
        resolved: { username: 'CORP\\alice', password: 'p' },
        mapping: null,
        viewport: {},
    });
    assert.equal(config.domain, 'CORP');
    assert.equal(config.username, 'alice');
});

test('an explicit domain is not overwritten by a bare username', () => {
    const config = buildHelperConfig({
        conn: { ...baseConn, rdpDomain: 'EXPLICIT' },
        resolved: { username: 'alice', password: 'p' },
        mapping: null,
        viewport: {},
    });
    assert.equal(config.domain, 'EXPLICIT');
    assert.equal(config.username, 'alice');
});

test('folder mapping reaches the helper as driveName + drivePath', () => {
    const config = buildHelperConfig({
        conn: baseConn,
        resolved: { username: 'a', password: 'b' },
        mapping: { folder: '/data/share', deviceName: 'MyShare', readOnly: true },
        viewport: {},
    });
    assert.equal(config.drivePath, '/data/share');
    assert.equal(config.driveName, 'MyShare');
    assert.equal(config.driveReadOnly, true);
});

test('an unnamed mapping defaults the share name to the folder basename', () => {
    const config = buildHelperConfig({
        conn: baseConn,
        resolved: { username: 'a', password: 'b' },
        mapping: { folder: '/home/me/项目资料', deviceName: '' },
        viewport: {},
    });
    assert.equal(config.driveName, '项目资料',
        'an empty share name would make the shim refuse the mapping outright');
});

test('the toggle being off suppresses the mapping even when one is stored', () => {
    const config = buildHelperConfig({
        conn: { ...baseConn, rdpStorage: false },
        resolved: { username: 'a', password: 'b' },
        mapping: { folder: '/data/share', deviceName: 'MyShare' },
        viewport: {},
    });
    assert.equal(config.drivePath, '');
    assert.equal(config.driveName, '',
        'a stored folder must not be mapped when the user turned the toggle off');
});

test('audio and clipboard toggles round-trip in both directions', () => {
    for (const mode of ['local', 'remote', 'off']) {
        const config = buildHelperConfig({
            conn: { ...baseConn, rdpSoundMode: mode },
            resolved: {}, mapping: null, viewport: {},
        });
        assert.equal(config.audioMode, mode);
    }
    assert.equal(buildHelperConfig({
        conn: { ...baseConn, rdpClipboard: false }, resolved: {}, mapping: null, viewport: {},
    }).clipboard, false);
    assert.equal(buildHelperConfig({
        conn: { ...baseConn, rdpMicrophone: true }, resolved: {}, mapping: null, viewport: {},
    }).microphone, true);
});

test('quality=performance turns off the desktop effects, quality=quality enables GFX', () => {
    const perf = buildHelperConfig({
        conn: { ...baseConn, rdpQuality: 'performance' }, resolved: {}, mapping: null, viewport: {},
    });
    assert.equal(perf.disableWallpaper, true);
    assert.equal(perf.disableThemes, true);
    assert.equal(perf.allowFontSmoothing, false);
    assert.equal(perf.gfx, false);

    const quality = buildHelperConfig({
        conn: { ...baseConn, rdpQuality: 'quality' }, resolved: {}, mapping: null, viewport: {},
    });
    assert.equal(quality.gfx, true);
    assert.equal(quality.disableWallpaper, false);

    const balanced = buildHelperConfig({
        conn: baseConn, resolved: {}, mapping: null, viewport: {},
    });
    assert.equal(balanced.gfx, false, 'balanced must not request a codec Alpine cannot decode');
});

test('maxFps is clamped into a sane range', () => {
    assert.equal(buildHelperConfig({
        conn: { ...baseConn, rdpFps: 0 }, resolved: {}, mapping: null, viewport: {},
    }).maxFps, 30, 'zero would divide by zero in the paint thread');
    assert.equal(buildHelperConfig({
        conn: { ...baseConn, rdpFps: 9999 }, resolved: {}, mapping: null, viewport: {},
    }).maxFps, 240);
});

/* ── mapping persistence ───────────────────────────────────────────────── */

test('mappings persist per connection and survive a reload', () => {
    const dir = tempDir('map');
    const file = path.join(dir, 'm.json');
    const store = new MappingStore(file);

    assert.equal(store.get('c1'), null, 'an unmapped connection reports null, not a blank mapping');
    store.set('c1', { folder: '/data/one', deviceName: 'One' });
    store.set('c2', { folder: '/data/two', deviceName: 'Two', readOnly: true });

    const reloaded = new MappingStore(file);
    assert.deepEqual(reloaded.get('c1'), { folder: '/data/one', deviceName: 'One', readOnly: false });
    assert.deepEqual(reloaded.get('c2'), { folder: '/data/two', deviceName: 'Two', readOnly: true });

    reloaded.remove('c1');
    assert.equal(new MappingStore(file).get('c1'), null);
    assert.ok(new MappingStore(file).get('c2'), 'removing one mapping must not disturb another');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt mapping file degrades to empty instead of throwing', () => {
    const dir = tempDir('corrupt');
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{ this is not json');
    const store = new MappingStore(file);
    assert.equal(store.get('c1'), null);
    store.set('c1', { folder: '/x', deviceName: 'X' });
    assert.deepEqual(new MappingStore(file).get('c1'),
        { folder: '/x', deviceName: 'X', readOnly: false });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('CJK folders and share names survive the round trip', () => {
    const dir = tempDir('cjk');
    const file = path.join(dir, 'm.json');
    new MappingStore(file).set('c1', { folder: '/home/me/项目资料', deviceName: '资料' });
    assert.deepEqual(new MappingStore(file).get('c1'),
        { folder: '/home/me/项目资料', deviceName: '资料', readOnly: false });
    fs.rmSync(dir, { recursive: true, force: true });
});

/* ── picker handoff ────────────────────────────────────────────────────── */

test('a picker request is claimed once and answered once', () => {
    const q = new PickerQueue();
    const id = q.request('alice');
    assert.equal(q.poll(id).state, 'pending');

    const claimed = q.claim();
    assert.equal(claimed.id, id);
    assert.equal(claimed.username, 'alice');
    assert.equal(q.claim(), null, 'a claimed request must not be handed out twice');

    assert.equal(q.poll(id).state, 'claimed');
    assert.equal(q.resolve(id, '/picked/folder'), true);

    const answer = q.poll(id);
    assert.equal(answer.state, 'done');
    assert.equal(answer.path, '/picked/folder');
    assert.equal(q.poll(id).state, 'unknown', 'a read answer is consumed, not replayed');
});

test('a cancelled pick carries the reason, not a silent empty path', () => {
    const q = new PickerQueue();
    const id = q.request('alice');
    q.claim();
    q.resolve(id, '', 'cancelled');
    const answer = q.poll(id);
    assert.equal(answer.state, 'done');
    assert.equal(answer.path, '');
    assert.equal(answer.error, 'cancelled');
});

test('stale picker requests expire so an unattended shell cannot leak them', () => {
    let now = 1000;
    const q = new PickerQueue({ ttlMs: 500, now: () => now });
    const id = q.request('alice');
    now += 501;
    assert.equal(q.poll(id).state, 'unknown');
    assert.equal(q.claim(), null);
});

test('resolving an unknown id is refused rather than inventing an entry', () => {
    const q = new PickerQueue();
    assert.equal(q.resolve('no-such-id', '/x'), false);
});

/* ── mounting ──────────────────────────────────────────────────────────── */

function stubHost() {
    const routes = { get: [], post: [] };
    const listeners = [];
    const app = {
        get: (route) => routes.get.push(route),
        post: (route) => routes.post.push(route),
    };
    const server = {
        listeners: () => listeners.slice(),
        removeAllListeners: () => { listeners.length = 0; },
        on: (_event, fn) => listeners.push(fn),
    };
    class FakeWss {
        constructor(opts) { this.opts = opts; this.handlers = {}; }
        on(event, fn) { this.handlers[event] = fn; }
        emit(event, ...args) { this.handlers[event]?.(...args); }
        handleUpgrade(req, socket, head, cb) { cb({ readyState: 1, OPEN: 1 }); }
    }
    return { app, server, routes, listeners, FakeWss };
}

test('attach mounts the mapping and picker routes', () => {
    const dir = tempDir('attach');
    const { app, server, routes, FakeWss } = stubHost();
    const result = bridge.attach({
        app,
        server,
        httpsServer: null,
        WebSocketServer: FakeWss,
        dataDir: dir,
        currentSession: () => ({ username: 'alice' }),
        requireUser: (req, res, next) => next(),
        rejectSocket: () => {},
        findConnection: () => null,
        resolveCredentials: () => ({}),
        logger: { info() {}, warn() {} },
    });

    assert.ok(routes.get.includes('/api/one/rdp/storage-mapping/:id'));
    assert.ok(routes.post.includes('/api/one/rdp/storage-mapping/:id'));
    assert.ok(routes.post.includes('/api/one/rdp/pick-folder'));
    assert.ok(routes.get.includes('/api/one/rdp/pick-folder/:id'));
    assert.ok(routes.get.includes('/api/one/rdp/picker-queue'));
    assert.ok(routes.post.includes('/api/one/rdp/picker-queue/:id'));
    assert.ok(result.mappings instanceof MappingStore);
    assert.ok(result.pickers instanceof PickerQueue);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the upgrade wrapper forwards foreign paths to the core untouched', () => {
    const dir = tempDir('upgrade');
    const { app, server, listeners, FakeWss } = stubHost();

    const coreSeen = [];
    listeners.push((req) => coreSeen.push(req.url));

    bridge.attach({
        app,
        server,
        httpsServer: null,
        WebSocketServer: FakeWss,
        dataDir: dir,
        currentSession: () => ({ username: 'alice' }),
        requireUser: (req, res, next) => next(),
        rejectSocket: () => {},
        findConnection: () => null,
        resolveCredentials: () => ({}),
        logger: { info() {}, warn() {} },
    });

    const wrapper = listeners[listeners.length - 1];
    wrapper({ url: '/ssh', headers: { host: 'x' } }, {}, null);
    wrapper({ url: '/file-transfer', headers: { host: 'x' } }, {}, null);
    assert.deepEqual(coreSeen, ['/ssh', '/file-transfer'],
        'the core must still receive every path it owns');

    coreSeen.length = 0;
    wrapper({ url: `${WS_PATH}?connectionId=c1`, headers: { host: 'x' } }, {}, null);
    assert.deepEqual(coreSeen, [], 'the One-only path must not reach the core handler');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('an unauthenticated upgrade on the native path is rejected', () => {
    const dir = tempDir('unauth');
    const { app, server, listeners, FakeWss } = stubHost();
    const rejects = [];

    bridge.attach({
        app,
        server,
        httpsServer: null,
        WebSocketServer: FakeWss,
        dataDir: dir,
        currentSession: () => null,
        requireUser: (req, res, next) => next(),
        rejectSocket: (socket, code) => rejects.push(code),
        findConnection: () => null,
        resolveCredentials: () => ({}),
        logger: { info() {}, warn() {} },
    });

    listeners[listeners.length - 1]({ url: WS_PATH, headers: { host: 'x' } }, {}, null);
    assert.deepEqual(rejects, [401], 'no session must mean 401, not an accepted socket');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a must-change-password session is refused with 403', () => {
    const dir = tempDir('mcp');
    const { app, server, listeners, FakeWss } = stubHost();
    const rejects = [];

    bridge.attach({
        app,
        server,
        httpsServer: null,
        WebSocketServer: FakeWss,
        dataDir: dir,
        currentSession: () => ({ username: 'alice', mustChangePassword: true }),
        requireUser: (req, res, next) => next(),
        rejectSocket: (socket, code) => rejects.push(code),
        findConnection: () => null,
        resolveCredentials: () => ({}),
        logger: { info() {}, warn() {} },
    });

    listeners[listeners.length - 1]({ url: WS_PATH, headers: { host: 'x' } }, {}, null);
    assert.deepEqual(rejects, [403]);
    fs.rmSync(dir, { recursive: true, force: true });
});
