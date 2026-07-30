import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zephyr_agent/fs/file_provider.dart';

void main() {
  group('DesktopFileProvider', () {
    test('write mode preserves existing bytes until overwritten', () async {
      final dir = await Directory.systemTemp.createTemp(
        'zephyr_agent_provider_',
      );
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

    test('write mode can extend without copying or truncating', () async {
      final dir = await Directory.systemTemp.createTemp(
        'zephyr_agent_provider_',
      );
      try {
        final file = File('${dir.path}/hello.bin');
        await file.writeAsBytes([1, 2, 3, 4]);
        final provider = DesktopFileProvider(dir.path);
        final handle = await provider.open('/hello.bin', 'write');
        await provider.write(handle, 6, Uint8List.fromList([9, 10]));
        await provider.close(handle);
        expect(await file.readAsBytes(), [1, 2, 3, 4, 0, 0, 9, 10]);
      } finally {
        await dir.delete(recursive: true);
      }
    });

    test('writeTruncate replaces file contents', () async {
      final dir = await Directory.systemTemp.createTemp(
        'zephyr_agent_provider_',
      );
      try {
        final file = File('${dir.path}/hello.txt');
        await file.writeAsString('abcdef');
        final provider = DesktopFileProvider(dir.path);
        final handle = await provider.open('/hello.txt', 'writeTruncate');
        await provider.write(handle, 0, Uint8List.fromList('ZZ'.codeUnits));
        await provider.close(handle);
        expect(await file.readAsString(), 'ZZ');
      } finally {
        await dir.delete(recursive: true);
      }
    });

    test('list skips unreadable entries instead of failing whole directory',
        () async {
      final dir = await Directory.systemTemp.createTemp(
        'zephyr_agent_provider_',
      );
      try {
        await File('${dir.path}/ok.txt').writeAsString('hi');
        final ghost = File('${dir.path}/ghost-link');
        // Create a dangling symlink when the platform supports it.
        try {
          await Link(ghost.path).create('${dir.path}/does-not-exist');
        } catch (_) {
          // Windows without developer mode may not allow symlinks; still
          // verify normal listing works.
        }
        final provider = DesktopFileProvider(dir.path);
        final entries = await provider.list('/');
        expect(entries.any((e) => e.name == 'ok.txt'), isTrue);
      } finally {
        await dir.delete(recursive: true);
      }
    });

    test('concurrent offset reads return independent slices', () async {
      final dir = await Directory.systemTemp.createTemp(
        'zephyr_agent_provider_',
      );
      try {
        final file = File('${dir.path}/large.bin');
        await file.writeAsBytes(
          List<int>.generate(256 * 1024, (i) => i & 0xff),
        );
        final provider = DesktopFileProvider(dir.path);
        final handle = await provider.open('/large.bin', 'read');
        final results = await Future.wait([
          provider.read(handle, 0, 4096),
          provider.read(handle, 64 * 1024, 4096),
          provider.read(handle, 128 * 1024, 4096),
          provider.read(handle, 192 * 1024, 4096),
        ]);
        for (final bytes in results) {
          expect(bytes.length, 4096);
          expect(bytes.take(256), List<int>.generate(256, (i) => i));
        }
        await provider.close(handle);
      } finally {
        await dir.delete(recursive: true);
      }
    });

    test('path traversal outside root is rejected', () async {
      final dir = await Directory.systemTemp.createTemp(
        'zephyr_agent_provider_',
      );
      try {
        final provider = DesktopFileProvider(dir.path);
        expect(
          () => provider.stat('/../outside'),
          throwsA(isA<FileProviderException>()),
        );
      } finally {
        await dir.delete(recursive: true);
      }
    });
  });
}
