import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MobileV1OutboxDispatcher } = require(path.join(repoRoot, 'mobile-v1-outbox-dispatcher.js'));

function createBridge(events) {
  const pending = [...events];
  let acknowledgements = 0;
  return {
    pendingWakeEvents(limit) { return pending.slice(0, limit); },
    acknowledgeWakeEvents(ids) {
      acknowledgements += 1;
      const accepted = new Set(ids);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (accepted.has(pending[index].outboxId)) pending.splice(index, 1);
      }
      return ids.length;
    },
    pending,
    get acknowledgements() { return acknowledgements; },
  };
}

function event(outboxId, ownerUserId, throughCursor) {
  return { outboxId, ownerUserId, throughCursor, createdAt: 1 };
}

function dispatcher(bridge, publish, options = {}) {
  const worker = new MobileV1OutboxDispatcher({
    changeBridge: bridge,
    wake: { publish },
    pollMs: 60_000,
    random: () => 0,
    ...options,
  });
  assert.equal(worker.start(), true);
  return worker;
}

test('startup recovery delivers an outbox row left by a previous process', async () => {
  const bridge = createBridge([event(1, 'account-a', 7)]);
  const calls = [];
  const first = dispatcher(bridge, (...args) => calls.push(args));
  first.close();

  const recovered = dispatcher(bridge, (...args) => calls.push(args));
  await recovered.flush();
  recovered.close();

  assert.deepEqual(calls, [['account-a', 7, 'change']]);
  assert.deepEqual(bridge.pending, []);
});

test('coalesces one owner to its highest cursor and acknowledges the batch atomically', async () => {
  const bridge = createBridge([
    event(1, 'account-a', 4), event(2, 'account-a', 9), event(3, 'account-a', 6),
  ]);
  const calls = [];
  const worker = dispatcher(bridge, (...args) => calls.push(args));
  await worker.flush();
  worker.close();

  assert.deepEqual(calls, [['account-a', 9, 'change']]);
  assert.equal(bridge.acknowledgements, 1);
  assert.deepEqual(bridge.pending, []);
});

test('keeps owners isolated while acknowledging successful publishes together', async () => {
  const bridge = createBridge([event(1, 'account-a', 4), event(2, 'account-b', 8)]);
  const calls = [];
  const worker = dispatcher(bridge, (...args) => calls.push(args));
  await worker.flush();
  worker.close();

  assert.deepEqual(calls, [['account-a', 4, 'change'], ['account-b', 8, 'change']]);
  assert.deepEqual(bridge.pending, []);
});

test('retains failed rows for a later exponential-backoff retry', async () => {
  const bridge = createBridge([event(1, 'account-a', 4)]);
  let fail = true;
  const calls = [];
  const scheduled = [];
  const worker = dispatcher(bridge, (...args) => {
    calls.push(args);
    if (fail) throw new Error('network unavailable');
  }, {
    retryBaseMs: 10, retryMaxMs: 40,
    setTimeout(fn, delay) { const handle = { fn, delay }; scheduled.push(handle); return handle; },
    clearTimeout() {},
  });
  await worker.flush();
  assert.equal(bridge.pending.length, 1);
  await worker.flush();
  assert.deepEqual(scheduled.slice(-2).map((handle) => handle.delay), [5, 10]);

  fail = false;
  await worker.flush();
  worker.close();
  assert.deepEqual(calls, [
    ['account-a', 4, 'change'], ['account-a', 4, 'change'], ['account-a', 4, 'change'],
  ]);
  assert.deepEqual(bridge.pending, []);
});

test('an acknowledgement retry is duplicate-safe and never drops an event', async () => {
  const bridge = createBridge([event(1, 'account-a', 4)]);
  const acknowledge = bridge.acknowledgeWakeEvents.bind(bridge);
  let failAck = true;
  bridge.acknowledgeWakeEvents = (ids) => {
    if (failAck) throw new Error('temporary sqlite failure');
    return acknowledge(ids);
  };
  const calls = [];
  const worker = dispatcher(bridge, (...args) => calls.push(args));
  await worker.flush();
  assert.equal(bridge.pending.length, 1);

  failAck = false;
  await worker.flush();
  worker.close();
  assert.deepEqual(calls, [['account-a', 4, 'change'], ['account-a', 4, 'change']]);
  assert.deepEqual(bridge.pending, []);
});

test('only one in-process leader runs and close clears its scheduled recovery timer', () => {
  const scheduled = [];
  const cleared = [];
  const first = new MobileV1OutboxDispatcher({
    changeBridge: createBridge([]), wake: { publish() {} },
    setTimeout(fn, delay) { const handle = { fn, delay }; scheduled.push(handle); return handle; },
    clearTimeout(handle) { cleared.push(handle); },
  });
  const second = new MobileV1OutboxDispatcher({
    changeBridge: createBridge([]), wake: { publish() {} },
  });
  assert.equal(first.start(), true);
  assert.equal(second.start(), false);
  assert.equal(scheduled.length, 1);
  first.close();
  assert.deepEqual(cleared, [scheduled[0]]);
  assert.equal(second.start(), true);
  second.close();
});
