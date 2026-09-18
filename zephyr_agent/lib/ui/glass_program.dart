import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

/// Single owner of the compiled Kyant-port refraction shader.
/// Loads lazily, caches forever, never throws into widget builds.
class GlassProgram {
  GlassProgram._();
  static ui.FragmentProgram? _program;
  static Future<ui.FragmentProgram>? _inflight;

  static bool get isReady => _program != null;

  static Future<ui.FragmentProgram?> ensure() async {
    final hit = _program;
    if (hit != null) return hit;
    var f = _inflight;
    if (f == null) {
      f = ui.FragmentProgram.fromAsset('shaders/glass_lens.frag');
      _inflight = f;
    }
    try {
      final program = await f;
      _program = program;
      return program;
    } catch (e) {
      debugPrint('glass lens shader failed to load: $e');
      return null;
    } finally {
      _inflight = null;
    }
  }
}
