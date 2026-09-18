import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../i18n/agent_strings.dart';
import 'link_embed_process.dart';
import 'link_file_runtime.dart';
import 'link_peer_resolver.dart';

/// Link runtime for hosts that exec `zephyr-link-embed` (Linux, Windows,
/// macOS, iOS). Talks HTTP to 127.0.0.1; the Go core owns ZSL/2, ES256, and
/// the bastion stream. Android keeps [PlatformLinkFileRuntime] because it
/// signs in Keystore instead of enabling persistent identity.
class HostLinkFileRuntime extends LinkFileRuntime {
  String? _serverUrl;
  String? _baseUrl;
  final HttpClient _http = HttpClient();

  Future<String> _base() async {
    return _baseUrl ??= await LinkEmbedProcess.instance.ensureStarted();
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body, {Duration? timeout}) async {
    final base = await _base();
    final uri = Uri.parse('$base$path');
    final req = await _http.postUrl(uri);
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode(body)));
    final res = await req.close().timeout(timeout ?? const Duration(seconds: 65));
    final text = await res.transform(utf8.decoder).join();
    Map<String, dynamic> decoded = {};
    if (text.isNotEmpty) {
      final parsed = jsonDecode(text);
      if (parsed is Map<String, dynamic>) decoded = parsed;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final err = decoded['error'];
      final message = err is Map ? (err['message'] as String? ?? text) : (decoded['error'] as String? ?? text);
      throw StateError(message.isEmpty ? AgentStrings.system.linkRequestFailed(res.statusCode) : message);
    }
    return decoded;
  }

  @override
  Future<String?> signingJwk(String deviceId) async {
    final body = await _post('/link/identity/jwk', {'deviceId': deviceId});
    final jwk = body['jwk'];
    if (jwk is Map) return jsonEncode(jwk);
    if (jwk is String && jwk.isNotEmpty) return jwk;
    return null;
  }

  @override
  Future<Map<String, String>> mlkemGenerate(String deviceId) async {
    final body = await _post('/link/mlkem/generate', {'deviceId': deviceId});
    return {
      'publicKey': '${body['publicKey'] ?? ''}',
      'seed': '${body['seed'] ?? ''}',
    };
  }

  @override
  Future<String> enrollmentProof({
    required String bindId,
    required String deviceId,
    required String userCode,
    required String sas,
    required String enrollmentSecret,
    required String serverId,
  }) async {
    final body = await _post('/link/identity/enrollment-proof', {
      'bindId': bindId,
      'deviceId': deviceId,
      'userCode': userCode,
      'sas': sas,
      'enrollmentSecret': enrollmentSecret,
      'serverId': serverId,
    });
    final proof = body['proof'] as String?;
    if (proof == null || proof.isEmpty) throw StateError('enrollment proof empty');
    return proof;
  }

  @override
  Future<bool> connect({required String serverUrl, required String deviceId, bool allowBadCertificates = false}) async {
    final peer = linkPeerRoot(serverUrl);
    final targets = await resolveLinkPeers(peer);
    Object? lastError;
    for (final target in targets) {
      try {
        final body = await _post('/link/dial', {
          'serverUrl': target.url,
          'deviceId': deviceId,
          'insecure': allowBadCertificates,
          'serverName': target.serverName,
        });
        if (body['pending'] == true) {
          throw StateError(AgentStrings.system.linkHandshakeNeedsHost);
        }
        final sessionId = body['sessionId'] as String?;
        if (sessionId == null || sessionId.isEmpty) {
          markDisconnected();
          return false;
        }
        markConnected(sessionId);
        _serverUrl = target.url;
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    markDisconnected();
    if (lastError != null) throw lastError;
    return false;
  }

  @override
  Future<LinkFileReply> request(String op, Map<String, dynamic> params) async {
    if (!ready) throw StateError('Agent Link runtime is not connected');
    final ack = await _post('/link/push', {
      'sessionId': sessionId,
      'peerUrl': _serverUrl,
      'kind': 10,
      'body': {'op': op, 'params': params},
      'secret': false,
    });
    final inner = ack['ack'] is Map<String, dynamic>
        ? Map<String, dynamic>.from(ack['ack'] as Map)
        : ack;
    final raw = inner['data'];
    if (inner['encoding'] == 'base64' && raw is String) {
      final binary = base64Decode(raw);
      inner.remove('data');
      inner.remove('encoding');
      return LinkFileReply(inner, binary: binary);
    }
    return LinkFileReply(inner);
  }

  @override
  Future<void> startTunnel() async {
    final id = sessionId;
    if (id == null) throw StateError('Agent Link runtime is not connected');
    final peer = _serverUrl ?? '';
    if (peer.isEmpty) throw StateError(AgentStrings.system.linkPeerUnset);
    await _post('/link/tunnel/start', {'sessionId': id, 'peerUrl': peer});
  }

  @override
  Future<int> zft2LocalPort() async {
    final base = await _base();
    final uri = Uri.parse(base);
    if (uri.hasPort) return uri.port;
    throw StateError('zft2 local port unavailable');
  }

  @override
  Future<void> close() async {
    markDisconnected();
    _serverUrl = null;
    await super.close();
  }

  static String linkPeerRoot(String serverUrl) {
    final trimmed = serverUrl.trim().replaceFirst(RegExp(r'/+$'), '');
    if (trimmed.isEmpty) return '';
    return trimmed.endsWith('/api/link/v2') ? trimmed : '$trimmed/api/link/v2';
  }
}
