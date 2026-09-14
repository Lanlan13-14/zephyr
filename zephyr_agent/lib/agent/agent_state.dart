// Agent state machine and configuration models.

enum AgentStatus {
  idle,
  connecting,
  authenticating,
  online,
  reconnecting,
  stopped,
  error;

  String get label => switch (this) {
    idle => '未连接',
    connecting => '连接中...',
    authenticating => '认证中...',
    online => '已连接',
    reconnecting => '重连中...',
    stopped => '已停止',
    error => '连接错误',
  };

  bool get isActive => this == online || this == connecting || this == authenticating || this == reconnecting;
}

class AgentConfig {
  String serverUrl;
  /// Legacy client token. Kept only for migration of old installations.
  String token;
  /// One enrollment-issued short-lived device access credential.
  String? accessCredential;
  String? refreshCredential;
  String? mlkemPublicKey;
  String? mlkemSeed;
  int? accessExpiresAt;
  String deviceName;
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
    this.accessCredential,
    this.refreshCredential,
    this.mlkemPublicKey,
    this.mlkemSeed,
    this.accessExpiresAt,
    this.deviceName = 'My Device',
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
    'accessCredential': accessCredential,
    'refreshCredential': refreshCredential,
    'mlkemPublicKey': mlkemPublicKey,
    'mlkemSeed': mlkemSeed,
    'accessExpiresAt': accessExpiresAt,
    'deviceName': deviceName,
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
    accessCredential: json['accessCredential'] as String?,
    refreshCredential: json['refreshCredential'] as String?,
    mlkemPublicKey: json['mlkemPublicKey'] as String?,
    mlkemSeed: json['mlkemSeed'] as String?,
    accessExpiresAt: (json['accessExpiresAt'] as num?)?.toInt(),
    deviceName: json['deviceName'] as String? ?? 'My Device',
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
