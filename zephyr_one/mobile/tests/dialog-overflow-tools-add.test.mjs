import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

const overlays = read('android/core-ui/src/main/kotlin/one/zephyr/mobile/ui/component/Overlays.kt');
const layout = read('android/core-ui/src/main/kotlin/one/zephyr/mobile/ui/component/AlertDialogLayout.kt');
const tools = read('android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolsRootScreen.kt');
const root = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const terminal = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalScreen.kt');
const remote = read('android/feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteScreen.kt');
const alertStart = overlays.indexOf('fun AlertDialog(');
const alert = overlays.slice(alertStart);

test('alert dialog is bounded by the actual available window', () => {
  assert.match(alert, /decorFitsSystemWindows = false/);
  assert.match(alert, /BoxWithConstraints/);
  assert.match(alert, /\.imePadding\(\)/);
  assert.match(alert, /AlertDialogLayout\.availableHeightDp\(windowHeightDp\)/);
  assert.match(alert, /\.heightIn\(max = availableHeight\)/);
  assert.match(alert, /\.navigationBarsPadding\(\)/);
  assert.match(alert, /window\.setLayout\(screenW, screenH\)/);
  assert.match(alert, /\.fillMaxSize\(\)/);
  assert.match(alert, /DialogWindowProvider/);
  assert.match(alert, /OnPreDrawListener/);
  assert.match(alert, /OnGlobalLayoutListener/);
  assert.match(alert, /\.requiredWidth\(AlertDialogLayout\.forcedWindowWidthDp\(screenWidthDp\)\.dp\)/);
  assert.match(alert, /\.requiredHeight\(AlertDialogLayout\.forcedWindowHeightDp\(screenHeightDp\)\.dp\)/);
  assert.match(alert, /AlertDialogLayout\.dialogWindowHeightDp\(screenHeightDp, maxHeight\.value\)/);
  assert.match(alert, /\.navigationBarsPadding\(\)[\s\S]*\.padding\(start = 10\.dp, end = 10\.dp, bottom = 10\.dp\)/);
  assert.match(layout, /fun availableHeightDp\(windowHeightDp: Float\)/);
  assert.match(layout, /fun dialogWindowHeightDp/);
  assert.match(layout, /fun cancelGroupOnScreen/);
  assert.doesNotMatch(alert, /val availableHeight = min\(maxHeight\.value - 20f, 640f\)/);
});

test('host-key and certificate sheets stay opaque and wrap the fingerprint', () => {
  assert.match(alert, /Color\(AlertDialogLayout\.sheetArgb\(palette\.dark\)\)/);
  assert.match(layout, /DARK_SHEET_ARGB: Int = 0xFF1A1E25\.toInt\(\)/);
  assert.match(layout, /fun wrapFingerprint/);
  assert.match(terminal, /AlertDialogLayout\.wrapFingerprint\(prompt\.fingerprint\)/);
  assert.match(remote, /AlertDialogLayout\.wrapFingerprint\(review\.sha256Fingerprint\)/);
  assert.match(remote, /AlertDialogLayout\.wrapFingerprint\(previous\)/);
  assert.match(root, /AlertDialogLayout\.wrapFingerprint\(prompt\.fingerprint\)/);
  assert.doesNotMatch(alert, /\.background\(palette\.surfaces\.floating\)/);
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

function readKotlinFloat(source, name) {
  const match = source.match(new RegExp(`const val ${name} = ([0-9.]+)f`));
  assert.ok(match, name + ' missing');
  return Number(match[1]);
}

function availableHeightDp(windowHeightDp) {
  const max = readKotlinFloat(layout, 'MAX_SHEET_DP');
  const gutter = readKotlinFloat(layout, 'EDGE_GUTTER_DP');
  return Math.max(Math.min(windowHeightDp - gutter * 2, max), 120);
}

function wrapFingerprint(raw) {
  const group = Number(layout.match(/const val FINGERPRINT_GROUP = (\d+)/)[1]);
  const perLine = Number(layout.match(/const val FINGERPRINT_GROUPS_PER_LINE = (\d+)/)[1]);
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return raw;
  const colon = compact.indexOf(':');
  const head = colon > 0 && colon <= 8 ? compact.slice(0, colon) : '';
  const prefixEnd = head && /[^0-9A-Fa-f]/.test(head) ? colon + 1 : 0;
  const prefix = compact.slice(0, prefixEnd);
  const payload = compact.slice(prefixEnd).replace(/:/g, '');
  if (!payload) return compact;
  const groups = payload.match(new RegExp(`.{1,${group}}`, 'g')) ?? [];
  const lines = [];
  for (let i = 0; i < groups.length; i += perLine) {
    lines.push(groups.slice(i, i + perLine).join(' '));
  }
  return prefix ? prefix + lines[0] + lines.slice(1).map((line) => '\n' + line).join('') : lines.join('\n');
}

test('window-height math keeps the cancel group on a phone', () => {
  const body = 180;
  const stacked = body + 8 + 50 + 10;
  assert.equal(availableHeightDp(780), 640);
  assert.ok(stacked < availableHeightDp(780));
  const wrapContentDialog = 220;
  assert.ok(stacked > wrapContentDialog, 'old WRAP_CONTENT Dialog would clip cancel');
  assert.equal(Math.max(780, 220), 780);
  const nav = 48;
  assert.ok(stacked + 10 + nav < 780);
  assert.ok(!(stacked + 10 + nav < wrapContentDialog));
});

test('python replica of AlertDialogLayout stays in lockstep', async () => {
  const replica = read('tests/alert-dialog-layout-replica.py');
  assert.match(replica, /FINGERPRINT_GROUPS_PER_LINE = 6/);
  assert.match(replica, /def wrap_fingerprint/);
  assert.match(replica, /def available_height_dp/);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('python3', [path.join(mobile, 'tests/alert-dialog-layout-replica.py')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /alert-dialog-layout-replica ok/);
});

test('screenshot SSH fingerprint wraps instead of overflowing', () => {
  const raw = 'SHA256:QytVAAei+gY5ISAlZF3D6WfcZGOaTGY+ygTPRiDSbl0';
  const wrapped = wrapFingerprint(raw);
  assert.equal(wrapped, 'SHA256:QytV AAei +gY5 ISAl ZF3D 6Wfc\nZGOa TGY+ ygTP RiDS bl0');
  const longest = Math.max(...wrapped.split('\n').map((line) => line.length));
  assert.ok(longest <= 48, 'longest line ' + longest);
  const tls = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const tlsWrapped = wrapFingerprint(tls);
  assert.match(tlsWrapped, /^0001 0203/);
  assert.equal(tls.replace(/:/g, ''), tlsWrapped.replace(/[\s:]/g, ''));
  const hexHead = 'A1:B2:C3:D4:E5:F6:01:23';
  assert.match(wrapFingerprint(hexHead), /^A1B2/);
  assert.match(layout, /FINGERPRINT_GROUPS_PER_LINE = 6/);
});
