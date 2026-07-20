import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  OP, FLAG_ERROR, FLAG_RESPONSE, encodeFrame, decodeFrame,
} from '../file-transfer-protocol.js';
import { FileTransferGateway } from '../file-transfer-ws.js';

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.OPEN = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = null;
  }
  send(frame, _options, callback) {
    this.sent.push(Buffer.from(frame));
    callback?.();
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function fixture({ owner = true, fileRead = true, fileWrite = true, agentResult = {} } = {}) {
  let called = null;
  let cancelled = false;
  const manager = {
    isAgentOwnedByUser: () => owner,
    callAgentV2(agentId, method, params) {
      called = { agentId, method, params };
      return { promise: Promise.resolve(agentResult), cancel() { cancelled = true; } };
    },
  };
  const authz = {
    assertCan(_user, cap) { if (cap === 'fileRead' && !fileRead) throw Object.assign(new Error('denied'), { code: 'denied' }); },
    can(_user, cap) { return cap !== 'fileWrite' || fileWrite; },
  };
  const storage = {
    getUserBrief: () => ({ userId: 'u1', username: 'alice', status: 'active' }),
    getConnectionById: () => ({ id: 'c1', ownerUserId: 'u1' }),
  };
  return {
    gateway: new FileTransferGateway({ fileAgentManager: manager, authz, storage, log() {} }),
    get called() { return called; },
    get cancelled() { return cancelled; },
  };
}

function request(url = '/file-transfer?agentId=a1&connectionId=c1') {
  return { url, headers: { host: 'example.test' }, authSession: { userId: 'u1' } };
}

async function deliver(gateway, socket, req, frame) {
  gateway.handleConnection(socket, req);
  socket.emit('message', frame, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('gateway forwards binary writes without base64 and returns structured response', async () => {
  const f = fixture({ agentResult: { bytesWritten: 3 } });
  const socket = new MockSocket();
  await deliver(f.gateway, socket, request(), encodeFrame({ type: OP.WRITE, requestId: 7, meta: { handle: 'h', offset: 9 }, payload: Buffer.from([0, 255, 1]) }));
  assert.equal(f.called.method, 'writeBinary');
  assert.deepEqual([...f.called.params.data], [0, 255, 1]);
  const response = decodeFrame(socket.sent[0]);
  assert.equal(response.flags, FLAG_RESPONSE);
  assert.deepEqual(response.meta, { bytesWritten: 3 });
});

test('gateway returns raw binary read payload', async () => {
  const f = fixture({ agentResult: Buffer.from([5, 4, 3]) });
  const socket = new MockSocket();
  await deliver(f.gateway, socket, request(), encodeFrame({ type: OP.READ, requestId: 8, meta: { handle: 'h', offset: 0, length: 3 } }));
  const response = decodeFrame(socket.sent[0]);
  assert.deepEqual([...response.payload], [5, 4, 3]);
  assert.deepEqual(response.meta, { bytesRead: 3, eof: false });
});

test('gateway rejects cross-user agents and missing read permission at bind time', () => {
  const crossUser = fixture({ owner: false });
  const socketA = new MockSocket();
  crossUser.gateway.handleConnection(socketA, request());
  assert.equal(socketA.closed.code, 1008);
  const denied = fixture({ fileRead: false });
  const socketB = new MockSocket();
  denied.gateway.handleConnection(socketB, request());
  assert.equal(socketB.closed.code, 1008);
});

test('gateway enforces fileWrite independently', async () => {
  const f = fixture({ fileWrite: false });
  const socket = new MockSocket();
  await deliver(f.gateway, socket, request(), encodeFrame({ type: OP.WRITE, requestId: 10, meta: { handle: 'h' }, payload: Buffer.from([1]) }));
  const response = decodeFrame(socket.sent[0]);
  assert.equal(response.flags, FLAG_RESPONSE | FLAG_ERROR);
  assert.equal(response.meta.code, 'read_only');
  assert.equal(f.called, null);
});

test('gateway allows owner-bound transient RDP sessions without a saved connection id', () => {
  const f = fixture();
  const binding = f.gateway.authorize(request('/file-transfer?agentId=a1'));
  assert.equal(binding.connectionId, '');
  assert.equal(binding.canWrite, true);
});
