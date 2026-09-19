import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> agentJson() => {
  'id': 'research-agent',
  'object': 'agent',
  'created': 1700000000,
  'owned_by': 'plugin',
  'name': 'Research Agent',
  'description': 'Deep research agent',
  'defaultModel': 'openai/gpt-4o',
  'visionCapable': true,
  'temperature': 0.3,
  'maxTokens': 8192,
  'toolGrants': [
    {'pluginId': 'web-search', 'required': true},
    {'pluginId': 'code-exec', 'required': false},
  ],
  'skillCount': 5,
};

void main() {
  group('AgentDto', () {
    test('parses valid JSON', () {
      final agent = AgentDto.fromJson(agentJson());
      expect(agent.id, 'research-agent');
      expect(agent.created, 1700000000);
      expect(agent.ownedBy, 'plugin');
      expect(agent.name, 'Research Agent');
      expect(agent.description, 'Deep research agent');
      expect(agent.defaultModel, 'openai/gpt-4o');
      expect(agent.visionCapable, isTrue);
      expect(agent.temperature, 0.3);
      expect(agent.maxTokens, 8192);
      expect(agent.toolGrants, hasLength(2));
      expect(agent.toolGrants[0].pluginId, 'web-search');
      expect(agent.toolGrants[0].required, isTrue);
      expect(agent.toolGrants[1].pluginId, 'code-exec');
      expect(agent.toolGrants[1].required, isFalse);
      expect(agent.skillCount, 5);
    });

    test('parseList succeeds with valid list response', () {
      final agents = AgentDto.parseList({
        'object': 'list',
        'data': [agentJson()],
      });
      expect(agents, hasLength(1));
      expect(agents.single.id, 'research-agent');
    });

    test('parseList rejects non-list object', () {
      expect(
        () => AgentDto.parseList({'object': 'list', 'data': {}}),
        throwsA(isA<PluginProtocolException>()),
      );
    });

    test('parseList rejects wrong object type', () {
      expect(
        () => AgentDto.parseList({
          'object': 'model',
          'data': [agentJson()],
        }),
        throwsA(isA<PluginProtocolException>()),
      );
    });

    test('throws when object field is not "agent"', () {
      expect(
        () => AgentDto.fromJson({...agentJson(), 'object': 'model'}),
        throwsA(isA<PluginProtocolException>()),
      );
    });

    test('throws when id is missing', () {
      expect(
        () => AgentDto.fromJson({
          ...agentJson(),
          'id': null,
        }),
        throwsA(isA<PluginProtocolException>()),
      );
    });

    test('allows optional fields to be absent', () {
      final minimal = AgentDto.fromJson({
        'id': 'minimal-agent',
        'object': 'agent',
        'created': 1,
        'owned_by': 'sys',
        'name': 'Minimal',
        'description': 'Minimal agent',
        'visionCapable': false,
        'skillCount': 0,
      });
      expect(minimal.defaultModel, isNull);
      expect(minimal.temperature, isNull);
      expect(minimal.maxTokens, isNull);
      expect(minimal.toolGrants, isEmpty);
      expect(minimal.skillCount, 0);
    });

    test('toolGrants default to empty list when absent', () {
      final json = <String, dynamic>{...agentJson()}..remove('toolGrants');
      final agent = AgentDto.fromJson(json);
      expect(agent.toolGrants, isEmpty);
    });
  });

  group('AgentToolGrant', () {
    test('parses required grant', () {
      final grant = AgentToolGrant.fromJson({
        'pluginId': 'web-search',
        'required': true,
      });
      expect(grant.pluginId, 'web-search');
      expect(grant.required, isTrue);
    });

    test('parses optional grant', () {
      final grant = AgentToolGrant.fromJson({
        'pluginId': 'code-exec',
        'required': false,
      });
      expect(grant.pluginId, 'code-exec');
      expect(grant.required, isFalse);
    });
  });

  group('PluginDto with agent type', () {
    Map<String, dynamic> agentPluginJson() => {
      'id': 'research-agent',
      'type': 'agent',
      'name': 'Research Agent',
      'description': 'Deep research agent',
      'version': '1.0.0',
      'schemaVersion': 1,
      'installed': true,
      'baseUrls': [
        {'id': 'primary', 'label': 'Primary'},
      ],
    };

    test('isSupported returns true for agent type', () {
      final plugin = PluginDto.fromSummaryJson(agentPluginJson());
      expect(plugin.isSupported, isTrue);
    });

    test('parses without error despite no tools or inference', () {
      final plugin = PluginDto.fromSummaryJson(agentPluginJson());
      expect(plugin.tools, isEmpty);
      expect(plugin.inference, isNull);
      expect(plugin.baseUrls, isNotEmpty);
    });

    test('parses without baseUrls key', () {
      final json = <String, dynamic>{...agentPluginJson()}..remove('baseUrls');
      final plugin = PluginDto.fromSummaryJson(json);
      expect(plugin.baseUrls, isEmpty);
    });

    test('isSupported false for wrong schemaVersion', () {
      final plugin = PluginDto.fromSummaryJson({
        ...agentPluginJson(),
        'schemaVersion': 2,
      });
      expect(plugin.isSupported, isFalse);
    });
  });

  group('PluginDto.isSupported', () {
    test('accepts tool, model, and agent types', () {
      for (final entry in [
        {'type': 'tool', 'tools': [{'name': 'list', 'description': 'List', 'readOnly': true, 'inputSchema': {'type': 'object'}}]},
        {'type': 'model', 'inference': {'defaultModel': 'm', 'tokenLimit': 4096, 'supportsStreaming': true, 'visionCapable': true}},
        {'type': 'agent'},
      ]) {
        expect(
          PluginDto.fromSummaryJson({
            'id': 'test',
            'type': entry['type'] as String,
            'name': 'Test',
            'description': 'Test',
            'version': '1.0.0',
            'schemaVersion': 1,
            'installed': true,
            if (entry.containsKey('tools')) 'tools': entry['tools'],
            if (entry.containsKey('inference')) 'inference': entry['inference'],
          }).isSupported,
          isTrue,
          reason: '${entry['type']} should be supported',
        );
      }
    });

    test('rejects unknown types', () {
      for (final type in ['future', 'unknown', 'plugin']) {
        expect(
          PluginDto.fromSummaryJson({
            'id': 'test',
            'type': type,
            'name': 'Test',
            'description': 'Test',
            'version': '1.0.0',
            'schemaVersion': 1,
            'installed': true,
          }).isSupported,
          isFalse,
          reason: '$type should not be supported',
        );
      }
    });
  });
}