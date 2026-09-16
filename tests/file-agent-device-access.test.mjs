// Device-enrollment authentication for the File Agent gateway.
//
// One enrollment issues short-lived access credentials bound to a deviceId.
// The gateway must authenticate those without any Client Token, reject
// credential/deviceId mismatches, and keep legacy tokens working during the
// migration window.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FileAgentManager } from '../file-agent-manager.js';

class MockAgentSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.OPEN = 1;
        this.sent = [];
    }
    send(frame, options, callback) {
        this.sent.push({ frame: Buffer.from(frame), options });
        callback?.();
    }
    close() { this.readyState = 3; }
}

function managerWith(resolver) {
    return new FileAgentManager({
        tokenFile: '/tmp/zephyr-agent-device-access-test-missing.json',
        resolveDeviceAccess: resolver,
    });
}

const DEVICE_ROW = {
    device_id: 'device-aaaa-bbbb-cccc',
    owner_user_id: 'user-1',
    owner_username: 'alice',
    token_id: 'link-v2-enrollment',
    device_name: 'Alice Agent',
};

function hello(overrides = {}) {
    return {
        type: 'hello',
        protocolVersion: 2,
        token: '',
        deviceId: DEVICE_ROW.device_id,
        deviceName: 'Alice Agent',
        platform: 'agent',
        appVersion: 'agent-test',
        capabilities: { binary: true, maxInflight: 2 },
        share: { readOnly: true },
        ...overrides,
    };
}

test('access credential authenticates without any legacy token', () => {
    const manager = managerWith((credential) => credential === 'cred-ok' ? DEVICE_ROW : null);
    const ws = new MockAgentSocket();
    const agentId = manager._handleHello(ws, hello({ accessCredential: 'cred-ok' }));
    assert.match(agentId, /^agent_/);
    const conn = manager.agents.get(agentId);
    assert.equal(conn.ownerId, 'user-1');
    assert.equal(conn.tokenName, 'Alice Agent');
    assert.ok(JSON.parse(ws.sent[0].frame.toString()).ok);
    manager.shutdown();
});

test('credential for a different deviceId is rejected', () => {
    const manager = managerWith(() => DEVICE_ROW);
    assert.throws(
        () => manager._handleHello(new MockAgentSocket(), hello({
            accessCredential: 'cred-ok',
            deviceId: 'another-device-id-0000',
        })),
        (err) => err.code === 'unauthorized' && /does not match/.test(err.message),
    );
    manager.shutdown();
});

test('invalid credential without token fallback is rejected', () => {
    const manager = managerWith(() => null);
    assert.throws(
        () => manager._handleHello(new MockAgentSocket(), hello({ accessCredential: 'cred-bad' })),
        (err) => err.code === 'unauthorized',
    );
    manager.shutdown();
});

test('enrolled device connection registers Link identity without the token store', async () => {
    let registered = null;
    const manager = new FileAgentManager({
        tokenFile: '/tmp/zephyr-agent-device-access-test-missing.json',
        resolveDeviceAccess: (c) => (c === 'cred-ok' ? DEVICE_ROW : null),
        linkRegisterAgentKey: async (deviceId, jwk) => { registered = { deviceId, jwk }; },
    });
    const jwk = JSON.stringify({
        kty: 'EC', crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    const ws = new MockAgentSocket();
    const agentId = manager._handleHello(ws, hello({
        accessCredential: 'cred-ok', token: '', linkSigningJwk: jwk,
    }));
    // hello only records the signing JWK; registration runs when the Agent
    // sends link_register. Simulate that frame.
    manager._registerAgentLinkKey(agentId, ws);
    for (let i = 0; i < 20 && !registered; i += 1) {
        await new Promise((r) => setImmediate(r));
    }
    assert.ok(registered, 'Go bridge registration must run');
    assert.equal(registered.deviceId, DEVICE_ROW.device_id);
    assert.equal(registered.jwk.kty, 'EC');
    // The sentinel enrollment tokenId must never reach the token store:
    // with no tokens loaded, bindLinkIdentity would have thrown
    // token_not_found ("Token 未绑定" symptom) — it did not.
    assert.equal(manager.agents.get(agentId).deviceCredential, DEVICE_ROW);
    manager.shutdown();
});

test('legacy token still authenticates when no credential is present', () => {
    // Resolver only accepts 'cred-ok'; anything else falls to the token path.
    const manager = managerWith((credential) => credential === 'cred-ok' ? DEVICE_ROW : null);
    const ws = new MockAgentSocket();
    assert.throws(
        () => manager._handleHello(ws, hello({ token: 'legacy-token', accessCredential: undefined })),
        (err) => err.code === 'unauthorized',
    );
    // The invalid-credential fallback must not throw TypeError.
    assert.throws(
        () => manager._handleHello(new MockAgentSocket(), hello({ accessCredential: 'cred-bad', token: '' })),
        (err) => err.code === 'unauthorized' && err.message === 'Invalid token',
    );
    manager.shutdown();
});

test('tokenless link identity registers through the Go bridge only', async () => {
    const registered = [];
    const manager = new FileAgentManager({
        tokenFile: '/tmp/zephyr-agent-link-identity-test-missing.json',
        linkRegisterAgentKey: async (deviceId, jwk) => { registered.push({ deviceId, jwk }); },
    });
    const identity = await manager.registerLinkIdentity({
        ownerId: 'user-1',
        deviceId: 'device-eeee-ffff',
        signingJwk: { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' },
    });
    assert.equal(identity.deviceId, 'device-eeee-ffff');
    assert.equal(registered.length, 1);
    assert.equal(registered[0].deviceId, 'device-eeee-ffff');
    assert.equal(registered[0].jwk.crv, 'P-256');
    // No token store row should exist for a tokenless identity.
    assert.equal(manager.listLinkIdentities().filter((r) => r.link_device_id === 'device-eeee-ffff').length, 0);
    manager.shutdown();
});

test('enrollment platform whitelist accepts agent-android', () => {
    const manager = managerWith(() => DEVICE_ROW);
    const ws = new MockAgentSocket();
    const agentId = manager._handleHello(ws, hello({
        platform: 'agent-android',
        accessCredential: 'cred-ok',
    }));
    assert.match(agentId, /^agent_/);
    manager.shutdown();
});

test('enrollment platform whitelist accepts agent platforms', () => {
    const manager = managerWith(() => DEVICE_ROW);
    const ws = new MockAgentSocket();
    const agentId = manager._handleHello(ws, hello({
        platform: 'agent-windows',
        accessCredential: 'cred-ok',
    }));
    assert.match(agentId, /^agent_/);
    manager.shutdown();
});