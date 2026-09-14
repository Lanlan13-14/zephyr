import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'link_file_runtime.dart';

/// Native adapter for the shared zephyr-link Go runtime.
///
/// The native side must call the existing `/link/dial` and `/link/push` local
/// APIs. It owns the ZSL/2 cryptographic implementation and key proof; Dart
/// only carries structured business data.
class PlatformLinkFileRuntime extends LinkFileRuntime {
  static const _channel = MethodChannel('com.zephyr.agent/link');
  String? _serverUrl;

  Future<String?> signingJwk(String deviceId) async =>
      await _channel.invokeMethod<String>('linkSigningJwk', {'deviceId': deviceId});

  @override
  Future<Map<String, dynamic>> mlkemGenerate(String deviceId) async =>
      Map<String, dynamic>.from(await _channel.invokeMethod<Map<dynamic, dynamic>>('mlkemGenerate', {'deviceId': deviceId}) ?? const {});

  @override
  Future<String> mlkemPublic(String deviceId) async =>
      (await _channel.invokeMethod<String>('mlkemPublic', {'deviceId': deviceId}))!;

  @override
  Future<String> enrollmentProof(String bindId, {required String deviceId, required String userCode, required String sas, required String enrollmentSecret, required String serverId}) async =>
      (await _channel.invokeMethod<String>('enrollmentProof', {'bindId': bindId, 'deviceId': deviceId, 'userCode': userCode, 'sas': sas, 'enrollmentSecret': enrollmentSecret, 'serverId': serverId}))!;

  @override
  Future<bool> connect({required String serverUrl, required String deviceId, bool allowBadCertificates = false}) async {
    final result = await _channel.invokeMethod<Map<dynamic, dynamic>>('linkConnect', {
      'serverUrl': serverUrl,
      'deviceId': deviceId,
      'insecure': allowBadCertificates,
    });
    final sessionId = result?['sessionId'] as String?;
    if (sessionId != null && sessionId.isNotEmpty) {
      markConnected(sessionId);
      _serverUrl = serverUrl;
      return true;
    }
    markDisconnected();
    return false;
  }

  @override
  Future<LinkFileReply> request(String op, Map<String, dynamic> params) async {
    final result = await _channel.invokeMethod<Map<dynamic, dynamic>>('linkFileRequest', {
      'op': op,
      'params': params,
    });
    if (result == null) throw StateError('empty Link file response');
    final body = Map<String, dynamic>.from(result['body'] as Map? ?? const {});
    final raw = body['data'];
    if (body['encoding'] == 'base64' && raw is String) {
      // The Go Link JSON boundary represents []byte as base64.
      final binary = base64Decode(raw);
      final normalized = Map<String, dynamic>.from(body)
        ..remove('data')
        ..remove('encoding');
      return LinkFileReply(normalized, binary: binary);
    }
    return LinkFileReply(body);
  }

  @override
  Future<void> close() async {
    await _channel.invokeMethod<void>('linkClose');
    await super.close();
  }

  /// Boots the bastion tunnel hub inside the embedded Go runtime: it connects
  /// the encrypted /link/stream channel and pumps TCP bytes under ZSL/2.
  Future<void> startTunnel() async {
    final sessionId = this.sessionId;
    if (sessionId == null) throw StateError('Agent Link runtime is not connected');
    await _channel.invokeMethod<void>('linkTunnelStart', {
      'sessionId': sessionId,
      'peerUrl': _serverUrl,
    });
  }
}
