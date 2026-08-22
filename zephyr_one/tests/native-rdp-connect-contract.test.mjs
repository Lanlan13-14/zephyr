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

test('broker denial is logged with enough detail to distinguish ACL from transport', () => {
  const broker = fs.readFileSync(path.join(ROOT, '..', 'zephyr-one-rdp-native-broker.js'), 'utf8');
  assert.match(broker, /authorization denied/);
  assert.match(broker, /code,\s*\n\s*status,/);
});
