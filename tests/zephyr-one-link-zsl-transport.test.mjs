import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const embed = require('../zephyr-one-link-embed.js');
const { OneLinkSyncSession, handshakeProof, LinkEmbedProcess } = embed;

function loadLinkSync() {
    try {
        return require('../zephyr-one-link-sync.js');
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return null;
        throw error;
    }
}

function signingIdentity(overrides = {}) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        serverUrl: 'https://main.example/',
        deviceId: 'dev-1',
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        allowInsecureTls: false,
        ...overrides,
    };
}

function bindDesktopSync(mod, { httpRequest, sleepFn, linkClient } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-link-zsl-'));
    const keys = mod.generateDeviceKeys();
    fs.writeFileSync(path.join(dir, 'one-link-device-keys.json'), JSON.stringify(keys));
    fs.writeFileSync(path.join(dir, 'one-link-binding.json'), JSON.stringify({
        serverUrl: 'https://main.example',
        allowInsecureTls: false,
        serverId: 'srv-1',
        deviceId: 'dev-1',
        deviceName: 'Zephyr One',
        platform: 'linux',
        userId: 'u1',
        username: 'local',
        tokenId: 'link-v2-enrollment',
        accessCredential: 'access-token',
        accessExpiresAt: Date.now() + 60 * 60 * 1000,
        refreshCredential: 'refresh-token',
        registryHash: 'hash',
        boundAt: Date.now(),
    }));
    const sync = new mod.ZephyrOneLinkSync({
        dataDir: dir,
        storage: { getFirstUser: () => ({ userId: 'u1', username: 'local' }) },
        log: () => {},
        httpRequest,
        sleepFn: sleepFn || (async () => {}),
        linkClient,
    });
    return { dir, sync, keys };
}

function challengeOk(opts) {
    const body = opts.body || {};
    return {
        ok: true,
        status: 200,
        headers: {},
        data: {
            challenge: {
                nonce: 'nonce-' + (body.path || ''),
                timestamp: Math.floor(Date.now() / 1000),
                expiresAt: Date.now() + 30000,
                method: body.method,
                canonicalPath: body.path,
                bodySha256: body.bodySha256,
                usage: body.usage,
            },
        },
    };
}

test('OneLinkSyncSession is exported and does not start the initiator splice', () => {
    const src = fs.readFileSync(path.join(root, 'zephyr-one-link-embed.js'), 'utf8');
    assert.match(src, /class OneLinkSyncSession/);
    assert.match(src, /module\.exports[\s\S]*OneLinkSyncSession/);
    const sessionBlock = src.slice(src.indexOf('class OneLinkSyncSession'), src.indexOf('module.exports'));
    const posts = [...sessionBlock.matchAll(/this\._post\('([^']+)'/g)].map((row) => row[1]);
    assert.deepEqual([...new Set(posts)].sort(), ['/link/dial', '/link/dial/finish', '/link/push']);
    assert.match(sessionBlock, /\/link\/dial/);
    assert.match(sessionBlock, /\/link\/dial\/finish/);
    assert.match(sessionBlock, /\/link\/push/);
    assert.match(sessionBlock, /secret:\s*false/);
    assert.match(sessionBlock, /\/api\/link\/v2/);
});

test('desktop sync injects a shared OneLinkSyncSession as linkClient', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(server, /new OneLinkSyncSession\(/);
    assert.match(server, /createZephyrOneLinkSync\(\{[\s\S]*linkClient/);
    assert.match(server, /process:\s*oneLinkInitiator\.process/);
    assert.doesNotMatch(server, /oneLinkInitiator\.ensureSession\(\)/);
});

test('ensureSession dials /link/dial and finishes a pending handshake', async () => {
    const identity = signingIdentity();
    const calls = [];
    const session = new OneLinkSyncSession({
        getIdentity: () => identity,
        _postJson: async (pathname, body) => {
            calls.push({ pathname, body });
            if (pathname === '/link/dial') {
                return {
                    status: 200,
                    data: {
                        ok: true,
                        pending: true,
                        sessionId: 'sess-1',
                        transcript: Buffer.from('transcript-bytes').toString('base64'),
                    },
                };
            }
            if (pathname === '/link/dial/finish') {
                return { status: 200, data: { ok: true, sessionId: 'sess-1' } };
            }
            throw new Error('unexpected ' + pathname);
        },
    });
    const sessionId = await session.ensureSession();
    assert.equal(sessionId, 'sess-1');
    assert.equal(calls[0].pathname, '/link/dial');
    assert.equal(calls[0].body.serverUrl, 'https://main.example/api/link/v2');
    assert.equal(calls[0].body.deviceId, 'dev-1');
    assert.equal(calls[0].body.insecure, false);
    assert.equal(calls[1].pathname, '/link/dial/finish');
    assert.equal(calls[1].body.sessionId, 'sess-1');
    assert.equal(typeof calls[1].body.proof, 'string');
    assert.ok(calls[1].body.proof.length > 40);
    assert.match(calls[1].body.proof, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(calls.some((row) => row.pathname.includes('/link/tunnel/initiator/start')), false);
});

test('push posts /link/push with sessionId, peerUrl, kind, body and secret:false', async () => {
    const identity = signingIdentity();
    const calls = [];
    const session = new OneLinkSyncSession({
        getIdentity: () => identity,
        _postJson: async (pathname, body) => {
            calls.push({ pathname, body });
            if (pathname === '/link/dial') {
                return { status: 200, data: { ok: true, sessionId: 'sess-9' } };
            }
            if (pathname === '/link/push') {
                return { status: 200, data: { ok: true, ackKind: 2, ack: { ok: true, op: 'bootstrap' } } };
            }
            throw new Error('unexpected ' + pathname);
        },
    });
    const result = await session.push({ kind: 1, body: { op: 'bootstrap', pageSize: '100' } });
    assert.equal(result.ackKind, 2);
    assert.equal(result.ack.ok, true);
    const pushed = calls.find((row) => row.pathname === '/link/push');
    assert.ok(pushed);
    assert.equal(pushed.body.sessionId, 'sess-9');
    assert.equal(pushed.body.peerUrl, 'https://main.example/api/link/v2');
    assert.equal(pushed.body.kind, 1);
    assert.equal(pushed.body.secret, false);
    assert.deepEqual(pushed.body.body, { op: 'bootstrap', pageSize: '100' });
    assert.equal(calls.some((row) => String(row.pathname).includes('initiator')), false);
});

test('push throws code and retryable when ack.ok is false', async () => {
    const session = new OneLinkSyncSession({
        getIdentity: () => signingIdentity(),
        _postJson: async (pathname) => {
            if (pathname === '/link/dial') {
                return { status: 200, data: { ok: true, sessionId: 'sess-err' } };
            }
            if (pathname === '/link/push') {
                return {
                    status: 200,
                    data: {
                        ok: true,
                        ackKind: 2,
                        ack: { ok: false, error: { code: 'cursor_expired', message: 'cursor expired', retryable: false } },
                    },
                };
            }
            throw new Error('unexpected ' + pathname);
        },
    });
    await assert.rejects(
        () => session.push({ kind: 1, body: { op: 'changes' } }),
        (err) => {
            assert.equal(err.code, 'cursor_expired');
            assert.equal(err.retryable, false);
            return true;
        },
    );
});

test('session_unknown on push clears the session and redials once', async () => {
    const calls = [];
    let pushes = 0;
    const session = new OneLinkSyncSession({
        getIdentity: () => signingIdentity(),
        _postJson: async (pathname, body) => {
            calls.push(pathname);
            if (pathname === '/link/dial') {
                return { status: 200, data: { ok: true, sessionId: `sess-${calls.filter((row) => row === '/link/dial').length}` } };
            }
            if (pathname === '/link/push') {
                pushes += 1;
                if (pushes === 1) {
                    return {
                        status: 400,
                        data: { ok: false, error: { code: 'session_unknown', message: 'Link 会话不存在', retryable: true } },
                    };
                }
                return { status: 200, data: { ok: true, ackKind: 2, ack: { ok: true } } };
            }
            throw new Error('unexpected ' + pathname);
        },
    });
    const result = await session.push({ kind: 1, body: { op: 'ack' } });
    assert.equal(result.ack.ok, true);
    assert.equal(calls.filter((row) => row === '/link/dial').length, 2);
    assert.equal(pushes, 2);
    assert.equal(session.sessionId, 'sess-2');
});

test('network failures clear sessionId so the next push redials', async () => {
    let dials = 0;
    const session = new OneLinkSyncSession({
        getIdentity: () => signingIdentity(),
        _postJson: async (pathname) => {
            if (pathname === '/link/dial') {
                dials += 1;
                return { status: 200, data: { ok: true, sessionId: `sess-${dials}` } };
            }
            if (pathname === '/link/push') {
                if (dials === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
                return { status: 200, data: { ok: true, ackKind: 2, ack: { complete: true } } };
            }
            throw new Error('unexpected ' + pathname);
        },
    });
    const result = await session.push({ kind: 1, body: { op: 'bootstrap' } });
    assert.equal(result.ack.complete, true);
    assert.equal(dials, 2);
    assert.equal(session.sessionId, 'sess-2');
});

test('link_embed_missing is not retried as a channel failure', async () => {
    const session = new OneLinkSyncSession({
        getIdentity: () => signingIdentity(),
        process: {
            ensureStarted: async () => {
                throw Object.assign(new Error('安装包缺少 zephyr-link-embed，无法经由 Agent 跳板'), {
                    code: 'link_embed_missing',
                });
            },
        },
    });
    await assert.rejects(
        () => session.push({ kind: 1, body: { op: 'bootstrap' } }),
        (err) => {
            assert.equal(err.code, 'link_embed_missing');
            return true;
        },
    );
});

test('owned-sync bootstrap/changes/push/ack ride ZSL kind=1 and skip HTTPS+proof', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const calls = [];
    const httpPaths = [];
    const linkClient = {
        push: async ({ kind, body }) => {
            calls.push({ kind, body });
            if (body.op === 'bootstrap') {
                return { ackKind: 2, ack: { ok: true, complete: true, entities: [], snapshotCursor: 1, nextPageToken: null } };
            }
            if (body.op === 'changes') {
                return { ackKind: 2, ack: { changes: [], nextCursor: 1, hasMore: false } };
            }
            if (body.op === 'push') {
                return { ackKind: 2, ack: { results: [], serverCursor: 1 } };
            }
            if (body.op === 'ack') {
                return { ackKind: 2, ack: { ok: true } };
            }
            throw new Error('unexpected op ' + body.op);
        },
    };
    const { sync } = bindDesktopSync(mod, {
        linkClient,
        httpRequest: async (_base, opts) => {
            httpPaths.push(opts.path);
            throw new Error('unexpected HTTP ' + opts.path);
        },
    });
    await sync._authorizedRequest({ method: 'GET', path: '/api/mobile/v1/sync/bootstrap', query: { pageSize: '100', pageToken: undefined } });
    await sync._authorizedRequest({ method: 'GET', path: '/api/mobile/v1/sync/changes', query: { sinceCursor: '4', limit: '200' } });
    await sync._authorizedRequest({
        method: 'POST',
        path: '/api/mobile/v1/sync/push',
        body: { protocolVersion: 1, deviceId: 'dev-1', batchId: 'b1', baseCursor: 0, registryHash: 'hash', operations: [] },
    });
    await sync._authorizedRequest({
        method: 'POST',
        path: '/api/mobile/v1/sync/ack',
        body: { deviceId: 'dev-1', cursor: 4, appliedOpIds: [] },
    });
    assert.deepEqual(calls.map((row) => row.kind), [1, 1, 1, 1]);
    assert.deepEqual(calls.map((row) => row.body.op), ['bootstrap', 'changes', 'push', 'ack']);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, 'pageToken'), false);
    assert.equal(calls[0].body.pageSize, '100');
    assert.equal(calls[1].body.sinceCursor, '4');
    assert.equal(calls[2].body.batchId, 'b1');
    assert.equal(calls[3].body.cursor, 4);
    assert.equal(httpPaths.length, 0);
});

test('capabilities and enrollment stay on HTTPS when linkClient is bound', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const zslOps = [];
    const httpPaths = [];
    const { sync } = bindDesktopSync(mod, {
        linkClient: {
            push: async ({ body }) => {
                zslOps.push(body.op);
                throw new Error('capabilities must not ride ZSL');
            },
        },
        httpRequest: async (_base, opts) => {
            httpPaths.push(opts.path);
            if (opts.path === '/api/mobile/v1/capabilities') {
                return { ok: true, status: 200, headers: {}, data: { serverId: 'srv-1', registryHash: 'hash' } };
            }
            if (opts.path === '/api/mobile/v1/devices/proof-challenge') return challengeOk(opts);
            if (opts.path === '/api/mobile/v1/agent-bastions') {
                return { ok: true, status: 200, headers: {}, data: { agents: [] } };
            }
            throw new Error('unexpected ' + opts.path);
        },
    });
    const caps = await sync._fetchCapabilities({ force: true });
    assert.equal(caps.serverId, 'srv-1');
    const agents = await sync.agentBastions();
    assert.deepEqual(agents, []);
    assert.equal(zslOps.length, 0);
    assert.ok(httpPaths.includes('/api/mobile/v1/capabilities'));
    assert.ok(httpPaths.includes('/api/mobile/v1/devices/proof-challenge'));
    assert.ok(httpPaths.includes('/api/mobile/v1/agent-bastions'));
});

test('link_embed_missing falls back to HTTPS owned-sync', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const httpPaths = [];
    const { sync } = bindDesktopSync(mod, {
        linkClient: {
            push: async () => {
                throw Object.assign(new Error('安装包缺少 zephyr-link-embed'), { code: 'link_embed_missing' });
            },
        },
        httpRequest: async (_base, opts) => {
            httpPaths.push(opts.path);
            if (opts.path === '/api/mobile/v1/devices/proof-challenge') return challengeOk(opts);
            if (opts.path === '/api/mobile/v1/sync/bootstrap') {
                return {
                    ok: true, status: 200, headers: {},
                    data: { entities: [], snapshotCursor: 3, nextPageToken: null, complete: true, bootstrapId: 'b1' },
                };
            }
            if (opts.path === '/api/mobile/v1/sync/ack') {
                return { ok: true, status: 200, headers: {}, data: { ok: true } };
            }
            throw new Error('unexpected ' + opts.path);
        },
    });
    const state = await sync.syncNow({ trigger: 'manual' });
    assert.equal(state.bootstrapComplete, true);
    assert.ok(httpPaths.includes('/api/mobile/v1/sync/bootstrap'));
    assert.ok(httpPaths.includes('/api/mobile/v1/devices/proof-challenge'));
    assert.equal(sync._ownedSyncHttpsFallback, true);
});

test('LinkEmbedProcess.ensureStarted still reports link_embed_missing without a bin', async () => {
    const previous = process.env.ZEPHYR_LINK_EMBED_BIN;
    delete process.env.ZEPHYR_LINK_EMBED_BIN;
    const child = new LinkEmbedProcess({ bin: path.join(os.tmpdir(), 'no-such-zephyr-link-embed') });
    try {
        await assert.rejects(
            () => child.ensureStarted(),
            (err) => {
                assert.equal(err.code, 'link_embed_missing');
                return true;
            },
        );
    } finally {
        if (previous == null) delete process.env.ZEPHYR_LINK_EMBED_BIN;
        else process.env.ZEPHYR_LINK_EMBED_BIN = previous;
    }
});
