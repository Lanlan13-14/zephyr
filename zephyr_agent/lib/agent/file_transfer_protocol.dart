import 'dart:convert';
import 'dart:typed_data';

const int zft2Version = 2;
const int zft2HeaderBytes = 20;
const int zft2FlagError = 0x0001;
const int zft2FlagResponse = 0x0002;
const int zft2MaxMetaBytes = 256 * 1024;
const int zft2MaxPayloadBytes = 1024 * 1024;

abstract final class Zft2Op {
  static const int open = 0x01;
  static const int read = 0x02;
  static const int write = 0x03;
  static const int close = 0x04;
  static const int stat = 0x05;
  static const int list = 0x06;
  static const int mkdir = 0x07;
  static const int delete = 0x08;
  static const int rename = 0x09;
  static const int truncate = 0x0a;
  static const int cancel = 0x0b;
  static const int ping = 0x0c;
}

class Zft2ProtocolException implements Exception {
  final String code;
  final String message;
  const Zft2ProtocolException(this.code, this.message);
  @override
  String toString() => message;
}

class Zft2Frame {
  final int type;
  final int requestId;
  final int flags;
  final Map<String, dynamic> meta;
  final Uint8List payload;

  Zft2Frame({
    required this.type,
    required this.requestId,
    this.flags = 0,
    this.meta = const {},
    Uint8List? payload,
  }) : payload = payload ?? Uint8List(0);

  bool get isResponse => flags & zft2FlagResponse != 0;
  bool get isError => flags & zft2FlagError != 0;
}

Uint8List encodeZft2Frame(Zft2Frame frame) {
  if (frame.type < 0 || frame.type > 255) {
    throw const Zft2ProtocolException(
      'invalid_type',
      'Invalid ZFT2 frame type',
    );
  }
  if (frame.requestId < 0 || frame.requestId > 0xffffffff) {
    throw const Zft2ProtocolException(
      'invalid_request_id',
      'Invalid ZFT2 request id',
    );
  }
  final metaBytes = Uint8List.fromList(utf8.encode(jsonEncode(frame.meta)));
  if (metaBytes.length > zft2MaxMetaBytes) {
    throw const Zft2ProtocolException(
      'metadata_too_large',
      'ZFT2 metadata exceeds limit',
    );
  }
  if (frame.payload.length > zft2MaxPayloadBytes) {
    throw const Zft2ProtocolException(
      'payload_too_large',
      'ZFT2 payload exceeds limit',
    );
  }
  final out = Uint8List(
    zft2HeaderBytes + metaBytes.length + frame.payload.length,
  );
  out.setRange(0, 4, const [0x5a, 0x46, 0x54, 0x32]);
  out[4] = zft2Version;
  out[5] = frame.type;
  final view = ByteData.sublistView(out);
  view.setUint16(6, frame.flags, Endian.big);
  view.setUint32(8, frame.requestId, Endian.big);
  view.setUint32(12, metaBytes.length, Endian.big);
  view.setUint32(16, frame.payload.length, Endian.big);
  out.setRange(zft2HeaderBytes, zft2HeaderBytes + metaBytes.length, metaBytes);
  out.setRange(zft2HeaderBytes + metaBytes.length, out.length, frame.payload);
  return out;
}

Zft2Frame decodeZft2Frame(List<int> raw) {
  final bytes = raw is Uint8List ? raw : Uint8List.fromList(raw);
  if (bytes.length < zft2HeaderBytes) {
    throw const Zft2ProtocolException(
      'truncated_header',
      'Truncated ZFT2 header',
    );
  }
  if (bytes[0] != 0x5a ||
      bytes[1] != 0x46 ||
      bytes[2] != 0x54 ||
      bytes[3] != 0x32) {
    throw const Zft2ProtocolException('bad_magic', 'Invalid ZFT2 magic');
  }
  if (bytes[4] != zft2Version) {
    throw Zft2ProtocolException(
      'unsupported_version',
      'Unsupported ZFT2 version ${bytes[4]}',
    );
  }
  final view = ByteData.sublistView(bytes);
  final metaLength = view.getUint32(12, Endian.big);
  final payloadLength = view.getUint32(16, Endian.big);
  if (metaLength > zft2MaxMetaBytes) {
    throw const Zft2ProtocolException(
      'metadata_too_large',
      'ZFT2 metadata exceeds limit',
    );
  }
  if (payloadLength > zft2MaxPayloadBytes) {
    throw const Zft2ProtocolException(
      'payload_too_large',
      'ZFT2 payload exceeds limit',
    );
  }
  final expected = zft2HeaderBytes + metaLength + payloadLength;
  if (bytes.length != expected) {
    throw Zft2ProtocolException(
      'length_mismatch',
      'ZFT2 frame length mismatch: expected $expected, got ${bytes.length}',
    );
  }
  Map<String, dynamic> meta = const {};
  if (metaLength > 0) {
    final decoded = jsonDecode(
      utf8.decode(bytes.sublist(zft2HeaderBytes, zft2HeaderBytes + metaLength)),
    );
    if (decoded is! Map<String, dynamic>) {
      throw const Zft2ProtocolException(
        'invalid_metadata',
        'ZFT2 metadata must be an object',
      );
    }
    meta = decoded;
  }
  return Zft2Frame(
    type: bytes[5],
    requestId: view.getUint32(8, Endian.big),
    flags: view.getUint16(6, Endian.big),
    meta: meta,
    payload: Uint8List.sublistView(bytes, zft2HeaderBytes + metaLength),
  );
}

Uint8List encodeZft2Response(
  Zft2Frame request, {
  Map<String, dynamic> meta = const {},
  Uint8List? payload,
}) {
  return encodeZft2Frame(
    Zft2Frame(
      type: request.type,
      requestId: request.requestId,
      flags: zft2FlagResponse,
      meta: meta,
      payload: payload ?? Uint8List(0),
    ),
  );
}

Uint8List encodeZft2Error(
  Zft2Frame request,
  String code,
  String message, {
  bool retryable = false,
}) {
  return encodeZft2Frame(
    Zft2Frame(
      type: request.type,
      requestId: request.requestId,
      flags: zft2FlagResponse | zft2FlagError,
      meta: {'code': code, 'message': message, 'retryable': retryable},
    ),
  );
}
