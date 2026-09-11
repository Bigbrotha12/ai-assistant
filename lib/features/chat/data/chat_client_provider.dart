import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import './chat_client.dart';

/// Provides the [ChatClient] wired to the configured inference endpoint.
/// Reuses the shared [dioProvider] so every HTTP client shares one connection
/// pool.
///
/// Inference target resolution is **compile-time only**: the `LLM_BASE_URL` /
/// `LLM_MODEL` / `LLM_API_KEY` dart-defines (see `dev.env` / `dev.sh`) are the
/// sole routing source. There is no gateway fallback — a build missing any of
/// the three fails loudly here instead of silently routing chat to a local
/// gateway proxy (see AGENTS.md).
final chatApiClientProvider = Provider<ChatClient>((ref) {
  final baseUrl = BackendConfig.trimTrailingSlash(
    BackendConfig.defaultLlmBaseUrl,
  );
  final model = BackendConfig.defaultLlmModel.trim();
  final apiKey = BackendConfig.defaultLlmApiKey.trim();

  if (baseUrl.isEmpty || model.isEmpty || apiKey.isEmpty) {
    throw StateError(
      'No inference endpoint configured: set the LLM_BASE_URL, LLM_MODEL and '
      'LLM_API_KEY dart-defines (see dev.env.example). There is no gateway '
      'fallback.',
    );
  }

  debugPrint(
    'ChatClient routing: base=$baseUrl model=$model '
    'key=${apiKey.isNotEmpty ? 'set' : 'none'}',
  );

  return ChatApiClient(
    baseUrl: baseUrl,
    dio: ref.watch(dioProvider),
    model: model,
    apiKey: apiKey,
  );
});