import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/zephyr_colors.dart';
import 'settings_palette.dart';

/// Visual model taken from sdegenaar/liquid_glass_widgets (MIT),
/// PATH B of `lightweight_glass.frag`: low frost, dual-highlight specular
/// rim, Fresnel inner highlight.
///
/// The 1.0.33 plate painted a 62% opaque white fill over an 18px blur —
/// that's frosted plastic, not glass. Body alpha stays under ~0.20 so the
/// backdrop actually reads; the edge does the rest.
class LiquidGlass extends StatelessWidget {
  final Widget child;
  final BorderRadius borderRadius;
  final double blur;
  final double thickness;
  final double lightIntensity;
  final double refractiveIndex;
  final Color? tint;
  final EdgeInsetsGeometry? padding;
  final bool hairline;

  const LiquidGlass({
    super.key,
    required this.child,
    this.borderRadius = const BorderRadius.all(Radius.circular(12)),
    this.blur = 28,
    this.thickness = 20,
    this.lightIntensity = 0.55,
    this.refractiveIndex = 1.2,
    this.tint,
    this.padding,
    this.hairline = true,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.maybeOf(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    // PATH B frost floor is ~8%. Anything past ~0.25 reads as milk.
    final frost = tint ??
        (dark
            ? const Color(0xFFFFFFFF).withValues(alpha: 0.08)
            : const Color(0xFFFFFFFF).withValues(alpha: 0.16));
    return ClipRRect(
      borderRadius: borderRadius,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: CustomPaint(
          foregroundPainter: _GlassRimPainter(
            radius: borderRadius,
            dark: dark,
            lightIntensity: lightIntensity,
            thickness: thickness,
            refractiveIndex: refractiveIndex,
            hairline: hairline,
            accent: palette?.accent ?? frost,
          ),
          child: ColoredBox(
            color: frost,
            child: padding == null ? child : Padding(padding: padding!, child: child),
          ),
        ),
      ),
    );
  }
}

class _GlassRimPainter extends CustomPainter {
  final BorderRadius radius;
  final bool dark;
  final double lightIntensity;
  final double thickness;
  final double refractiveIndex;
  final bool hairline;
  final Color accent;

  _GlassRimPainter({
    required this.radius,
    required this.dark,
    required this.lightIntensity,
    required this.thickness,
    required this.refractiveIndex,
    required this.hairline,
    required this.accent,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (!hairline || size.isEmpty) return;
    final rrect = radius.toRRect(Offset.zero & size);
    final thicknessBoost = ((thickness - 10) / 10).clamp(-0.3, 0.6);
    final alpha = (0.42 + 0.30 * lightIntensity + 0.08 * thicknessBoost) *
        refractiveIndex.clamp(1.0, 1.6);

    canvas.drawRRect(
      rrect.deflate(0.4),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.7
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Colors.white.withValues(alpha: (0.92 * alpha).clamp(0.0, 1.0)),
            Colors.white.withValues(alpha: dark ? 0.12 : 0.28),
            accent.withValues(alpha: 0.16 * lightIntensity),
          ],
          stops: const [0.0, 0.55, 1.0],
        ).createShader(Offset.zero & size),
    );

    final inner = rrect.deflate(1.2);
    canvas.save();
    canvas.clipRRect(inner);
    canvas.drawRRect(
      inner,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: const Alignment(0, -0.28),
          colors: [
            Colors.white.withValues(alpha: dark ? 0.26 : 0.48),
            Colors.white.withValues(alpha: 0.0),
          ],
        ).createShader(Offset.zero & size),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _GlassRimPainter old) =>
      old.dark != dark ||
      old.lightIntensity != lightIntensity ||
      old.thickness != thickness ||
      old.accent != accent;
}

/// Page backdrop. Light mode is plain white — the colored mesh was why
/// 1.0.33 read as tinted plastic. Dark mode keeps the theme bg, no blobs.
class LiquidGlassBackdrop extends StatelessWidget {
  final ZephyrPalette palette;
  final Widget child;
  const LiquidGlassBackdrop({super.key, required this.palette, required this.child});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return ColoredBox(
      color: dark ? palette.bg : const Color(0xFFFFFFFF),
      child: child,
    );
  }
}
