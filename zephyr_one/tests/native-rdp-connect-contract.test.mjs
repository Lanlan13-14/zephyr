import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('embedded panel maps every snapshot phase to a distinct visible state', () => {
  const embedded = read('src/rdp/native-rdp-embedded.js');
  /* A failed/negotiating session must not silently collapse into the closed
   * placeholder, and a detached surface must not read as "session ended". */
  assert.match(embedded, /phase === 'connected'/);
  assert.match(embedded, /phase === 'connecting'/);
  assert.match(embedded, /phase === 'closed'/);
  assert.match(embedded, /phase === 'disconnected'/);
  assert.match(embedded, /surface-detached|surface is unavailable/i);
});

test('the native open intent carries the presentation style, not pixels', () => {
  const embedded = read('src/rdp/native-rdp-embedded.js');
  /* Corner fill must match the workspace card: without the radius/backdrop
   * snapshot the first frame leaves a foreign rectangle inside a rounded
   * window, and a resize during negotiation leaves it stale. */
  const openCall = embedded.slice(
    embedded.indexOf("shellRequest('open', {"),
    embedded.indexOf('}, 120000)'),
  );
  for (const field of ['sessionId', 'connectionId', 'width', 'height', 'dpi', 'cornerRadius', 'backdropColor', 'title']) {
    assert.match(openCall, new RegExp(`${field}:`), field);
  }
  assert.match(embedded, /getComputedStyle\(view\.panel\)/);
  assert.match(embedded, /borderTopLeftRadius/);
});

test('CAD input is capture-independent on both dispatch layers', () => {
  const client = read('src/rdp/native-rdp-client.js');
  const rust = read('src-tauri/src/commands/rdp_surface.rs');

  /* The shell must not demand a stale capture ticket for the one key chord
   * whose meaning is "unlock this session", and the broker must not route
   * it through the AI capture ledger either. */
  const clientInput = client.slice(client.indexOf('async function input'), client.indexOf('async function open'));
  assert.match(clientInput, /control === 'ctrl_alt_del'/);
  const ctrlAltDelBlock = clientInput.slice(
    clientInput.indexOf("control === 'ctrl_alt_del'"),
    clientInput.indexOf("const captureId ="),
  );
  assert.doesNotMatch(ctrlAltDelBlock, /lastCaptures\.get|stale_capture/);

  const rustInput = rust.slice(rust.indexOf('"input" =>'), rust.indexOf('"close" =>'));
  assert.match(rustInput, /payload\.control == "ctrl_alt_del"/);
  assert.match(rustInput, /handle\.send_ctrl_alt_del\(\)/);
  const beforeTicket = rustInput.slice(0, rustInput.indexOf('let ticket ='));
  assert.match(beforeTicket, /handle\.send_ctrl_alt_del\(\)/);
});

test('Ctrl+Alt+Del is sent as the secure-attention scancode chord', () => {
  const session = read('src-tauri/src/rdp/session.rs');
  assert.match(session, /pub fn send_ctrl_alt_del/);
  const body = session.slice(session.indexOf('pub fn send_ctrl_alt_del'), session.indexOf('pub fn send_sync'));
  for (const scancode of ['0x1D', '0x38', '0x53']) {
    assert.match(body, new RegExp(scancode), scancode);
  }
  assert.match(body, /KBDEXT/);
  assert.match(body, /RELEASE/);
});

test('a dead session handle does not block the retry', () => {
  const surface = read('src-tauri/src/commands/rdp_surface.rs');
  const broker = read('src-tauri/src/rdp/broker.rs');
  const session = read('src-tauri/src/rdp/session.rs');

  /* The retry must see liveness, not just presence: presence alone is what
   * produced rdp_session_exists for a session that had already died. */
  const startSession = surface.slice(surface.indexOf('pub fn start_session'), surface.indexOf('pub fn disconnect_session'));
  assert.match(startSession, /is_some_and\(\|handle\| handle\.is_live\(\)\)/);
  assert.doesNotMatch(startSession, /self\.sessions\.get\(session_id\)\.is_some\(\)[\s,]/);

  /* The broker must let the same owner re-claim a reservation whose open
   * failed, while still refusing a different owner; and the close path must
   * still be able to tear it down. */
  const authorize = broker.slice(broker.indexOf('pub(crate) fn authorize_and_open'), broker.indexOf('pub fn with_active'));
  assert.match(authorize, /Err\(error\) => \{\s*\/\*[\s\S]*?return Err\(error\)/);
  const claim = broker.slice(broker.indexOf('pub fn claim_surface'), broker.indexOf('pub fn release_reserved'));
  assert.match(claim, /SurfaceReserved[\s\S]*owner_label == owner_label/);

  /* The registry must not let a retry silently replace a live handle, and must
   * not let a dead one block it either. */
  const start = session.slice(session.indexOf('pub fn start('), session.indexOf('pub fn get('));
  assert.match(start, /retire_dead/);
  assert.match(start, /Error::SessionExists/);
});

test('the GFX channel is wired into the GDI pipeline through the common fallback', () => {
  const shim = read('native/freerdp-core/zephyr_rdp.c');

  /* The regression this locks: the shim claimed cliprdr and disp and dropped
   * every other channel on the floor. With RDPGFX negotiated (the default
   * gfx=true policy), that meant the server sent frames as GFX PDUs that
   * nothing decoded into the GDI primary buffer — connect succeeded and the
   * host then timed out waiting for a first frame that could never exist.
   * Every shipped FreeRDP client ends its handler with the common fallback,
   * which is where gdi_graphics_pipeline_init lives. */
  const connected = shim.slice(
    shim.indexOf('static void on_channel_connected'),
    shim.indexOf('static void on_channel_disconnected'),
  );
  assert.match(connected, /freerdp_client_OnChannelConnectedEventHandler\(context, e\)/);

  const disconnected = shim.slice(
    shim.indexOf('static void on_channel_disconnected'),
    shim.indexOf('/* ── instance callbacks'),
  );
  assert.match(disconnected, /freerdp_client_OnChannelDisconnectedEventHandler\(context, e\)/);
});

test('broker denial is logged with enough detail to distinguish ACL from transport', () => {
  const broker = fs.readFileSync(path.join(ROOT, '..', 'zephyr-one-rdp-native-broker.js'), 'utf8');
  assert.match(broker, /authorization denied/);
  assert.match(broker, /code,\s*\n\s*status,/);
});
