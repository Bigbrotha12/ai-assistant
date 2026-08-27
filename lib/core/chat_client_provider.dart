import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'chat_client.dart';
import 'config.dart';
import 'files_providers.dart';
import 'settings_providers.dart';

/// Provides the [ChatClient] wired to the configured backend host. Reuses the
/// shared [dioProvider] so every HTTP client shares one connection pool.
final chatApiClientProvider = Provider<ChatClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final host = settings?.trimmedHost ?? BackendConfig.defaultHost;
  final baseUrl =
      BackendConfig.llmProxy(host).toString().replaceAll(RegExp(r'/$'), '');
  return ChatApiClient(baseUrl: baseUrl, dio: ref.watch(dioProvider));
});
