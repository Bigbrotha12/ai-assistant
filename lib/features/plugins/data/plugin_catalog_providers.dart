import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/http/dio_provider.dart';
import '../../auth/data/auth_client_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/message_model.dart';
import '../../settings/data/settings_providers.dart';
import 'langchain_request.dart';
import 'plugin_credentials_providers.dart';
import 'plugin_credentials_store.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';
import 'plugin_registry_client.dart';

enum PluginAccess { loading, signedOut, reauthenticate, error, ready }

final pluginAccessProvider = Provider.autoDispose<PluginAccess>((ref) {
  final auth = ref.watch(authCredentialsProvider);
  final settings = ref.watch(settingsProvider);
  final origin = normalizeBackendOrigin(ref.watch(authBackendOriginProvider));
  if (auth.isLoading || settings.isLoading) return PluginAccess.loading;
  if (auth.hasError || settings.hasError) return PluginAccess.error;
  final credentials = auth.value;
  if (credentials == null) return PluginAccess.signedOut;
  final scope = credentials.accountScope;
  if (credentials.apiKey.trim().isEmpty ||
      credentials.apiKey.contains(RegExp(r'[\r\n]')) ||
      scope == null ||
      scope.backendOrigin != origin) {
    return PluginAccess.reauthenticate;
  }
  return PluginAccess.ready;
});

final pluginRegistryClientProvider = Provider.autoDispose<PluginRegistryClient>(
  (ref) {
    final scope = ref.watch(pluginAccountScopeProvider);
    return PluginRegistryClient(
      dio: ref.watch(dioProvider),
      baseUrl: '${scope.backendOrigin}/v1',
    );
  },
);

class PluginCatalog {
  PluginCatalog(this.plugins, List<PluginModelDto> models, List<AgentDto> agents)
    : models = List.unmodifiable(
        models.where(
          (model) => plugins.any(
            (plugin) =>
                plugin.id == model.id &&
                plugin.type == 'model' &&
                plugin.installed &&
                plugin.isSupported,
          ),
        ),
      ),
      agents = List.unmodifiable(
        agents.where(
          (agent) => plugins.any(
            (plugin) =>
                plugin.id == agent.id &&
                plugin.type == 'agent' &&
                plugin.installed &&
                plugin.isSupported,
          ),
        ),
      );

  final List<PluginDto> plugins;
  final List<PluginModelDto> models;
  final List<AgentDto> agents;

  PluginDto? installedPlugin(String id) {
    for (final plugin in plugins) {
      if (plugin.id == id && plugin.installed && plugin.isSupported) {
        return plugin;
      }
    }
    return null;
  }
}

final pluginCatalogProvider = FutureProvider.autoDispose<PluginCatalog>(
  retry: (_, _) => null,
  (ref) async {
    final token = CancelToken();
    ref.onDispose(token.cancel);
    ref.listen(authCredentialsProvider, (_, _) => token.cancel());
    ref.listen(settingsProvider, (_, _) => token.cancel());
    ref.listen(authBackendOriginProvider, (_, _) => token.cancel());
    if (ref.watch(pluginAccessProvider) != PluginAccess.ready) {
      throw const PluginReauthenticationRequired();
    }
    final auth = ref.watch(authCredentialsProvider).requireValue!;
    final client = ref.watch(pluginRegistryClientProvider);
    try {
      final (plugins, models, agents) = await (
        client.listPlugins(gatewayKey: auth.apiKey, cancelToken: token),
        client.listModels(gatewayKey: auth.apiKey, cancelToken: token),
        client.listAgents(gatewayKey: auth.apiKey, cancelToken: token),
      ).wait;
      if (token.isCancelled) throw const PluginClientException('cancelled');
      return PluginCatalog(plugins, models, agents);
    } finally {
      token.cancel();
    }
  },
);

final stagedPluginRequestBuilderProvider =
    FutureProvider.autoDispose<StagedPluginRequestBuilder>((ref) async {
      if (ref.watch(pluginAccessProvider) != PluginAccess.ready) {
        throw const PluginReauthenticationRequired();
      }
      final auth = ref.watch(authCredentialsProvider).requireValue!;
      final epoch = ref.watch(pluginCredentialsEpochProvider);
      final (catalog, configuration) = await (
        ref.watch(pluginCatalogProvider.future),
        ref.watch(pluginCredentialsProvider.future),
      ).wait;
      void checkCurrent() {
        if (!ref.mounted ||
            ref.read(pluginAccessProvider) != PluginAccess.ready ||
            ref.read(authCredentialsProvider).value != auth ||
            ref.read(pluginCredentialsEpochProvider) != epoch) {
          throw const PluginReauthenticationRequired();
        }
      }

      checkCurrent();
      return StagedPluginRequestBuilder._(
        auth.apiKey,
        catalog,
        configuration,
        checkCurrent,
      );
    });

class StagedPluginRequestBuilder {
  StagedPluginRequestBuilder._(
    this._gatewayKey,
    this._catalog,
    this._configuration,
    this._checkCurrent,
  );

  final String _gatewayKey;
  final PluginCatalog _catalog;
  final PluginAccountConfiguration _configuration;
  final void Function() _checkCurrent;

  LangChainRequest build({
    required List<ApiMessage> messages,
    required String threadId,
    required String turnId,
  }) {
    _checkCurrent();
    final model = _configuration.selectedModel;
    if (model == null || !_catalog.models.any((item) => item.id == model)) {
      throw const PluginClientException('plugin_unavailable');
    }
    final enabled = _configuration.plugins.entries
        .where(
          (entry) =>
              entry.value.enabled &&
              _catalog.installedPlugin(entry.key)?.type == 'tool',
        )
        .map((entry) => entry.key)
        .toList();
    final credentials = <String, Map<String, String>>{};
    for (final id in [model, ...enabled]) {
      final fields =
          _configuration.plugins[id]?.credentials ?? const <String, String>{};
      if (_catalog.installedPlugin(id)?.credentials?.required == true &&
          (fields['apiKey']?.trim().isEmpty ?? true)) {
        throw const PluginClientException('invalid_credentials');
      }
      if (fields.isNotEmpty) credentials[id] = fields;
    }
    return LangChainRequest(
      gatewayKey: _gatewayKey,
      modelPluginId: model,
      credentials: credentials,
      messages: messages,
      managed: true,
      conversationPublicId: threadId,
      turnId: turnId,
      enabledPlugins: enabled,
    );
  }
}
