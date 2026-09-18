import 'dart:io';

import 'host_link_file_runtime.dart';
import 'link_file_runtime.dart';
import 'platform_link_file_runtime.dart';

/// Android signs in Keystore and talks over MethodChannel. Every other
/// platform execs zephyr-link-embed and talks HTTP to 127.0.0.1.
LinkFileRuntime createLinkFileRuntime() {
  if (Platform.isAndroid) return PlatformLinkFileRuntime();
  return HostLinkFileRuntime();
}
