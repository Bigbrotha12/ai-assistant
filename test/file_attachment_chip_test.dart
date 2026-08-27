import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/file_cache.dart';
import 'package:ai_assistant/core/files_providers.dart';
import 'package:ai_assistant/core/files_service.dart';
import 'package:ai_assistant/features/attachments/file_attachment_chip.dart';
import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:ai_assistant/features/attachments/file_store.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';

import 'fakes.dart';

// The fake cache assigns a public param to a private field (mirroring
// FileCache), which trips prefer_initializing_formals.
// ignore_for_file: prefer_initializing_formals

/// [FileCache] fake whose lookups complete on demand, so tests can observe the
/// chip's `downloading` state before resolving. No real disk IO is performed.
class FakeFileCache extends FileCache {
  FakeFileCache({
    FileInfo? cached,
    this.fetchCompleter,
    this.cacheExtension,
  })  : _cached = cached,
        super(cacheDir: Directory.systemTemp);

  final FileInfo? _cached;

  /// When set, [getCached] waits on this before returning [cached].
  Completer<FileInfo?>? fetchCompleter;

  /// Extension returned by [extensionForMime]. Null delegates to the real
  /// MIME→extension mapping so tests can observe the resolved type.
  final String? cacheExtension;

  /// File ids passed to [cacheFile], in order.
  final List<String> cachedIds = [];

  /// Extensions passed to [cacheFile], in order.
  final List<String> cacheExtensions = [];

  String? lastCachePath;

  @override
  Future<FileInfo?> getCached(String fileId) {
    final completer = fetchCompleter;
    if (completer != null) return completer.future;
    return Future.value(_cached);
  }

  @override
  Future<String> cacheFile(
    String fileId,
    String extension,
    Uint8List data,
  ) async {
    cachedIds.add(fileId);
    cacheExtensions.add(extension);
    lastCachePath = '${Directory.systemTemp.path}/$fileId$extension';
    return lastCachePath!;
  }

  @override
  String extensionForMime(String mime) =>
      cacheExtension ?? super.extensionForMime(mime);
}

Widget chipApp({
  required FilesClient files,
  required FileCache cache,
  FileStore? fileStore,
  String fileId = 'f1',
  String filename = 'photo.jpg',
  Future<void> Function(String path)? openFile,
}) {
  return ProviderScope(
    overrides: [
      filesServiceProvider.overrideWithValue(files),
      fileCacheProvider.overrideWithValue(cache),
      filesStoreProvider.overrideWithValue(fileStore ?? FakeFileStore()),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: FileAttachmentChip(
          fileId: fileId,
          filename: filename,
          openFile: openFile,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('chip shows downloading then ready when the file is cached',
      (tester) async {
    final cacheLookup = Completer<FileInfo?>();
    final cache = FakeFileCache(fetchCompleter: cacheLookup);
    final files = FakeFilesClient();
    final opened = <String>[];

    await tester.pumpWidget(chipApp(
      files: files,
      cache: cache,
      openFile: (path) async => opened.add(path),
    ));

    await tester.tap(find.byType(ActionChip));
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // Resolve the cache hit: the chip becomes ready and opens the local file
    // directly, without a network fetch.
    cacheLookup.complete(const FileInfo(
      id: 'f1',
      filename: 'f1.jpg',
      sizeBytes: 3,
      mimeType: 'image/jpeg',
      localPath: '/cache/f1.jpg',
    ));
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('photo.jpg'), findsOneWidget);
    expect(find.text('3 B'), findsOneWidget);
    expect(files.fetchedIds, isEmpty);
    expect(opened, ['/cache/f1.jpg']);
  });

  testWidgets('chip downloads, caches, and shows ready when not cached',
      (tester) async {
    final cache = FakeFileCache(cacheExtension: '.jpg');
    final files = FakeFilesClient();
    final opened = <String>[];

    await tester.pumpWidget(chipApp(
      files: files,
      cache: cache,
      filename: 'photo.jpg',
      openFile: (path) async => opened.add(path),
    ));

    await tester.tap(find.byType(ActionChip));
    await tester.pump();
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('photo.jpg'), findsOneWidget);
    expect(files.fetchedIds, ['f1']);
    expect(cache.cachedIds, ['f1']);
    expect(cache.cacheExtensions, ['.jpg']);
    expect(opened, [cache.lastCachePath]);
  });

  testWidgets('chip shows an error with retry when the download fails',
      (tester) async {
    final cache = FakeFileCache();
    final files = FakeFilesClient(fetchError: StateError('boom'));

    await tester.pumpWidget(chipApp(files: files, cache: cache));

    await tester.tap(find.byType(ActionChip));
    await tester.pump();
    await tester.pump();

    expect(find.text('Failed to download'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    // The service recovers; retrying downloads and reaches ready.
    files.fetchError = null;
    await tester.tap(find.byType(ActionChip));
    await tester.pump();
    await tester.pump();

    expect(find.text('Failed to download'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('photo.jpg'), findsOneWidget);
    expect(files.fetchedIds, ['f1', 'f1']);
  });

  testWidgets('chip reports files service not configured for a NoOp client',
      (tester) async {
    final cache = FakeFileCache();

    await tester.pumpWidget(chipApp(
      files: NoOpFilesClient(),
      cache: cache,
    ));

    await tester.tap(find.byType(ActionChip));
    await tester.pump();

    expect(find.text('Files service not configured'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets(
      'bot-generated chip derives the real image extension from the file '
      'store (not octet-stream)', (tester) async {
    // Bot chips carry only the server file id as the display name (no
    // extension), so the filename alone would resolve to
    // application/octet-stream and cache as `.bin` — unopenable on Android /
    // iOS. The local store knows the real mime from the upload.
    final cache = FakeFileCache();
    final fileStore = FakeFileStore();
    await fileStore.saveFile(
      const FileInfo(
        id: 'f1',
        filename: 'photo.jpg',
        sizeBytes: 10,
        mimeType: 'image/jpeg',
      ),
    );
    final files = FakeFilesClient();
    final opened = <String>[];

    await tester.pumpWidget(chipApp(
      files: files,
      cache: cache,
      fileStore: fileStore,
      fileId: 'f1',
      filename: 'f1',
      openFile: (path) async => opened.add(path),
    ));

    await tester.tap(find.byType(ActionChip));
    await tester.pump();
    await tester.pump();

    expect(files.fetchedIds, ['f1']);
    // Cached with the real image extension, not `.bin`.
    expect(cache.cacheExtensions, ['.jpg']);
    expect(cache.lastCachePath, endsWith('f1.jpg'));
    expect(opened, [cache.lastCachePath]);
    expect(find.text('f1'), findsOneWidget);
  });
}