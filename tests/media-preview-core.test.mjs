import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Server, utils } = require('ssh2');
const WebSocket = require('ws');
const root = process.env.ZEPHYR_MEDIA_TEST_CORE_ROOT || path.resolve(import.meta.dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    return port;
}

function nextMessage(ws, type) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', message); reject(new Error(`No WebSocket ${type} within 15s`)); }, 15000);
        const message = (data) => {
            const parsed = JSON.parse(data);
            if (parsed.type === 'error' || parsed.type === 'sftp-error') {
                clearTimeout(timer); ws.off('message', message); reject(new Error(parsed.message));
            } else if (parsed.type === type || (type === 'sftp-media-preview-ready' && parsed.type === 'sftp-media-preview')) {
                clearTimeout(timer); ws.off('message', message); resolve(parsed);
            }
        };
        ws.on('message', message);
    });
}

async function startSftp() {
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    const clients = new Set();
    const files = new Map([
        ['/sample.mp4', Buffer.from('0123456789')],
        ['/sample.aiff', Buffer.from('FORM0000AIFF')],
        ['/sample.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\ncaption\n')],
    ]);
    const reads = [];
    const attrs = (size) => ({ mode: 0o100644, uid: 0, gid: 0, size, atime: 100, mtime: 100 });
    const server = new Server({ hostKeys: [key] }, (client) => {
        clients.add(client);
        client.on('error', () => {});
        client.on('close', () => clients.delete(client));
        client.on('authentication', (ctx) => ctx.accept());
        client.on('ready', () => client.on('session', (accept) => {
            const session = accept();
            session.on('pty', (acceptPty) => acceptPty());
            session.on('shell', (acceptShell) => { const stream = acceptShell(); stream.on('data', () => {}); });
            session.on('sftp', (acceptSftp) => {
                const sftp = acceptSftp();
                const { STATUS_CODE } = utils.sftp;
                for (const event of ['STAT', 'LSTAT']) sftp.on(event, (id, file) => {
                    const bytes = files.get(file);
                    if (bytes) sftp.attrs(id, attrs(bytes.length));
                    else sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
                });
                sftp.on('OPEN', (id, file) => files.has(file) ? sftp.handle(id, Buffer.from(file)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE));
                sftp.on('READ', (id, handle, offset, length) => {
                    const file = handle.toString(); const bytes = files.get(file); reads.push({ file, offset, length });
                    if (offset >= bytes.length) sftp.status(id, STATUS_CODE.EOF);
                    else sftp.data(id, bytes.subarray(offset, offset + length));
                });
                sftp.on('CLOSE', (id) => sftp.status(id, STATUS_CODE.OK));
                let listed = false;
                sftp.on('OPENDIR', (id) => { listed = false; sftp.handle(id, Buffer.from('directory')); });
                sftp.on('READDIR', (id) => {
                    if (listed) sftp.status(id, STATUS_CODE.EOF);
                    else { listed = true; sftp.name(id, [{ filename: 'sample.srt', longname: '-rw-r--r-- sample.srt', attrs: attrs(files.get('/sample.srt').length) }]); }
                });
            });
        }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { port: server.address().port, reads, stop: async () => {
        for (const client of clients) client.end();
        await new Promise((resolve) => server.close(resolve));
    } };
}

test('live embedded core registers RAW media through authenticated SSH/WebSocket and streams SFTP bytes', { timeout: 60000 }, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-media-core-'));
    const ssh = await startSftp();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const challenge = crypto.randomBytes(32).toString('hex');
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
        ...process.env, PORT: String(port), HTTP_ENABLED: 'true', HTTPS_ENABLED: 'false',
        PUBLIC_ORIGIN: base, ZEPHYR_DATA_DIR: dataDir, ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${await freePort()}`,
        ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1', ZEPHYR_ONE_EMBEDDED: '1', ZEPHYR_ONE_STARTUP_CHALLENGE: challenge,
        ENCRYPTION_KEY: 'media-preview-core-test-only', SSH_STATS_ENABLED: 'false', NODE_ENV: 'test',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
    let ws;
    try {
        let ready = false;
        for (let count = 0; count < 400; count++) {
            assert.equal(child.exitCode, null, logs.slice(-3000));
            try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
            await wait(100);
        }
        assert.ok(ready, logs.slice(-3000));
        const bootstrap = await fetch(base + '/__zephyr_one/bootstrap', { method: 'POST', headers: { 'x-zephyr-one-bootstrap-challenge': challenge } });
        assert.equal(bootstrap.status, 204);
        const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
        assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 200);
        ws = new WebSocket(`ws://127.0.0.1:${port}/ssh`, { headers: { cookie, origin: base } });
        await once(ws, 'open');
        let response = nextMessage(ws, 'ready');
        ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: ssh.port, username: 'fixture', password: 'fixture', sessionId: 'media-core-fixture' }));
        await response;
        response = nextMessage(ws, 'sftp-ready'); ws.send(JSON.stringify({ type: 'sftp-init' })); await response;
        for (const file of ['/sample.mp4', '/sample.aiff']) {
            response = nextMessage(ws, 'sftp-media-preview-ready');
            ws.send(JSON.stringify({ type: 'sftp-media-preview', path: file, requestId: `open-${file}` }));
            const message = await response;
            assert.equal(message.type, 'sftp-media-preview-ready', message.error);
            assert.equal(message.requestId, `open-${file}`);
            assert.equal(message.mode, 'RAW');
            const unauthorized = await fetch(base + message.streamUrl);
            assert.equal(unauthorized.status, 401); await unauthorized.text();
            const partial = await fetch(base + message.streamUrl, { headers: { cookie, range: 'bytes=-3' } });
            assert.equal(partial.status, 206);
            assert.equal(await partial.text(), file.endsWith('.mp4') ? '789' : 'IFF');
            assert.equal(partial.headers.get('content-type'), file.endsWith('.mp4') ? 'video/mp4' : 'audio/aiff');
            assert.equal(message.subtitles[0].codec, 'srt');
            const subtitle = await fetch(base + message.subtitles[0].url, { headers: { cookie } });
            assert.equal(subtitle.status, 200); assert.match(await subtitle.text(), /caption/);
        }
        assert.ok(ssh.reads.some((read) => read.file === '/sample.mp4' && read.offset === 7));
        for (const [asset, mime] of [
            ['/vendor/ffmpeg/esm/index.js', /javascript/], ['/vendor/ffmpeg/esm/worker.js', /javascript/],
            ['/vendor/ffmpeg/ffmpeg-core.js', /javascript/], ['/vendor/ffmpeg/ffmpeg-core.wasm', /application\/wasm/],
        ]) {
            const result = await fetch(base + asset, { method: 'HEAD' });
            assert.equal(result.status, 200, asset); assert.match(result.headers.get('content-type'), mime, asset);
            assert.equal(result.headers.get('cross-origin-embedder-policy'), 'require-corp');
            assert.equal(result.headers.get('cross-origin-opener-policy'), 'same-origin');
        }
    } finally {
        ws?.terminate();
        if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000).then(() => child.kill('SIGKILL'))]); }
        await ssh.stop(); fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
