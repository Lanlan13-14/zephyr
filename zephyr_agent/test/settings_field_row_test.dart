import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/theme/zephyr_colors.dart';
import 'package:zephyr_agent/ui/settings_group.dart';
import 'package:zephyr_agent/ui/settings_palette.dart';

void main() {
  Widget wrap(Widget child) {
    return MaterialApp(
      theme: ZephyrColors.buildTheme(ZephyrTheme.frost, Brightness.light),
      home: SettingsPalette(
        palette: ZephyrColors.palette(ZephyrTheme.frost, Brightness.light),
        child: Scaffold(
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [child],
          ),
        ),
      ),
    );
  }

  testWidgets('address field stays a 44pt row inside a ListView, never fills the viewport',
      (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(wrap(SettingsGroup(header: 'Server', children: [
      SettingsFieldRow(
        label: 'Address',
        controller: TextEditingController(),
        enabled: true,
        placeholder: 'https://zephyr.example.com',
      ),
      SettingsToggleRow(
        icon: Icons.lock_open_outlined,
        iconColor: const Color(0xFFFFD60A),
        title: 'Allow Self-Signed',
        value: true,
        onChanged: (_) {},
      ),
    ])));
    await tester.pumpAndSettle();

    final fieldSize = tester.getSize(find.byType(SettingsFieldRow));
    expect(fieldSize.height, 44);

    final groupSize = tester.getSize(find.byType(SettingsGroup));
    // Header + 44pt field + divider + 44pt toggle + bottom padding 28.
    // Must stay well under a phone viewport — the 1.0.31 bug filled ~700pt.
    expect(groupSize.height, lessThan(200));
    expect(groupSize.height, greaterThan(90));

    // The toggle row after the field is still on screen, not pushed off.
    expect(find.text('Allow Self-Signed'), findsOneWidget);
    expect(tester.getTopLeft(find.text('Allow Self-Signed')).dy, lessThan(200));
  });

  testWidgets('TextField inside SettingsFieldRow does not expand', (tester) async {
    await tester.pumpWidget(wrap(SettingsFieldRow(
      label: 'Address',
      controller: TextEditingController(text: 'https://example.com'),
      enabled: true,
    )));
    await tester.pumpAndSettle();
    final tf = tester.getSize(find.byType(TextField));
    expect(tf.height, lessThanOrEqualTo(44));
  });
}
