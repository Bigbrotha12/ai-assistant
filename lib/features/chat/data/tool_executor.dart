import 'package:json_schema/json_schema.dart';

import '../../attachments/data/tool_files.dart';

/// A tool the model may call. Phase 2 is plumbing-only: the registry and
/// validation exist, but only a placeholder `voices()` tool is registered.
abstract class Tool {
  String get name;
  Map<String, Object?> get inputSchema; // JSON Schema (draft-07 subset)
  Future<String> execute(Map<String, dynamic> args);
}

class ToolResult {
  final String toolName;
  final bool ok;
  final String message; // result text fed back to the model as the tool role content
  const ToolResult({
    required this.toolName,
    required this.ok,
    required this.message,
  });
}

/// Allowlist registry. Dispatch validates args against the tool's schema
/// BEFORE execution; unknown tool names are rejected.
class ToolRegistry {
  final Map<String, Tool> _tools;

  ToolRegistry({List<Tool>? tools})
      : _tools = {for (final t in tools ?? const []) t.name: t};

  Tool? find(String name) => _tools[name];

  bool has(String name) => _tools.containsKey(name);

  /// For the API `tools` array:
  /// [{"type":"function","function":{"name":...,"parameters":...}}]
  List<Map<String, Object?>> get toolDefinitions => [
        for (final tool in _tools.values)
          {
            'type': 'function',
            'function': {
              'name': tool.name,
              'parameters': tool.inputSchema,
            },
          },
      ];

  Future<ToolResult> dispatch(String name, Map<String, dynamic> args) async {
    final tool = _tools[name];
    if (tool == null) {
      return ToolResult(
        toolName: name,
        ok: false,
        message: 'unknown tool: $name',
      );
    }

    final schema = JsonSchema.create(tool.inputSchema);
    final result = schema.validate(args);
    if (!result.isValid) {
      return ToolResult(
        toolName: name,
        ok: false,
        message: result.errors.map((e) => e.toString()).join('; '),
      );
    }

    final execution = await tool.execute(args);
    return ToolResult(toolName: name, ok: true, message: execution);
  }
}

/// The placeholder tool registered in Phase 2. Accepts no arguments and
/// always reports that it is not yet available.
class VoicesTool implements Tool {
  @override
  String get name => 'voices';

  @override
  Map<String, Object?> get inputSchema =>
      const {'type': 'object', 'properties': {}, 'additionalProperties': false};

  @override
  Future<String> execute(Map<String, dynamic> args) async {
    return 'voices tool is not available yet';
  }
}

/// Builds the default registry containing the placeholder `voices()` tool and
/// the `files()` stub.
ToolRegistry buildDefaultToolRegistry() =>
    ToolRegistry(tools: [VoicesTool(), FilesTool()]);
