import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { FileAgentConnection } from '../file-agent-manager.js';
import { OP, FLAG_RESPONSE, encodeFrame } from '../file-transfer-protocol.js';

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
}

function connection() {
  return new FileAgentConnection(new MockAgentSocket(), 'agent-1', {
    protocolVersion: 2,
    deviceName: 'phone',
    capabilities: { binaryRead: true, binaryWrite: true, maxInflight: 2, maxChunkSize: 1048576 },
    share: { readOnly: false },
  });
}

test('Agent v2 resolves binary reads and structured writes', async () => {
  const conn = connection();
  const read = conn.callBinaryV2(OP.READ, { handle: 'h', offset: 0, length: 3 }, null, 1000);
  const readId = conn.nextRequestId - 1;
  conn.handleBinaryResponse(encodeFrame({ type: OP.READ, requestId: readId, flags: FLAG_RESPONSE, meta: { bytesRead: 3 }, payload: Buffer.from([9, 8, 7]) }));
  assert.deepEqual([...await read.promise], [9, 8, 7]);

  const write = conn.callBinaryV2(OP.WRITE, { handle: 'h', offset: 0 }, Buffer.from([1]), 1000);
  const writeId = conn.nextRequestId - 1;
  conn.handleBinaryResponse(encodeFrame({ type: OP.WRITE, requestId: writeId, flags: FLAG_RESPONSE, meta: { bytesWritten: 1 } }));
  assert.deepEqual(await write.promise, { bytesWritten: 1 });
});

test('Agent v2 cancellation rejects immediately and emits CANCEL', async () => {
  const conn = connection();
  const operation = conn.callBinaryV2(OP.READ, { handle: 'h', offset: 0, length: 1 }, null, 1000);
  operation.cancel();
  await assert.rejects(operation.promise, (error) => error.code === 'cancelled');
  assert.equal(conn.pendingRequests.size, 0);
  assert.equal(conn.ws.sent.length, 2);
});

test('Agent v2 queues requests beyond in-flight limit and unblocks when slot frees', async () => {
  const conn = connection();
  // Fill both slots (maxInflight=2 in the mock connection).
  const one = conn.callBinaryV2(OP.READ, { handle: 'h1', length: 1 }, null, 1000);
  const two = conn.callBinaryV2(OP.READ, { handle: 'h2', length: 1 }, null, 1000);
  // Third request arrives while the window is full — must NOT reject immediately
  // with "busy"; it should queue and wait for a slot to free up.
  const three = conn.callBinaryV2(OP.READ, { handle: 'h3', length: 1 }, null, 1000);

  // Give the event loop several poll intervals so any instant-reject would fire.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(conn.ws.sent.length, 2, 'third request should be queued, not sent yet');
  // Confirm three is not yet in the pending map (still waiting for a slot).
  assert.equal(conn.pendingRequests.size, 2, 'only two requests should hold a slot');

  // Free one slot — one.cancel() also sends a CANCEL frame.
  one.cancel();
  await assert.rejects(one.promise, (e) => e.code === 'cancelled');

  // After the slot frees the third request should acquire it and send its
  // frame within a few poll intervals (≤ 30 ms).
  await new Promise((r) => setTimeout(r, 30));
  // Sent count: 2 (initial) + 1 (cancel for one) + 1 (three's frame) = 4.
  assert.equal(conn.ws.sent.length, 4, 'third request should have sent after slot freed');
  assert.equal(conn.pendingRequests.size, 2, 'two and three should now hold slots');

  // Clean up — cancel remaining to avoid dangling timers.
  two.cancel();
  three.cancel();
  await Promise.allSettled([two.promise, three.promise]);
});
