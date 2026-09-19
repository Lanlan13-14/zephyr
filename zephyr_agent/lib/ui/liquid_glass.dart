import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/zephyr_colors.dart';
import 'glass_program.dart';
import 'settings_palette.dart';

/// Liquid-glass plate after Kyant `drawBackdrop` + `DialogContent`.
///
/// Layer order mirrors upstream exactly:
/// backdrop sampling → vibrancy → blur → lens → surface → highlight →
/// shadow → child.
///
/// The plate samples the real screen behind it (BackdropFilter + the
/// refraction shader), so it only reads as glass over a non-flat
/// background. On a flat fill the math is identity — that is physics,
/// not a bug.
class LiquidGlass extends StatefulWidget {
  final Widget child;
  final BorderRadius borderRadius;

  /// DialogContent light/dark blur: 16 / 8.
  final double blur;

  /// Refraction band height in px (Kyant `refractionHeight`).
  final double refractionHeight;

  /// Refraction bend amount in px (Kyant `refractionAmount`).
  final double refractionAmount;

  /// Kyant `depthEffect`.
  final bool depthEffect;

  /// Kyant `onDrawSurface` tint. When null, surfaces stay fully clear in
  /// light mode and 40%-black in dark mode (DialogContent containerColor).
  final Color? tint;

  final EdgeInsetsGeometry? padding;
  final bool hairline;
  final bool specularCrescent;

  const LiquidGlass({
    super.key,
    required this.child,
    this.borderRadius = const BorderRadius.all(Radius.circular(12)),
    this.blur = 16,
    this.refractionHeight = 24,
    this.refractionAmount = 48,
    this.depthEffect = true,
    this.tint,
    this.padding,
    this.hairline = true,
    this.specularCrescent = true,
  });

  @override
  State<LiquidGlass> createState() => _LiquidGlassState();
}

class _LiquidGlassState extends State<LiquidGlass> {
  FragmentShader? _shader;

  @override
  void initState() {
    super.initState();
    GlassProgram.ensure().then((program) {
      if (!mounted || program == null) return;
      setState(() => _shader = program.fragmentShader());
    });
  }

  @override
  void dispose() {
    _shader?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.maybeOf(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    // DialogContent containerColor: 60% near-white light, 40% near-black dark.
    final surface = widget.tint ??
        (dark
            ? const Color(0xFF121212).withValues(alpha: 0.40)
            : const Color(0xFFFAFAFA).withValues(alpha: 0.60));
    final radius = widget.borderRadius.topLeft.x;
    return LayoutBuilder(builder: (context, constraints) {
      final w = constraints.maxWidth.isFinite ? constraints.maxWidth : 300.0;
      final maxH = constraints.maxHeight;
      final h = maxH.isFinite && maxH < 2000 ? maxH : 96.0;
      final ImageFilter filter;
      final shader = _shader;
      if (shader != null) {
        shader
          ..setFloat(0, w)
          ..setFloat(1, h)
          ..setFloat(2, radius)
          ..setFloat(3, widget.refractionHeight)
          ..setFloat(4, widget.refractionAmount)
          ..setFloat(5, 1.0);
        filter = ImageFilter.shader(shader);
      } else {
        filter = ImageFilter.blur(sigmaX: widget.blur, sigmaY: widget.blur);
      }
      return ClipRRect(
        borderRadius: widget.borderRadius,
        child: BackdropFilter(
          filter: filter,
          child: CustomPaint(
            foregroundPainter: _GlassRimPainter(
              radius: widget.borderRadius,
              dark: dark,
              hairline: widget.hairline,
              accent: palette?.accent,
              specularCrescent: widget.specularCrescent,
            ),
            child: ColoredBox(
              // Kyant onDrawSurface sits ON TOP of the refracted backdrop;
              // saturation/vibrancy is a render effect, not extra opacity.
              color: surface,
              child: widget.padding == null
                  ? widget.child
                  : Padding(padding: widget.padding!, child: widget.child),
            ),
          ),
        ),
      );
    });
  }
}

class _GlassRimPainter extends CustomPainter {
  final BorderRadius radius;
  final bool dark;
  final bool hairline;
  final Color? accent;
  final bool specularCrescent;

  _GlassRimPainter({
    required this.radius,
    required this.dark,
    required this.hairline,
    required this.accent,
    this.specularCrescent = true,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (!hairline || size.isEmpty) return;
    final rrect = radius.toRRect(Offset.zero & size);
    // Kyant Highlight.Plain: white 38% additive. No saturation wash —
    // DialogContent reserves that for render effects, not the rim.
    canvas.drawRRect(
      rrect.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.5
        ..color = Colors.white.withValues(alpha: 0.38),
    );

    // Kyant Highlight.Default at 45°: edge normals facing the light pick up
    // the specular, the rest falls off.
    // Suppressed on buttons so wide elongated capsules stay clean and
    // uninterrupted without an arbitrary circular arc cutting across the label.
    if (specularCrescent) {
      canvas.save();
      canvas.clipRRect(rrect.deflate(1.0));
      canvas.drawArc(
        Rect.fromCenter(
          center: Offset(size.width / 2, size.height / 2),
          width: size.width + 2,
          height: size.height + 2,
        ),
        0.7853982 - 1.35,
        2.7,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.4
          ..color = Colors.white.withValues(alpha: dark ? 0.34 : 0.50),
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _GlassRimPainter old) =>
      old.dark != dark || old.accent != accent || old.specularCrescent != specularCrescent;
}

/// Clean, calm Apple system backdrop.
///
/// Light mode resolves to iOS systemGroupedBackground (0xFFF2F2F7),
/// Dark mode resolves to true deep OLED black (0xFF000000).
/// Eliminates cluttered color blooms and plastic gradients so the content
/// cards and liquid glass interactions shine with clarity and high contrast.
class LiquidGlassBackdrop extends StatelessWidget {
  final ZephyrPalette palette;
  final Widget child;
  const LiquidGlassBackdrop({super.key, required this.palette, required this.child});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final bg = dark ? const Color(0xFF000000) : const Color(0xFFF2F2F7);
    return ColoredBox(
      color: bg,
      child: child,
    );
  }
}
