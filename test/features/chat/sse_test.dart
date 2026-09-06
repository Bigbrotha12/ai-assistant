import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/sse.dart';

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

Future<List<SseEvent>> collect(Stream<SseEvent> events) => events.toList();

/// Builds an OpenAI-style chunk payload as a JSON string.
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

/// Builds a single `delta.tool_calls[]` entry.
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

void expectDone(SseEvent e, String? finishReason) {
  expect(e.type, SseEventType.done);
  expect(e.finishReason, finishReason);
}

/// Locates [needle] (a byte sequence) inside [haystack].
int indexOfBytes(List<int> haystack, List<int> needle) {
  for (var i = 0; i <= haystack.length - needle.length; i++) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

void main() {
  group('content streaming', () {
    test('multiple content deltas concatenate into the full message', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'Hello')}\n\n'
        'data: ${chunk(content: ', wor')}\n\n'
        'data: ${chunk(content: 'ld!')}\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.content,
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'Hello, world!',
      );
      expectDone(events.last, null);
    });

    test('reasoning_content is ignored while content still streams', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'Hello', reasoning: 'hidden reasoning')}\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expect(events.first.content, 'Hello');
    });

    test('<thinking> tags are stripped from content', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: '<thinking>Let me think...</thinking>Hello')}\n\n'
        'data: ${chunk(content: ' world')}\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'Hello world',
      );
    });

    test('a content delta that is entirely <thinking> emits nothing', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: '<thinking>secret</thinking>')}\n\n'
        'data: ${chunk(content: 'answer')}\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expect(events.first.content, 'answer');
    });
  });

  group('termination', () {
    test('[DONE] produces a done event and stops', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'hi')}\n\n'
        'data: [DONE]\n\n'
        'data: ${chunk(content: 'ignored')}\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expectDone(events.last, null);
    });

    test('clean EOF without [DONE] produces a done event', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'hi')}\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expectDone(events.last, null);
    });

    test('empty stream produces a single done event', () async {
      final events = await collect(parseSse(const Stream.empty()));

      expect(events, hasLength(1));
      expectDone(events.single, null);
    });

    test('finish_reason stop produces a done event', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'bye', finishReason: 'stop')}\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expectDone(events.last, 'stop');
    });
  });

  group('tool calls', () {
    test('accumulates argument fragments across deltas', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices', arguments: '{"voice"')])}\n\n'
        'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
        'data: ${chunk(finishReason: 'tool_calls')}\n\n',
      )));

      expect(events, hasLength(3));

      final first = events[0];
      expect(first.type, SseEventType.toolCall);
      expect(first.toolCall!.index, 0);
      expect(first.toolCall!.id, 'call_1');
      expect(first.toolCall!.name, 'voices');
      expect(first.toolCall!.argsFragment, '{"voice"');

      final second = events[1];
      expect(second.type, SseEventType.toolCall);
      expect(second.toolCall!.id, isNull); // id/name only on the first fragment
      expect(second.toolCall!.name, isNull);
      expect(second.toolCall!.argsFragment, ':"amy"}');

      final args = events
          .where((e) => e.type == SseEventType.toolCall)
          .map((e) => e.toolCall!.argsFragment)
          .join();
      expect(args, '{"voice":"amy"}');

      expectDone(events.last, 'tool_calls');
    });

    test('re-prefixes a lost leading brace', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices', arguments: '"voice"')])}\n\n'
        'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
        'data: ${chunk(finishReason: 'tool_calls')}\n\n',
      )));

      final args = events
          .where((e) => e.type == SseEventType.toolCall)
          .map((e) => e.toolCall!.argsFragment)
          .join();
      expect(args, '{"voice":"amy"}');
      expectDone(events.last, 'tool_calls');
    });

    test('accumulates multiple tool calls by index independently', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(toolCalls: [toolCall(index: 0, id: 'call_a', name: 'voices', arguments: '{"v"')])}\n\n'
        'data: ${chunk(toolCalls: [toolCall(index: 1, id: 'call_b', name: 'other', arguments: '{"x"')])}\n\n'
        'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
        'data: ${chunk(toolCalls: [toolCall(index: 1, arguments: ':1}')])}\n\n'
        'data: ${chunk(finishReason: 'tool_calls')}\n\n',
      )));

      final byIndex = <int, String>{};
      for (final e in events) {
        if (e.type == SseEventType.toolCall) {
          byIndex[e.toolCall!.index] =
              (byIndex[e.toolCall!.index] ?? '') + e.toolCall!.argsFragment;
        }
      }
      expect(byIndex[0], '{"v":"amy"}');
      expect(byIndex[1], '{"x":1}');
    });

    test('a defining delta with id/name but no arguments still emits', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices')])}\n\n'
        'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: '{"voice":"amy"}')])}\n\n'
        'data: ${chunk(finishReason: 'tool_calls')}\n\n',
      )));

      final first = events[0];
      expect(first.type, SseEventType.toolCall);
      expect(first.toolCall!.id, 'call_1');
      expect(first.toolCall!.name, 'voices');
      expect(first.toolCall!.argsFragment, '');
      expect(events[1].toolCall!.argsFragment, '{"voice":"amy"}');
    });
  });

  group('robustness', () {
    test('comment and event lines are ignored', () async {
      final events = await collect(parseSse(sseBytes(
        ': ping\n'
        ': keep-alive\n'
        'event: message\n'
        'data: ${chunk(content: 'hi')}\n\n'
        ': ping\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
    });

    test('error envelope produces an error event and stops', () async {
      final events = await collect(parseSse(sseBytes(
        'data: {"error": "upstream blew up"}\n\n'
        'data: ${chunk(content: 'ignored')}\n\n',
      )));

      expect(events, hasLength(1));
      expect(events.single.type, SseEventType.error);
      expect(events.single.error, 'upstream blew up');
    });

    test('error envelope with a message map produces an error event', () async {
      final events = await collect(parseSse(sseBytes(
        'data: {"error": {"message": "boom", "type": "server_error"}}\n\n',
      )));

      expect(events.single.type, SseEventType.error);
      expect(events.single.error, 'boom');
    });

    test('malformed JSON lines are skipped without crashing', () async {
      final events = await collect(parseSse(sseBytes(
        'data: {not valid json\n\n'
        'data: ${chunk(content: 'ok')}\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expect(events.first.content, 'ok');
    });

    test('non-object data payloads are skipped', () async {
      final events = await collect(parseSse(sseBytes(
        'data: 42\n\n'
        'data: null\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events, hasLength(1));
      expectDone(events.single, null);
    });

    test('tolerates CRLF line endings', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'hi')}\r\n\r\n'
        'data: [DONE]\r\n\r\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expect(events.first.content, 'hi');
    });

    test('empty lines and empty payloads are ignored', () async {
      final events = await collect(parseSse(sseBytes(
        '\n\n'
        'data: \n\n'
        'data: ${chunk(content: '')}\n\n'
        'data: ${chunk()}\n\n'
        'data: [DONE]\n\n',
      )));

      expect(events.map((e) => e.type), [SseEventType.done]);
    });

    test('a partial line without a trailing newline is still parsed', () async {
      final events = await collect(parseSse(sseBytes(
        'data: ${chunk(content: 'hi')}',
      )));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expect(events.first.content, 'hi');
    });
  });

  group('utf-8 decoding', () {
    test('a multi-byte character split across chunks decodes correctly', () async {
      final text = 'data: ${chunk(content: '中')}\n\ndata: [DONE]\n\n';
      final bytes = utf8.encode(text);
      final charBytes = utf8.encode('中');
      final at = indexOfBytes(bytes, charBytes);
      expect(at, greaterThanOrEqualTo(0));

      final events = await collect(parseSse(sseChunked(text, [at + 1])));

      expect(events.map((e) => e.type), [SseEventType.content, SseEventType.done]);
      expect(events.first.content, '中');
    });

    test('malformed UTF-8 bytes are replaced and do not crash the parser',
        () async {
      final events = await collect(parseSse(Stream.fromIterable([
        utf8.encode('data: ${chunk(content: 'ok')}\n\n'),
        [0xFF, 0xFE, 0x0A], // invalid bytes + newline
        utf8.encode('data: ${chunk(content: 'after')}\n\ndata: [DONE]\n\n'),
      ])));

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(events[0].content, 'ok');
      expect(events[1].content, 'after');
    });
  });
}
