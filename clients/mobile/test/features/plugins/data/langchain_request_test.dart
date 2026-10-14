import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/langchain_request.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  LangChainRequest request({Object? agent}) => LangChainRequest(
    gatewayKey: 'gateway-key',
    modelPluginId: 'openrouter',
    credentials: const {},
    messages: const [ApiMessage(role: 'user', content: 'hi')],
    agent: agent,
  );

  test('omits agent when null', () {
    expect(request().toJson().containsKey('agent'), isFalse);
  });

  test('serializes a template agent as its string id', () {
    expect(request(agent: 'productivity').toJson()['agent'], 'productivity');
  });

  test('serializes a custom agent spec object (frozen copy)', () {
    final spec = <String, dynamic>{
      'name': 'Custom',
      'systemPrompt': 'You are helpful.',
      'skills': ['s1'],
      'mcpServers': [
        {'name': 'calendar'},
      ],
      'tools': [
        {'pluginId': 'vikunja', 'required': true},
      ],
      'modelRef': 'openrouter',
      'inference': {'temperature': 0.7, 'maxTokens': 2048, 'visionCapable': true},
    };
    final wire = request(agent: spec).toJson()['agent'] as Map<String, dynamic>;
    expect(wire['name'], 'Custom');
    expect(wire['systemPrompt'], 'You are helpful.');
    expect(wire['modelRef'], 'openrouter');
    expect((wire['tools'] as List).single['required'], isTrue);
    expect(wire['inference'], {
      'temperature': 0.7,
      'maxTokens': 2048,
      'visionCapable': true,
    });
  });

  test('rejects a non-string non-map agent', () {
    expect(() => request(agent: 42), throwsA(isA<PluginClientException>()));
    expect(() => request(agent: <Object?>[]), throwsA(isA<PluginClientException>()));
  });

  test('validates a string template id', () {
    expect(
      () => request(agent: 'Not An Id'),
      throwsA(isA<PluginProtocolException>()),
    );
    expect(() => request(agent: 'Bad_Id'), throwsA(isA<PluginProtocolException>()));
  });

  test('background managed request still carries the agent', () {
    final request = LangChainRequest(
      gatewayKey: 'gateway-key',
      modelPluginId: 'openrouter',
      credentials: const {},
      messages: const [ApiMessage(role: 'user', content: 'hi')],
      managed: true,
      background: true,
      turnId: 'turn-1',
      agent: 'productivity',
    );
    final json = request.toJson();
    expect(json['agent'], 'productivity');
    expect(json['background'], isTrue);
  });
}