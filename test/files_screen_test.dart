import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/file_cache.dart';
import 'package:ai_assistant/core/files_providers.dart';
import 'package:ai_assistant/core/files_service.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:ai_assistant/features/attachments/file_store.dart';
import 'package:ai_assistant/features/attachments/files_screen.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';

import 'fakes.dart';

/// [FileCache] fake that performs no disk IO: lookups return scripted state and
/// evictions are recorded, so widget tests never touch the filesystem.
class FakeFileCache extends FileCache {
  FakeFileCache({Map<String, FileInfo>? cached})
      : _cached = cached ?? {},
        super(cacheDir: Directory.systemTemp);

  final Map<String, FileInfo> _cached;

  /// File ids passed to [evict], in order.
  final List<String> evictedIds = [];

  /// Number of [evictExpired] calls.
  int evictExpiredCalls = 0;

  Map<String, FileInfo> get cached => _cached;

  @override
  Future<FileInfo?> getCached(String fileId) async => _cached[fileId];

  @override
  Future<Map<String, FileInfo>> getAllCached() async => Map.of(_cached);

  @override
  Future<void> evict(String fileId) async {
    evictedIds.add(fileId);
    _cached.remove(fileId);
  }

  @override
  Future<void> evictExpired() async {
    evictExpiredCalls++;
    _cached.clear();
  }

  @override
  String extensionForMime(String mime) => '.bin';
}

void main() {
  FileInfo fileInfo(String id, String name,
          {String mime = 'image/png', int size = 2048}) =>
      FileInfo(
        id: id,
        filename: name,
        sizeBytes: size,
        mimeType: mime,
        uploadedAt: DateTime(2026, 1, 1),
      );

  Widget filesApp({
    required FilesClient filesClient,
    FileStore? store,
    FileCache? fileCache,
  }) {
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(FakeSettingsStore(
          stored: const BackendSettings(host: 'myhost'),
        )),
        filesServiceProvider.overrideWithValue(filesClient),
        filesStoreProvider.overrideWithValue(store ?? FakeFileStore()),
        fileCacheProvider.overrideWithValue(fileCache ?? FakeFileCache()),
      ],
      child: const MaterialApp(home: FilesScreen()),
    );
  }

  testWidgets('renders a grid tile per file from the files service',
      (tester) async {
    final client = FakeFilesClient(files: [
      fileInfo('f1', 'photo.png'),
      fileInfo('f2', 'doc.pdf', mime: 'application/pdf'),
    ]);
    await tester.pumpWidget(filesApp(filesClient: client));
    await tester.pumpAndSettle();

    expect(client.listCalls, 1);
    expect(find.text('photo.png'), findsOneWidget);
    expect(find.text('doc.pdf'), findsOneWidget);
    // Un-cached thumbnails render placeholder icons, never IO-backed images.
    expect(find.byIcon(Icons.image_outlined), findsOneWidget);
    expect(find.byIcon(Icons.insert_drive_file_outlined), findsOneWidget);
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('shows the empty state when no files are uploaded',
      (tester) async {
    await tester.pumpWidget(filesApp(filesClient: FakeFilesClient()));
    await tester.pumpAndSettle();

    expect(find.text('No files uploaded yet'), findsOneWidget);
    expect(find.text('Go to Chat'), findsOneWidget);
  });

  testWidgets('shows an error state with a working Retry button',
      (tester) async {
    final client = FakeFilesClient(
      files: [fileInfo('f1', 'photo.png')],
      listError: StateError('boom'),
    );
    await tester.pumpWidget(filesApp(filesClient: client));
    await tester.pumpAndSettle();

    expect(find.text('Could not load files'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    client.listError = null;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(find.text('photo.png'), findsOneWidget);
    expect(find.text('Could not load files'), findsNothing);
  });

  testWidgets('long-pressing a tile and choosing Delete removes the file',
      (tester) async {
    final client = FakeFilesClient(files: [fileInfo('f1', 'photo.png')]);
    final store = FakeFileStore();
    await tester.pumpWidget(filesApp(filesClient: client, store: store));
    await tester.pumpAndSettle();

    await tester.longPress(find.text('photo.png'));
    await tester.pumpAndSettle();

    expect(find.text('Delete'), findsOneWidget);
    expect(find.text('Copy Link'), findsOneWidget);

    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(client.deletedIds, ['f1']);
    expect(store.deletedIds, ['f1']);
    expect(find.text('photo.png'), findsNothing);
    expect(find.text('No files uploaded yet'), findsOneWidget);
  });

  testWidgets('shows the not-configured state for a NoOpFilesClient',
      (tester) async {
    await tester.pumpWidget(filesApp(filesClient: NoOpFilesClient()));
    await tester.pumpAndSettle();

    expect(find.text('Files service not configured'), findsOneWidget);
    expect(find.textContaining('Settings'), findsOneWidget);
  });

  testWidgets('Clear Cache confirms, evicts downloads, and keeps the list',
      (tester) async {
    final client = FakeFilesClient(files: [
      fileInfo('f1', 'doc.pdf', mime: 'application/pdf'),
    ]);
    final cache = FakeFileCache(cached: {
      'f1': FileInfo(
        id: 'f1',
        filename: 'doc.pdf',
        sizeBytes: 2048,
        mimeType: 'application/pdf',
        localPath: '/cache/f1.pdf',
      ),
    });
    await tester.pumpWidget(filesApp(filesClient: client, fileCache: cache));
    await tester.pumpAndSettle();

    expect(cache.cached, isNotEmpty);

    await tester.tap(find.byTooltip('Clear Cache'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(cache.evictExpiredCalls, 1);
    expect(cache.evictedIds, ['f1']);
    expect(cache.cached, isEmpty);
    expect(find.text('doc.pdf'), findsOneWidget);
    expect(find.text('Cache cleared'), findsOneWidget);
  });
}