import 'dart:async';
import 'dart:convert';

/// The kind of a parsed [SseEvent].
enum SseEventType { content, toolCall, done, error }

/// A single parsed SSE event from an OpenAI-compatible chat stream.
class SseEvent {
  final SseEventType type;
  final String? content; // content delta (type == content), thinking already stripped
  final ToolCallDelta? toolCall; // tool-call delta (type == toolCall)
  final String? finishReason; // 'stop' | 'tool_calls' | null
  final String? error; // set when server sent {"error": "..."} envelope

  const SseEvent.content(this.content)
      : type = SseEventType.content,
        toolCall = null,
        finishReason = null,
        error = null;

  const SseEvent.toolCall(this.toolCall)
      : type = SseEventType.toolCall,
        content = null,
        finishReason = null,
        error = null;

  const SseEvent.done(this.finishReason)
      : type = SseEventType.done,
        content = null,
        toolCall = null,
        error = null;

  const SseEvent.error(this.error)
      : type = SseEventType.error,
        content = null,
        toolCall = null,
        finishReason = null;
}

/// An incremental tool-call delta for one call index.
class ToolCallDelta {
  const ToolCallDelta({
    required this.index,
    this.id, // set on first fragment
    this.name, // set on first fragment
    required this.argsFragment, // incremental argument text (accumulate raw)
  });

  final int index;
  final String? id;
  final String? name;
  final String argsFragment;
}

/// Parses an SSE byte stream into events.
Stream<SseEvent> parseSse(Stream<List<int>> byteStream) async* {
  const decoder = Utf8Decoder(allowMalformed: true);
  final lines = decoder.bind(byteStream).transform(const LineSplitter());

  final seenIndexes = <int>{};
  final startedArgs = <int>{};
  String? finishReason;

  await for (final line in lines) {
    if (line.isEmpty) continue;
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;

    final payload = line.substring(5).trim();
    if (payload.isEmpty) continue;

    if (payload == '[DONE]') {
      yield SseEvent.done(finishReason);
      return;
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(payload);
    } on FormatException {
      continue;
    }

    if (decoded is! Map<String, dynamic>) continue;

    final choices = decoded['choices'];
    if (choices is! List || choices.isEmpty) {
      final error = decoded['error'];
      if (error != null) {
        yield SseEvent.error(_errorMessage(error));
        return;
      }
      continue;
    }

    final choice = choices.first;
    if (choice is! Map<String, dynamic>) continue;

    final delta = choice['delta'];
    if (delta is Map<String, dynamic>) {
      final content = delta['content'];
      if (content is String && content.isNotEmpty) {
        final stripped = _stripThinking(content);
        if (stripped.isNotEmpty) {
          yield SseEvent.content(stripped);
        }
      }

      final toolCalls = delta['tool_calls'];
      if (toolCalls is List) {
        for (final toolCall in toolCalls) {
          if (toolCall is! Map<String, dynamic>) continue;
          final index = toolCall['index'];
          final callIndex = index is int ? index : 0;
          final isFirst = seenIndexes.add(callIndex);

          String? name;
          String? rawFragment;
          final function = toolCall['function'];
          if (function is Map<String, dynamic>) {
            final fname = function['name'];
            if (fname is String) name = fname;
            final fargs = function['arguments'];
            if (fargs is String) rawFragment = fargs;
          }

          final id = toolCall['id'];
          final fragment = rawFragment ?? '';
          // llama.cpp fragmentation workaround: the first argument fragment
          // may arrive without its leading `{`. Re-prefix it so concatenated
          // fragments form valid JSON. The decision only ever needs to know
          // whether a non-empty fragment was already emitted for this index:
          // once one has been, the accumulated args begin with `{`, so no
          // later fragment is re-prefixed.
          final needsBracePrefix = !startedArgs.contains(callIndex) &&
              fragment.isNotEmpty &&
              !fragment.startsWith('{');
          final emittedFragment =
              needsBracePrefix ? '{$fragment' : fragment;
          if (fragment.isNotEmpty) startedArgs.add(callIndex);

          final emittedId = isFirst && id is String ? id : null;
          final emittedName = isFirst ? name : null;
          if (emittedId != null ||
              emittedName != null ||
              emittedFragment.isNotEmpty) {
            yield SseEvent.toolCall(ToolCallDelta(
              index: callIndex,
              id: emittedId,
              name: emittedName,
              argsFragment: emittedFragment,
            ));
          }
        }
      }
    }

    final rawFinishReason = choice['finish_reason'];
    if (rawFinishReason is String &&
        rawFinishReason.isNotEmpty &&
        finishReason == null) {
      finishReason = rawFinishReason;
    }
  }

  yield SseEvent.done(finishReason);
}

final _thinkingBlock = RegExp(r'<thinking>[\s\S]*?</thinking>');
final _thinkingTag = RegExp(r'</?thinking>');

String _stripThinking(String content) {
  var result = content
      .replaceAll(_thinkingBlock, '')
      .replaceAll(_thinkingTag, '');
  return stripStructuredTokens(result);
}

/// Strips structured-output control tokens emitted by the inference API.
///
/// The model frames tool / citation references with Private Use Area (PUA)
/// sentinels (`\uE200`–`\uE202` …), e.g. `\ue200cite\ue202turn0file0\ue201` or
/// a bare tool reference `\ue202turn0search0`. These are machine markers that
/// must never surface in a rendered bubble, and they can be split across SSE
/// deltas, so callers strip on both per-delta content and the accumulated
/// buffer.
String stripStructuredTokens(String content) {
  if (!content.contains(RegExp(r'[\uE000-\uF8FF]'))) return content;
  // A PUA sentinel plus its reference payload: either a `turn<N><tool><N>`
  // tool/citation reference (e.g. `turn0search0`, `turn0file0`) or a short
  // lowercase block keyword (`cite`). Bounded so a following real word is
  // never clipped (non-greedy lowercase-only payload).
  return content
      .replaceAll(RegExp(r'[\uE000-\uF8FF](?:turn\d+[a-z]+\d*|[a-z]+)?'), '');
}

String _errorMessage(Object? error) {
  return switch (error) {
    final String s => s,
    final Map m => m['message'] is String ? m['message'] as String : '$error',
    _ => '$error',
  };
}
