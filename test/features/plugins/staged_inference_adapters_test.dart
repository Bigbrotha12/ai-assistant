import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/features/auth/data/account_lifecycle.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:ai_assistant/features/plugins/data/staged_inference_adapters.dart';
import 'package:ai_assistant/features/vision/data/vision_client.dart';
import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

class _Wire implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  Completer<void>? gate;
  final received = StreamController<void>.broadcast();
  int status = 200;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    received.add(null);
    await gate?.future;
    final body = options.data as Map<String, dynamic>;
    return ResponseBody.fromString(
      status == 200
          ? 'data: ${jsonEncode({
              'choices': [
                {
                  'delta': {'content': 'A picture'},
                  'finish_reason': 'stop',
                },
              ],
            })}\n\ndata: [DONE]\n\n'
          : '{"error":"inference_unavailable"}',
      status,
      headers: {
        'content-type': [
          status == 200 ? 'text/event-stream' : 'application/json',
        ],
        if (body['conversation_mode'] == 'managed') ...{
          'x-thread-id': [body['thread_id'] as String],
          'x-conversation-state': ['seeded'],
        },
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

PluginModelDto _model(String id, bool vision) => PluginModelDto.fromJson({
  'id': id,
  'object': 'model',
  'created': 0,
  'owned_by': 'test',
  'defaultModel': '$id/upstream',
  'tokenLimit': 4096,
  'visionCapable': vision,
  'supportsStreaming': true,
  'parameters': <String, dynamic>{},
});

void main() {
  late AppDatabase db;
  late ManagedConversationRepository repo;
  late PluginCredentialsStore plugins;
  late SecureAuthCredentialsStore auth;
  late AuthAccountScope scope;
  late AuthAccountScope? current;
  late AccountLifecycle lifecycle;
  late StagedInferenceAdapters adapters;
  late LangChainClient client;
  late _Wire wire;
  late List<PluginModelDto> models;
  var modelLoads = 0;

  setUp(() async {
    db = AppDatabase(NativeDatabase.memory());
    repo = ManagedConversationRepository(db);
    final storage = InMemorySecureStorage();
    plugins = PluginCredentialsStore(storage: storage);
    auth = SecureAuthCredentialsStore(storage: storage);
    scope = AuthAccountScope.fromIdentity(
      backendOrigin: 'https://gateway.test',
      ownerId: 'alice',
    )!;
    current = scope;
    await auth.save(
      const AuthCredentials(
        apiKey: 'gateway-test',
        backendOrigin: 'https://gateway.test',
        ownerId: 'alice',
      ),
    );
    await plugins.setSelectedModel(scope, 'text');
    await plugins.setCredentials(scope, 'text', {'apiKey': 'text-test'});
    await plugins.setCredentials(scope, 'eyes', {'apiKey': 'eyes-test'});
    await plugins.setEnabled(scope, 'eyes', true);
    await plugins.setCredentials(scope, 'disabled', {'apiKey': 'never-send'});
    models = [
      _model('text', false),
      _model('eyes', true),
      _model('disabled', true),
    ];
    modelLoads = 0;
    wire = _Wire();
    final dio = Dio()..httpClientAdapter = wire;
    client = LangChainClient(dio: dio, baseUrl: 'https://gateway.test/v1');
    lifecycle = AccountLifecycle();
    adapters = createStagedInferenceAdapters(
      client: client,
      repository: repo,
      scope: scope,
      currentScope: () => current,
      authStore: auth,
      pluginStore: plugins,
      lifecycle: lifecycle,
      loadModels: ({required gatewayKey, cancelToken}) async {
        expect(gatewayKey, 'gateway-test');
        modelLoads++;
        return models;
      },
    );
  });

  tearDown(() async {
    adapters.dispose();
    lifecycle.dispose();
    await wire.received.close();
    await db.close();
  });

  test('lazy factory and vision uses capable configured plugin, bearer and shared SSE', () async {
    expect(wire.requests, isEmpty);
    expect(modelLoads, 0);
    expect(
      await adapters.describeImage(
        bytes: Uint8List.fromList([1, 2, 3]),
        mimeType: 'image/png',
        prompt: 'What?',
      ),
      'A picture',
    );
    final request = wire.requests.single;
    expect(request.uri.toString(), 'https://gateway.test/v1/chat/completions');
    expect(request.headers['Authorization'], 'Bearer gateway-test');
    expect(request.followRedirects, isFalse);
    expect(request.data, {
      'model': 'eyes',
      'stream': true,
      'enabled_plugins': [],
      'credentials': {
        'eyes': {'apiKey': 'eyes-test'},
      },
      'messages': [
        {
          'role': 'user',
          'content': [
            {'type': 'text', 'text': 'What?'},
            {
              'type': 'image_url',
              'image_url': {'url': 'data:image/png;base64,AQID'},
            },
          ],
        },
      ],
    });
    expect(await (db.select(db.managedPendingTurns)).get(), isEmpty);
    await plugins.setCredentials(scope, 'eyes', {'apiKey': 'rotated-test'});
    await adapters.describeImage(
      bytes: Uint8List.fromList([1]),
      mimeType: 'image/jpeg',
    );
    expect((wire.requests.last.data as Map)['credentials'], {
      'eyes': {'apiKey': 'rotated-test'},
    });
  });

  test('probe explicitly reports no credentials and no capable model without inference', () async {
    await auth.clear();
    expect((await adapters.probeVision()).status, ProbeStatus.noCredentials);
    expect(modelLoads, 0);
    await auth.save(
      const AuthCredentials(
        apiKey: 'gateway-test',
        backendOrigin: 'https://gateway.test',
        ownerId: 'alice',
      ),
    );
    await plugins.setCredentials(scope, 'eyes', {});
    expect((await adapters.probeVision()).status, ProbeStatus.noCredentials);
    models = [_model('text', false)];
    expect((await adapters.probeVision()).detail, 'no_capable_model');
    expect(wire.requests, isEmpty);
  });

  test('invalid images and precancelled requests never dispatch', () async {
    for (final image in [
      Uint8List(0),
      Uint8List(StagedInferenceAdapters.maxImageBytes + 1),
    ]) {
      await expectLater(
        adapters.describeImage(bytes: image, mimeType: 'image/png'),
        throwsA(isA<VisionValidationError>()),
      );
    }
    await expectLater(
      adapters.describeImage(bytes: Uint8List(1), mimeType: 'text/html'),
      throwsA(isA<VisionValidationError>()),
    );
    final token = CancelToken()..cancel();
    await expectLater(
      adapters.describeImage(
        bytes: Uint8List(1),
        mimeType: 'image/png',
        cancelToken: token,
      ),
      throwsA(isA<PluginClientException>()),
    );
    expect(wire.requests, isEmpty);
  });

  test('vision failure is not retried', () async {
    wire.status = 503;
    await expectLater(
      adapters.describeImage(bytes: Uint8List(1), mimeType: 'image/png'),
      throwsA(isA<PluginClientException>()),
    );
    expect(wire.requests, hasLength(1));
  });

  test(
    'voice then managed chat preserves conversation and thread history',
    () async {
      final voice = await adapters.sendVoiceTurn(
        'conversation',
        userText: 'Spoken',
      );
      final history = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) async =>
            (await store.loadConversation('conversation'))!.messages,
      );
      expect(history.map((m) => m.content), ['Spoken', 'A picture']);
      final chat = ManagedConversationService(
        client: client,
        repo: repo,
        scope: scope,
        modelPluginId: 'text',
        credentials: () async => const ManagedCredentials(
          gatewayKey: 'gateway-test',
          provider: {
            'text': {'apiKey': 'text-test'},
          },
        ),
      );
      final text = await chat.sendTurn(
        'conversation',
        history: history,
        userText: 'Typed',
      );
      expect(text.threadId, voice.threadId);
      final bodies = wire.requests.map((r) => r.data as Map).toList();
      expect(bodies[0]['messageId'], isNot(bodies[1]['messageId']));
      expect((bodies[1]['messages'] as List).map((m) => m['content']), [
        'Spoken',
        'A picture',
        'Typed',
      ]);
      expect(bodies.every((b) => !b.containsKey('tools')), isTrue);
      expect(await repo.pending(scope, 'conversation'), isNull);
    },
  );

  test(
    'lifecycle cancels voice, clears scope, suppresses late callback',
    () async {
      wire.gate = Completer<void>();
      var callbacks = 0;
      final received = wire.received.stream.first;
      final result = adapters.sendVoiceTurn(
        'late',
        userText: 'Spoken',
        onCompleted: (_) => callbacks++,
      );
      final assertion = expectLater(
        result,
        throwsA(isA<PluginClientException>()),
      );
      await received;
      final pending = (await repo.pending(scope, 'late'))!;
      expect(pending.envelope, isNot(contains('test')));
      final epoch = lifecycle.begin();
      await lifecycle.cancelPending();
      await lifecycle.clearLocal(scope);
      current = null;
      wire.gate!.complete();
      await assertion;
      lifecycle.complete(epoch);
      expect(callbacks, 0);
      expect(await repo.pending(scope, 'late'), isNull);
      expect(await (db.select(db.conversations)).get(), isEmpty);
    },
  );

  test('voice caller cancellation suppresses completion', () async {
    wire.gate = Completer<void>();
    final token = CancelToken();
    final received = wire.received.stream.first;
    var callbacks = 0;
    final result = adapters.sendVoiceTurn(
      'cancel',
      userText: 'Spoken',
      cancelToken: token,
      onCompleted: (_) => callbacks++,
    );
    final assertion = expectLater(
      result,
      throwsA(isA<PluginClientException>()),
    );
    await received;
    token.cancel();
    wire.gate!.complete();
    await assertion;
    expect(callbacks, 0);
  });

  test(
    'late voice account result cannot persist an assistant or call back',
    () async {
      wire.gate = Completer<void>();
      final received = wire.received.stream.first;
      var callbacks = 0;
      final result = adapters.sendVoiceTurn(
        'changed',
        userText: 'Spoken',
        onCompleted: (_) => callbacks++,
      );
      final assertion = expectLater(
        result,
        throwsA(isA<PluginClientException>()),
      );
      await received;
      current = null;
      wire.gate!.complete();
      await assertion;
      final history = await repo.access(
        scope,
        repo.epoch(scope),
        () {},
        (store) async => (await store.loadConversation('changed'))!.messages,
      );
      expect(history.map((m) => m.content), ['Spoken']);
      expect(callbacks, 0);
    },
  );

  test('vision caller cancellation is not retried', () async {
    wire.gate = Completer<void>();
    final token = CancelToken();
    final received = wire.received.stream.first;
    final result = adapters.describeImage(
      bytes: Uint8List(1),
      mimeType: 'image/png',
      cancelToken: token,
    );
    final assertion = expectLater(
      result,
      throwsA(isA<PluginClientException>()),
    );
    await received;
    token.cancel();
    wire.gate!.complete();
    await assertion;
    expect(wire.requests, hasLength(1));
  });

  test('late vision result from changed account is discarded', () async {
    wire.gate = Completer<void>();
    final received = wire.received.stream.first;
    final result = adapters.describeImage(
      bytes: Uint8List(1),
      mimeType: 'image/png',
    );
    final assertion = expectLater(
      result,
      throwsA(isA<PluginClientException>()),
    );
    await received;
    current = AuthAccountScope.fromIdentity(
      backendOrigin: scope.backendOrigin,
      ownerId: 'bob',
    );
    wire.gate!.complete();
    await assertion;
  });
}
