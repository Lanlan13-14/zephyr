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
  const strings = read('zephyr_agent/lib/i18n/agent_strings.dart');
  assert.match(strings, /作为跳板机/);
  assert.doesNotMatch(home, /供主端和 One 经此 Agent 中转 SSH/);
  assert.doesNotMatch(strings, /供主端和 One 经此 Agent 中转 SSH/);
});

test('every toggle is the liquid_glass_easy switch, not MD3 Switch', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  assert.match(toggle, /class LiquidToggle/);
  assert.match(toggle, /package:liquid_glass_easy\/liquid_glass_easy\.dart/);
  assert.match(toggle, /LiquidGlassSwitch\(/);
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.match(group, /LiquidToggle\(/);
  assert.doesNotMatch(group, /Switch\(/);
});

test('the toggle track is the single theme accent, never a fixed green', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  // No color parameter on the constructor — per-row colors are impossible.
  assert.doesNotMatch(toggle, /final Color activeColor/);
  assert.doesNotMatch(toggle, /required this\.activeColor/);
  // On-state track resolves from SettingsPalette accent.
  assert.match(toggle, /SettingsPalette\.maybeOf\(context\)\?\.accent/);
  // Off-state is the translucent system gray.
  assert.match(toggle, /0x33787878/);
  assert.match(toggle, /0x5C787880/);
  // Fixed green must not appear — on-track is the theme accent.
  assert.doesNotMatch(toggle, /0xFF34C759/);
  assert.doesNotMatch(toggle, /0xFF30D158/);
  // No specular track gradient or glow.
  assert.doesNotMatch(toggle, /specularTop/);
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.doesNotMatch(group, /activeColor: iconColor/);
});

test('primary actions are glass capsules, not Material elevated buttons', () => {
  const button = read('zephyr_agent/lib/ui/glass_button.dart');
  assert.match(button, /LiquidGlass\(/);
  assert.match(button, /BorderRadius\.circular\(14\)/);
  assert.match(button, /HapticFeedback\.lightImpact/);
});

test('secondary surfaces are glass sheets — no MD3 dialogs or popup menus', () => {
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  const sheet = read('zephyr_agent/lib/ui/glass_sheet.dart');
  assert.match(sheet, /showGlassSheet/);
  assert.match(sheet, /required ZephyrPalette palette/);
  assert.match(sheet, /showGeneralDialog/);
  assert.match(sheet, /LiquidGlass/);
  // 1.0.32: looking up SettingsPalette on the caller context (HomeScreen
  // State sits *above* the InheritedWidget) asserted and the tap vanished.
  assert.doesNotMatch(sheet, /final palette = SettingsPalette\.of\(context\);\s*return show/);
  assert.match(home, /palette: _palette/);
  // All modal flows go through the glass sheet helper; raw Material sheets,
  // popup menus, and dialogs are banned outside glass_sheet.dart itself.
  assert.doesNotMatch(home, /showModalBottomSheet</);
  assert.doesNotMatch(home, /PopupMenuButton</);
  assert.doesNotMatch(home, /showDialog</);
  assert.doesNotMatch(home, /AlertDialog/);
  for (const rel of [
    'zephyr_agent/lib/ui/settings_group.dart',
    'zephyr_agent/lib/ui/glass_button.dart',
    'zephyr_agent/lib/ui/liquid_toggle.dart',
    'zephyr_agent/lib/app/zephyr_agent_app.dart',
  ]) {
    const banner = 'showModalBottomSheet<|PopupMenuButton<|showDialog<|AlertDialog(';
    for (const pat of banner.split('|')) {
      assert.ok(!read(rel).includes(pat), `${rel} must not use ${pat}`);
    }
  }
  // Theme selection is a row + sheet, not a popup menu.
  assert.match(home, /showGlassSheet<ZephyrTheme>/);
  // No MD3 progress metaphor anywhere in the UI layer.
  assert.doesNotMatch(home, /CircularProgressIndicator/);
  const app = read('zephyr_agent/lib/app/zephyr_agent_app.dart');
  assert.doesNotMatch(app, /CircularProgressIndicator/);
  assert.match(app, /AppleSpinner/);
  // The Material theme no longer ships MD3 control themes.
  const colors = read('zephyr_agent/lib/theme/zephyr_colors.dart');
  assert.doesNotMatch(colors, /elevatedButtonTheme: ElevatedButtonThemeData\(/);
  assert.doesNotMatch(colors, /switchTheme: SwitchThemeData\(/);
  assert.doesNotMatch(colors, /chipTheme: ChipThemeData\(/);
});

test('the auto-shutdown row says “10 minutes after start”, not “idle”', () => {
  const strings = read('zephyr_agent/lib/i18n/agent_strings.dart');
  assert.match(strings, /开启10分钟后自动关闭/);
  assert.match(strings, /'Auto shutdown 10 min after start'/);
  assert.doesNotMatch(strings, /闲置自动关闭/);
  assert.doesNotMatch(strings, /闲置/);
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.doesNotMatch(home, /闲置自动关闭/);
  const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
  assert.match(controller, /autoShutdownNotice\(/);
  assert.match(strings, /已因开启 \$minutes 分钟超时自动关闭/);
});

test('UI strings follow the system locale — zh and en ship side by side', () => {
  const strings = read('zephyr_agent/lib/i18n/agent_strings.dart');
  assert.match(strings, /class AgentStrings/);
  assert.match(strings, /PlatformDispatcher\.instance\.locale/);
  assert.match(strings, /languageCode\.toLowerCase\(\) == 'zh'/);
  // Every UI-facing string has both zh and en.
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(home, /AgentStrings\.system/);
  assert.doesNotMatch(home, /'启动连接'/);
  assert.doesNotMatch(home, /'停止共享'/);
  assert.doesNotMatch(home, /'作为跳板机'/);
  const state = read('zephyr_agent/lib/agent/agent_state.dart');
  assert.match(state, /AgentStrings\.system\.statusLabel/);
  const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
  assert.doesNotMatch(controller, /return '等待主端批准'/);
  const enrollment = read('zephyr_agent/lib/agent/link_enrollment_client.dart');
  assert.doesNotMatch(enrollment, /'等待批准超时，请重试'/);
  const app = read('zephyr_agent/lib/app/zephyr_agent_app.dart');
  assert.match(app, /supportedLocales: const \[Locale\('en'\), Locale\('zh'\)\]/);
  // Runtime layers that surface text to the UI are localized too.
  const hostLink = read('zephyr_agent/lib/agent/host_link_file_runtime.dart');
  assert.match(hostLink, /AgentStrings\.system/);
  assert.doesNotMatch(hostLink, /'Link 对端未设置'/);
  const embed = read('zephyr_agent/lib/agent/link_embed_process.dart');
  assert.match(embed, /AgentStrings\.system/);
  assert.doesNotMatch(embed, /'未找到 zephyr-link-embed/);
  // The auto-shutdown notice uses the new "after start" phrasing in both bundles.
  assert.match(strings, /autoShutdownNotice/);
  assert.match(strings, /'Sharing and jump host auto-stopped \$minutes min after start'/);
});

test('theme labels are localized too', () => {
  const colors = read('zephyr_agent/lib/theme/zephyr_colors.dart');
  assert.match(colors, /class ZephyrThemeLabels/);
  assert.match(colors, /static String of\(ZephyrTheme/);
  assert.doesNotMatch(colors, /凝霜蓝|熔岩流|浅葱影|极夜青/);
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(home, /ZephyrThemeLabels\.of\(/);
  const strings = read('zephyr_agent/lib/i18n/agent_strings.dart');
  for (const zh of ['凝霜蓝', '熔岩流', '浅葱影', '极夜青']) assert.ok(strings.includes(zh), `missing zh theme label ${zh}`);
  for (const en of ['Frost Blue', 'Lava Flow', 'Asagi Shade', 'Cyber Night']) assert.ok(strings.includes(en), `missing en theme label ${en}`);
});

test('settings field rows are a 44pt iOS row, never an expanding TextField', () => {
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.match(group, /class SettingsFieldRow/);
  assert.match(group, /return SizedBox\(\s*height: 44,/);
  assert.match(group, /CupertinoTextField\(/);
  assert.match(group, /decoration: const BoxDecoration\(\)/);
  // Material TextField's InputDecorator is what painted the gray slab.
  assert.doesNotMatch(group, /child: TextField\(/);
  assert.doesNotMatch(group, /isCollapsed: true/);
  // Android 14 SystemContextMenu dims the whole Activity. Adaptive's
  // default toolbar still routes there on SDK 34+, so the field must
  // ship a Flutter-owned capsule toolbar and cupertino handles.
  assert.match(group, /_AddressSelectionToolbar/);
  assert.match(group, /cupertinoTextSelectionHandleControls/);
  assert.match(group, /clipBehavior: Clip\.none/);
  assert.match(group, /maxLines: 1/);
  assert.doesNotMatch(group, /AdaptiveTextSelectionToolbar\.editableText/);
});

test('binding sheet opens the system browser the way Zephyr One does', () => {
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  const browser = read('zephyr_agent/lib/platform/system_browser.dart');
  const strings = read('zephyr_agent/lib/i18n/agent_strings.dart');
  const android = read('zephyr_agent/android_host/MainActivity.kt');
  const ios = read('zephyr_agent/ios_host/AppDelegate.swift');
  const mac = read('zephyr_agent/macos_host/MainFlutterWindow.swift');
  assert.match(home, /SystemBrowser\.open/);
  assert.match(home, /s\.actionOpenSystemBrowser/);
  assert.match(strings, /在系统浏览器批准/);
  assert.match(strings, /Approve in System Browser/);
  assert.doesNotMatch(home, /SelectableText\(info\.verificationUri/);
  assert.match(browser, /openUrl/);
  assert.match(android, /"openUrl"/);
  assert.match(android, /Intent\.ACTION_VIEW/);
  assert.match(android, /CATEGORY_BROWSABLE/);
  assert.match(ios, /"openUrl"/);
  assert.match(ios, /UIApplication\.shared\.open/);
  assert.match(mac, /"openUrl"/);
  assert.match(mac, /NSWorkspace\.shared\.open/);
});

test('primary actions, sheets and controls employ liquid glass over a calm system backdrop', () => {
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.match(group, /LiquidGlass\(/);
  const button = read('zephyr_agent/lib/ui/glass_button.dart');
  assert.match(button, /LiquidGlass\(/);
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(home, /LiquidGlassBackdrop\(/);
  const glass = read('zephyr_agent/lib/ui/liquid_glass.dart');
  assert.match(glass, /class LiquidGlass/);
  assert.match(glass, /BackdropFilter/);
  assert.match(glass, /Kyant/);
  // Kyant wire-up: refraction shader over the real backdrop, not a bare blur.
  assert.match(glass, /GlassProgram\.ensure\(\)/);
  assert.match(glass, /ImageFilter\.shader\(/);
  assert.match(glass, /setFloat\(3, widget\.refractionHeight\)/);
  assert.match(glass, /setFloat\(4, widget\.refractionAmount\)/);
  // Kyant surface: 60% near-white light, 40% near-black dark.
  assert.match(glass, /0xFFFAFAFA/);
  assert.match(glass, /0xFF121212/);
  // Rim is a 45° crescent (Default) over a Plain hairline — never a uniform ring.
  assert.match(glass, /0\.7853982 - 1\.35/);
  // The backdrop is a calm Apple HIG system backdrop without messy blooms.
  assert.doesNotMatch(glass, /_Bloom\(/);
});
