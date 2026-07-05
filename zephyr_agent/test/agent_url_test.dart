import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/agent/agent_controller.dart';

void main() {
  group('AgentController.normalizeServerUrl', () {
    test('adds https scheme to bare hosts', () {
      expect(AgentController.normalizeServerUrl('ssh.example.com'), 'https://ssh.example.com');
      expect(AgentController.normalizeServerUrl('192.168.1.10:3443'), 'https://192.168.1.10:3443');
    });

    test('converts websocket schemes to http schemes for storage', () {
      expect(AgentController.normalizeServerUrl('wss://ssh.example.com/agent/files'), 'https://ssh.example.com');
      expect(AgentController.normalizeServerUrl('ws://127.0.0.1:3443/agent/files'), 'http://127.0.0.1:3443');
    });

    test('trims paths and trailing slashes', () {
      expect(AgentController.normalizeServerUrl('https://ssh.example.com/'), 'https://ssh.example.com');
      expect(AgentController.normalizeServerUrl('https://ssh.example.com/app.html'), 'https://ssh.example.com');
      expect(AgentController.normalizeServerUrl('https://ssh.example.com/base/agent/files'), 'https://ssh.example.com');
    });
  });

  group('AgentController.agentWebSocketUriForServerUrl', () {
    test('builds websocket endpoint from normalized http URLs', () {
      expect(AgentController.agentWebSocketUriForServerUrl('https://ssh.example.com').toString(), 'wss://ssh.example.com/agent/files');
      expect(AgentController.agentWebSocketUriForServerUrl('http://127.0.0.1:3443').toString(), 'ws://127.0.0.1:3443/agent/files');
    });
  });
}
