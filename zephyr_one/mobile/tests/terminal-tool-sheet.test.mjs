import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const ws = src('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalWorkspace.kt');
const screen = src('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt');
const sheet = src('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalToolSheet.kt');
const panels = src('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalPanels.kt');

const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

test('phone tools are an in-flow drawer with demo detents', () => {
  assert.match(ws, /SHEET_MID_FRACTION\s*=\s*0\.44f/);
  assert.match(ws, /SHEET_MAX_FRACTION\s*=\s*1\.00f/);
  assert.match(ws, /SHEET_DISMISS_FRACTION\s*=\s*0\.20f/);
  assert.match(ws, /SHEET_DISMISS_VELOCITY_PX_PER_MS\s*=\s*0\.70f/);
  assert.match(screen, /TerminalToolSheet\(/);
  assert.match(sheet, /height\(maxHeight \* animatedFraction\)/);
  assert.match(sheet, /tween\(260, easing = ZephyrMotionTokens\.easeDrawer\)/);
});

test('terminal no longer renders movable floating tool panels', () => {
  const all = codeOnly(ws + '\n' + screen + '\n' + panels);
  assert.doesNotMatch(all, /TerminalFloatingPanel|FloatingToolLayer|TermPanelLayout|floatingOffset/);
});

test('drawer drag uses velocity projection and close threshold', () => {
  assert.match(ws, /current < SHEET_DISMISS_FRACTION/);
  assert.match(ws, /velocityPxPerMs > SHEET_DISMISS_VELOCITY_PX_PER_MS/);
  assert.match(ws, /projected = current - velocityPxPerMs \* SHEET_PROJECTION_SECONDS/);
  assert.match(sheet, /detectDragGestures/);
});

test('IME button closes tool drawer before showing keyboard', () => {
  assert.match(screen, /TerminalWorkspace\.closeSheet\(ws\)[\s\S]*onIntent\(intent\)/);
});

test('FILES drawer with its text editor survives an open IME', () => {
  // The file browser embeds a text editor that needs the system keyboard. When the IME opens
  // inside it the drawer must stay composed (shrunk above the keyboard via imePadding), instead of
  // the whole tool sheet being removed — which made the file page vanish on focus.
  assert.match(
    codeOnly(screen),
    /!imeOpen \|\| ws\.sheetCurrent == TerminalToolKind\.FILES/,
  );
  assert.match(sheet, /SftpBrowserPane\(/);
});
