// Platform-abstracted file provider for Zephyr Agent.

import 'dart:io' as io;
import 'dart:typed_data';
import 'package:flutter/services.dart';
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

class _DesktopOpenFile {
  final String path;
  final io.RandomAccessFile file;
  final bool writable;
  _DesktopOpenFile(this.path, this.file, this.writable);
}

/// Desktop file provider using dart:io.
///
/// Uses a platform-aware path context so Windows drive roots (`C:\`) join and
/// validate correctly. Directory listings skip entries that throw on stat so a
/// single protected/system item cannot fail an entire drive enumeration.
class DesktopFileProvider extends ZephyrFileProvider {
  final String rootDir;
  final Map<String, _DesktopOpenFile> _openFiles = {};
  final _uuid = const Uuid();
  late final p.Context _path;
  late final String _normalizedRoot;

  DesktopFileProvider(this.rootDir) {
    _path = p.Context(
      style: io.Platform.isWindows ? p.Style.windows : p.Style.posix,
    );
    _normalizedRoot = _normalizeRoot(rootDir);
  }

  static String _normalizeRoot(String root) {
    final raw = root.trim();
    if (raw.isEmpty) return raw;
    if (io.Platform.isWindows) {
      final withSep = raw.replaceAll('/', '\\');
      // Keep drive roots as `C:\` (not `C:`) so joins stay on the drive.
      if (RegExp(r'^[A-Za-z]:$').hasMatch(withSep)) {
        return '$withSep\\';
      }
      if (RegExp(r'^[A-Za-z]:\\$').hasMatch(withSep)) {
        return withSep;
      }
      return p.Context(style: p.Style.windows).normalize(withSep);
    }
    return p.Context(style: p.Style.posix).normalize(raw);
  }

  String _virtualJoin(String parent, String name) {
    final cleanedParent = parent.replaceAll('\\', '/');
    if (cleanedParent.isEmpty || cleanedParent == '/') return '/$name';
    return '${cleanedParent.replaceAll(RegExp(r'/+$'), '')}/$name';
  }

  String _resolve(String virtualPath) {
    final cleaned = virtualPath
        .replaceAll('\\', '/')
        .split('/')
        .where((s) => s.isNotEmpty && s != '.' && s != '..')
        .join('/');
    if (cleaned.isEmpty) return _normalizedRoot;
    final joined = _path.join(_normalizedRoot, cleaned);
    return _path.normalize(joined);
  }

  void _validatePath(String virtualPath) {
    final resolved = _resolve(virtualPath);
    final root = _normalizedRoot;
    if (resolved == root) return;
    // package:path isWithin treats equal paths as false; drive-root siblings
    // must still be rejected via relative() prefix check.
    final rel = _path.relative(resolved, from: root);
    final escaped = rel == '..' ||
        rel.startsWith('..${_path.separator}') ||
        rel.startsWith('../') ||
        rel.startsWith('..\\') ||
        _path.isAbsolute(rel);
    if (escaped) {
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
    // followLinks: false avoids cycles and dangling-link crashes on macOS/Windows.
    await for (final entity in dir.list(followLinks: false)) {
      try {
        final s = await entity.stat();
        final name = _path.basename(entity.path);
        if (name.isEmpty || name == '.' || name == '..') continue;
        final vPath = _virtualJoin(path, name);
        entries.add(ZephyrFileStat(
          name: name,
          path: vPath,
          isDir: s.type == io.FileSystemEntityType.directory,
          size: s.size,
          mtime: s.modified.millisecondsSinceEpoch,
        ));
      } catch (_) {
        // Skip unreadable/system entries instead of failing the whole listing.
        // Mapping C:\ or / otherwise dies on the first protected item.
        continue;
      }
    }
    return entries;
  }

  @override
  Future<ZephyrFileStat> stat(String path) async {
    _validatePath(path);
    final resolved = _resolve(path);
    final type = io.FileSystemEntity.typeSync(resolved, followLinks: false);
    if (type == io.FileSystemEntityType.notFound) {
      throw FileProviderException('not_found', 'Not found: $path');
    }
    final s = await io.FileStat.stat(resolved);
    return ZephyrFileStat(
      name: _path.basename(resolved),
      path: path,
      isDir: type == io.FileSystemEntityType.directory,
      size: s.size,
      mtime: s.modified.millisecondsSinceEpoch,
    );
  }

  /// Open a file for random-access write WITHOUT truncating existing content.
  ///
  /// Dart's [io.FileMode.write] always truncates. RDP in-place opens must
  /// preserve bytes. Use [io.FileMode.append] then seek(0): it is O_RDWR-like
  /// without O_TRUNC on POSIX and does not rewrite multi-GB files on open.
  /// Never fall back to "copy whole file then rewrite" — that stalls CREATE
  /// and drops the RDP drive with 0x8007048F on large Agent copies.
  Future<io.RandomAccessFile> _openWritablePreserve(io.File file) async {
    if (!await file.exists()) {
      await file.create(recursive: true);
    }
    final raf = await file.open(mode: io.FileMode.append);
    await raf.setPosition(0);
    return raf;
  }

  @override
  Future<String> open(String path, String mode) async {
    _validatePath(path);
    final resolved = _resolve(path);
    final file = io.File(resolved);

    final wantsWrite = mode == 'write' || mode == 'writeTruncate';
    late final io.RandomAccessFile raf;

    if (wantsWrite) {
      await file.parent.create(recursive: true);
      if (mode == 'writeTruncate') {
        raf = await file.open(mode: io.FileMode.write);
      } else {
        raf = await _openWritablePreserve(file);
      }
    } else {
      if (!await file.exists()) {
        throw FileProviderException('not_found', 'File not found: $path');
      }
      raf = await file.open(mode: io.FileMode.read);
    }

    final handle = 'h_${_uuid.v4().substring(0, 8)}';
    _openFiles[handle] = _DesktopOpenFile(resolved, raf, wantsWrite);
    return handle;
  }

  @override
  Future<Uint8List> read(String handle, int offset, int length) async {
    final opened = _openFiles[handle];
    if (opened == null) {
      throw FileProviderException('not_found', 'Invalid handle');
    }
    // Independent FD per read so parallel readahead cannot race position.
    final raf = await io.File(opened.path).open(mode: io.FileMode.read);
    try {
      await raf.setPosition(offset);
      return await raf.read(length);
    } finally {
      await raf.close();
    }
  }

  @override
  Future<int> write(String handle, int offset, Uint8List data) async {
    final opened = _openFiles[handle];
    if (opened == null) {
      throw FileProviderException('not_found', 'Invalid handle');
    }
    if (!opened.writable) {
      throw FileProviderException('read_only', 'Handle is not writable');
    }
    await opened.file.setPosition(offset);
    await opened.file.writeFrom(data);
    return data.length;
  }

  @override
  Future<void> close(String handle) async {
    final opened = _openFiles.remove(handle);
    if (opened != null) await opened.file.close();
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
    final type = io.FileSystemEntity.typeSync(resolved, followLinks: false);
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
    final type = io.FileSystemEntity.typeSync(oldResolved, followLinks: false);
    if (type == io.FileSystemEntityType.directory) {
      await io.Directory(oldResolved).rename(newResolved);
    } else {
      await io.File(oldResolved).rename(newResolved);
    }
  }

  @override
  Future<void> truncate(String path, int size) async {
    _validatePath(path);
    final raf =
        await io.File(_resolve(path)).open(mode: io.FileMode.writeOnlyAppend);
    await raf.truncate(size);
    await raf.close();
  }

  void closeAll() {
    for (final opened in _openFiles.values) {
      try {
        opened.file.closeSync();
      } catch (_) {}
    }
    _openFiles.clear();
  }
}

class AndroidStorageAccess {
  static const MethodChannel _channel = MethodChannel('com.zephyr.agent/saf');

  static Future<bool> hasAllFilesAccess() async {
    try {
      return await _channel.invokeMethod<bool>('hasAllFilesAccess') ?? false;
    } on PlatformException {
      return false;
    }
  }

  static Future<void> openAllFilesAccessSettings() async {
    await _channel.invokeMethod<void>('openAllFilesAccessSettings');
  }

  static Future<String> externalStorageRoot() async {
    try {
      return await _channel.invokeMethod<String>('externalStorageRoot') ??
          '/storage/emulated/0';
    } on PlatformException {
      return '/storage/emulated/0';
    }
  }
}

/// Android Storage Access Framework provider.
class AndroidSafFileProvider extends ZephyrFileProvider {
  static const MethodChannel _channel = MethodChannel('com.zephyr.agent/saf');
  final String rootUri;

  AndroidSafFileProvider(this.rootUri);

  static Future<({String rootUri, String name})?> selectDirectory() async {
    final result =
        await _channel.invokeMethod<Map<dynamic, dynamic>>('selectDirectory');
    if (result == null) return null;
    return (
      rootUri: result['uri'] as String,
      name: (result['name'] as String?) ?? 'Android Share',
    );
  }

  Map<String, Object?> _baseArgs([Map<String, Object?>? extra]) => {
        'rootUri': rootUri,
        if (extra != null) ...extra,
      };

  ZephyrFileStat _statFromMap(Map<dynamic, dynamic> map) {
    return ZephyrFileStat(
      name: map['name'] as String? ?? '',
      path: map['path'] as String? ?? '/',
      isDir: map['isDir'] == true,
      size: (map['size'] as num?)?.toInt() ?? 0,
      mtime: (map['mtime'] as num?)?.toInt() ?? 0,
    );
  }

  Future<T> _invoke<T>(String method, Map<String, Object?> args) async {
    try {
      final result = await _channel.invokeMethod<T>(method, args);
      if (result == null) {
        throw FileProviderException(
          'internal_error',
          'No result from Android SAF method: $method',
        );
      }
      return result;
    } on PlatformException catch (e) {
      throw FileProviderException(e.code, e.message ?? e.code);
    }
  }

  Future<void> _invokeVoid(String method, Map<String, Object?> args) async {
    try {
      await _channel.invokeMethod<void>(method, args);
    } on PlatformException catch (e) {
      throw FileProviderException(e.code, e.message ?? e.code);
    }
  }

  @override
  Future<List<ZephyrFileStat>> list(String path) async {
    final result =
        await _invoke<List<dynamic>>('list', _baseArgs({'path': path}));
    return result
        .map((e) => _statFromMap(e as Map<dynamic, dynamic>))
        .toList();
  }

  @override
  Future<ZephyrFileStat> stat(String path) async {
    final result =
        await _invoke<Map<dynamic, dynamic>>('stat', _baseArgs({'path': path}));
    return _statFromMap(result);
  }

  @override
  Future<String> open(String path, String mode) async {
    final handle = await _invoke<String>(
      'open',
      _baseArgs({'path': path, 'mode': mode}),
    );
    return handle;
  }

  @override
  Future<Uint8List> read(String handle, int offset, int length) async {
    final data = await _invoke<Uint8List>(
      'read',
      _baseArgs({
        'handle': handle,
        'offset': offset,
        'length': length,
      }),
    );
    return data;
  }

  @override
  Future<int> write(String handle, int offset, Uint8List data) async {
    final written = await _invoke<int>(
      'write',
      _baseArgs({
        'handle': handle,
        'offset': offset,
        'data': data,
      }),
    );
    return written;
  }

  @override
  Future<void> close(String handle) async {
    await _invokeVoid('close', _baseArgs({'handle': handle}));
  }

  @override
  Future<void> mkdir(String path) async {
    await _invokeVoid('mkdir', _baseArgs({'path': path}));
  }

  @override
  Future<void> delete(String path, {bool recursive = false}) async {
    await _invokeVoid(
      'delete',
      _baseArgs({'path': path, 'recursive': recursive}),
    );
  }

  @override
  Future<void> rename(String oldPath, String newPath) async {
    await _invokeVoid(
      'rename',
      _baseArgs({'oldPath': oldPath, 'newPath': newPath}),
    );
  }

  @override
  Future<void> truncate(String path, int size) async {
    await _invokeVoid('truncate', _baseArgs({'path': path, 'size': size}));
  }
}
