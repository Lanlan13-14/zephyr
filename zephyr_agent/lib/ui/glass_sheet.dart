import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/zephyr_colors.dart';
import 'settings_group.dart';

/// Presents a modal sheet in the iOS card style: it floats over the dimmed
/// previous context, the top corners are continuously rounded, the surface is
/// blurred glass, and a grabber pill sits on top.
///
/// Every secondary surface in the Agent goes through here — no MD3 dialogs,
/// no Material popup menus.
Future<T?> showGlassSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = false,
}) {
  final palette = SettingsPaletteLike.of(context);
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: isScrollControlled,
    backgroundColor: Colors.transparent,
    barrierColor: Colors.black.withValues(alpha: 0.32),
    builder: (ctx) => SettingsPalette(
      palette: palette,
      child: _GlassSheetFrame(
        child: Builder(builder: builder),
      ),
    ),
  );
}

/// Duck-typed accessor so the sheet does not depend on the settings module's
/// private API surface.
class SettingsPaletteLike {
  static ZephyrPalette of(BuildContext context) => SettingsPalette.of(context);
}

class _GlassSheetFrame extends StatelessWidget {
  final Widget child;
  const _GlassSheetFrame({required this.child});

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    const radius = Radius.circular(16);
    return ClipRRect(
      borderRadius: const BorderRadius.vertical(top: radius),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 28, sigmaY: 28),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: const BorderRadius.vertical(top: radius),
            color: (dark ? const Color(0xFF1C1C1E) : const Color(0xFFF7F7F9))
                .withValues(alpha: dark ? 0.82 : 0.88),
            border: Border(
              top: BorderSide(
                color: Colors.white.withValues(alpha: dark ? 0.14 : 0.6),
                width: 0.5,
              ),
            ),
          ),
          child: SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6, bottom: 2),
                  child: Container(
                    width: 36,
                    height: 5,
                    decoration: BoxDecoration(
                      color: palette.textSecondary.withValues(alpha: 0.45),
                      borderRadius: BorderRadius.circular(2.5),
                    ),
                  ),
                ),
                DefaultTextStyle(
                  style: TextStyle(color: palette.text),
                  child: child,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
