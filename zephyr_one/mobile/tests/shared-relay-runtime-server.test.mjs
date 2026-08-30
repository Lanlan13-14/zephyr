import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startSharedRelayRuntimeServer } from './shared-relay-runtime-server.mjs';

function waitForJson(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`missing ${type}`)), 3000);
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.type === type) {
        clearTimeout(timer);
        resolve(frame);
      }
    });
  });
}

function waitForBytes(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('missing binary data')), 3000);
    const listener = (raw, binary) => {
      if (!binary) return;
      ws.off('message', listener);
      clearTimeout(timer);
      resolve(Buffer.from(raw));
    };
    ws.on('message', listener);
  });
}


test('shared relay runtime forwards input output and resize with subprotocol credential', async () => {
  const runtime = await startSharedRelayRuntimeServer();
  const ws = new WebSocket(runtime.relayUrl, ['zephyr-shared-relay-v1', 'single-use']);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    assert.equal((await waitForBytes(ws)).toString(), 'banner');
    ws.send(JSON.stringify({ type: 'input', data: 'whoami' }));
    assert.equal((await waitForBytes(ws)).toString(), 'echo:whoami');
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40, widthPx: 1000, heightPx: 800 }));
    assert.deepEqual(await waitForJson(ws, 'resized'), { type: 'resized', cols: 100, rows: 40 });
    assert.deepEqual(runtime.attach(), { path: '/relay', credential: 'single-use' });
  } finally {
    ws.terminate();
    await runtime.close();
  }
});
