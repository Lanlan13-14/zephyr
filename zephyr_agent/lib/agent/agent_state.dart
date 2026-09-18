// Agent state machine and configuration models.

import '../i18n/agent_strings.dart';

enum AgentStatus {
  idle,
  connecting,
  authenticating,
  online,
  reconnecting,
  stopped,
  error;

  String get label => AgentStrings.system.statusLabel(name);

  bool get isActive => this == online || this == connecting || this == authenticating || this == reconnecting;
}

class AgentConfig {
  String serverUrl;
  String token;
  String deviceName;
  /// One enrollment-issued device access credential (preferred auth path).
  String? accessCredential;
  String? refreshCredential;
  int? accessExpiresAt;
  /// ML-KEM-768 public key + seed from the embedded Go runtime.
  String? mlkemPublicKey;
  String? mlkemSeed;
  String? sharedDirectoryPath;
  String? sharedDirectoryName;
  bool readOnly;
  bool autoShutdown;
  int autoShutdownMinutes;
  bool allowBadCertificates;
  /// Advertise this Agent as an optional SSH/SFTP bastion candidate.
  /// Disabled by default; enabling never changes the file-share ACL.
  bool bastionEnabled;
  /// Android Keystore public signing JWK, persisted after first generation.
  String? linkSigningJwk;
  String? linkDeviceId;

  AgentConfig({
    this.serverUrl = '',
    this.token = '',
    this.deviceName = 'My Device',
    this.accessCredential,
    this.refreshCredential,
    this.accessExpiresAt,
    this.mlkemPublicKey,
    this.mlkemSeed,
    this.sharedDirectoryPath,
    this.sharedDirectoryName,
    this.readOnly = true,
    this.autoShutdown = true,
    this.autoShutdownMinutes = 10,
    this.allowBadCertificates = true,
    this.bastionEnabled = false,
    this.linkSigningJwk,
    this.linkDeviceId,
  });

  Map<String, dynamic> toJson() => {
    'serverUrl': serverUrl,
    'token': token,
    'deviceName': deviceName,
    'accessCredential': accessCredential,
    'refreshCredential': refreshCredential,
    'accessExpiresAt': accessExpiresAt,
    'mlkemPublicKey': mlkemPublicKey,
    'mlkemSeed': mlkemSeed,
    'sharedDirectoryPath': sharedDirectoryPath,
    'sharedDirectoryName': sharedDirectoryName,
    'readOnly': readOnly,
    'autoShutdown': autoShutdown,
    'autoShutdownMinutes': autoShutdownMinutes,
    'allowBadCertificates': allowBadCertificates,
    'bastionEnabled': bastionEnabled,
    'linkSigningJwk': linkSigningJwk,
    'linkDeviceId': linkDeviceId,
  };

  factory AgentConfig.fromJson(Map<String, dynamic> json) => AgentConfig(
    serverUrl: json['serverUrl'] as String? ?? '',
    token: json['token'] as String? ?? '',
    deviceName: json['deviceName'] as String? ?? 'My Device',
    accessCredential: json['accessCredential'] as String?,
    refreshCredential: json['refreshCredential'] as String?,
    accessExpiresAt: (json['accessExpiresAt'] as num?)?.toInt(),
    mlkemPublicKey: json['mlkemPublicKey'] as String?,
    mlkemSeed: json['mlkemSeed'] as String?,
    sharedDirectoryPath: json['sharedDirectoryPath'] as String?,
    sharedDirectoryName: json['sharedDirectoryName'] as String?,
    readOnly: json['readOnly'] as bool? ?? true,
    autoShutdown: json['autoShutdown'] as bool? ?? true,
    autoShutdownMinutes: json['autoShutdownMinutes'] as int? ?? 10,
    allowBadCertificates: json['allowBadCertificates'] as bool? ?? true,
    bastionEnabled: json['bastionEnabled'] as bool? ?? false,
    linkSigningJwk: json['linkSigningJwk'] as String?,
    linkDeviceId: json['linkDeviceId'] as String?,
  );
}
