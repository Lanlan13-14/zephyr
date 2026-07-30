import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const agent = readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');
const bridge = readFileSync(path.join(root, 'ai-runtime-bridge.js'), 'utf8');
const routingSource = readFileSync(path.join(root, 'ai-intent-routing.js'), 'utf8');
const routing = require('../ai-intent-routing');

test('client context exposes the active RDP/VNC surface without changing renderers', () => {
  assert.match(app, /activeSurface = activeRemoteDesktop/);
  assert.match(app, /kind: 'remote-desktop'/);
  assert.doesNotMatch(app, /html2canvas/);
});

test('RDP/VNC intent is deterministically routed through cert status then capture action verify', () => {
  const tools = routing.preferredToolsForUserMessage('在当前 RDP 远程桌面打开 Edge').map((item) => item.name);
  assert.deepEqual(tools, ['remote_desktop_cert_status_v1', 'remote_desktop_capture_v1', 'remote_desktop_action_v1', 'remote_desktop_verify_v1']);
  const certTools = routing.preferredToolsForUserMessage('当前 RDP 证书未验证，请信任证书').map((item) => item.name);
  assert.deepEqual(certTools, ['remote_desktop_cert_status_v1', 'remote_desktop_cert_decide_v1', 'remote_desktop_capture_v1']);
  assert.match(routing.buildIntentRoutingHint('在当前 RDP 里点击开始'), /禁止调用 browser_\*/);
});

test('browser tools are removed and rejected while remote desktop owns the surface', () => {
  assert.match(bridge, /activeSurface\?\.kind === 'remote-desktop'[\s\S]*?filter\(\(tool\) => !String\(tool\?\.name \|\| ''\)\.startsWith\('browser_'\)\)/);
  assert.match(agent, /runtime_required_for_remote_desktop/);
  assert.match(agent, /Legacy Chat 不会接收远程桌面截图/);
  assert.match(agent, /activeSurface\?\.kind === 'remote-desktop'[\s\S]*?startsWith\('browser_'\)/);
  assert.match(agent, /err\.code = 'wrong_surface'/);
  assert.match(routingSource, /remote_desktop_capture_v1/);
});
