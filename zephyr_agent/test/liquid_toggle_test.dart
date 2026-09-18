import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

  testWidgets('toggle is the Kyant 64 by 28 capsule', (tester) async {
    await tester.pumpWidget(_wrap(LiquidToggle(value: false, onChanged: (_) {})));
    final size = tester.getSize(find.byType(LiquidToggle));
    expect(size.width, LiquidToggle.trackWidth);
    expect(size.height, LiquidToggle.trackHeight);
    expect(LiquidToggle.trackWidth, 64);
    expect(LiquidToggle.trackHeight, 28);
    expect(LiquidToggle.thumbWidth, 40);
    expect(LiquidToggle.thumbHeight, 24);
    expect(LiquidToggle.travel, 20);
  });

  testWidgets('on-state track follows the theme accent, not a fixed green',
      (tester) async {
    Future<Color> trackColor(ZephyrTheme theme) async {
      await tester.pumpWidget(_wrap(LiquidToggle(value: true, onChanged: (_) {}), theme: theme));
      await tester.pump();
      final box = tester.widget<DecoratedBox>(
        find.descendant(
          of: find.byType(LiquidToggle),
          matching: find.byType(DecoratedBox),
        ).first,
      );
      return (box.decoration as BoxDecoration).color!;
    }

    final frost = await trackColor(ZephyrTheme.frost);
    final lava = await trackColor(ZephyrTheme.lava);
    expect(frost, ZephyrColors.palette(ZephyrTheme.frost, Brightness.light).accent);
    expect(lava, ZephyrColors.palette(ZephyrTheme.lava, Brightness.light).accent);
    expect(frost, isNot(lava));
    expect(frost, isNot(const Color(0xFF34C759)));
  });

  testWidgets('off-state track is the translucent groove regardless of theme',
      (tester) async {
    Future<Color> trackColor(ZephyrTheme theme) async {
      await tester.pumpWidget(_wrap(LiquidToggle(value: false, onChanged: (_) {}), theme: theme));
      await tester.pump();
      final box = tester.widget<DecoratedBox>(
        find.descendant(
          of: find.byType(LiquidToggle),
          matching: find.byType(DecoratedBox),
        ).first,
      );
      return (box.decoration as BoxDecoration).color!;
    }

    final frost = await trackColor(ZephyrTheme.frost);
    final lava = await trackColor(ZephyrTheme.lava);
    expect(frost, const Color(0x33787878));
    expect(frost, lava);
  });
}
