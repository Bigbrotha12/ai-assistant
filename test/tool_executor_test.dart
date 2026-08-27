import 'package:ai_assistant/features/chat/tool_executor.dart';
import 'package:flutter_test/flutter_test.dart';

class EchoTool implements Tool {
  @override
  String get name => 'echo';

  @override
  Map<String, Object?> get inputSchema => const {
        'type': 'object',
        'properties': {'text': {'type': 'string'}},
        'required': ['text'],
        'additionalProperties': false,
      };

  @override
  Future<String> execute(Map<String, dynamic> args) async => 'echo: ${args['text']}';
}

void main() {
  group('ToolRegistry', () {
    test('find and has', () {
      final registry = buildDefaultToolRegistry();
      expect(registry.has('voices'), isTrue);
      expect(registry.has('nope'), isFalse);
      final tool = registry.find('voices');
      expect(tool, isNotNull);
      expect(tool!.name, 'voices');
      expect(registry.find('nope'), isNull);
    });

    test('toolDefinitions has the expected shape', () {
      final registry = buildDefaultToolRegistry();
      final defs = registry.toolDefinitions;
      expect(defs, hasLength(1));
      final def = defs.single;
      expect(def['type'], 'function');
      final fn = def['function'] as Map<String, Object?>;
      expect(fn['name'], 'voices');
      expect(fn['parameters'], isA<Map>());
    });

    test('dispatch unknown tool returns error result', () async {
      final registry = buildDefaultToolRegistry();
      final result = await registry.dispatch('does_not_exist', const {});
      expect(result.toolName, 'does_not_exist');
      expect(result.ok, isFalse);
      expect(result.message, contains('unknown tool'));
    });

    test('dispatch voices() with valid (empty) args returns ok result', () async {
      final registry = buildDefaultToolRegistry();
      final result = await registry.dispatch('voices', const {});
      expect(result.ok, isTrue);
      expect(result.message, 'voices tool is not available yet');
    });

    test('dispatch voices() with args fails schema validation', () async {
      final registry = buildDefaultToolRegistry();
      // additionalProperties:false -> any arg is rejected.
      final result = await registry.dispatch('voices', const {'extra': 1});
      expect(result.ok, isFalse);
      expect(result.message, isNotEmpty);
    });

    test('dispatch executes and wraps result for a custom tool', () async {
      final registry = ToolRegistry(tools: [EchoTool()]);
      final result = await registry.dispatch('echo', const {'text': 'hi'});
      expect(result.ok, isTrue);
      expect(result.toolName, 'echo');
      expect(result.message, 'echo: hi');
    });

    test('dispatch rejects invalid args before execution', () async {
      final registry = ToolRegistry(tools: [EchoTool()]);
      // 'text' is required and must be a string.
      final result = await registry.dispatch('echo', const {'text': 42});
      expect(result.ok, isFalse);
    });
  });
}
