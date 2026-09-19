import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_client_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../auth/data/auth_credentials_store.dart';
import '../../settings/data/settings_providers.dart';
import 'agent_config.dart';
import 'plugin_credentials_store.dart';

final pluginCredentialsStoreProvider = Provider<PluginCredentialsStore>(
  (ref) => PluginCredentialsStore(),
);

final pluginAccountScopeProvider = Provider<AuthAccountScope>((ref) {
  final auth = ref.watch(authCredentialsProvider);
  final settings = ref.watch(settingsProvider);
  final origin = normalizeBackendOrigin(ref.watch(authBackendOriginProvider));
  final scope = auth.value?.accountScope;
  if (auth.isLoading ||
      auth.hasError ||
      settings.isLoading ||
      settings.hasError ||
      (auth.value?.apiKey.trim().isEmpty ?? true) ||
      scope == null ||
      origin != scope.backendOrigin) {
    throw const PluginReauthenticationRequired();
  }
  return scope;
});

final pluginCredentialsEpochProvider =
    NotifierProvider<PluginCredentialsEpoch, int>(PluginCredentialsEpoch.new);

class PluginCredentialsEpoch extends Notifier<int> {
  int _generation = 0;

  @override
  int build() {
    ref.watch(authCredentialsProvider);
    ref.watch(settingsProvider);
    ref.watch(authBackendOriginProvider);
    return ++_generation;
  }

  void invalidate() {
    if (ref.mounted) state = ++_generation;
  }
}

final pluginCredentialsProvider =
    FutureProvider.autoDispose<PluginAccountConfiguration>((ref) async {
  ref.watch(pluginCredentialsEpochProvider);
  final scope = ref.watch(pluginAccountScopeProvider);
  final store = ref.watch(pluginCredentialsStoreProvider);
  var config = await store.load(scope);
  if (config.plugins.isEmpty) {
    await store.ensureDefaultAgent(scope);
    config = await store.load(scope);
  }
  return config;
});

final selectedModelProvider = Provider<String?>((ref) {
  return ref.watch(pluginCredentialsProvider).value?.selectedModel;
});

final selectedAgentProvider = Provider<String?>((ref) {
  return ref.watch(pluginCredentialsProvider).value?.selectedAgent;
});

final scopedPluginCredentialsProvider =
    Provider.autoDispose<ScopedPluginCredentials>((ref) {
      final scope = ref.watch(pluginAccountScopeProvider);
      final auth = ref.watch(authCredentialsProvider);
      final settings = ref.watch(settingsProvider);
      final epoch = ref.watch(pluginCredentialsEpochProvider);
      final store = ref.watch(pluginCredentialsStoreProvider);
      return ScopedPluginCredentials._(
        scope,
        store,
        () {
          if (!ref.mounted ||
              ref.read(authCredentialsProvider) != auth ||
              ref.read(settingsProvider) != settings ||
              ref.read(pluginCredentialsEpochProvider) != epoch) {
            throw const PluginReauthenticationRequired();
          }
        },
        () {
          if (ref.mounted) {
            ref.read(pluginCredentialsEpochProvider.notifier).invalidate();
          }
        },
      );
    });

class ScopedPluginCredentials {
  ScopedPluginCredentials._(
    this.scope,
    this._store,
    this._checkCurrent,
    this._invalidate,
  );

  final AuthAccountScope scope;
  final PluginCredentialsStore _store;
  final void Function() _checkCurrent;
  final void Function() _invalidate;

  Future<void> _write(Future<void> Function() operation) async {
    _checkCurrent();
    await operation();
    _invalidate();
  }

  Future<void> setCredentials(
    String pluginId,
    Map<String, String> credentials,
  ) => _write(() => _store.setCredentials(scope, pluginId, credentials));

  Future<void> setEnabled(String pluginId, bool enabled) =>
      _write(() => _store.setEnabled(scope, pluginId, enabled));

  Future<void> setSelectedModel(String? model) =>
      _write(() => _store.setSelectedModel(scope, model));

  Future<void> setSelectedAgent(String? id) =>
      _write(() => _store.setSelectedAgent(scope, id));

  Future<void> setAgentConfig(String pluginId, AgentConfig config) =>
      _write(() => _store.setAgentConfig(scope, pluginId, config));

  Future<void> removePlugin(String pluginId) =>
      _write(() => _store.removePlugin(scope, pluginId));

  Future<void> clearScope() => _write(() => _store.clearScope(scope));
}
