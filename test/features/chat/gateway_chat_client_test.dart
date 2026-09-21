import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/gateway_chat_client.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';

import 'sse_fixtures.dart';

class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter(this.action);

  final _AdapterAction action;
  int callCount = 0;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    callCount++;
    requests.add(options);

    return switch (action) {
      _StreamAction(:final frames) => ResponseBody(
          Stream.fromIterable(
            frames.map((f) => Uint8List.fromList(utf8.encode(f))),
          ),
          200,
          headers: const {'content-type': ['text/event-stream']},
        ),
      _JsonAction(:final body) => ResponseBody.fromString(
          jsonEncode(body),
          200,
          headers: const {'content-type': ['application/json']},
        ),
      _ErrorAction(:final status, :final body) => ResponseBody.fromString(
          jsonEncode(body),
          status,
          headers: const {'content-type': ['application/json']},
        ),
    };
  }

  @override
  void close({bool force = false}) {}
}

sealed class _AdapterAction {}

class _StreamAction extends _AdapterAction {
  _StreamAction(this.frames);
  final List<String> frames;
}

class _JsonAction extends _AdapterAction {
  _JsonAction(this.body);
  final Map<String, dynamic> body;
}

class _ErrorAction extends _AdapterAction {
  _ErrorAction(this.status, this.body);
  final int status;
  final Map<String, dynamic> body;
}

GatewayChatClient _client(
  _ScriptedAdapter adapter, {
  GatewayCredentials? credentials,
}) =>
    GatewayChatClient(
      baseUrl: 'http://localhost:17600/v1',
      dio: Dio()..httpClientAdapter = adapter,
      credentialResolver: () async => credentials,
    );

void main() {
  const messages = [ApiMessage(role: 'user', content: 'Hi there')];

  group('GatewayChatClient', () {
    group('streamCompletions', () {
      test('happy path: accumulates SSE content deltas', () async {
        final adapter = _ScriptedAdapter(_StreamAction([
          frame(chunk(content: 'Hello')),
          frame(chunk(content: ', ')),
          frame(chunk(content: 'world!')),
          frame(chunk(finishReason: 'stop')),
        ]));
        final client = _client(
          adapter,
          credentials: const GatewayCredentials(
            gatewayKey: 'test-key',
            modelPluginId: 'model_1',
            credentials: {'model_1': {'apiKey': 'sk-test'}},
          ),
        );

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
        expect(body['model'], 'model_1');
        expect(body['stream'], isTrue);
        expect(body['messages'], [
          {'role': 'user', 'content': 'Hi there'},
        ]);
        expect(body['credentials'], {
          'model_1': {'apiKey': 'sk-test'},
        });
        expect(req.headers['Authorization'] ?? req.headers['authorization'],
    'Bearer test-key');
      });

      test('prepends system prompt when provided', () async {
        final adapter = _ScriptedAdapter(_StreamAction([
          frame(chunk(content: 'ok')),
          frame(chunk(finishReason: 'stop')),
        ]));
        final client = _client(
          adapter,
          credentials: const GatewayCredentials(
            gatewayKey: 'test-key',
            modelPluginId: 'model_1',
            credentials: {'model_1': {'apiKey': 'sk-test'}},
          ),
        );

        await client.streamCompletions(
          messages: messages,
          systemPrompt: 'Be concise.',
        );

        final body = adapter.requests.single.data as Map<String, dynamic>;
        expect(body['messages'], [
          {'role': 'system', 'content': 'Be concise.'},
          {'role': 'user', 'content': 'Hi there'},
        ]);
      });

      test('throws ChatNetworkError when resolver returns null', () async {
        final adapter = _ScriptedAdapter(_StreamAction([
          frame(chunk(content: 'never')),
          frame(chunk(finishReason: 'stop')),
        ]));
        final client = _client(adapter, credentials: null);

        await expectLater(
          () => client.streamCompletions(messages: messages),
          throwsA(isA<ChatNetworkError>().having(
            (e) => e.message,
            'message',
            'Plugin configuration is unavailable. Sign in again from Settings to continue.',
          )),
        );

        expect(adapter.callCount, 0);
      });

      test('surfaces the gateway error message from a non-2xx body', () async {
        final adapter = _ScriptedAdapter(_ErrorAction(400, {
          'error': 'invalid_request',
          'message': 'template_not_found: default',
        }));
        final client = _client(
          adapter,
          credentials: const GatewayCredentials(
            gatewayKey: 'test-key',
            modelPluginId: 'openrouter',
            credentials: {
              'openrouter': {'apiKey': 'sk-test'},
            },
          ),
        );

        await expectLater(
          () => client.streamCompletions(messages: messages),
          throwsA(
            isA<ChatServerError>()
                .having((e) => e.statusCode, 'statusCode', 400)
                .having(
                  (e) => e.message,
                  'message',
                  'template_not_found: default',
                ),
          ),
        );
      });
    });

    group('completions', () {
      test('happy path: parses JSON response', () async {
        final adapter = _ScriptedAdapter(_JsonAction({
          'choices': [
            {
              'message': {'content': 'Hello world!'},
              'finish_reason': 'stop',
            },
          ],
        }));
        final client = _client(
          adapter,
          credentials: const GatewayCredentials(
            gatewayKey: 'test-key',
            modelPluginId: 'model_1',
            credentials: {'model_1': {'apiKey': 'sk-test'}},
          ),
        );

        final result = await client.completions(messages: messages);

        expect(result.content, 'Hello world!');
        expect(result.finishReason, 'stop');
        expect(result.toolCalls, isEmpty);

        final req = adapter.requests.single;
        final body = req.data as Map<String, dynamic>;
        expect(body.containsKey('stream'), isFalse);
        expect(body['model'], 'model_1');
        expect(body['credentials'], {
          'model_1': {'apiKey': 'sk-test'},
        });
      });

      test('throws ChatNetworkError when resolver returns null', () async {
        final adapter = _ScriptedAdapter(_JsonAction({
          'choices': [{'message': {'content': ''}, 'finish_reason': 'stop'}],
        }));
        final client = _client(adapter, credentials: null);

        await expectLater(
          () => client.completions(messages: messages),
          throwsA(isA<ChatNetworkError>().having(
            (e) => e.message,
            'message',
            'Plugin configuration is unavailable. Sign in again from Settings to continue.',
          )),
        );

        expect(adapter.callCount, 0);
      });

      test('surfaces the gateway error message from a non-2xx body', () async {
        final adapter = _ScriptedAdapter(_ErrorAction(400, {
          'error': 'invalid_request',
          'message': 'template_not_found: default',
        }));
        final client = _client(
          adapter,
          credentials: const GatewayCredentials(
            gatewayKey: 'test-key',
            modelPluginId: 'openrouter',
            credentials: {
              'openrouter': {'apiKey': 'sk-test'},
            },
          ),
        );

        await expectLater(
          () => client.completions(messages: messages),
          throwsA(
            isA<ChatServerError>()
                .having((e) => e.statusCode, 'statusCode', 400)
                .having(
                  (e) => e.message,
                  'message',
                  'template_not_found: default',
                ),
          ),
        );
      });
    });
  });
}