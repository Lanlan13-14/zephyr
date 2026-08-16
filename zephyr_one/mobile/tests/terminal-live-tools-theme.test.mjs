import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const panels = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalPanels.kt');
const screen = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt');
const sheet = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalToolSheet.kt');
const workspace = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalWorkspace.kt');
const bridge = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TermuxSessionBridge.kt');
const ops = read('feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/HostOpsPanels.kt');
const tools = read('feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolScreens.kt');
const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');

test('terminal tools never render demo files snippets or zero metrics', () => {
  assert.doesNotMatch(panels, /"nginx\.conf"|"access\.log"|Snippet\(id = "demo-|Meter\(colors, "CPU", "—"/);
  assert.match(panels, /listRemoteDirectory\(path\)/);
  assert.match(panels, /HostMonitorPanel\(/);
  assert.match(panels, /HostDockerPanel\(/);
});

test('docker and monitor stay inside the SSH tool drawer', () => {
  assert.match(workspace, /enum class TerminalToolKind[\s\S]*DOCKER/);
  assert.match(sheet, /current == TerminalToolKind\.STATS \|\| current == TerminalToolKind\.DOCKER/);
  assert.match(screen, /TerminalWorkspace\.openTool\(ws, TerminalToolKind\.DOCKER/);
  assert.doesNotMatch(panels, /RootRoute\.Ops/);
  assert.doesNotMatch(sheet, /RootRoute\.Ops/);
  assert.match(ops, /dockerCheckCommand/);
  assert.match(ops, /dockerListContainersCommand/);
  assert.match(ops, /dockerPullCommand/);
  assert.match(ops, /dockerMirrorsSetCommand/);
  assert.match(ops, /statsCommand/);
  assert.match(ops, /processSignalCommand/);
  assert.match(tools, /HostDockerPanel\(/);
  assert.match(tools, /HostMonitorPanel\(/);
  assert.doesNotMatch(tools, /SSH 引擎尚未接入，当前无法读取容器状态/);
  assert.match(root, /LiveSshExecPort\(sshEngine, account.sessions, managedSsh\)/);
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
