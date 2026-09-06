import 'dart:io';
import 'dart:typed_data';

import 'package:ai_assistant/features/attachments/data/file_cache.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory tempDir;
  late FileCache cache;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('file_cache_test');
    cache = FileCache(cacheDir: tempDir);
  });

  tearDown(() async {
    if (await tempDir.exists()) {
      await tempDir.delete(recursive: true);
    }
  });

  group('cacheFile / getCached', () {
    test('writes bytes and returns the absolute path', () async {
      final path = await cache.cacheFile('f1', '.jpg', Uint8List.fromList([1, 2, 3]));

      expect(File(path).isAbsolute, isTrue);
      expect(File(path).existsSync(), isTrue);
      expect(await File(path).length(), 3);
    });

    test('getCached returns FileInfo with localPath when present', () async {
      await cache.cacheFile('f1', '.png', Uint8List.fromList([9]));

      final info = await cache.getCached('f1');

      expect(info, isNotNull);
      expect(info!.id, 'f1');
      expect(info.localPath, isNotNull);
      expect(File(info.localPath!).existsSync(), isTrue);
      expect(info.sizeBytes, 1);
      expect(info.mimeType, 'image/png');
    });

    test('getCached returns null when missing', () async {
      expect(await cache.getCached('nope'), isNull);
    });

    test('getCached returns null when expired', () async {
      final shortTtl = FileCache(
        cacheDir: tempDir,
        ttl: const Duration(milliseconds: 10),
      );
      await shortTtl.cacheFile('f1', '.jpg', Uint8List.fromList([1]));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(await shortTtl.getCached('f1'), isNull);
    });
  });

  group('evict', () {
    test('removes the file', () async {
      await cache.cacheFile('f1', '.jpg', Uint8List.fromList([1]));

      await cache.evict('f1');

      expect(await cache.getCached('f1'), isNull);
      expect(await cache.totalBytes, 0);
    });

    test('evicting a missing file is a no-op', () async {
      await cache.evict('missing');
    });
  });

  group('totalBytes', () {
    test('sums the size of all cached files', () async {
      await cache.cacheFile('a', '.jpg', Uint8List.fromList([1, 2, 3]));
      await cache.cacheFile('b', '.png', Uint8List.fromList([4, 5]));

      expect(await cache.totalBytes, 5);
    });
  });

  group('evictExpired', () {
    test('evicts expired entries then oldest until under the cap', () async {
      final smallCache = FileCache(
        cacheDir: tempDir,
        ttl: const Duration(days: 7),
        maxBytes: 5,
      );
      await smallCache.cacheFile('old', '.jpg', Uint8List.fromList([1, 2, 3]));
      final oldFile = File('${tempDir.path}/old.jpg');
      final oldMod = DateTime.now().subtract(const Duration(days: 8));
      await oldFile.setLastModified(oldMod);
      await smallCache.cacheFile('new', '.jpg', Uint8List.fromList([9, 9, 9, 9, 9, 9]));

      await smallCache.evictExpired();

      expect(await smallCache.getCached('old'), isNull,
          reason: 'expired entry should be evicted');
      expect(await smallCache.totalBytes, lessThanOrEqualTo(5));
    });

    test('evicts the oldest first when over the cap', () async {
      final smallCache = FileCache(cacheDir: tempDir, maxBytes: 6);
      await smallCache.cacheFile('a', '.jpg', Uint8List.fromList([1, 1, 1, 1]));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await smallCache.cacheFile('b', '.jpg', Uint8List.fromList([2, 2, 2, 2]));

      await smallCache.evictExpired();

      expect(await smallCache.getCached('a'), isNull,
          reason: 'oldest should be evicted first');
      expect(await smallCache.getCached('b'), isNotNull);
    });
  });

  group('extensionForMime', () {
    test('maps known mimes', () {
      expect(cache.extensionForMime('image/jpeg'), '.jpg');
      expect(cache.extensionForMime('image/png'), '.png');
      expect(cache.extensionForMime('image/webp'), '.webp');
    });

    test('defaults unknown mimes to .bin', () {
      expect(cache.extensionForMime('application/pdf'), '.bin');
    });
  });
}
