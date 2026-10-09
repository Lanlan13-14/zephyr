import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const media = require('../preview/media/media-service.js');
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const sliceBetween = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const section = (start, end) => sliceBetween(source, start, end);
const requestHandler = section("        if (msg.type === 'sftp-media-preview') {", "        if (msg.type === 'sftp-readfile') {");
const taskHelpers = section('function getMediaTask(', "app.get('/api/sftp/media/stream/:token'");
const streamHandler = section("app.get('/api/sftp/media/stream/:token'", '// ===== 分片上传 API =====');
const authHandler = section('function requireUser(', '/**\n * AI account plane');
const bindings = {
    getMediaExt: media.extname,
    getMediaBasenameNoExt: media.basenameNoExt,
    isMediaExt: media.isMediaExt,
    isVideoExt: media.isVideoExt,
    isSubtitleExt: media.isSubtitleExt,
    isExternalSubtitleFor: media.isExternalSubtitleFor,
    mediaContentType: media.mediaContentType,
    MEDIA_TOKEN_TTL: 86_400_000,
    remoteJoin: (dir, name) => {
        const base = String(dir || '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
        return base === '/' ? `/${name}` : `${base}/${name}`;
    },
    console: { info() {}, warn() {} },
};

async function registerPreview(filePath, { entries = [], readError = null, statError = null, directory = false, requestId } = {}) {
    const tokens = new Map();
    let readdirCalls = 0;
    let deliver;
    const delivered = new Promise((resolve) => { deliver = resolve; });
    const context = {
        ...bindings,
        msg: { type: 'sftp-media-preview', path: filePath, requestId },
        req: { authSession: { userId: 'owner-id', username: 'owner' } },
        attachedSshSession: { id: 'ssh-session', userId: 'owner-id', connectionConfig: { host: 'remote' } },
        conn: null,
        crypto: { randomBytes: () => Buffer.alloc(24, 1) },
        dirnameRemote: (value) => value.slice(0, value.lastIndexOf('/')) || '/',
        sftpMediaTokens: tokens,
        sftpStream: {
            stat(_path, callback) { callback(statError, { size: 10, mtime: 100, isDirectory: () => directory }); },
            readdir(_path, callback) { readdirCalls++; callback(readError, entries); },
        },
        sendJSON: deliver,
    };
    // Execute the production WebSocket handler, not a rewritten mock of it.
    await vm.runInNewContext(`(async () => { ${requestHandler} })()`, context);
    const message = await delivered;
    return { message, tokens, readdirCalls };
}

test('committed RAW handler throws ReferenceError on the undefined info probe', async () => {
    const committed = execFileSync('git', ['show', 'HEAD:server.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const handler = sliceBetween(committed, "        if (msg.type === 'sftp-media-preview') {", "        if (msg.type === 'sftp-readfile') {");
    assert.match(handler, /info\.subtitles/);
    const tokens = new Map();
    let deliver;
    const delivered = new Promise((resolve) => { deliver = resolve; });
    await vm.runInNewContext(`(async () => { ${handler} })()`, {
        ...bindings,
        msg: { type: 'sftp-media-preview', path: '/clip.mp4', requestId: 'legacy' },
        req: { authSession: { userId: 'owner-id', username: 'owner' } },
        attachedSshSession: { id: 'ssh-session', userId: 'owner-id', connectionConfig: { host: 'remote' } },
        conn: null,
        crypto: { randomBytes: () => Buffer.alloc(24, 1) },
        dirnameRemote: (value) => value.slice(0, value.lastIndexOf('/')) || '/',
        sftpMediaTokens: tokens,
        sftpStream: {
            stat(_path, callback) { callback(null, { size: 4, isDirectory: () => false }); },
            readdir(_path, callback) { callback(null, [{ filename: 'clip.srt' }]); },
        },
        sendJSON: deliver,
    });
    const message = await delivered;
    assert.equal(message.type, 'sftp-media-preview');
    assert.equal(message.error, 'info is not defined');
    assert.equal(message.requestId, undefined, 'the committed handler drops request correlation');
    assert.equal(tokens.size, 0, 'the exception happens before a token can be issued');
});

test('RAW WebSocket handler registers every supported audio/video extension without probing', async () => {
    for (const ext of [...media.VIDEO_EXTENSIONS, ...media.AUDIO_EXTENSIONS]) {
        const { message, tokens } = await registerPreview(`/media/sample.${ext}`);
        assert.equal(message.type, 'sftp-media-preview-ready', `${ext}: ${message.error || ''}`);
        assert.equal(message.kind, media.isVideoExt(ext) ? 'video' : 'audio');
        assert.equal(message.mode, 'RAW');
        const task = tokens.get(message.token);
        assert.equal(task.ownerUserId, 'owner-id');
        assert.equal(task.username, 'owner');
        assert.equal(task.sessionId, 'ssh-session');
        assert.equal(task.connectionConfig.host, 'remote');
        assert.equal(message.streamUrl, `/api/sftp/media/stream/${message.token}`);
    }
});

test('ready payload retains the real subtitle codec despite legacy .vtt URLs', async () => {
    const { message, tokens } = await registerPreview('/media/sample.mp4', {
        entries: ['sample.en.srt', 'sample.ja.ass', 'sample.fr.vtt', 'different.srt', 'sample.en.sub', 'samplex.srt'].map((filename) => ({ filename })),
    });
    assert.equal(message.type, 'sftp-media-preview-ready', message.error);
    assert.deepEqual(Array.from(message.subtitles, (sub) => sub.codec), ['srt', 'ass', 'vtt']);
    assert.deepEqual(Array.from(message.subtitles, (sub) => sub.index), [0, 1, 2]);
    assert.equal(tokens.get(message.token).subtitles[1].externalPath, '/media/sample.ja.ass');
    assert.equal(tokens.get(message.token).subtitles[1].index, 1);
    const rooted = await registerPreview('/sample.mp4', { entries: [{ filename: 'sample.en.srt' }] });
    assert.equal(rooted.tokens.get(rooted.message.token).subtitles[0].externalPath, '/sample.en.srt');
    const missing = await registerPreview('/sample.mp3', { readError: new Error('permission denied') });
    assert.equal(missing.message.type, 'sftp-media-preview-ready', 'optional subtitles must not block playback');
});

function rangeFor(range, size) {
    return vm.runInNewContext(`${taskHelpers}; mediaRangeFromRequest({ headers: { range } }, size)`, { ...bindings, range, size });
}

test('Range parser returns the final bytes for suffix ranges and rejects malformed ranges', () => {
    const suffix = rangeFor('bytes=-3', 10);
    assert.equal(suffix?.start, 7);
    assert.equal(suffix?.end, 9);
    const largeSuffix = rangeFor('bytes=-99', 10);
    assert.equal(largeSuffix?.start, 0);
    assert.equal(largeSuffix?.end, 9);
    for (const raw of ['bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=0-2junk', 'bytes=10-', 'bytes=8-2']) {
        assert.equal(rangeFor(raw, 10), null, raw);
    }
    assert.equal(rangeFor('bytes=0-', 0), null);
    assert.equal(rangeFor('', 0)?.empty, true);
    assert.equal(rangeFor('items=0-1', 10)?.partial, false, 'unsupported units are ignored');
});

test('RAW ready/error responses echo optional requestId for refresh ordering', async () => {
    for (const [filePath, options] of [
        ['/sample.mp4', {}], ['', {}], ['/sample.txt', {}],
        ['/sample.mp4', { statError: new Error('stat failed') }], ['/sample.mp4', { directory: true }],
    ]) {
        const result = await registerPreview(filePath, { ...options, requestId: 'refresh-2' });
        assert.equal(result.message.requestId, 'refresh-2');
    }
    assert.equal((await registerPreview('/sample.mp3')).message.requestId, '', 'older clients remain supported');
});

async function httpHarness(tokens) {
    const routes = new Map();
    const reads = [];
    const closed = [];
    let opens = 0;
    let statSize = 10;
    const payload = Buffer.from('0123456789');
    const context = {
        ...bindings,
        path: require('node:path'),
        sftpMediaTokens: tokens,
        currentSession(req) {
            const cookie = req.headers.cookie || '';
            if (cookie === 'sid=owner') return { userId: 'owner-id', username: 'owner' };
            if (cookie === 'sid=other') return { userId: 'other-id', username: 'owner' };
            if (cookie === 'sid=suspended') return { userId: 'suspended-id', username: 'suspended' };
            return null;
        },
        storage: { getUserBrief: (userId) => ({ userId, username: 'owner', status: userId === 'suspended-id' ? 'suspended' : 'active' }) },
        authError: (res, status, code, error) => res.status(status).json({ error, code }),
        isPasswordChangeAllowedPath: () => false,
        createRoutedSSHConnection: async () => {
            opens++;
            return { clients: [{ end: () => closed.push('client') }], client: { sftp(callback) {
                callback(null, {
                    stat(_path, done) { done(null, { size: statSize, isDirectory: () => false }); },
                    createReadStream(filePath, options) {
                        reads.push({ filePath, options });
                        const bytes = filePath.endsWith('.srt') ? Buffer.from('1\n00:00:00,000 --> 00:00:01,000\ncaption\n')
                            : (statSize === 0 ? Buffer.alloc(0) : payload.subarray(options?.start || 0, options ? options.end + 1 : payload.length));
                        return Readable.from([bytes]);
                    },
                    end: () => closed.push('sftp'),
                });
            } } };
        },
        app: { get: (route, auth, handler) => routes.set(route, { auth, handler }) },
    };
    vm.runInNewContext(`${authHandler}\n${taskHelpers}\n${streamHandler}`, context);
    const server = http.createServer(async (req, res) => {
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return res; };
        res.type = (type) => { res.setHeader('Content-Type', type); return res; };
        const url = new URL(req.url, 'http://fixture.local');
        const stream = url.pathname.match(/^\/api\/sftp\/media\/stream\/([^/]+)$/);
        const subtitle = url.pathname.match(/^\/api\/sftp\/media\/subtitle\/([^/]+)\/(.+)\.vtt$/);
        const route = routes.get(subtitle ? '/api/sftp/media/subtitle/:token/:index.vtt' : '/api/sftp/media/stream/:token');
        if (!stream && !subtitle) return res.status(404).end();
        req.params = subtitle ? { token: subtitle[1], index: subtitle[2] } : { token: stream[1] };
        req.query = Object.fromEntries(url.searchParams);
        try { route.auth(req, res, () => { route.handler(req, res).catch((error) => res.destroy(error)); }); }
        catch (error) { res.status(500).json({ error: error.message }); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        reads, closed, opens: () => opens,
        setSize: (size) => { statSize = size; },
        stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
    };
}

test('actual RAW HTTP route enforces sessions, stable token ownership, TTL and Range bytes', async () => {
    const { message, tokens } = await registerPreview('/sample.mp4', { entries: [{ filename: 'sample.srt' }] });
    const fixture = await httpHarness(tokens);
    const get = (headers = {}, url = message.streamUrl) => fetch(fixture.base + url, { headers });
    try {
        for (const [cookie, status] of [['', 401], ['sid=suspended', 403], ['sid=other', 404]]) {
            const response = await get({ cookie });
            assert.equal(response.status, status);
            await response.text();
        }
        assert.equal(fixture.opens(), 0, 'unauthorized requests must not open an SSH connection');
        assert.ok(tokens.has(message.token), 'wrong owner cannot revoke the legitimate owner token');
        for (const [range, status, body, contentRange] of [
            ['', 200, '0123456789', null], ['bytes=2-4', 206, '234', 'bytes 2-4/10'],
            ['bytes=7-', 206, '789', 'bytes 7-9/10'], ['bytes=-3', 206, '789', 'bytes 7-9/10'],
            ['bytes=-99', 206, '0123456789', 'bytes 0-9/10'], ['bytes=0-99', 206, '0123456789', 'bytes 0-9/10'],
        ]) {
            const response = await get({ cookie: 'sid=owner', ...(range ? { range } : {}) });
            assert.equal(response.status, status, range);
            assert.equal(response.headers.get('content-type'), 'video/mp4');
            assert.equal(response.headers.get('accept-ranges'), 'bytes');
            assert.equal(response.headers.get('content-range'), contentRange);
            assert.equal(response.headers.get('content-length'), String(body.length));
            assert.equal(response.headers.get('x-zephyr-media-mode'), 'RAW');
            assert.equal(await response.text(), body);
        }
        const readCount = fixture.reads.length;
        for (const range of ['bytes=-0', 'bytes=10-', 'bytes=0-2junk', 'bytes=0-1,4-5']) {
            const response = await get({ cookie: 'sid=owner', range });
            assert.equal(response.status, 416, range);
            assert.equal(response.headers.get('content-range'), 'bytes */10');
            await response.text();
        }
        assert.equal(fixture.reads.length, readCount, 'invalid ranges must not create a read stream');
        const subtitle = await get({ cookie: 'sid=owner' }, message.subtitles[0].url);
        assert.equal(subtitle.headers.get('content-type'), 'text/plain; charset=utf-8');
        assert.match(await subtitle.text(), /00:00:00,000/);
        const subtitleReads = fixture.reads.length;
        for (const index of ['1', '01', '-1', '1.5', 'nope']) {
            const missingSubtitle = await get({ cookie: 'sid=owner' }, `/api/sftp/media/subtitle/${message.token}/${index}.vtt`);
            assert.equal(missingSubtitle.status, 500, index);
            assert.match(await missingSubtitle.text(), /字幕不存在/);
        }
        assert.equal(fixture.reads.length, subtitleReads, 'missing subtitle indexes must not open the first subtitle');
        // The current stat, not stale token metadata, defines the response size.
        fixture.setSize(0);
        const empty = await get({ cookie: 'sid=owner' });
        assert.equal(empty.status, 200);
        assert.equal(empty.headers.get('content-length'), '0');
        assert.equal(await empty.text(), '');
        const emptyRange = await get({ cookie: 'sid=owner', range: 'bytes=0-' });
        assert.equal(emptyRange.status, 416);
        assert.equal(emptyRange.headers.get('content-range'), 'bytes */0');
        await emptyRange.text();
        const task = tokens.get(message.token);
        const oldExpiry = task.expiresAt;
        tokens.set('no-connection', { ...task, connectionConfig: null });
        const invalidConnection = await get({ cookie: 'sid=owner' }, '/api/sftp/media/stream/no-connection');
        assert.equal(invalidConnection.status, 410);
        await invalidConnection.text();
        assert.equal(tokens.has('no-connection'), false);
        assert.ok(oldExpiry > Date.now(), 'valid reads slide the token expiry');
        task.expiresAt = Date.now() - 1;
        const expired = await get({ cookie: 'sid=owner' });
        assert.equal(expired.status, 404);
        await expired.text();
        assert.equal(tokens.has(message.token), false);
        assert.ok(fixture.closed.includes('sftp') && fixture.closed.includes('client'));
    } finally { await fixture.stop(); }
});
