import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'liquid_glass.dart';
import 'liquid_toggle.dart';
import 'settings_palette.dart';

class SettingsGroup extends StatelessWidget {
  final String? header;
  final String? footer;
  final List<Widget> children;
  /// When false, skip the liquid-glass plate — used inside an already-glass
  /// sheet so we don't stack BackdropFilters (the glass-in-glass anti-pattern
  /// called out by liquid_glass_widgets).
  final bool glass;

  const SettingsGroup({
    super.key,
    this.header,
    this.footer,
    required this.children,
    this.glass = true,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (header != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                header!.toUpperCase(),
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w400,
                  letterSpacing: 0.2,
                  color: palette.textSecondary,
                ),
              ),
            ),
          _groupPlate(
            glass: glass,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < children.length; i++) ...[
                  if (i > 0)
                    Padding(
                      padding: const EdgeInsets.only(left: 54),
                      child: Divider(height: 0.5, thickness: 0.5, color: palette.border.withValues(alpha: 0.45)),
                    ),
                  children[i],
                ],
              ],
            ),
          ),
          if (footer != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Text(
                footer!,
                style: TextStyle(fontSize: 13, height: 1.3, color: palette.textSecondary),
              ),
            ),
        ],
      ),
    );
  }

  Widget _groupPlate({required bool glass, required Widget child}) {
    if (!glass) return child;
    return LiquidGlass(
      borderRadius: BorderRadius.circular(12),
      child: child,
    );
  }
}

class SettingsRow extends StatefulWidget {
  final IconData? icon;
  final Color? iconColor;
  final String title;
  final String? detail;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool showChevron;

  const SettingsRow({
    super.key,
    this.icon,
    this.iconColor,
    required this.title,
    this.detail,
    this.trailing,
    this.onTap,
    this.showChevron = false,
  });

  @override
  State<SettingsRow> createState() => _SettingsRowState();
}

class _SettingsRowState extends State<SettingsRow> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    final child = AnimatedContainer(
      duration: const Duration(milliseconds: 90),
      curve: Curves.easeOut,
      color: _pressed ? palette.border.withValues(alpha: 0.45) : Colors.transparent,
      constraints: const BoxConstraints(minHeight: 44),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          if (widget.icon != null) ...[
            Container(
              width: 29,
              height: 29,
              decoration: BoxDecoration(
                color: widget.iconColor ?? palette.accent,
                borderRadius: BorderRadius.circular(7),
              ),
              child: Icon(widget.icon, size: 18, color: Colors.white),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Text(
              widget.title,
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w400,
                letterSpacing: -0.41,
                color: palette.text,
              ),
            ),
          ),
          if (widget.detail != null)
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(
                widget.detail!,
                textAlign: TextAlign.right,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 17, color: palette.textSecondary, letterSpacing: -0.3),
              ),
            ),
          if (widget.trailing != null) widget.trailing!,
          if (widget.showChevron)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Icon(Icons.chevron_right, size: 22, color: palette.textSecondary.withValues(alpha: 0.55)),
            ),
        ],
      ),
    );
    if (widget.onTap == null) return child;
    return Listener(
      onPointerDown: (_) => setState(() => _pressed = true),
      onPointerUp: (_) => setState(() => _pressed = false),
      onPointerCancel: (_) => setState(() => _pressed = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          widget.onTap!();
        },
        child: child,
      ),
    );
  }
}

class SettingsToggleRow extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final bool value;
  final ValueChanged<bool>? onChanged;

  const SettingsToggleRow({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SettingsRow(
      icon: icon,
      iconColor: iconColor,
      title: title,
      trailing: LiquidToggle(
        value: value,
        onChanged: onChanged,
      ),
    );
  }
}

class SettingsFieldRow extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final bool enabled;
  final TextInputType? keyboardType;
  final String? placeholder;

  const SettingsFieldRow({
    super.key,
    required this.label,
    required this.controller,
    required this.enabled,
    this.keyboardType,
    this.placeholder,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    // Tight height is load-bearing. A TextField inside a ListView-hosted
    // Column receives unbounded max height; Material 3's InputDecorator then
    // expands to fill the viewport (the gray slab in 1.0.31). A 44pt iOS
    // settings row never grows past that.
    return SizedBox(
      height: 44,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SizedBox(
              width: 88,
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 17, letterSpacing: -0.41, color: palette.text),
              ),
            ),
            Expanded(
              // CupertinoTextField with an empty BoxDecoration paints no
              // Material fill — the gray slab in 1.0.32 was InputDecorator.
              child: CupertinoTextField(
                controller: controller,
                enabled: enabled,
                keyboardType: keyboardType,
                placeholder: placeholder,
                padding: EdgeInsets.zero,
                decoration: const BoxDecoration(),
                style: TextStyle(fontSize: 17, height: 1.2, letterSpacing: -0.41, color: palette.text),
                placeholderStyle: TextStyle(fontSize: 17, height: 1.2, color: palette.textSecondary.withValues(alpha: 0.7)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
