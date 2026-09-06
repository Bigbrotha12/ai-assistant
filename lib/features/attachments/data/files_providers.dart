import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/config.dart';
import '../../../app/app_startup.dart';
import './file_cache.dart';
import './files_service.dart';
import '../../settings/data/settings_providers.dart';

/// Shared [Dio] instance for every HTTP client, so they share one connection
/// pool and (future) interceptors.
final dioProvider = Provider<Dio>((ref) => Dio());

/// Bearer-gated files service wired to the configured host, or a
/// [NoOpFilesClient] when no files secret is configured (the UI then shows
/// "Files service not configured"). Never throws.
final filesServiceProvider = Provider<FilesClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final host = effectiveHost(settings);
  final filesSecret = settings?.filesSecret?.trim();
  if (filesSecret == null || filesSecret.isEmpty) {
    return NoOpFilesClient();
  }
  return FilesClientImpl(
    dio: ref.watch(dioProvider),
    baseUrl: BackendConfig.effectiveStorageUrl(
      host,
      settings?.storageUrl,
      environment: effectiveEnvironment(settings),
    ).toString(),
    bearerToken: filesSecret,
  );
});

/// On-disk file cache rooted at `<documents>/files_cache`. The directory is
/// resolved lazily on first use because path_provider is async.
final fileCacheProvider = Provider<FileCache>((ref) {
  return FileCache.async(
    resolveDir: () async {
      final docs = await getApplicationDocumentsDirectory();
      return Directory('${docs.path}/files_cache');
    },
  );
});
