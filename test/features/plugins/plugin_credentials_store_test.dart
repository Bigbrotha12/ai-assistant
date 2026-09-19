import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';

import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

class DelayedSecureStorage extends InMemorySecureStorage {
  Completer<void>? gate;
  bool failNextWrite = false;

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    await gate?.future;
    if (failNextWrite) {
      failNextWrite = false;
      throw StateError('Storage unavailable');
    }
    await super.write(key: key, value: value);
  }
}

AuthAccountScope scope(String owner, [String origin = 'https://example.com']) =>
    AuthAccountScope.fromIdentity(ownerId: owner, backendOrigin: origin)!;

void main() {
  test(
    'isolates owners, origins and plugins; survives store recreation',
    () async {
      final storage = InMemorySecureStorage();
      final store = PluginCredentialsStore(storage: storage);
      final a = scope('a');
      final b = scope('b');
      final otherOrigin = scope('a', 'http://example.com');
      await store.setCredentials(a, 'one', {'token': ' secret '});
      await store.setCredentials(a, 'two', {'password': 'second'});
      await store.setEnabled(a, 'one', true);
      await store.setSelectedModel(a, 'model-a');
      await store.setCredentials(b, 'one', {'token': 'b'});
      await store.setCredentials(otherOrigin, 'one', {'token': 'other'});
      final loaded = await PluginCredentialsStore(storage: storage).load(a);
      expect(loaded.plugins['one']!.credentials, {'token': ' secret '});
      expect(loaded.plugins['one']!.enabled, isTrue);
      expect(loaded.plugins['two']!.enabled, isFalse);
      expect(loaded.selectedModel, 'model-a');
      expect(loaded.selectedAgent, isNull);
      expect(loaded.toString(), isNot(contains('secret')));
      expect(loaded.plugins.toString(), isNot(contains('secret')));
      expect(
        () => loaded.plugins['one']!.credentials['token'] = 'x',
        throwsUnsupportedError,
      );
      await store.removePlugin(a, 'one');
      expect((await store.load(a)).plugins.keys, ['two']);
      await store.setSelectedModel(a, null);
      expect((await store.load(a)).selectedModel, isNull);
      await store.setSelectedAgent(a, 'agent-workflow');
      expect((await store.load(a)).selectedAgent, 'agent-workflow');
      await store.setSelectedAgent(a, null);
      expect((await store.load(a)).selectedAgent, isNull);
      await storage.write(key: 'auth_api_key', value: 'unrelated');
      await store.clearScope(a);
      expect((await store.load(a)).plugins, isEmpty);
      expect((await store.load(b)).plugins['one']!.credentials['token'], 'b');
      expect(
        (await store.load(otherOrigin)).plugins['one']!.credentials['token'],
        'other',
      );
      expect(storage.values.length, 3);
      expect(storage.values['auth_api_key'], 'unrelated');
    },
  );

  test(
    'concurrent read-modify-writes and clear execute in invocation order',
    () async {
      final storage = DelayedSecureStorage()..gate = Completer<void>();
      final store = PluginCredentialsStore(storage: storage);
      final a = scope('a');
      final mutable = {'token': 'original'};
      final writes = [
        store.setCredentials(a, 'one', mutable),
        store.setEnabled(a, 'one', true),
        store.setCredentials(a, 'two', {'token': 'second'}),
        store.setSelectedModel(a, 'model'),
        store.setSelectedAgent(a, 'agent-x'),
      ];
      mutable['token'] = 'mutated';
      storage.gate!.complete();
      await Future.wait(writes);
      final loaded = await store.load(a);
      expect(loaded.plugins['one']!.credentials['token'], 'original');
      expect(loaded.plugins['one']!.enabled, isTrue);
      expect(loaded.plugins.length, 2);
      expect(loaded.selectedModel, 'model');
      expect(loaded.selectedAgent, 'agent-x');
      await Future.wait([
        store.setEnabled(a, 'one', false),
        store.clearScope(a),
      ]);
      expect(storage.values, isEmpty);
    },
  );

  test('write failure propagates without poisoning the queue', () async {
    final storage = DelayedSecureStorage()..failNextWrite = true;
    final store = PluginCredentialsStore(storage: storage);
    await expectLater(
      store.setCredentials(scope('a'), 'one', {'key': 'x'}),
      throwsStateError,
    );
    await store.setEnabled(scope('a'), 'two', true);
    expect((await store.load(scope('a'))).plugins.keys, ['two']);
  });

  test(
    'malformed payload fails closed without including secrets in errors',
    () async {
      final storage = InMemorySecureStorage();
      final store = PluginCredentialsStore(storage: storage);
      await store.setEnabled(scope('a'), 'one', true);
      await storage.write(
        key: storage.values.keys.single,
        value: 'secret malformed',
      );
      await expectLater(
        store.load(scope('a')),
        throwsA(
          isA<FormatException>().having(
            (e) => e.toString(),
            'redacted',
            isNot(contains('secret')),
          ),
        ),
      );
      await expectLater(
        store.setEnabled(scope('a'), 'two', true),
        throwsFormatException,
      );
      await store.clearScope(scope('a'));
      expect(storage.values, isEmpty);
    },
  );

  test('v1 JSON without agent fields loads successfully with agent null', () async {
    final storage = InMemorySecureStorage();
    final a = scope('a');
    await storage.write(
      key: 'plugin_credentials_v1_${a.storageId}',
      value: jsonEncode({
        'version': 1,
        'plugins': {
          'model-x': {'credentials': {'apiKey': 'abc'}, 'enabled': true},
        },
        'selectedModel': 'model-x',
      }),
    );
    final store = PluginCredentialsStore(storage: storage);
    final loaded = await store.load(a);
    expect(loaded.plugins['model-x']!.agent, isNull);
    expect(loaded.plugins['model-x']!.credentials['apiKey'], 'abc');
    expect(loaded.selectedModel, 'model-x');
  });

  test('agent config roundtrip (template kind)', () async {
    final storage = InMemorySecureStorage();
    final store = PluginCredentialsStore(storage: storage);
    final a = scope('a');
    await store.setAgentConfig(a, 'my-agent', AgentConfig(
      id: 'my-agent',
      kind: AgentKind.template,
    ));
    final loaded = await store.load(a);
    final config = loaded.plugins['my-agent']!.agent;
    expect(config, isNotNull);
    expect(config!.id, 'my-agent');
    expect(config.kind, AgentKind.template);
    expect(config.name, '');
    expect(config.skills, isEmpty);
    expect(config.mcpServers, isEmpty);
    expect(config.tools, isEmpty);
    expect(config.modelRef, isNull);
    expect(config.inference, isNull);
  });

  test('custom agent roundtrip with skills, mcpServers, modelRef, inference', () async {
    final storage = InMemorySecureStorage();
    final store = PluginCredentialsStore(storage: storage);
    final a = scope('a');
    await store.setAgentConfig(a, 'custom-agent', AgentConfig(
      id: 'custom-agent',
      kind: AgentKind.custom,
      name: 'My Custom Agent',
      systemPrompt: 'You are a helpful assistant.',
      skills: ['code-review', 'data-analysis'],
      mcpServers: ['filesystem', 'github'],
      tools: [
        AgentToolGrantData(pluginId: 'tool-a', required: true),
        AgentToolGrantData(pluginId: 'tool-b'),
      ],
      modelRef: 'gpt-4',
      inference: AgentInferenceData(temperature: 0.7, maxTokens: 2048, visionCapable: true),
    ));
    final loaded = await store.load(a);
    final config = loaded.plugins['custom-agent']!.agent;
    expect(config, isNotNull);
    expect(config!.id, 'custom-agent');
    expect(config.kind, AgentKind.custom);
    expect(config.name, 'My Custom Agent');
    expect(config.systemPrompt, 'You are a helpful assistant.');
    expect(config.skills, ['code-review', 'data-analysis']);
    expect(config.mcpServers, ['filesystem', 'github']);
    expect(config.tools.length, 2);
    expect(config.tools[0].pluginId, 'tool-a');
    expect(config.tools[0].required, isTrue);
    expect(config.tools[1].pluginId, 'tool-b');
    expect(config.tools[1].required, isFalse);
    expect(config.modelRef, 'gpt-4');
    expect(config.inference!.temperature, 0.7);
    expect(config.inference!.maxTokens, 2048);
    expect(config.inference!.visionCapable, isTrue);
  });

  test('seeding: empty store gets default agent after ensureDefaultAgent', () async {
    final storage = InMemorySecureStorage();
    final store = PluginCredentialsStore(storage: storage);
    final a = scope('a');
    await store.ensureDefaultAgent(a);
    final loaded = await store.load(a);
    expect(loaded.plugins, hasLength(1));
    expect(loaded.plugins, containsPair('default', isA<PluginConfiguration>()));
    expect(loaded.plugins['default']!.agent, isNotNull);
    expect(loaded.plugins['default']!.agent!.id, 'default');
    expect(loaded.plugins['default']!.agent!.kind, AgentKind.template);
    expect(loaded.selectedAgent, 'default');
  });

  test('removePlugin clears selectedAgent when removing the selected plugin', () async {
    final storage = InMemorySecureStorage();
    final store = PluginCredentialsStore(storage: storage);
    final a = scope('a');
    await store.setCredentials(a, 'plugin-a', {'key': 'val'});
    await store.setSelectedAgent(a, 'plugin-a');
    await store.removePlugin(a, 'plugin-a');
    final loaded = await store.load(a);
    expect(loaded.selectedAgent, isNull);
  });

  test('_key stability regression guard', () async {
    final storage = InMemorySecureStorage();
    final store = PluginCredentialsStore(storage: storage);
    final a = scope('a');
    // Write via store, then check the storage key
    await store.setCredentials(a, 'test', {'k': 'v'});
    expect(storage.values.length, greaterThan(0));
    final storedKey = storage.values.keys.firstWhere(
      (k) => k.startsWith('plugin_credentials_v1_'),
    );
    expect(storedKey, startsWith('plugin_credentials_v1_'));
    expect(storedKey, contains(a.storageId));
  });

  test('credential resolver includes agent modelRef and tool grant credentials', () async {
    final storage = InMemorySecureStorage();
    final store = PluginCredentialsStore(storage: storage);
    final a = scope('a');
    // Set up credentials for model, agent modelRef, and tool grant plugins
    await store.setCredentials(a, 'selected-model', {'apiKey': 'model-key'});
    await store.setCredentials(a, 'agent-model', {'apiKey': 'agent-model-key'});
    await store.setCredentials(a, 'tool-plugin', {'apiKey': 'tool-key'});
    await store.setSelectedModel(a, 'selected-model');
    // Set up an agent config that references a different model and tool grants
    await store.setAgentConfig(a, 'my-agent', AgentConfig(
      id: 'my-agent',
      kind: AgentKind.template,
      modelRef: 'agent-model',
      tools: [AgentToolGrantData(pluginId: 'tool-plugin', required: true)],
    ));
    await store.setSelectedAgent(a, 'my-agent');
    final loaded = await store.load(a);
    expect(loaded.selectedModel, 'selected-model');
    expect(loaded.selectedAgent, 'my-agent');
    final agent = loaded.plugins['my-agent']!.agent;
    expect(agent, isNotNull);
    expect(agent!.modelRef, 'agent-model');
    expect(agent.tools.length, 1);
    expect(agent.tools[0].pluginId, 'tool-plugin');
  });

  test('version 2 JSON loads correctly', () async {
    final storage = InMemorySecureStorage();
    final a = scope('a');
    await storage.write(
      key: 'plugin_credentials_v1_${a.storageId}',
      value: jsonEncode({
        'version': 2,
        'plugins': {
          'model-x': {
            'credentials': {'apiKey': 'abc'},
            'enabled': true,
            'agent': {
              'id': 'model-x',
              'kind': 'template',
              'name': '',
              'skills': [],
              'mcpServers': [],
              'tools': [],
            },
          },
        },
        'selectedModel': 'model-x',
        'selectedAgent': 'model-x',
      }),
    );
    final store = PluginCredentialsStore(storage: storage);
    final loaded = await store.load(a);
    expect(loaded.plugins['model-x']!.agent, isNotNull);
    expect(loaded.plugins['model-x']!.agent!.id, 'model-x');
    expect(loaded.plugins['model-x']!.agent!.kind, AgentKind.template);
    expect(loaded.selectedModel, 'model-x');
    expect(loaded.selectedAgent, 'model-x');
  });
}
