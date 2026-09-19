import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/secure_storage.dart';
import '../../auth/data/auth_credentials_store.dart';
import 'agent_config.dart';

class PluginReauthenticationRequired implements Exception {
  const PluginReauthenticationRequired();

  String get message => 'Sign in again to configure plugins for this account.';

  @override
  String toString() => message;
}

class PluginConfiguration {
  PluginConfiguration({
    Map<String, String> credentials = const {},
    this.enabled = false,
    this.agent,
  }) : credentials = Map.unmodifiable(credentials);

  final Map<String, String> credentials;
  final bool enabled;
  final AgentConfig? agent;
}

class PluginAccountConfiguration {
  PluginAccountConfiguration({
    Map<String, PluginConfiguration> plugins = const {},
    this.selectedModel,
    this.selectedAgent,
  }) : plugins = Map.unmodifiable(plugins);

  final Map<String, PluginConfiguration> plugins;
  final String? selectedModel;
  final String? selectedAgent;
}

class PluginCredentialsStore {
  PluginCredentialsStore({FlutterSecureStorage? storage})
    : _storage = storage ?? defaultSecureStorage();

  final FlutterSecureStorage _storage;
  Future<void> _pending = Future.value();

  String _key(AuthAccountScope scope) =>
      'plugin_credentials_v1_${scope.storageId}';

  Future<T> _serialized<T>(Future<T> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<PluginAccountConfiguration> load(AuthAccountScope scope) =>
      _serialized(() => _load(scope));

  Future<PluginAccountConfiguration> _load(AuthAccountScope scope) async {
    final raw = await _storage.read(key: _key(scope));
    if (raw == null) return PluginAccountConfiguration();
    try {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final version = data['version'] as int?;
      if (version == null || version < 1 || version > 2) {
        throw const FormatException();
      }
      final plugins = (data['plugins'] as Map<String, dynamic>?)?.map((
        id,
        value,
      ) {
        final entry = value as Map<String, dynamic>;
        return MapEntry(
          id,
          PluginConfiguration(
            credentials: Map<String, String>.from(entry['credentials'] as Map? ?? {}),
            enabled: entry['enabled'] as bool? ?? false,
            agent: entry['agent'] != null
                ? AgentConfig.fromJson(entry['agent'] as Map<String, dynamic>)
                : null,
          ),
        );
      }) ?? {};
      return PluginAccountConfiguration(
        plugins: plugins,
        selectedModel: data['selectedModel'] as String?,
        selectedAgent: data['selectedAgent'] as String?,
      );
    } catch (_) {
      throw const FormatException('Stored plugin configuration is invalid.');
    }
  }

  Future<void> _save(
    AuthAccountScope scope,
    PluginAccountConfiguration config,
  ) => _storage.write(
    key: _key(scope),
    value: jsonEncode({
      'version': 2,
      'plugins': config.plugins.map(
        (id, value) => MapEntry(id, {
          'credentials': value.credentials,
          'enabled': value.enabled,
          if (value.agent != null) 'agent': value.agent!.toJson(),
        }),
      ),
      'selectedModel': config.selectedModel,
      'selectedAgent': config.selectedAgent,
    }),
  );

  Future<void> setCredentials(
    AuthAccountScope scope,
    String pluginId,
    Map<String, String> credentials,
  ) {
    final snapshot = Map<String, String>.unmodifiable(credentials);
    return _updatePlugin(
      scope,
      pluginId,
      (previous) =>
          PluginConfiguration(credentials: snapshot, enabled: previous.enabled, agent: previous.agent),
    );
  }

  Future<void> setEnabled(
    AuthAccountScope scope,
    String pluginId,
    bool enabled,
  ) => _updatePlugin(
    scope,
    pluginId,
    (previous) => PluginConfiguration(
      credentials: previous.credentials,
      enabled: enabled,
      agent: previous.agent,
    ),
  );

  Future<void> _updatePlugin(
    AuthAccountScope scope,
    String pluginId,
    PluginConfiguration Function(PluginConfiguration) update,
  ) => _serialized(() async {
    if (pluginId.trim().isEmpty) {
      throw ArgumentError('Plugin ID must not be blank.');
    }
    final config = await _load(scope);
    await _save(
      scope,
      PluginAccountConfiguration(
        plugins: {
          ...config.plugins,
          pluginId: update(config.plugins[pluginId] ?? PluginConfiguration()),
        },
        selectedModel: config.selectedModel,
        selectedAgent: config.selectedAgent,
      ),
    );
  });

  Future<void> removePlugin(AuthAccountScope scope, String pluginId) =>
      _serialized(() async {
        final config = await _load(scope);
        final plugins = {...config.plugins}..remove(pluginId);
        await _save(
          scope,
          PluginAccountConfiguration(
            plugins: plugins,
            selectedModel: config.selectedModel,
            selectedAgent: config.selectedAgent == pluginId ? null : config.selectedAgent,
          ),
        );
      });

  Future<void> setSelectedModel(AuthAccountScope scope, String? model) =>
      _serialized(() async {
        final config = await _load(scope);
        await _save(
          scope,
          PluginAccountConfiguration(
            plugins: config.plugins,
            selectedModel: model == null || model.trim().isEmpty ? null : model,
            selectedAgent: config.selectedAgent,
          ),
        );
      });

  Future<void> setSelectedAgent(AuthAccountScope scope, String? id) =>
      _serialized(() async {
        final config = await _load(scope);
        await _save(
          scope,
          PluginAccountConfiguration(
            plugins: config.plugins,
            selectedModel: config.selectedModel,
            selectedAgent: id == null || id.trim().isEmpty ? null : id,
          ),
        );
      });

  Future<void> setAgentConfig(
    AuthAccountScope scope,
    String pluginId,
    AgentConfig config,
  ) => _updatePlugin(scope, pluginId, (previous) =>
    PluginConfiguration(
      credentials: previous.credentials,
      enabled: previous.enabled,
      agent: config,
    ),
  );

  Future<void> ensureDefaultAgent(AuthAccountScope scope, {String? templateId}) =>
      _serialized(() async {
        final config = await _load(scope);
        if (config.plugins.isNotEmpty) return;
        final id =
            (templateId != null && templateId.trim().isNotEmpty)
            ? templateId
            : 'default';
        await _save(scope, PluginAccountConfiguration(
          plugins: {id: PluginConfiguration(
            enabled: true,
            agent: AgentConfig(id: id, kind: AgentKind.template),
          )},
          selectedAgent: id,
          selectedModel: config.selectedModel,
        ));
      });

  Future<void> clearScope(AuthAccountScope scope) =>
      _serialized(() => _storage.delete(key: _key(scope)));
}
