// Agent controller — manages WebSocket connection, protocol, heartbeat,
// file RPC handling, auto-shutdown timer, and reconnection.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';
import 'package:uuid/uuid.dart';
import 'agent_state.dart';
import '../fs/file_provider.dart';
import 'file_transfer_protocol.dart';
import '../app/agent_version.dart';

class AgentController extends ChangeNotifier {
  AgentConfig _config;
  AgentStatus _status = AgentStatus.idle;
  String? _agentId;
  String _errorMessage = '';
  int _transferCount = 0;
  int _transferBytes = 0;

  // Auto-shutdown
  Timer? _shutdownTimer;
  DateTime? _shutdownAt;

  // WebSocket
  WebSocketChannel? _channel;
  StreamSubscription? _channelSub;

  // Heartbeat
  Timer? _heartbeatTimer;
  int _heartbeatIntervalMs = 15000;
  int _missedHeartbeats = 0;

  // Reconnect
  int _reconnectAttempts = 0;
  static const int _maxReconnectAttempts = 10;
  Timer? _reconnectTimer;

  // File provider
  ZephyrFileProvider? _fileProvider;
  final Map<int, Future<void>> _zft2Tasks = {};
  final Map<String, Future<void>> _zft2HandleQueues = {};
  final Set<int> _zft2Cancelled = {};
  Timer? _transferUiTimer;
  bool _transferUiDirty = false;

  AgentController(this._config);

  // ─── Getters ─────────────────────────────────────────────────

  AgentConfig get config => _config;
  AgentStatus get status => _status;
  String? get agentId => _agentId;
  String get errorMessage => _errorMessage;
  int get transferCount => _transferCount;
  int get transferBytes => _transferBytes;
  DateTime? get shutdownAt => _shutdownAt;

  Duration? get remainingShutdownTime {
    if (_shutdownAt == null) return null;
    final remaining = _shutdownAt!.difference(DateTime.now());
    return remaining.isNegative ? Duration.zero : remaining;
  }

  // ─── Config update ───────────────────────────────────────────

  void updateConfig(AgentConfig newConfig) {
    _config = newConfig;
    notifyListeners();
  }

  // ─── File provider ───────────────────────────────────────────

  void setFileProvider(ZephyrFileProvider provider) {
    _fileProvider = provider;
  }

  // ─── Connection lifecycle ────────────────────────────────────

  Future<void> start() async {
    if (_status.isActive) return;
    _reconnectAttempts = 0;
    await _connect();
  }

  Future<void> stop() async {
    _setStatus(AgentStatus.stopped);
    _cancelShutdownTimer();
    _cancelHeartbeat();
    _cancelReconnect();
    await _disconnect();
  }

  static String normalizeServerUrl(String input) {
    var value = input.trim();
    if (value.isEmpty) return '';
    if (value.startsWith('wss://')) value = 'https://${value.substring(6)}';
    if (value.startsWith('ws://')) value = 'http://${value.substring(5)}';
    if (!value.contains('://')) value = 'https://$value';
    final uri = Uri.parse(value);
    if (!uri.hasScheme || uri.host.isEmpty) return value.replaceAll(RegExp(r'/+$'), '');
    return Uri(
      scheme: uri.scheme,
      userInfo: uri.userInfo,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
    ).toString().replaceAll(RegExp(r'/+$'), '');
  }

  static Uri agentWebSocketUriForServerUrl(String serverUrl) {
    final normalized = normalizeServerUrl(serverUrl);
    final uri = Uri.parse(normalized);
    final wsScheme = uri.scheme == 'http' ? 'ws' : 'wss';
    return Uri(
      scheme: wsScheme,
      userInfo: uri.userInfo,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
      path: '/agent/files',
    );
  }

  String _friendlyConnectionError(Object error) {
    final raw = error.toString();
    if (raw.contains('Operation not permitted')) {
      return '网络连接被系统拒绝：Android 构建缺 INTERNET 权限或系统网络策略阻止。请安装修复后的新版 Zephyr Agent。';
    }
    if (raw.contains('CERTIFICATE_VERIFY_FAILED') || raw.contains('HandshakeException')) {
      return 'TLS/证书验证失败：请使用受信任 HTTPS 证书，或在主端地址填写正确域名。';
    }
    if (raw.contains('Connection refused')) return '主端拒绝连接：请确认地址、端口和 Zephyr 服务正在运行。';
    if (raw.contains('Failed host lookup')) return '域名解析失败：请检查主端地址或 DNS/网络。';
    if (raw.contains('timed out') || raw.contains('TimeoutException')) return '连接超时：请检查网络、防火墙、反向代理 WebSocket 转发。';
    return raw;
  }

  Future<void> _connect() async {
    _setStatus(AgentStatus.connecting);
    _errorMessage = '';

    try {
      final normalizedServerUrl = normalizeServerUrl(_config.serverUrl);
      if (normalizedServerUrl.isEmpty) throw const FormatException('主端地址为空');
      final uri = agentWebSocketUriForServerUrl(normalizedServerUrl);
      _config.serverUrl = normalizedServerUrl;
      final customClient = _config.allowBadCertificates && uri.scheme == 'wss'
          ? (HttpClient()..badCertificateCallback = (_, __, ___) => true)
          : null;

      _channel = IOWebSocketChannel.connect(
        uri,
        pingInterval: Duration(seconds: 30),
        customClient: customClient,
      );

      await _channel!.ready;
      _channelSub = _channel!.stream.listen(
        _onMessage,
        onError: _onError,
        onDone: _onDone,
      );

      _setStatus(AgentStatus.authenticating);
      _sendHello();
    } catch (e) {
      _errorMessage = _friendlyConnectionError(e);
      _setStatus(AgentStatus.error);
      _maybeReconnect();
    }
  }

  Future<void> _disconnect() async {
    _channelSub?.cancel();
    _channelSub = null;
    try {
      await _channel?.sink.close();
    } catch (_) {}
    _channel = null;
  }

  // ─── Protocol ────────────────────────────────────────────────

  void _sendHello() {
    final deviceId = const Uuid().v5(Namespace.url.value, '${_config.serverUrl}:${_config.deviceName}');
    _send({
      'type': 'hello',
      'protocolVersion': 2,
      'token': _config.token,
      'deviceId': deviceId,
      'deviceName': _config.deviceName,
      'platform': _platformName(),
      'appVersion': AgentVersion.version,
      'capabilities': {
        'read': true,
        'write': !_config.readOnly,
        'delete': !_config.readOnly,
        'rename': !_config.readOnly,
        'mkdir': !_config.readOnly,
        'truncate': !_config.readOnly,
        'binary': true,
        'binaryRead': true,
        'binaryWrite': true,
        'cancel': true,
        'creditFlow': true,
        'maxInflight': 8,
        'maxChunkSize': 1 * 1024 * 1024,
      },
      'share': {
        'name': _config.sharedDirectoryName ?? _config.deviceName,
        'readOnly': _config.readOnly,
      },
    });
  }

  void _onMessage(dynamic raw) {
    if (raw is List<int>) {
      try {
        final bytes = raw is Uint8List ? raw : Uint8List.fromList(raw);
        if (bytes.length >= 4 && bytes[0] == 0x5a && bytes[1] == 0x46 && bytes[2] == 0x54 && bytes[3] == 0x32) {
          _handleZft2Frame(decodeZft2Frame(bytes));
          return;
        }
      } catch (_) {
        return;
      }
    }
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>));
    } catch (_) {
      return;
    }

    switch (msg['type']) {
      case 'hello_ack':
        _handleHelloAck(msg);
        break;
      case 'request':
        _handleRequest(msg);
        break;
      case 'pong':
        _missedHeartbeats = 0;
        break;
      default:
        break;
    }
  }

  void _handleZft2Frame(Zft2Frame frame) {
    if (frame.isResponse) return;
    if (frame.type == Zft2Op.cancel) {
      final target = (frame.meta['targetRequestId'] as num?)?.toInt() ?? -1;
      if (_zft2Tasks.containsKey(target)) _zft2Cancelled.add(target);
      return;
    }
    if (_zft2Tasks.length >= 8) {
      _sendBytes(encodeZft2Error(frame, 'busy', 'Agent request window is full', retryable: true));
      return;
    }
    final handle = frame.meta['handle']?.toString() ?? '';
    Future<void> run() async {
      try {
        final response = await _dispatchZft2(frame);
        if (!_zft2Cancelled.contains(frame.requestId)) _sendBytes(response);
      } catch (e) {
        final code = e is FileProviderException ? e.code : 'internal_error';
        if (!_zft2Cancelled.contains(frame.requestId)) _sendBytes(encodeZft2Error(frame, code, e.toString()));
      } finally {
        _zft2Tasks.remove(frame.requestId);
        _zft2Cancelled.remove(frame.requestId);
      }
    }
    Future<void> task;
    if (handle.isNotEmpty && [Zft2Op.read, Zft2Op.write, Zft2Op.close].contains(frame.type)) {
      final previous = _zft2HandleQueues[handle] ?? Future.value();
      task = previous.catchError((_) {}).then((_) => run());
      _zft2HandleQueues[handle] = task.whenComplete(() {
        if (identical(_zft2HandleQueues[handle], task)) _zft2HandleQueues.remove(handle);
      });
    } else {
      task = run();
    }
    _zft2Tasks[frame.requestId] = task;
  }

  Future<Uint8List> _dispatchZft2(Zft2Frame frame) async {
    final fp = _fileProvider;
    if (fp == null) throw FileProviderException('internal_error', 'No file provider');
    final meta = frame.meta;
    final mutating = [Zft2Op.write, Zft2Op.mkdir, Zft2Op.delete, Zft2Op.rename, Zft2Op.truncate];
    if (_config.readOnly && mutating.contains(frame.type)) throw FileProviderException('read_only', 'Share is read-only');
    Map<String, dynamic> result = {};
    Uint8List payload = Uint8List(0);
    switch (frame.type) {
      case Zft2Op.open:
        result = {'handle': await fp.open(meta['path'] as String, meta['mode'] as String? ?? 'read')};
        break;
      case Zft2Op.read:
        payload = await fp.read(meta['handle'] as String, (meta['offset'] as num?)?.toInt() ?? 0, (meta['length'] as num?)?.toInt() ?? 262144);
        result = {'bytesRead': payload.length, 'eof': payload.isEmpty};
        _recordTransfer(payload.length);
        break;
      case Zft2Op.write:
        final written = await fp.write(meta['handle'] as String, (meta['offset'] as num?)?.toInt() ?? 0, frame.payload);
        result = {'bytesWritten': written};
        _recordTransfer(written);
        break;
      case Zft2Op.close:
        await fp.close(meta['handle'] as String);
        break;
      case Zft2Op.stat:
        result = (await fp.stat(meta['path'] as String? ?? '/')).toJson();
        break;
      case Zft2Op.list:
        final entries = await fp.list(meta['path'] as String? ?? '/');
        result = {'entries': entries.map((e) => e.toJson()).toList()};
        break;
      case Zft2Op.mkdir:
        await fp.mkdir(meta['path'] as String);
        break;
      case Zft2Op.delete:
        await fp.delete(meta['path'] as String, recursive: meta['recursive'] == true);
        break;
      case Zft2Op.rename:
        await fp.rename(meta['oldPath'] as String, meta['newPath'] as String);
        break;
      case Zft2Op.truncate:
        await fp.truncate(meta['path'] as String, (meta['size'] as num?)?.toInt() ?? 0);
        break;
      case Zft2Op.ping:
        result = {'agentTime': DateTime.now().millisecondsSinceEpoch};
        break;
      default:
        throw FileProviderException('unsupported', 'Unsupported ZFT2 operation: ${frame.type}');
    }
    _transferCount++;
    _scheduleTransferUiUpdate();
    return encodeZft2Response(frame, meta: result, payload: payload);
  }

  void _recordTransfer(int bytes) {
    _transferBytes += bytes;
    _scheduleTransferUiUpdate();
  }

  void _scheduleTransferUiUpdate() {
    _transferUiDirty = true;
    if (_transferUiTimer != null) return;
    _transferUiTimer = Timer(const Duration(milliseconds: 250), () {
      _transferUiTimer = null;
      if (!_transferUiDirty) return;
      _transferUiDirty = false;
      notifyListeners();
    });
  }

  void _sendBytes(Uint8List bytes) {
    try { _channel?.sink.add(bytes); } catch (_) {}
  }

  void _handleHelloAck(Map<String, dynamic> msg) {
    if (msg['ok'] == true) {
      _agentId = msg['agentId'] as String?;
      _heartbeatIntervalMs = (msg['heartbeatIntervalMs'] as int?) ?? 15000;
      _setStatus(AgentStatus.online);
      _reconnectAttempts = 0;
      _startHeartbeat();
      _startShutdownTimer();
    } else {
      final error = msg['error'] as Map<String, dynamic>?;
      _errorMessage = error?['message'] as String? ?? 'Authentication failed';
      _setStatus(AgentStatus.error);
      // Don't reconnect on auth failure
    }
  }

  void _handleRequest(Map<String, dynamic> msg) async {
    final id = msg['id'] as String?;
    final method = msg['method'] as String?;
    final params = msg['params'] as Map<String, dynamic>? ?? {};

    if (id == null || method == null) return;

    if (_fileProvider == null) {
      _sendResponse(id, false, error: {'code': 'internal_error', 'message': 'No file provider'});
      return;
    }

    // Check read-only constraints
    if (_config.readOnly && ['write', 'mkdir', 'delete', 'rename', 'truncate'].contains(method)) {
      _sendResponse(id, false, error: {'code': 'read_only', 'message': 'Share is read-only'});
      return;
    }

    try {
      if (method == 'readBinary') {
        final data = await _fileProvider!.read(
          params['handle'] as String,
          params['offset'] as int? ?? 0,
          params['length'] as int? ?? 262144,
        );
        _transferCount++;
        _transferBytes += data.length;
        notifyListeners();
        _sendBinaryResponse(id, data);
        return;
      }

      final result = await _dispatchRpc(method, params);
      _transferCount++;
      _sendResponse(id, true, result: result);
    } catch (e) {
      _sendResponse(id, false, error: {
        'code': e is FileProviderException ? e.code : 'internal_error',
        'message': e.toString(),
      });
    }
  }

  Future<Map<String, dynamic>> _dispatchRpc(String method, Map<String, dynamic> params) async {
    final fp = _fileProvider!;
    switch (method) {
      case 'list':
        final entries = await fp.list(params['path'] as String? ?? '/');
        return {'entries': entries.map((e) => e.toJson()).toList()};
      case 'stat':
        final stat = await fp.stat(params['path'] as String? ?? '/');
        return stat.toJson();
      case 'open':
        final handle = await fp.open(params['path'] as String, params['mode'] as String? ?? 'read');
        return {'handle': handle};
      case 'read':
        throw FileProviderException('unsupported', 'Base64 reads are disabled in protocol v2');
      case 'write':
        throw FileProviderException('unsupported', 'Base64 writes are disabled in protocol v2');
      case 'close':
        await fp.close(params['handle'] as String);
        return {};
      case 'mkdir':
        await fp.mkdir(params['path'] as String);
        return {};
      case 'delete':
        await fp.delete(params['path'] as String, recursive: params['recursive'] as bool? ?? false);
        return {};
      case 'rename':
        await fp.rename(params['oldPath'] as String, params['newPath'] as String);
        return {};
      case 'truncate':
        await fp.truncate(params['path'] as String, params['size'] as int? ?? 0);
        return {};
      default:
        throw FileProviderException('unsupported', 'Unsupported method: $method');
    }
  }

  // ─── Heartbeat ───────────────────────────────────────────────

  void _startHeartbeat() {
    _cancelHeartbeat();
    _heartbeatTimer = Timer.periodic(Duration(milliseconds: _heartbeatIntervalMs), (_) {
      if (_status != AgentStatus.online) return;
      _missedHeartbeats++;
      if (_missedHeartbeats >= 3) {
        _errorMessage = 'Heartbeat timeout';
        _setStatus(AgentStatus.error);
        _disconnect();
        _maybeReconnect();
        return;
      }
      _send({'type': 'ping', 'time': DateTime.now().millisecondsSinceEpoch});
    });
  }

  void _cancelHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _missedHeartbeats = 0;
  }

  // ─── Auto-shutdown ───────────────────────────────────────────

  void _startShutdownTimer() {
    if (!_config.autoShutdown) return;
    _cancelShutdownTimer();
    _shutdownAt = DateTime.now().add(Duration(minutes: _config.autoShutdownMinutes));
    _shutdownTimer = Timer(Duration(minutes: _config.autoShutdownMinutes), () {
      _send({
        'type': 'agent_auto_shutdown',
        'agentId': _agentId ?? '',
        'reason': 'timeout_${_config.autoShutdownMinutes}min',
      });
      stop();
      _errorMessage = '已因 ${_config.autoShutdownMinutes} 分钟超时自动关闭';
      _setStatus(AgentStatus.stopped);
    });
    notifyListeners();
  }

  void extendShutdown() {
    if (!_config.autoShutdown || _status != AgentStatus.online) return;
    _startShutdownTimer();
  }

  void _cancelShutdownTimer() {
    _shutdownTimer?.cancel();
    _shutdownTimer = null;
    _shutdownAt = null;
  }

  // ─── Reconnect ───────────────────────────────────────────────

  void _maybeReconnect() {
    if (_status == AgentStatus.stopped) return;
    if (_reconnectAttempts >= _maxReconnectAttempts) {
      _setStatus(AgentStatus.error);
      _errorMessage = 'Max reconnect attempts reached';
      return;
    }
    _setStatus(AgentStatus.reconnecting);
    _reconnectAttempts++;
    final delay = Duration(seconds: _reconnectAttempts.clamp(1, 30));
    _reconnectTimer = Timer(delay, () => _connect());
  }

  void _cancelReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  // ─── Error/Close handlers ────────────────────────────────────

  void _onError(Object error) {
    _errorMessage = _friendlyConnectionError(error);
    if (_status == AgentStatus.online || _status == AgentStatus.authenticating || _status == AgentStatus.connecting) {
      _setStatus(AgentStatus.error);
      _cancelHeartbeat();
      _maybeReconnect();
    }
  }

  void _onDone() {
    _cancelHeartbeat();
    if (_status == AgentStatus.online || _status == AgentStatus.authenticating) {
      _errorMessage = 'Connection closed';
      _setStatus(AgentStatus.error);
      _maybeReconnect();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────

  void _send(Map<String, dynamic> msg) {
    try {
      _channel?.sink.add(jsonEncode(msg));
    } catch (_) {}
  }

  void _sendResponse(String id, bool ok, {Map<String, dynamic>? result, Map<String, dynamic>? error}) {
    _send({
      'id': id,
      'type': 'response',
      'ok': ok,
      if (ok && result != null) 'result': result,
      if (!ok && error != null) 'error': error,
    });
  }

  void _sendBinaryResponse(String id, List<int> payload) {
    final idBytes = utf8.encode(id);
    if (idBytes.length > 65535) {
      _sendResponse(id, false, error: {'code': 'invalid_parameter', 'message': 'Request id too long'});
      return;
    }
    final out = Uint8List(4 + 2 + idBytes.length + payload.length);
    // Magic: ZFB1
    out[0] = 0x5A;
    out[1] = 0x46;
    out[2] = 0x42;
    out[3] = 0x31;
    out[4] = (idBytes.length >> 8) & 0xFF;
    out[5] = idBytes.length & 0xFF;
    out.setRange(6, 6 + idBytes.length, idBytes);
    out.setRange(6 + idBytes.length, out.length, payload);
    try {
      _channel?.sink.add(out);
    } catch (_) {}
  }

  void _setStatus(AgentStatus newStatus) {
    if (_status == newStatus) return;
    _status = newStatus;
    notifyListeners();
  }

  String _platformName() {
    if (kIsWeb) return 'web';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isWindows) return 'windows';
    if (Platform.isLinux) return 'linux';
    return 'unknown';
  }

  @override
  void dispose() {
    _transferUiTimer?.cancel();
    _zft2Tasks.clear();
    _zft2HandleQueues.clear();
    _zft2Cancelled.clear();
    _cancelShutdownTimer();
    _cancelHeartbeat();
    _cancelReconnect();
    _disconnect();
    super.dispose();
  }
}
