import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const panels = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalPanels.kt');
const screen = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt');
const bridge = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TermuxSessionBridge.kt');

test('terminal tools never render demo files snippets or zero metrics', () => {
  assert.doesNotMatch(panels, /"nginx\.conf"|"access\.log"|Snippet\(id = "demo-|Meter\(colors, "CPU", "—"/);
  assert.match(panels, /listRemoteDirectory\(path\)/);
  assert.match(panels, /remoteMetrics\(\)/);
});

test('terminal background opacity and blur affect rendering', () => {
  assert.match(screen, /\.blur\(workspace\.backgroundBlurPx\.dp\)/);
  assert.match(screen, /alpha = workspace\.backgroundOpacity/);
  assert.doesNotMatch(screen, /private fun Brush\.copy\(alpha: Float\): Brush = this/);
});

test('light terminal installs a readable 16-color ANSI palette', () => {
  assert.match(bridge, /readableAnsiPalette/);
  assert.match(bridge, /scheme\.ansiArgb\.forEachIndexed/);
  assert.match(bridge, /color\$index/);
});
