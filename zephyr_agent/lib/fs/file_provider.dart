/// Platform-abstracted file provider for Zephyr Agent.

import 'dart:io' as io;
import 'dart:typed_data';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';

class FileProviderException implements Exception {
  final String code;
  final String message;
  FileProviderException(this.code, this.message);
  @override
  String toString() => message;
}

class ZephyrFileStat {
  final String name;
  final String path;
  final bool isDir;
  final int size;
  final int mtime;

  ZephyrFileStat({
    required this.name,
    required this.path,
    required this.isDir,
    required this.size,
    required this.mtime,
  });

  Map<String, dynamic> toJson() => {
    'name': name,
    'path': path,
    'isDir': isDir,
    'size': size,
    'mtime': mtime,
    'canRead': true,
    'canWrite': true,
  };
}

/// Abstract file provider interface.
abstract class ZephyrFileProvider {
  Future<List<ZephyrFileStat>> list(String path);
  Future<ZephyrFileStat> stat(String path);
  Future<String> open(String path, String mode);
  Future<Uint8List> read(String handle, int offset, int length);
  Future<int> write(String handle, int offset, Uint8List data);
  Future<void> close(String handle);
  Future<void> mkdir(String path);
  Future<void> delete(String path, {bool recursive = false});
  Future<void> rename(String oldPath, String newPath);
  Future<void> truncate(String path, int size);
}

/// Desktop file provider using dart:io
class DesktopFileProvider extends ZephyrFileProvider {
  final String rootDir;
  final Map<String, io.RandomAccessFile> _openFiles = {};
  final _uuid = const Uuid();

  DesktopFileProvider(this.rootDir);

  String _resolve(String virtualPath) {
    final cleaned = virtualPath
        .replaceAll('\\', '/')
        .split('/')
        .where((s) => s.isNotEmpty && s != '.' && s != '..')
        .join('/');
    if (cleaned.isEmpty) return rootDir;
    return p.join(rootDir, cleaned);
  }

  void _validatePath(String virtualPath) {
    final resolved = _resolve(virtualPath);
    if (!p.isWithin(rootDir, resolved) && resolved != rootDir) {
      throw FileProviderException('invalid_path', 'Path traversal blocked');
    }
  }

  @override
  Future<List<ZephyrFileStat>> list(String path) async {
    _validatePath(path);
    final dir = io.Directory(_resolve(path));
    if (!await dir.exists()) {
      throw FileProviderException('not_found', 'Directory not found: $path');
    }
    final entries = <ZephyrFileStat>[];
    await for (final entity in dir.list()) {
      final s = await entity.stat();
      final name = p.basename(entity.path);
      final vPath = path == '/' ? '/$name' : '$path/$name';
      entries.add(ZephyrFileStat(
        name: name,
        path: vPath,
        isDir: s.type == io.FileSystemEntityType.directory,
        size: s.size,
        mtime: s.modified.millisecondsSinceEpoch,
      ));
    }
    return entries;
  }

  @override
  Future<ZephyrFileStat> stat(String path) async {
    _validatePath(path);
    final resolved = _resolve(path);
    final type = io.FileSystemEntity.typeSync(resolved);
    if (type == io.FileSystemEntityType.notFound) {
      throw FileProviderException('not_found', 'Not found: $path');
    }
    final s = await io.FileStat.stat(resolved);
    return ZephyrFileStat(
      name: p.basename(resolved),
      path: path,
      isDir: type == io.FileSystemEntityType.directory,
      size: s.size,
      mtime: s.modified.millisecondsSinceEpoch,
    );
  }

  @override
  Future<String> open(String path, String mode) async {
    _validatePath(path);
    final resolved = _resolve(path);
    final file = io.File(resolved);

    if (mode == 'write') {
      await file.parent.create(recursive: true);
      if (!await file.exists()) {
        await file.create();
      }
    }

    if (!await file.exists()) {
      throw FileProviderException('not_found', 'File not found: $path');
    }

    final fileMode = mode == 'write' ? io.FileMode.writeOnlyAppend : io.FileMode.read;
    final raf = await file.open(mode: fileMode);
    final handle = 'h_${_uuid.v4().substring(0, 8)}';
    _openFiles[handle] = raf;
    return handle;
  }

  @override
  Future<Uint8List> read(String handle, int offset, int length) async {
    final raf = _openFiles[handle];
    if (raf == null) throw FileProviderException('not_found', 'Invalid handle');
    await raf.setPosition(offset);
    return await raf.read(length);
  }

  @override
  Future<int> write(String handle, int offset, Uint8List data) async {
    final raf = _openFiles[handle];
    if (raf == null) throw FileProviderException('not_found', 'Invalid handle');
    await raf.setPosition(offset);
    await raf.writeFrom(data);
    return data.length;
  }

  @override
  Future<void> close(String handle) async {
    final raf = _openFiles.remove(handle);
    if (raf != null) await raf.close();
  }

  @override
  Future<void> mkdir(String path) async {
    _validatePath(path);
    await io.Directory(_resolve(path)).create(recursive: true);
  }

  @override
  Future<void> delete(String path, {bool recursive = false}) async {
    _validatePath(path);
    final resolved = _resolve(path);
    final type = io.FileSystemEntity.typeSync(resolved);
    if (type == io.FileSystemEntityType.directory) {
      await io.Directory(resolved).delete(recursive: recursive);
    } else {
      await io.File(resolved).delete();
    }
  }

  @override
  Future<void> rename(String oldPath, String newPath) async {
    _validatePath(oldPath);
    _validatePath(newPath);
    final oldResolved = _resolve(oldPath);
    final newResolved = _resolve(newPath);
    final type = io.FileSystemEntity.typeSync(oldResolved);
    if (type == io.FileSystemEntityType.directory) {
      await io.Directory(oldResolved).rename(newResolved);
    } else {
      await io.File(oldResolved).rename(newResolved);
    }
  }

  @override
  Future<void> truncate(String path, int size) async {
    _validatePath(path);
    final raf = await io.File(_resolve(path)).open(mode: io.FileMode.writeOnlyAppend);
    await raf.truncate(size);
    await raf.close();
  }

  void closeAll() {
    for (final raf in _openFiles.values) {
      try { raf.closeSync(); } catch (_) {}
    }
    _openFiles.clear();
  }
}
