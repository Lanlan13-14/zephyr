import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const rdp = readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const vnc = readFileSync(new URL('../public/novnc.js', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../ai-remote-desktop-tools.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../ai-agent-service.js', import.meta.url), 'utf8');

test('dynamic desktop frames do not invalidate an already server-validated action', () => {
  const normalizeStart = app.indexOf('function normalizeAiRemoteDesktopMouseAction');
  const normalizeEnd = app.indexOf('\nfunction delayMs', normalizeStart);
  const normalizeBody = app.slice(normalizeStart, normalizeEnd);
  const rdpActionStart = rdp.indexOf('async function performAiRemoteDesktopAction');
  const rdpActionEnd = rdp.indexOf('\nfunction ', rdpActionStart + 20);
  const rdpActionBody = rdp.slice(rdpActionStart, rdpActionEnd);
  const vncActionStart = vnc.indexOf('async function performAiRemoteDesktopAction');
  const vncActionEnd = vnc.indexOf('\nfunction ', vncActionStart + 20);
  const vncActionBody = vnc.slice(vncActionStart, vncActionEnd);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  assert.doesNotMatch(normalizeBody, /readRemoteDesktopSnapshotForAi/);
  assert.doesNotMatch(normalizeBody, /String\(action\.captureId\).*String\(shot\?\.captureId/);
  assert.match(app, /const beforeFrameAt = Number\(action\.frameAt \|\| 0\)/);
  assert.match(app, /originalWidth: action\.originalWidth/);
  assert.match(app, /originalHeight: action\.originalHeight/);
  assert.doesNotMatch(app, /const beforeShot = readRemoteDesktopSnapshotForAi/);
  assert.doesNotMatch(rdpActionBody, /getRemoteDesktopSnapshotForAi|current\.captureId/);
  assert.doesNotMatch(vncActionBody, /getRemoteDesktopSnapshotForAi|current\.captureId/);
  assert.match(rdpActionBody, /Node tool host already validates captureId/);
  assert.match(vncActionBody, /captureId was already validated by the Node run ledger/);
});

test('server ledger still enforces latest, expiring, one-time capture ids', () => {
  assert.match(tools, /CAPTURE_LEDGER_TTL_MS = 2 \* 60 \* 1000/);
  assert.match(tools, /function consumeRememberedCapture/);
  assert.match(tools, /item\.captureId !== String\(captureId \|\| ''\)/);
  assert.match(tools, /item\.consumedAt/);
  assert.match(agent, /consumeRememberedCapture\(\{/);
  assert.match(agent, /stale_capture_retry_exhausted/);
  assert.match(agent, /retryCount > 1/);
  assert.match(tools, /function noteStaleAction/);
});
