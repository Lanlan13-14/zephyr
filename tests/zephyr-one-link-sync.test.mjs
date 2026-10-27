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
    assert.doesNotMatch(transformed, /data-settings="agent"/);
    assert.doesNotMatch(transformed, /id="settings-agent"/);
    assert.match(transformed, /id="linkSettingsTab"[^>]*data-i18n="文件同步"/);
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

test('canonicalRequestPath drops undefined query keys the same way requestJson does', (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const { canonicalRequestPath } = mod;
    assert.equal(
        canonicalRequestPath('/api/mobile/v1/sync/bootstrap', { pageToken: undefined, pageSize: '100' }),
        '/api/mobile/v1/sync/bootstrap?pageSize=100',
    );
    assert.equal(
        canonicalRequestPath('/api/mobile/v1/sync/bootstrap', { pageToken: null, pageSize: 100 }),
        '/api/mobile/v1/sync/bootstrap?pageSize=100',
    );
    assert.equal(
        canonicalRequestPath('/api/mobile/v1/sync/bootstrap', { pageToken: 'page-2', pageSize: '100' }),
        '/api/mobile/v1/sync/bootstrap?pageSize=100&pageToken=page-2',
    );
    assert.equal(
        canonicalRequestPath('/api/mobile/v1/sync/changes', { sinceCursor: '4', limit: '200' }),
        '/api/mobile/v1/sync/changes?limit=200&sinceCursor=4',
    );
    assert.doesNotMatch(
        canonicalRequestPath('/api/mobile/v1/sync/bootstrap', { pageToken: undefined, pageSize: '100' }),
        /pageToken=undefined/,
    );
});

test('bootstrap GET proof is signed for the on-the-wire URL, not URLSearchParams(object)', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const challengePaths = [];
    const { sync } = bindDesktopSync(mod, {
        httpRequest: async (_base, opts) => {
            if (opts.path === '/api/mobile/v1/devices/proof-challenge') {
                challengePaths.push(opts.body.path);
                return challengeOk(opts);
            }
            if (opts.path === '/api/mobile/v1/sync/bootstrap') {
                return {
                    ok: true, status: 200, headers: {},
                    data: { entities: [], snapshotCursor: 1, nextPageToken: null, complete: true, bootstrapId: 'b1' },
                };
            }
            if (opts.path === '/api/mobile/v1/sync/ack') {
                return { ok: true, status: 200, headers: {}, data: { ok: true } };
            }
            throw new Error('unexpected ' + opts.path);
        },
    });
    await sync.syncNow({ trigger: 'manual' });
    assert.ok(challengePaths.includes('/api/mobile/v1/sync/bootstrap?pageSize=100'));
    assert.equal(challengePaths.some((p) => String(p).includes('pageToken=undefined')), false);
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


test('a probe update keeps iconSource even though the field mask lists only icon', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const { ZephyrOneLinkSync } = mod;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-link-icon-'));
    const rows = new Map([['c1', { id: 'c1', icon: 'auto', iconSource: 'auto', revision: 1 }]]);
    const adapter = {
        read: (_user, id) => rows.get(id) || null,
        update: (_user, id, patch) => { rows.set(id, { ...rows.get(id), ...patch }); },
        create: () => { throw new Error('create should not run for an existing row'); },
        revisionOf: (row) => row.revision,
    };
    const spec = {
        secretFields: [],
        serverAuthorityFields: ['iconSource', 'revision'],
    };
    const sync = new ZephyrOneLinkSync({
        dataDir: dir,
        storage: { getFirstUser: () => ({ userId: 'u1', username: 'local' }) },
        log: () => {},
    });
    sync.binding = { deviceId: 'dev-1' };
    sync.mobileV1Api = {
        adapters: new Map([['connection', adapter]]),
        entityByType: new Map([['connection', spec]]),
    };
    await sync._applyRemoteChange({
        entityType: 'connection',
        entityId: 'c1',
        action: 'upsert',
        revision: 3,
        fieldMask: ['icon'],
        payload: { icon: 'debian', iconSource: 'probed', revision: 3 },
    });
    assert.equal(rows.get('c1').icon, 'debian');
    assert.equal(rows.get('c1').iconSource, 'probed');
});

/*
 * Permanent regressions for the audited desktop sync defects
 * (TESTING-AND-RELEASE-GATES.md §11). Each one asserts the user-visible
 * result, not the absence of an exception.
 */

function memoryAdapter(rows) {
    return {
        idOf: (row) => row.id,
        revisionOf: (row) => Number(row.revision) || 0,
        list: () => [...rows.values()],
        read: (_user, id) => rows.get(id) || null,
        create: (_user, id, payload) => {
            rows.set(id, { id, revision: 1, ...payload });
        },
        update: (_user, id, patch) => {
            rows.set(id, { ...rows.get(id), ...patch, revision: (Number(rows.get(id).revision) || 0) + 1 });
        },
        remove: (_user, id) => { rows.delete(id); },
    };
}

function scriptedSync(mod, { rows, specs, httpRequest }) {
    const { sync } = bindDesktopSync(mod, { httpRequest });
    sync.mobileV1Api = {
        adapters: new Map([...rows.keys()].map((type) => [type, memoryAdapter(rows.get(type))])),
        entityByType: new Map(Object.entries(specs)),
    };
    sync.state.bootstrapComplete = true;
    return sync;
}

function pushAwareHttp(onPush) {
    return async (_base, opts) => {
        if (opts.path === '/api/mobile/v1/devices/proof-challenge') return challengeOk(opts);
        if (opts.path === '/api/mobile/v1/sync/push') return onPush(opts);
        if (opts.path === '/api/mobile/v1/capabilities' || String(opts.path || '').includes('capabilities')) {
            return { ok: true, status: 200, headers: {}, data: { registryHash: 'hash', serverId: 'srv-1', serverEncryption: null } };
        }
        throw new Error('unexpected ' + opts.path + ' ' + opts.method);
    };
}

test('SYNC-CAS-001 a locally created row is pushed with baseRevision 0, not its local revision', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n-new', { id: 'n-new', title: 'fresh', revision: 1 }]]);
    let pushed = null;
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => {
            pushed = opts.body;
            return {
                ok: true, status: 200, headers: {},
                data: {
                    results: [{ opId: opts.body.operations[0].opId, status: 'accepted', revision: 1 }],
                    serverCursor: 40,
                },
            };
        }),
    });
    await sync._pushPending();
    assert.ok(pushed, 'a local create must produce an upload');
    assert.equal(pushed.operations.length, 1);
    assert.equal(pushed.operations[0].action, 'upsert');
    assert.equal(pushed.operations[0].baseRevision, 0);
});

test('SYNC-CUR-001 push serverCursor must not advance appliedCursor past unpulled changes', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'edited', revision: 4, confirmedBaseRevision: 3 }]]);
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => ({
            ok: true, status: 200, headers: {},
            data: {
                results: [{ opId: opts.body.operations[0].opId, status: 'accepted', revision: 5 }],
                serverCursor: 20,
            },
        })),
    });
    sync.state.appliedCursor = 10;
    await sync._pushPending();
    assert.equal(sync.state.appliedCursor, 10);
    assert.equal(sync.state.ackedCursor <= 10, true);
});

test('SYNC-OUT-004 a local delete is uploaded and is not resurrected by the mirror scan', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map();
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => ({
            ok: true, status: 200, headers: {},
            data: {
                results: opts.body.operations.map((op) => ({ opId: op.opId, status: 'accepted', revision: op.baseRevision })),
                serverCursor: 11,
            },
        })),
    });
    sync._rememberConfirmed('note', 'gone', 7);
    sync._enqueueDelete('note', 'gone', 7);
    const actions = [];
    const original = sync._http;
    sync._http = async (base, opts) => {
        if (opts.path === '/api/mobile/v1/sync/push') actions.push(...opts.body.operations.map((op) => op.action));
        return original(base, opts);
    };
    await sync._pushPending();
    assert.deepEqual(actions, ['delete']);
});

test('SYNC-SEC-001 a bad secret envelope aborts the entity and never writes a false secret presence', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const connections = new Map();
    const writes = [];
    const adapter = memoryAdapter(connections);
    adapter.create = (...args) => { writes.push(['create', ...args]); };
    adapter.update = (...args) => { writes.push(['update', ...args]); };
    const { sync, keys } = bindDesktopSync(mod, { httpRequest: async () => { throw new Error('unused'); } });
    sync.binding.serverId = 'srv-1';
    sync.mobileV1Api = {
        adapters: new Map([['connection', adapter]]),
        entityByType: new Map([['connection', {
            editableFields: ['name'],
            secretFields: ['password'],
            serverAuthorityFields: ['revision'],
        }]]),
    };
    await assert.rejects(() => sync._applyRemoteChange({
        entityType: 'connection',
        entityId: 'c-secret',
        action: 'upsert',
        revision: 2,
        fieldMask: ['name'],
        payload: { name: 'box', hasPassword: true },
        secretEnvelopes: {
            password: { entityRevision: 2, keyVersion: 1, ciphertext: 'AAAA', nonce: 'BBBB' },
        },
    }), /secret|envelope|aad/i);
    assert.equal(connections.size, 0);
    assert.equal(writes.length, 0);
    assert.equal(JSON.stringify([...connections.values()]).includes('hasPassword'), false);
    void keys;
});

test('SYNC-CON-001 an unpushed local edit survives a remote change to the same row', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'local-edit', revision: 4, confirmedBaseRevision: 3 }]]);
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title', 'body'], secretFields: [], serverAuthorityFields: ['revision'] } },
    });
    sync._enqueueUpsert('note', 'n1', ['title']);
    await sync._applyRemoteChange({
        entityType: 'note',
        entityId: 'n1',
        action: 'upsert',
        revision: 5,
        fieldMask: ['body'],
        payload: { body: 'from-server' },
    });
    assert.equal(notes.get('n1').title, 'local-edit');
    assert.equal(notes.get('n1').body, 'from-server');
    assert.equal(sync.state.pendingCount >= 1, true);
});

test('rebinding isolates the previous account mirror instead of reusing its cursors', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const { sync, dir } = bindDesktopSync(mod, { httpRequest: async () => ({ ok: true, status: 200, headers: {}, data: {} }) });
    sync.state.appliedCursor = 88;
    sync.state.ackedCursor = 80;
    sync._saveState();
    const notes = new Map([['n1', { id: 'n1', title: 'account-a', revision: 3 }]]);
    const localOnly = new Map([['local-1', { id: 'local-1', title: 'keep-me', revision: 1 }]]);
    const noteAdapter = memoryAdapter(notes);
    const localAdapter = memoryAdapter(localOnly);
    sync.mobileV1Api = {
        adapters: new Map([['note', noteAdapter]]),
        entityByType: new Map([['note', { editableFields: ['title'], secretFields: [] }]]),
    };
    /* Non-mirror types must survive unbind. */
    sync.mobileV1Api.adapters.set('snippet', localAdapter);
    sync.unbind();
    const archivePath = path.join(dir, 'accounts', 'srv-1', 'u1', 'dev-1', 'one-link-sync-state.json');
    const snapshotPath = path.join(dir, 'accounts', 'srv-1', 'u1', 'dev-1', 'mirror-snapshot.json');
    assert.equal(fs.existsSync(archivePath), true);
    assert.equal(fs.existsSync(snapshotPath), true);
    const rebound = JSON.parse(fs.readFileSync(path.join(dir, 'one-link-sync-state.json'), 'utf8'));
    assert.equal(Number(rebound.appliedCursor) || 0, 0);
    assert.equal(Number(rebound.ackedCursor) || 0, 0);
    assert.deepEqual(rebound.outbox || [], []);
    assert.deepEqual(rebound.confirmedBaseRevisions || {}, {});
    assert.equal(notes.has('n1'), false);
    assert.equal(localOnly.has('local-1'), true);
});

test('SYNC-CAS-002 a confirmed-base edit is pushed with the server baseline, not the local display revision', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'edited', revision: 10 }]]);
    let pushed = null;
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => {
            pushed = opts.body;
            return {
                ok: true, status: 200, headers: {},
                data: {
                    results: [{ opId: opts.body.operations[0].opId, status: 'accepted', revision: 42 }],
                    serverCursor: 99,
                },
            };
        }),
    });
    sync._rememberConfirmed('note', 'n1', 41);
    sync.recordLocalMutation({
        entityType: 'note',
        entityId: 'n1',
        action: 'upsert',
        fieldMask: ['title'],
    });
    await sync._pushPending();
    assert.ok(pushed, 'the local edit must produce an upload');
    assert.equal(pushed.operations.length, 1);
    assert.equal(pushed.operations[0].baseRevision, 41);
    assert.notEqual(pushed.operations[0].baseRevision, 10);
    assert.equal(sync.state.appliedCursor, 0);
});

test('SYNC-OUT-001 the same opId is retried after an unknown network failure', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'retry-me', revision: 2 }]]);
    const opIds = [];
    let attempts = 0;
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => {
            attempts += 1;
            opIds.push(...opts.body.operations.map((op) => op.opId));
            if (attempts === 1) {
                const err = new Error('network_unknown');
                err.code = 'network_unknown';
                throw err;
            }
            return {
                ok: true, status: 200, headers: {},
                data: {
                    results: opts.body.operations.map((op) => ({ opId: op.opId, status: 'duplicate', revision: 3 })),
                    serverCursor: 12,
                },
            };
        }),
    });
    sync._rememberConfirmed('note', 'n1', 1);
    sync.recordLocalMutation({ entityType: 'note', entityId: 'n1', action: 'upsert', fieldMask: ['title'] });
    await assert.rejects(() => sync._pushPending(), /network_unknown/);
    const pendingAfterFail = (sync.state.outbox || []).filter((op) => op.status === 'pending');
    assert.equal(pendingAfterFail.length, 1);
    await sync._pushPending();
    assert.equal(opIds.length, 2);
    assert.equal(opIds[0], opIds[1]);
    assert.equal((sync.state.outbox || []).filter((op) => op.status === 'pending').length, 0);
});

test('SYNC-OUT-002 mixed accepted/conflict/rejected leaves each op in the protocol state', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([
        ['ok', { id: 'ok', title: 'ok', revision: 2 }],
        ['clash', { id: 'clash', title: 'clash', revision: 2 }],
        ['nope', { id: 'nope', title: 'nope', revision: 2 }],
    ]);
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => {
            const [a, b, c] = opts.body.operations;
            return {
                ok: true, status: 200, headers: {},
                data: {
                    results: [
                        { opId: a.opId, status: 'accepted', revision: 3 },
                        { opId: b.opId, status: 'conflict', reason: 'cas' },
                        { opId: c.opId, status: 'rejected', reason: 'policy' },
                    ],
                    serverCursor: 50,
                },
            };
        }),
    });
    sync.recordLocalMutation({ entityType: 'note', entityId: 'ok', action: 'upsert', fieldMask: ['title'] });
    sync.recordLocalMutation({ entityType: 'note', entityId: 'clash', action: 'upsert', fieldMask: ['title'] });
    sync.recordLocalMutation({ entityType: 'note', entityId: 'nope', action: 'upsert', fieldMask: ['title'] });
    await sync._pushPending();
    const byEntity = Object.fromEntries((sync.state.outbox || []).map((op) => [op.entityId, op]));
    assert.equal(byEntity.ok, undefined);
    assert.equal(byEntity.clash.status, 'conflict');
    assert.equal(byEntity.nope.status, 'pending');
    assert.equal(sync.state.conflicts.some((row) => row.entityId === 'clash'), true);
    assert.equal(sync.state.appliedCursor, 0);
});

test('SYNC-CON-002/003 different fields merge; the same field keeps the local overlay', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'local-title', body: 'local-body', revision: 4 }]]);
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title', 'body'], secretFields: [], serverAuthorityFields: ['revision'] } },
    });
    sync.recordLocalMutation({ entityType: 'note', entityId: 'n1', action: 'upsert', fieldMask: ['title'] });
    await sync._applyRemoteChange({
        entityType: 'note',
        entityId: 'n1',
        action: 'upsert',
        revision: 8,
        fieldMask: ['title', 'body'],
        payload: { title: 'server-title', body: 'server-body' },
    });
    assert.equal(notes.get('n1').title, 'local-title');
    assert.equal(notes.get('n1').body, 'server-body');
});

test('_enqueue persists fieldMask on the pending op', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'a', body: 'b', revision: 2 }]]);
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title', 'body'], secretFields: [], serverAuthorityFields: ['revision'] } },
    });
    const op = sync._enqueueUpsert('note', 'n1', ['title']);
    assert.deepEqual(op.fieldMask, ['title']);
    const again = sync._enqueueUpsert('note', 'n1', ['body']);
    assert.equal(again.opId, op.opId);
    assert.deepEqual([...again.fieldMask].sort(), ['body', 'title']);
});

test('a pending upsert followed by a local delete does not resurrect the row', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map();
    let pushed = null;
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => {
            pushed = opts.body;
            return {
                ok: true, status: 200, headers: {},
                data: {
                    results: opts.body.operations.map((op) => ({ opId: op.opId, status: 'accepted', revision: op.baseRevision })),
                    serverCursor: 7,
                },
            };
        }),
    });
    sync._rememberConfirmed('note', 'n1', 4);
    sync._enqueueUpsert('note', 'n1', ['title']);
    sync._enqueueDelete('note', 'n1', 4);
    const pending = (sync.state.outbox || []).filter((op) => op.status === 'pending' && op.entityId === 'n1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action, 'delete');
    await sync._pushPending();
    assert.ok(pushed);
    assert.deepEqual(pushed.operations.map((op) => op.action), ['delete']);
});

test('SYNC-OUT-004 capture enqueues a delete when a confirmed row vanishes from list', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map();
    const actions = [];
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title'], secretFields: [], serverAuthorityFields: ['revision'] } },
        httpRequest: pushAwareHttp((opts) => {
            actions.push(...opts.body.operations.map((op) => op.action));
            return {
                ok: true, status: 200, headers: {},
                data: {
                    results: opts.body.operations.map((op) => ({ opId: op.opId, status: 'accepted', revision: op.baseRevision })),
                    serverCursor: 11,
                },
            };
        }),
    });
    sync._rememberConfirmed('note', 'gone', 7);
    await sync._pushPending();
    assert.deepEqual(actions, ['delete']);
});

test('bootstrap overlay still protects pending local fields', async (t) => {
    const mod = loadLinkSync();
    if (!mod) { t.skip('@noble/post-quantum is not installed in this worktree'); return; }
    const notes = new Map([['n1', { id: 'n1', title: 'local-edit', revision: 1 }]]);
    const sync = scriptedSync(mod, {
        rows: new Map([['note', notes]]),
        specs: { note: { editableFields: ['title', 'body'], secretFields: [], serverAuthorityFields: ['revision'] } },
    });
    sync.state.bootstrapComplete = false;
    sync.recordLocalMutation({ entityType: 'note', entityId: 'n1', action: 'upsert', fieldMask: ['title'] });
    await sync._applyRemoteChange({
        entityType: 'note',
        entityId: 'n1',
        action: 'upsert',
        revision: 9,
        fieldMask: ['title', 'body'],
        payload: { title: 'from-bootstrap', body: 'boot-body' },
    });
    assert.equal(notes.get('n1').title, 'local-edit');
    assert.equal(notes.get('n1').body, 'boot-body');
});

test('ResourceService create/update/delete fire onOwnedMutation', () => {
    const { ResourceService } = require('../resource-service.js');
    const { CAP, HttpError } = require('../authz.js');
    const events = [];
    const connections = [];
    const storage = {
        rawDb: () => ({ prepare() { return { all: () => [], get: () => null, run: () => {} }; } }),
        getConnectionById: (id) => connections.find((row) => row.id === id) || null,
        insertConnection: (row) => {
            const saved = { ...row, revision: 1 };
            connections.push(saved);
            return saved;
        },
        updateConnectionRow: (row) => {
            const idx = connections.findIndex((item) => item.id === row.id);
            connections[idx] = row;
            return row;
        },
        deleteConnectionRow: (id) => {
            const idx = connections.findIndex((item) => item.id === id);
            if (idx >= 0) connections.splice(idx, 1);
        },
        getProxyRaw: () => null,
        getSshKeyRaw: () => null,
        listJumpHosts: () => [],
    };
    const authz = {
        can() { return true; },
        assertCan(user, capability, resourceType, resourceId, resource, { resourceExists = true } = {}) {
            if (!resourceExists) throw new HttpError(404, 'denied', 'denied', false);
            void capability;
            void CAP;
        },
        audit() {},
        revokeAllForResource() {},
        effectiveCapabilities() { return new Set(['view', 'edit', 'delete', 'use', 'revealSecret']); },
    };
    const service = new ResourceService(storage, authz, {
        mobileChangeBridge: false,
        onOwnedMutation: (event) => events.push(event),
    });
    const user = { userId: 'u1', role: 'user', status: 'active' };
    service.createConnection(user, { id: 'c1', name: 'box', host: 'h', port: 22, protocol: 'SSH' });
    service.updateConnection(user, 'c1', (row) => ({ ...row, name: 'box-2' }));
    service.deleteConnection(user, 'c1');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.action), ['upsert', 'upsert', 'delete']);
    assert.equal(events.every((event) => event.entityType === 'connection' && event.entityId === 'c1'), true);
    assert.equal(events[0].user.userId, 'u1');
});

test('NotesService create/update/delete fire onOwnedMutation', () => {
    const { NotesService } = require('../notes-service.js');
    const events = [];
    const rows = new Map();
    const db = {
        prepare(sql) {
            const text = String(sql);
            if (text.startsWith('INSERT INTO notes')) {
                return {
                    run(params) {
                        rows.set(params.noteId, {
                            note_id: params.noteId,
                            owner_user_id: params.ownerUserId,
                            title: params.title,
                            content: params.content,
                            group_path: params.groupPath,
                            tags_json: params.tagsJson,
                            linked_connection_ids_json: params.linkedJson,
                            sort_order: params.sortOrder,
                            revision: 1,
                            created_at: params.createdAt,
                            updated_at: params.updatedAt,
                            deleted_at: null,
                            visibility: params.visibility,
                            share_with_users: params.shareWithUsers,
                            share_with_admins: params.shareWithAdmins,
                            allow_ai: params.allowAi,
                            allow_ai_read: params.allowAiRead,
                            allow_ai_write: params.allowAiWrite,
                        });
                    },
                };
            }
            if (text.startsWith('SELECT * FROM notes WHERE note_id')) {
                return { get: (id) => rows.get(String(id)) || null };
            }
            if (text.startsWith('UPDATE notes SET title=')) {
                return {
                    run(params) {
                        const row = rows.get(params.noteId);
                        if (!row || row.deleted_at || row.revision !== params.expectedRevision) {
                            return { changes: 0 };
                        }
                        Object.assign(row, {
                            title: params.title,
                            content: params.content,
                            group_path: params.groupPath,
                            tags_json: params.tagsJson,
                            linked_connection_ids_json: params.linkedJson,
                            sort_order: params.sortOrder,
                            revision: params.revision,
                            updated_at: params.updatedAt,
                            visibility: params.visibility,
                            share_with_users: params.shareWithUsers,
                            share_with_admins: params.shareWithAdmins,
                            allow_ai: params.allowAi,
                            allow_ai_read: params.allowAiRead,
                            allow_ai_write: params.allowAiWrite,
                        });
                        return { changes: 1 };
                    },
                };
            }
            if (text.startsWith('UPDATE notes SET deleted_at')) {
                return {
                    run(deletedAt, updatedAt, noteId) {
                        const row = rows.get(String(noteId));
                        if (!row || row.deleted_at) return { changes: 0 };
                        row.deleted_at = deletedAt;
                        row.updated_at = updatedAt;
                        row.revision = Number(row.revision) + 1;
                        return { changes: 1 };
                    },
                };
            }
            return { run() { return { changes: 0 }; }, get() { return null; }, all() { return []; } };
        },
        transaction(fn) { return (...args) => fn(...args); },
    };
    const notes = new NotesService(db, {
        can() { return false; },
        audit() {},
        getUserById: (id) => ({ userId: id, status: 'active' }),
    }, () => 1_700_000_000_000, {
        mobileChangeBridge: false,
        onOwnedMutation: (event) => events.push(event),
    });
    const user = { userId: 'u1', role: 'user', status: 'active' };
    const created = notes.create(user, { title: 'Alpha', content: 'body' });
    notes.update(user, created.noteId, { title: 'Beta', expectedRevision: created.revision });
    notes.delete(user, created.noteId);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.action), ['upsert', 'upsert', 'delete']);
    assert.equal(events.every((event) => event.entityType === 'note' && event.entityId === created.noteId), true);
});
