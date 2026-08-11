import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const {
  FileAgentManager,
  FileAgentAdmissionGate,
  canonicalRemoteIp,
  FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES,
  FILE_AGENT_AUTHENTICATED_MAX_MESSAGE_BYTES,
} = require('../file-agent-manager.js');

class FakeRawSocket extends EventEmitter {
  constructor(remoteAddress) {
    super();
    this.remoteAddress = remoteAddress;
  }
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
    this.closeCalls = [];
    this.terminated = false;
    this._receiver = { _maxPayload: FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES };
  }

  send(value) {
    this.sent.push(String(value));
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason: String(reason || '') });
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', code, Buffer.from(String(reason || ''))));
  }

  terminate() {
    this.terminated = true;
    this.close(1006, 'terminated');
  }
}

function tempManager(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-file-agent-gate-'));
  const manager = new FileAgentManager({
    tokenFile: path.join(directory, 'agent-tokens.json'),
    log: () => {},
    ...options,
  });
  return {
    directory,
    manager,
    cleanup() {
      manager.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function hello(token, deviceId = 'device-1') {
  return {
    type: 'hello',
    protocolVersion: 2,
    token,
    deviceId,
    deviceName: deviceId,
    platform: 'test',
    appVersion: '1.0.0',
    capabilities: { read: true, binaryRead: true, maxInflight: 8 },
    share: { name: deviceId, readOnly: true },
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('canonical IP and pre-auth concurrency limits use only remoteAddress', () => {
  assert.equal(canonicalRemoteIp({ remoteAddress: '::ffff:192.0.2.7' }), '192.0.2.7');
  assert.equal(canonicalRemoteIp({
    remoteAddress: '192.0.2.7',
    headers: { 'x-forwarded-for': '203.0.113.99' },
  }), '192.0.2.7');
  assert.equal(
    canonicalRemoteIp({ remoteAddress: '2001:0db8:0:0:0:0:0:1' }),
    canonicalRemoteIp({ remoteAddress: '2001:db8::1' }),
  );
  assert.equal(canonicalRemoteIp({ remoteAddress: 'not-an-ip' }), 'unknown');

  const gate = new FileAgentAdmissionGate({
    preAuthGlobal: 3,
    preAuthPerIp: 2,
    globalRateBurst: 100,
    perIpRateBurst: 100,
  }, () => {});
  const one = gate.admit(new FakeRawSocket('192.0.2.7'));
  const mapped = gate.admit(new FakeRawSocket('::ffff:192.0.2.7'));
  assert.equal(one.ok, true);
  assert.equal(mapped.ok, true);
  assert.equal(gate.admit(new FakeRawSocket('192.0.2.7')).code, 'preauth_ip_limit');
  const otherIp = gate.admit(new FakeRawSocket('198.51.100.2'));
  assert.equal(otherIp.ok, true);
  assert.equal(gate.admit(new FakeRawSocket('203.0.113.9')).code, 'preauth_global_limit');
  assert.deepEqual(gate.snapshot().preAuthByIp, {
    '192.0.2.7': 2,
    '198.51.100.2': 1,
  });

  one.lease.socket.emit('error', new Error('closed during upgrade'));
  one.lease.socket.emit('close');
  assert.equal(gate.release(one.lease), false, 'release is idempotent after error/close races');
  gate.release(mapped.lease);
  gate.release(otherIp.lease);
  assert.deepEqual(gate.snapshot(), {
    preAuth: 0,
    authenticated: 0,
    pendingBytes: 0,
    preAuthByIp: {},
    authenticatedByIp: {},
  });
});

test('global and per-IP token buckets throttle upgrade churn and refill', () => {
  let now = 1000;
  const gate = new FileAgentAdmissionGate({
    now: () => now,
    preAuthGlobal: 20,
    preAuthPerIp: 20,
    globalRateBurst: 3,
    globalRatePerSecond: 1,
    perIpRateBurst: 2,
    perIpRatePerSecond: 1,
  }, () => {});
  const admitAndRelease = (ip) => {
    const admitted = gate.admit(new FakeRawSocket(ip));
    if (admitted.ok) gate.release(admitted.lease);
    return admitted;
  };

  assert.equal(admitAndRelease('192.0.2.1').ok, true);
  assert.equal(admitAndRelease('192.0.2.1').ok, true);
  assert.equal(admitAndRelease('192.0.2.1').code, 'upgrade_ip_rate');
  assert.equal(admitAndRelease('192.0.2.2').ok, true);
  assert.equal(admitAndRelease('192.0.2.3').code, 'upgrade_global_rate');
  now += 1000;
  assert.equal(admitAndRelease('192.0.2.1').ok, true);
  assert.equal(gate.snapshot().preAuth, 0);
});

test('authentication atomically transfers quota and close/error races restore counts', async (t) => {
  const fixture = tempManager({
    admission: {
      preAuthGlobal: 4,
      preAuthPerIp: 4,
      authenticatedGlobal: 2,
      authenticatedPerIp: 1,
      globalRateBurst: 100,
      perIpRateBurst: 100,
    },
  });
  t.after(() => fixture.cleanup());
  const token = fixture.manager.createToken({ userId: 'owner-1', username: 'owner' }, 'test').token;

  const rawOne = new FakeRawSocket('::ffff:192.0.2.10');
  const admittedOne = fixture.manager.admitUpgrade(rawOne);
  const wsOne = new FakeWebSocket();
  fixture.manager.handleConnection(wsOne, { fileAgentAdmission: admittedOne.lease });
  wsOne.emit('message', Buffer.from(JSON.stringify(hello(token, 'one'))), false);
  assert.deepEqual(fixture.manager.getAdmissionSnapshot(), {
    preAuth: 0,
    authenticated: 1,
    pendingBytes: 0,
    preAuthByIp: {},
    authenticatedByIp: { '192.0.2.10': 1 },
  });
  assert.equal(wsOne._receiver._maxPayload, FILE_AGENT_AUTHENTICATED_MAX_MESSAGE_BYTES);

  const rawTwo = new FakeRawSocket('192.0.2.10');
  const admittedTwo = fixture.manager.admitUpgrade(rawTwo);
  const wsTwo = new FakeWebSocket();
  fixture.manager.handleConnection(wsTwo, { fileAgentAdmission: admittedTwo.lease });
  wsTwo.emit('message', Buffer.from(JSON.stringify(hello(token, 'two'))), false);
  await nextTurn();
  assert.equal(wsTwo.closeCalls[0]?.code, 1008);
  assert.match(wsTwo.sent.join('\n'), /resource_exhausted/);
  assert.equal(fixture.manager.getAdmissionSnapshot().preAuth, 0);
  assert.equal(fixture.manager.getAdmissionSnapshot().authenticated, 1);

  wsOne.emit('error', new Error('transport failed'));
  wsOne.emit('close');
  await nextTurn();
  assert.deepEqual(fixture.manager.getAdmissionSnapshot(), {
    preAuth: 0,
    authenticated: 0,
    pendingBytes: 0,
    preAuthByIp: {},
    authenticatedByIp: {},
  });
});

test('strict first hello, byte budget, slow hello, and synchronous close release pre-auth leases', async (t) => {
  const fixture = tempManager({
    authTimeoutMs: 20,
    preAuthCloseGraceMs: 10,
    preAuthMaxMessageBytes: 512,
    admission: {
      preAuthGlobal: 8,
      preAuthPerIp: 8,
      authenticatedGlobal: 8,
      authenticatedPerIp: 8,
      globalRateBurst: 100,
      perIpRateBurst: 100,
      maxPendingBytes: 160,
    },
  });
  t.after(() => fixture.cleanup());
  const token = fixture.manager.createToken({ userId: 'owner-2', username: 'owner' }, 'test').token;

  const invalidWs = new FakeWebSocket();
  fixture.manager.handleConnection(invalidWs);
  invalidWs.emit('message', Buffer.from('{"type":"ping"}'), false);
  await nextTurn();
  assert.equal(invalidWs.closeCalls[0]?.code, 1008);

  const budgetWs = new FakeWebSocket();
  fixture.manager.handleConnection(budgetWs);
  budgetWs.emit('message', Buffer.from(JSON.stringify(hello(token, 'budget'))), false);
  await nextTurn();
  assert.equal(budgetWs.closeCalls[0]?.code, 1009);

  const slowWs = new FakeWebSocket();
  fixture.manager.handleConnection(slowWs);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(slowWs.closeCalls[0]?.code, 1008);

  const closeDuringAck = new FakeWebSocket();
  closeDuringAck.send = function send(value) {
    this.sent.push(String(value));
    this.close(1000, 'closed in send');
  };
  fixture.manager.handleConnection(closeDuringAck);
  const compactHello = { type: 'hello', protocolVersion: 2, token, deviceId: 'race' };
  closeDuringAck.emit('message', Buffer.from(JSON.stringify(compactHello)), false);
  await nextTurn();
  assert.equal(fixture.manager.agents.size, 0);
  assert.deepEqual(fixture.manager.getAdmissionSnapshot(), {
    preAuth: 0,
    authenticated: 0,
    pendingBytes: 0,
    preAuthByIp: {},
    authenticatedByIp: {},
  });
});

async function wsHarness(t) {
  const fixture = tempManager({
    admission: {
      preAuthGlobal: 8,
      preAuthPerIp: 8,
      authenticatedGlobal: 8,
      authenticatedPerIp: 8,
      globalRateBurst: 100,
      perIpRateBurst: 100,
    },
  });
  const token = fixture.manager.createToken({ userId: 'ws-owner', username: 'owner' }, 'ws').token;
  const server = http.createServer();
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES,
  });
  server.on('upgrade', (req, socket, head) => {
    const admitted = fixture.manager.admitUpgrade(socket);
    if (!admitted.ok) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    req.fileAgentAdmission = admitted.lease;
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch {
      fixture.manager.releaseUpgradeAdmission(admitted.lease);
      socket.destroy();
    }
  });
  wss.on('connection', (ws, req) => fixture.manager.handleConnection(ws, req));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fixture.cleanup();
  });
  const port = server.address().port;
  return { fixture, token, url: `ws://127.0.0.1:${port}/agent/files` };
}

test('fragmented hello is aggregated once and promoted before larger authenticated payloads', async (t) => {
  const harness = await wsHarness(t);
  const client = new WebSocket(harness.url, { perMessageDeflate: false });
  await once(client, 'open');
  const body = JSON.stringify(hello(harness.token, 'fragmented'));
  const acknowledgement = once(client, 'message');
  client.send(body.slice(0, 17), { fin: false });
  client.send(body.slice(17), { fin: true });
  const [rawAck] = await acknowledgement;
  assert.equal(JSON.parse(rawAck.toString()).ok, true);
  assert.equal(harness.fixture.manager.getAdmissionSnapshot().authenticated, 1);

  const pong = once(client, 'message');
  client.send(JSON.stringify({ type: 'ping', padding: 'x'.repeat(32 * 1024) }));
  const [rawPong] = await pong;
  assert.equal(JSON.parse(rawPong.toString()).type, 'pong');

  client.close();
  await once(client, 'close');
  await waitFor(() => harness.fixture.manager.getAdmissionSnapshot().authenticated === 0);
  assert.equal(harness.fixture.manager.getAdmissionSnapshot().authenticated, 0);
});

test('fragmented pre-auth payload over the aggregate limit closes 1009 before hello parsing', async (t) => {
  const harness = await wsHarness(t);
  const client = new WebSocket(harness.url, { perMessageDeflate: false });
  await once(client, 'open');
  const oversized = `{"type":"hello","padding":"${'a'.repeat(FILE_AGENT_PREAUTH_MAX_MESSAGE_BYTES)}"}`;
  const closed = once(client, 'close');
  client.send(oversized.slice(0, 9000), { fin: false });
  client.send(oversized.slice(9000), { fin: true });
  const [code] = await closed;
  assert.equal(code, 1009);
  await nextTurn();
  assert.deepEqual(harness.fixture.manager.getAdmissionSnapshot(), {
    preAuth: 0,
    authenticated: 0,
    pendingBytes: 0,
    preAuthByIp: {},
    authenticatedByIp: {},
  });
});
