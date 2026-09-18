import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/theme/zephyr_colors.dart';
import 'package:zephyr_agent/ui/glass_sheet.dart';
import 'package:zephyr_agent/ui/settings_group.dart';
import 'package:zephyr_agent/ui/settings_palette.dart';

/// 1.0.32: showGlassSheet looked up SettingsPalette on the State's context,
/// which sits *above* the palette InheritedWidget. The assert aborted the
/// tap and the sheet never appeared. This test calls it from exactly that
/// shape of tree.
void main() {
  testWidgets('showGlassSheet opens from a context that has no SettingsPalette ancestor',
      (tester) async {
    final palette = ZephyrColors.palette(ZephyrTheme.frost, Brightness.light);
    await tester.pumpWidget(MaterialApp(
      theme: ZephyrColors.buildTheme(ZephyrTheme.frost, Brightness.light),
      home: _Caller(palette: palette),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    expect(find.text('Sheet body'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping a SettingsRow with onTap actually fires', (tester) async {
    var taps = 0;
    final palette = ZephyrColors.palette(ZephyrTheme.frost, Brightness.light);
    await tester.pumpWidget(MaterialApp(
      theme: ZephyrColors.buildTheme(ZephyrTheme.frost, Brightness.light),
      home: SettingsPalette(
        palette: palette,
        child: Scaffold(
          body: SettingsGroup(children: [
            SettingsRow(
              title: 'Theme',
              detail: 'Frost',
              showChevron: true,
              onTap: () => taps++,
            ),
          ]),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Theme'));
    await tester.pump();
    expect(taps, 1);
  });
}

class _Caller extends StatelessWidget {
  final ZephyrPalette palette;
  const _Caller({required this.palette});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: TextButton(
          onPressed: () {
            showGlassSheet<void>(
              context: context,
              palette: palette,
              builder: (_) => const Padding(
                padding: EdgeInsets.all(24),
                child: Text('Sheet body'),
              ),
            );
          },
          child: const Text('Open'),
        ),
      ),
    );
  }
}
