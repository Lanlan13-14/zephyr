import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const screen = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt');
const chrome = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalChrome.kt');
const routes = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SessionRoutes.kt');
const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');

test('terminal renders both key row and icon-label context dock', () => {
  assert.match(screen, /DemoKeyRow\(/);
  assert.match(screen, /DemoContextDock\(/);
  assert.match(chrome, /Icon\(demoDockIcon\(item\)/);
  assert.match(chrome, /Text\(demoDockLabel\(item\)/);
});

test('actual IME keeps shortcut row and removes only context dock', () => {
  assert.match(screen, /val imeOpen = imeHeightPx > 8f/);
  assert.match(screen, /DemoKeyRow\([\s\S]*if \(!imeOpen\) \{[\s\S]*DemoContextDock/);
  assert.match(screen, /\.imePadding\(\)/);
  assert.doesNotMatch(screen, /keyboardVisible \|\| imeHeightPx/);
});

test('session plus opens new connection protocol picker', () => {
  assert.match(screen, /onAdd = onCreateConnection/);
  assert.match(routes, /onCreateConnection/);
  assert.match(root, /onCreateConnection = \{ route = RootRoute\.ProtocolPicker \}/);
});

test('context dock is removed rather than transparent blank occupancy', () => {
  assert.doesNotMatch(chrome, /dockHide|alpha = 1f - hidden|translationY = 90f/);
});
