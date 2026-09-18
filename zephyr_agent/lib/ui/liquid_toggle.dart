import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/services.dart';

import 'settings_palette.dart';

/// Capsule liquid-glass switch, 1:1 after Kyant0/AndroidLiquidGlass
/// `LiquidToggle`.
///
/// 64×28 track, 40×24 glass thumb, 2pt inset, 20pt travel. The thumb is a
/// hollow refractive shell: backdrop sampling + blur(8, press-scaled) +
/// lens(5→10, chromatic) + ambient highlight, over a white surface that
/// fades out on press (alpha 1→0). A 4dp black/5% shadow and a press-gated
/// inner shadow sit underneath. Press scales the whole thumb; drag velocity
/// stretches it. Track stays the track: solid on-color when asked
/// (theme accent), translucent groove when off.
///
/// Kyant's on-track is system green; here it is the single active theme
/// accent so every switch on screen is the same color. Everything else —
/// geometry, glass stack, interaction physics — follows upstream.
class LiquidToggle extends StatefulWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;

  const LiquidToggle({
    super.key,
    required this.value,
    required this.onChanged,
  });

  /// LiquidToggle geometry.
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
  bool _dragging = false;
  Offset _lastMove = Offset.zero;
  Duration _lastMoveAt = Duration.zero;
  double _velocity = 0;
  bool _tapDown = false;

  bool get _enabled => widget.onChanged != null;

  @override
  void initState() {
    super.initState();
    // DampedDragAnimation value spec: spring(1, 1000). Position snaps with a
    // stiff critically-damped spring rather than a fixed-duration tween.
    _fraction = AnimationController.unbounded(
      vsync: this,
      value: widget.value ? 1 : 0,
    )..addListener(() => setState(() {}));
    // pressProgress spec: same spring, drives scale 1→1.5 and the glass stack.
    _press = AnimationController.unbounded(vsync: this, value: 0)
      ..addListener(() => setState(() {}));
  }

  @override
  void didUpdateWidget(covariant LiquidToggle oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value && !_dragging) {
      _animateFraction(widget.value ? 1 : 0);
      _animatePress(widget.value ? 1 : 0);
    }
  }

  @override
  void dispose() {
    _fraction.dispose();
    _press.dispose();
    super.dispose();
  }

  bool get _reduceMotion =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  void _animateFraction(double target) {
    if (_reduceMotion) {
      _fraction.value = target;
      return;
    }
    _fraction.animateWith(SpringSimulation(
      _valueSpring,
      _fraction.value,
      target,
      _velocity,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
  }

  void _animatePress(double target) {
    if (_reduceMotion) {
      _press.value = target;
      return;
    }
    _press.animateWith(SpringSimulation(
      _pressSpring,
      _press.value,
      target,
      0,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
  }

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
  static final _velocitySpring = SpringDescription.withDampingRatio(
    mass: 0.5,
    stiffness: 300,
    ratio: 1.0,
  );

  void _haptic() {
    if (_reduceMotion) return;
    unawaited(HapticFeedback.lightImpact());
  }

  void _onPointerDown(PointerDownEvent e) {
    if (!_enabled) return;
    _tapDown = true;
    _dragging = false;
    _lastMove = e.position;
    _lastMoveAt = e.timeStamp;
    _velocity = 0;
    _animatePress(1);
  }

  void _onPointerMove(PointerMoveEvent e) {
    if (!_enabled || !_tapDown) return;
    final dx = e.position.dx - _lastMove.dx;
    final dt = (e.timeStamp - _lastMoveAt).inMicroseconds / 1e6;
    _lastMove = e.position;
    _lastMoveAt = e.timeStamp;
    if (dx.abs() > 0.4) _dragging = true;
    if (!_dragging || dt <= 0) return;
    final next =
        (_fraction.value + dx / LiquidToggle.travel).clamp(0.0, 1.0);
    final crossedMid = (_fraction.value - 0.5) * (next - 0.5) < 0;
    _velocity = (next - _fraction.value) / dt;
    _fraction.stop();
    _fraction.value = next;
    // iOS ticks once at the 50% mark regardless of direction.
    if (crossedMid) _haptic();
  }

  void _onPointerUp(PointerEvent e) {
    if (!_enabled || !_tapDown) return;
    _tapDown = false;
    _animatePress(0);
    bool next;
    if (_dragging) {
      final v = _velocity;
      _fraction.animateWith(SpringSimulation(
        _velocitySpring,
        _fraction.value,
        _fraction.value,
        v,
        tolerance: const Tolerance(distance: 0.001, velocity: 5),
      ));
      // Allow one frame for velocity spring state, then snap by 50%.
      next = v.abs() > 300 ? v > 0 : _fraction.value >= 0.5;
      _animateFraction(next ? 1 : 0);
    } else {
      next = !widget.value;
      _animateFraction(next ? 1 : 0);
      _haptic();
    }
    _dragging = false;
    _velocity = 0;
    if (next != widget.value) widget.onChanged?.call(next);
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
              animation: _fraction,
              builder: (context, _) {
                // Kyant DampedDragAnimation.value: 0..1 fraction, press drives
                // the glass stack separately below.
                final t = _fraction.value.clamp(0.0, 1.0);
                final press = _press.value.clamp(0.0, 1.0);
                // Kyant track: solid interpolated color. No specular
                // gradient on the track, no accent glow.
                final track = Color.lerp(off, on, t)!;
                // pressedScale 1.5, drag velocity stretches like layerBlock.
                final v = (_velocity / 50).clamp(-0.2, 0.2);
                final scaleX = 1.5 / (1 - (v * 0.75).clamp(-0.2, 0.2));
                final scaleY = 1.5 * (1 - (v * 0.25).clamp(-0.2, 0.2));
                // Kyant graphicsLayer: 2pt inset, translationX lerps
                // padding→padding+travel with t.
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
                          transform: Matrix4.diagonal3Values(scaleX, scaleY, 1),
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

class _GlassThumb extends StatelessWidget {
  final double width;
  final double height;
  final double press;

  const _GlassThumb({
    required this.width,
    required this.height,
    required this.press,
  });

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(height / 2);
    // Kyant onDrawSurface: solid white fading out on press (alpha 1→0).
    final surfaceOpacity = (1 - press).clamp(0.0, 1.0);
    final blurSigma = 8 * (1 - press);
    final refrHeight = 5 * press;
    final refrAmount = 10 * press;
    return SizedBox(
      width: width,
      height: height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: radius,
          boxShadow: const [
            // Upstream is 4dp black at 5%.
            BoxShadow(
              color: Color(0x0D000000),
              blurRadius: 4,
              offset: Offset(0, 0),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
            child: CustomPaint(
              painter: _ThumbGlassPainter(
                press: press,
                surfaceOpacity: surfaceOpacity,
                refrHeight: refrHeight,
                refrAmount: refrAmount,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ThumbGlassPainter extends CustomPainter {
  final double press;
  final double surfaceOpacity;
  final double refrHeight;
  final double refrAmount;

  _ThumbGlassPainter({
    required this.press,
    required this.surfaceOpacity,
    required this.refrHeight,
    required this.refrAmount,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect =
        RRect.fromRectAndRadius(rect, Radius.circular(size.height / 2));
    // Hollow shell: the see-through center is the glass. Surface white
    // fades with press; on press the thumb is almost pure refraction.
    canvas.drawRRect(
      rrect,
      Paint()..color = Colors.white.withValues(alpha: surfaceOpacity),
    );

    // Ambient highlight that grows with press (upstream scales 2/3→0.75 at
    // half width, 0→0.75 blur radius; painter approximation here).
    final ambientAlpha = (0.35 + 0.65 * press).clamp(0.0, 1.0);
    canvas.drawRRect(
      rrect.deflate(0.4),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.75
        ..color = Colors.white.withValues(alpha: 0.75 * ambientAlpha),
    );

    // Inner shadow gated by press.
    if (press > 0.02) {
      canvas.drawRRect(
        rrect.deflate(1.2),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.2 * press.clamp(0.0, 1.0)
          ..color = Colors.black.withValues(alpha: 0.10 * press),
      );
    }

    // Liquid refraction tongue: a thin bent band hugging the rim.
    // Full refraction field lives in the lens shader; the painter draws the
    // visible chromatic edge so the non-shader path still bends light.
    if (refrAmount > 0.05) {
      final band = (refrHeight + 1.5).clamp(0.0, size.height / 2);
      canvas.drawRRect(
        rrect.deflate(size.height / 2 - band),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.2
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              const Color(0xFF5AC8FA).withValues(alpha: 0.30 * press),
              Colors.white.withValues(alpha: 0.10 * press),
              const Color(0xFFFF375F).withValues(alpha: 0.24 * press),
            ],
            stops: const [0.0, 0.5, 1.0],
          ).createShader(rect),
      );
    }

    // Top inner highlight.
    canvas.save();
    canvas.clipRRect(rrect.deflate(0.8));
    canvas.drawRRect(
      rrect,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: const Alignment(0, -0.1),
          colors: [
            Colors.white.withValues(alpha: 0.55 + 0.20 * press),
            Colors.white.withValues(alpha: 0.0),
          ],
        ).createShader(rect),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _ThumbGlassPainter old) =>
      old.press != press ||
      old.surfaceOpacity != surfaceOpacity ||
      old.refrHeight != refrHeight ||
      old.refrAmount != refrAmount;
}
