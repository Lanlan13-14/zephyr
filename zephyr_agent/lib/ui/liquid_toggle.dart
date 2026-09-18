import 'dart:async';
import 'dart:ui';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'settings_palette.dart';

/// Capsule switch restored 1:1 from sdegenaar/liquid_glass_widgets
/// `GlassSwitch` (58×26, 380ms jump, liquid bloom, drag-to-toggle).
///
/// Track on-color is the current theme accent — never a per-row color and
/// never the package's default system green. Off-color is the iOS-exact
/// inactive groove (`#C5C5C6` light / 20% white dark).
///
/// The thumb is a near-clear refractive pill (baseAlpha 0.04 / 0.00) whose
/// visibility comes from the specular rim, not a milk-white fill. A solid
/// white core fades out as the bloom grows, matching GlassSwitch._buildThumb.
class LiquidToggle extends StatefulWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;

  const LiquidToggle({
    super.key,
    required this.value,
    required this.onChanged,
  });

  /// GlassSwitch defaults.
  static const double trackWidth = 58;
  static const double trackHeight = 26;
  static const double inset = 2;

  static Color trackOnColor(BuildContext context) =>
      SettingsPalette.maybeOf(context)?.accent ?? Theme.of(context).colorScheme.primary;

  /// Light: solid opaque grey matching native iOS. Dark: 20% white overlay.
  static Color trackOffColor(Brightness brightness) => brightness == Brightness.dark
      ? const Color(0x33FFFFFF)
      : const Color(0xFFC5C5C6);

  @override
  State<LiquidToggle> createState() => _LiquidToggleState();
}

class _LiquidToggleState extends State<LiquidToggle>
    with TickerProviderStateMixin {
  static const _thumbShadow = Color(0x33000000);

  late final AnimationController _position;
  late final AnimationController _thickness;
  late final Animation<double> _positionAnimation;
  late final Animation<double> _thicknessAnimation;
  late bool _movingForward;

  bool _dragging = false;
  double _dragStartX = 0;
  double _dragStartPosition = 0;
  bool _dragAbandoned = false;
  bool _justEndedDrag = false;
  bool _midpointHaptic = false;
  bool _wasAboveMid = false;

  bool get _enabled => widget.onChanged != null;

  double get _thumbSize => LiquidToggle.trackHeight - 4;
  double get _thumbWidth => _thumbSize * 1.6;
  double get _travel => LiquidToggle.trackWidth - _thumbWidth - 4;

  @override
  void initState() {
    super.initState();
    _position = AnimationController(duration: const Duration(milliseconds: 380), vsync: this);
    _thickness = AnimationController(duration: const Duration(milliseconds: 380), vsync: this);
    _positionAnimation = Tween<double>(begin: 0, end: 1).animate(CurvedAnimation(
      parent: _position,
      curve: Curves.easeInOutCubic,
      reverseCurve: Curves.easeInOutCubic,
    ));
    _thicknessAnimation = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween<double>(begin: 0, end: 1).chain(CurveTween(curve: Curves.easeInOutCubic)),
        weight: 45,
      ),
      TweenSequenceItem(
        tween: Tween<double>(begin: 1, end: 0).chain(CurveTween(curve: Curves.easeInOutQuad)),
        weight: 55,
      ),
    ]).animate(_thickness);
    _movingForward = widget.value;
    if (widget.value) _position.value = 1;
  }

  @override
  void didUpdateWidget(covariant LiquidToggle oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value == oldWidget.value) return;
    if (_dragging) {
      _dragging = false;
      _dragAbandoned = true;
    }
    _movingForward = widget.value;
    if (widget.value) {
      unawaited(_position.forward());
    } else {
      unawaited(_position.reverse());
    }
    final justEnded = _justEndedDrag;
    _justEndedDrag = false;
    if (justEnded) return;
    if (_thickness.value >= 0.99) _thickness.value = 0;
    final dist = widget.value ? (1 - _position.value) : _position.value;
    final ms = (380 * dist).round();
    if (ms > 0) {
      unawaited(_thickness.animateTo(1, duration: Duration(milliseconds: ms), curve: Curves.easeIn));
    } else {
      _thickness.value = 1;
    }
  }

  @override
  void dispose() {
    _position.dispose();
    _thickness.dispose();
    super.dispose();
  }

  bool get _reduceMotion => MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  void _haptic() {
    if (_reduceMotion) return;
    unawaited(HapticFeedback.lightImpact());
  }

  void _onTapDown(TapDownDetails _) {
    if (!_enabled) return;
    if (_thickness.value >= 0.99) _thickness.value = 0;
    _dragAbandoned = false;
    unawaited(_thickness.animateTo(0.45, duration: const Duration(milliseconds: 120), curve: Curves.easeOut));
  }

  void _onTapUp(TapUpDetails _) {
    if (!_enabled) return;
    if (_dragging) return;
    _haptic();
    widget.onChanged!(!widget.value);
  }

  void _onTapCancel() {
    if (!_dragging) unawaited(_thickness.forward(from: _thickness.value));
  }

  void _onDragStart(DragStartDetails d) {
    if (!_enabled) return;
    _position.stop();
    _dragStartX = d.localPosition.dx;
    _dragStartPosition = _position.value;
    _dragAbandoned = false;
    setState(() => _dragging = true);
    _thickness.stop();
    if (_thickness.value >= 0.99) _thickness.value = 0;
    if ((_thickness.value - 0.45).abs() > 0.01) {
      unawaited(_thickness.animateTo(0.45, duration: const Duration(milliseconds: 80)));
    } else {
      _thickness.value = 0.45;
    }
    _midpointHaptic = false;
    _wasAboveMid = _position.value >= 0.5;
  }

  void _onDragUpdate(DragUpdateDetails d) {
    if (!_dragging) return;
    final next = (_dragStartPosition + (d.localPosition.dx - _dragStartX) / _travel).clamp(0.0, 1.0);
    _position.value = next;
    if (!_midpointHaptic) {
      final nowAbove = next >= 0.5;
      if (nowAbove != _wasAboveMid) {
        _haptic();
        _midpointHaptic = true;
      }
      _wasAboveMid = nowAbove;
    }
  }

  void _onDragCancel() {
    setState(() => _dragging = false);
    unawaited(_thickness.forward(from: _thickness.value));
  }

  void _onDragEnd(DragEndDetails d) {
    if (_dragAbandoned) {
      _dragAbandoned = false;
      return;
    }
    if (!_dragging) return;
    final velocity = d.primaryVelocity ?? 0;
    final shouldOn = velocity.abs() > 200 ? velocity > 0 : _position.value >= 0.5;
    _movingForward = shouldOn;
    setState(() => _dragging = false);
    _justEndedDrag = true;
    if (shouldOn) {
      unawaited(_position.forward());
    } else {
      unawaited(_position.reverse());
    }
    unawaited(_thickness.forward(from: _thickness.value));
    if (!_midpointHaptic && shouldOn != widget.value) _haptic();
    _midpointHaptic = false;
    if (shouldOn != widget.value) widget.onChanged!(shouldOn);
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final on = LiquidToggle.trackOnColor(context);
    final off = LiquidToggle.trackOffColor(brightness);
    final dark = brightness == Brightness.dark;

    return Opacity(
      opacity: _enabled ? 1 : 0.42,
      child: Semantics(
        enabled: _enabled,
        toggled: widget.value,
        button: true,
        child: GestureDetector(
          onTapDown: _enabled ? _onTapDown : null,
          onTapUp: _enabled ? _onTapUp : null,
          onTapCancel: _enabled ? _onTapCancel : null,
          onHorizontalDragStart: _enabled ? _onDragStart : null,
          onHorizontalDragUpdate: _enabled ? _onDragUpdate : null,
          onHorizontalDragEnd: _enabled ? _onDragEnd : null,
          onHorizontalDragCancel: _enabled ? _onDragCancel : null,
          child: RepaintBoundary(
            child: AnimatedBuilder(
              animation: Listenable.merge([_position, _thickness]),
              builder: (context, _) {
                final t = _positionAnimation.value.clamp(0.0, 1.0);
                final bloom = _thicknessAnimation.value.clamp(0.0, 1.0);
                final blended = Color.lerp(off, on, t)!;
                final specularTop = Color.lerp(on, CupertinoColors.white, 0.25)!;
                final scale = 1.0 - bloom * 0.08;
                final vExpand = bloom * 10.0;
                final leadStretch = bloom * 16.0;
                final thumbOffset = 2.0 + _travel * t;
                final anchor = _dragging ? leadStretch / 2 : (_movingForward ? 0.0 : leadStretch);
                final thumbLeft = thumbOffset - anchor;

                return SizedBox(
                  width: LiquidToggle.trackWidth,
                  height: LiquidToggle.trackHeight,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Container(
                        width: LiquidToggle.trackWidth,
                        height: LiquidToggle.trackHeight,
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Color.lerp(blended, specularTop, t)!,
                              blended,
                            ],
                          ),
                          borderRadius: BorderRadius.circular(LiquidToggle.trackHeight / 2),
                          boxShadow: t > 0.01
                              ? [
                                  BoxShadow(
                                    color: on.withValues(alpha: 0.35 * t),
                                    blurRadius: 6,
                                    offset: const Offset(0, 1),
                                  ),
                                ]
                              : null,
                        ),
                      ),
                      Positioned(
                        left: thumbLeft,
                        top: 2.0 - vExpand,
                        child: Transform.scale(
                          scale: scale * (1.0 + bloom * 0.1),
                          child: _GlassThumb(
                            size: _thumbSize,
                            bloom: bloom,
                            leadStretch: leadStretch,
                            vExpand: vExpand,
                            anchor: anchor,
                            dark: dark,
                            shadow: _thumbShadow,
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
  final double size;
  final double bloom;
  final double leadStretch;
  final double vExpand;
  final double anchor;
  final bool dark;
  final Color shadow;

  const _GlassThumb({
    required this.size,
    required this.bloom,
    required this.leadStretch,
    required this.vExpand,
    required this.anchor,
    required this.dark,
    required this.shadow,
  });

  @override
  Widget build(BuildContext context) {
    final thumbWidth = size * 1.6;
    final thumbHeight = size;
    final totalWidth = thumbWidth + leadStretch;
    final totalHeight = thumbHeight + vExpand * 2;
    final radius = BorderRadius.circular(totalHeight / 2);
    // GlassSwitch._buildThumb light-mode settings, 1:1:
    //   glassColor alpha 0.12 / 0.08, baseAlpha 0.04 / 0.00,
    //   edgeAlpha 0.28 / 0.15, rim 0.7 / 0.5.
    final body = dark
        ? const Color(0x14FFFFFF) // 0.08 white
        : const Color.fromRGBO(224, 224, 230, 0.12);
    final coreOpacity = (1.0 - bloom * 1.2).clamp(0.0, 1.0);

    return SizedBox(
      width: totalWidth,
      height: totalHeight,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            left: 0,
            top: 0,
            child: ClipRRect(
              borderRadius: radius,
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: dark ? 6 : 8, sigmaY: dark ? 6 : 8),
                child: CustomPaint(
                  size: Size(totalWidth, totalHeight),
                  painter: _ThumbGlassPainter(
                    dark: dark,
                    bloom: bloom,
                    body: body,
                    rimAlpha: dark ? 0.15 : 0.28,
                    rimWidth: dark ? 0.5 : 0.7,
                    ambient: dark ? 0.08 : 0.15,
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            left: anchor,
            top: vExpand,
            child: Opacity(
              opacity: coreOpacity,
              child: Container(
                width: thumbWidth,
                height: thumbHeight,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(thumbHeight / 2),
                  boxShadow: [
                    BoxShadow(
                      color: shadow.withValues(alpha: 0.2 * (1.0 - bloom)),
                      blurRadius: 0,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ThumbGlassPainter extends CustomPainter {
  final bool dark;
  final double bloom;
  final Color body;
  final double rimAlpha;
  final double rimWidth;
  final double ambient;

  _ThumbGlassPainter({
    required this.dark,
    required this.bloom,
    required this.body,
    required this.rimAlpha,
    required this.rimWidth,
    required this.ambient,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(size.height / 2));
    canvas.drawRRect(rrect, Paint()..color = body);

    // Dual-highlight specular (kSpecularPowerPrimary=16 / Kick=20).
    canvas.drawRRect(
      rrect.deflate(rimWidth * 0.4),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = rimWidth
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Colors.white.withValues(alpha: rimAlpha + ambient + 0.20 * bloom),
            Colors.white.withValues(alpha: ambient),
            const Color(0xFF5AC8FA).withValues(alpha: 0.10 * bloom),
          ],
        ).createShader(Offset.zero & size),
    );

    canvas.save();
    canvas.clipRRect(rrect.deflate(1.0));
    canvas.drawRRect(
      rrect,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: const Alignment(0, -0.15),
          colors: [
            Colors.white.withValues(alpha: dark ? 0.22 : 0.45),
            Colors.white.withValues(alpha: 0.0),
          ],
        ).createShader(Offset.zero & size),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _ThumbGlassPainter old) =>
      old.bloom != bloom || old.dark != dark || old.body != body;
}
