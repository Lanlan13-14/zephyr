import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/services.dart';
import 'file_transfer_protocol.dart';

/// Pumps the Agent's ZFT2 file dispatcher onto the encrypted Link zft2 lane.
///
/// The embedded Go runtime mirrors every zft2 lane on a loopback WebSocket
/// (/link/zft2/stream). Each binary message is [lane id u32 BE][ZFT2 frame].
/// Frames reuse the SAME dispatcher the legacy WebSocket path used — the
/// protocol never changed, only the carrier, so semantics (queueing, cancel,
/// window) are identical.
class Zft2LinkLaneClient {
  static const _channel = MethodChannel('com.zephyr.agent/link');
  final void Function(int laneId, Uint8List frame) onFrame;
  final Future<void> Function() onLost;
  WebSocket? _socket;
  bool _connecting = false;
  bool _closed = false;
  bool get attached => _socket != null;

  Zft2LinkLaneClient({required this.onFrame, required this.onLost});

  Future<int> _localPort() async {
    final port = await _channel.invokeMethod<int>('linkZft2Port');
    if (port == null || port <= 0) throw StateError('zft2 local port unavailable');
    return port;
  }

  /// Connect (idempotent) and start pumping. Reconnect-safe.
  Future<void> connect() async {
    if (_closed || _connecting || _socket != null) return;
    _connecting = true;
    try {
      final port = await _localPort();
      final socket = await WebSocket.connect('ws://127.0.0.1:$port/link/zft2/stream');
      if (_closed) { await socket.close(); return; }
      _socket = socket;
      socket.listen(
        (data) {
          if (data is! List<int> || data.length < 4) return;
          final laneId = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
          onFrame(laneId, Uint8List.fromList(data.sublist(4)));
        },
        onDone: () { _socket = null; onLost(); },
        onError: (_) { _socket = null; onLost(); },
        cancelOnError: true,
      );
    } catch (_) {
      _socket = null;
      rethrow;
    } finally {
      _connecting = false;
    }
  }

  /// Send one framed reply back onto the main end via the lane socket.
  void reply(int laneId, Uint8List frame) {
    final socket = _socket;
    if (socket == null) return;
    final out = BytesBuilder(copy: false);
    final header = ByteData(4)..setUint32(0, laneId, Endian.big);
    out.add(header.buffer.asUint8List());
    out.add(frame);
    try { socket.add(out.takeBytes()); } catch (_) {}
  }

  Future<void> close() async {
    _closed = true;
    final s = _socket;
    _socket = null;
    await s?.close();
  }
}
