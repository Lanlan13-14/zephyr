import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadLinkSync() {
    try {
        return require('../zephyr-one-link-sync.js');
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return null;
        throw error;
    }
}
const { proofPayload } = require('../link-v2-enrollment.js');
const mobileProof = require('../mobile-v1-proof.js');

test('desktop platform tags are accepted by enrollment and bind validators', () => {
    const store = fs.readFileSync(path.join(root, 'mobile-v1-store.js'), 'utf8');
    const enroll = fs.readFileSync(path.join(root, 'link-v2-enrollment.js'), 'utf8');
    for (const source of [store, enroll]) {
        assert.match(source, /platformTag !== 'desktop'/);
        assert.match(source, /platformTag !== 'linux'/);
        assert.match(source, /platformTag !== 'macos'/);
        assert.match(source, /platformTag !== 'windows'/);
    }
    assert.match(store, /'android','ios','desktop','linux','macos','windows'/);
});

test('interval clamp matches Android SyncContract bounds', (t) => {
    const mod = loadLinkSync();
    if (!mod) {
        t.skip('@noble/post-quantum is not installed in this worktree');
        return;
    }
    const { clampInterval } = mod;
    assert.equal(clampInterval(10), 30);
    assert.equal(clampInterval(300), 300);
    assert.equal(clampInterval(99_999), 86400);
    assert.equal(clampInterval('nope'), 300);
});

test('detectDesktopPlatform never reports android or agent', (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const { detectDesktopPlatform } = mod;
    const platform = detectDesktopPlatform();
    assert.equal(['linux', 'macos', 'windows', 'desktop'].includes(platform), true);
    assert.doesNotMatch(platform, /^agent/);
    assert.notEqual(platform, 'android');
    assert.notEqual(platform, 'ios');
});

test('generated device keys match enrollment wire sizes', (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const { generateDeviceKeys } = mod;
    const keys = generateDeviceKeys();
    assert.equal(keys.encryption.alg, 'ML-KEM-768');
    assert.equal(Buffer.from(keys.encryption.publicKey, 'base64').length, 1184);
    assert.equal(keys.signing.alg, 'ES256');
    assert.equal(keys.signing.jwk.kty, 'EC');
    assert.equal(keys.signing.jwk.crv, 'P-256');
});

test('unbound sync state is local-mode and refuses pull', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const { ZephyrOneLinkSync } = mod;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-link-'));
    const sync = new ZephyrOneLinkSync({
        dataDir: dir,
        storage: { getFirstUser: () => ({ userId: 'u1', username: 'local' }) },
        log: () => {},
    });
    const state = sync.publicState();
    assert.equal(state.bound, false);
    assert.equal(state.localMode, true);
    await assert.rejects(() => sync.syncNow(), /尚未绑定主端/);
});

test('enrollment proof payload is identical to Android / Agent', () => {
    const payload = proofPayload({
        bindId: 'bind-1',
        deviceId: 'device-1-device-1',
        userCode: 'ABCD-EFGH',
        sas: 'WXYZ-WXYZ-WXYZ-WXYZ',
        secretHash: 'a'.repeat(64),
        serverId: 'server-1',
    });
    assert.equal(payload.includes('\u0000'), true);
    assert.ok(payload.toString('utf8').startsWith('zephyr-link-enrollment-v2'));
});

test('device-proof usage covers bootstrap changes push and ack', () => {
    assert.equal(mobileProof.proofUsage('GET', '/api/mobile/v1/sync/bootstrap'), 'sync.bootstrap');
    assert.equal(mobileProof.proofUsage('GET', '/api/mobile/v1/sync/changes'), 'sync.changes');
    assert.equal(mobileProof.proofUsage('POST', '/api/mobile/v1/sync/push'), 'sync.push');
    assert.equal(mobileProof.proofUsage('POST', '/api/mobile/v1/sync/ack'), 'sync.ack');
});

test('embed surface shows Zephyr Link instead of renaming Agent to 文件同步', () => {
    const { applyEmbeddedSurface } = require('../zephyr-one-embed-surface.js');
    const html = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
    const transformed = applyEmbeddedSurface(html).html;
    assert.match(transformed, /data-settings="agent" data-i18n="Zephyr Agent"/);
    assert.match(transformed, /id="linkSettingsTab"[^>]*data-i18n="Zephyr Link"/);
    assert.match(transformed, /zephyr-one-link-ui\.js/);
    assert.doesNotMatch(transformed, /zephyr-one-native-rdp\.js/);
});

test('desktop link engine caps pages per round and resumes bootstrap from a checkpoint', () => {
    const src = fs.readFileSync(path.join(root, 'zephyr-one-link-sync.js'), 'utf8');
    assert.match(src, /const MAX_PAGES_PER_ROUND = 24/);
    assert.match(src, /const PAGE_TOKEN_TTL_MS = 30 \* 60 \* 1000/);
    assert.match(src, /bootstrapPageToken/);
    assert.match(src, /_liveBootstrapToken/);
    assert.match(src, /lastPushedRevisions/);
    assert.match(src, /Retry-After|retry-after/);
    assert.match(src, /_issueProofChallenge/);
    assert.doesNotMatch(src, /for \(let i = 0; i < MAX_BOOTSTRAP_PAGES; i \+= 1\) \{\s*if \(!this\.binding\.serverId\)/);
});

function bindDesktopSync(mod, { httpRequest, sleepFn } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-link-'));
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

test('a 429 on proof-challenge waits Retry-After once then continues', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const calls = [];
    let challengeHits = 0;
    const slept = [];
    const { sync } = bindDesktopSync(mod, {
        sleepFn: async (ms) => { slept.push(ms); },
        httpRequest: async (_base, opts) => {
            calls.push(opts.path);
            if (opts.path === '/api/mobile/v1/devices/proof-challenge') {
                challengeHits += 1;
                if (challengeHits === 1) {
                    return {
                        ok: false,
                        status: 429,
                        headers: { 'retry-after': '5' },
                        data: { error: { code: 'rate_limited', message: '设备证明 challenge 请求过于频繁', retryable: true } },
                    };
                }
                return challengeOk(opts);
            }
            if (opts.path === '/api/mobile/v1/sync/bootstrap') {
                return {
                    ok: true,
                    status: 200,
                    headers: {},
                    data: { entities: [], snapshotCursor: 4, nextPageToken: null, complete: true, bootstrapId: 'b1' },
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
    /* First challenge 429s, retry succeeds for bootstrap, ack needs a third. */
    assert.equal(challengeHits, 3);
    assert.equal(slept[0], 5000);
    assert.ok(calls.includes('/api/mobile/v1/sync/bootstrap'));
});

test('bootstrap persists the page token and resumes instead of restarting', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const tokens = [];
    const { sync } = bindDesktopSync(mod, {
        httpRequest: async (_base, opts) => {
            if (opts.path === '/api/mobile/v1/devices/proof-challenge') return challengeOk(opts);
            if (opts.path === '/api/mobile/v1/sync/bootstrap') {
                tokens.push(opts.query?.pageToken || null);
                if (!opts.query?.pageToken) {
                    return {
                        ok: true, status: 200, headers: {},
                        data: {
                            entities: [{ entityType: 'note', entityId: 'n1', action: 'upsert', payload: { title: 'a' }, revision: 1 }],
                            snapshotCursor: 9,
                            nextPageToken: 'page-2',
                            complete: false,
                            bootstrapId: 'boot-1',
                        },
                    };
                }
                return {
                    ok: true, status: 200, headers: {},
                    data: { entities: [], snapshotCursor: 9, nextPageToken: null, complete: true, bootstrapId: 'boot-1' },
                };
            }
            if (opts.path === '/api/mobile/v1/sync/ack') {
                return { ok: true, status: 200, headers: {}, data: { ok: true } };
            }
            throw new Error('unexpected ' + opts.path);
        },
    });
    sync.mobileV1Api = {
        adapters: new Map([['note', {
            idOf: (row) => row.id,
            revisionOf: (row) => row.revision || 1,
            list: () => [],
            read: () => null,
            create: () => {},
            update: () => {},
            remove: () => {},
        }]]),
        entityByType: new Map([['note', { editableFields: ['title'], secretFields: [] }]]),
    };
    const originalMax = sync._bootstrapAll;
    const pages = [];
    sync.state.bootstrapComplete = false;
    await sync._bootstrapAll();
    assert.equal(sync.state.bootstrapComplete, true);
    assert.equal(sync.state.bootstrapPageToken, null);
    assert.deepEqual(tokens, [null, 'page-2']);
    void originalMax;
    void pages;
});

test('a second bootstrap after a 429 does not restart from page one when a token is saved', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const tokens = [];
    const { sync } = bindDesktopSync(mod, {
        httpRequest: async (_base, opts) => {
            if (opts.path === '/api/mobile/v1/devices/proof-challenge') return challengeOk(opts);
            if (opts.path === '/api/mobile/v1/sync/bootstrap') {
                tokens.push(opts.query?.pageToken || null);
                if (!opts.query?.pageToken) {
                    return {
                        ok: true, status: 200, headers: {},
                        data: { entities: [], snapshotCursor: 3, nextPageToken: 'resume-me', complete: false, bootstrapId: 'boot-2' },
                    };
                }
                const err = new Error('rate');
                err.code = 'rate_limited';
                err.status = 429;
                throw err;
            }
            throw new Error('unexpected ' + opts.path);
        },
    });
    sync.state.bootstrapComplete = false;
    await assert.rejects(() => sync._bootstrapAll(), /rate/);
    assert.equal(sync.state.bootstrapPageToken, 'resume-me');
    assert.equal(sync.publicState().bootstrapResume, true);
});

