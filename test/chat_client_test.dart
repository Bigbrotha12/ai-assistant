import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/features/chat/message_model.dart';

/// Wraps [payload] in a single SSE `data:` frame.
String frame(String payload) => 'data: $payload\n\n';

/// Builds an OpenAI-style streaming chunk payload as a JSON string.
String chunk({
  String? content,
  List<Map<String, Object?>>? toolCalls,
  String? finishReason,
}) {
  final delta = <String, Object?>{};
  if (content != null) delta['content'] = content;
  if (toolCalls != null) delta['tool_calls'] = toolCalls;
  return jsonEncode({
    'id': 'chatcmpl-1',
    'object': 'chat.completion.chunk',
    'choices': [
      {'delta': delta, 'index': 0, 'finish_reason': finishReason},
    ],
  });
}

/// Builds a single `delta.tool_calls[]` entry as a map.
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

sealed class _AdapterAction {}

class _StreamAction extends _AdapterAction {
  _StreamAction(this.frames);

  /// Complete SSE frames; each becomes one byte chunk.
  final List<String> frames;
}

class _LiveStreamAction extends _AdapterAction {
  _LiveStreamAction(this.controller);

  final StreamController<Uint8List> controller;
}

class _JsonAction extends _AdapterAction {
  _JsonAction(this.body);

  final Map<String, dynamic> body;
}

class _ErrorAction extends _AdapterAction {
  _ErrorAction(this.statusCode, {this.body = ''});

  final int statusCode;
  final String body;
}

class _NetworkErrorAction extends _AdapterAction {
  _NetworkErrorAction(this.type);

  final DioExceptionType type;
}

/// A scripted [HttpClientAdapter]: each fetch pops the next action
/// (repeating the last one) and records the request options.
class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter(this.actions);

  final List<_AdapterAction> actions;
  final List<RequestOptions> requests = [];

  int _calls = 0;
  int get callCount => _calls;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final index = _calls < actions.length ? _calls : actions.length - 1;
    _calls++;
    requests.add(options);

    final action = actions[index];
    switch (action) {
      case _StreamAction a:
        return ResponseBody(
          Stream.fromIterable(
            a.frames.map((f) => Uint8List.fromList(utf8.encode(f))),
          ),
          200,
          headers: const {'content-type': ['text/event-stream']},
        );
      case _LiveStreamAction a:
        return ResponseBody(
          a.controller.stream,
          200,
          headers: const {'content-type': ['text/event-stream']},
        );
      case _JsonAction a:
        return ResponseBody.fromString(
          jsonEncode(a.body),
          200,
          headers: const {'content-type': ['application/json']},
        );
      case _ErrorAction a:
        return ResponseBody.fromString(a.body, a.statusCode);
      case _NetworkErrorAction a:
        throw DioException(
          type: a.type,
          requestOptions: options,
          error: Exception('simulated ${a.type.name}'),
        );
    }
  }

  @override
  void close({bool force = false}) {}
}

ChatApiClient _client(_ScriptedAdapter adapter, {String? apiKey}) =>
    ChatApiClient(
      baseUrl: 'http://192.168.1.5:9091',
      dio: Dio()..httpClientAdapter = adapter,
      apiKey: apiKey,
    );

void main() {
  const messages = [ApiMessage(role: 'user', content: 'Hi there')];

  group('streamCompletions', () {
    test('accumulates content deltas and fires onContent per delta', () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(content: 'Hello')),
          frame(chunk(content: ', ')),
          frame(chunk(content: 'world!')),
          frame(chunk(finishReason: 'stop')),
        ]),
      ]);
      final client = _client(adapter);

      final contents = <String>[];
      final result = await client.streamCompletions(
        messages: messages,
        onContent: contents.add,
      );

      expect(contents, ['Hello', ', ', 'world!']);
      expect(result.content, 'Hello, world!');
      expect(result.finishReason, 'stop');
      expect(result.toolCalls, isEmpty);

      final req = adapter.requests.single;
      final body = req.data as Map<String, dynamic>;
      expect(req.responseType, ResponseType.stream);
      expect(body['model'], 'Qwen3-8B-Q4_K_M.gguf');
      expect(body['stream'], isTrue);
      expect(body['max_tokens'], 4096);
      expect(body['chat_template_kwargs'], {'enable_thinking': false});
      expect(body.containsKey('tools'), isFalse);
      expect(body.containsKey('temperature'), isFalse);
      expect(body['messages'], [
        {'role': 'user', 'content': 'Hi there'},
      ]);
    });

    test('prepends the system prompt and shapes the request body', () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(content: 'ok')),
          frame(chunk(finishReason: 'stop')),
        ]),
      ]);
      final client = _client(adapter);

      await client.streamCompletions(
        messages: messages,
        systemPrompt: 'Be terse.',
        enableThinking: true,
        temperature: 0,
        tools: const [
          {'type': 'function', 'name': 'lookup'},
        ],
      );

      final body = adapter.requests.single.data as Map<String, dynamic>;
      expect(body['messages'], [
        {'role': 'system', 'content': 'Be terse.'},
        {'role': 'user', 'content': 'Hi there'},
      ]);
      expect(body.containsKey('chat_template_kwargs'), isFalse);
      expect(body['temperature'], 0);
      expect(body['tools'], isNotEmpty);
    });

    test('accumulates tool-call deltas across chunks into toolCalls', () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(toolCalls: [
            toolCall(
                index: 0, id: 'call_1', name: 'get_weather', arguments: '{"city":'),
          ])),
          frame(chunk(toolCalls: [
            toolCall(index: 0, arguments: '"Paris","unit":"c"}'),
          ])),
          frame(chunk(toolCalls: [
            toolCall(index: 1, id: 'call_2', name: 'get_time', arguments: '{"tz":'),
          ])),
          frame(chunk(toolCalls: [
            toolCall(index: 1, arguments: '"UTC"}'),
          ])),
          frame(chunk(finishReason: 'tool_calls')),
        ]),
      ]);
      final client = _client(adapter);

      final deltas = <(int, String, String)>[];
      final result = await client.streamCompletions(
        messages: messages,
        onToolCallDelta: (index, name, fragment) =>
            deltas.add((index, name, fragment)),
      );

      expect(result.finishReason, 'tool_calls');
      expect(result.toolCalls, hasLength(2));
      expect(result.toolCalls[0].id, 'call_1');
      expect(result.toolCalls[0].name, 'get_weather');
      expect(result.toolCalls[0].args, {'city': 'Paris', 'unit': 'c'});
      expect(result.toolCalls[1].id, 'call_2');
      expect(result.toolCalls[1].name, 'get_time');
      expect(result.toolCalls[1].args, {'tz': 'UTC'});
      expect(deltas, hasLength(4));
      expect(deltas.first, (0, 'get_weather', '{"city":'));
    });

    test('falls back to non-streaming completions once when args fail to decode',
        () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(toolCalls: [
            toolCall(
                index: 0, id: 'call_1', name: 'get_weather', arguments: '{"city":'),
          ])),
          frame(chunk(toolCalls: [
            toolCall(index: 0, arguments: '"Paris"'),
          ])),
          frame(chunk(finishReason: 'tool_calls')),
        ]),
        _JsonAction({
          'id': 'chatcmpl-2',
          'object': 'chat.completion',
          'choices': [
            {
              'index': 0,
              'finish_reason': 'tool_calls',
              'message': {
                'role': 'assistant',
                'content': null,
                'tool_calls': [
                  {
                    'id': 'call_1',
                    'type': 'function',
                    'function': {
                      'name': 'get_weather',
                      'arguments': '{"city": "Paris"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      ]);
      final client = _client(adapter);

      final result = await client.streamCompletions(messages: messages);

      expect(adapter.callCount, 2);
      expect(
        (adapter.requests[0].data as Map<String, dynamic>)['stream'],
        isTrue,
      );
      expect(
        (adapter.requests[1].data as Map<String, dynamic>)['stream'],
        isFalse,
      );

      expect(result.finishReason, 'tool_calls');
      expect(result.toolCalls, hasLength(1));
      expect(result.toolCalls.single.name, 'get_weather');
      expect(result.toolCalls.single.args, {'city': 'Paris'});
    });

    test('surfaces ChatStreamError on an error envelope in the stream', () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(jsonEncode({'error': 'upstream blew up'})),
        ]),
      ]);
      final client = _client(adapter);

      await expectLater(
        client.streamCompletions(messages: messages),
        throwsA(
          isA<ChatStreamError>()
              .having((e) => e.message, 'message', 'upstream blew up'),
        ),
      );
      expect(adapter.callCount, 1);
    });

    test('maps a 502 status to ChatServerError with statusCode', () async {
      final adapter = _ScriptedAdapter([
        _ErrorAction(502, body: 'Bad Gateway'),
      ]);
      final client = _client(adapter);

      await expectLater(
        client.streamCompletions(messages: messages),
        throwsA(
          isA<ChatServerError>()
              .having((e) => e.statusCode, 'statusCode', 502)
              .having((e) => e.message, 'message', contains('502')),
        ),
      );
      expect(adapter.callCount, 1);
    });

    test('retries once after a connection timeout with zero bytes received',
        () async {
      final adapter = _ScriptedAdapter([
        _NetworkErrorAction(DioExceptionType.connectionTimeout),
        _StreamAction([
          frame(chunk(content: 'recovered')),
          frame(chunk(finishReason: 'stop')),
        ]),
      ]);
      final client = _client(adapter);

      final result = await client.streamCompletions(messages: messages);

      expect(result.content, 'recovered');
      expect(result.finishReason, 'stop');
      expect(adapter.callCount, 2);
    });

    test('maps cancellation to ChatNetworkError', () async {
      final controller = StreamController<Uint8List>();
      addTearDown(controller.close);
      final adapter = _ScriptedAdapter([
        _LiveStreamAction(controller),
      ]);
      final client = _client(adapter);
      final token = CancelToken();
      final sawContent = Completer<void>();

      final future = client.streamCompletions(
        messages: messages,
        cancelToken: token,
        onContent: (_) {
          if (!sawContent.isCompleted) sawContent.complete();
        },
      );

      controller.add(Uint8List.fromList(utf8.encode(frame(chunk(content: 'hi')))));
      await sawContent.future;
      token.cancel();

      await expectLater(
        future,
        throwsA(
          isA<ChatNetworkError>()
              .having((e) => e.message, 'message', 'cancelled'),
        ),
      );
    });
  });

  group('completions', () {
    test('non-streaming happy path', () async {
      final adapter = _ScriptedAdapter([
        _JsonAction({
          'id': 'chatcmpl-3',
          'object': 'chat.completion',
          'choices': [
            {
              'index': 0,
              'finish_reason': 'stop',
              'message': {
                'role': 'assistant',
                'content': 'Plain answer',
              },
            },
          ],
        }),
      ]);
      final client = _client(adapter);

      final result = await client.completions(messages: messages);

      expect(result.content, 'Plain answer');
      expect(result.finishReason, 'stop');
      expect(result.toolCalls, isEmpty);
      expect(
        (adapter.requests.single.data as Map<String, dynamic>)['stream'],
        isFalse,
      );
    });
  });

  group('bearer auth header', () {
    test('streamCompletions sends Authorization: Bearer <key> when apiKey set',
        () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(content: 'Hello')),
          frame(chunk(finishReason: 'stop')),
        ]),
      ]);
      final client = _client(adapter, apiKey: 'sk-test123');

      await client.streamCompletions(messages: messages);

      final req = adapter.requests.single;
      expect(req.headers['Authorization'], 'Bearer sk-test123');
      expect(req.headers['accept'], 'text/event-stream');
    });

    test('completions sends Authorization: Bearer <key> when apiKey set',
        () async {
      final adapter = _ScriptedAdapter([
        _JsonAction({
          'id': 'chatcmpl-4',
          'object': 'chat.completion',
          'choices': [
            {
              'index': 0,
              'finish_reason': 'stop',
              'message': {
                'role': 'assistant',
                'content': 'Plain answer',
              },
            },
          ],
        }),
      ]);
      final client = _client(adapter, apiKey: 'sk-test123');

      await client.completions(messages: messages);

      expect(
        adapter.requests.single.headers['Authorization'],
        'Bearer sk-test123',
      );
    });

    test('no Authorization header when apiKey is null', () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(content: 'Hello')),
          frame(chunk(finishReason: 'stop')),
        ]),
      ]);
      final client = _client(adapter); // apiKey stays null

      await client.streamCompletions(messages: messages);

      final req = adapter.requests.single;
      expect(req.headers.containsKey('Authorization'), isFalse);
      expect(req.headers['accept'], 'text/event-stream');
    });

    test('streamed-tool-call fallback also carries the bearer header',
        () async {
      final adapter = _ScriptedAdapter([
        _StreamAction([
          frame(chunk(toolCalls: [
            toolCall(index: 0, id: 'call_1', name: 'get_weather', arguments: '{"city":'),
          ])),
          frame(chunk(toolCalls: [
            toolCall(index: 0, arguments: '"Paris"'),
          ])),
          frame(chunk(finishReason: 'tool_calls')),
        ]),
        _JsonAction({
          'id': 'chatcmpl-5',
          'object': 'chat.completion',
          'choices': [
            {
              'index': 0,
              'finish_reason': 'tool_calls',
              'message': {
                'role': 'assistant',
                'content': null,
                'tool_calls': [
                  {
                    'id': 'call_1',
                    'type': 'function',
                    'function': {
                      'name': 'get_weather',
                      'arguments': '{"city": "Paris"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      ]);
      final client = _client(adapter, apiKey: 'sk-test123');

      final result = await client.streamCompletions(messages: messages);

      expect(result.toolCalls, hasLength(1));
      expect(adapter.callCount, 2);
      for (final req in adapter.requests) {
        expect(req.headers['Authorization'], 'Bearer sk-test123');
      }
    });
  });
}
