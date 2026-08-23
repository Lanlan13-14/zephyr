import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLinkSyncBridge } = require('../link-v2-sync-bridge.js');
const { KIND } = require('../link-v2-codec.js');

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function makeBridge({ deviceRow = null, user = null, pushResult = null } = {}) {
    const calls = { push: 0 };
    const api = {
        store: { getDeviceRow: (id) => (id === 'dev-1' ? deviceRow : null) },
        executePushForDevice: (auth, body) => { calls.push += 1; return pushResult; },
    };
    const storage = { getUserBrief: (id) => user };
    const bridge = createLinkSyncBridge({ api, storage, adminToken: 'tok-abcdef0123456789' });
    return { bridge, calls };
}

test('rejects a wrong admin token', () => {
    const { bridge } = makeBridge();
    const res = mockRes();
    bridge.handle({ get: () => 'wrong-token', body: { deviceId: 'dev-1', kind: KIND.SYNC_OP, body: {} } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
});

test('rejects an unknown device', () => {
    const { bridge } = makeBridge({ deviceRow: null, user: { userId: 'u1' } });
    const res = mockRes();
    bridge.handle({ get: () => 'tok-abcdef0123456789', body: { deviceId: 'dev-1', kind: KIND.SYNC_OP, body: {} } }, res);
    assert.equal(res.statusCode, 401);
});

test('rejects a revoked device', () => {
    const { bridge, calls } = makeBridge({
        deviceRow: { device_id: 'dev-1', owner_user_id: 'u1', enabled: 1, revoked_at: 123 },
        user: { userId: 'u1' },
    });
    const res = mockRes();
    bridge.handle({ get: () => 'tok-abcdef0123456789', body: { deviceId: 'dev-1', kind: KIND.SYNC_OP, body: {} } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls.push, 0, 'must not touch the sync core for a revoked device');
});

test('a valid SYNC_OP reaches the single sync core and returns its result', () => {
    const pushResult = { ok: true, batchId: 'b1', serverCursor: 42, results: [] };
    const { bridge, calls } = makeBridge({
        deviceRow: { device_id: 'dev-1', owner_user_id: 'u1', enabled: 1, revoked_at: null },
        user: { userId: 'u1' },
        pushResult,
    });
    const res = mockRes();
    bridge.handle({ get: () => 'tok-abcdef0123456789', body: { deviceId: 'dev-1', kind: KIND.SYNC_OP, body: { operations: [] } } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.kind, KIND.SYNC_ACK);
    assert.equal(res.body.body.serverCursor, 42);
    assert.equal(calls.push, 1, 'exactly one call into the shared sync core');
});

test('an unsupported kind is rejected without touching the core', () => {
    const { bridge, calls } = makeBridge({
        deviceRow: { device_id: 'dev-1', owner_user_id: 'u1', enabled: 1, revoked_at: null },
        user: { userId: 'u1' },
    });
    const res = mockRes();
    bridge.handle({ get: () => 'tok-abcdef0123456789', body: { deviceId: 'dev-1', kind: KIND.WAKE, body: {} } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.push, 0);
});
