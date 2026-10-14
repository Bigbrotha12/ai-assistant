import 'dart:convert';

/// Shared SSE wire-format fixtures used by `sse_test.dart` and
/// `chat_client_test.dart`.

/// Encodes [text] as a single byte chunk.
Stream<List<int>> sseBytes(String text) =>
    Stream.fromIterable([utf8.encode(text)]);

/// Splits [text] at the given byte offsets into separate chunks.
Stream<List<int>> sseChunked(String text, List<int> splitPoints) {
  final bytes = utf8.encode(text);
  final chunks = <List<int>>[];
  var start = 0;
  for (final p in splitPoints) {
    chunks.add(bytes.sublist(start, p));
    start = p;
  }
  if (start < bytes.length) chunks.add(bytes.sublist(start));
  return Stream.fromIterable(chunks);
}

/// Wraps [payload] in a single SSE `data:` frame.
String frame(String payload) => 'data: $payload\n\n';

/// Builds an OpenAI-style chunk payload as a JSON string.
///
/// Only non-null optional fields are included in the delta map.
String chunk({
  String? content,
  String? reasoning,
  List<Map<String, Object?>>? toolCalls,
  String? finishReason,
}) {
  final delta = <String, Object?>{};
  if (content != null) delta['content'] = content;
  if (reasoning != null) delta['reasoning_content'] = reasoning;
  if (toolCalls != null) delta['tool_calls'] = toolCalls;
  return jsonEncode({
    'id': 'chatcmpl-1',
    'object': 'chat.completion.chunk',
    'choices': [
      {'delta': delta, 'index': 0, 'finish_reason': finishReason},
    ],
  });
}

/// Builds a single `delta.tool_calls[]` entry as a map with only its non-null
/// optional fields included.
Map<String, Object?> toolCall({
  int index = 0,
  String? id,
  String? name,
  String? arguments,
}) {
  final function = <String, Object?>{};
  if (name != null) function['name'] = name;
  if (arguments != null) function['arguments'] = arguments;
  return {
    'index': index,
    'type': 'function',
    'id': ?id,
    'function': function,
  };
}