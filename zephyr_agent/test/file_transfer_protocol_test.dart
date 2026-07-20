import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/agent/file_transfer_protocol.dart';

void main() {
  test('ZFT2 frame round-trips metadata and binary payload', () {
    final raw = encodeZft2Frame(
      Zft2Frame(
        type: Zft2Op.write,
        requestId: 0xfeedbeef,
        flags: zft2FlagResponse,
        meta: {'handle': 'h1', 'offset': 4294967296},
        payload: Uint8List.fromList([0, 1, 2, 253, 254, 255]),
      ),
    );
    final decoded = decodeZft2Frame(raw);
    expect(decoded.type, Zft2Op.write);
    expect(decoded.requestId, 0xfeedbeef);
    expect(decoded.flags, zft2FlagResponse);
    expect(decoded.meta['handle'], 'h1');
    expect(decoded.meta['offset'], 4294967296);
    expect(decoded.payload, [0, 1, 2, 253, 254, 255]);
  });

  test('ZFT2 rejects malformed and oversized frames', () {
    expect(
      () => decodeZft2Frame(Uint8List(3)),
      throwsA(isA<Zft2ProtocolException>()),
    );
    final badMagic = Uint8List(zft2HeaderBytes);
    expect(
      () => decodeZft2Frame(badMagic),
      throwsA(isA<Zft2ProtocolException>()),
    );
    expect(
      () => encodeZft2Frame(
        Zft2Frame(
          type: Zft2Op.write,
          requestId: 1,
          payload: Uint8List(zft2MaxPayloadBytes + 1),
        ),
      ),
      throwsA(isA<Zft2ProtocolException>()),
    );
  });
}
