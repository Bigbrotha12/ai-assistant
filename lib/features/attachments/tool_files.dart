import '../chat/tool_executor.dart';

/// Stub `files()` tool registered for Phase 4+ (plan §3.13).
///
/// The model may call this tool (its training data knows `files()`), but the
/// actual upload/list/download flow lives in the chat attachment picker. We
/// register it so the API `tools` array stays consistent and the model never
/// hits an "unknown tool" error; executing it returns a neutral message that
/// steers toward the correct flow without revealing the project roadmap.
class FilesTool implements Tool {
  @override
  String get name => 'files';

  @override
  Map<String, Object?> get inputSchema => const {
        'type': 'object',
        'properties': {
          'action': {
            'type': 'string',
            'enum': ['list', 'upload', 'download'],
          },
          'fileId': {'type': 'string'},
        },
        'required': ['action'],
      };

  @override
  Future<String> execute(Map<String, dynamic> args) async {
    return 'File operations are not available on this device. '
        'Upload files from the chat attachment picker.';
  }
}
