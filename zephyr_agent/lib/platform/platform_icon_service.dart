import 'dart:io' as io;
import 'package:flutter/services.dart';
import '../theme/zephyr_colors.dart';

class PlatformIconService {
  static const MethodChannel _platformChannel = MethodChannel('com.zephyr.agent/platform');
  static const MethodChannel _androidChannel = MethodChannel('com.zephyr.agent/saf');

  static Future<void> sync(ZephyrTheme theme) async {
    try {
      if (io.Platform.isAndroid) {
        await _androidChannel.invokeMethod<void>('setLauncherTheme', {'theme': theme.name});
      } else if (io.Platform.isIOS || io.Platform.isMacOS) {
        await _platformChannel.invokeMethod<void>('setIconTheme', {'theme': theme.name});
      } else if (io.Platform.isWindows) {
        await _syncWindows(theme);
      } else if (io.Platform.isLinux) {
        await _syncLinux(theme);
      }
    } catch (_) {
      // Best effort only. App theme switching must never fail because shell icon sync failed.
    }
  }

  static Future<io.File> _writeAssetIcon(ZephyrTheme theme, String extension, String dirPath) async {
    final dir = io.Directory(dirPath);
    await dir.create(recursive: true);
    final file = io.File('${dir.path}${io.Platform.pathSeparator}zephyr-agent-${theme.name}.$extension');
    final data = await rootBundle.load('assets/icons/zephyr-agent-${theme.name}.$extension');
    await file.writeAsBytes(data.buffer.asUint8List(), flush: true);
    return file;
  }

  static String _homeDir() => io.Platform.environment['HOME'] ?? io.Platform.environment['USERPROFILE'] ?? '.';

  static Future<void> _syncWindows(ZephyrTheme theme) async {
    final appData = io.Platform.environment['APPDATA'] ?? '${_homeDir()}\\AppData\\Roaming';
    final icon = await _writeAssetIcon(theme, 'ico', '$appData\\Zephyr Agent\\icons');
    final escaped = icon.path.replaceAll("'", "''");
    final script = r'''
$icon = '__ICON__'
$paths = @(
  "$env:USERPROFILE\Desktop\Zephyr Agent.lnk",
  "$env:PUBLIC\Desktop\Zephyr Agent.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Zephyr Agent.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Zephyr Agent\Zephyr Agent.lnk"
)
$wsh = New-Object -ComObject WScript.Shell
foreach ($p in $paths) {
  if (Test-Path $p) {
    $s = $wsh.CreateShortcut($p)
    $s.IconLocation = "$icon,0"
    $s.Save()
  }
}
try { ie4uinit.exe -show | Out-Null } catch {}
'''.replaceAll('__ICON__', escaped);
    await io.Process.run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }

  static Future<void> _syncLinux(ZephyrTheme theme) async {
    final dataHome = io.Platform.environment['XDG_DATA_HOME'] ?? '${_homeDir()}/.local/share';
    final icon = await _writeAssetIcon(theme, 'png', '$dataHome/icons');
    final appDir = io.Directory('$dataHome/applications');
    await appDir.create(recursive: true);
    final desktop = io.File('${appDir.path}/zephyr-agent.desktop');
    final exec = io.Platform.resolvedExecutable.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    await desktop.writeAsString('''[Desktop Entry]\nType=Application\nName=Zephyr Agent\nExec="$exec"\nIcon=${icon.path}\nTerminal=false\nCategories=Network;Utility;\n''', flush: true);
    await io.Process.run('update-desktop-database', [appDir.path]);
  }
}
