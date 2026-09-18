import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Full-width capsule glass button. Press scales 0.97 with a spring; the
/// fill is a translucent tint over a blur, not a flat Material color.
class GlassPrimaryButton extends StatefulWidget {
  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback? onPressed;

  const GlassPrimaryButton({
    super.key,
    required this.label,
    required this.icon,
    required this.color,
    required this.onPressed,
  });

  @override
  State<GlassPrimaryButton> createState() => _GlassPrimaryButtonState();
}

class _GlassPrimaryButtonState extends State<GlassPrimaryButton> {
  bool _pressed = false;
  bool get _enabled => widget.onPressed != null;

  @override
  Widget build(BuildContext context) {
    final child = AnimatedScale(
      scale: _pressed && _enabled ? 0.97 : 1,
      duration: const Duration(milliseconds: 140),
      curve: Curves.easeOutCubic,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            height: 50,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              color: widget.color.withValues(alpha: _pressed ? 0.78 : 0.88),
              border: Border.all(color: Colors.white.withValues(alpha: 0.28), width: 0.6),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(widget.icon, color: Colors.white, size: 22),
                const SizedBox(width: 8),
                Text(
                  widget.label,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.4,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return Opacity(
      opacity: _enabled ? 1 : 0.42,
      child: Listener(
        onPointerDown: (_) { if (_enabled) setState(() => _pressed = true); },
        onPointerUp: (_) => setState(() => _pressed = false),
        onPointerCancel: (_) => setState(() => _pressed = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: _enabled
              ? () {
                  HapticFeedback.lightImpact();
                  widget.onPressed!();
                }
              : null,
          child: child,
        ),
      ),
    );
  }
}
