import 'dart:io' as io;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/services.dart';

import 'settings_palette.dart';

/// Capsule liquid-glass switch, after Kyant0/AndroidLiquidGlass `LiquidToggle`
/// and the iOS 26 UISwitch.
///
/// Track 64×28, thumb 40×24, 2pt inset (20pt travel). The thumb is a glass
/// lens: backdrop sampling, refraction, blur, specular rim, press scale,
/// velocity squash. Drag is 1:1; release hands velocity to a spring.
///
/// Exactly one track color exists at a time: the current theme accent, read
/// from [SettingsPalette]. Off-state is the system neutral translucent gray
/// (HIG `#787878`/`#787880` at low alpha). No per-row or per-state custom
/// colors — switching the Zephyr theme recolors every toggle at once.
class LiquidToggle extends StatefulWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;

  const LiquidToggle({
    super.key,
    required this.value,
    required this.onChanged,
  });

  static const double trackWidth = 64;
  static const double trackHeight = 28;
  static const double thumbWidth = 40;
  static const double thumbHeight = 24;
  static const double inset = 2;
  static const double travel = trackWidth - thumbWidth - inset * 2;

  /// On-state track = the active theme accent. Falls back to the iOS system
  /// blue only if the widget is used outside a [SettingsPalette] scope.
  static Color trackOnColor(BuildContext context) =>
      SettingsPalette.maybeOf(context)?.accent ?? Theme.of(context).colorScheme.primary;

  /// Off-state neutral translucent gray, per the Apple HIG system palette.
  static Color trackOffColor(Brightness brightness) => brightness == Brightness.light
      ? const Color(0xFF787878).withValues(alpha: 0.22)
      : const Color(0xFF787880).withValues(alpha: 0.36);

  /// RuntimeShader lens refraction needs Impeller; on Android that is the
  /// default from API 29 up (and the AGP builds here target 36). Everywhere
  /// else, or when shader compilation fails, the painter fallback below still
  /// renders blur + specular rim + chromatic fringe.
  static bool get supportsRuntimeLens =>
      !kIsWeb && (io.Platform.isAndroid || io.Platform.isIOS);

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

  ui.FragmentProgram? _lensProgram;
  bool _lensTried = false;

  bool get _enabled => widget.onChanged != null;

  @override
  void initState() {
    super.initState();
    _fraction = AnimationController.unbounded(
      vsync: this,
      value: widget.value ? 1 : 0,
    )..addListener(() => setState(() {}));
    _press = AnimationController.unbounded(vsync: this, value: 0)
      ..addListener(() => setState(() {}));
    _loadLens();
  }

  Future<void> _loadLens() async {
    if (!LiquidToggle.supportsRuntimeLens) return;
    try {
      final program = await ui.FragmentProgram.fromAsset(
        'shaders/glass_lens.frag',
      );
      if (mounted) setState(() => _lensProgram = program);
    } catch (_) {
      // Keep the painter fallback; a missing/failed shader must never break
      // the control.
    } finally {
      _lensTried = true;
    }
  }

  @override
  void didUpdateWidget(covariant LiquidToggle oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value && !_dragging) {
      _animateFraction(widget.value ? 1 : 0);
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

  void _animateFraction(double target, {double velocity = 0}) {
    if (_reduceMotion) {
      _fraction.value = target;
      return;
    }
    _fraction.animateWith(SpringSimulation(
      _settleSpring,
      _fraction.value,
      target,
      velocity,
      tolerance: const Tolerance(distance: 0.001, velocity: 0.001),
    ));
  }

  void _animatePress(double target) {
    if (_reduceMotion) {
      _press.value = target;
      return;
    }
    _press.animateWith(SpringSimulation(
      target > 0.5 ? _pressSpring : _settleSpring,
      _press.value,
      0,
    ));
  }

  static final _settleSpring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 220,
    ratio: 1.0,
  );
  static final _pressSpring = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 420,
    ratio: 0.86,
  );

  void _onPointerDown(PointerDownEvent e) {
    if (!_enabled) return;
    _dragging = false;
    _lastMove = e.position;
    _lastMoveAt = e.timeStamp;
    _velocity = 0;
    _animatePress(1);
  }

  void _onPointerMove(PointerMoveEvent e) {
    if (!_enabled) return;
    final dx = e.position.dx - _lastMove.dx;
    final dt = (e.timeStamp - _lastMoveAt).inMicroseconds / 1e6;
    _lastMove = e.position;
    _lastMoveAt = e.timeStamp;
    if (dx.abs() > 0.4) _dragging = true;
    if (!_dragging || dt <= 0) return;
    final logical = dx / LiquidToggle.travel;
    final next = (_fraction.value + logical).clamp(0.0, 1.0);
    _velocity = (next - _fraction.value) / dt;
    _fraction.stop();
    _fraction.value = next;
  }

  void _onPointerUp(PointerEvent e) {
    if (!_enabled) return;
    _animatePress(0);
    if (_dragging) {
      final goingOn = _velocity.abs() > 1.2 ? _velocity > 0 : _fraction.value >= 0.5;
      _commit(goingOn);
    } else {
      _commit(!widget.value);
    }
    _dragging = false;
  }

  void _commit(bool next) {
    _animateFraction(next ? 1 : 0, velocity: _velocity);
    if (next != widget.value) {
      HapticFeedback.lightImpact();
      widget.onChanged?.call(next);
    }
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final on = LiquidToggle.trackOnColor(context);
    final off = LiquidToggle.trackOffColor(brightness);
    final t = _fraction.value.clamp(0.0, 1.0);
    final press = _press.value.clamp(0.0, 1.0);
    final track = Color.lerp(off, on, t)!;
    final thumbX = LiquidToggle.inset + LiquidToggle.travel * t;
    final scale = 1.0 + 0.22 * press;
    final v = (_velocity / 8).clamp(-0.18, 0.18);
    final scaleX = scale * (1 - v * 0.55);
    final scaleY = scale * (1 + v.abs() * 0.22);

    return Opacity(
      opacity: _enabled ? 1 : 0.42,
      child: Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: _onPointerDown,
        onPointerMove: _onPointerMove,
        onPointerUp: _onPointerUp,
        onPointerCancel: _onPointerUp,
        child: Semantics(
          enabled: _enabled,
          toggled: widget.value,
          button: true,
          child: SizedBox(
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
                  child: Transform.scale(
                    scaleX: scaleX,
                    scaleY: scaleY,
                    child: _GlassThumb(
                      press: press,
                      brightness: brightness,
                      lensProgram: _lensTried ? _lensProgram : null,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GlassThumb extends StatelessWidget {
  final double press;
  final Brightness brightness;
  final ui.FragmentProgram? lensProgram;

  const _GlassThumb({
    required this.press,
    required this.brightness,
    required this.lensProgram,
  });

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(LiquidToggle.thumbHeight / 2);
    final lens = lensProgram;
    return SizedBox(
      width: LiquidToggle.thumbWidth,
      height: LiquidToggle.thumbHeight,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: radius,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.10 + 0.08 * press),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: BackdropFilter(
            filter: lens != null
                ? ui.ImageFilter.shader(
                    lens.fragmentShader()
                      ..setFloat(0, LiquidToggle.thumbWidth)
                      ..setFloat(1, LiquidToggle.thumbHeight)
                      ..setFloat(2, LiquidToggle.thumbHeight / 2)
                      // Refraction depth/amount mirror Kyant's lens(): a 6dp
                      // rim band bending 9dp inward, easing off on press.
                      ..setFloat(3, 6.0 * (1 - 0.35 * press))
                      ..setFloat(4, 9.0 * (1 - 0.35 * press))
                      // Slight green-blue / magenta fringe on the rim, like
                      // chromaticAberration = true.
                      ..setFloat(5, 0.75 + 0.55 * press),
                  )
                : ui.ImageFilter.blur(
                    sigmaX: 10 * (1 - 0.35 * press),
                    sigmaY: 10 * (1 - 0.35 * press),
                  ),
            child: CustomPaint(
              painter: _GlassPainter(press: press, brightness: brightness),
            ),
          ),
        ),
      ),
    );
  }
}

class _GlassPainter extends CustomPainter {
  final double press;
  final Brightness brightness;
  _GlassPainter({required this.press, required this.brightness});

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final rrect = RRect.fromRectAndRadius(rect, Radius.circular(size.height / 2));
    final fill = brightness == Brightness.dark
        ? Color.lerp(const Color(0xFFF2F2F7).withValues(alpha: 0.92), Colors.white.withValues(alpha: 0.55), press)!
        : Color.lerp(Colors.white.withValues(alpha: 0.94), Colors.white.withValues(alpha: 0.62), press)!;
    canvas.drawRRect(rrect, Paint()..color = fill);

    final highlight = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.center,
        colors: [
          Colors.white.withValues(alpha: 0.72 + 0.2 * press),
          Colors.white.withValues(alpha: 0.0),
        ],
      ).createShader(rect);
    canvas.drawRRect(rrect, highlight);

    canvas.drawRRect(
      rrect.deflate(0.6),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.8
        ..color = Colors.white.withValues(alpha: 0.55 + 0.25 * press),
    );

    if (press > 0.04) {
      final shift = 1.1 * press;
      canvas.drawRRect(
        rrect.shift(Offset(-shift, 0)).deflate(0.4),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.1
          ..color = const Color(0xFF5AC8FA).withValues(alpha: 0.28 * press),
      );
      canvas.drawRRect(
        rrect.shift(Offset(shift, 0)).deflate(0.4),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.1
          ..color = const Color(0xFFFF375F).withValues(alpha: 0.22 * press),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _GlassPainter old) =>
      old.press != press || old.brightness != brightness;
}
