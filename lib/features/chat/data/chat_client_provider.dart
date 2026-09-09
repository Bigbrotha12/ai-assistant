import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/app_startup.dart';
import '../../auth/data/auth_credentials_providers.dart';
import './chat_client.dart';
import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import '../../settings/data/settings_providers.dart';

/// Provides the [ChatClient] wired to the configured inference endpoint.
/// Reuses the shared [dioProvider] so every HTTP client shares one connection
/// pool.
///
/// Inference target resolution (precedence high → low):
/// 1. Runtime settings override (`llmBaseUrl`/`llmModel`/`llmApiKey`).
/// 2. Compile-time `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` dart-defines
///    (e.g. a LibreChat agents endpoint).
/// 3. Gateway default: host's :17600 proxy, the default model, and the minted
///    better-auth API key.
///
/// Watches [authCredentialsProvider] so the gateway path always carries the
/// key on every request — and a fresh client is created whenever the key
/// changes (initial load, re-authentication).
final chatApiClientProvider = Provider<ChatClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final host = effectiveHost(settings);
  final environment = effectiveEnvironment(settings);

  final overrideBase = settings?.trimmedLlmBaseUrl;
  final defineBase = BackendConfig.defaultLlmBaseUrl.trim();
  final baseUrl = (overrideBase?.isNotEmpty ?? false)
      ? overrideBase!
      : (defineBase.isNotEmpty
          ? defineBase
          : BackendConfig.llmApiBase(host, environment: environment).toString());

  final overrideModel = settings?.trimmedLlmModel;
  final model = (overrideModel?.isNotEmpty ?? false)
      ? overrideModel!
      : BackendConfig.defaultLlmModel;

  final overrideKey = settings?.trimmedLlmApiKey;
  final defineKey = BackendConfig.defaultLlmApiKey.trim();
  final apiKey = (overrideKey?.isNotEmpty ?? false)
      ? overrideKey!
      : (defineKey.isNotEmpty
          ? defineKey
          : ref.watch(authCredentialsProvider).value?.apiKey);

  debugPrint(
    'ChatClient routing: base=$baseUrl model=$model '
    'key=${apiKey != null && apiKey.isNotEmpty ? 'set' : 'none'}',
  );

  return ChatApiClient(
    baseUrl: baseUrl,
    dio: ref.watch(dioProvider),
    model: model,
    apiKey: apiKey,
  );
});
