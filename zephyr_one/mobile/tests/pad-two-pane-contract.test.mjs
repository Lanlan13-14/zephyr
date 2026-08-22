import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

const WORKSPACE = 'android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalWorkspace.kt';
const SCREEN = 'android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt';
const CHROME = 'android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalChrome.kt';

test('the old split mode is gone from the workspace and the chrome', () => {
  const workspace = read(WORKSPACE);
  const screen = read(SCREEN);
  const chrome = read(CHROME);
  for (const gone of ['TerminalSplitMode', 'nextSplit', 'applySplit', 'paneB', 'focusPane', 'dockWidthFraction', 'SplitGutter']) {
    assert.ok(!workspace.includes(gone), `workspace still references ${gone}`);
    assert.ok(!screen.includes(gone), `screen still references ${gone}`);
  }
  assert.ok(!chrome.includes('onSplit'), 'the header must not offer a split button');
});

test('a pad lays the terminal and the panel side by side with a draggable gutter', () => {
  const workspace = read(WORKSPACE);
  const screen = read(SCREEN);
  assert.match(workspace, /enum class PadTermSide \{ LEFT, RIGHT \}/);
  assert.match(workspace, /PAD_DEFAULT_TERM_FRACTION = 0\.50f/, 'the terminal opens at half width');
  assert.match(workspace, /PAD_MAX_TERM_FRACTION = 1\.00f/, 'the gutter can push the terminal to full width');
  assert.match(workspace, /fun dragPadTermFraction\(/, 'the gutter drag maps dx to the terminal fraction');
  assert.match(screen, /PadGutter\(colors, workspace, onWorkspace\)/, 'the gutter sits between the panes');
  assert.match(screen, /workspace\.padPanelTool != null &&\s*workspace\.padTermFraction < TerminalWorkspace\.PAD_MAX_TERM_FRACTION/,
    'the panel hides when the terminal is dragged to full width');
});

test('pad tools open on the panel side and toggle closed like the phone sheet', () => {
  const workspace = read(WORKSPACE);
  const screen = read(SCREEN);
  assert.match(workspace, /if \(!phone\) \{[\s\S]*?padPanelTool = kind/,
    'a pad tool opens on the opposite side instead of a bottom sheet');
  assert.match(workspace, /if \(state\.padPanelTool == kind\) return state\.copy\(padPanelTool = null\)/,
    'tapping the open tool again closes the panel');
  assert.match(screen, /TerminalWorkspace\.openTool\(ws, kind, phone = !pad\)/,
    'the dock routes pad tools to the panel and phone tools to the sheet');
});

test('the panel side is a user choice persisted in the workspace state', () => {
  const workspace = read(WORKSPACE);
  const screen = read(SCREEN);
  assert.match(workspace, /val padTermSide: PadTermSide = PadTermSide\.RIGHT/,
    'the terminal defaults to the right half so the panel or home surface sits left');
  assert.match(screen, /val terminalFirst = workspace\.padTermSide == PadTermSide\.LEFT/,
    'the layout honours the configured side');
});
