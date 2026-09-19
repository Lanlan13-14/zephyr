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
  /// When true, wraps the card in a liquid-glass plate. Default is false,
  /// matching Apple HIG Inset Grouped Settings cards (solid surface with
  /// high contrast, no optical distortion over text).
  final bool glass;

  const SettingsGroup({
    super.key,
    this.header,
    this.footer,
    required this.children,
    this.glass = false,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (header != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 7),
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
            context,
            glass: glass,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < children.length; i++) ...[
                  if (i > 0)
                    Padding(
                      padding: const EdgeInsets.only(left: 54),
                      child: Divider(
                        height: 0.5,
                        thickness: 0.5,
                        color: isDark
                            ? Colors.white.withValues(alpha: 0.10)
                            : Colors.black.withValues(alpha: 0.08),
                      ),
                    ),
                  children[i],
                ],
              ],
            ),
          ),
          if (footer != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 7, 16, 0),
              child: Text(
                footer!,
                style: TextStyle(fontSize: 13, height: 1.3, color: palette.textSecondary),
              ),
            ),
        ],
      ),
    );
  }

  Widget _groupPlate(BuildContext context, {required bool glass, required Widget child}) {
    if (glass) {
      return LiquidGlass(
        borderRadius: BorderRadius.circular(12),
        child: child,
      );
    }
    final palette = SettingsPalette.of(context);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(12),
        border: dark
            ? Border.all(color: Colors.white.withValues(alpha: 0.08), width: 0.5)
            : null,
        boxShadow: dark
            ? null
            : [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.04),
                  blurRadius: 10,
                  offset: const Offset(0, 2),
                ),
              ],
      ),
      // Clip.none is load-bearing: (1) LiquidToggle blooms to 1.5× on press
      // and must overflow the 44pt row the way Kyant / glass.mt512 does;
      // (2) Android SystemContextMenu is a PlatformView that inherits the
      // nearest ClipRRect — clipping the card made the text-selection menu
      // paint as a full-viewport gray slab (the 1.0.38 screenshot).
      clipBehavior: Clip.none,
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
  final Color? textColor;
  final bool centerTitle;

  const SettingsRow({
    super.key,
    this.icon,
    this.iconColor,
    required this.title,
    this.detail,
    this.trailing,
    this.onTap,
    this.showChevron = false,
    this.textColor,
    this.centerTitle = false,
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
              textAlign: widget.centerTitle ? TextAlign.center : TextAlign.left,
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w400,
                letterSpacing: -0.41,
                color: widget.textColor ?? palette.text,
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
              width: 96,
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
                textAlign: TextAlign.right,
                minLines: 1,
                maxLines: 1,
                // Android 14+ SystemContextMenu dims the whole Activity.
                // Draw a Flutter capsule toolbar; never ask the OS for one.
                enableInteractiveSelection: true,
                selectionControls: cupertinoTextSelectionHandleControls,
                contextMenuBuilder: (context, editableTextState) {
                  return _AddressSelectionToolbar(editableTextState: editableTextState);
                },
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

/// Flutter-owned selection toolbar. Never a PlatformView, never a dim
/// overlay — the Android 14 SystemContextMenu fog is what this replaces.
class _AddressSelectionToolbar extends StatelessWidget {
  final EditableTextState editableTextState;
  const _AddressSelectionToolbar({required this.editableTextState});

  @override
  Widget build(BuildContext context) {
    final anchors = editableTextState.contextMenuAnchors;
    final palette = SettingsPalette.of(context);
    final items = editableTextState.contextMenuButtonItems;
    if (items.isEmpty) return const SizedBox.shrink();
    return AdaptiveTextSelectionToolbar(
      anchors: anchors,
      children: [
        Material(
          color: Colors.transparent,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: palette.surface,
              borderRadius: BorderRadius.circular(12),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.16),
                  blurRadius: 16,
                  offset: const Offset(0, 6),
                ),
              ],
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < items.length; i++) ...[
                  if (i > 0)
                    Container(width: 0.5, height: 28, color: palette.border.withValues(alpha: 0.45)),
                  _ToolbarButton(item: items[i], color: palette.text),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _ToolbarButton extends StatelessWidget {
  final ContextMenuButtonItem item;
  final Color color;
  const _ToolbarButton({required this.item, required this.color});

  String get _label {
    switch (item.type) {
      case ContextMenuButtonType.copy:
        return 'Copy';
      case ContextMenuButtonType.cut:
        return 'Cut';
      case ContextMenuButtonType.paste:
        return 'Paste';
      case ContextMenuButtonType.selectAll:
        return 'Select All';
      default:
        return item.label ?? '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => item.onPressed?.call(),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        child: Text(
          _label,
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: color),
        ),
      ),
    );
  }
}
