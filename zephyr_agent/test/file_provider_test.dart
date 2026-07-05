import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/fs/file_provider.dart';

void main() {
  group('DesktopFileProvider', () {
    test('write mode preserves existing bytes until overwritten', () async {
      final dir = await Directory.systemTemp.createTemp('zephyr_agent_provider_');
      try {
        final file = File('${dir.path}/hello.txt');
        await file.writeAsString('abcdef');
        final provider = DesktopFileProvider(dir.path);
        final handle = await provider.open('/hello.txt', 'write');
        await provider.write(handle, 2, Uint8List.fromList('XY'.codeUnits));
        await provider.close(handle);
        expect(await file.readAsString(), 'abXYef');
      } finally {
        await dir.delete(recursive: true);
      }
    });
  });
}
