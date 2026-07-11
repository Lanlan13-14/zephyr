# Zephyr Agent — 内嵌 Web 控制台 & 本地设备管理 优化方案

> 文档版本：v1.0  日期：2026-07-09  
> 仓库：https://github.com/Lanlan13-14/zephyr-ssh  
> 本文档为完整实施规划，涵盖架构、数据模型、UI 交互、JS Bridge、平台配置和分阶段交付清单。

---

## 一、目标与现状

### 1.1 现状

| 维度 | 当前状态 |
|------|---------|
| Zephyr Agent | Flutter 应用，功能单一：配置 WebSocket 连接 + 共享本地目录给 RDP |
| Zephyr Web UI | 运行在 Node.js 服务端，需要用户手动在系统浏览器打开 `https://<host>` |
| 本地设备 | 无概念，全部连接由 Web 前端发起，存储在服务端数据库 |
| 离线/内网 | Web 可以访问内网地址，但依赖系统浏览器，无法注入本地权限 |

### 1.2 目标

1. **内嵌浏览器**：Agent 内直接嵌入 WebView，加载 Zephyr Web UI，无需跳出到系统浏览器。
2. **本地化增强**：WebView 通过 JS Bridge 暴露原生能力，包括：
   - 自签名证书信任（内网 HTTPS 无警告）
   - 离线/无公网时正常访问局域网 Zephyr 实例
   - 本地设备注册（不经过服务端，存在设备本地）
   - 原生文件选择器、通知、权限申请
3. **本地设备管理**：Agent 内维护一份「本地连接列表」（SSH/RDP/VNC/本地服务），独立于服务端数据库；元数据（不含凭据）在网络可达时**始终自动同步**到服务端，每台设备有独立的 `showInWeb` 开关控制是否在浏览器版 Zephyr 中展示。
4. **功能一致性**：WebView 内所有 Zephyr 功能（终端、RDP、文件管理、AI、设置）与浏览器版完全一致。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                  Zephyr Agent (Flutter)                  │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Agent Tab  │  │ Devices Tab  │  │  Console Tab   │  │
│  │  (现有功能)  │  │ 本地设备管理  │  │ 内嵌 WebView   │  │
│  └─────────────┘  └──────────────┘  └───────┬────────┘  │
│                                              │           │
│                              ┌───────────────▼────────┐  │
│                              │     JS Bridge          │  │
│                              │  ZephyrNativeBridge    │  │
│                              │  - localDevices        │  │
│                              │  - openLocalConn       │  │
│                              │  - pickFile / pickDir  │  │
│                              │  - getAgentStatus      │  │
│                              │  - requestPermission   │  │
│                              └───────────────┬────────┘  │
└──────────────────────────────────────────────┼───────────┘
                                               │ WebSocket/HTTP
                                    ┌──────────▼──────────┐
                                    │   Zephyr Server     │
                                    │   (Node.js)         │
                                    │   内网 / 公网均可     │
                                    └─────────────────────┘
```

### 关键设计决策

- **WebView 引擎**：使用 `flutter_inappwebview` v6（而非 `webview_flutter`）。原因：支持自定义证书拦截、JS Channel 双向通信、`onReceivedHttpAuthRequest`、Cookie 管理、自定义 UA，功能完备度远超官方包。
- **本地连接存储**：`SharedPreferences` 存 JSON 列表，不依赖服务端数据库。元数据（不含凭据）在网络可达时**始终自动同步**到 Zephyr 服务端；`showInWeb` 字段控制每台设备是否在浏览器版 Web UI 中展示，默认 `true`（同步且展示）。
- **JS Bridge 方向**：Web → Native（通过 `window.ZephyrNativeBridge.postMessage`）；Native → Web（通过 `webViewController.evaluateJavascript`）。
- **Server 侧改动极小**：仅在 `/api/settings` 或 `hello_ack` 响应中追加 `inAppContext: true` 标志，让前端 JS 知道自己跑在 Agent WebView 内，从而渲染「本地设备」入口。

---

## 三、依赖变更

### 3.1 Flutter pubspec.yaml 新增依赖

```yaml
dependencies:
  flutter_inappwebview: ^6.1.5      # WebView 核心
  flutter_secure_storage: ^9.2.2    # 敏感配置加密存储（Token、证书指纹）
  permission_handler: ^11.3.1       # 运行时权限申请统一 API
  connectivity_plus: ^6.1.0         # 网络连通性检测（判断内网/无网）
  local_auth: ^2.3.0                # 生物识别解锁（可选，保护本地连接列表）
  package_info_plus: ^8.1.3         # 读取 App 版本号注入 UA
```

> `flutter_inappwebview` 6.x 需要 Android minSdk ≥ 21、iOS ≥ 12。

### 3.2 Android `AndroidManifest.xml` 新增权限

```xml
<!-- 内网访问 -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />

<!-- 相机（WebRTC 视频）-->
<uses-permission android:name="android.permission.CAMERA" />

<!-- 麦克风（WebRTC 音频）-->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

在 `<application>` 标签内追加：

```xml
<!-- 允许明文 HTTP（内网场景，仅限白名单域）-->
<uses-library android:name="org.apache.http.legacy" android:required="false" />
```

同时创建 `res/xml/network_security_config.xml`：

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
  <!-- 开发/内网：允许 10.x 16.x 172.x 192.168.x 明文 -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">10.0.0.0/8</domain>
    <domain includeSubdomains="true">192.168.0.0/16</domain>
    <domain includeSubdomains="true">172.16.0.0/12</domain>
    <domain includeSubdomains="true">localhost</domain>
  </domain-config>
</network-security-config>
```

---

## 四、数据模型

### 4.1 本地设备 `LocalDevice`

```dart
// lib/devices/local_device.dart

enum LocalDeviceType { ssh, rdp, vnc, localService }

class LocalDevice {
  final String id;          // UUID v4，本地生成
  String label;             // 显示名，用户自定义
  LocalDeviceType type;
  String host;              // IP 或主机名
  int port;
  String? username;
  bool saveCredentials;     // 是否在 SecureStorage 存密码/私钥
  String? note;
  DateTime createdAt;
  DateTime updatedAt;
  // 元数据（不含凭据）在网络可达时始终同步到 Zephyr 服务端；
  // showInWeb 仅控制是否在浏览器版 Zephyr Web UI 中展示，默认 true（展示）。
  bool showInWeb;
  Map<String, dynamic> extra; // 扩展字段（RDP: domain/resolution; VNC: colorDepth）

  LocalDevice({
    required this.id,
    required this.label,
    required this.type,
    required this.host,
    required this.port,
    this.username,
    this.saveCredentials = false,
    this.note,
    required this.createdAt,
    required this.updatedAt,
    this.showInWeb = true,
    this.extra = const {},
  });

  Map<String, dynamic> toJson() => {
    'id': id,
    'label': label,
    'type': type.name,
    'host': host,
    'port': port,
    'username': username,
    'saveCredentials': saveCredentials,
    'note': note,
    'createdAt': createdAt.toIso8601String(),
    'updatedAt': updatedAt.toIso8601String(),
    'showInWeb': showInWeb,
    'extra': extra,
  };

  factory LocalDevice.fromJson(Map<String, dynamic> j) => LocalDevice(
    id: j['id'] as String,
    label: j['label'] as String,
    type: LocalDeviceType.values.firstWhere(
      (t) => t.name == j['type'], orElse: () => LocalDeviceType.ssh),
    host: j['host'] as String,
    port: j['port'] as int,
    username: j['username'] as String?,
    saveCredentials: j['saveCredentials'] as bool? ?? false,
    note: j['note'] as String?,
    createdAt: DateTime.parse(j['createdAt'] as String),
    updatedAt: DateTime.parse(j['updatedAt'] as String),
    showInWeb: j['showInWeb'] as bool? ?? true,
    extra: (j['extra'] as Map<String, dynamic>?) ?? {},
  );
}
```

### 4.2 本地设备存储 `LocalDeviceStore`

```dart
// lib/devices/local_device_store.dart

import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'local_device.dart';

class LocalDeviceStore extends ChangeNotifier {
  static const _listKey = 'local_devices_v1';
  static const _storage = FlutterSecureStorage();

  List<LocalDevice> _devices = [];
  List<LocalDevice> get devices => List.unmodifiable(_devices);

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_listKey);
    if (raw == null) return;
    final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    _devices = list.map(LocalDevice.fromJson).toList();
    notifyListeners();
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_listKey, jsonEncode(_devices.map((d) => d.toJson()).toList()));
  }

  Future<void> add(LocalDevice device) async {
    _devices.add(device);
    await _persist();
    notifyListeners();
  }

  Future<void> update(LocalDevice device) async {
    final i = _devices.indexWhere((d) => d.id == device.id);
    if (i < 0) return;
    _devices[i] = device;
    await _persist();
    notifyListeners();
  }

  Future<void> remove(String id) async {
    _devices.removeWhere((d) => d.id == id);
    await _storage.delete(key: 'cred_$id');
    await _persist();
    notifyListeners();
  }

  /// 保存凭据（密码/私钥）到 SecureStorage
  Future<void> saveCredential(String deviceId, String credential) async {
    await _storage.write(key: 'cred_$deviceId', value: credential);
  }

  Future<String?> loadCredential(String deviceId) async {
    return await _storage.read(key: 'cred_$deviceId');
  }
}
```

---

## 五、JS Bridge 设计

### 5.1 Bridge 消息格式

所有 Web → Native 消息走同一个 `ZephyrNativeBridge` channel，用 `action` 字段路由：

```js
// Web 侧调用示例
window.ZephyrNativeBridge.postMessage(JSON.stringify({
  action: 'getLocalDevices',
  requestId: 'req_001',
}));

// Native 回调到 Web
// webViewController.evaluateJavascript(
//   "window.onZephyrNativeResponse({requestId:'req_001', data:[...]})"
// );
```

### 5.2 支持的 Bridge Actions

| action | 方向 | 参数 | 说明 |
|--------|------|------|------|
| `getLocalDevices` | W→N | — | 返回本地设备列表 JSON |
| `addLocalDevice` | W→N | `device: LocalDevice` | 添加本地设备 |
| `updateLocalDevice` | W→N | `device: LocalDevice` | 更新本地设备 |
| `removeLocalDevice` | W→N | `id: string` | 删除本地设备 |
| `openLocalConnection` | W→N | `id: string` | 在 Agent 内打开连接 |
| `getAgentStatus` | W→N | — | 返回 Agent 连接状态 |
| `pickFile` | W→N | `multiple: bool` | 调用原生文件选择器 |
| `pickDirectory` | W→N | — | 调用原生目录选择器 |
| `requestPermission` | W→N | `permission: string` | 申请权限（camera/microphone/storage）|
| `getNetworkInfo` | W→N | — | 返回 IP / WiFi SSID / 是否内网 |
| `setClipboard` | W→N | `text: string` | 写入系统剪贴板 |
| `getClipboard` | W→N | — | 读取系统剪贴板 |
| `showNativeToast` | W→N | `message: string` | 弹出系统 Toast |
| `openAppSettings` | W→N | — | 跳转 App 系统设置页 |
| `inAppContextReady` | N→W | `agentConnected: bool, platform: string` | WebView 加载完成时 Native 推送上下文 |

### 5.3 Dart Bridge Handler 核心代码

```dart
// lib/webview/native_bridge.dart

import 'dart:convert';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import '../devices/local_device_store.dart';
import '../agent/agent_controller.dart';

class NativeBridge {
  final InAppWebViewController webController;
  final LocalDeviceStore deviceStore;
  final AgentController agentController;

  NativeBridge({
    required this.webController,
    required this.deviceStore,
    required this.agentController,
  });

  /// 注册所有 JS Channel 处理
  void register(InAppWebViewController controller) {
    controller.addJavaScriptHandler(
      handlerName: 'ZephyrNativeBridge',
      callback: (args) async {
        if (args.isEmpty) return;
        final msg = jsonDecode(args[0] as String) as Map<String, dynamic>;
        final action = msg['action'] as String?;
        final requestId = msg['requestId'] as String? ?? '';
        final payload = msg['payload'] as Map<String, dynamic>? ?? {};
        final result = await _dispatch(action, payload);
        _respond(requestId, result);
      },
    );
  }

  Future<dynamic> _dispatch(String? action, Map<String, dynamic> p) async {
    switch (action) {
      case 'getLocalDevices':
        return deviceStore.devices.map((d) => d.toJson()).toList();

      case 'addLocalDevice':
        final d = LocalDevice.fromJson(p['device'] as Map<String, dynamic>);
        await deviceStore.add(d);
        return {'ok': true, 'id': d.id};

      case 'updateLocalDevice':
        final d = LocalDevice.fromJson(p['device'] as Map<String, dynamic>);
        await deviceStore.update(d);
        return {'ok': true};

      case 'removeLocalDevice':
        await deviceStore.remove(p['id'] as String);
        return {'ok': true};

      case 'getAgentStatus':
        return {
          'status': agentController.status.name,
          'agentId': agentController.agentId,
          'serverUrl': agentController.config.serverUrl,
        };

      case 'getNetworkInfo':
        // ConnectivityPlus + NetworkInfo 填充
        return {'platform': _platformName()};

      default:
        return {'error': 'unknown_action', 'action': action};
    }
  }

  void _respond(String requestId, dynamic data) {
    final json = jsonEncode({'requestId': requestId, 'data': data});
    // 单引号转义防止 JS 注入
    final escaped = json.replaceAll("'", "\\'");
    webController.evaluateJavascript(
      source: "window.__zephyrNativeResponse && window.__zephyrNativeResponse('$escaped')",
    );
  }

  String _platformName() {
    // 与 AgentController._platformName() 保持一致
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isWindows) return 'windows';
    if (Platform.isLinux) return 'linux';
    return 'unknown';
  }
}
```

---

## 六、WebView 页面实现

### 6.1 ConsoleScreen — 内嵌 WebView 页

```dart
// lib/screens/console_screen.dart  （新文件，完整骨架）

import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:provider/provider.dart';
import '../agent/agent_controller.dart';
import '../devices/local_device_store.dart';
import '../storage/local_settings.dart';
import '../webview/native_bridge.dart';

class ConsoleScreen extends StatefulWidget {
  const ConsoleScreen({super.key});
  @override
  State<ConsoleScreen> createState() => _ConsoleScreenState();
}

class _ConsoleScreenState extends State<ConsoleScreen> {
  InAppWebViewController? _wvc;
  NativeBridge? _bridge;
  double _progress = 0;
  bool _canGoBack = false;
  String? _currentUrl;
  // 地址栏控制器
  final _urlCtrl = TextEditingController();

  @override
  void dispose() {
    _urlCtrl.dispose();
    super.dispose();
  }

  InAppWebViewSettings _buildSettings(String serverUrl) {
    return InAppWebViewSettings(
      javaScriptEnabled: true,
      domStorageEnabled: true,
      databaseEnabled: true,
      mediaPlaybackRequiresUserGesture: false,
      allowsInlineMediaPlayback: true,
      // 允许自签名证书（内网 HTTPS）
      allowUniversalAccessFromFileURLs: false,
      // 自定义 UA 注入 ZephyrAgent 标识，前端 JS 通过 navigator.userAgent 检测
      userAgent:
          'Mozilla/5.0 ZephyrAgent/${_appVersion()} (${Platform.operatingSystem})',
      // 允许混合内容（内网 HTTP + HTTPS 混用）
      mixedContentMode: MixedContentMode.MIXED_CONTENT_ALWAYS_ALLOW,
      // 支持全屏（RDP/VNC 全屏模式）
      supportZoom: false,
      useWideViewPort: true,
      loadWithOverviewMode: true,
      // 开启 WebRTC（终端/RDP 可能用到）
      allowsAirPlayForMediaPlayback: true,
    );
  }

  String _appVersion() => '1.0.0'; // 后续从 package_info_plus 读取

  @override
  Widget build(BuildContext context) {
    final agentCtrl = context.watch<AgentController>();
    final deviceStore = context.watch<LocalDeviceStore>();
    final serverUrl = agentCtrl.config.serverUrl;
    final initialUrl = serverUrl.isNotEmpty ? serverUrl : 'about:blank';

    return Scaffold(
      appBar: _buildAppBar(context),
      body: Column(
        children: [
          // 进度条
          if (_progress < 1.0)
            LinearProgressIndicator(value: _progress, minHeight: 2),
          // WebView
          Expanded(
            child: serverUrl.isEmpty
                ? _buildNoUrlPlaceholder(context)
                : InAppWebView(
                    initialUrlRequest: URLRequest(
                      url: WebUri(initialUrl),
                    ),
                    initialSettings: _buildSettings(serverUrl),
                    onWebViewCreated: (controller) {
                      _wvc = controller;
                      _bridge = NativeBridge(
                        webController: controller,
                        deviceStore: deviceStore,
                        agentController: agentCtrl,
                      );
                      _bridge!.register(controller);
                    },
                    onLoadStart: (controller, url) {
                      setState(() {
                        _currentUrl = url?.toString();
                        _urlCtrl.text = _currentUrl ?? '';
                        _progress = 0.1;
                      });
                    },
                    onProgressChanged: (controller, progress) {
                      setState(() => _progress = progress / 100.0);
                    },
                    onLoadStop: (controller, url) async {
                      setState(() {
                        _progress = 1.0;
                        _currentUrl = url?.toString();
                        _urlCtrl.text = _currentUrl ?? '';
                      });
                      _canGoBack = await controller.canGoBack();
                      setState(() {});
                      // 加载完成后推送 Native 上下文到 Web
                      _injectContextBridge(agentCtrl);
                    },
                    // 自定义证书处理（允许内网自签名）
                    onReceivedServerTrustAuthRequest: (controller, challenge) async {
                      if (agentCtrl.config.allowBadCertificates) {
                        return ServerTrustAuthResponse(
                          action: ServerTrustAuthResponseAction.PROCEED,
                        );
                      }
                      return ServerTrustAuthResponse(
                        action: ServerTrustAuthResponseAction.CANCEL,
                      );
                    },
                    // 允许 WebRTC 相机/麦克风
                    onPermissionRequest: (controller, request) async {
                      return PermissionResponse(
                        resources: request.resources,
                        action: PermissionResponseAction.GRANT,
                      );
                    },
                    onConsoleMessage: (controller, msg) {
                      debugPrint('[WebConsole] ${msg.message}');
                    },
                  ),
          ),
        ],
      ),
    );
  }

  void _injectContextBridge(AgentController ctrl) {
    final payload = {
      'agentConnected': ctrl.status.name == 'online',
      'agentId': ctrl.agentId ?? '',
      'platform': Platform.operatingSystem,
      'inApp': true,
    };
    final json = payload.entries
        .map((e) => '"${e.key}": ${e.value is String ? '"${e.value}"' : e.value}')
        .join(', ');
    _wvc?.evaluateJavascript(
      source: '''
        window.__zephyrAgentContext = {$json};
        document.dispatchEvent(new CustomEvent('zephyrAgentReady', {
          detail: window.__zephyrAgentContext
        }));
      ''',
    );
  }

  AppBar _buildAppBar(BuildContext context) {
    return AppBar(
      title: _buildUrlBar(),
      leading: _canGoBack
          ? IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => _wvc?.goBack(),
            )
          : null,
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh),
          onPressed: () => _wvc?.reload(),
          tooltip: '刷新',
        ),
        IconButton(
          icon: const Icon(Icons.open_in_browser),
          onPressed: _currentUrl != null
              ? () {
                  // 用系统浏览器打开当前页（备用）
                }
              : null,
          tooltip: '在系统浏览器打开',
        ),
      ],
    );
  }

  Widget _buildUrlBar() {
    return GestureDetector(
      onTap: () => _showUrlEditDialog(),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceVariant,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.lock_outline, size: 14),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _currentUrl ?? '未加载',
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showUrlEditDialog() {
    final ctrl = TextEditingController(text: _currentUrl ?? '');
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('导航到'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(labelText: 'URL'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          ElevatedButton(
            onPressed: () {
              final url = ctrl.text.trim();
              if (url.isNotEmpty) {
                _wvc?.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
              }
              Navigator.pop(context);
            },
            child: const Text('跳转'),
          ),
        ],
      ),
    );
  }

  Widget _buildNoUrlPlaceholder(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.web_asset_off_outlined,
              size: 64, color: Theme.of(context).colorScheme.outline),
          const SizedBox(height: 16),
          const Text('请先在「代理」标签页填写主端地址', style: TextStyle(fontSize: 15)),
          const SizedBox(height: 8),
          const Text('填写并保存后，控制台将自动加载 Zephyr Web UI',
              style: TextStyle(fontSize: 13, color: Colors.grey)),
        ],
      ),
    );
  }
}
```

---

## 七、本地设备管理页

### 7.1 DevicesScreen 骨架

```dart
// lib/screens/devices_screen.dart

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';
import '../devices/local_device.dart';
import '../devices/local_device_store.dart';

class DevicesScreen extends StatelessWidget {
  const DevicesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<LocalDeviceStore>(
      builder: (context, store, _) {
        final devices = store.devices;
        return Scaffold(
          body: devices.isEmpty
              ? _buildEmpty(context)
              : ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: devices.length,
                  itemBuilder: (context, i) =>
                      _DeviceCard(device: devices[i]),
                ),
          floatingActionButton: FloatingActionButton.extended(
            onPressed: () => _showAddDeviceDialog(context, store),
            icon: const Icon(Icons.add),
            label: const Text('添加设备'),
          ),
        );
      },
    );
  }

  Widget _buildEmpty(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.devices_other_outlined,
              size: 72, color: Theme.of(context).colorScheme.outline),
          const SizedBox(height: 16),
          const Text('还没有本地设备', style: TextStyle(fontSize: 16)),
          const SizedBox(height: 8),
          const Text('添加 SSH / RDP / VNC 等设备，\n直接从 Agent 发起连接',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: Colors.grey)),
        ],
      ),
    );
  }

  void _showAddDeviceDialog(BuildContext context, LocalDeviceStore store) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => DeviceEditSheet(
        onSave: (device) async {
          await store.add(device);
        },
      ),
    );
  }
}

class _DeviceCard extends StatelessWidget {
  final LocalDevice device;
  const _DeviceCard({required this.device});

  IconData _iconFor(LocalDeviceType t) => switch (t) {
    LocalDeviceType.ssh => Icons.terminal,
    LocalDeviceType.rdp => Icons.desktop_windows_outlined,
    LocalDeviceType.vnc => Icons.screen_share_outlined,
    LocalDeviceType.localService => Icons.settings_ethernet,
  };

  String _typeLabel(LocalDeviceType t) => switch (t) {
    LocalDeviceType.ssh => 'SSH',
    LocalDeviceType.rdp => 'RDP',
    LocalDeviceType.vnc => 'VNC',
    LocalDeviceType.localService => '本地服务',
  };

  @override
  Widget build(BuildContext context) {
    final store = context.read<LocalDeviceStore>();
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: CircleAvatar(child: Icon(_iconFor(device.type))),
        title: Text(device.label, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('${device.host}:${device.port}  •  ${_typeLabel(device.type)}'),
        trailing: PopupMenuButton<String>(
          onSelected: (v) {
            if (v == 'edit') {
              showModalBottomSheet(
                context: context,
                isScrollControlled: true,
                shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
                builder: (_) => DeviceEditSheet(
                  initial: device,
                  onSave: (d) => store.update(d),
                ),
              );
            } else if (v == 'delete') {
              _confirmDelete(context, store);
            }
          },
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'edit', child: ListTile(
              leading: Icon(Icons.edit_outlined), title: Text('编辑'))),
            const PopupMenuItem(value: 'delete', child: ListTile(
              leading: Icon(Icons.delete_outline), title: Text('删除'))),
          ],
        ),
        onTap: () => _openDevice(context),
      ),
    );
  }

  void _openDevice(BuildContext context) {
    // 通过 WebView Bridge 触发连接，或者本地内嵌连接逻辑
    // 详见第九节「连接跳转流程」
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('正在连接 ${device.label}…'),
          behavior: SnackBarBehavior.floating),
    );
  }

  void _confirmDelete(BuildContext context, LocalDeviceStore store) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除设备'),
        content: Text('确定删除「${device.label}」？此操作不可撤销。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              store.remove(device.id);
              Navigator.pop(context);
            },
            child: const Text('删除'),
          ),
        ],
      ),
    );
  }
}
```

### 7.2 DeviceEditSheet — 添加/编辑设备表单

```dart
// lib/screens/device_edit_sheet.dart

class DeviceEditSheet extends StatefulWidget {
  final LocalDevice? initial;
  final Future<void> Function(LocalDevice) onSave;
  const DeviceEditSheet({super.key, this.initial, required this.onSave});

  @override
  State<DeviceEditSheet> createState() => _DeviceEditSheetState();
}

class _DeviceEditSheetState extends State<DeviceEditSheet> {
  final _formKey = GlobalKey<FormState>();
  late TextEditingController _labelCtrl;
  late TextEditingController _hostCtrl;
  late TextEditingController _portCtrl;
  late TextEditingController _userCtrl;
  late TextEditingController _noteCtrl;
  LocalDeviceType _type = LocalDeviceType.ssh;
  bool _saveCredentials = false;

  static const _defaultPorts = {
    LocalDeviceType.ssh: 22,
    LocalDeviceType.rdp: 3389,
    LocalDeviceType.vnc: 5900,
    LocalDeviceType.localService: 80,
  };

  @override
  void initState() {
    super.initState();
    final d = widget.initial;
    _type = d?.type ?? LocalDeviceType.ssh;
    _labelCtrl = TextEditingController(text: d?.label ?? '');
    _hostCtrl = TextEditingController(text: d?.host ?? '');
    _portCtrl = TextEditingController(
        text: (d?.port ?? _defaultPorts[_type]!).toString());
    _userCtrl = TextEditingController(text: d?.username ?? '');
    _noteCtrl = TextEditingController(text: d?.note ?? '');
    _saveCredentials = d?.saveCredentials ?? false;
  }

  @override
  void dispose() {
    for (final c in [_labelCtrl, _hostCtrl, _portCtrl, _userCtrl, _noteCtrl]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
          left: 16, right: 16, top: 16),
      child: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(child: Container(width: 40, height: 4,
                  decoration: BoxDecoration(
                    color: Colors.grey.shade300,
                    borderRadius: BorderRadius.circular(2)))),
              const SizedBox(height: 16),
              Text(widget.initial == null ? '添加设备' : '编辑设备',
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              const SizedBox(height: 16),

              // 类型选择
              Wrap(
                spacing: 8,
                children: LocalDeviceType.values.map((t) => ChoiceChip(
                  label: Text(t.name.toUpperCase()),
                  selected: _type == t,
                  onSelected: (_) => setState(() {
                    _type = t;
                    _portCtrl.text = _defaultPorts[t]!.toString();
                  }),
                )).toList(),
              ),
              const SizedBox(height: 12),

              TextFormField(
                controller: _labelCtrl,
                decoration: const InputDecoration(labelText: '显示名称 *'),
                validator: (v) => (v == null || v.isEmpty) ? '请输入名称' : null,
              ),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(
                  flex: 3,
                  child: TextFormField(
                    controller: _hostCtrl,
                    decoration: const InputDecoration(labelText: '主机 / IP *'),
                    keyboardType: TextInputType.url,
                    validator: (v) => (v == null || v.isEmpty) ? '请输入地址' : null,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextFormField(
                    controller: _portCtrl,
                    decoration: const InputDecoration(labelText: '端口'),
                    keyboardType: TextInputType.number,
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              TextFormField(
                controller: _userCtrl,
                decoration: const InputDecoration(labelText: '用户名'),
              ),
              const SizedBox(height: 10),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('保存凭据（密码/私钥）'),
                subtitle: const Text('加密存储在设备 Keystore 中'),
                value: _saveCredentials,
                onChanged: (v) => setState(() => _saveCredentials = v),
              ),
              TextFormField(
                controller: _noteCtrl,
                decoration: const InputDecoration(labelText: '备注（可选）'),
                maxLines: 2,
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton(
                  onPressed: _submit,
                  child: const Text('保存'),
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }

  void _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final now = DateTime.now();
    final device = LocalDevice(
      id: widget.initial?.id ?? const Uuid().v4(),
      label: _labelCtrl.text.trim(),
      type: _type,
      host: _hostCtrl.text.trim(),
      port: int.tryParse(_portCtrl.text.trim()) ?? _defaultPorts[_type]!,
      username: _userCtrl.text.trim().isEmpty ? null : _userCtrl.text.trim(),
      saveCredentials: _saveCredentials,
      note: _noteCtrl.text.trim().isEmpty ? null : _noteCtrl.text.trim(),
      createdAt: widget.initial?.createdAt ?? now,
      updatedAt: now,
    );
    await widget.onSave(device);
    if (mounted) Navigator.pop(context);
  }
}
```

---

## 八、主导航改造（BottomNavigationBar 三标签）

### 8.1 改造 ZephyrAgentApp

现有 `HomeScreen` 直接作为 `home`，改为三标签 Shell：

```dart
// lib/app/zephyr_agent_app.dart — 改造 build() 方法

home: MainShell(
  currentTheme: _theme,
  onThemeChanged: _setTheme,
),
```

### 8.2 MainShell — 三标签容器

```dart
// lib/screens/main_shell.dart

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../agent/agent_controller.dart';
import '../theme/zephyr_colors.dart';
import 'home_screen.dart';
import 'devices_screen.dart';
import 'console_screen.dart';

class MainShell extends StatefulWidget {
  final ZephyrTheme currentTheme;
  final ValueChanged<ZephyrTheme> onThemeChanged;
  const MainShell({super.key, required this.currentTheme, required this.onThemeChanged});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _tab = 0;

  // 使用 IndexedStack 保留各标签页状态，避免 WebView 被销毁重建
  late final List<Widget> _pages = [
    HomeScreen(
      currentTheme: widget.currentTheme,
      onThemeChanged: widget.onThemeChanged,
    ),
    const DevicesScreen(),
    const ConsoleScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final agentCtrl = context.watch<AgentController>();
    final isOnline = agentCtrl.status == AgentStatus.online;
    final brightness = Theme.of(context).brightness;
    final accent = ZephyrColors.getPrimary(widget.currentTheme, brightness);

    return Scaffold(
      body: IndexedStack(index: _tab, children: _pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          NavigationDestination(
            icon: Icon(isOnline ? Icons.wifi : Icons.wifi_off_outlined),
            selectedIcon: Icon(isOnline ? Icons.wifi : Icons.wifi_off, color: accent),
            label: '代理',
          ),
          const NavigationDestination(
            icon: Icon(Icons.devices_outlined),
            selectedIcon: Icon(Icons.devices),
            label: '设备',
          ),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: !isOnline && agentCtrl.config.serverUrl.isNotEmpty,
              label: const Text('!'),
              child: const Icon(Icons.web_outlined),
            ),
            selectedIcon: const Icon(Icons.web),
            label: '控制台',
          ),
        ],
      ),
    );
  }
}
```

> **IndexedStack 的重要性**：三个页面全部常驻内存，切换标签时 WebView 不会销毁重建，保留 RDP/终端会话状态。

---

## 九、连接跳转流程

### 9.1 本地设备 → WebView 内打开

当用户在「设备」标签点击 SSH/RDP 设备时，流程如下：

```
用户点击设备卡片
   ↓
DevicesScreen._openDevice()
   ↓
构造目标 URL：
  SSH  → {serverUrl}/terminal?host=X&port=22&user=Y&localDevice=true
  RDP  → {serverUrl}/rdp?host=X&port=3389&localDevice=true
  VNC  → {serverUrl}/novnc?host=X&port=5900&localDevice=true
   ↓
切换到「控制台」标签 (MainShell._tab = 2)
   ↓
ConsoleScreen 加载目标 URL
   ↓
前端 JS 检测 ?localDevice=true 参数
   + window.__zephyrAgentContext.inApp === true
   ↓
前端跳过 "需要先添加连接" 提示，直接使用 URL 参数建立连接
```

实现片段（`_DeviceCard._openDevice`）：

```dart
void _openDevice(BuildContext context) {
  final agentCtrl = context.read<AgentController>();
  final serverUrl = agentCtrl.config.serverUrl;
  if (serverUrl.isEmpty) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('请先在「代理」标签填写主端地址'),
          behavior: SnackBarBehavior.floating),
    );
    return;
  }

  final typePathMap = {
    LocalDeviceType.ssh: 'terminal',
    LocalDeviceType.rdp: 'rdp',
    LocalDeviceType.vnc: 'novnc',
    LocalDeviceType.localService: '',
  };
  final path = typePathMap[device.type];
  if (path == null || path.isEmpty) {
    // localService：直接用 host:port 拼 URL
    _navigateConsole(context, 'http://${device.host}:${device.port}');
    return;
  }

  final user = device.username ?? '';
  final target = '$serverUrl/$path?'
      'host=${Uri.encodeComponent(device.host)}'
      '&port=${device.port}'
      '${user.isNotEmpty ? "&user=${Uri.encodeComponent(user)}" : ""}'
      '&localDevice=true'
      '&label=${Uri.encodeComponent(device.label)}';

  _navigateConsole(context, target);
}

void _navigateConsole(BuildContext context, String url) {
  // 通知 MainShell 切换到控制台标签并导航
  context.read<MainShellController>().navigateConsole(url);
}
```

### 9.2 MainShellController — 跨标签导航

```dart
// lib/app/main_shell_controller.dart

class MainShellController extends ChangeNotifier {
  int _tab = 0;
  String? _pendingConsoleUrl;

  int get tab => _tab;
  String? get pendingConsoleUrl => _pendingConsoleUrl;

  void switchTab(int i) {
    _tab = i;
    notifyListeners();
  }

  void navigateConsole(String url) {
    _pendingConsoleUrl = url;
    _tab = 2; // 控制台 tab
    notifyListeners();
  }

  void consumePendingUrl() {
    _pendingConsoleUrl = null;
  }
}
```

`ConsoleScreen` 监听 `MainShellController.pendingConsoleUrl`，有值时立即 `loadUrl`：

```dart
// ConsoleScreen initState 中
context.read<MainShellController>().addListener(() {
  final pending = context.read<MainShellController>().pendingConsoleUrl;
  if (pending != null && _wvc != null) {
    _wvc!.loadUrl(urlRequest: URLRequest(url: WebUri(pending)));
    context.read<MainShellController>().consumePendingUrl();
  }
});
```

---

## 十、前端 JS 适配（Zephyr Web UI 改动）

### 10.1 Agent 上下文检测

在 `public/app.js` 最顶部加入检测逻辑（不影响浏览器版）：

```js
// public/app.js — 新增，放在 DOMContentLoaded 之前

window.__isZephyrAgent = false;
window.__zephyrAgentContext = null;

document.addEventListener('zephyrAgentReady', (e) => {
  window.__isZephyrAgent = true;
  window.__zephyrAgentContext = e.detail;
  document.documentElement.classList.add('in-zephyr-agent');
  console.log('[ZephyrAgent] inApp context ready', e.detail);
});

// 超时 500ms 仍未收到事件 → 浏览器模式
setTimeout(() => {
  if (!window.__isZephyrAgent) {
    document.documentElement.classList.add('in-browser');
  }
}, 500);
```

### 10.2 本地设备入口注入

`app.html` 的侧边栏 / 顶栏增加「本地设备」按钮，仅在 `.in-zephyr-agent` 时显示：

```html
<!-- 仅 Agent 模式可见 -->
<button id="localDevicesBtn"
        class="agent-only-btn"
        style="display:none"
        onclick="openLocalDevicesPanel()">
  <svg><!-- devices icon --></svg>
  <span>本地设备</span>
</button>

<style>
.in-zephyr-agent #localDevicesBtn { display: flex !important; }
</style>
```

```js
// public/app.js — 本地设备面板
async function openLocalDevicesPanel() {
  const devices = await bridgeCall('getLocalDevices');
  renderLocalDevicesPanel(devices);
}

function renderLocalDevicesPanel(devices) {
  // 渲染侧边抽屉，列表显示 SSH/RDP/VNC 卡片
  // 点击「连接」→ 构造 URL 在当前页跳转
}
```

### 10.3 localDevice 参数处理（terminal.html / rdp.html）

```js
// public/terminal.js — 现有 boot() 前增加

const searchParams = new URLSearchParams(location.search);
const localDevice = searchParams.get('localDevice') === 'true';
const deviceHost = searchParams.get('host');
const devicePort = searchParams.get('port');
const deviceUser = searchParams.get('user');

if (localDevice && deviceHost) {
  // 预填充连接表单，自动发起连接，跳过「需要先保存连接」步骤
  document.querySelector('#hostInput').value = deviceHost;
  document.querySelector('#portInput').value = devicePort || '22';
  if (deviceUser) document.querySelector('#userInput').value = deviceUser;
  document.addEventListener('DOMContentLoaded', () => autoConnect());
}
```

### 10.4 CSS class `in-zephyr-agent` 控制的 UI 差异

| 元素 | 浏览器版 | Agent 版 |
|------|---------|---------|
| 顶栏「在浏览器中打开」按钮 | 隐藏 | 显示 |
| 侧边「本地设备」入口 | 隐藏 | 显示 |
| 证书错误警告横幅 | 显示 | 隐藏（由 Native 处理） |
| 全屏按钮 | 显示 | 显示 |
| 安装 PWA 提示 | 显示 | 隐藏 |

---

## 十一、服务端最小改动

### 11.1 hello_ack 追加 inAppContext 支持

在 `file-agent-manager.js` 的 `hello_ack` 响应中增加字段（无破坏性）：

```js
// file-agent-manager.js — _handleHello() 中发送 hello_ack 时追加

const ack = {
  type: 'hello_ack',
  ok: true,
  agentId,
  heartbeatIntervalMs: 15000,
  serverVersion: getAppVersion(),
  features: {
    localDeviceSync: true,   // 服务端支持本地设备元数据同步
    inAppContext: true,       // 供前端 JS 确认服务端版本支持 Agent 上下文
  },
};
ws.send(JSON.stringify(ack));
```

### 11.2 本地设备元数据同步接口（可选）

增加 REST 端点，Agent 将本地设备列表（不含凭据）在网络可达时自动同步到服务端。凭据**永远不离开设备**：

```
PUT /api/agent/local-devices
Authorization: Bearer <token>
Content-Type: application/json

{
  "agentId": "...",
  "devices": [
    {
      "id": "uuid",
      "label": "家里的 Mac",
      "type": "ssh",
      "host": "192.168.1.100",
      "port": 22,
      "username": "user"
      // 不含 password / privateKey
    }
  ]
}
```

服务端将这批设备存入数据库的独立表，仅对该 agentId 对应的已认证用户可见。Web 前端从 `/api/agent/local-devices` 读取，在连接列表中以「来自 Agent」角标显示。

### 11.3 数据库 schema 追加（storage.js）

```sql
CREATE TABLE IF NOT EXISTS agent_local_devices (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT,
  extra TEXT DEFAULT '{}',
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_ald_user ON agent_local_devices(user_id);
```

---

## 十二、安全设计

### 12.1 证书处理

| 场景 | 处理方式 |
|------|---------|
| 受信任 CA（公网）| WebView 默认验证，无需干预 |
| 自签名（内网）| `onReceivedServerTrustAuthRequest` → PROCEED（由 `allowBadCertificates` 开关控制）|
| 证书指纹锁定 | 可选：`LocalSettings` 存储首次连接时的证书 SHA-256 指纹，后续比对 |

### 12.2 凭据安全

- 密码 / 私钥 → `flutter_secure_storage`（Android: EncryptedSharedPreferences + AES256 KeyStore；iOS: Keychain）
- Token → 同上，不存 `SharedPreferences`
- 本地设备列表（不含凭据）→ `SharedPreferences` JSON，可接受
- 同步到服务端的数据 → **只含 host/port/label/username，绝不含 password/privateKey**

### 12.3 JS Bridge 安全

- Bridge handler 仅注册在 `serverUrl` 同域页面（通过 `shouldOverrideUrlLoading` 拦截跨域跳转）
- Bridge action 白名单：未知 action 返回 `{error: 'unknown_action'}` 而非抛异常
- `evaluateJavascript` 回调中的字符串做 JSON 序列化，不做字符串拼接注入

### 12.4 Content Security Policy

Zephyr 服务端已设置 CORS 和 CSP。Agent WebView 不注入额外脚本，JS Bridge 通过 `addJavaScriptHandler`（原生注入，不受 CSP 限制）通信，无冲突。

---

## 十三、iOS 适配说明

> iOS 使用 WKWebView（`flutter_inappwebview` 底层）。以下几点与 Android 不同：

| 项目 | Android | iOS |
|------|---------|-----|
| 自签名证书 | `onReceivedServerTrustAuthRequest` | 同，但需在 Info.plist 追加 NSAllowsArbitraryLoads（内网环境）|
| 文件访问 | SAF / `MANAGE_EXTERNAL_STORAGE` | UIDocumentPickerViewController via `file_picker` |
| 安全存储 | EncryptedSharedPreferences | Keychain |
| 相机/麦克风 | AndroidManifest 声明 | NSCameraUsageDescription / NSMicrophoneUsageDescription |
| 后台 WebSocket | 需 `FlutterBackgroundService` | BGProcessingTask |

**Info.plist 追加：**

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoadsInWebContent</key>
  <true/>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
<key>NSCameraUsageDescription</key>
<string>用于 RDP/终端 WebRTC 视频</string>
<key>NSMicrophoneUsageDescription</key>
<string>用于 RDP/终端 WebRTC 音频</string>
```

---

## 十四、离线 / 内网场景设计

### 14.1 无公网时的启动流程

```
App 启动
  ↓
ConnectivityPlus 检测网络类型
  ├── WiFi / 以太网 → 尝试连接上次 serverUrl（内网地址）
  ├── 移动数据 → 提示"当前使用移动网络，连接内网地址可能失败"（可关闭提示）
  └── 无网络 → 显示横幅"离线模式：已缓存的页面仍可浏览"
```

### 14.2 WebView 离线缓存

`flutter_inappwebview` 默认启用 WebView 本地缓存。为增强离线体验：

```dart
initialSettings: InAppWebViewSettings(
  cacheEnabled: true,
  // 优先使用缓存，网络不可达时仍能显示上次加载的页面
  cacheMode: CacheMode.LOAD_CACHE_ELSE_NETWORK,
),
```

注意：RDP/SSH 等实时连接功能在离线时仍然不可用，但设置页、历史连接列表等静态内容可离线浏览。

### 14.3 本地设备在离线时的行为

本地设备列表完全存储在 Agent 本地，离线时依然可以：
- 查看所有设备
- 添加 / 编辑 / 删除设备
- 连接**同局域网**内的设备（只要 Agent 能 WebSocket 到 Zephyr 服务）

---

## 十五、目录结构变更汇总

```
zephyr_agent/
├── pubspec.yaml                         ← 新增依赖
├── android/
│   ├── app/src/main/AndroidManifest.xml ← 权限 + networkSecurityConfig
│   └── app/src/main/res/xml/
│       └── network_security_config.xml  ← 新增
├── ios/Runner/Info.plist                ← NSAppTransportSecurity 等
└── lib/
    ├── main.dart                        ← 不变
    ├── app/
    │   ├── zephyr_agent_app.dart        ← 改：注入 LocalDeviceStore provider
    │   ├── agent_version.dart           ← 不变
    │   └── main_shell_controller.dart   ← 新增
    ├── agent/
    │   ├── agent_controller.dart        ← 不变
    │   └── agent_state.dart             ← 不变
    ├── devices/
    │   ├── local_device.dart            ← 新增（数据模型）
    │   └── local_device_store.dart      ← 新增（存储）
    ├── fs/
    │   └── file_provider.dart           ← 不变
    ├── platform/
    │   └── platform_icon_service.dart   ← 不变
    ├── screens/
    │   ├── home_screen.dart             ← 不变（原代理页）
    │   ├── devices_screen.dart          ← 新增
    │   ├── device_edit_sheet.dart       ← 新增
    │   ├── console_screen.dart          ← 新增
    │   └── main_shell.dart              ← 新增（三标签容器）
    ├── storage/
    │   └── local_settings.dart          ← 不变
    ├── theme/
    │   └── zephyr_colors.dart           ← 不变
    └── webview/
        └── native_bridge.dart           ← 新增（JS Bridge）

public/
├── app.js                               ← 新增 zephyrAgentReady 监听 + localDevice 面板
├── app.html                             ← 新增 agent-only-btn + CSS class 控制
├── terminal.js                          ← 新增 localDevice URL 参数处理
└── rdp-wasm-client.js                   ← 新增 localDevice URL 参数处理

server.js / file-agent-manager.js        ← hello_ack features 字段
storage.js                               ← 新增 agent_local_devices 表（含 show_in_web 字段）
```

---

## 十六、分阶段交付计划

### Phase 0 — 基础内嵌 WebView（1-2 天）

**目标**：Agent 内能打开 Zephyr Web UI，无需跳浏览器。

**任务清单**：
- [ ] `pubspec.yaml` 追加 `flutter_inappwebview: ^6.1.5`
- [ ] `AndroidManifest.xml` 追加网络权限 + `network_security_config`
- [ ] 新建 `lib/screens/console_screen.dart`（基础 WebView，无 Bridge）
- [ ] 新建 `lib/screens/main_shell.dart`（三标签，IndexedStack）
- [ ] 新建 `lib/app/main_shell_controller.dart`
- [ ] 改造 `zephyr_agent_app.dart`：注入 `MainShellController`，`home` 改为 `MainShell`
- [ ] 验证：启动 App → 切到「控制台」标签 → 加载 serverUrl → 页面正常渲染
- [ ] 验证：内网自签名 HTTPS 无安全警告拦截
- [ ] 验证：切换到「代理」标签，WebView 未被销毁（IndexedStack 保留状态）

**验收标准**：
- WebView 能加载 serverUrl，功能与系统浏览器等价
- 自签名证书不弹警告（`allowBadCertificates=true` 时）
- 标签切换不刷新页面

---

### Phase 1 — 本地设备管理（2-3 天）

**目标**：「设备」标签可以添加/编辑/删除本地连接。

**任务清单**：
- [ ] 新建 `lib/devices/local_device.dart`（数据模型）
- [ ] 新建 `lib/devices/local_device_store.dart`（存储 + ChangeNotifier）
- [ ] 追加 `flutter_secure_storage: ^9.2.2` 依赖
- [ ] 新建 `lib/screens/devices_screen.dart`
- [ ] 新建 `lib/screens/device_edit_sheet.dart`
- [ ] `zephyr_agent_app.dart` MultiProvider 追加 `LocalDeviceStore`
- [ ] 验证：添加 SSH/RDP/VNC 设备，重启 App 后持久化正常
- [ ] 验证：凭据保存到 SecureStorage，不出现在 SharedPreferences

**验收标准**：
- CRUD 正常，数据持久化
- 设备类型切换自动填充默认端口

---

### Phase 2 — JS Bridge 基础（1-2 天）

**目标**：Web 侧能通过 `ZephyrNativeBridge` 读取本地设备列表和 Agent 状态。

**任务清单**：
- [ ] 新建 `lib/webview/native_bridge.dart`
- [ ] `ConsoleScreen` 的 `onWebViewCreated` 中注册 Bridge
- [ ] `ConsoleScreen` 的 `onLoadStop` 中注入 `window.__zephyrAgentContext`
- [ ] `public/app.js` 追加 `zephyrAgentReady` 事件监听 + `in-zephyr-agent` class
- [ ] `public/app.html` 追加 `agent-only-btn` CSS 控制
- [ ] 验证：打开 Chrome DevTools Remote Debugging → 确认 `window.__isZephyrAgent === true`
- [ ] 验证：调用 `ZephyrNativeBridge.postMessage(getLocalDevices)` → 返回设备 JSON

**验收标准**：
- Web 页面收到 `zephyrAgentReady` 事件
- Bridge 双向通信正常（Web→Native→Web 回调）

---

### Phase 3 — 设备 → WebView 跳转（1-2 天）

**目标**：点击本地设备卡片，WebView 自动导航到对应连接页并预填参数。

**任务清单**：
- [ ] `_DeviceCard._openDevice()` 构造目标 URL
- [ ] `MainShellController.navigateConsole()` 跨标签导航
- [ ] `ConsoleScreen` 监听 `pendingConsoleUrl` 并 `loadUrl`
- [ ] `public/terminal.js` 处理 `?localDevice=true&host=X&port=Y&user=Z`
- [ ] `public/rdp-wasm-client.js` 同上
- [ ] 验证：点击 SSH 设备 → 切到控制台 → terminal.html 预填 host/port/user → 自动连接
- [ ] 验证：点击 RDP 设备 → rdp.html 预填参数

**验收标准**：
- 从设备列表发起连接，全程无需手动填写 IP/Port
- 连接页标题显示设备 label

---

### Phase 4 — 本地设备同步到服务端（2 天）

**目标**：网络可达时自动同步本地设备元数据到服务端（凭据永不离开设备）；`showInWeb` 开关控制每台设备是否在浏览器版 Zephyr Web UI 中展示。

**设计要点**：
- 同步**始终发生**，不需要用户手动触发，也没有「是否同步」总开关
- `showInWeb=true`（默认）：同步到服务端且 Web 前端在连接列表中展示该设备（带「来自 Agent」角标），可点击连接
- `showInWeb=false`：同步到服务端但 Web 前端不渲染——有记录，不可见
- 同步时机：`hello_ack` 成功后立即全量 upsert；此后每次 Agent 本地设备列表发生变更（CRUD）时增量推送

**任务清单**：
- [ ] `storage.js` 追加 `agent_local_devices` 表（含 `show_in_web` 字段）
- [ ] `server.js` 追加 `PUT /api/agent/local-devices`（全量 upsert）+ `GET /api/agent/local-devices?showInWeb=true`
- [ ] `AgentController` 在 `hello_ack` 成功后调用 `_syncLocalDevices()`，`LocalDeviceStore` 变更时也触发
- [ ] `DeviceEditSheet` 底部追加「在 Zephyr Web 中显示」ChoiceChip（显示/隐藏，默认选「显示」，样式与共享目录权限开关一致）
- [ ] `_DeviceCard` 显示 `showInWeb` 图标角标（地球图标，亮=展示，暗=隐藏）
- [ ] `public/app.js` 从 `GET /api/agent/local-devices?showInWeb=true` 读取并渲染
- [ ] 验证：新建设备 → Agent 同步 → 服务端 DB 有记录；`showInWeb=false` 时 Web 列表不出现
- [ ] 验证：打开「在 Zephyr Web 中显示」→ Agent 推送 showInWeb=true → Web 端刷新 → 设备卡片出现

**验收标准**：
- 凭据（password/privateKey）绝不出现在同步请求中（服务端接口遇到这两个字段直接 400）
- `showInWeb=false` 的设备，Web 端无论如何刷新都不可见
- 设备卡片有「来自 Agent」角标和设备类型图标

---

## 十七、常见问题 & 设计决策记录

### Q1：为什么用 `flutter_inappwebview` 而不是官方 `webview_flutter`？

[KNOWN] `webview_flutter` 截至 4.x 不支持：
- `onReceivedServerTrustAuthRequest`（自签名证书必须）
- `addJavaScriptHandler`（JS Channel 只支持单向）
- `CacheMode` 精细控制
- `onPermissionRequest`（WebRTC 需要）

`flutter_inappwebview` 6.x 全部支持，是 Flutter WebView 生态的事实标准。

### Q2：IndexedStack 会不会内存占用过高？

三个标签：Agent 页（纯 Flutter）+ 设备页（纯 Flutter）+ WebView。  
WebView 是主要内存消耗，但它本来就要运行。IndexedStack 不新增内存，反而比反复 destroy/recreate 节省（WebView 初始化成本高）。  
如果目标设备内存严重不足（<2GB），可改为在切到控制台时延迟初始化 WebView（仅第一次切入时创建）。

### Q3：本地 SSH 设备点击后走 Zephyr 服务端中转，是否有安全问题？

是的，连接走 Zephyr 服务端的 SSH 代理，服务端需要能访问目标 SSH 主机。  
对于纯内网设备，只要 Zephyr 服务端也在内网，路径是：`Agent(手机) → Zephyr(内网服务端) → SSH主机(内网)`，没有公网暴露。  
如果希望 Agent 直接连（绕过服务端），需要在 Agent 内集成原生 SSH 客户端（如 `dart_ssh2` 或调用 `ssh` 二进制），这属于 Phase 5 扩展范围。

### Q4：`localDevice=true` URL 参数会不会影响普通浏览器用户安全？

普通浏览器用户无法伪造 `window.__zephyrAgentContext.inApp === true`（这个值由 Native 注入，不可通过 URL 参数设置）。  
`localDevice=true` 参数仅影响 UI 预填行为，不会绕过认证或权限控制。服务端始终做 Token 验证。

### Q5：WebView 内的 RDP/终端会话，切到后台 App 被系统杀掉怎么处理？

Android 后台限制：App 进入后台后，WebView 的 WebSocket 连接可能被系统断开。  
缓解方案：
1. `AndroidManifest.xml` 的 Activity 设置 `android:persistableMode="persistAcrossReboots"` 并配合 `SavedStateHandle`
2. Agent 已有重连逻辑（`_maybeReconnect`），WebView 内的 Zephyr JS 也有重连逻辑，断线后会自动重试
3. 长期方案：使用 `FlutterBackgroundService` 保持 WebSocket 心跳

---

## 十八、验收测试矩阵

| 测试场景 | 预期结果 | 平台 |
|---------|---------|------|
| 首次安装，填写内网 serverUrl（HTTP）| 控制台加载成功 | Android / iOS |
| 填写内网 HTTPS（自签名证书）| 控制台加载，无证书警告 | Android / iOS |
| 无互联网，WiFi 连内网 | 控制台加载，所有功能正常 | Android / iOS |
| 切换「代理」→「控制台」→「代理」| 控制台未刷新，保留之前状态 | 全平台 |
| 添加 SSH 设备，点击连接 | 跳到控制台 terminal.html，预填参数 | 全平台 |
| 添加 RDP 设备，点击连接 | 跳到控制台 rdp.html，预填参数 | 全平台 |
| 在 WebView 内调用 `ZephyrNativeBridge.getLocalDevices` | 返回本地设备 JSON | 全平台 |
| serverUrl 为空，切到控制台 | 显示「请填写主端地址」占位页 | 全平台 |
| Agent 在线状态，导航栏 WiFi 图标变绿 | 实时反映 Agent 状态 | 全平台 |
| 删除本地设备，SecureStorage 中的凭据也被清除 | 验证 `cred_{id}` 键不存在 | Android |
| 本地设备同步到服务端，Web 版显示「来自 Agent」| 设备卡片出现，含角标 | 全平台（Phase 4）|

---

*文档结束 — 共 18 节*
