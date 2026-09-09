import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/app_startup.dart';
import './auth_client.dart';
import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import '../../settings/data/settings_providers.dart';

/// Provides the [AuthClient] wired to the configured backend host. Reuses the
/// shared [dioProvider] so every HTTP client shares one connection pool.
///
/// The backend gateway (Hono + better-auth) shares the same host/port as the
/// LLM proxy (see [chatApiClientProvider]); the auth base is the same origin
/// but under the `/api/auth` path.
final authClientProvider = Provider<AuthClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final baseUrl = BackendConfig.llmProxy(
    effectiveHost(settings),
    environment: effectiveEnvironment(settings),
  ).toString().replaceAll(RegExp(r'/$'), '');
  return BetterAuthClient(baseUrl: baseUrl, dio: ref.watch(dioProvider));
});
