// Local settings persistence using SharedPreferences.

import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../agent/agent_state.dart';
import '../theme/zephyr_colors.dart';

class LocalSettings {
  static const _configKey = 'agent_config';
  static const _themeKey = 'theme_color';

  static Future<AgentConfig> loadConfig() async {
    final prefs = await SharedPreferences.getInstance();
    final json = prefs.getString(_configKey);
    if (json == null) return AgentConfig();
    try {
      return AgentConfig.fromJson(jsonDecode(json));
    } catch (_) {
      return AgentConfig();
    }
  }

  static Future<void> saveConfig(AgentConfig config) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_configKey, jsonEncode(config.toJson()));
  }

  static Future<ZephyrTheme> loadTheme() async {
    final prefs = await SharedPreferences.getInstance();
    final name = prefs.getString(_themeKey) ?? 'frost';
    return ZephyrTheme.values.firstWhere(
      (t) => t.name == name,
      orElse: () => ZephyrTheme.frost,
    );
  }

  static Future<void> saveTheme(ZephyrTheme theme) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_themeKey, theme.name);
  }

  static Future<void> resetAll() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_configKey);
    await prefs.remove(_themeKey);
  }
}
