import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
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

    test('toWireObject carries tools, modelRef, and inference for the gateway', () {
      final config = AgentConfig(
        id: 'wire-agent',
        kind: AgentKind.custom,
        name: 'Wire Agent',
        description: 'desc',
        systemPrompt: 'sys',
        skills: ['skill-a'],
        mcpServers: ['mcp-a'],
        tools: [AgentToolGrantData(pluginId: 'web-search', required: true)],
        modelRef: 'openrouter',
        inference: AgentInferenceData(
          temperature: 0.7,
          maxTokens: 4096,
          visionCapable: true,
        ),
      );
      final wire = config.toWireObject();
      expect(wire['name'], 'Wire Agent');
      expect(wire['description'], 'desc');
      expect(wire['systemPrompt'], 'sys');
      expect(wire['skills'], ['skill-a']);
      expect(wire['mcpServers'], [
        {'name': 'mcp-a'},
      ]);
      expect(wire['tools'], [
        {'pluginId': 'web-search', 'required': true},
      ]);
      expect(wire['modelRef'], 'openrouter');
      expect(wire['inference'], {
        'temperature': 0.7,
        'maxTokens': 4096,
        'visionCapable': true,
      });
      expect(wire.containsKey('id'), isFalse);
      expect(wire.containsKey('kind'), isFalse);
    });

    test('inference omits unset temperature/maxTokens but keeps visionCapable', () {
      final json = AgentInferenceData(visionCapable: false).toJson();
      expect(json.containsKey('temperature'), isFalse);
      expect(json.containsKey('maxTokens'), isFalse);
      expect(json['visionCapable'], isFalse);

      final restored = AgentInferenceData.fromJson(json);
      expect(restored.temperature, isNull);
      expect(restored.maxTokens, isNull);
      expect(restored.visionCapable, isFalse);
    });
  });

  group('PluginRegistryClient catalog methods', () {
    List<Future<List<Map<String, dynamic>>> Function()> catalogRequests(
      PluginRegistryClient client,
    ) => [
      () => client.fetchSkills(gatewayKey: 'test-key'),
      () => client.fetchMcps(gatewayKey: 'test-key'),
      () => client.fetchAgentTemplates(gatewayKey: 'test-key'),
    ];

    Future<void> expectCatalogError(
      Future<List<Map<String, dynamic>>> Function() request, {
      required String code,
      required int? statusCode,
      Duration? retryAfter,
    }) async {
      await expectLater(
        request(),
        throwsA(
          isA<PluginClientException>()
              .having((error) => error.code, 'code', code)
              .having((error) => error.statusCode, 'status', statusCode)
              .having((error) => error.retryAfter, 'retryAfter', retryAfter),
        ),
      );
    }

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
        expect(options.headers['Authorization'], 'Bearer test-key');
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
        expect(options.headers['Authorization'], 'Bearer test-key');
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

    test('fetchSkills maps error responses to typed exceptions', () async {
      final dio = Dio()
        ..httpClientAdapter = FakePluginAdapter(
          (_) => ResponseBody.fromString(
            jsonEncode({'error': 'internal'}),
            500,
            headers: {
              'content-type': ['application/json'],
            },
          ),
        );
      final client = PluginRegistryClient(
        dio: dio,
        baseUrl: 'http://test:17600/v1',
      );
      await expectCatalogError(
        () => client.fetchSkills(gatewayKey: 'test-key'),
        code: 'internal',
        statusCode: 500,
      );
      dio.close(force: true);
    });

    test('catalog 401 responses map to typed unauthorized errors', () async {
      final dio = Dio()
        ..httpClientAdapter = FakePluginAdapter(
          (_) => ResponseBody.fromString(
            jsonEncode({'error': 'unauthorized'}),
            401,
            headers: {
              'content-type': ['application/json'],
            },
          ),
        );
      final client = PluginRegistryClient(
        dio: dio,
        baseUrl: 'http://test:17600/v1',
      );
      for (final request in catalogRequests(client)) {
        await expectCatalogError(
          request,
          code: 'unauthorized',
          statusCode: 401,
        );
      }
      dio.close(force: true);
    });

    test('catalog 403 email verification errors map to typed errors', () async {
      final dio = Dio()
        ..httpClientAdapter = FakePluginAdapter(
          (_) => ResponseBody.fromString(
            jsonEncode({'error': 'email_not_verified'}),
            403,
            headers: {
              'content-type': ['application/json'],
            },
          ),
        );
      final client = PluginRegistryClient(
        dio: dio,
        baseUrl: 'http://test:17600/v1',
      );
      for (final request in catalogRequests(client)) {
        await expectCatalogError(
          request,
          code: 'email_not_verified',
          statusCode: 403,
        );
      }
      dio.close(force: true);
    });

    test('catalog 429 responses preserve Retry-After', () async {
      final dio = Dio()
        ..httpClientAdapter = FakePluginAdapter(
          (_) => ResponseBody.fromString(
            jsonEncode({'error': 'rate_limited'}),
            429,
            headers: {
              'content-type': ['application/json'],
              'retry-after': ['12'],
            },
          ),
        );
      final client = PluginRegistryClient(
        dio: dio,
        baseUrl: 'http://test:17600/v1',
      );
      for (final request in catalogRequests(client)) {
        await expectCatalogError(
          request,
          code: 'rate_limited',
          statusCode: 429,
          retryAfter: const Duration(seconds: 12),
        );
      }
      dio.close(force: true);
    });

    test(
      'catalog transport failures map to typed timeout and network errors',
      () async {
        for (final type in [
          DioExceptionType.connectionTimeout,
          DioExceptionType.connectionError,
        ]) {
          final dio = Dio()
            ..httpClientAdapter = FakePluginAdapter((options) {
              throw DioException(
                requestOptions: options,
                type: type,
                message: 'private transport detail',
              );
            });
          final client = PluginRegistryClient(
            dio: dio,
            baseUrl: 'http://test:17600/v1',
          );
          for (final request in catalogRequests(client)) {
            await expectCatalogError(
              request,
              code: type == DioExceptionType.connectionTimeout
                  ? 'timeout'
                  : 'network_error',
              statusCode: null,
            );
          }
          dio.close(force: true);
        }
      },
    );

    test('malformed catalog envelopes map to invalid_response', () async {
      for (final body in [
        'not-json',
        '{}',
        jsonEncode({'data': null}),
        jsonEncode({'data': {}}),
        jsonEncode({
          'data': [1],
        }),
      ]) {
        final dio = Dio()
          ..httpClientAdapter = FakePluginAdapter(
            (_) => ResponseBody.fromString(
              body,
              200,
              headers: {
                'content-type': ['application/json'],
              },
            ),
          );
        final client = PluginRegistryClient(
          dio: dio,
          baseUrl: 'http://test:17600/v1',
        );
        for (final request in catalogRequests(client)) {
          await expectCatalogError(
            request,
            code: 'invalid_response',
            statusCode: null,
          );
        }
        dio.close(force: true);
      }
    });
  });
}
