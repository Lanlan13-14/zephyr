import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/zephyr_colors.dart';
import 'settings_palette.dart';

/// Visual model taken from sdegenaar/liquid_glass_widgets (MIT):
/// PATH B of `lightweight_glass.frag` — frost fill + dual-highlight specular
/// rim + Fresnel + optional chromatic fringe. Driven with the same knobs
/// (`blur`, `thickness`, `lightIntensity`, `refractiveIndex`, `saturation`).
///
/// We cannot depend on the pub package (it requires Flutter ≥ 3.41). This
/// widget is the Agent's in-tree restoration of that look, so glass has a
/// backdrop to sample: put it over a non-flat background.
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
    this.blur = 20,
    this.thickness = 20,
    this.lightIntensity = 0.5,
    this.refractiveIndex = 1.2,
    this.tint,
    this.padding,
    this.hairline = true,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.maybeOf(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    // PATH B frost: light mode lifts toward white, dark mode stays a dim
    // translucent plate. Matches applyGlassColorLW's achromatic path.
    final frost = tint ??
        (dark
            ? const Color(0xFF1C1C1E).withValues(alpha: 0.55)
            : const Color(0xFFFFFFFF).withValues(alpha: 0.62));
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
    // Dual-highlight specular (kSpecularPowerPrimary / Kick from the shader).
    final rim = dark ? 0.55 : 0.78;
    final thicknessBoost = ((thickness - 10) / 10).clamp(-0.3, 0.6);
    final alpha = (0.28 + 0.22 * lightIntensity + 0.08 * thicknessBoost) *
        refractiveIndex.clamp(1.0, 1.6);

    canvas.drawRRect(
      rrect.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.6
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Colors.white.withValues(alpha: (rim * alpha).clamp(0.0, 1.0)),
            Colors.white.withValues(alpha: 0.08),
            accent.withValues(alpha: 0.10 * lightIntensity),
          ],
          stops: const [0.0, 0.55, 1.0],
        ).createShader(Offset.zero & size),
    );

    // Inner highlight — top edge only, like the shader's fresnel * borderMask.
    final inner = rrect.deflate(1.1);
    canvas.save();
    canvas.clipRRect(inner);
    canvas.drawRRect(
      inner,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: const Alignment(0, -0.2),
          colors: [
            Colors.white.withValues(alpha: dark ? 0.16 : 0.34),
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

/// Theme-tinted mesh that liquid glass can actually refract. Flat grey
/// behind glass is why the previous build looked like a cheap BackdropFilter.
class LiquidGlassBackdrop extends StatelessWidget {
  final ZephyrPalette palette;
  final Widget child;
  const LiquidGlassBackdrop({super.key, required this.palette, required this.child});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Stack(
      fit: StackFit.expand,
      children: [
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                palette.bg,
                Color.lerp(palette.bg, palette.accent, dark ? 0.18 : 0.10)!,
                Color.lerp(palette.bg, palette.accent, dark ? 0.08 : 0.04)!,
              ],
              stops: const [0.0, 0.55, 1.0],
            ),
          ),
        ),
        Positioned(
          right: -80,
          top: 40,
          child: IgnorePointer(
            child: ImageFiltered(
              imageFilter: ImageFilter.blur(sigmaX: 48, sigmaY: 48),
              child: Transform.rotate(
                angle: -math.pi / 10,
                child: Container(
                  width: 280,
                  height: 280,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: palette.accent.withValues(alpha: dark ? 0.22 : 0.14),
                  ),
                ),
              ),
            ),
          ),
        ),
        Positioned(
          left: -60,
          bottom: 80,
          child: IgnorePointer(
            child: ImageFiltered(
              imageFilter: ImageFilter.blur(sigmaX: 56, sigmaY: 56),
              child: Container(
                width: 220,
                height: 220,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: palette.accentHover.withValues(alpha: dark ? 0.16 : 0.10),
                ),
              ),
            ),
          ),
        ),
        child,
      ],
    );
  }
}
