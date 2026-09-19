import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/services.dart';

import 'glass_program.dart';
import 'settings_palette.dart';

/// Capsule liquid-glass switch, 1:1 after Kyant0/AndroidLiquidGlass
/// `LiquidToggle` + `DampedDragAnimation`.
///
/// 64×28 track, 40×24 glass thumb, 2pt inset, 20pt travel. The thumb is a
/// hollow refractive shell: backdrop sampling + blur(8·(1-p)) +
/// lens(5p→10p, chromatic) + ambient highlight, over a white surface that
/// fades out on press (alpha 1→0).
///
/// On touch or toggle jump:
/// - Thumb blooms (scale 1.0 → 1.5, pressProgress 0 → 1), solid white melts away
///   into living liquid glass with chromatic dispersion.
/// - During motion, finger velocity squashes and stretches the knob.
/// - On landing, underdamped springs (damping 0.6 / 0.7) snap the knob back
///   with a juicy jelly bounce as the white surface solidifies into place.
///
/// Track stays the track: solid interpolated color (theme accent when on,
/// translucent gray groove when off).
class LiquidToggle extends StatefulWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;

  const LiquidToggle({
    super.key,
    required this.value,
    required this.onChanged,
  });

  /// LiquidToggle geometry (Kyant0 / AndroidLiquidGlass).
  static const double trackWidth = 64;
  static const double trackHeight = 28;
  static const double thumbWidth = 40;
  static const double thumbHeight = 24;
  static const double inset = 2;
  static const double travel = trackWidth - thumbWidth - inset * 2;

  static Color trackOnColor(BuildContext context) =>
      SettingsPalette.maybeOf(context)?.accent ?? Theme.of(context).colorScheme.primary;

  /// Light: 20% translucent grey. Dark: 36% translucent grey-white.
  static Color trackOffColor(Brightness brightness) => brightness == Brightness.dark
      ? const Color(0x5C787880)
      : const Color(0x33787878);

  @override
  State<LiquidToggle> createState() => _LiquidToggleState();
}

class _LiquidToggleState extends State<LiquidToggle>
    with TickerProviderStateMixin {
  late final AnimationController _fraction;
  late final AnimationController _press;
  late final AnimationController _scaleX;
  late final AnimationController _scaleY;

  bool _dragging = false;
  Offset _lastMove = Offset.zero;
  Duration _lastMoveAt = Duration.zero;
  double _velocity = 0;
  bool _tapDown = false;
  VoidCallback? _landingCheck;

  bool get _enabled => widget.onChanged != null;

  @override
  void initState() {
    super.initState();
    // DampedDragAnimation value spec: spring(1, 1000). Critically damped travel.
    _fraction = AnimationController.unbounded(
      vsync: this,
      value: widget.value ? 1.0 : 0.0,
    )..addListener(() => setState(() {}));

    // pressProgress spec: spring(1, 1000). Drives the glass melting stack.
    _press = AnimationController.unbounded(vsync: this, value: 0.0)
      ..addListener(() => setState(() {}));

    // scaleX spec: spring(0.6, 250). Underdamped bounce on release!
    _scaleX = AnimationController.unbounded(vsync: this, value: 1.0)
      ..addListener(() => setState(() {}));

    // scaleY spec: spring(0.7, 250). Underdamped bounce on release!
    _scaleY = AnimationController.unbounded(vsync: this, value: 1.0)
      ..addListener(() => setState(() {}));
  }

  @override
  void didUpdateWidget(covariant LiquidToggle oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value && !_dragging && !_tapDown) {
      _animateToTarget(widget.value ? 1.0 : 0.0);
    }
  }

  @override
  void dispose() {
    if (_landingCheck != null) {
      _fraction.removeListener(_landingCheck!);
      _landingCheck = null;
    }
    _fraction.dispose();
    _press.dispose();
    _scaleX.dispose();
    _scaleY.dispose();
    super.dispose();
  }

  bool get _reduceMotion =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  static final _valueSpring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 1000,
    ratio: 1.0,
  );
  static final _pressSpring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 1000,
    ratio: 1.0,
  );
  static final _scaleXSpring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 250,
    ratio: 0.6, // Kyant DampedDragAnimation: underdamped jelly bounce
  );
  static final _scaleYSpring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 250,
    ratio: 0.7, // Kyant DampedDragAnimation: underdamped jelly bounce
  );

  void _haptic() {
    if (_reduceMotion) return;
    unawaited(HapticFeedback.lightImpact());
  }

  void _pressDown() {
    if (_reduceMotion) {
      _press.value = 1.0;
      _scaleX.value = 1.5;
      _scaleY.value = 1.5;
      return;
    }
    _press.animateWith(SpringSimulation(
      _pressSpring,
      _press.value,
      1.0,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
    _scaleX.animateWith(SpringSimulation(
      _scaleXSpring,
      _scaleX.value,
      1.5,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
    _scaleY.animateWith(SpringSimulation(
      _scaleYSpring,
      _scaleY.value,
      1.5,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
  }

  void _releaseUp() {
    if (_reduceMotion) {
      _press.value = 0.0;
      _scaleX.value = 1.0;
      _scaleY.value = 1.0;
      return;
    }
    _press.animateWith(SpringSimulation(
      _pressSpring,
      _press.value,
      0.0,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
    _scaleX.animateWith(SpringSimulation(
      _scaleXSpring,
      _scaleX.value,
      1.0,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
    _scaleY.animateWith(SpringSimulation(
      _scaleYSpring,
      _scaleY.value,
      1.0,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
  }

  void _animateToTarget(double target) {
    if (_landingCheck != null) {
      _fraction.removeListener(_landingCheck!);
      _landingCheck = null;
    }

    if (_reduceMotion) {
      _fraction.value = target;
      _press.value = 0.0;
      _scaleX.value = 1.0;
      _scaleY.value = 1.0;
      return;
    }

    // 1. Bloom the thumb into living liquid glass
    _pressDown();

    // 2. Animate fraction across the track with critically damped spring
    _fraction.animateWith(SpringSimulation(
      _valueSpring,
      _fraction.value,
      target,
      _velocity,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));

    // 3. Monitor landing: when near destination, trigger underdamped release bounce!
    void check() {
      if ((_fraction.value - target).abs() <= 0.035 || !_fraction.isAnimating) {
        if (_landingCheck != null) {
          _fraction.removeListener(_landingCheck!);
          _landingCheck = null;
        }
        _releaseUp();
      }
    }

    _landingCheck = check;
    _fraction.addListener(check);
  }

  void _onPointerDown(PointerDownEvent e) {
    if (!_enabled) return;
    _tapDown = true;
    _dragging = false;
    _lastMove = e.position;
    _lastMoveAt = e.timeStamp;
    _velocity = 0;
    _pressDown();
  }

  void _onPointerMove(PointerMoveEvent e) {
    if (!_enabled || !_tapDown) return;
    final dx = e.position.dx - _lastMove.dx;
    final dt = (e.timeStamp - _lastMoveAt).inMicroseconds / 1e6;
    _lastMove = e.position;
    _lastMoveAt = e.timeStamp;
    if (dx.abs() > 0.4) _dragging = true;
    if (!_dragging || dt <= 0) return;
    final next = (_fraction.value + dx / LiquidToggle.travel).clamp(0.0, 1.0);
    final crossedMid = (_fraction.value - 0.5) * (next - 0.5) < 0;
    _velocity = (next - _fraction.value) / dt;
    _fraction.stop();
    _fraction.value = next;
    if (crossedMid) _haptic();
  }

  void _onPointerUp(PointerEvent e) {
    if (!_enabled || !_tapDown) return;
    _tapDown = false;
    final double target;
    if (_dragging) {
      target = (_velocity.abs() > 200 ? _velocity > 0 : _fraction.value >= 0.5) ? 1.0 : 0.0;
    } else {
      target = widget.value ? 0.0 : 1.0;
      _haptic();
    }
    _animateToTarget(target);
    _dragging = false;
    _velocity = 0;
    final bool nextValue = target == 1.0;
    if (nextValue != widget.value) {
      widget.onChanged?.call(nextValue);
    }
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final on = LiquidToggle.trackOnColor(context);
    final off = LiquidToggle.trackOffColor(brightness);

    return Opacity(
      opacity: _enabled ? 1 : 0.42,
      child: Semantics(
        enabled: _enabled,
        toggled: widget.value,
        button: true,
        child: Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: _onPointerDown,
          onPointerMove: _onPointerMove,
          onPointerUp: _onPointerUp,
          onPointerCancel: _onPointerUp,
          child: RepaintBoundary(
            child: AnimatedBuilder(
              animation: Listenable.merge([_fraction, _press, _scaleX, _scaleY]),
              builder: (context, _) {
                final t = _fraction.value.clamp(0.0, 1.0);
                final press = _press.value.clamp(0.0, 1.0);
                final track = Color.lerp(off, on, t)!;

                // Squash & stretch from drag velocity and underdamped spring scale
                final v = (_velocity / 50).clamp(-0.2, 0.2);
                final scaleX = _scaleX.value / (1.0 - (v * 0.75).clamp(-0.2, 0.2));
                final scaleY = _scaleY.value * (1.0 - (v * 0.25).clamp(-0.2, 0.2));

                final thumbX = LiquidToggle.inset + LiquidToggle.travel * t;

                return SizedBox(
                  width: LiquidToggle.trackWidth,
                  height: LiquidToggle.trackHeight,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Positioned.fill(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: track,
                            borderRadius: BorderRadius.circular(LiquidToggle.trackHeight / 2),
                          ),
                        ),
                      ),
                      Positioned(
                        left: thumbX,
                        top: LiquidToggle.inset,
                        child: Transform(
                          alignment: Alignment.center,
                          transform: Matrix4.diagonal3Values(scaleX, scaleY, 1.0),
                          child: _GlassThumb(
                            width: LiquidToggle.thumbWidth,
                            height: LiquidToggle.thumbHeight,
                            press: press,
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _GlassThumb extends StatefulWidget {
  final double width;
  final double height;
  final double press;

  const _GlassThumb({
    required this.width,
    required this.height,
    required this.press,
  });

  @override
  State<_GlassThumb> createState() => _GlassThumbState();
}

class _GlassThumbState extends State<_GlassThumb> {
  FragmentShader? _lens;

  @override
  void initState() {
    super.initState();
    GlassProgram.ensure().then((program) {
      if (!mounted || program == null) return;
      setState(() => _lens = program.fragmentShader());
    });
  }

  @override
  void dispose() {
    _lens?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final press = widget.press.clamp(0.0, 1.0);
    final radius = BorderRadius.circular(widget.height / 2);
    final lens = _lens;
    final ImageFilter backdrop;
    if (lens != null) {
      // Kyant thumb stack, 1:1: blur(8·(1−p)) then lens(5p, 10p, chromatic)
      lens
        ..setFloat(0, widget.width)
        ..setFloat(1, widget.height)
        ..setFloat(2, widget.height / 2)
        ..setFloat(3, 5 * press)
        ..setFloat(4, 10 * press)
        ..setFloat(5, 1.0);
      backdrop = ImageFilter.shader(lens);
    } else {
      backdrop = ImageFilter.blur(
        sigmaX: 8 * (1 - press),
        sigmaY: 8 * (1 - press),
      );
    }
    return SizedBox(
      width: widget.width,
      height: widget.height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: radius,
          boxShadow: const [
            // Soft ambient drop shadow giving physical floating depth
            BoxShadow(
              color: Color(0x26000000), // 15% black
              blurRadius: 3.5,
              offset: Offset(0, 1.5),
            ),
            // Contact shadow
            BoxShadow(
              color: Color(0x0D000000), // 5% black
              blurRadius: 1,
              offset: Offset(0, 0.5),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: BackdropFilter(
            filter: backdrop,
            child: CustomPaint(
              painter: _ThumbGlassPainter(press: press),
            ),
          ),
        ),
      ),
    );
  }
}

class _ThumbGlassPainter extends CustomPainter {
  final double press;

  _ThumbGlassPainter({required this.press});

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect =
        RRect.fromRectAndRadius(rect, Radius.circular(size.height / 2));

    // Kyant onDrawSurface: 100% pure white at rest (alpha = 1.0),
    // melting smoothly to translucent liquid refraction on press (1.0 - press).
    final surfaceAlpha = (1.0 - press).clamp(0.0, 1.0);
    if (surfaceAlpha > 0.001) {
      canvas.drawRRect(
        rrect,
        Paint()..color = Colors.white.withValues(alpha: surfaceAlpha),
      );
    }

    if (press > 0.02) {
      // 1. Internal convex glass refraction luminosity
      final glowRect = rect.deflate(0.5);
      canvas.drawRRect(
        rrect.deflate(0.5),
        Paint()
          ..shader = RadialGradient(
            center: const Alignment(-0.25, -0.35),
            radius: 0.85,
            colors: [
              Colors.white.withValues(alpha: 0.28 * press),
              Colors.white.withValues(alpha: 0.0),
            ],
          ).createShader(glowRect),
      );

      // 2. Kyant Highlight.Ambient: 45° specular crescent responding to press
      canvas.save();
      canvas.clipRRect(rrect.deflate(0.6));
      canvas.drawArc(
        Rect.fromCenter(
          center: Offset(size.width / 2, size.height / 2),
          width: size.width + 1.0,
          height: size.height + 1.0,
        ),
        0.7853982 - 1.15,
        2.3,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.0
          ..color = Colors.white.withValues(alpha: 0.85 * press),
      );
      canvas.restore();

      // 3. Top-left caustic glint for genuine Apple 3D liquid refraction
      final glintRect = Rect.fromCenter(
        center: Offset(size.width * 0.35, size.height * 0.32),
        width: size.width * 0.32,
        height: size.height * 0.24,
      );
      canvas.drawOval(
        glintRect,
        Paint()
          ..shader = RadialGradient(
            colors: [
              Colors.white.withValues(alpha: 0.65 * press),
              Colors.white.withValues(alpha: 0.0),
            ],
          ).createShader(glintRect),
      );

      // 4. Subtle bottom meniscus absorption for real spherical depth
      final meniscusRect = Rect.fromLTWH(0, size.height * 0.60, size.width, size.height * 0.40);
      canvas.save();
      canvas.clipRRect(rrect);
      canvas.drawRect(
        meniscusRect,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              Colors.transparent,
              Colors.black.withValues(alpha: 0.12 * press),
            ],
          ).createShader(meniscusRect),
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _ThumbGlassPainter old) =>
      old.press != press;
}
