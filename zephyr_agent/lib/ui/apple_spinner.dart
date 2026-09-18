import 'dart:math' as math;

import 'package:flutter/material.dart';

/// iOS-style activity indicator: twelve tapered blades, rotating one blade
/// per tick. Replaces `CircularProgressIndicator` — the Agent UI carries no
/// MD3 progress metaphors.
class AppleSpinner extends StatefulWidget {
  final double radius;
  final Color? color;

  const AppleSpinner({super.key, this.radius = 10, this.color});

  @override
  State<AppleSpinner> createState() => _AppleSpinnerState();
}

class _AppleSpinnerState extends State<AppleSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ??
        (Theme.of(context).brightness == Brightness.dark
            ? const Color(0xFF98989F)
            : const Color(0xFF6C6C70));
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reduce) {
      return CustomPaint(
        size: Size.square(widget.radius * 2),
        painter: _BladePainter(tick: 0, color: color),
      );
    }
    return AnimatedBuilder(
      animation: _controller,
      builder: (_, __) => CustomPaint(
        size: Size.square(widget.radius * 2),
        painter: _BladePainter(
          tick: (_controller.value * 12).floor() % 12,
          color: color,
        ),
      ),
    );
  }
}

class _BladePainter extends CustomPainter {
  final int tick;
  final Color color;
  _BladePainter({required this.tick, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.width / 2;
    for (var i = 0; i < 12; i++) {
      final fade = (12 - ((tick - i) % 12)) / 12;
      final paint = Paint()
        ..color = color.withValues(alpha: 0.18 + 0.82 * fade)
        ..strokeCap = StrokeCap.round
        ..strokeWidth = radius * 0.24;
      final angle = i * math.pi / 6;
      canvas.drawLine(
        center + Offset(math.cos(angle), math.sin(angle)) * radius * 0.52,
        center + Offset(math.cos(angle), math.sin(angle)) * radius * 0.95,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _BladePainter old) =>
      old.tick != tick || old.color != color;
}
