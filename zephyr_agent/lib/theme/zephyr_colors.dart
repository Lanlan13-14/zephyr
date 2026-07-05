// Zephyr theme color definitions — aligned with public/style.css palettes.
import 'package:flutter/material.dart';

enum ZephyrTheme {
  frost,
  lava,
  asagi,
  cyber;

  String get label => switch (this) {
    frost => 'Frost',
    lava => 'Lava',
    asagi => 'Asagi',
    cyber => 'Cyber',
  };
}

class ZephyrPalette {
  final Color bg;
  final Color surface;
  final Color border;
  final Color text;
  final Color textSecondary;
  final Color accent;
  final Color accentHover;
  final Color danger;
  final Color success;
  final Color warning;
  final Color iconStart;
  final Color iconMid;
  final Color iconEnd;
  final Color iconDotA;
  final Color iconDotB;

  const ZephyrPalette({
    required this.bg,
    required this.surface,
    required this.border,
    required this.text,
    required this.textSecondary,
    required this.accent,
    required this.accentHover,
    required this.danger,
    required this.success,
    required this.warning,
    required this.iconStart,
    required this.iconMid,
    required this.iconEnd,
    required this.iconDotA,
    required this.iconDotB,
  });
}

class ZephyrColors {
  static const Map<ZephyrTheme, ZephyrPalette> darkPalettes = {
    ZephyrTheme.frost: ZephyrPalette(
      bg: Color(0xFF101114), surface: Color(0xFF1B1C20), border: Color(0xFF303237),
      text: Color(0xFFF4F4F6), textSecondary: Color(0xFF9A9CA3), accent: Color(0xFF0A84FF),
      accentHover: Color(0xFF2997FF), danger: Color(0xFFFF453A), success: Color(0xFF32D74B), warning: Color(0xFFFFD60A),
      iconStart: Color(0xFFEEF2F7), iconMid: Color(0xFFA8B5C3), iconEnd: Color(0xFF6E7B88),
      iconDotA: Color(0xFF0A84FF), iconDotB: Color(0xFF8E99A6),
    ),
    ZephyrTheme.lava: ZephyrPalette(
      bg: Color(0xFF12110F), surface: Color(0xFF1E1C19), border: Color(0xFF36312C),
      text: Color(0xFFF5F2EE), textSecondary: Color(0xFFA39D95), accent: Color(0xFFBF5A1F),
      accentHover: Color(0xFFD06A2C), danger: Color(0xFFFF453A), success: Color(0xFF30D158), warning: Color(0xFFD49328),
      iconStart: Color(0xFFF6D7B4), iconMid: Color(0xFFD89457), iconEnd: Color(0xFF8D4E24),
      iconDotA: Color(0xFFBF5A1F), iconDotB: Color(0xFFA39D95),
    ),
    ZephyrTheme.asagi: ZephyrPalette(
      bg: Color(0xFF0F1414), surface: Color(0xFF1A2020), border: Color(0xFF2D3937),
      text: Color(0xFFEDF3F2), textSecondary: Color(0xFF93A09E), accent: Color(0xFF4D9C8A),
      accentHover: Color(0xFF62AD9B), danger: Color(0xFFFF5A66), success: Color(0xFF36C98F), warning: Color(0xFFD7A446),
      iconStart: Color(0xFFE6F2EF), iconMid: Color(0xFF8FC8BB), iconEnd: Color(0xFF4D9C8A),
      iconDotA: Color(0xFF4D9C8A), iconDotB: Color(0xFF93A09E),
    ),
    ZephyrTheme.cyber: ZephyrPalette(
      bg: Color(0xFF0D1114), surface: Color(0xFF171C20), border: Color(0xFF2D343A),
      text: Color(0xFFEDF2F5), textSecondary: Color(0xFF909AA3), accent: Color(0xFF4F9DA6),
      accentHover: Color(0xFF67B0B8), danger: Color(0xFFFF453A), success: Color(0xFF32D74B), warning: Color(0xFFD7A446),
      iconStart: Color(0xFFE7F5F7), iconMid: Color(0xFF96C8CE), iconEnd: Color(0xFF4F9DA6),
      iconDotA: Color(0xFF4F9DA6), iconDotB: Color(0xFF909AA3),
    ),
  };

  static const Map<ZephyrTheme, ZephyrPalette> lightPalettes = {
    ZephyrTheme.frost: ZephyrPalette(
      bg: Color(0xFFF5F5F7), surface: Color(0xFFFFFFFF), border: Color(0xFFDEDEE3),
      text: Color(0xFF1D1D1F), textSecondary: Color(0xFF6E6E73), accent: Color(0xFF007AFF),
      accentHover: Color(0xFF006BD6), danger: Color(0xFFD70015), success: Color(0xFF248A3D), warning: Color(0xFFB26A00),
      iconStart: Color(0xFFEEF2F7), iconMid: Color(0xFFA8B5C3), iconEnd: Color(0xFF6E7B88),
      iconDotA: Color(0xFF007AFF), iconDotB: Color(0xFF8E99A6),
    ),
    ZephyrTheme.lava: ZephyrPalette(
      bg: Color(0xFFF7F3EF), surface: Color(0xFFFFFFFF), border: Color(0xFFE1D8CF),
      text: Color(0xFF2B241F), textSecondary: Color(0xFF746860), accent: Color(0xFFB85C22),
      accentHover: Color(0xFF9F4E1D), danger: Color(0xFFD70015), success: Color(0xFF248A3D), warning: Color(0xFFA35F00),
      iconStart: Color(0xFFF6D7B4), iconMid: Color(0xFFD89457), iconEnd: Color(0xFF8D4E24),
      iconDotA: Color(0xFFB85C22), iconDotB: Color(0xFF746860),
    ),
    ZephyrTheme.asagi: ZephyrPalette(
      bg: Color(0xFFF3F6F5), surface: Color(0xFFFFFFFF), border: Color(0xFFD8E1DF),
      text: Color(0xFF1F2625), textSecondary: Color(0xFF657270), accent: Color(0xFF3F8F82),
      accentHover: Color(0xFF357A70), danger: Color(0xFFC2414A), success: Color(0xFF248A64), warning: Color(0xFF9A6700),
      iconStart: Color(0xFFE6F2EF), iconMid: Color(0xFF8FC8BB), iconEnd: Color(0xFF3F8F82),
      iconDotA: Color(0xFF3F8F82), iconDotB: Color(0xFF657270),
    ),
    ZephyrTheme.cyber: ZephyrPalette(
      bg: Color(0xFFF3F5F6), surface: Color(0xFFFFFFFF), border: Color(0xFFD7DFE3),
      text: Color(0xFF182025), textSecondary: Color(0xFF5F6B72), accent: Color(0xFF448E96),
      accentHover: Color(0xFF36777E), danger: Color(0xFFD70015), success: Color(0xFF248A3D), warning: Color(0xFFA35F00),
      iconStart: Color(0xFFE7F5F7), iconMid: Color(0xFF96C8CE), iconEnd: Color(0xFF448E96),
      iconDotA: Color(0xFF448E96), iconDotB: Color(0xFF5F6B72),
    ),
  };

  static ZephyrPalette palette(ZephyrTheme theme, Brightness brightness) {
    return brightness == Brightness.dark ? darkPalettes[theme]! : lightPalettes[theme]!;
  }

  static Color getPrimary(ZephyrTheme theme, [Brightness brightness = Brightness.dark]) => palette(theme, brightness).accent;

  static ThemeData buildTheme(ZephyrTheme zTheme, Brightness brightness) {
    final p = palette(zTheme, brightness);
    final isDark = brightness == Brightness.dark;
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: ColorScheme.fromSeed(
        seedColor: p.accent,
        brightness: brightness,
        primary: p.accent,
        secondary: p.accentHover,
        surface: p.surface,
        error: p.danger,
      ),
      scaffoldBackgroundColor: p.bg,
      cardTheme: CardThemeData(
        color: p.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(Radius.circular(14)),
          side: BorderSide(color: p.border),
        ),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: p.bg,
        foregroundColor: p.text,
        elevation: 0,
        centerTitle: true,
      ),
      textTheme: (isDark ? ThemeData.dark() : ThemeData.light()).textTheme.apply(
        bodyColor: p.text,
        displayColor: p.text,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? p.surface : Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: p.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: p.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: p.accent, width: 1.4),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: p.accent,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: p.accent,
          side: BorderSide(color: p.accent.withValues(alpha: 0.52)),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected) ? p.accent : p.textSecondary;
        }),
        trackColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected) ? p.accent.withValues(alpha: 0.36) : p.border;
        }),
      ),
      chipTheme: ChipThemeData(
        selectedColor: p.accent.withValues(alpha: 0.16),
        backgroundColor: p.surface,
        side: BorderSide(color: p.border),
        labelStyle: TextStyle(color: p.text),
      ),
    );
  }
}
