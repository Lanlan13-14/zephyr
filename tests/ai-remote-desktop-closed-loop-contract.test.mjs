import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import aiAgent from '../ai-agent-service.js';
import capabilities from '../ai-capabilities.js';
import { PLAYBOOKS } from '../ai-playbooks.js';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const vnc = fs.readFileSync(path.join(root, 'public/novnc.js'), 'utf8');
const nativeClient = fs.readFileSync(path.join(root, 'zephyr_one/src/rdp/native-rdp-client.js'), 'utf8');
const nativeEmbedded = fs.readFileSync(path.join(root, 'zephyr_one/src/rdp/native-rdp-embedded.js'), 'utf8');
const nativeCommands = fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/src/commands/rdp_surface.rs'), 'utf8');
const nativeSurface = fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/src/rdp_surface/windows.rs'), 'utf8');
const nativeLib = fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/src/lib.rs'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'zephyr-ai/internal/agent/loop.go'), 'utf8');

const names = [
  'remote_desktop_capture_v1',
  'remote_desktop_action_v1',
  'remote_desktop_verify_v1',
  'remote_desktop_cert_status_v1',
  'remote_desktop_cert_decide_v1',
];

test('remote desktop canonical catalog exposes capture action verify chain', () => {
  const catalog = aiAgent.listToolCatalog({});
  for (const name of names) assert.ok(catalog.some((item) => item.name === name));
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_capture_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_action_v1').risk, 'R2');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_verify_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_cert_status_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'remote_desktop_cert_decide_v1').risk, 'R2');
  assert.equal(catalog.some((item) => item.name === 'remote_desktop_screenshot'), false);
});

test('frontend binds actions and results to native FreeRDP capture ids', () => {
  assert.match(app, /captureId:\s*action\.captureId/);
  assert.match(app, /beforeCaptureId/);
  assert.match(app, /afterCaptureId/);
  assert.match(app, /captureChanged/);
  assert.match(app, /runtimeLastEventId/);
  assert.match(vnc, /vncLastFrameAt \|\| Date\.now\(\)/);
  assert.match(vnc, /captureId was already validated by the Node run ledger/);
  assert.match(vnc, /captureId/);
  assert.match(app, /nativeRemoteDesktopBridge\(frame\)/);
  assert.match(app, /nativeBridge\.snapshot\(\{ maxWidth \}\)/);
  assert.match(app, /nativeBridge\.action\(msg\)/);
  assert.match(nativeEmbedded, /__zephyrNativeRdpBridge/);
  assert.match(nativeEmbedded, /shellRequest\('capture'/);
  assert.match(nativeEmbedded, /shellRequest\('input'/);
  assert.match(nativeClient, /invoke\('rdp_native_surface_capture'/);
  assert.match(nativeClient, /lastCaptures\.get\(sessionId\)/);
  assert.match(nativeClient, /lastCaptures\.delete\(sessionId\)/);
  assert.match(nativeClient, /invoke\('rdp_native_send_mouse'/);
  assert.match(nativeClient, /invoke\('rdp_native_send_text'/);
});

test('native capture is owner-bound, encoded from the Rust surface, and has no WASM fallback', () => {
  assert.match(nativeCommands, /pub fn rdp_native_surface_capture\b/);
  assert.match(nativeCommands, /broker\.assert_active_owner\(window\.label\(\), &session_id\)/);
  assert.match(nativeCommands, /state\.capture_surface\(&session_id,[\s\S]*?max_width/);
  assert.match(nativeCommands, /data:image\/png;base64/);
  assert.match(nativeSurface, /pub fn capture_frame\(&self, max_width: u32\)/);
  assert.match(nativeSurface, /let mut pixels = zeroed_bgra\(size\)/);
  assert.match(nativeSurface, /original_size/);
  assert.match(nativeSurface, /self\.revision = self\.revision\.saturating_add\(1\)/);
  assert.match(nativeLib, /commands::rdp_surface::rdp_native_surface_capture/);
  assert.doesNotMatch(nativeClient, /rdp-wasm|WebAssembly|readPixels|public\/rdp-worker/i);
  assert.doesNotMatch(nativeEmbedded, /rdp-wasm|WebAssembly|readPixels|WebSocket|rdp-proxy/i);
});

test('Go runtime detects wrapped canonical client captures', () => {
  assert.match(loop, /if data, ok := m\["data"\]\.\(map\[string\]any\)/);
  assert.match(app, /\/capture`/);
  assert.match(app, /captureResult/);
});

test('remote desktop capability and playbook require verification', () => {
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
