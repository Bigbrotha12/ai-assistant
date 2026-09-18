import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/langchain_request.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/data/plugin_registry_client.dart';
import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dio/dio.dart';

class FakePluginAdapter implements HttpClientAdapter {
  FakePluginAdapter(this.respond);

  final FutureOr<ResponseBody> Function(RequestOptions) respond;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

String frame(Object value) => 'data: ${jsonEncode(value)}\n\n';

ResponseBody sseResponse(String text) => ResponseBody(
  Stream.fromIterable(
    utf8.encode(text).map((byte) => Uint8List.fromList([byte])),
  ),
  200,
  headers: {
    'content-type': ['text/event-stream'],
  },
);

LangChainRequest request() => LangChainRequest(
  gatewayKey: 'gateway-secret',
  modelPluginId: 'openrouter',
  credentials: {
    'openrouter': {'apiKey': 'provider-secret'},
  },
  messages: [const ApiMessage(role: 'user', content: 'Hello')],
);

Map<String, dynamic> modelJson() => {
  'id': 'openrouter',
  'object': 'model',
  'created': 42,
  'owned_by': 'plugin',
  'defaultModel': 'provider/model',
  'tokenLimit': 4096,
  'visionCapable': true,
  'supportsStreaming': true,
  'parameters': {
    'temperature': 0.2,
    'future': [
      1,
      {'enabled': true},
    ],
  },
};

Map<String, dynamic> pluginJson({bool detail = false}) => {
  'id': 'openrouter',
  'type': 'model',
  'name': 'OpenRouter',
  'description': 'Model provider',
  'version': '1.0.0',
  'schemaVersion': 1,
  'installed': true,
  'baseUrls': [
    {
      'id': 'primary',
      'label': 'Primary',
      if (detail) 'url': 'https://provider.test',
    },
  ],
  'credentials': {
    'apiKey': {'label': 'Provider key', 'required': true},
  },
  'inference': {
    'defaultModel': 'provider/model',
    'tokenLimit': 4096,
    'visionCapable': true,
    'supportsStreaming': true,
    if (detail) 'endpoint': 'https://provider.test',
    if (detail) 'parameters': <String, dynamic>{},
  },
  'futureField': true,
};

Matcher errorCode(String code) =>
    throwsA(isA<PluginClientException>().having((e) => e.code, 'code', code));

void main() {
  test('catalog DTOs enforce known shapes and tolerate future additions', () {
    final summary = PluginDto.parseList({
      'plugins': [pluginJson()],
    }).single;
    expect(summary.installed, isTrue);
    expect(summary.credentials!.required, isTrue);
    expect(summary.baseUrls.single.url, isNull);
    expect(summary.inference!.endpoint, isNull);
    expect(summary.isSupported, isTrue);
    final detail = PluginDto.fromDetailJson(pluginJson(detail: true));
    expect(detail.inference!.endpoint, 'https://provider.test');
    final future = PluginDto.fromSummaryJson({
      ...pluginJson(),
      'type': 'future',
      'schemaVersion': 2,
    });
    expect(future.isSupported, isFalse);
    final model = PluginModelDto.parseList({
      'object': 'list',
      'data': [modelJson()],
    }).single;
    expect(model.id, 'openrouter');
    expect(model.defaultModel, 'provider/model');
    expect(
      () => (model.parameters['future'] as List).add(3),
      throwsUnsupportedError,
    );
    expect(PluginDto.parseList({'plugins': []}), isEmpty);
    expect(PluginModelDto.parseList({'object': 'list', 'data': []}), isEmpty);
    for (final malformed in [
      null,
      [],
      {'data': []},
      {
        'plugins': [null],
      },
      {
        'plugins': [
          {...pluginJson(), 'installed': 'true'},
        ],
      },
      {
        'plugins': [
          {...pluginJson(), 'credentials': null},
        ],
      },
      {
        'plugins': [
          {
            ...pluginJson(),
            'inference': {'tokenLimit': -1},
          },
        ],
      },
    ]) {
      expect(
        () => PluginDto.parseList(malformed),
        throwsA(isA<PluginProtocolException>()),
      );
    }
    expect(
      () => PluginModelDto.fromJson({...modelJson(), 'tokenLimit': 0}),
      throwsA(isA<PluginProtocolException>()),
    );
    final tool = PluginDto.fromSummaryJson({
      ...pluginJson(),
      'type': 'tool',
      'tools': [
        {
          'name': 'list',
          'description': 'List tasks',
          'readOnly': true,
          'inputSchema': {
            'type': 'object',
            'properties': {
              'limit': {'type': 'integer', 'minimum': 1},
            },
            'required': ['limit'],
          },
        },
      ],
    });
    expect(tool.tools.single.inputSchema['properties']['limit']['minimum'], 1);
  });

  test(
    'request snapshots credentials and history; IDs remain raw wire IDs',
    () {
      final credentials = {
        'openrouter': {'apiKey': 'original'},
      };
      final calls = [
        {
          'id': 'call',
          'function': {'name': 'list', 'arguments': '{}'},
        },
      ];
      final messages = [
        ApiMessage(role: 'assistant', toolCalls: calls),
        const ApiMessage(role: 'tool', toolCallId: 'call', content: 'done'),
        const ApiMessage(role: 'user', content: 'Next'),
      ];
      final dto = LangChainRequest(
        gatewayKey: 'gateway',
        modelPluginId: 'openrouter',
        credentials: credentials,
        messages: messages,
        conversationPublicId: 'raw-client-uuid',
        turnId: 'turn-uuid',
      );
      credentials['openrouter']!['apiKey'] = 'changed';
      (calls.single['function'] as Map)['name'] = 'changed';
      messages.clear();
      final body = dto.toJson();
      expect(body['credentials']['openrouter']['apiKey'], 'original');
      expect(body['messages'][0]['tool_calls'][0]['function']['name'], 'list');
      expect(body['messages'][1]['tool_call_id'], 'call');
      expect(body['thread_id'], 'raw-client-uuid');
      expect(body['messageId'], 'turn-uuid');
      expect(body['model'], 'openrouter');
      expect(body.containsKey('gatewayKey'), isFalse);
      expect(body.containsKey('tools'), isFalse);
      expect(body.containsKey('background'), isFalse);
      expect(dto.toString(), isNot(contains('original')));
      expect(
        () => dto.credentials['openrouter']!['apiKey'] = 'bad',
        throwsUnsupportedError,
      );
      expect(request().toJson().containsKey('thread_id'), isFalse);
      expect(
        () => LangChainRequest(
          gatewayKey: '',
          modelPluginId: 'openrouter',
          credentials: {},
          messages: messages,
        ),
        errorCode('missing_gateway_key'),
      );
    },
  );

  test(
    'registry reuses shared Dio, GET only, per-call auth and no redirects',
    () async {
      final adapter = FakePluginAdapter(
        (options) => ResponseBody.fromString(
          jsonEncode(
            options.path.endsWith('/models')
                ? {
                    'object': 'list',
                    'data': [modelJson()],
                  }
                : options.path.endsWith('/openrouter')
                ? pluginJson(detail: true)
                : {
                    'plugins': [pluginJson()],
                  },
          ),
          200,
        ),
      );
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final dio = container.read(dioProvider)..httpClientAdapter = adapter;
      final originalHeaders = Map.of(dio.options.headers);
      final client = PluginRegistryClient(
        dio: dio,
        baseUrl: 'https://gateway.test/v1/',
      );
      expect(
        (await client.listPlugins(gatewayKey: 'one')).single.id,
        'openrouter',
      );
      expect(
        (await client.listModels(gatewayKey: 'two')).single.id,
        'openrouter',
      );
      expect(
        (await client.getPlugin('openrouter', gatewayKey: 'three')).installed,
        isTrue,
      );
      expect(adapter.requests.map((r) => r.headers['Authorization']), [
        'Bearer one',
        'Bearer two',
        'Bearer three',
      ]);
      for (final options in adapter.requests) {
        expect(options.method, 'GET');
        expect(options.followRedirects, isFalse);
        expect(options.maxRedirects, 0);
        expect(options.connectTimeout, isNotNull);
        expect(options.receiveTimeout, isNotNull);
        expect(options.data, isNull);
      }
      expect(dio.options.headers, originalHeaders);
      await expectLater(
        client.listPlugins(gatewayKey: ''),
        errorCode('missing_gateway_key'),
      );
      expect(
        () => client.getPlugin('../bad', gatewayKey: 'one'),
        throwsA(isA<PluginProtocolException>()),
      );
      expect(adapter.requests, hasLength(3));
    },
  );

  test(
    'flat/nested HTTP errors expose safe codes and retry-after only',
    () async {
      for (final error in [
        'busy',
        {'code': 'busy', 'message': 'provider-secret'},
        {
          'code': 'provider-secret',
          'type': 'busy',
          'message': 'gateway-secret',
        },
      ]) {
        final adapter = FakePluginAdapter(
          (_) => ResponseBody.fromString(
            jsonEncode({'error': error}),
            429,
            headers: {
              'retry-after': ['12'],
            },
          ),
        );
        final client = PluginRegistryClient(
          dio: Dio()..httpClientAdapter = adapter,
          baseUrl: 'https://gateway.test/v1',
        );
        await expectLater(
          client.listModels(gatewayKey: 'gateway-secret'),
          throwsA(
            isA<PluginClientException>()
                .having((e) => e.code, 'code', 'busy')
                .having((e) => e.statusCode, 'status', 429)
                .having(
                  (e) => e.retryAfter,
                  'retry',
                  const Duration(seconds: 12),
                )
                .having(
                  (e) => e.toString(),
                  'safe text',
                  isNot(contains('secret')),
                ),
          ),
        );
        expect(adapter.requests, hasLength(1));
      }
      for (final status in [302, 401, 502]) {
        final adapter = FakePluginAdapter(
          (_) => ResponseBody.fromString(
            'provider-secret',
            status,
            headers: {
              'location': ['https://other.test'],
              'retry-after': ['invalid'],
            },
          ),
        );
        final client = LangChainClient(
          dio: Dio()..httpClientAdapter = adapter,
          baseUrl: 'https://gateway.test/v1',
        );
        await expectLater(
          client.streamTurn(request()),
          errorCode('server_error'),
        );
        expect(adapter.requests, hasLength(1));
      }
    },
  );

  test('full server-executed tool/text turn uses a single POST', () async {
    final text = [
      ': keepalive\n\n',
      frame({
        'choices': [
          {
            'delta': {'content': 'Héllo '},
            'finish_reason': null,
          },
        ],
      }),
      frame({
        'choices': [
          {
            'delta': {
              'tool_calls': [
                {
                  'index': 3,
                  'id': 'call-a',
                  'function': {'name': 'tasks__list', 'arguments': '{"limit":'},
                },
              ],
            },
            'finish_reason': null,
          },
        ],
      }),
      frame({
        'choices': [
          {
            'delta': {
              'tool_calls': [
                {
                  'index': 3,
                  'function': {'arguments': '2}'},
                },
              ],
            },
            'finish_reason': null,
          },
        ],
      }),
      frame({
        'choices': [
          {
            'delta': {
              'tool_calls': [
                {
                  'index': 8,
                  'id': 'call-b',
                  'function': {'name': 'tasks__get', 'arguments': '{"id":1}'},
                },
              ],
            },
            'finish_reason': null,
          },
        ],
      }),
      frame({
        'choices': [
          {
            'delta': {'content': 'done'},
            'finish_reason': null,
          },
        ],
      }),
      frame({
        'choices': [
          {'delta': {}, 'finish_reason': 'tool_calls'},
        ],
      }),
      'data: [DONE]\n\n',
    ].join();
    final adapter = FakePluginAdapter((_) => sseResponse(text));
    final client = LangChainClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gateway.test/v1',
    );
    var received = 0;
    final content = <String>[];
    final result = await client.streamTurn(
      request(),
      onReceived: () => received++,
      onContent: content.add,
    );
    expect(received, 1);
    expect(content.join(), 'Héllo done');
    expect(result.content, 'Héllo done');
    expect(result.toolCalls.map((t) => t.id), ['call-a', 'call-b']);
    expect(result.toolCalls.first.args, {'limit': 2});
    expect(result.finishReason, 'tool_calls');
    expect(adapter.requests, hasLength(1));
    expect(adapter.requests.single.method, 'POST');
    expect(
      adapter.requests.single.path,
      'https://gateway.test/v1/chat/completions',
    );
    expect(
      adapter.requests.single.headers['Authorization'],
      'Bearer gateway-secret',
    );
    expect(
      adapter.requests.single.data['credentials']['openrouter']['apiKey'],
      'provider-secret',
    );
  });

  test('server empty turn terminates without a finish chunk', () async {
    final adapter = FakePluginAdapter((_) => sseResponse('data: [DONE]\n\n'));
    final client = LangChainClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gateway.test/v1',
    );
    final result = await client.streamTurn(request());
    expect(result.content, isEmpty);
    expect(result.toolCalls, isEmpty);
    expect(result.finishReason, 'stop');
    expect(adapter.requests, hasLength(1));
  });

  test('managed turn in recreated state resolves as a success', () async {
    final text = [
      frame({
        'choices': [
          {
            'delta': {'content': 'recreated reply'},
            'finish_reason': null,
          },
        ],
      }),
      frame({
        'choices': [
          {'delta': {}, 'finish_reason': 'stop'},
        ],
      }),
      'data: [DONE]\n\n',
    ].join();
    final adapter = FakePluginAdapter(
      (_) => ResponseBody(
        Stream.fromIterable(
          utf8.encode(text).map((byte) => Uint8List.fromList([byte])),
        ),
        200,
        headers: {
          'content-type': ['text/event-stream'],
          'x-thread-id': ['thread-uuid'],
          'x-conversation-state': ['recreated'],
        },
      ),
    );
    final client = LangChainClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gateway.test/v1',
    );
    final result = await client.managedTurn(
      LangChainRequest(
        gatewayKey: 'gateway-secret',
        modelPluginId: 'openrouter',
        credentials: {
          'openrouter': {'apiKey': 'provider-secret'},
        },
        messages: [const ApiMessage(role: 'user', content: 'Hello')],
        conversationPublicId: 'thread-uuid',
        turnId: 'turn-uuid',
        managed: true,
      ),
    );
    expect(result.state, 'recreated');
    expect(result.threadId, 'thread-uuid');
    expect(result.result!.content, 'recreated reply');
    expect(adapter.requests, hasLength(1));
    expect(adapter.requests.single.method, 'POST');
  });

  test('malformed/incomplete streams never retry or fall back', () async {
    for (final (body, code) in [
      ('data: broken-secret\n\n', 'invalid_response'),
      (
        frame({
          'choices': [
            {
              'delta': {'content': 'partial'},
              'finish_reason': null,
            },
          ],
        }),
        'incomplete_stream',
      ),
      (
        frame({
          'choices': [
            {'delta': {}, 'finish_reason': 'stop'},
          ],
        }),
        'incomplete_stream',
      ),
      (
        [
          frame({
            'choices': [
              {
                'delta': {
                  'tool_calls': [
                    {
                      'index': 5,
                      'id': 'x',
                      'function': {'name': 'f', 'arguments': '{bad'},
                    },
                  ],
                },
                'finish_reason': 'tool_calls',
              },
            ],
          }),
          'data: [DONE]\n\n',
        ].join(),
        'invalid_response',
      ),
      (frame({'error': 'invalid_credentials'}), 'invalid_credentials'),
      (frame({'error': 'message_thread_conflict'}), 'message_thread_conflict'),
      (
        frame({
          'error': {'message': 'provider-secret'},
        }),
        'server_error',
      ),
    ]) {
      final adapter = FakePluginAdapter((_) => sseResponse(body));
      final client = LangChainClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gateway.test/v1',
      );
      await expectLater(client.streamTurn(request()), errorCode(code));
      expect(adapter.requests, hasLength(1));
    }
    final adapter = FakePluginAdapter(
      (_) => ResponseBody.fromString('{}', 200),
    );
    await expectLater(
      LangChainClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gateway.test/v1',
      ).streamTurn(request()),
      errorCode('invalid_response'),
    );
    expect(adapter.requests, hasLength(1));
  });

  test('transport failures are safe and never retried', () async {
    for (final type in [
      DioExceptionType.connectionTimeout,
      DioExceptionType.connectionError,
      DioExceptionType.cancel,
    ]) {
      final adapter = FakePluginAdapter(
        (options) => throw DioException(
          requestOptions: options,
          type: type,
          message: 'provider-secret gateway-secret',
        ),
      );
      final client = LangChainClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gateway.test/v1',
      );
      await expectLater(
        client.streamTurn(request()),
        errorCode(
          type == DioExceptionType.cancel
              ? 'cancelled'
              : type == DioExceptionType.connectionError
              ? 'network_error'
              : 'timeout',
        ),
      );
      expect(adapter.requests, hasLength(1));
    }
  });

  test('cancellation and deadline stop a stalled SSE stream', () async {
    for (final cancel in [true, false]) {
      final controller = StreamController<Uint8List>();
      var streamCancelled = false;
      controller.onCancel = () {
        streamCancelled = true;
      };
      final adapter = FakePluginAdapter(
        (_) => ResponseBody(
          controller.stream,
          200,
          headers: {
            'content-type': ['text/event-stream'],
          },
        ),
      );
      final client = LangChainClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gateway.test/v1',
        timeout: cancel
            ? const Duration(seconds: 2)
            : const Duration(milliseconds: 30),
      );
      final token = CancelToken();
      final future = client.streamTurn(
        request(),
        cancelToken: token,
        onReceived: () {
          if (cancel) token.cancel('gateway-secret');
        },
      );
      await expectLater(future, errorCode(cancel ? 'cancelled' : 'timeout'));
      expect(streamCancelled, isTrue);
      expect(adapter.requests, hasLength(1));
      await controller.close();
    }
  });

  test(
    'nested SSE error after nonzero tool index keeps safe code, never retries',
    () async {
      final adapter = FakePluginAdapter(
        (_) => sseResponse(
          [
            frame({
              'choices': [
                {
                  'delta': {
                    'tool_calls': [
                      {
                        'index': 7,
                        'id': 'call-7',
                        'function': {
                          'name': 'tasks__create',
                          'arguments': '{"title":"test"}',
                        },
                      },
                    ],
                  },
                  'finish_reason': null,
                },
              ],
            }),
            frame({
              'error': {
                'code': 'budget_exhausted',
                'type': 'model_error',
                'message': 'provider-secret gateway-secret',
              },
            }),
            'data: [DONE]\n\n',
          ].join(),
        ),
      );
      final client = LangChainClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gateway.test/v1',
      );
      final calls = <int>[];
      await expectLater(
        client.streamTurn(
          request(),
          onToolCallDelta: (delta) => calls.add(delta.index),
        ),
        throwsA(
          isA<PluginClientException>()
              .having((e) => e.code, 'code', 'budget_exhausted')
              .having(
                (e) => e.toString(),
                'safe text',
                isNot(contains('secret')),
              ),
        ),
      );
      expect(calls, [7]);
      expect(adapter.requests, hasLength(1));
    },
  );
}
