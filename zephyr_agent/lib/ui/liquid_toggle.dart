import 'package:flutter/material.dart';
import 'package:liquid_glass_easy/liquid_glass_easy.dart';

import 'settings_palette.dart';

/// Authentic iOS 26 liquid glass switch, directly delegating to
/// liquid_glass_easy's LiquidGlassSwitch without any custom imitation.
///
/// Only customization is resolving the active track color from the active
/// theme palette accent and the inactive track color from the system gray.
class LiquidToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;

  static const double trackWidth = 63;
  static const double trackHeight = 28;
  static const double thumbWidth = 37;
  static const double thumbHeight = 24;
  static const double inset = 2;
  static const double travel = 20;

  const LiquidToggle({
    super.key,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final onTrack = SettingsPalette.maybeOf(context)?.accent ?? (dark ? const Color(0xFF0A84FF) : const Color(0xFF007AFF));
    final offTrack = dark ? const Color(0x5C787880) : const Color(0x33787878);

    final control = LiquidGlassSwitch(
      value: value,
      onChanged: onChanged ?? (_) {},
      activeColor: onTrack,
      inactiveColor: offTrack,
    );

    if (onChanged == null) {
      return IgnorePointer(
        child: Opacity(opacity: 0.42, child: control),
      );
    }
    return control;
  }
}
