import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachRdpProxyBridge } = require('../server/rdp-proxy-bridge');

class MockSocket extends EventEmitter {
    constructor() { super(); this.paused = 0; this.resumed = 0; }
    pause() { this.paused++; }
    resume() { this.resumed++; }
}

class MockWs extends EventEmitter {
    constructor() {
        super();
        this.OPEN = 1;
        this.readyState = 1;
        this.bufferedAmount = 0;
        this.sent = [];
        this._socket = new MockSocket();
    }
    send(data, options, callback) {
        this.sent.push(Buffer.from(data));
        callback?.();
    }
}

class MockTcp extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.writableLength = 0;
        this.writes = [];
        this.writeResult = true;
        this.paused = 0;
        this.resumed = 0;
    }
    write(data) { this.writes.push(Buffer.from(data)); return this.writeResult; }
    pause() { this.paused++; }
    resume() { this.resumed++; }
}

function fixture(options = {}) {
    const ws = new MockWs();
    const tcpConn = new MockTcp();
    const fatals = [];
    const bridge = attachRdpProxyBridge({ ws, tcpConn, onFatal: (...args) => fatals.push(args), logger: { warn() {} }, ...options });
    return { ws, tcpConn, bridge, fatals };
}

test('binary websocket payloads reach TCP without reordering', () => {
    const { ws, tcpConn } = fixture();
    ws.emit('message', Buffer.from([1, 2]), true);
    ws.emit('message', Buffer.from([3]), true);
    assert.deepEqual(tcpConn.writes.map((b) => [...b]), [[1, 2], [3]]);
});

test('TCP backpressure pauses and drain resumes websocket socket', () => {
    const { ws, tcpConn, bridge } = fixture();
    tcpConn.writeResult = false;
    ws.emit('message', Buffer.from([1]), true);
    assert.equal(ws._socket.paused, 1);
    assert.equal(bridge.state().wsSocketPausedForTcp, true);
    tcpConn.emit('drain');
    assert.equal(ws._socket.resumed, 1);
    assert.equal(bridge.state().wsSocketPausedForTcp, false);
});

test('websocket bufferedAmount applies TCP high and low watermarks', () => {
    const { ws, tcpConn, bridge } = fixture({ limits: { wsHighWater: 8, wsLowWater: 2, wsHardLimit: 20 } });
    ws.bufferedAmount = 10;
    bridge.inspectWsBacklog();
    assert.equal(tcpConn.paused, 1);
    ws.bufferedAmount = 1;
    bridge.inspectWsBacklog();
    assert.equal(tcpConn.resumed, 1);
});

test('websocket bufferedAmount resumes TCP after asynchronous drain', async () => {
    const { ws, tcpConn, bridge } = fixture({ limits: { wsHighWater: 8, wsLowWater: 2, wsHardLimit: 20 } });
    ws.bufferedAmount = 10;
    bridge.inspectWsBacklog();
    ws.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(tcpConn.resumed, 1);
    bridge.dispose();
});

test('v2 flow-control text never reaches RDP TCP stream', () => {
    const { ws, tcpConn, bridge, fatals } = fixture({ flowControlEnabled: true });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'zephyr-rdp-flow', state: 'pause' })), false);
    assert.equal(tcpConn.writes.length, 0);
    assert.equal(tcpConn.paused, 1);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'zephyr-rdp-flow', state: 'resume' })), false);
    assert.equal(tcpConn.resumed, 1);
    assert.deepEqual(fatals, []);
    assert.equal(bridge.state().tcpPausedByClient, false);
});

test('legacy text payload fails closed instead of corrupting TCP stream', () => {
    const { ws, tcpConn, fatals } = fixture();
    ws.emit('message', Buffer.from('not-rdp'), false);
    assert.equal(tcpConn.writes.length, 0);
    assert.equal(fatals[0][0], 'NON_BINARY_RDP_PAYLOAD');
});

test('hard limits fail closed without accepting additional bytes', () => {
    const { ws, tcpConn, bridge, fatals } = fixture({ limits: { wsHighWater: 4, wsLowWater: 1, wsHardLimit: 8, tcpHardLimit: 4 } });
    ws.bufferedAmount = 9;
    bridge.inspectWsBacklog();
    assert.equal(fatals[0][0], 'WS_BUFFER_HARD_LIMIT');

    const second = fixture({ limits: { tcpHardLimit: 4 } });
    second.tcpConn.writableLength = 5;
    second.ws.emit('message', Buffer.from([1]), true);
    assert.equal(second.fatals[0][0], 'TCP_BUFFER_HARD_LIMIT');
});

test('dispose removes data-plane listeners', () => {
    const { ws, tcpConn, bridge } = fixture();
    bridge.dispose();
    ws.emit('message', Buffer.from([1]), true);
    tcpConn.emit('data', Buffer.from([2]));
    assert.equal(tcpConn.writes.length, 0);
    assert.equal(ws.sent.length, 0);
});
