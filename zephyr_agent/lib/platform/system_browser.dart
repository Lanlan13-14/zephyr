import 'dart:io' as io;

import 'package:flutter/services.dart';

/// Opens [url] in the system browser — same path Zephyr One uses for
/// enrollment approval (`Intent.ACTION_VIEW` / `UIApplication.open` /
/// `NSWorkspace.open`). Never embeds a WebView; login, TOTP and Passkey
/// stay in the OS browser.
class SystemBrowser {
  SystemBrowser._();

  static const _android = MethodChannel('com.zephyr.agent/saf');
  static const _apple = MethodChannel('com.zephyr.agent/platform');

  static Future<bool> open(String url) async {
    final uri = Uri.tryParse(url.trim());
    if (uri == null || !(uri.isScheme('https') || uri.isScheme('http'))) {
      return false;
    }
    try {
      if (io.Platform.isAndroid) {
        await _android.invokeMethod<void>('openUrl', {'url': uri.toString()});
        return true;
      }
      if (io.Platform.isIOS || io.Platform.isMacOS) {
        await _apple.invokeMethod<void>('openUrl', {'url': uri.toString()});
        return true;
      }
      if (io.Platform.isWindows) {
        final r = await io.Process.run('cmd', ['/c', 'start', '', uri.toString()]);
        return r.exitCode == 0;
      }
      if (io.Platform.isLinux) {
        final r = await io.Process.run('xdg-open', [uri.toString()]);
        return r.exitCode == 0;
      }
    } catch (_) {
      return false;
    }
    return false;
  }
}
