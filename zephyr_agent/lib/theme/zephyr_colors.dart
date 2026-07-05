// Zephyr theme color definitions — matching zephyr-ssh CSS variables.
import 'package:flutter/material.dart';

enum ZephyrTheme { blue, green, purple, orange }

class ZephyrColors {
  static const Map<ZephyrTheme, Color> primary = {
    ZephyrTheme.blue: Color(0xFF3B82F6),
    ZephyrTheme.green: Color(0xFF10B981),
    ZephyrTheme.purple: Color(0xFF8B5CF6),
    ZephyrTheme.orange: Color(0xFFF97316),
  };

  static const Map<ZephyrTheme, Color> primaryDark = {
    ZephyrTheme.blue: Color(0xFF2563EB),
    ZephyrTheme.green: Color(0xFF059669),
    ZephyrTheme.purple: Color(0xFF7C3AED),
    ZephyrTheme.orange: Color(0xFFEA580C),
  };

  static const Color background = Color(0xFF0F172A);
  static const Color surface = Color(0xFF1E293B);
  static const Color surfaceVariant = Color(0xFF334155);
  static const Color onSurface = Color(0xFFF1F5F9);
  static const Color onSurfaceVariant = Color(0xFF94A3B8);
  static const Color error = Color(0xFFEF4444);
  static const Color success = Color(0xFF22C55E);
  static const Color warning = Color(0xFFEAB308);

  static Color getPrimary(ZephyrTheme theme) => primary[theme] ?? primary[ZephyrTheme.blue]!;
  static Color getPrimaryDark(ZephyrTheme theme) => primaryDark[theme] ?? primaryDark[ZephyrTheme.blue]!;

  static ThemeData buildTheme(ZephyrTheme zTheme) {
    final accent = getPrimary(zTheme);
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorSchemeSeed: accent,
      scaffoldBackgroundColor: background,
      cardTheme: const CardThemeData(
        color: surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(12))),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: background,
        foregroundColor: onSurface,
        elevation: 0,
        centerTitle: true,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surfaceVariant,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide.none,
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: accent,
          side: BorderSide(color: accent.withValues(alpha: 0.5)),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected) ? accent : onSurfaceVariant;
        }),
        trackColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected) ? accent.withValues(alpha: 0.4) : surfaceVariant;
        }),
      ),
    );
  }
}
