import 'package:flutter/material.dart';

import '../theme/zephyr_colors.dart';

/// Carries the active Zephyr palette down the settings tree. Rows, toggles,
/// sheets, and glass controls all resolve color from here, so a single theme
/// switch recolors the entire surface — including every toggle track.
class SettingsPalette extends InheritedWidget {
  final ZephyrPalette palette;
  const SettingsPalette({super.key, required this.palette, required super.child});

  static ZephyrPalette of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<SettingsPalette>();
    assert(scope != null, 'SettingsPalette missing');
    return scope!.palette;
  }

  static ZephyrPalette? maybeOf(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<SettingsPalette>()?.palette;
  }

  @override
  bool updateShouldNotify(SettingsPalette oldWidget) => oldWidget.palette != palette;
}
