import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const commands = read('zephyr_one/src-tauri/src/commands/mod.rs');
const surfaces = read('zephyr_one/src-tauri/src/commands/rdp_surface.rs');
const lib = read('zephyr_one/src-tauri/src/lib.rs');

test('registers the complete native RDP surface lifecycle command set', () => {
  for (const command of ['create', 'show', 'close', 'resize', 'focus', 'status', 'capture']) {
    const name = `rdp_native_surface_${command}`;
    assert.match(surfaces, new RegExp(`pub fn ${name}\\b`));
    assert.match(lib, new RegExp(`commands::rdp_surface::${name}\\b`));
  }

  assert.match(lib, /manage\(rdp_surface_state\)/);
  assert.match(surfaces, /create_windows_surface\(/);
  assert.match(surfaces, /NativeRdpSurfaceRegistry/);
});

test('connect requires an attached native sink and never substitutes RecordingSink', () => {
  const start = commands.indexOf('pub fn rdp_native_connect');
  const end = commands.indexOf('pub fn rdp_native_disconnect', start);
  const connect = commands.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(connect, /surfaces\.start_session\(&session_id, config\)/);
  assert.doesNotMatch(connect, /RecordingSink|rdp-wasm|wasm_bindgen/i);
  assert.match(surfaces, /SURFACE_MISSING[\s\S]*create a native surface before connecting/);
  assert.match(surfaces, /registry\.frame_sink\(session_id\.to_owned\(\)\)/);
});

test('status exposes metadata only while capture is explicit and owner-bound', () => {
  const statusStart = surfaces.indexOf('pub struct RdpSurfaceStatus');
  const statusEnd = surfaces.indexOf('\n}', statusStart);
  const status = surfaces.slice(statusStart, statusEnd);

  assert.notEqual(statusStart, -1);
  assert.doesNotMatch(status, /pixels|frame|bytes|data|window_handle/i);
  assert.match(surfaces, /serde\(rename_all = "camelCase"\)/);
  assert.match(surfaces, /rdp_surface_platform_unsupported/);
  assert.match(surfaces, /cfg\(not\(target_os = "windows"\)\)/);
  assert.match(surfaces, /pub struct RdpSurfaceCapture/);
  assert.match(surfaces, /pub fn rdp_native_surface_capture[\s\S]*broker\.assert_active_owner/);
  assert.match(surfaces, /data:image\/png;base64/);
});

test('clipboard event telemetry never formats or serializes clipboard contents', () => {
  const eventStart = surfaces.indexOf('fn event(&self, event: SessionEvent)');
  const eventEnd = surfaces.indexOf('\n    }\n}', eventStart);
  const eventHandler = surfaces.slice(eventStart, eventEnd);

  assert.notEqual(eventStart, -1);
  assert.match(eventHandler, /SessionEvent::Clipboard\(_\) => "Clipboard"\.to_owned\(\)/);
  assert.match(eventHandler, /SessionEvent::Clipboard\(text\)[\s\S]*apply_remote_clipboard\(text\)/);
  assert.doesNotMatch(eventHandler, /format!\("\{event:\?\}"\)[\s\S]*SessionEvent::Clipboard/);
  assert.match(surfaces, /clipboard-secret-must-not-cross-ipc/);
});

test('surface lifecycle binds input after start and unbinds before every session close', () => {
  const startBegin = surfaces.indexOf('pub fn start_session');
  const disconnectBegin = surfaces.indexOf('pub fn disconnect_session');
  const startSession = surfaces.slice(startBegin, disconnectBegin);
  const disconnectEnd = surfaces.indexOf('pub fn telemetry', disconnectBegin);
  const disconnect = surfaces.slice(disconnectBegin, disconnectEnd);
  const closeBegin = surfaces.indexOf('fn close_surface');
  const closeEnd = surfaces.indexOf('fn surface_status', closeBegin);
  const closeSurface = surfaces.slice(closeBegin, closeEnd);

  assert.ok(startSession.indexOf('.start(session_id, config, sink)') < startSession.indexOf('.bind_session(handle)'));
  assert.match(disconnect, /if let Some\(entry\) = &entry[\s\S]*\.unbind_session\(\)[\s\S]*let session_closed = self\.sessions\.close\(session_id\)/);
  assert.ok(closeSurface.indexOf('.unbind_session()') < closeSurface.indexOf('.close(&session_id)'));
  assert.match(surfaces, /impl Drop for SurfaceEntry[\s\S]*unbind_session\(\)/);
});
