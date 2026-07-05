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
  String token;
  String deviceName;
  String? sharedDirectoryPath;
  String? sharedDirectoryName;
  bool readOnly;
  bool autoShutdown;
  int autoShutdownMinutes;
  bool allowBadCertificates;

  AgentConfig({
    this.serverUrl = '',
    this.token = '',
    this.deviceName = 'My Device',
    this.sharedDirectoryPath,
    this.sharedDirectoryName,
    this.readOnly = true,
    this.autoShutdown = true,
    this.autoShutdownMinutes = 10,
    this.allowBadCertificates = true,
  });

  Map<String, dynamic> toJson() => {
    'serverUrl': serverUrl,
    'token': token,
    'deviceName': deviceName,
    'sharedDirectoryPath': sharedDirectoryPath,
    'sharedDirectoryName': sharedDirectoryName,
    'readOnly': readOnly,
    'autoShutdown': autoShutdown,
    'autoShutdownMinutes': autoShutdownMinutes,
    'allowBadCertificates': allowBadCertificates,
  };

  factory AgentConfig.fromJson(Map<String, dynamic> json) => AgentConfig(
    serverUrl: json['serverUrl'] as String? ?? '',
    token: json['token'] as String? ?? '',
    deviceName: json['deviceName'] as String? ?? 'My Device',
    sharedDirectoryPath: json['sharedDirectoryPath'] as String?,
    sharedDirectoryName: json['sharedDirectoryName'] as String?,
    readOnly: json['readOnly'] as bool? ?? true,
    autoShutdown: json['autoShutdown'] as bool? ?? true,
    autoShutdownMinutes: json['autoShutdownMinutes'] as int? ?? 10,
    allowBadCertificates: json['allowBadCertificates'] as bool? ?? true,
  );
}
