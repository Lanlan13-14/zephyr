import 'dart:ui' as ui;

/// Minimal zh/en string table. The bundle follows the system locale
/// (`ui.PlatformDispatcher.instance.locale`): any zh-* language code resolves
/// to Simplified Chinese, everything else falls back to English.
///
/// Strings that ship to another machine (logs, wire payloads, error prefixes
/// surfaced from the Link runtime) stay in their original form; only text the
/// user reads on this device goes through [S].
class AgentStrings {
  final bool zh;
  const AgentStrings._(this.zh);

  static AgentStrings of(ui.Locale? locale) =>
      AgentStrings._(locale?.languageCode.toLowerCase() == 'zh');

  static AgentStrings get system => of(ui.PlatformDispatcher.instance.locale);

  String pick(String zhText, String enText) => zh ? zhText : enText;

  // ── Brand ────────────────────────────────────────────────────────────
  String get appTitle => 'Zephyr Agent';

  // ── Status enum ──────────────────────────────────────────────────────
  // `AgentStatus.name` is passed in, so this layer never imports the state
  // layer (the state layer imports this file for localized labels).
  String statusLabel(String statusName) => switch (statusName) {
        'idle' => pick('未连接', 'Not Connected'),
        'connecting' => pick('连接中…', 'Connecting…'),
        'authenticating' => pick('认证中…', 'Authenticating…'),
        'online' => pick('已连接', 'Connected'),
        'reconnecting' => pick('重连中…', 'Reconnecting…'),
        'stopped' => pick('已停止', 'Stopped'),
        'error' => pick('连接错误', 'Connection Error'),
        _ => statusName,
      };

  // ── Group headers ────────────────────────────────────────────────────
  String get groupStatus => pick('状态', 'Status');
  String get groupServer => pick('主端', 'Server');
  String get groupSharing => pick('共享', 'Sharing');
  String get groupAccess => pick('访问', 'Access');
  String get groupLink => pick('加密通道', 'Encrypted Channel');
  String get groupTransfer => pick('传输', 'Transfers');
  String get groupAppearance => pick('外观', 'Appearance');

  // ── Rows ─────────────────────────────────────────────────────────────
  String get rowAutoShutdown => pick('自动关闭', 'Auto Shutdown');
  String get rowAutoShutdownAccess =>
      pick('开启10分钟后自动关闭', 'Auto shutdown 10 min after start');
  String get rowServerAddress => pick('地址', 'Address');
  String get rowDeviceBinding => pick('设备绑定', 'Device Binding');
  String get rowAllowSelfSigned => pick('允许自签名证书', 'Allow Self-Signed Certificates');
  String get rowSharedDirectory => pick('共享目录', 'Shared Directory');
  String get rowReadOnly => pick('只读', 'Read-Only');
  String get rowBastion => pick('作为跳板机', 'Use as Jump Host');
  String get rowTheme => pick('主题', 'Theme');
  String get linkEstablished => pick('已建立', 'Established');
  String get linkNotEstablished => pick('未建立', 'Not Established');
  String get noDirectorySelected => pick('未选择', 'Not Selected');
  String transferRequests(int count) => pick('$count 次请求', '$count requests');

  // ── Actions ──────────────────────────────────────────────────────────
  String get actionStart => pick('启动连接', 'Start Sharing');
  String get actionStop => pick('停止共享', 'Stop Sharing');
  String extendMinutes(int minutes) =>
      pick('延长 $minutes 分钟', 'Extend by $minutes min');
  String get tooltipReset => pick('重置设置', 'Reset Settings');
  String get tooltipSave => pick('保存设置', 'Save Settings');

  // ── Snacks / feedback ────────────────────────────────────────────────
  String get snackSaved => pick('连接信息已保存', 'Connection settings saved');
  String get snackReset => pick('设置已重置', 'Settings reset');
  String get snackNeedServer => pick('请填写主端地址', 'Enter the server address');
  String get snackNeedBinding =>
      pick('请先绑定设备，或填写旧版 Token 迁移', 'Bind the device first, or enter a legacy token');
  String get snackNeedDirectory => pick('请选择共享目录', 'Choose a shared directory');
  String get snackNeedAllFiles =>
      pick('需要“所有文件访问权限”才能映射整个共享存储', 'All-files access is required to map shared storage');
  String get snackGrantAllFiles =>
      pick('请在系统设置中授予“所有文件访问权限”，返回后再启动连接',
          'Grant “All files access” in system settings, then come back and start');
  String get snackBound => pick('设备绑定成功', 'Device bound');

  // ── Sheets ───────────────────────────────────────────────────────────
  String get sheetShareLocation => pick('共享位置', 'Share Location');
  String get shareEntireStorage => pick('整个共享存储', 'Entire Shared Storage');
  String get sharePickDirectory => pick('选择目录', 'Choose Directory');
  String get shareEnterPath => pick('输入路径', 'Enter Path');
  String get sheetSharedDirectory => pick('共享目录', 'Shared Directory');
  String get fieldPath => pick('路径', 'Path');
  String get actionCancel => pick('取消', 'Cancel');
  String get actionDone => pick('完成', 'Done');
  String get sheetBoundTitle => pick('已绑定', 'Bound');
  String get boundUsesIdentity =>
      pick('使用设备身份，无需 Token', 'Uses the device identity — no token needed');
  String get actionUnbind => pick('解绑', 'Unbind');
  String get sheetWaitingApproval => pick('等待批准', 'Waiting for Approval');
  String get sheetCreatingBinding => pick('创建绑定…', 'Creating Binding…');
  String get sheetBindingResult => pick('绑定结果', 'Binding Result');
  String get bindingDone => pick('绑定完成', 'Binding Complete');
  String get actionWaitBackground => pick('后台等待', 'Wait in Background');
  String get bindingEnterCode =>
      pick('在主端「设备绑定」页面输入以下验证码批准：',
          'Approve on the server’s “Device Binding” page with this code:');
  String get bindingCheckSas =>
      pick('确认安全码一致（防中间人）：', 'Confirm the safety code matches (anti-MITM):');
  String get bindingOpenLink => pick('或打开链接批准：', 'Or open this link to approve:');
  String bindingExpires(int minutes) =>
      pick('$minutes 分钟内有效', 'Valid for $minutes min');
  String get bindingExpiring => pick('即将过期', 'Expiring soon');
  String get closingSoon => pick('即将关闭', 'Closing soon');

  // ── Themes ───────────────────────────────────────────────────────────
  String themeLabel(ZephyrThemeLike theme) => switch (theme) {
        ZephyrThemeLike.frost => pick('凝霜蓝', 'Frost Blue'),
        ZephyrThemeLike.lava => pick('熔岩流', 'Lava Flow'),
        ZephyrThemeLike.asagi => pick('浅葱影', 'Asagi Shade'),
        ZephyrThemeLike.cyber => pick('极夜青', 'Cyber Night'),
      };

  // ── Controller / state layer ─────────────────────────────────────────
  String get enrollmentWaiting => pick('等待主端批准', 'Waiting for server approval');
  String get enrollmentBound => pick('已绑定', 'Bound');
  String get enrollmentFailed => pick('绑定失败', 'Binding Failed');
  String get enrollmentNotBound => pick('未绑定', 'Not Bound');
  String get errorFillServerFirst => pick('请先填写主端地址', 'Enter the server address first');
  String get errorEmptyServerUrl => pick('主端地址为空', 'Server address is empty');
  String get errorCredentialExpired =>
      pick('设备绑定已失效，请重新绑定设备', 'Device binding expired — bind again');
  String autoShutdownNotice(int minutes) =>
      pick('已因开启 $minutes 分钟超时自动关闭共享和跳板机',
          'Sharing and jump host auto-stopped $minutes min after start');
  String get errorAndroidInternet =>
      pick('网络连接被系统拒绝：Android 构建缺 INTERNET 权限或系统网络策略阻止。请安装修复后的新版 Zephyr Agent。',
          'The system rejected the network connection: this Android build lacks INTERNET permission or a system policy blocked it. Install the fixed Zephyr Agent build.');
  String get errorTls =>
      pick('TLS/证书验证失败：请使用受信任 HTTPS 证书，或在主端地址填写正确域名。',
          'TLS/certificate verification failed: use a trusted HTTPS certificate or the correct server domain.');
  String get errorRefused =>
      pick('主端拒绝连接：请确认地址、端口和 Zephyr 服务正在运行。',
          'Connection refused: check the address, port, and that the Zephyr server is running.');
  String get errorDns =>
      pick('域名解析失败：请检查主端地址或 DNS/网络。',
          'DNS lookup failed: check the server address or DNS/network.');
  String get errorTimeout =>
      pick('连接超时：请检查网络、防火墙、反向代理 WebSocket 转发。',
          'Connection timed out: check network, firewall, and reverse-proxy WebSocket forwarding.');
  String get errorLinkRejected => pick('Link 注册被主端拒绝', 'Link registration rejected by the server');
  String get errorLinkDial => pick('Link 拨号未建立会话', 'Link dial did not establish a session');

  // ── Enrollment exceptions ────────────────────────────────────────────
  String enrollmentBadResponse(int statusCode) =>
      pick('主端返回了无法解析的数据 (HTTP $statusCode)',
          'The server returned unparseable data (HTTP $statusCode)');
  String enrollmentNetwork(String message) =>
      pick('无法连接主端：$message', 'Could not reach the server: $message');
  String enrollmentTls(String message) =>
      pick('TLS 握手失败：$message', 'TLS handshake failed: $message');
  String enrollmentHttp(String message) =>
      pick('HTTP 异常：$message', 'HTTP error: $message');
  String get enrollmentMissingIdentity =>
      pick('设备身份未初始化', 'Device identity is not initialized');
  String get enrollmentDenied => pick('绑定请求被拒绝', 'Binding request denied');
  String enrollmentFailedWithStatus(String status) =>
      pick('绑定请求已$status', 'Binding request $status');
  String get enrollmentTimeout =>
      pick('等待批准超时，请重试', 'Timed out waiting for approval — try again');
  String get enrollmentIncompleteCredentials =>
      pick('主端未返回完整凭证', 'The server did not return complete credentials');
  String get enrollmentMissingRefresh =>
      pick('没有可用的刷新凭据，请重新绑定', 'No refresh credential available — bind again');

  // ── Link runtime errors ──────────────────────────────────────────────
  String linkRequestFailed(int statusCode) =>
      pick('Link Runtime 请求失败 ($statusCode)', 'Link runtime request failed ($statusCode)');
  String get linkHandshakeNeedsHost =>
      pick('Link 握手需要宿主签名，但此端已启用持久身份',
          'Link handshake needs a host signature, but this side has a persistent identity');
  String get linkPeerUnset => pick('Link 对端未设置', 'Link peer is not set');
  String get linkEmbedMissing =>
      pick('未找到 zephyr-link-embed，无法建立加密跳板通道',
          'zephyr-link-embed not found — cannot establish the encrypted jump channel');
  String get linkEmbedTimeout => pick('Link Runtime 启动超时', 'Link runtime start timed out');
  String linkEmbedFailed(String line) =>
      pick('Link Runtime 启动失败: $line', 'Link runtime failed to start: $line');
}

/// Mirror of `ZephyrTheme` so this file never imports the theme layer
/// (the theme layer imports this file for localized labels).
enum ZephyrThemeLike { frost, lava, asagi, cyber }
