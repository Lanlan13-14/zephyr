// One-style device enrollment for Zephyr Agent.
//
// Protocol (shared with Zephyr One, no Client Token involved):
//   POST /api/link/v2/enrollments            → pending bind, userCode + SAS
//   GET  /api/link/v2/enrollments/:bindId    → poll until approved
//   POST /api/link/v2/enrollments/:bindId/consume → credentials + proof
//   POST /api/mobile/v1/devices/refresh     → rotate access credential
//
// The ES256 proof is signed by the platform host (Android Keystore / desktop
// keychain); the ML-KEM-768 seed stays in the host's embedded Go runtime and
// never crosses the channel boundary.

import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import 'agent_state.dart';
import 'platform_link_file_runtime.dart';

class EnrollmentException implements Exception {
  final String code;
  final String message;
  const EnrollmentException(this.code, this.message);

  @override
  String toString() => code == 'network' ? message : '[$code] $message';
}

/// One bind attempt shown in the UI while waiting for main-end approval.
class EnrollmentInfo {
  final String bindId;
  final String userCode;
  final String sas;
  final String verificationUri;
  final String? serverId;
  final String? qrDataUrl;
  final String enrollmentSecret;
  final int expiresAt;

  const EnrollmentInfo({
    required this.bindId,
    required this.userCode,
    required this.sas,
    required this.verificationUri,
    required this.enrollmentSecret,
    required this.expiresAt,
    this.serverId,
    this.qrDataUrl,
  });
}

class EnrollmentClient {
  final PlatformLinkFileRuntime _runtime;
  bool _allowBadCertificates = false;

  EnrollmentClient(this._runtime);

  static Uri _base(String serverUrl) => Uri.parse(serverUrl);

  static String _hostPlatform() {
    if (io.Platform.isAndroid) return 'android';
    if (io.Platform.isIOS) return 'ios';
    if (io.Platform.isMacOS) return 'agent-macos';
    if (io.Platform.isWindows) return 'agent-windows';
    if (io.Platform.isLinux) return 'agent-linux';
    return 'agent';
  }

  io.HttpClient _client() {
    final client = io.HttpClient();
    if (_allowBadCertificates) {
      client.badCertificateCallback = (_, __, ___) => true;
    }
    return client;
  }

  Map<String, dynamic> _errorFrom(Map<String, dynamic> body, String fallback) {
    final error = body['error'];
    if (error is Map<String, dynamic>) {
      return {
        'code': error['code'] ?? 'unknown',
        'message': error['message'] ?? fallback,
      };
    }
    return {'code': 'unknown', 'message': fallback};
  }

  Future<Map<String, dynamic>> _request(String method, Uri uri, {Map<String, dynamic>? body}) async {
    final client = _client();
    try {
      final request = await client.openUrl(method, uri);
      request.headers.set(io.HttpHeaders.contentTypeHeader, 'application/json');
      request.followRedirects = true;
      if (body != null) request.write(jsonEncode(body));
      final response = await request.close();
      final text = await response.transform(utf8.decoder).join();
      Map<String, dynamic> decoded;
      try {
        decoded = jsonDecode(text) is Map<String, dynamic> ? jsonDecode(text) : <String, dynamic>{};
      } catch (_) {
        throw EnrollmentException('bad_response', '主端返回了无法解析的数据 (HTTP ${response.statusCode})');
      }
      if (response.statusCode >= 200 && response.statusCode < 300 && decoded['ok'] == true) {
        return decoded;
      }
      final err = _errorFrom(decoded, 'HTTP ${response.statusCode}');
      throw EnrollmentException(err['code'] as String, err['message'] as String);
    } on io.SocketException catch (e) {
      throw EnrollmentException('network', '无法连接主端：${e.message}');
    } on io.HandshakeException catch (e) {
      throw EnrollmentException('network', 'TLS 握手失败：${e.message}');
    } on io.HttpException catch (e) {
      throw EnrollmentException('network', 'HTTP 异常：${e.message}');
    } finally {
      client.close(force: true);
    }
  }

  /// Creates a pending enrollment. Requires the config to already carry
  /// deviceId + signing JWK + ML-KEM public key; generates them when absent.
  Future<EnrollmentInfo> create(AgentConfig config) async {
    _allowBadCertificates = config.allowBadCertificates;
    if (config.linkDeviceId == null || config.linkDeviceId!.length < 16) {
      throw EnrollmentException('missing_identity', '设备身份未初始化');
    }
    config.linkSigningJwk ??= await _runtime.signingJwk(config.linkDeviceId!);
    if (config.mlkemPublicKey == null || config.mlkemPublicKey!.isEmpty) {
      final kem = await _runtime.mlkemGenerate(config.linkDeviceId!);
      config.mlkemPublicKey = kem['publicKey'];
      config.mlkemSeed = kem['seed'];
    }
    final r = await _request('POST', _base(config.serverUrl).replace(path: '/api/link/v2/enrollments'), body: {
      'deviceId': config.linkDeviceId,
      'deviceName': config.deviceName,
      'platform': _hostPlatform(),
      'appVersion': 'agent',
      'keys': {
        'encryption': {'alg': 'ML-KEM-768', 'publicKey': config.mlkemPublicKey},
        'signing': {'alg': 'ES256', 'jwk': jsonDecode(config.linkSigningJwk!)},
      },
    });
    final info = EnrollmentInfo(
      bindId: r['bindId'] as String,
      userCode: r['userCode'] as String,
      sas: r['sas'] as String,
      verificationUri: r['verificationUri'] as String? ?? '',
      enrollmentSecret: r['enrollmentSecret'] as String,
      expiresAt: (r['expiresAt'] as num?)?.toInt() ?? 0,
      serverId: r['serverId'] as String?,
      qrDataUrl: r['qrDataUrl'] as String?,
    );
    return info;
  }

  /// Polls the bind status until the main end approves, denies, or it expires.
  /// Returns 'approved' on success; throws with the server's code otherwise.
  Future<String> waitUntilApproved(AgentConfig config, EnrollmentInfo info,
      {Duration timeout = const Duration(minutes: 10)}) async {
    _allowBadCertificates = config.allowBadCertificates;
    final uri = _base(config.serverUrl).replace(
      path: '/api/link/v2/enrollments/${info.bindId}',
      queryParameters: {'userCode': info.userCode},
    );
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      final r = await _request('GET', uri);
      final status = r['status'] as String? ?? '';
      if (status == 'approved') return 'approved';
      if (status == 'denied') {
        throw EnrollmentException('enrollment_denied', '绑定请求被拒绝');
      }
      if (status == 'expired' || status == 'consumed') {
        throw EnrollmentException('enrollment_$status', '绑定请求已$status');
      }
      await Future<void>.delayed(const Duration(seconds: 2));
    }
    throw EnrollmentException('enrollment_timeout', '等待批准超时，请重试');
  }

  /// Consumes the approved enrollment: proves device ownership and stores
  /// the returned access/refresh credentials on the config.
  Future<void> consume(AgentConfig config, EnrollmentInfo info) async {
    _allowBadCertificates = config.allowBadCertificates;
    final proof = await _runtime.enrollmentProof(
      bindId: info.bindId,
      deviceId: config.linkDeviceId!,
      userCode: info.userCode,
      sas: info.sas,
      enrollmentSecret: info.enrollmentSecret,
      serverId: info.serverId ?? '',
    );
    final r = await _request(
      'POST',
      _base(config.serverUrl).replace(path: '/api/link/v2/enrollments/${info.bindId}/consume'),
      body: {
        'userCode': info.userCode,
        'enrollmentSecret': info.enrollmentSecret,
        'proof': proof,
        'keys': {
          'encryption': {'alg': 'ML-KEM-768', 'publicKey': config.mlkemPublicKey},
          'signing': {'alg': 'ES256', 'jwk': jsonDecode(config.linkSigningJwk!)},
        },
      },
    );
    config.accessCredential = r['accessCredential'] as String?;
    config.accessExpiresAt = (r['accessExpiresAt'] as num?)?.toInt();
    config.refreshCredential = r['refreshCredential'] as String?;
    if (config.accessCredential == null || config.refreshCredential == null) {
      throw EnrollmentException('bad_response', '主端未返回完整凭证');
    }
  }

  /// Rotates the access credential with the single-use refresh credential.
  Future<void> refresh(AgentConfig config) async {
    _allowBadCertificates = config.allowBadCertificates;
    if (config.refreshCredential == null || config.linkDeviceId == null) {
      throw EnrollmentException('missing_credential', '没有可用的刷新凭据，请重新绑定');
    }
    final r = await _request('POST', _base(config.serverUrl).replace(path: '/api/mobile/v1/devices/refresh'), body: {
      'deviceId': config.linkDeviceId,
      'refreshCredential': config.refreshCredential,
    });
    config.accessCredential = r['accessCredential'] as String?;
    config.accessExpiresAt = (r['accessExpiresAt'] as num?)?.toInt();
    config.refreshCredential = r['refreshCredential'] as String?;
    if (config.accessCredential == null || config.refreshCredential == null) {
      throw EnrollmentException('bad_response', '主端未返回完整凭证');
    }
  }

  /// True when the cached access credential is missing or about to expire.
  static bool needsRefresh(AgentConfig config) {
    final expires = config.accessExpiresAt;
    if (config.accessCredential == null || expires == null) return true;
    return expires <= DateTime.now().millisecondsSinceEpoch + 30000;
  }
}