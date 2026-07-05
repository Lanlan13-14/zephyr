import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/zephyr_colors.dart';
import '../agent/agent_controller.dart';
import '../screens/home_screen.dart';
import '../storage/local_settings.dart';

class ZephyrAgentApp extends StatefulWidget {
  const ZephyrAgentApp({super.key});

  @override
  State<ZephyrAgentApp> createState() => _ZephyrAgentAppState();
}

class _ZephyrAgentAppState extends State<ZephyrAgentApp> {
  ZephyrTheme _theme = ZephyrTheme.frost;
  AgentController? _controller;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    final theme = await LocalSettings.loadTheme();
    final config = await LocalSettings.loadConfig();
    setState(() {
      _theme = theme;
      _controller = AgentController(config);
      _loaded = true;
    });
  }

  void _setTheme(ZephyrTheme theme) {
    setState(() => _theme = theme);
    LocalSettings.saveTheme(theme);
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) {
      return MaterialApp(
        theme: ZephyrColors.buildTheme(_theme, Brightness.light),
        darkTheme: ZephyrColors.buildTheme(_theme, Brightness.dark),
        themeMode: ThemeMode.system,
        home: const Scaffold(body: Center(child: CircularProgressIndicator())),
      );
    }

    return ChangeNotifierProvider.value(
      value: _controller!,
      child: MaterialApp(
        title: 'Zephyr Agent',
        debugShowCheckedModeBanner: false,
        theme: ZephyrColors.buildTheme(_theme, Brightness.light),
        darkTheme: ZephyrColors.buildTheme(_theme, Brightness.dark),
        themeMode: ThemeMode.system,
        home: HomeScreen(
          currentTheme: _theme,
          onThemeChanged: _setTheme,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }
}
