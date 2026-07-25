import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('requestAgent retries transient busy/timeout/backpressure', () => {
  const retry = read('rdp-wasm/agent_retry.go');
  const rdpefs = read('rdp-wasm/rdpefs.go');
  assert.match(retry, /agentRequestMaxAttempts\s*=\s*4/);
  assert.match(retry, /func isRetryableAgentError/);
  assert.match(retry, /case "busy", "timeout", "io_error", "backpressure":/);
  assert.match(rdpefs, /for attempt := 1; attempt <= agentRequestMaxAttempts/);
  // Permanent errors must still short-circuit.
  assert.match(rdpefs, /!isRetryableAgentError\(err\)/);
});

test('callAgentStat distinguishes not_found from transient errors', () => {
  const src = read('rdp-wasm/rdpefs.go');
  assert.match(src, /func \(h \*RdpefsHandler\) callAgentStat\(agentID, path string\) \(\*agentFileStat, error\)/);
  assert.match(src, /zerr\.Code == "not_found"/);
  // CREATE must not invent NO_SUCH_FILE on transient stat failure.
  assert.match(src, /statResult, statErr := h\.callAgentStat/);
  assert.match(src, /if statErr != nil \{\s*\n\s*\/\/ Transient failure/);
});

test('browser ZFT2 client queues on full window instead of busy-fail', () => {
  const src = read('rdp-wasm/file_transfer_client_js.go');
  assert.match(src, /fileTransferSlotPoll/);
  assert.match(src, /len\(c\.pending\) < fileTransferMaxInflight/);
  assert.match(src, /time\.Sleep\(fileTransferSlotPoll\)/);
  // Hard busy only after the full request deadline, not immediately.
  assert.match(src, /time\.Now\(\)\.After\(deadline\)/);
  assert.doesNotMatch(
    src,
    /if len\(c\.pending\) >= fileTransferMaxInflight \{\s*\n\s*c\.mu\.Unlock\(\)\s*\n\s*return fileTransferResponse\{\}, &zft2Error\{Code: "busy"/,
  );
});

test('backpressure waits match request timeout instead of hard-failing at 30s', () => {
  const go = read('rdp-wasm/file_transfer_client_js.go');
  const js = read('file-transfer-ws.js');
  assert.match(go, /fileTransferSendWait\s*=\s*60 \* time\.Second/);
  assert.match(go, /Code: "backpressure"/);
  assert.match(js, /SEND_WAIT_TIMEOUT_MS\s*=\s*60000/);
});

test('agent serializes truncate/open with write on the same path', () => {
  const src = read('zephyr_agent/lib/agent/agent_controller.dart');
  assert.match(src, /_zft2PathQueues/);
  assert.match(src, /_handlePaths/);
  assert.match(src, /case Zft2Op\.truncate:/);
  assert.match(src, /case Zft2Op\.open:/);
  assert.match(src, /_handlePaths\[handle\] = openPath/);
  // Old per-handle-only queue must be gone.
  assert.doesNotMatch(src, /_zft2HandleQueues/);
});

test('Android read reuses positioned channel and never skip-from-zero', () => {
  const src = read('zephyr_agent/android_host/MainActivity.kt');
  assert.match(src, /channel\.read\(ByteBuffer\.wrap\(buffer\), offset\)/);
  assert.match(src, /Prefer the persistent FileChannel/);
  // The O(n²) skip fallback must be gone.
  assert.doesNotMatch(src, /stream\.skip\(/);
  assert.doesNotMatch(src, /while \(skipped < offset\)/);
});
