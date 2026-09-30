import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/managed_resolution.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/data/staged_inference_adapters.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

AgentDto _agent({
  required String id,
  String? defaultModel,
  List<({String pluginId, bool required})> toolGrants = const [],
}) {
  final json = <String, dynamic>{
    'id': id,
    'object': 'agent',
    'created': 0,
    'owned_by': 'plugin',
    'name': id,
    'description': 'desc',
    'visionCapable': false,
    'skillCount': 0,
    'skillIds': <String>[],
    'mcpNames': <String>[],
  };
  if (defaultModel != null) json['defaultModel'] = defaultModel;
  if (toolGrants.isNotEmpty) {
    json['toolGrants'] = [
      for (final grant in toolGrants)
        {'pluginId': grant.pluginId, 'required': grant.required},
    ];
  }
  return AgentDto.fromJson(json);
}

PluginModelDto _model(String id, {bool streaming = true}) =>
    PluginModelDto.fromJson({
      'id': id,
      'object': 'model',
      'created': 0,
      'owned_by': 'plugin',
      'defaultModel': 'default',
      'tokenLimit': 4096,
      'visionCapable': false,
      'supportsStreaming': streaming,
      'parameters': <String, dynamic>{},
    });

void main() {
  final scope = AuthAccountScope.fromIdentity(
    backendOrigin: 'https://gateway.test',
    ownerId: 'alice',
  )!;

  late InMemorySecureStorage storage;
  late SecureAuthCredentialsStore auth;
  late PluginCredentialsStore plugins;

  setUp(() async {
    storage = InMemorySecureStorage();
    auth = SecureAuthCredentialsStore(storage: storage);
    plugins = PluginCredentialsStore(storage: storage);
    await auth.save(
      const AuthCredentials(
        apiKey: 'gateway-test',
        backendOrigin: 'https://gateway.test',
        ownerId: 'alice',
      ),
    );
    await plugins.setSelectedModel(scope, 'text');
    await plugins.setCredentials(scope, 'text', {'apiKey': 'text-test'});
  });

  Future<ManagedSelection> resolve({
    List<PluginModelDto> models = const [],
    List<AgentDto> agents = const [],
    void Function()? onLoadAgents,
  }) => resolveManagedSelection(
    scope: scope,
    authStore: auth,
    pluginStore: plugins,
    loadModels: ({required gatewayKey, cancelToken}) async => models,
    loadAgents: ({required gatewayKey, cancelToken}) async {
      onLoadAgents?.call();
      return agents;
    },
  );

  test('no agent selected → agent is null, model stays selected', () async {
    final selection = await resolve(models: [_model('text')]);
    expect(selection.agent, isNull);
    expect(selection.modelId, 'text');
  });

  test(
    'template agent → string id, credentials for its model + grants',
    () async {
      await plugins.setAgentConfig(
        scope,
        'productivity',
        AgentConfig(id: 'productivity', kind: AgentKind.template),
      );
      await plugins.setSelectedAgent(scope, 'productivity');
      await plugins.setCredentials(scope, 'vikunja', {'apiKey': 'v-key'});
      await plugins.setCredentials(scope, 'fast', {'apiKey': 'fast-key'});
      var agentLoads = 0;
      final selection = await resolve(
        models: [_model('text'), _model('fast')],
        agents: [
          _agent(
            id: 'productivity',
            defaultModel: 'fast',
            toolGrants: [(pluginId: 'vikunja', required: true)],
          ),
        ],
        onLoadAgents: () {
          agentLoads++;
        },
      );
      expect(agentLoads, 1);
      expect(selection.agent, 'productivity');
      expect(selection.modelId, 'fast');
      expect(selection.credentials.provider, {
        'fast': {'apiKey': 'fast-key'},
        'vikunja': {'apiKey': 'v-key'},
      });
    },
  );

  test(
    'custom agent → spec object, modelRef pins model, grant creds ride',
    () async {
      await plugins.setAgentConfig(
        scope,
        'custom',
        AgentConfig(
          id: 'custom',
          kind: AgentKind.custom,
          name: 'Custom',
          systemPrompt: 'Be terse.',
          modelRef: 'text',
          skills: const ['s1'],
          tools: [AgentToolGrantData(pluginId: 'vikunja', required: true)],
        ),
      );
      await plugins.setSelectedAgent(scope, 'custom');
      await plugins.setCredentials(scope, 'vikunja', {'apiKey': 'v-key'});
      var agentLoads = 0;
      final selection = await resolve(
        models: [_model('text')],
        onLoadAgents: () {
          agentLoads++;
        },
      );
      expect(agentLoads, 0); // custom agents never hit the catalog.
      final wire = selection.agent as Map<String, dynamic>;
      expect(wire['name'], 'Custom');
      expect(wire['systemPrompt'], 'Be terse.');
      expect(wire['modelRef'], 'text');
      expect(wire['tools'], [
        {'pluginId': 'vikunja', 'required': true},
      ]);
      expect(selection.modelId, 'text');
      expect(selection.credentials.provider, {
        'text': {'apiKey': 'text-test'},
        'vikunja': {'apiKey': 'v-key'},
      });
    },
  );

  test('stale template (deleted server-side) degrades to no agent', () async {
    await plugins.setAgentConfig(
      scope,
      'gone',
      AgentConfig(id: 'gone', kind: AgentKind.template),
    );
    await plugins.setSelectedAgent(scope, 'gone');
    final selection = await resolve(models: [_model('text')], agents: const []);
    expect(selection.agent, isNull);
    expect(selection.modelId, 'text');
  });

  test(
    'a seeded enabled template agent never leaks into enabledPlugins',
    () async {
      // `ensureDefaultAgent` / `selectAgent` seed the selected default agent
      // with `enabled: true`; that id must not ride `enabled_plugins` (the
      // gateway would count it as a requested tool, bind nothing, and 502
      // `tools_unavailable` even though the agent has no tools).
      await plugins.setSelectedAgent(scope, 'voice-assistant');
      await plugins.setAgentConfig(
        scope,
        'voice-assistant',
        AgentConfig(id: 'voice-assistant', kind: AgentKind.template),
      );
      await plugins.setEnabled(scope, 'voice-assistant', true);
      await plugins.setEnabled(scope, 'web', true);
      await plugins.setCredentials(scope, 'web', {'apiKey': 'w-key'});

      final selection = await resolve(
        models: [_model('text')],
        agents: [_agent(id: 'voice-assistant')],
      );
      expect(selection.agent, 'voice-assistant');
      expect(selection.enabledPlugins, ['web']);
      expect(
        selection.credentials.provider,
        containsPair('web', {'apiKey': 'w-key'}),
      );
      expect(
        selection.credentials.provider.containsKey('voice-assistant'),
        isFalse,
      );
    },
  );

  test('agent modelRef that is not a configured streaming model → '
      'no_selected_model', () async {
    await plugins.setAgentConfig(
      scope,
      'custom',
      AgentConfig(id: 'custom', kind: AgentKind.custom, modelRef: 'missing'),
    );
    await plugins.setSelectedAgent(scope, 'custom');
    await expectLater(
      resolve(models: [_model('text')]),
      throwsA(
        isA<StagedInferenceUnavailable>().having(
          (e) => e.code,
          'code',
          'no_selected_model',
        ),
      ),
    );
  });

  test('resolveAgentForSend returns null for missing selection/config', () {
    expect(
      resolveAgentForSend(
        selectedAgentId: null,
        config: PluginAccountConfiguration(),
        agents: const [],
      ),
      isNull,
    );
    expect(
      resolveAgentForSend(
        selectedAgentId: 'nope',
        config: PluginAccountConfiguration(),
        agents: const [],
      ),
      isNull,
    );
  });

  test('resolveAgentForSend maps custom and template selections', () {
    final config = PluginAccountConfiguration(
      selectedAgent: 'custom',
      plugins: {
        'custom': PluginConfiguration(
          enabled: true,
          agent: AgentConfig(
            id: 'custom',
            kind: AgentKind.custom,
            modelRef: 'text',
            tools: [AgentToolGrantData(pluginId: 'vikunja', required: true)],
          ),
        ),
      },
    );
    final custom = resolveAgentForSend(
      selectedAgentId: 'custom',
      config: config,
      agents: const [],
    );
    expect(custom!.wire, isA<Map<String, dynamic>>());
    expect(custom.modelRef, 'text');
    expect(custom.toolPlugins, ['vikunja']);

    final template = resolveAgentForSend(
      selectedAgentId: 'tmpl',
      config: PluginAccountConfiguration(
        selectedAgent: 'tmpl',
        plugins: {
          'tmpl': PluginConfiguration(
            enabled: true,
            agent: AgentConfig(id: 'tmpl', kind: AgentKind.template),
          ),
        },
      ),
      agents: [_agent(id: 'tmpl', defaultModel: 'fast')],
    );
    expect(template!.wire, 'tmpl');
    expect(template.modelRef, 'fast');
  });
}
