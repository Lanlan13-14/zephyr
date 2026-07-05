import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/agent/agent_state.dart';

void main() {
  group('AgentConfig', () {
    test('serialization round-trip', () {
      final config = AgentConfig(
        serverUrl: 'wss://example.com',
        token: 'test_token',
        deviceName: 'Test Phone',
        sharedDirectoryPath: '/Downloads',
        readOnly: false,
        autoShutdown: true,
        autoShutdownMinutes: 10,
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
    test('labels', () {
      expect(AgentStatus.idle.label, '未连接');
      expect(AgentStatus.online.label, '已连接');
      expect(AgentStatus.error.label, '连接错误');
    });

    test('isActive', () {
      expect(AgentStatus.idle.isActive, false);
      expect(AgentStatus.online.isActive, true);
      expect(AgentStatus.connecting.isActive, true);
      expect(AgentStatus.stopped.isActive, false);
    });
  });
}
