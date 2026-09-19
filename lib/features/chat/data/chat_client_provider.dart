import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/app_startup.dart';
import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../settings/data/settings_providers.dart';
import 'chat_client.dart';
import 'gateway_chat_client.dart';

/// Provides [ChatClient] wired to the LangChain gateway for inference. The
/// gateway resolves model + tool plugins and executes tools in the agent graph;
/// the client sends only the model, messages, and plugin credentials.
final chatApiClientProvider = Provider<ChatClient>((ref) {
  final settings = ref.watch(settingsProvider).value;
  final baseUrl = '${BackendConfig.gatewayBase(
    effectiveHost(settings),
    environment: effectiveEnvironment(settings),
  ).toString().replaceAll(RegExp(r'/$'), '')}/v1';

  return GatewayChatClient(
    baseUrl: baseUrl,
    dio: ref.watch(dioProvider),
    credentialResolver: () async {
      final auth = ref.read(authCredentialsProvider).value;
      final pluginCreds = ref.read(pluginCredentialsProvider).value;
      if (auth == null || auth.apiKey.trim().isEmpty || pluginCreds == null) {
        return null;
      }
      final selected = pluginCreds.selectedModel;
      if (selected == null) return null;

      final selectedAgent = pluginCreds.selectedAgent;

      final credentials = <String, Map<String, String>>{};
      for (final entry in pluginCreds.plugins.entries) {
        final id = entry.key;
        if (id == selected || entry.value.enabled) {
          final fields = entry.value.credentials;
          if (fields['apiKey']?.trim().isNotEmpty == true) {
            credentials[id] = {'apiKey': fields['apiKey']!.trim()};
          }
        }
      }
      if (!credentials.containsKey(selected)) return null;

      return GatewayCredentials(
        gatewayKey: auth.apiKey.trim(),
        modelPluginId: selected,
        agent: selectedAgent,
        credentials: credentials,
      );
    },
  );
});