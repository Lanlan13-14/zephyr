import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { proxyLinkV2Stream } = require('../link-v2-go-proxy.js');

class FakeWs extends EventEmitter {
  constructor({ bufferedAmount = 0, readyState = 1 } = {}) {
    super(); this.OPEN = 1; this.readyState = readyState; this.bufferedAmount = bufferedAmount; this.sent = []; this.closed = null;
  }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, reason); }
}

class FakeUpstream extends FakeWs {
  constructor() { super({ readyState: 0 }); this.terminateCount = 0; }
  terminate() { this.terminateCount++; this.readyState = 3; }
}

function setup({ start = Promise.resolve(), req = { url: '/?sessionId=s' }, ws = new FakeWs() } = {}) {
  const upstream = new FakeUpstream();
  let currentUpstream;
  class FakeWebSocket {
    constructor() { return upstream; }
  }
  proxyLinkV2Stream(ws, req, { proc: { ensureStarted: async () => { await start; return '127.0.0.1:1'; } }, onUpstream: (u) => { currentUpstream = u; }, WebSocket: FakeWebSocket });
  return { ws, upstream, get currentUpstream() { return currentUpstream; } };
}

test('queues messages emitted while upstream initializes, preserving order', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ws, upstream } = setup({ start: gate });
  upstream.readyState = 1;
  const a = Buffer.from([1, 2]); const b = Buffer.from([3]);
  ws.emit('message', a); ws.emit('message', b);
  release(); await new Promise((r) => setTimeout(r, 30));
  upstream.emit('open');
  assert.deepEqual(upstream.sent.map((x) => [...x]), [[1, 2], [3]]);
});

test('counts ArrayBuffer/view bytes and includes current frame in bufferedAmount', async () => {
  const { ws, upstream } = setup();
  upstream.readyState = 1;
  await new Promise((r) => setImmediate(r));
  upstream.emit('open'); upstream.bufferedAmount = 8 * 1024 * 1024 - 2;
  ws.emit('message', new Uint8Array([1, 2, 3]).buffer);
  assert.equal(ws.closed?.code, 1013);
});

test('cleans queue and terminates upstream when client closes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ws, upstream } = setup({ start: gate });
  ws.emit('message', Buffer.alloc(4)); release(); await new Promise((r) => setTimeout(r, 20)); ws.emit('close');
  await new Promise((r) => setImmediate(r));
  assert.equal(upstream.terminateCount, 1);
  assert.deepEqual(upstream.sent, []);
});
