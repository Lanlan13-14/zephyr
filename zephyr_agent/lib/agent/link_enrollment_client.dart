import 'dart:convert';
import 'dart:io';
import 'dart:async';
import 'package:uuid/uuid.dart';
import 'platform_link_file_runtime.dart';
import '../storage/local_settings.dart';
import 'agent_state.dart';

class EnrollmentInfo {
  final String bindId, userCode, enrollmentSecret, verificationUri, sas, serverId;
  final int expiresAt;
  final String? qrDataUrl;
  const EnrollmentInfo({required this.bindId, required this.userCode, required this.enrollmentSecret, required this.verificationUri, required this.sas, required this.serverId, required this.expiresAt, this.qrDataUrl});
}

class EnrollmentClient {
  final PlatformLinkFileRuntime runtime;
  bool allowBadCertificates = false;
  EnrollmentClient(this.runtime);

  Future<Map<String, dynamic>> _request(String method, Uri uri, [Map<String, dynamic>? body]) async {
    final client = HttpClient()
      ..badCertificateCallback = allowBadCertificates ? (_, __, ___) => true : null;
    try {
      final req = await client.openUrl(method, uri);
      req.headers.contentType = ContentType.json;
      if (body != null) req.write(jsonEncode(body));
      final res = await req.close();
      final text = await res.transform(utf8.decoder).join();
      final parsed = text.isEmpty ? <String, dynamic>{} : jsonDecode(text) as Map<String, dynamic>;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        final e = parsed['error'];
        throw StateError(e is Map ? (e['message'] ?? 'enrollment request failed').toString() : 'enrollment request failed (${res.statusCode})');
      }
      return parsed;
    } finally { client.close(force: true); }
  }

  Uri _api(String server, String path) {
    var s = server.trim();
    if (s.startsWith('ws://')) s = 'http://${s.substring(5)}';
    if (s.startsWith('wss://')) s = 'https://${s.substring(6)}';
    if (!s.contains('://')) s = 'https://$s';
    return Uri.parse(s.replaceAll(RegExp(r'/+$'), '') + path);
  }

  Future<EnrollmentInfo> create(AgentConfig config) async {
    allowBadCertificates = config.allowBadCertificates;
    final deviceId = config.linkDeviceId ??= const Uuid().v4();
    final signing = config.linkSigningJwk ??= await runtime.signingJwk(deviceId);
    if (signing == null) throw StateError('signing key unavailable');
    if (config.mlkemPublicKey == null || config.mlkemSeed == null) {
      final kem = await runtime.mlkemGenerate(deviceId);
      config.mlkemPublicKey = kem['publicKey'] as String?;
      config.mlkemSeed = kem['seed'] as String?;
    }
    final r = await _request('POST', _api(config.serverUrl, '/api/link/v2/enrollments'), {
      'deviceId': deviceId, 'deviceName': config.deviceName, 'platform': Platform.operatingSystem,
      'appVersion': 'agent', 'keys': {'encryption': {'alg': 'ML-KEM-768', 'publicKey': config.mlkemPublicKey}, 'signing': {'alg': 'ES256', 'jwk': jsonDecode(signing)}}
    });
    await LocalSettings.saveConfig(config);
    return EnrollmentInfo(bindId: r['bindId'], userCode: r['userCode'], enrollmentSecret: r['enrollmentSecret'], verificationUri: r['verificationUri'], sas: r['sas'], serverId: r['serverId'], expiresAt: (r['expiresAt'] as num).toInt(), qrDataUrl: r['qrDataUrl']);
  }

  Future<String> waitUntilApproved(AgentConfig config, EnrollmentInfo info, {Duration timeout = const Duration(minutes: 5)}) async {
    allowBadCertificates = config.allowBadCertificates;
    final end = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(end)) {
      final r = await _request('GET', _api(config.serverUrl, '/api/link/v2/enrollments/${Uri.encodeComponent(info.bindId)}?userCode=${Uri.encodeComponent(info.userCode)}'));
      final status = r['status'];
      if (status == 'approved') return status;
      if (status == 'denied' || status == 'expired') throw StateError('enrollment $status');
      await Future<void>.delayed(const Duration(milliseconds: 900));
    }
    throw TimeoutException('enrollment approval timeout');
  }

  Future<void> consume(AgentConfig config, EnrollmentInfo info) async {
    allowBadCertificates = config.allowBadCertificates;
    final proof = await runtime.enrollmentProof(info.bindId, deviceId: config.linkDeviceId!, userCode: info.userCode, sas: info.sas, enrollmentSecret: info.enrollmentSecret, serverId: info.serverId);
    final kem = config.mlkemPublicKey ?? await runtime.mlkemPublic(config.linkDeviceId!);
    final signing = config.linkSigningJwk;
    final r = await _request('POST', _api(config.serverUrl, '/api/link/v2/enrollments/${Uri.encodeComponent(info.bindId)}/consume'), {
      'userCode': info.userCode, 'enrollmentSecret': info.enrollmentSecret, 'proof': proof,
      'keys': {'encryption': {'alg': 'ML-KEM-768', 'publicKey': kem}, 'signing': {'alg': 'ES256', 'jwk': jsonDecode(signing!)}}, 'syncIntervalSec': 300
    });
    config.accessCredential = r['accessCredential'] as String?;
    config.refreshCredential = r['refreshCredential'] as String?;
    config.accessExpiresAt = (r['accessExpiresAt'] as num?)?.toInt();
    await LocalSettings.saveConfig(config);
  }

  Future<void> refresh(AgentConfig config) async {
    allowBadCertificates = config.allowBadCertificates;
    final deviceId = config.linkDeviceId, refresh = config.refreshCredential;
    if (deviceId == null || refresh == null || refresh.isEmpty) throw StateError('device is not enrolled');
    final r = await _request('POST', _api(config.serverUrl, '/api/mobile/v1/devices/refresh'), {'deviceId': deviceId, 'refreshCredential': refresh});
    config.accessCredential = r['accessCredential'] as String?;
    config.refreshCredential = r['refreshCredential'] as String?;
    config.accessExpiresAt = (r['accessExpiresAt'] as num?)?.toInt();
    await LocalSettings.saveConfig(config);
  }
}
