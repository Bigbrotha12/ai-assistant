import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate;
import 'dart:typed_data';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/ledger_client.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:drift/native.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

const credentials = AuthCredentials(
  apiKey: 'test-key',
  ownerId: 'owner-a',
  backendOrigin: 'https://gw.test',
);

Map<String, dynamic> taskJson({
  String status = 'running',
  String messageId = 'msg',
}) => {
  'id': 'task',
  'owner': 'owner-a',
  'intent_key': messageId,
  'status': status,
  'created_ts': 1,
  'updated_ts': 2,
  'last_heartbeat_ts': 2,
};

Map<String, dynamic> cancelReportJson({
  String taskId = 'task',
  String stage = 'already-terminal',
  String reachedStage = 'already-terminal',
  String taskStatus = 'awaiting_review',
  String? terminalStatus = 'awaiting_review',
}) => {
  'schemaVersion': 1,
  'taskId': taskId,
  'stage': stage,
  'reachedStage': reachedStage,
  'taskStatus': taskStatus,
  'cancellable': false,
  'terminalStatus': ?terminalStatus,
  'effectState': 'completed_steps_only',
  'completedActions': [
    {
      'id': 'step-1',
      'stage': 'sentinel',
      'action': 'sentinel:flag',
      'completed': true,
    },
  ],
  'projection': {
    'schemaVersion': 1,
    'code': 'review',
    'lastActionId': 'step-1',
    'canCancel': false,
    'canRetry': false,
    'cancellationPending': false,
    'effectState': 'completed_steps_only',
    'terminalStatus': 'awaiting_review',
  },
};

ResponseBody jsonResponse(
  Object? value, {
  int status = 200,
  String? retryAfter,
}) => ResponseBody.fromString(
  jsonEncode(value),
  status,
  headers: {
    'content-type': ['application/json'],
    if (retryAfter != null) 'retry-after': [retryAfter],
  },
);

class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.respond);
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

class FakeScheduler implements LedgerScheduler {
  @override
  Duration elapsed = Duration.zero;
  final jobs = <({Duration at, void Function() callback, List<bool> active})>[];

  @override
  LedgerCancel schedule(Duration delay, void Function() callback) {
    final active = [true];
    jobs.add((at: elapsed + delay, callback: callback, active: active));
    return () => active[0] = false;
  }

  Future<void> advance(Duration duration) async {
    final target = elapsed + duration;
    await flush();
    while (true) {
      jobs.sort((a, b) => a.at.compareTo(b.at));
      final ready = jobs
          .where((j) => j.active[0] && j.at <= target)
          .firstOrNull;
      if (ready == null) break;
      elapsed = ready.at;
      ready.active[0] = false;
      ready.callback();
      await flush();
    }
    elapsed = target;
    await flush();
  }
}

Future<void> flush() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class Rig {
  Rig(
    FutureOr<ResponseBody> Function(RequestOptions) respond, {
    int maxAttempts = 12,
    LedgerCredentialsResolver? resolver,
  }) {
    adapter = FakeAdapter((request) {
      times.add(clock.elapsed.inSeconds);
      return respond(request);
    });
    dio.httpClientAdapter = adapter;
    poller = LedgerPoller(
      client: LedgerClient(dio: dio, scope: credentials.accountScope!),
      credentials: resolver ?? () async => auth,
      scheduler: clock,
      maxAttempts: maxAttempts,
      maxElapsed: const Duration(seconds: 30),
      maxDelay: const Duration(seconds: 3),
    );
    addTearDown(poller.dispose);
    addTearDown(dio.close);
  }

  final dio = Dio();
  final clock = FakeScheduler();
  final times = <int>[];
  AuthCredentials? auth = credentials;
  late final FakeAdapter adapter;
  late final LedgerPoller poller;
}

void main() {
  test('HTTP-date Retry-After is preserved by PluginHttp', () async {
    final retryAt = DateTime.now().toUtc().add(const Duration(seconds: 60));
    final rig = Rig(
      (_) => jsonResponse(
        {'error': 'busy'},
        status: 503,
        retryAfter: HttpDate.format(retryAt),
      ),
    );
    await expectLater(
      rig.poller.client.getTask('task', gatewayKey: 'test-key'),
      throwsA(
        isA<PluginClientException>().having(
          (e) => e.retryAfter!.inSeconds,
          'retryAfter',
          inInclusiveRange(58, 60),
        ),
      ),
    );
  });

  test(
    'credentials refresh each GET after invalidating old key work',
    () async {
      final rig = Rig((_) => jsonResponse(taskJson()));
      rig.poller.setForeground(true);
      final first = rig.poller.watch(const LedgerLookup.byTaskId('task'));
      await rig.clock.advance(Duration.zero);
      rig.poller.invalidateScope();
      rig.auth = const AuthCredentials(
        apiKey: 'rotated',
        ownerId: 'owner-a',
        backendOrigin: 'https://gw.test',
      );
      rig.poller.watch(const LedgerLookup.byTaskId('task'));
      await rig.clock.advance(Duration.zero);
      expect(first.isCurrent, isFalse);
      expect(rig.adapter.requests.map((r) => r.headers['Authorization']), [
        'Bearer test-key',
        'Bearer rotated',
      ]);
    },
  );

  test(
    'pause cancels transport and late old response cannot beat resumed result',
    () async {
      final old = Completer<ResponseBody>();
      var calls = 0;
      final rig = Rig(
        (_) => ++calls == 1
            ? old.future
            : jsonResponse(taskJson(status: 'failed')),
      );
      final updates = <LedgerTaskStatus>[];
      final handle = rig.poller.watch(
        const LedgerLookup.byTaskId('task'),
        onUpdate: (task) => updates.add(task.status),
      );
      rig.poller.setForeground(true);
      await rig.clock.advance(Duration.zero);
      final token = rig.adapter.requests.single.cancelToken!;
      rig.poller.setForeground(false);
      await flush();
      expect(token.isCancelled, isTrue);
      rig.poller.setForeground(true);
      await rig.clock.advance(Duration.zero);
      old.complete(jsonResponse(taskJson(status: 'succeeded')));
      await flush();
      expect(updates, [LedgerTaskStatus.failed]);
      expect((await handle.done).task?.status, LedgerTaskStatus.failed);
      rig.poller.setForeground(false);
      rig.poller.setForeground(true);
      expect(handle.isCurrent, isFalse);
    },
  );

  test(
    'callback invalidation stops scheduling and consumer exceptions are safe',
    () async {
      final rig = Rig((_) => jsonResponse(taskJson()));
      rig.poller.setForeground(true);
      final handle = rig.poller.watch(
        const LedgerLookup.byTaskId('task'),
        onUpdate: (_) => rig.poller.invalidateScope(),
      );
      await rig.clock.advance(const Duration(seconds: 30));
      expect((await handle.done).end, LedgerPollEnd.cancelled);
      expect(rig.times, [0]);
      final next = rig.poller.watch(
        const LedgerLookup.byTaskId('task'),
        onUpdate: (_) => throw StateError('private'),
      );
      await rig.clock.advance(Duration.zero);
      expect((await next.done).error.toString(), isNot(contains('private')));
    },
  );

  test(
    'network failures retry sequentially and malformed JSON stops',
    () async {
      var calls = 0;
      final rig = Rig((request) {
        if (++calls == 1) {
          throw DioException(
            requestOptions: request,
            type: DioExceptionType.connectionError,
          );
        }
        return ResponseBody.fromString('private-not-json', 200);
      });
      final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
      rig.poller.setForeground(true);
      await rig.clock.advance(const Duration(seconds: 30));
      expect(rig.times, [0, 1]);
      expect((await handle.done).error?.code, 'invalid_response');
    },
  );

  test(
    'expired paused polling and disposed pollers never start requests',
    () async {
      final rig = Rig((_) => jsonResponse(taskJson()));
      final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
      await rig.clock.advance(const Duration(seconds: 31));
      rig.poller.setForeground(true);
      expect((await handle.done).end, LedgerPollEnd.exhausted);
      expect(rig.adapter.requests, isEmpty);
      rig.poller.dispose();
      expect(
        () => rig.poller.watch(const LedgerLookup.byTaskId('task')),
        throwsA(isA<PluginClientException>()),
      );
    },
  );
  test('GET contracts encode IDs, authenticate per call and discard private fields', () async {
    const messageId = 'message /?#%';
    final adapter = FakeAdapter(
      (_) => jsonResponse({
        ...taskJson(messageId: messageId),
        'spec': 'private',
        'fence_token': 'private',
        'steps': [
          {'result': 'private'},
        ],
        'chain': [],
      }),
    );
    final dio = Dio()..httpClientAdapter = adapter;
    addTearDown(dio.close);
    final client = LedgerClient(dio: dio, scope: credentials.accountScope!);
    final task = await client.getTaskByMessageId(
      messageId,
      gatewayKey: 'first',
    );
    await client.getTask('task', gatewayKey: 'second');
    expect(task.messageId, messageId);
    expect(task.toString(), isNot(contains('private')));
    expect(
      adapter.requests.first.uri.toString(),
      'https://gw.test/ledger/tasks/by-key/${Uri.encodeComponent(messageId)}',
    );
    expect(adapter.requests.last.uri.path, '/ledger/tasks/task');
    expect(adapter.requests.map((r) => r.headers['Authorization']), [
      'Bearer first',
      'Bearer second',
    ]);
    for (final request in adapter.requests) {
      expect(request.method, 'GET');
      expect(request.data, isNull);
      expect(request.followRedirects, isFalse);
    }
  });

  test(
    'cancelTask posts no caller-selected state and parses the versioned report',
    () async {
      final adapter = FakeAdapter((_) => jsonResponse(cancelReportJson()));
      final dio = Dio()..httpClientAdapter = adapter;
      addTearDown(dio.close);
      final client = LedgerClient(dio: dio, scope: credentials.accountScope!);

      final report = await client.cancelTask('task', gatewayKey: 'gateway-key');

      expect(adapter.requests.single.method, 'POST');
      expect(adapter.requests.single.uri.path, '/ledger/tasks/task/cancel');
      expect(adapter.requests.single.data, isNull);
      expect(
        adapter.requests.single.headers['Authorization'],
        'Bearer gateway-key',
      );
      expect(report.stage, LedgerTaskCancelStage.alreadyTerminal);
      expect(report.reachedStage, LedgerTaskCancelReachedStage.alreadyTerminal);
      expect(report.taskStatus, LedgerTaskStatus.awaitingReview);
      expect(report.terminalStatus, LedgerTaskStatus.awaitingReview);
      expect(report.cancellable, isFalse);
      expect(report.completedActions.single.action, 'sentinel:flag');
      expect(report.projection.code, LedgerTaskProgressCode.review);
    },
  );

  test('cancelTask rejects an internally inconsistent report', () async {
    final payload = cancelReportJson();
    (payload['projection']! as Map<String, dynamic>)['canCancel'] = true;
    final adapter = FakeAdapter((_) => jsonResponse(payload));
    final dio = Dio()..httpClientAdapter = adapter;
    addTearDown(dio.close);
    final client = LedgerClient(dio: dio, scope: credentials.accountScope!);

    await expectLater(
      client.cancelTask('task', gatewayKey: 'gateway-key'),
      throwsA(
        isA<PluginClientException>().having(
          (error) => error.code,
          'code',
          'invalid_response',
        ),
      ),
    );
  });

  test('steps parsing: reply extraction + missing steps tolerated', () {
    final withSteps = LedgerTask.fromJson({
      ...taskJson(status: 'succeeded'),
      'steps': [
        {
          'id': 's1',
          'task_id': 'task',
          'seq': 1,
          'stage': 'tool',
          'action': 'tool:list_tasks',
          'result': '{"ok":true}',
          'ts': 1,
          'tool_call_id': 'call_1',
        },
        {
          'id': 's2',
          'task_id': 'task',
          'seq': 2,
          'stage': 'reply',
          'action': 'assistant_message',
          'result': 'the assistant reply',
          'ts': 2,
          'tool_call_id': null,
        },
      ],
    });
    expect(withSteps.steps, hasLength(2));
    expect(withSteps.steps.first.stage, 'tool');
    expect(withSteps.steps.first.toolCallId, 'call_1');
    expect(withSteps.steps.last.action, 'assistant_message');
    expect(withSteps.reply, 'the assistant reply');

    // The status-by-messageId endpoint carries no steps key — tolerated.
    final withoutSteps = LedgerTask.fromJson(taskJson(status: 'succeeded'));
    expect(withoutSteps.steps, isEmpty);
    expect(withoutSteps.reply, isNull);

    // A reply step without a string result yields a null reply.
    final nullResult = LedgerTask.fromJson({
      ...taskJson(status: 'succeeded'),
      'steps': [
        {'stage': 'reply', 'action': 'assistant_message', 'result': null},
      ],
    });
    expect(nullResult.reply, isNull);

    // A reply step with a non-string result yields a null reply.
    final nonString = LedgerTask.fromJson({
      ...taskJson(status: 'succeeded'),
      'steps': [
        {'stage': 'reply', 'action': 'assistant_message', 'result': 42},
      ],
    });
    expect(nonString.reply, isNull);
  });

  test(
    'all server statuses stay distinct; review and stuck are not terminal',
    () {
      final statuses = {
        'queued': LedgerTaskStatus.queued,
        'running': LedgerTaskStatus.running,
        'stuck': LedgerTaskStatus.stuck,
        'succeeded': LedgerTaskStatus.succeeded,
        'failed': LedgerTaskStatus.failed,
        'cancelled': LedgerTaskStatus.cancelled,
        'awaiting_review': LedgerTaskStatus.awaitingReview,
        'future_status': LedgerTaskStatus.unknown,
      };
      for (final entry in statuses.entries) {
        expect(
          LedgerTask.fromJson(taskJson(status: entry.key)).status,
          entry.value,
        );
      }
      expect(LedgerTaskStatus.stuck.isTerminal, isFalse);
      expect(LedgerTaskStatus.awaitingReview.isTerminal, isFalse);
      expect(LedgerTaskStatus.unknown.isTerminal, isFalse);
    },
  );

  test('deterministic projection preserves every existing status and error behavior', () {
    const cases =
        <
          ({
            String status,
            List<Map<String, dynamic>> steps,
            LedgerTaskProgressCode code,
            bool pending,
            bool terminal,
            bool canCancel,
            bool canRetry,
            LedgerTaskStatus? terminalStatus,
            String? errorCode,
            LedgerTaskEffectState effectState,
          })
        >[
          (
            status: 'queued',
            steps: [],
            code: LedgerTaskProgressCode.queued,
            pending: true,
            terminal: false,
            canCancel: true,
            canRetry: false,
            terminalStatus: null,
            errorCode: null,
            effectState: LedgerTaskEffectState.noneKnown,
          ),
          (
            status: 'running',
            steps: [],
            code: LedgerTaskProgressCode.runningModel,
            pending: true,
            terminal: false,
            canCancel: true,
            canRetry: false,
            terminalStatus: null,
            errorCode: null,
            effectState: LedgerTaskEffectState.noneKnown,
          ),
          (
            status: 'running',
            steps: [
              {'stage': 'tool', 'action': 'tool:list', 'result': '{}'},
            ],
            code: LedgerTaskProgressCode.runningModel,
            pending: true,
            terminal: false,
            canCancel: true,
            canRetry: false,
            terminalStatus: null,
            errorCode: null,
            effectState: LedgerTaskEffectState.completedStepsOnly,
          ),
          (
            status: 'running',
            steps: [
              {'stage': 'error', 'action': 'error:job_failed', 'result': 'x'},
            ],
            code: LedgerTaskProgressCode.runningModel,
            pending: true,
            terminal: false,
            canCancel: true,
            canRetry: false,
            terminalStatus: null,
            errorCode: 'job_failed',
            effectState: LedgerTaskEffectState.completedStepsOnly,
          ),
          (
            status: 'stuck',
            steps: [
              {'stage': 'tool', 'action': 'tool:list', 'result': '{}'},
            ],
            code: LedgerTaskProgressCode.queued,
            pending: true,
            terminal: false,
            canCancel: false,
            canRetry: true,
            terminalStatus: null,
            errorCode: null,
            effectState: LedgerTaskEffectState.unknown,
          ),
          (
            status: 'succeeded',
            steps: [
              {'stage': 'reply', 'action': 'assistant_message', 'result': 'ok'},
            ],
            code: LedgerTaskProgressCode.done,
            pending: false,
            terminal: true,
            canCancel: false,
            canRetry: false,
            terminalStatus: LedgerTaskStatus.succeeded,
            errorCode: null,
            effectState: LedgerTaskEffectState.completedStepsOnly,
          ),
          (
            status: 'failed',
            steps: [
              {
                'stage': 'error',
                'action': 'error:credentials_expired',
                'result': 'x',
              },
            ],
            code: LedgerTaskProgressCode.done,
            pending: false,
            terminal: true,
            canCancel: false,
            canRetry: true,
            terminalStatus: LedgerTaskStatus.failed,
            errorCode: 'credentials_expired',
            effectState: LedgerTaskEffectState.completedStepsOnly,
          ),
          (
            status: 'cancelled',
            steps: [],
            code: LedgerTaskProgressCode.done,
            pending: false,
            terminal: true,
            canCancel: false,
            canRetry: false,
            terminalStatus: LedgerTaskStatus.cancelled,
            errorCode: null,
            effectState: LedgerTaskEffectState.noneKnown,
          ),
          (
            status: 'awaiting_review',
            steps: [
              {'stage': 'sentinel', 'action': 'sentinel:flag', 'result': '{}'},
            ],
            code: LedgerTaskProgressCode.review,
            pending: true,
            terminal: true,
            canCancel: false,
            canRetry: false,
            terminalStatus: LedgerTaskStatus.awaitingReview,
            errorCode: null,
            effectState: LedgerTaskEffectState.completedStepsOnly,
          ),
          (
            status: 'future_status',
            steps: [],
            code: LedgerTaskProgressCode.expired,
            pending: false,
            terminal: true,
            canCancel: false,
            canRetry: false,
            terminalStatus: null,
            errorCode: null,
            effectState: LedgerTaskEffectState.unknown,
          ),
        ];

    for (final item in cases) {
      final task = LedgerTask.fromJson({
        ...taskJson(status: item.status),
        'steps': item.steps,
      });
      final projection = task.projection;
      expect(projection.code, item.code, reason: item.status);
      expect(projection.keepsPendingMarker, item.pending, reason: item.status);
      expect(projection.isTerminal, item.terminal, reason: item.status);
      expect(projection.canCancel, item.canCancel, reason: item.status);
      expect(projection.canRetry, item.canRetry, reason: item.status);
      expect(
        projection.terminalStatus,
        item.terminalStatus,
        reason: item.status,
      );
      expect(projection.errorCode, item.errorCode, reason: item.status);
      expect(projection.effectState, item.effectState, reason: item.status);
    }
  });

  test('invalid shapes, owner and lookup mismatches fail safely', () async {
    for (final body in [
      <String, dynamic>{},
      {...taskJson(), 'owner': 'other'},
      {...taskJson(), 'intent_key': 'other'},
      {...taskJson(), 'status': 42},
      {...taskJson(), 'created_ts': 'private'},
    ]) {
      final dio = Dio()
        ..httpClientAdapter = FakeAdapter((_) => jsonResponse(body));
      addTearDown(dio.close);
      await expectLater(
        LedgerClient(
          dio: dio,
          scope: credentials.accountScope!,
        ).getTaskByMessageId('msg', gatewayKey: 'test-key'),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            'invalid_response',
          ),
        ),
      );
    }
  });

  test('404 projects an expired task immediately without retry', () async {
    final rig = Rig(
      (_) => jsonResponse({'error': 'not_found'}, status: 404),
      maxAttempts: 5,
    );
    final handle = rig.poller.watch(const LedgerLookup.byMessageId('msg'));
    rig.poller.setForeground(true);
    await rig.clock.advance(Duration.zero);
    final result = await handle.done;
    expect(result.end, LedgerPollEnd.expired);
    expect(result.task, isNull);
    expect(result.projection?.code, LedgerTaskProgressCode.expired);
    expect(result.error?.code, 'not_found');
    expect(rig.times, [0]);
    expect(rig.adapter.requests.every((r) => r.method == 'GET'), isTrue);
  });

  test(
    '413 request_too_large is retryable (backoff then exhausts, no replay)',
    () async {
      final rig = Rig(
        (_) => jsonResponse({'error': 'request_too_large'}, status: 413),
        maxAttempts: 5,
      );
      final handle = rig.poller.watch(const LedgerLookup.byMessageId('msg'));
      rig.poller.setForeground(true);
      await rig.clock.advance(const Duration(seconds: 20));
      expect(rig.times, [0, 1, 3, 6, 9]);
      final result = await handle.done;
      expect(result.end, LedgerPollEnd.exhausted);
      expect(result.error?.code, 'request_too_large');
    },
  );

  test(
    'Retry-After survives pause and is not capped below server delay',
    () async {
      final rig = Rig(
        (_) => jsonResponse(
          {'error': 'rate_limited'},
          status: 429,
          retryAfter: '10',
        ),
      );
      final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
      rig.poller.setForeground(true);
      await rig.clock.advance(Duration.zero);
      rig.poller.setForeground(false);
      await rig.clock.advance(const Duration(seconds: 4));
      rig.poller.setForeground(true);
      await rig.clock.advance(const Duration(seconds: 5));
      expect(rig.times, [0]);
      await rig.clock.advance(const Duration(seconds: 1));
      expect(rig.times, [0, 10]);
      handle.cancel();
      expect((await handle.done).end, LedgerPollEnd.cancelled);
    },
  );

  test('deadline bounds Retry-After and an unresolved request', () async {
    for (final hanging in [false, true]) {
      final response = Completer<ResponseBody>();
      final rig = Rig(
        (_) => hanging
            ? response.future
            : jsonResponse({'error': 'busy'}, status: 503, retryAfter: '9999'),
      );
      final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
      rig.poller.setForeground(true);
      await rig.clock.advance(const Duration(seconds: 30));
      expect((await handle.done).end, LedgerPollEnd.exhausted);
      expect(rig.times, [0]);
      if (hanging) {
        response.complete(jsonResponse(taskJson(status: 'succeeded')));
      }
    }
  });

  test(
    'terminal, stuck, review and unknown statuses stop polling honestly',
    () async {
      for (final status in [
        'succeeded',
        'failed',
        'cancelled',
        'stuck',
        'awaiting_review',
        'future',
      ]) {
        final rig = Rig((_) => jsonResponse(taskJson(status: status)));
        final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
        rig.poller.setForeground(true);
        await rig.clock.advance(const Duration(seconds: 30));
        expect((await handle.done).end, LedgerPollEnd.observed);
        expect(rig.times, [0]);
      }
    },
  );

  test('permanent HTTP errors stop; raw server errors never escape', () async {
    for (final status in [301, 400, 401, 403, 409]) {
      final rig = Rig(
        (_) => jsonResponse({'error': 'private-token'}, status: status),
      );
      final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
      rig.poller.setForeground(true);
      await rig.clock.advance(const Duration(seconds: 30));
      final result = await handle.done;
      expect(result.end, LedgerPollEnd.error);
      expect(result.error.toString(), isNot(contains('private-token')));
      expect(result.error?.statusCode, status);
      expect(rig.times, [0]);
    }
  });

  test('scope validation rejects credentials before any request', () async {
    final rig = Rig((_) => jsonResponse(taskJson()));
    rig.auth = const AuthCredentials(
      apiKey: 'other-key',
      ownerId: 'other',
      backendOrigin: 'https://gw.test',
    );
    final handle = rig.poller.watch(const LedgerLookup.byTaskId('task'));
    rig.poller.setForeground(true);
    await rig.clock.advance(Duration.zero);
    expect((await handle.done).end, LedgerPollEnd.error);
    expect(rig.adapter.requests, isEmpty);
  });

  test(
    'invalidation and disposal suppress delayed credentials and responses',
    () async {
      for (final action in ['key', 'scope', 'dispose', 'pause', 'replace']) {
        final response = Completer<ResponseBody>();
        final rig = Rig((_) => response.future);
        final updates = <LedgerTask>[];
        const lookup = LedgerLookup.byTaskId('task');
        final handle = rig.poller.watch(lookup, onUpdate: updates.add);
        rig.poller.setForeground(true);
        await rig.clock.advance(Duration.zero);
        switch (action) {
          case 'key':
            rig.poller.invalidateKey(lookup);
          case 'scope':
            rig.poller.invalidateScope();
          case 'dispose':
            rig.poller.dispose();
          case 'pause':
            rig.poller.setForeground(false);
          case 'replace':
            rig.poller.watch(lookup);
        }
        response.complete(jsonResponse(taskJson(status: 'succeeded')));
        await flush();
        expect(updates, isEmpty);
        expect(handle.isCurrent, isFalse);
        if (action != 'pause') {
          expect((await handle.done).end, LedgerPollEnd.cancelled);
        }
      }
      final gate = Completer<AuthCredentials?>();
      final rig = Rig(
        (_) => jsonResponse(taskJson()),
        resolver: () => gate.future,
      );
      rig.poller.watch(const LedgerLookup.byTaskId('task'));
      rig.poller.setForeground(true);
      await rig.clock.advance(Duration.zero);
      rig.poller.invalidateScope();
      gate.complete(credentials);
      await flush();
      expect(rig.adapter.requests, isEmpty);
    },
  );

  test('repeated dispose and a late response remain safe', () async {
    final response = Completer<ResponseBody>();
    final rig = Rig((_) => response.future);
    final updates = <LedgerTask>[];
    final handle = rig.poller.watch(
      const LedgerLookup.byTaskId('task'),
      onUpdate: updates.add,
    );
    rig.poller.setForeground(true);
    await rig.clock.advance(Duration.zero);
    expect(rig.adapter.requests, hasLength(1));

    rig.poller.dispose();
    rig.poller.dispose();

    expect((await handle.done).end, LedgerPollEnd.cancelled);
    response.complete(jsonResponse(taskJson(status: 'succeeded')));
    await flush();
    await rig.clock.advance(const Duration(seconds: 30));
    expect(updates, isEmpty);
    expect(rig.adapter.requests, hasLength(1));
  });

  test(
    'key invalidation leaves other lookups and other scopes alone',
    () async {
      final rig = Rig(
        (r) => jsonResponse(taskJson(messageId: r.uri.pathSegments.last)),
      );
      final other = Rig((_) => jsonResponse(taskJson()));
      rig.poller.setForeground(true);
      other.poller.setForeground(true);
      final first = rig.poller.watch(const LedgerLookup.byMessageId('first'));
      rig.poller.watch(const LedgerLookup.byMessageId('second'));
      other.poller.watch(const LedgerLookup.byMessageId('msg'));
      rig.poller.invalidateKey(first.lookup);
      await rig.clock.advance(Duration.zero);
      await other.clock.advance(Duration.zero);
      expect(rig.adapter.requests.single.uri.path, endsWith('/second'));
      expect(other.adapter.requests, hasLength(1));
    },
  );

  test('unknown managed send polls, then reconciles checkpoint without another send', () async {
    final db = AppDatabase(NativeDatabase.memory());
    addTearDown(db.close);
    final repo = ManagedConversationRepository(db);
    var sends = 0;
    var historyReads = 0;
    final adapter = FakeAdapter((request) {
      if (request.method == 'POST') {
        sends++;
        throw DioException(
          requestOptions: request,
          type: DioExceptionType.connectionError,
        );
      }
      historyReads++;
      return jsonResponse({
        'sessionId': request.uri.pathSegments.last,
        'messages': [
          {'role': 'user', 'content': 'hi'},
          {'role': 'assistant', 'content': 'checkpoint answer'},
        ],
      });
    });
    final dio = Dio()..httpClientAdapter = adapter;
    addTearDown(dio.close);
    final service = ManagedConversationService(
      client: LangChainClient(dio: dio, baseUrl: credentials.backendOrigin!),
      repo: repo,
      scope: credentials.accountScope!,
      credentials: () async => const ManagedCredentials(gatewayKey: 'test-key'),
    );
    await expectLater(
      service.sendTurn('conversation', history: [], userText: 'hi'),
      throwsA(isA<PluginClientException>()),
    );
    final pending = (await repo.pending(
      credentials.accountScope!,
      'conversation',
    ))!;
    var polls = 0;
    final rig = Rig(
      (_) => jsonResponse(
        taskJson(
          messageId: pending.messageId,
          status: ++polls == 1 ? 'running' : 'succeeded',
        ),
      ),
    );
    final handle = rig.poller.watch(
      LedgerLookup.byMessageId(pending.messageId),
    );
    rig.poller.setForeground(true);
    await rig.clock.advance(const Duration(seconds: 1));
    final result = await handle.done;
    expect(result.task?.status, LedgerTaskStatus.succeeded);
    expect(handle.isCurrent, isTrue);
    final history = await service.reconcileFromServer('conversation');
    expect(history.last.content, 'checkpoint answer');
    expect(
      await repo.pending(credentials.accountScope!, 'conversation'),
      isNull,
    );
    expect(sends, 1);
    expect(historyReads, 1);
    expect(rig.adapter.requests.every((r) => r.method == 'GET'), isTrue);
    rig.poller.invalidateScope();
    expect(handle.isCurrent, isFalse);
  });
  test(
    'foreground gate pauses requests and resumes the same status lookup',
    () async {
      final adapter = FakeAdapter((_) => jsonResponse(taskJson()));
      final dio = Dio()..httpClientAdapter = adapter;
      final scheduler = FakeScheduler();
      final poller = LedgerPoller(
        client: LedgerClient(dio: dio, scope: credentials.accountScope!),
        credentials: () async => credentials,
        scheduler: scheduler,
      );
      addTearDown(poller.dispose);
      addTearDown(dio.close);
      poller.watch(const LedgerLookup.byMessageId('msg'));
      await scheduler.advance(const Duration(seconds: 3));
      expect(adapter.requests, isEmpty);
      poller.setForeground(true);
      await scheduler.advance(Duration.zero);
      expect(adapter.requests, hasLength(1));
      poller.setForeground(false);
      await scheduler.advance(const Duration(seconds: 10));
      expect(adapter.requests, hasLength(1));
      poller.setForeground(true);
      await scheduler.advance(Duration.zero);
      expect(adapter.requests, hasLength(2));
      expect(adapter.requests.every((r) => r.method == 'GET'), isTrue);
    },
  );
}
