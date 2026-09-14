// Agent-side Link runtime contract.
//
// Cryptography is intentionally not implemented in Dart. Platform hosts must
// expose the shared zephyr-link Go runtime and return true only after the
// existing ZSL/2 enrollment handshake has completed.
import 'dart:async';

class LinkFileRuntime {
  bool _ready = false;
  String? _sessionId;
  bool _tunnelUp = false;

  bool get ready => _ready && _sessionId != null;
  String? get sessionId => _sessionId;
  /// Whether the bastion tunnel hub is pumping on the encrypted Link stream.
  bool get tunnelUp => _tunnelUp;

  void markConnected(String sessionId) {
    _ready = true;
    _sessionId = sessionId;
  }

  void markTunnelUp() { _tunnelUp = true; }
  void markTunnelDown() { _tunnelUp = false; }

  void markDisconnected() {
    _ready = false;
    _sessionId = null;
    _tunnelUp = false;
  }

  Future<bool> connect({required String serverUrl, required String deviceId, bool allowBadCertificates = false}) async {
    // The native host owns the Go runtime and must override this method through
    // the platform adapter before enabling the capability advertisement.
    _ready = false;
    _sessionId = null;
    return false;
  }

  Future<Map<String, dynamic>> mlkemGenerate(String deviceId) async => throw UnimplementedError('ML-KEM unavailable');
  Future<String> mlkemPublic(String deviceId) async => throw UnimplementedError('ML-KEM unavailable');
  Future<String> enrollmentProof(String bindId, {required String deviceId, required String userCode, required String sas, required String enrollmentSecret, required String serverId}) async => throw UnimplementedError('enrollment proof unavailable');

  Future<LinkFileReply> request(String op, Map<String, dynamic> params) async {
    if (!ready) throw StateError('Agent Link runtime is not connected');
    throw UnimplementedError('Platform Link runtime adapter is unavailable');
  }

  Future<void> close() async {
    _ready = false;
    _sessionId = null;
  }
}

class LinkFileReply {
  final Map<String, dynamic> body;
  final List<int>? binary;

  const LinkFileReply(this.body, {this.binary});
}
