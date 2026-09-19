import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/plugin_registry_client.dart';

import 'data/langchain_client_test.dart' show FakePluginAdapter;

Response<dynamic> jsonDioResponse(Object value) => Response<dynamic>(
  data: value,
  requestOptions: RequestOptions(path: ''),
  statusCode: 200,
);

void main() {
  group('AgentConfig serialization', () {
    test('roundtrip: template kind', () {
      final config = AgentConfig(
        id: 'code-reviewer',
        kind: AgentKind.template,
        name: 'Code Reviewer',
        description: 'Reviews code for patterns and issues',
        modelRef: 'gpt-4',
      );
      final json = config.toJson();
      expect(json['id'], 'code-reviewer');
      expect(json['kind'], 'template');
      expect(json['name'], 'Code Reviewer');
      expect(json['description'], 'Reviews code for patterns and issues');
      expect(json['modelRef'], 'gpt-4');
      expect(json['skills'], []);
      expect(json['mcpServers'], []);
      expect(json['tools'], []);

      final restored = AgentConfig.fromJson(json);
      expect(restored.id, config.id);
      expect(restored.kind, config.kind);
      expect(restored.name, config.name);
      expect(restored.description, config.description);
      expect(restored.modelRef, config.modelRef);
      expect(restored.skills, []);
      expect(restored.mcpServers, []);
    });

    test('roundtrip: custom agent with all fields', () {
      final config = AgentConfig(
        id: 'my-custom-agent',
        kind: AgentKind.custom,
        name: 'My Custom Agent',
        description: 'A custom agent for data analysis',
        systemPrompt: 'You are a data analyst assistant.',
        skills: ['sql-query', 'chart-generation', 'statistical-analysis'],
        mcpServers: ['filesystem', 'database'],
        tools: [
          AgentToolGrantData(pluginId: 'code-executor', required: true),
          AgentToolGrantData(pluginId: 'web-search'),
        ],
        modelRef: 'claude-3-opus',
        inference: AgentInferenceData(
          temperature: 0.3,
          maxTokens: 4096,
          visionCapable: false,
        ),
      );
      final json = config.toJson();
      expect(json['id'], 'my-custom-agent');
      expect(json['kind'], 'custom');
      expect(json['name'], 'My Custom Agent');
      expect(json['systemPrompt'], 'You are a data analyst assistant.');
      expect(json['skills'], ['sql-query', 'chart-generation', 'statistical-analysis']);
      expect(json['mcpServers'], ['filesystem', 'database']);
      expect(
        json['tools'],
        [
          {'pluginId': 'code-executor', 'required': true},
          {'pluginId': 'web-search', 'required': false},
        ],
      );
      expect(json['modelRef'], 'claude-3-opus');
      expect(json['inference'], {
        'temperature': 0.3,
        'maxTokens': 4096,
        'visionCapable': false,
      });

      final restored = AgentConfig.fromJson(json);
      expect(restored.id, config.id);
      expect(restored.kind, config.kind);
      expect(restored.systemPrompt, config.systemPrompt);
      expect(restored.skills, config.skills);
      expect(restored.mcpServers, config.mcpServers);
      expect(restored.tools.length, 2);
      expect(restored.tools[0].pluginId, 'code-executor');
      expect(restored.tools[0].required, isTrue);
      expect(restored.tools[1].pluginId, 'web-search');
      expect(restored.tools[1].required, isFalse);
      expect(restored.modelRef, config.modelRef);
      expect(restored.inference!.temperature, 0.3);
      expect(restored.inference!.maxTokens, 4096);
    });

    test('json shape matches server customAgentSpecSchema', () {
      final config = AgentConfig(
        id: 'agent-1',
        kind: AgentKind.custom,
        name: 'Test Agent',
        systemPrompt: 'You are helpful.',
        skills: ['skill-a'],
        mcpServers: ['mcp-a'],
        tools: [AgentToolGrantData(pluginId: 'tool-a')],
      );
      final json = config.toJson();
      // The server expects this shape for custom agent spec
      final spec = <String, dynamic>{
        'name': json['name'],
        if (json['systemPrompt'] != null) 'systemPrompt': json['systemPrompt'],
        'skills': json['skills'],
        'mcpServers': (json['mcpServers'] as List).map((n) => {'name': n}).toList(),
        'tools': json['tools'],
      };
      expect(spec['name'], 'Test Agent');
      expect(spec['systemPrompt'], 'You are helpful.');
      expect(spec['skills'], ['skill-a']);
      expect(spec['mcpServers'], [{'name': 'mcp-a'}]);
      expect(spec['tools'], [{'pluginId': 'tool-a', 'required': false}]);
    });
  });

  group('PluginRegistryClient catalog methods', () {
    test('fetchSkills calls /v1/skills and returns data', () async {
      final dio = Dio()..httpClientAdapter = FakePluginAdapter((options) {
        expect(options.uri.path, '/v1/skills');
        expect(options.headers['Authorization'], 'Bearer test-key');
        return ResponseBody.fromString(
          jsonEncode({'data': [
            {'id': 'skill-1', 'title': 'Code Review'},
            {'id': 'skill-2', 'title': 'Data Analysis'},
          ]}),
          200,
          headers: {'content-type': ['application/json']},
        );
      });
      final client = PluginRegistryClient(dio: dio, baseUrl: 'http://test:17600/v1');
      final result = await client.fetchSkills(gatewayKey: 'test-key');
      expect(result, hasLength(2));
      expect(result[0]['id'], 'skill-1');
      expect(result[1]['title'], 'Data Analysis');
      dio.close(force: true);
    });

    test('fetchMcps calls /v1/mcps and returns data', () async {
      final dio = Dio()..httpClientAdapter = FakePluginAdapter((options) {
        expect(options.uri.path, '/v1/mcps');
        return ResponseBody.fromString(
          jsonEncode({'data': [
            {'name': 'filesystem', 'description': 'Filesystem access'},
            {'name': 'github', 'description': 'GitHub API'},
          ]}),
          200,
          headers: {'content-type': ['application/json']},
        );
      });
      final client = PluginRegistryClient(dio: dio, baseUrl: 'http://test:17600/v1');
      final result = await client.fetchMcps(gatewayKey: 'test-key');
      expect(result, hasLength(2));
      expect(result[0]['name'], 'filesystem');
      expect(result[1]['name'], 'github');
      dio.close(force: true);
    });

    test('fetchAgentTemplates calls /v1/agents and returns data', () async {
      final dio = Dio()..httpClientAdapter = FakePluginAdapter((options) {
        expect(options.uri.path, '/v1/agents');
        return ResponseBody.fromString(
          jsonEncode({'data': [
            {'id': 'template-1', 'name': 'Default Agent', 'skillCount': 2},
            {'id': 'template-2', 'name': 'Research Agent', 'skillCount': 3},
          ]}),
          200,
          headers: {'content-type': ['application/json']},
        );
      });
      final client = PluginRegistryClient(dio: dio, baseUrl: 'http://test:17600/v1');
      final result = await client.fetchAgentTemplates(gatewayKey: 'test-key');
      expect(result, hasLength(2));
      expect(result[0]['id'], 'template-1');
      expect(result[1]['name'], 'Research Agent');
      dio.close(force: true);
    });

    test('fetchSkills throws on error response', () async {
      final dio = Dio()..httpClientAdapter = FakePluginAdapter((_) =>
        ResponseBody.fromString(
          jsonEncode({'error': 'internal'}),
          500,
          headers: {'content-type': ['application/json']},
        ),
      );
      final client = PluginRegistryClient(dio: dio, baseUrl: 'http://test:17600/v1');
      expect(
        () => client.fetchSkills(gatewayKey: 'test-key'),
        throwsA(isA<DioException>()),
      );
      dio.close(force: true);
    });
  });
}