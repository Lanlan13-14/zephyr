import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let aiAgent;
let capabilities;
let PLAYBOOKS;
try {
    aiAgent = require('../ai-agent-service.js');
    capabilities = require('../ai-capabilities.js');
    PLAYBOOKS = require('../ai-playbooks.js').PLAYBOOKS;
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const vnc = fs.readFileSync(path.join(root, 'public/novnc.js'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'zephyr-ai/internal/agent/loop.go'), 'utf8');

const names = [
  'remote_desktop_capture_v1',
  'remote_desktop_action_v1',
  'remote_desktop_verify_v1',
  'remote_desktop_cert_status_v1',
  'remote_desktop_cert_decide_v1',
];

test('remote desktop canonical catalog exposes capture action verify chain', (t) => {
  if (!aiAgent) {
    t.skip('ai-agent-service dependencies are not installed in this worktree');
    return;
  }
  const catalog = aiAgent.listToolCatalog({});
  for (const name of names) assert.ok(catalog.some((item) => item.name === name));
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_capture_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_action_v1').risk, 'R2');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_verify_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_cert_status_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_cert_decide_v1').risk, 'R2');
  assert.equal(catalog.some((item) => item.name === 'remote_desktop_screenshot'), false);
});

test('frontend binds actions and results to capture ids on the Web RDP path', () => {
  assert.match(app, /captureId:\s*action\.captureId/);
  assert.match(app, /beforeCaptureId/);
  assert.match(app, /afterCaptureId/);
  assert.match(app, /captureChanged/);
  assert.match(app, /runtimeLastEventId/);
  assert.match(vnc, /vncLastFrameAt \|\| Date\.now\(\)/);
  assert.match(vnc, /captureId was already validated by the Node run ledger/);
  assert.match(vnc, /captureId/);
  assert.match(app, /\/rdp\.html\?/);
});

test('Go runtime detects wrapped canonical client captures', () => {
  assert.match(loop, /if data, ok := m\["data"\]\.\(map\[string\]any\)/);
  assert.match(app, /\/capture`/);
  assert.match(app, /captureResult/);
});

test('remote desktop capability and playbook require verification', (t) => {
  if (!capabilities || !PLAYBOOKS) {
    t.skip('ai-capabilities dependencies are not installed in this worktree');
    return;
  }
  for (const id of ['remotedesktop.capture', 'remotedesktop.action', 'remotedesktop.verify', 'remotedesktop.cert_status', 'remotedesktop.cert_decide']) {
    assert.ok(capabilities.CAPABILITIES.some((item) => item.id === id && item.state === 'implemented'));
  }
  const playbook = PLAYBOOKS.find((item) => item.id === 'remote-desktop-closed-loop-v1');
  assert.ok(playbook);
  assert.match(playbook.prompt, /stale_capture/);
  assert.match(playbook.prompt, /只允许重新截图并重试同一动作一次/);
  assert.match(playbook.prompt, /禁止继续循环/);
  assert.match(playbook.prompt, /remote_desktop_verify_v1/);
  assert.match(playbook.prompt, /只有 verified=true/);
  assert.match(playbook.prompt, /remote_desktop_cert_status_v1/);
});
