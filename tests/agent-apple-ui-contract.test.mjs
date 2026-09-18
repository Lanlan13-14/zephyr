import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('the Agent home screen is a grouped settings list, not Material cards', () => {
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(home, /SettingsPalette/);
  assert.match(home, /SettingsGroup/);
  assert.match(home, /SettingsToggleRow/);
  assert.match(home, /GlassPrimaryButton/);
  assert.doesNotMatch(home, /Switch\(/);
  assert.doesNotMatch(home, /ChoiceChip\(/);
  assert.doesNotMatch(home, /ElevatedButton/);
  assert.doesNotMatch(home, /FilledButton/);
  assert.doesNotMatch(home, /return Card\(/);
});

test('the bastion row has no ambiguous subtitle', () => {
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(home, /作为跳板机/);
  assert.doesNotMatch(home, /供主端和 One 经此 Agent 中转 SSH/);
});

test('every toggle is the liquid-glass switch, not MD3 Switch', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  assert.match(toggle, /class LiquidToggle/);
  assert.match(toggle, /SpringSimulation/);
  assert.match(toggle, /BackdropFilter/);
  assert.match(toggle, /chromatic|0xFF5AC8FA/);
  assert.match(toggle, /disableAnimations/);
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.match(group, /LiquidToggle\(/);
  assert.doesNotMatch(group, /Switch\(/);
});

test('liquid toggle is 64 by 28 with a 40 by 24 thumb and 20pt travel', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  assert.match(toggle, /static const double trackWidth = 64/);
  assert.match(toggle, /static const double trackHeight = 28/);
  assert.match(toggle, /static const double thumbWidth = 40/);
  assert.match(toggle, /static const double thumbHeight = 24/);
  assert.match(toggle, /static const double travel = trackWidth - thumbWidth - inset \* 2/);
  assert.match(toggle, /onPanUpdate|PointerMoveEvent|_onPointerMove/);
  assert.match(toggle, /SpringSimulation/);
});

test('primary actions are glass capsules, not Material elevated buttons', () => {
  const button = read('zephyr_agent/lib/ui/glass_button.dart');
  assert.match(button, /BackdropFilter/);
  assert.match(button, /BorderRadius\.circular\(14\)/);
  assert.match(button, /HapticFeedback\.lightImpact/);
});
