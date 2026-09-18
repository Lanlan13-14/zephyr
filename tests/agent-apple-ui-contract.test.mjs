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

test('every toggle is the liquid-glass switch, not MD3 Switch', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  assert.match(toggle, /class LiquidToggle/);
  assert.match(toggle, /Kyant0\/AndroidLiquidGlass/);
  assert.match(toggle, /BackdropFilter/);
  assert.match(toggle, /0xFF5AC8FA/);
  assert.match(toggle, /disableAnimations/);
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.match(group, /LiquidToggle\(/);
  assert.doesNotMatch(group, /Switch\(/);
});

test('liquid toggle follows Kyant geometry: 64 by 28, 40 by 24 thumb, 20pt travel', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  assert.match(toggle, /static const double trackWidth = 64/);
  assert.match(toggle, /static const double trackHeight = 28/);
  assert.match(toggle, /static const double thumbWidth = 40/);
  assert.match(toggle, /static const double thumbHeight = 24/);
  assert.match(toggle, /static const double travel = trackWidth - thumbWidth - inset \* 2/);
  assert.match(toggle, /_onPointerMove/);
  assert.match(toggle, /SpringSimulation/);
});

test('the toggle track is the single theme accent, never a fixed green', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  // No color parameter on the constructor — per-row colors are impossible.
  assert.doesNotMatch(toggle, /final Color activeColor/);
  assert.doesNotMatch(toggle, /required this\.activeColor/);
  // On-state track resolves from SettingsPalette accent.
  assert.match(toggle, /SettingsPalette\.maybeOf\(context\)\?\.accent/);
  // Off-state is the Kyant groove (translucent system gray).
  assert.match(toggle, /0x33787878/);
  assert.match(toggle, /0x5C787880/);
  // Kyant's own system green must not appear — on-track is the theme accent.
  assert.doesNotMatch(toggle, /0xFF34C759/);
  assert.doesNotMatch(toggle, /0xFF30D158/);
  // No sdegenaar specular track gradient or glow.
  assert.doesNotMatch(toggle, /specularTop/);
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.doesNotMatch(group, /activeColor: iconColor/);
});

test('the toggle thumb is a hollow refractive shell, not a milk-white knob', () => {
  const toggle = read('zephyr_agent/lib/ui/liquid_toggle.dart');
  // Kyant onDrawSurface: white fades out on press, blur/lens scale with press.
  assert.match(toggle, /surfaceOpacity = \(1 - press\)/);
  assert.match(toggle, /blurSigma = 8 \* \(1 - press\)/);
  assert.match(toggle, /refrHeight = 5 \* press/);
  assert.match(toggle, /refrAmount = 10 \* press/);
  assert.match(toggle, /BackdropFilter/);
  assert.match(toggle, /0x0D000000/);
  // The sdegenaar milk fill (0.94 white) and bloom core are gone.
  assert.doesNotMatch(toggle, /0\.94/);
  assert.doesNotMatch(toggle, /coreOpacity/);
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
});

test('grouped cards, sheets, and the primary button are liquid glass over a refracting backdrop', () => {
  const group = read('zephyr_agent/lib/ui/settings_group.dart');
  assert.match(group, /LiquidGlass\(/);
  const button = read('zephyr_agent/lib/ui/glass_button.dart');
  assert.match(button, /LiquidGlass\(/);
  const home = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(home, /LiquidGlassBackdrop\(/);
  const glass = read('zephyr_agent/lib/ui/liquid_glass.dart');
  assert.match(glass, /class LiquidGlass/);
  assert.match(glass, /BackdropFilter/);
  assert.match(glass, /sdegenaar\/liquid_glass_widgets/);
  assert.match(glass, /PATH B/);
  // Light-mode page is plain white — the tinted mesh was plastic, not glass.
  assert.match(glass, /dark \? palette\.bg : const Color\(0xFFFFFFFF\)/);
  assert.doesNotMatch(glass, /palette\.accent\.withValues\(alpha: dark \? 0\.22/);
  // Body frost stays under 0.20 so the backdrop reads through.
  assert.match(glass, /alpha: 0\.16\)/);
  assert.doesNotMatch(glass, /alpha: 0\.62/);
});
