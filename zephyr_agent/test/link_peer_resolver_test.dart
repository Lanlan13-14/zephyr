import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/agent/host_link_file_runtime.dart';
import 'package:zephyr_agent/agent/link_peer_resolver.dart';

void main() {
  group('HostLinkFileRuntime.linkPeerRoot', () {
    test('appends /api/link/v2 to a bare server URL', () {
      expect(HostLinkFileRuntime.linkPeerRoot('https://ssh.example.com'),
          'https://ssh.example.com/api/link/v2');
      expect(HostLinkFileRuntime.linkPeerRoot('https://ssh.example.com/'),
          'https://ssh.example.com/api/link/v2');
    });

    test('does not double-append an already-normalized root', () {
      expect(HostLinkFileRuntime.linkPeerRoot('https://ssh.example.com/api/link/v2'),
          'https://ssh.example.com/api/link/v2');
      expect(HostLinkFileRuntime.linkPeerRoot('https://ssh.example.com/api/link/v2/'),
          'https://ssh.example.com/api/link/v2');
    });
  });

  group('resolveLinkPeers', () {
    test('literal IPv4 is a single target with itself as SNI fallback', () async {
      final targets = await resolveLinkPeers('https://192.168.1.10:3443/api/link/v2');
      expect(targets, hasLength(1));
      expect(targets.single.url, 'https://192.168.1.10:3443/api/link/v2');
      expect(targets.single.serverName, '192.168.1.10');
    });

    test('literal IPv6 keeps the host as serverName', () async {
      final targets = await resolveLinkPeers('https://[::1]:3443/api/link/v2');
      expect(targets, hasLength(1));
      expect(targets.single.serverName, '::1');
    });
  });
}
