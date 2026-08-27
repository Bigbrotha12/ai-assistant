import 'dart:io';
import 'dart:typed_data';

import '../features/attachments/file_model.dart';
import '../features/attachments/file_utils.dart' as file_utils;

// The constructors assign public params to a private resolver field, which
// trips prefer_initializing_formals.
// ignore_for_file: prefer_initializing_formals

/// On-disk cache for downloaded files under an app-managed directory.
///
/// Files are stored as `<cacheDir>/<fileId><extension>` where the extension is
/// derived from the MIME type (`.jpg`, `.png`, `.webp`), which lets the OS open
/// previews without sniffing. Entries older than [ttl] are evicted, and the
/// total size is capped at [maxBytes].
class FileCache {
  FileCache({
    required Directory cacheDir,
    this.ttl = const Duration(days: 7),
    this.maxBytes = 50 * 1024 * 1024,
  }) : _resolveDir = _constantDir(cacheDir);

  static Future<Directory> Function() _constantDir(Directory dir) =>
      () async => dir;

  /// Like the default constructor but resolves the directory lazily on first
  /// use, which suits providers backed by async path_provider lookups.
  FileCache.async({
    required Future<Directory> Function() resolveDir,
    this.ttl = const Duration(days: 7),
    this.maxBytes = 50 * 1024 * 1024,
  }) : _resolveDir = resolveDir;

  final Future<Directory> Function() _resolveDir;
  Future<Directory>? _dirFuture;

  final Duration ttl;
  final int maxBytes;

  Future<Directory> _dir() => _dirFuture ??= _resolveDir();

  /// Writes [data] as `<fileId><extension>` and returns the absolute path.
  Future<String> cacheFile(
    String fileId,
    String extension,
    Uint8List data,
  ) async {
    final dir = await _dir();
    await dir.create(recursive: true);
    final file = File('${dir.path}/$fileId$extension');
    await file.writeAsBytes(data, flush: true);
    return file.absolute.path;
  }

  /// Returns [FileInfo] with [FileInfo.localPath] set to the absolute path
  /// when the cached file exists and is within [ttl]; null when missing or
  /// expired.
  Future<FileInfo?> getCached(String fileId) async {
    final file = await _findFile(fileId);
    if (file == null) return null;
    final stat = await file.stat();
    if (DateTime.now().difference(stat.modified) > ttl) return null;
    return _fileInfoFor(fileId, file, stat);
  }

  /// Returns every cached entry keyed by file id, from a single directory
  /// listing. Prefer over repeated [getCached] calls (each re-lists the
  /// directory) when enriching a whole file listing.
  Future<Map<String, FileInfo>> getAllCached() async {
    final dir = await _dir();
    if (!await dir.exists()) return const {};
    final now = DateTime.now();
    final result = <String, FileInfo>{};
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = _fileName(entity);
      final fileId = _idFromName(name);
      if (fileId.isEmpty) continue;
      final stat = await entity.stat();
      if (now.difference(stat.modified) > ttl) continue;
      result[fileId] = _fileInfoFor(fileId, entity, stat);
    }
    return result;
  }

  FileInfo _fileInfoFor(String fileId, File file, FileStat stat) {
    final name = _fileName(file);
    final extension = _extensionFromName(name);
    return FileInfo(
      id: fileId,
      filename: name,
      sizeBytes: stat.size,
      mimeType: _mimeForExtension(extension),
      cachedAt: stat.modified,
      localPath: file.absolute.path,
    );
  }

  /// Strips a known extension from a cached filename to recover the file id.
  /// `abc.jpg` -> `abc`; a bare `abc` stays `abc`.
  String _idFromName(String name) {
    final extension = _extensionFromName(name);
    if (extension.isEmpty || extension.length == name.length) return name;
    return name.substring(0, name.length - extension.length);
  }

  /// Deletes the cached file (and any index entry) for [fileId].
  Future<void> evict(String fileId) async {
    final file = await _findFile(fileId);
    if (file == null) return;
    try {
      await file.delete();
    } catch (_) {
      // Best-effort: a concurrently-deleted file is fine to ignore.
    }
  }

  /// Deletes entries older than [ttl], then evicts the oldest survivors until
  /// the total size drops below [maxBytes].
  Future<void> evictExpired() async {
    final dir = await _dir();
    if (!await dir.exists()) return;
    final now = DateTime.now();
    final survivors = <({File file, int size, DateTime modified})>[];
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final stat = await entity.stat();
      if (now.difference(stat.modified) > ttl) {
        try {
          await entity.delete();
        } catch (_) {}
      } else {
        survivors.add((file: entity, size: stat.size, modified: stat.modified));
      }
    }
    survivors.sort((a, b) => a.modified.compareTo(b.modified));
    var total = survivors.fold<int>(0, (sum, e) => sum + e.size);
    for (final entry in survivors) {
      if (total <= maxBytes) break;
      try {
        await entry.file.delete();
        total -= entry.size;
      } catch (_) {}
    }
  }

  /// Total on-disk bytes of every cached file.
  Future<int> get totalBytes async {
    final dir = await _dir();
    if (!await dir.exists()) return 0;
    var total = 0;
    await for (final entity in dir.list()) {
      if (entity is File) {
        total += await entity.length();
      }
    }
    return total;
  }

  /// Maps a MIME type to a file extension (`.jpg`, `.png`, `.webp`, or
  /// `.bin` for anything else).
  String extensionForMime(String mime) => file_utils.extensionForMime(mime);

  Future<File?> _findFile(String fileId) async {
    final dir = await _dir();
    if (!await dir.exists()) return null;
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = _fileName(entity);
      // Exact match only: the cache stores `<fileId><extension>` (or a bare
      // `<fileId>`), so id `abc` must not match an unrelated file whose name
      // merely starts with `abc.`.
      if (name == fileId) return entity;
      for (final ext in const ['.jpg', '.png', '.webp', '.bin']) {
        if (name == '$fileId$ext') return entity;
      }
    }
    return null;
  }

  String _fileName(File file) => file.uri.pathSegments.last;

  String _extensionFromName(String name) {
    final dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.substring(dot);
  }

  String _mimeForExtension(String extension) =>
      file_utils.mimeForExtension(extension);
}
