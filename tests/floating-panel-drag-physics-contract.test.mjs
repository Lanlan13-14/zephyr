import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const floating = readFileSync(new URL('../public/floating-panel.js', import.meta.url), 'utf8');
const terminal = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnet = readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const novnc = readFileSync(new URL('../public/novnc.js', import.meta.url), 'utf8');
const rdp = readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const image = readFileSync(new URL('../public/preview/image/image-preview.js', import.meta.url), 'utf8');
const media = readFileSync(new URL('../public/preview/media/media-preview.js', import.meta.url), 'utf8');

test('shared floating-panel exposes AI-parity physics + hard drag', () => {
  assert.match(floating, /export async function ensureFloatingPanelPhysicsDrag/);
  assert.match(floating, /export function startFloatingPanelHardDrag/);
  assert.match(floating, /Motion\.drag\(panel/);
  assert.match(floating, /handle:\s*dragHandle/);
  assert.match(floating, /Only the top gray \.panel-drag-handle owns physical dragging/);
  assert.match(floating, /Three-dot traffic light is separately wired to precise hard drag/);
  assert.match(floating, /activationThreshold:\s*4/);
  assert.match(floating, /rubberband:\s*true/);
  assert.match(floating, /floatingPanelDragBounds/);
  assert.match(floating, /bakePanelTransform/);
  assert.match(floating, /Hold-and-drag on ⋯ = precise hard drag/);
  assert.match(floating, /window\.ZephyrFloatingPanelPhysics/);
});

test('SSH terminal wires physics drag, not titlebar hard drag', () => {
  assert.match(terminal, /ensureFloatingPanelPhysicsDrag/);
  assert.match(terminal, /AI panel parity: gray \.panel-drag-handle/);
  assert.match(terminal, /Title\/content are NOT drag surfaces/);
  assert.doesNotMatch(terminal, /querySelectorAll\('\.panel-titlebar'\)/);
  assert.match(terminal, /consumeLayoutClickSuppression/);
});

test('Telnet terminal mirrors SSH physics wiring', () => {
  assert.match(telnet, /ensureFloatingPanelPhysicsDrag/);
  assert.match(telnet, /AI panel parity: gray \.panel-drag-handle/);
  assert.doesNotMatch(telnet, /querySelectorAll\('\.panel-titlebar'\)/);
});

test('RDP imports physics-capable floating-panel revision', () => {
  assert.match(rdp, /floating-panel\.js\?v=20260731-panel-drag-physics1/);
  assert.match(rdp, /setupPanelInteractions/);
});

test('noVNC uses shared physics drag helpers', () => {
  assert.match(novnc, /ensureFloatingPanelPhysicsDrag/);
  assert.match(novnc, /AI panel parity: gray strip/);
  assert.doesNotMatch(novnc, /novnc-panel \.panel-titlebar/);
});

test('image/media preview use shared physics, not header hard drag', () => {
  assert.match(image, /setupPhysicsDrag/);
  assert.match(image, /ZephyrFloatingPanelPhysics/);
  assert.doesNotMatch(image, /setupTitlebarDrag/);
  assert.doesNotMatch(image, /setupDrag\(modal\)/);
  assert.match(media, /setupPhysicsDrag/);
  assert.match(media, /ZephyrFloatingPanelPhysics/);
  assert.doesNotMatch(media, /startPanelDrag/);
});
