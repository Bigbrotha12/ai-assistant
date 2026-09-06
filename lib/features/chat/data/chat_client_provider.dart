import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/app_startup.dart';
import '../../auth/data/auth_credentials_providers.dart';
import './chat_client.dart';
import '../../../core/config.dart';
import '../../attachments/data/files_providers.dart';
import '../../settings/data/settings_providers.dart';

/// Provides the [ChatClient] wired to the configured backend host. Reuses the
/// shared [dioProvider] so every HTTP client shares one connection pool.
///
/// Watches [authCredentialsProvider] so the client carries the minted API key
/// on every request — and a fresh client is created whenever the key changes
/// (initial load, re-authentication).
final chatApiClientProvider = Provider<ChatClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final apiKey = ref.watch(authCredentialsProvider).value?.apiKey;
  final baseUrl = BackendConfig.llmProxy(
    effectiveHost(settings),
    environment: effectiveEnvironment(settings),
  ).toString().replaceAll(RegExp(r'/$'), '');
  return ChatApiClient(
    baseUrl: baseUrl,
    dio: ref.watch(dioProvider),
    apiKey: apiKey,
  );
});
