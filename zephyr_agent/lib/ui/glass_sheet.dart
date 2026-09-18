import 'package:flutter/material.dart';

import '../theme/zephyr_colors.dart';
import 'liquid_glass.dart';
import 'settings_palette.dart';

/// Presents a modal sheet in the iOS card style after
/// sdegenaar/liquid_glass_widgets `GlassSheet.show`:
/// floating over a dimmed context, continuously rounded, liquid-glass
/// surface, grabber pill, ease-out-cubic slide.
///
/// [palette] is required because the caller is often a State whose
/// `context` sits *above* [SettingsPalette] — looking it up there
/// asserts and the tap appears to do nothing (the 1.0.32 bug).
Future<T?> showGlassSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  required ZephyrPalette palette,
  bool isScrollControlled = false,
}) {
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Dismiss',
    barrierColor: Colors.black.withValues(alpha: 0.38),
    transitionDuration: const Duration(milliseconds: 280),
    pageBuilder: (ctx, animation, secondary) {
      return SettingsPalette(
        palette: palette,
        child: _GlassSheetHost(
          animation: animation,
          isScrollControlled: isScrollControlled,
          child: Builder(builder: builder),
        ),
      );
    },
  );
}

class _GlassSheetHost extends StatelessWidget {
  final Animation<double> animation;
  final bool isScrollControlled;
  final Widget child;
  const _GlassSheetHost({
    required this.animation,
    required this.isScrollControlled,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    final curved = CurvedAnimation(
      parent: animation,
      curve: const Cubic(0.23, 1, 0.32, 1),
      reverseCurve: const Cubic(0.55, 0, 1, 0.45),
    );
    return SafeArea(
      top: false,
      child: Align(
        alignment: Alignment.bottomCenter,
        child: SlideTransition(
          position: Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero).animate(curved),
          child: FadeTransition(
            opacity: curved,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Material(
                type: MaterialType.transparency,
                child: LiquidGlass(
                  borderRadius: BorderRadius.circular(28),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: MediaQuery.sizeOf(context).height * (isScrollControlled ? 0.92 : 0.72),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 8, bottom: 4),
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
                          child: isScrollControlled
                              ? SingleChildScrollView(child: child)
                              : child,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
