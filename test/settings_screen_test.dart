import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/file_cache.dart';
import 'package:ai_assistant/core/files_providers.dart';
import 'package:ai_assistant/core/files_service.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:ai_assistant/features/attachments/files_screen.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';
import 'package:ai_assistant/features/settings/settings_screen.dart';

import 'fakes.dart';

/// [FileCache] fake that performs no disk IO, recording eviction calls.
class FakeFileCache extends FileCache {
  FakeFileCache() : super(cacheDir: Directory.systemTemp);

  int evictExpiredCalls = 0;

  @override
  Future<void> evictExpired() async {
    evictExpiredCalls++;
  }

  @override
  Future<Map<String, FileInfo>> getAllCached() async => const {};
}

void main() {
  Widget settingsApp({
    required FakeSettingsStore store,
    required FilesClient filesClient,
    required FileCache fileCache,
    FakeProbe? probe,
  }) {
    return ProviderScope(
      overrides: [
        settingsStoreProvider.overrideWithValue(store),
        backendProbeProvider.overrideWithValue(probe ?? FakeProbe()),
        filesServiceProvider.overrideWithValue(filesClient),
        filesStoreProvider.overrideWithValue(FakeFileStore()),
        fileCacheProvider.overrideWithValue(fileCache),
      ],
      child: const MaterialApp(home: SettingsScreen()),
    );
  }

  testWidgets('files token field prefills from saved settings', (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(
        host: 'myhost',
        secret: 's3cret',
        filesSecret: 'files-token',
      ),
    );
    await tester.pumpWidget(settingsApp(
      store: store,
      filesClient: NoOpFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    final filesField = tester.widget<TextField>(find.byType(TextField).at(3));
    expect(filesField.controller!.text, 'files-token');
  });

  testWidgets('save persists the files token', (tester) async {
    final store = FakeSettingsStore();
    await tester.pumpWidget(settingsApp(
      store: store,
      filesClient: NoOpFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'tailscale.local');
    await tester.enterText(find.byType(TextField).at(1), 's3cret');
    await tester.enterText(find.byType(TextField).at(3), 'files-token');
    await tester.pump();

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(store.stored, isNotNull);
    expect(store.stored!.host, 'tailscale.local');
    expect(store.stored!.filesSecret, 'files-token');
  });

  testWidgets('shows Files service not configured for a no-op client',
      (tester) async {
    await tester.pumpWidget(settingsApp(
      store: FakeSettingsStore(),
      filesClient: NoOpFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Files service not configured'), findsOneWidget);
    expect(find.text('Files service connected'), findsNothing);
  });

  testWidgets('shows Files service connected for a configured client',
      (tester) async {
    final store = FakeSettingsStore(
      stored: const BackendSettings(
        host: 'myhost',
        secret: 's3cret',
        filesSecret: 'files-token',
      ),
    );
    await tester.pumpWidget(settingsApp(
      store: store,
      filesClient: FakeFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Files service connected'), findsOneWidget);
    expect(find.text('Files service not configured'), findsNothing);
  });

  testWidgets('Clear Cache confirms, evicts expired files, and shows a SnackBar',
      (tester) async {
    final cache = FakeFileCache();
    await tester.pumpWidget(settingsApp(
      store: FakeSettingsStore(),
      filesClient: NoOpFilesClient(),
      fileCache: cache,
    ));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Clear Cache'));
    await tester.tap(find.text('Clear Cache'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(cache.evictExpiredCalls, 1);
    expect(find.text('Cache cleared'), findsOneWidget);
  });

  testWidgets('File Browser button pushes the FilesScreen', (tester) async {
    await tester.pumpWidget(settingsApp(
      store: FakeSettingsStore(),
      filesClient: FakeFilesClient(),
      fileCache: FakeFileCache(),
    ));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('File Browser'));
    await tester.tap(find.text('File Browser'));
    await tester.pumpAndSettle();

    expect(find.byType(FilesScreen), findsOneWidget);
  });
}
