import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/agent/agent_state.dart';
import 'package:zephyr_agent/i18n/agent_strings.dart';

void main() {
  group('AgentConfig', () {
    test('serialization round-trip', () {
      final config = AgentConfig(
        serverUrl: 'https://example.com',
        token: 'test_token',
        deviceName: 'Test Phone',
        sharedDirectoryPath: '/Downloads',
        readOnly: false,
        autoShutdown: true,
        autoShutdownMinutes: 10,
        allowBadCertificates: false,
      );

      final json = config.toJson();
      final restored = AgentConfig.fromJson(json);

      expect(restored.serverUrl, config.serverUrl);
      expect(restored.token, config.token);
      expect(restored.deviceName, config.deviceName);
      expect(restored.sharedDirectoryPath, config.sharedDirectoryPath);
      expect(restored.readOnly, config.readOnly);
      expect(restored.autoShutdown, config.autoShutdown);
      expect(restored.autoShutdownMinutes, config.autoShutdownMinutes);
      expect(restored.allowBadCertificates, config.allowBadCertificates);
    });

    test('defaults', () {
      final config = AgentConfig();
      expect(config.serverUrl, '');
      expect(config.readOnly, true);
      expect(config.autoShutdown, true);
      expect(config.autoShutdownMinutes, 10);
    });
  });

  group('AgentStatus', () {
    test('labels follow the zh bundle', () {
      final s = AgentStrings.of(const Locale('zh'));
      expect(s.statusLabel(AgentStatus.idle.name), '未连接');
      expect(s.statusLabel(AgentStatus.online.name), '已连接');
      expect(s.statusLabel(AgentStatus.error.name), '连接错误');
      expect(s.statusLabel(AgentStatus.reconnecting.name), '重连中…');
    });

    test('labels follow the en bundle', () {
      final s = AgentStrings.of(const Locale('en'));
      expect(s.statusLabel(AgentStatus.idle.name), 'Not Connected');
      expect(s.statusLabel(AgentStatus.online.name), 'Connected');
      expect(s.statusLabel(AgentStatus.error.name), 'Connection Error');
    });

    test('locale resolution maps zh-* to zh, everything else to en', () {
      expect(AgentStrings.of(const Locale('zh')).zh, isTrue);
      expect(AgentStrings.of(const Locale('zh', 'TW')).zh, isTrue);
      expect(AgentStrings.of(const Locale('en')).zh, isFalse);
      expect(AgentStrings.of(const Locale('ja')).zh, isFalse);
      expect(AgentStrings.of(null).zh, isFalse);
      // The runtime label getter must not throw for either bundle.
      expect(AgentStatus.idle.label, isNotEmpty);
    });

    test('isActive', () {
      expect(AgentStatus.idle.isActive, false);
      expect(AgentStatus.online.isActive, true);
      expect(AgentStatus.connecting.isActive, true);
      expect(AgentStatus.stopped.isActive, false);
    });
  });
}
