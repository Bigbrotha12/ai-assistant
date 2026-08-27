import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'chat_client.dart';
import 'config.dart';
import 'settings_providers.dart';

/// Provides the [ChatClient] wired to the configured backend host.
final chatApiClientProvider = Provider<ChatClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final host = settings?.trimmedHost ?? BackendConfig.defaultHost;
  final baseUrl =
      BackendConfig.llmProxy(host).toString().replaceAll(RegExp(r'/$'), '');
  return ChatApiClient(baseUrl: baseUrl);
});
