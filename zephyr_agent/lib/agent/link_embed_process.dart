import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// Spawns the bundled `zephyr-link-embed` loopback runtime.
///
/// Same contract as Android's EmbeddedLinkProcess: bind 127.0.0.1:0, print
/// `127.0.0.1:<port>\n` on stdout, die when stdin closes. Identity keys live
/// under [identityDir] so Dial can finish a proof-required handshake without
/// the host signing (Android keeps signing in Keystore and does not use this).
class LinkEmbedProcess {
  LinkEmbedProcess._();
  static final LinkEmbedProcess instance = LinkEmbedProcess._();

  Process? _process;
  String? _baseUrl;
  Future<String>? _starting;

  Future<String> ensureStarted() {
    final live = _process;
    if (_baseUrl != null && live != null) return Future.value(_baseUrl!);
    return _starting ??= _start().whenComplete(() => _starting = null);
  }

  Future<String> _start() async {
    await stop();
    final binary = resolveBinary();
    if (binary == null) {
      throw StateError('未找到 zephyr-link-embed，无法建立加密跳板通道');
    }
    final identity = identityDir();
    await Directory(identity).create(recursive: true);
    final child = await Process.start(
      binary,
      const [],
      workingDirectory: identity,
      environment: {
        ...Platform.environment,
        'ZEPHYR_LINK_IDENTITY_DIR': identity,
        'HOME': identity,
        'TMPDIR': Directory.systemTemp.path,
      },
    );
    child.stderr.transform(utf8.decoder).listen((_) {});
    final line = await child.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .first
        .timeout(const Duration(seconds: 10), onTimeout: () {
      child.kill(ProcessSignal.sigkill);
      throw TimeoutException('Link Runtime 启动超时');
    });
    if (!RegExp(r'^127\.0\.0\.1:[1-9][0-9]{0,4}$').hasMatch(line.trim())) {
      child.kill(ProcessSignal.sigkill);
      throw StateError('Link Runtime 启动失败: $line');
    }
    _process = child;
    unawaited(child.exitCode.then((_) {
      if (identical(_process, child)) {
        _process = null;
        _baseUrl = null;
      }
    }));
    return _baseUrl = 'http://${line.trim()}';
  }

  Future<void> stop() async {
    final child = _process;
    _process = null;
    _baseUrl = null;
    if (child == null) return;
    try {
      await child.stdin.close();
    } catch (_) {}
    try {
      child.kill();
    } catch (_) {}
  }

  static String identityDir() {
    if (Platform.isWindows) {
      final appdata = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
      return p.join(appdata, 'Zephyr Agent', 'link-identity');
    }
    final home = Platform.environment['HOME'] ?? Directory.systemTemp.path;
    if (Platform.isMacOS || Platform.isIOS) {
      return p.join(home, 'Library', 'Application Support', 'Zephyr Agent', 'link-identity');
    }
    return p.join(home, '.local', 'share', 'zephyr-agent', 'link-identity');
  }

  static String? resolveBinary() {
    final override = Platform.environment['ZEPHYR_LINK_EMBED'];
    if (override != null && override.isNotEmpty && File(override).existsSync()) {
      return override;
    }
    final exe = File(Platform.resolvedExecutable);
    final dir = exe.parent.path;
    final name = Platform.isWindows ? 'zephyr-link-embed.exe' : 'zephyr-link-embed';
    for (final candidate in [
      p.join(dir, name),
      p.join(p.dirname(dir), name),
      p.join(p.dirname(p.dirname(dir)), 'Resources', name),
    ]) {
      if (File(candidate).existsSync()) return candidate;
    }
    return null;
  }
}
