import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

const overlays = read('android/core-ui/src/main/kotlin/one/zephyr/mobile/ui/component/Overlays.kt');
const tools = read('android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolsRootScreen.kt');
const root = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const alertStart = overlays.indexOf('fun AlertDialog(');
const alert = overlays.slice(alertStart);

test('alert dialog is bounded by the actual available window', () => {
  assert.match(alert, /decorFitsSystemWindows = false/);
  assert.match(alert, /BoxWithConstraints/);
  assert.match(alert, /\.imePadding\(\)/);
  assert.match(alert, /val availableHeight = min\(maxHeight\.value - 20f, 640f\)/);
  assert.match(alert, /\.heightIn\(max = availableHeight\)/);
  assert.match(alert, /\.navigationBarsPadding\(\)/);
});

test('alert text scrolls while confirm and cancel actions stay fixed', () => {
  const scrollIndex = alert.indexOf('.verticalScroll(rememberScrollState())');
  const confirmIndex = alert.indexOf('ProvideContentColor(palette.status.error, confirmButton)');
  const dismissIndex = alert.indexOf('ProvideContentColor(palette.onBackground, dismissButton)');
  assert.ok(scrollIndex > 0);
  assert.ok(confirmIndex > scrollIndex);
  assert.ok(dismissIndex > confirmIndex);
  assert.match(alert, /\.weight\(1f, fill = false\)[\s\S]*\.verticalScroll/);
  assert.doesNotMatch(alert, /\.heightIn\(max = 640\.dp\)[\s\S]{0,80}\.verticalScroll/);
});

test('tools root has no redundant add button or callback', () => {
  assert.match(tools, /RootPageHeader\(title = stringResource\(R\.string\.tools_root_title\)\)/);
  assert.doesNotMatch(tools, /HeaderAddButton/);
  assert.doesNotMatch(tools, /onAddTool/);
  assert.doesNotMatch(root, /onAddTool =/);
  assert.doesNotMatch(read('android/feature-tools/src/main/res/values/strings.xml'), /tools_root_add/);
  assert.doesNotMatch(read('android/feature-tools/src/main/res/values-en/strings.xml'), /tools_root_add/);
});
