import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/agent/host_link_file_runtime.dart';
import 'package:zephyr_agent/agent/link_runtime_factory.dart';
import 'package:zephyr_agent/agent/platform_link_file_runtime.dart';

void main() {
  test('factory picks HostLinkFileRuntime off Android', () {
    final runtime = createLinkFileRuntime();
    if (Platform.isAndroid) {
      expect(runtime, isA<PlatformLinkFileRuntime>());
    } else {
      expect(runtime, isA<HostLinkFileRuntime>());
    }
  });
}
