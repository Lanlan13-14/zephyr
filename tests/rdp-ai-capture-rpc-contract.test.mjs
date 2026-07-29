import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/rdp-worker-bridge.js', import.meta.url), 'utf8');

test('RDP AI capture uses the implemented Worker RPC method', () => {
  assert.match(bridge, /call\(method, args = \[\]\) \{/);
  assert.match(bridge, /type: 'request'/);
  assert.match(client, /rdpWorkerBridge\.call\('rdpCaptureFrame', \[\]\)/);
  assert.doesNotMatch(client, /rdpWorkerBridge\.request\('rdpCaptureFrame'/);
});
