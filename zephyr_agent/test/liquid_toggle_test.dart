import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:liquid_glass_easy/liquid_glass_easy.dart';
import 'package:zephyr_agent/theme/zephyr_colors.dart';
import 'package:zephyr_agent/ui/liquid_toggle.dart';
import 'package:zephyr_agent/ui/settings_palette.dart';

Widget _wrap(Widget child, {ZephyrTheme theme = ZephyrTheme.frost}) {
  return MaterialApp(
    theme: ZephyrColors.buildTheme(theme, Brightness.light),
    home: SettingsPalette(
      palette: ZephyrColors.palette(theme, Brightness.light),
      child: Scaffold(body: Center(child: child)),
    ),
  );
}

void main() {
  testWidgets('liquid toggle taps to flip', (tester) async {
    var value = false;
    await tester.pumpWidget(_wrap(LiquidToggle(
      value: value,
      onChanged: (v) => value = v,
    )));
    expect(find.byType(LiquidToggle), findsOneWidget);
    expect(find.byType(LiquidGlassSwitch), findsOneWidget);
    await tester.tap(find.byType(LiquidToggle));
    await tester.pump();
    expect(value, isTrue);
  });

  testWidgets('disabled toggle does not flip', (tester) async {
    var value = false;
    await tester.pumpWidget(_wrap(LiquidToggle(
      value: value,
      onChanged: null,
    )));
    await tester.tap(find.byType(LiquidToggle));
    await tester.pump();
    expect(value, isFalse);
  });

  testWidgets('toggle delegates to LiquidGlassSwitch with layout sizing', (tester) async {
    await tester.pumpWidget(_wrap(LiquidToggle(value: false, onChanged: (_) {})));
    final size = tester.getSize(find.byType(LiquidToggle));
    expect(size.width, LiquidToggle.trackWidth);
    expect(size.height, LiquidToggle.trackHeight);
  });

  testWidgets('on-state track follows the theme accent, not a fixed green',
      (tester) async {
    Color trackColor(ZephyrTheme theme) {
      return ZephyrColors.palette(theme, Brightness.light).accent;
    }

    final frost = trackColor(ZephyrTheme.frost);
    final lava = trackColor(ZephyrTheme.lava);
    expect(frost, ZephyrColors.palette(ZephyrTheme.frost, Brightness.light).accent);
    expect(lava, ZephyrColors.palette(ZephyrTheme.lava, Brightness.light).accent);
    expect(frost, isNot(lava));
    expect(frost, isNot(const Color(0xFF34C759)));
  });

  testWidgets('off-state track is the translucent groove regardless of theme',
      (tester) async {
    await tester.pumpWidget(_wrap(LiquidToggle(value: false, onChanged: (_) {})));
    final sw = tester.widget<LiquidGlassSwitch>(find.byType(LiquidGlassSwitch));
    expect(sw.inactiveTrackColor, const Color(0x33787878));
  });
}
