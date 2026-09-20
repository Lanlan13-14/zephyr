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
