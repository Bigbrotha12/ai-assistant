import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:ai_assistant/features/goals/data/goal_client.dart';
import 'package:ai_assistant/features/goals/data/goal_dto.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 3.7 client half: the goal wire contract of `WIRE_SPEC §12` — the
/// request the trigger builds, the detail the todo view parses, and the goal
/// error codes arriving through the REAL envelope path (the reachable client
/// path Phase 3.6's forward-registration was waiting for).

ResponseBody jsonResponse(
  Object? value, {
  int status = 200,
  String? nextOffset,
}) => ResponseBody.fromString(
  jsonEncode(value),
  status,
  headers: {
    'content-type': ['application/json'],
    if (nextOffset != null) 'x-ledger-next-offset': [nextOffset],
  },
);

class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.respond);

  final FutureOr<ResponseBody> Function(RequestOptions options) respond;
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

Map<String, Object?> submittedJson() => {
  'goalId': 'g_550e8400-e29b-41d4-a716-446655440000',
  'status': 'queued',
  'todos': <Object?>[],
  'createdAt': '2026-10-04T00:00:00.000Z',
};

Map<String, Object?> summaryJson({
  String goalId = 'g_1',
  String status = 'running',
  String instruction = 'do the thing',
  String? pauseQuestion,
  String? failureReason,
  String updatedAt = '2026-10-04T00:01:00.000Z',
  String? modelPluginId = 'openrouter',
}) => {
  'goalId': goalId,
  'status': status,
  'modelPluginId': modelPluginId,
  'instruction': instruction,
  'pauseReason': pauseQuestion == null ? null : 'needs_user_input',
  'pauseQuestion': pauseQuestion,
  'resultSummary': null,
  'failureReason': failureReason,
  'tokenBudget': 200000,
  'tokensSpent': 41230,
  'canCancel': true,
  'canResume': status == 'paused',
  'terminal': const ['complete', 'failed', 'cancelled'].contains(status),
  'createdAt': '2026-10-04T00:00:00.000Z',
  'updatedAt': updatedAt,
};

Map<String, Object?> detailJson({
  String goalId = 'g_550e8400-e29b-41d4-a716-446655440000',
  String status = 'running',
  Object? todos = const ['buy salmon', 'chop onions'],
  String? pauseReason,
  String? pauseQuestion,
  String? modelPluginId = 'openrouter',
}) => {
  'goalId': goalId,
  'status': status,
  'modelPluginId': modelPluginId,
  'pauseReason': pauseReason,
  'pauseQuestion': pauseQuestion,
  'resultSummary': null,
  'failureReason': null,
  'instruction': "plan tomorrow's meals",
  'todos': todos,
  'tokenBudget': 200000,
  'tokensSpent': 41230,
  'effectState': 'none_known',
  'canCancel': true,
  'canResume': status == 'paused',
  'terminal': const ['complete', 'failed', 'cancelled'].contains(status),
  'unresolvedMutations': [
    {'tool': 'create_mealplan', 'argsHash': 'abc123'},
  ],
  'steps': [
    {'seq': 1, 'kind': 'model', 'status': 'terminal', 'tokens': 123},
  ],
  'updatedAt': '2026-10-04T00:01:00.000Z',
};

void main() {
  late FakeAdapter adapter;
  late GoalClient client;

  setUp(() {
    adapter = FakeAdapter((_) => jsonResponse(submittedJson()));
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );
  });

  test(
    'POST /v1/goals sends the §12 body with the pinned model credentials',
    () async {
      final submitted = await client.submit(
        gatewayKey: 'test-key',
        instruction: "plan tomorrow's meals",
        agent: 'mealie-agent',
        modelPluginId: 'openrouter',
        tokenBudget: 200000,
        clientGoalId: '7f5f9f22-1c1e-4a4a-9a9a-1a2b3c4d5e6f',
        modelCredentials: {'apiKey': 'sk-stored'},
      );

      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.uri.toString(), 'https://gw.test/v1/goals');
      expect(request.headers['Authorization'], 'Bearer test-key');

      final body = request.data as Map<String, dynamic>;
      expect(body, {
        'instruction': "plan tomorrow's meals",
        'agent': 'mealie-agent',
        'modelPluginId': 'openrouter',
        'tokenBudget': 200000,
        'clientGoalId': '7f5f9f22-1c1e-4a4a-9a9a-1a2b3c4d5e6f',
        'credentials': {
          'openrouter': {'apiKey': 'sk-stored'},
        },
      });

      expect(submitted.goalId, 'g_550e8400-e29b-41d4-a716-446655440000');
      expect(submitted.status, 'queued');
      expect(submitted.todos, isEmpty);
      expect(submitted.createdAt, '2026-10-04T00:00:00.000Z');
    },
  );

  test(
    'an instruction that cannot produce a request is refused client-side',
    () async {
      await expectLater(
        () => client.submit(
          gatewayKey: 'test-key',
          instruction: '   ',
          agent: 'mealie-agent',
          modelPluginId: 'openrouter',
          tokenBudget: 200000,
          clientGoalId: 'id',
          modelCredentials: const {},
        ),
        throwsA(
          isA<PluginClientException>().having(
            (e) => e.code,
            'code',
            'invalid_request',
          ),
        ),
      );
      expect(
        adapter.requests,
        isEmpty,
        reason: 'no wire call for an empty instruction',
      );
    },
  );

  test('GET /v1/goals/:id parses the §12 detail', () async {
    adapter = FakeAdapter((_) => jsonResponse(detailJson()));
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    final detail = await client.fetch(
      'g_550e8400-e29b-41d4-a716-446655440000',
      gatewayKey: 'test-key',
    );

    expect(
      adapter.requests.single.uri.toString(),
      'https://gw.test/v1/goals/g_550e8400-e29b-41d4-a716-446655440000',
    );
    expect(detail.goalId, 'g_550e8400-e29b-41d4-a716-446655440000');
    expect(detail.status, 'running');
    expect(detail.instruction, "plan tomorrow's meals");
    expect(detail.todos, ['buy salmon', 'chop onions']);
    expect(detail.tokenBudget, 200000);
    expect(detail.tokensSpent, 41230);
    expect(detail.canCancel, isTrue);
    expect(detail.canResume, isFalse);
    expect(detail.terminal, isFalse);
    expect(detail.pauseReason, isNull);
    expect(detail.steps.single.seq, 1);
    expect(detail.unresolvedMutations.single.tool, 'create_mealplan');
    expect(detail.unresolvedMutations.single.argsHash, 'abc123');
  });

  test(
    'a malformed todos column degrades to an empty plan, never a crash',
    () async {
      adapter = FakeAdapter(
        (_) => jsonResponse(detailJson(todos: ['keep', 7, null, 'me'])),
      );
      client = GoalClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gw.test/v1',
      );

      final detail = await client.fetch('g_1', gatewayKey: 'test-key');
      expect(detail.todos, ['keep', 'me']);
    },
  );

  test('a goal refusal arrives as its own allowlisted code', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'error': 'goal_not_deletable'}, status: 409),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    await expectLater(
      () => client.fetch('g_1', gatewayKey: 'test-key'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'goal_not_deletable')
            .having((e) => e.statusCode, 'statusCode', 409),
      ),
    );

    adapter = FakeAdapter(
      (_) => jsonResponse({'error': 'not_found'}, status: 404),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );
    await expectLater(
      () => client.fetch('g_2', gatewayKey: 'test-key'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'not_found')
            .having((e) => e.statusCode, 'statusCode', 404),
      ),
    );
  });

  test('GET /v1/goals pages with the ledger header convention', () async {
    adapter = FakeAdapter((options) {
      final offset = int.parse(options.uri.queryParameters['offset'] ?? '0');
      return jsonResponse({
        'goals': offset == 0
            ? [
                summaryJson(goalId: 'g_2', instruction: 'newest first'),
                summaryJson(
                  goalId: 'g_1',
                  status: 'paused',
                  instruction: 'answer me',
                  pauseQuestion: 'which flight?',
                ),
              ]
            : [summaryJson(goalId: 'g_0', instruction: 'oldest')],
      }, nextOffset: offset == 0 ? '100' : null);
    });
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    final page = await client.list(gatewayKey: 'test-key');

    expect(
      adapter.requests.single.uri.toString(),
      'https://gw.test/v1/goals?limit=100&offset=0',
    );
    expect(page.goals.map((g) => g.goalId), ['g_2', 'g_1']);
    expect(page.goals.first.instruction, 'newest first');
    expect(page.goals.last.pauseQuestion, 'which flight?');
    expect(page.goals.last.canResume, isTrue);
    expect(page.nextOffset, 100, reason: 'older goals exist beyond this page');

    final last = await client.list(gatewayKey: 'test-key', offset: 100);
    expect(
      adapter.requests.last.uri.toString(),
      'https://gw.test/v1/goals?limit=100&offset=100',
    );
    expect(last.goals.single.instruction, 'oldest');
    expect(last.nextOffset, isNull, reason: 'no header means this is the end');
  });

  test('a malformed list row is skipped, not fatal', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({
        'goals': [
          {'status': 'running'}, // no goalId — dropped
          summaryJson(goalId: 'g_ok'),
        ],
      }),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    final page = await client.list(gatewayKey: 'test-key');
    expect(page.goals.map((g) => g.goalId), ['g_ok']);
    expect(page.nextOffset, isNull);
  });

  test('detail and summary parse modelPluginId, null when absent', () {
    expect(
      GoalDetail.fromJson(detailJson(modelPluginId: 'anthropic')).modelPluginId,
      'anthropic',
    );
    expect(
      GoalDetail.fromJson(detailJson()..remove('modelPluginId')).modelPluginId,
      isNull,
      reason: 'an older gateway omits the field',
    );
    expect(
      GoalSummary.fromJson(summaryJson(modelPluginId: 'bedrock')).modelPluginId,
      'bedrock',
    );
    expect(
      GoalSummary.fromJson(summaryJson()..remove('modelPluginId'))
          .modelPluginId,
      isNull,
    );
  });

  test('POST /v1/goals/:id/cancel returns the §12 cancel shape', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({
        'goalId': 'g_1',
        'status': 'cancelled',
        'previousStatus': 'running',
        'effectState': 'completed_steps_only',
      }),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    final result = await client.cancel('g_1', gatewayKey: 'test-key');

    final request = adapter.requests.single;
    expect(request.method, 'POST');
    expect(request.uri.toString(), 'https://gw.test/v1/goals/g_1/cancel');
    expect(result.goalId, 'g_1');
    expect(result.status, 'cancelled');
    expect(result.previousStatus, 'running');
    expect(result.effectState, 'completed_steps_only');
  });

  test('cancel parses a sparse result defensively', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'goalId': 'g_1', 'status': 'cancelled'}),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    final result = await client.cancel('g_1', gatewayKey: 'test-key');
    expect(result.previousStatus, isNull);
    expect(result.effectState, isNull);
  });

  test('a cancel refusal surfaces as goal_not_cancellable', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'error': 'goal_not_cancellable'}, status: 409),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    await expectLater(
      () => client.cancel('g_1', gatewayKey: 'test-key'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'goal_not_cancellable')
            .having((e) => e.statusCode, 'statusCode', 409),
      ),
    );
  });

  test('DELETE /v1/goals/:id accepts an empty 204', () async {
    adapter = FakeAdapter((_) => ResponseBody.fromString('', 204));
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    await client.delete('g_1', gatewayKey: 'test-key');

    final request = adapter.requests.single;
    expect(request.method, 'DELETE');
    expect(request.uri.toString(), 'https://gw.test/v1/goals/g_1');
  });

  test('a delete refusal surfaces as goal_not_deletable', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'error': 'goal_not_deletable'}, status: 409),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    await expectLater(
      () => client.delete('g_1', gatewayKey: 'test-key'),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'goal_not_deletable')
            .having((e) => e.statusCode, 'statusCode', 409),
      ),
    );
  });

  test('POST /v1/goals/:id/resume sends the §12 body', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'goalId': 'g_1', 'status': 'queued'}),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    final resumed = await client.resume(
      'g_1',
      gatewayKey: 'test-key',
      answer: 'no shellfish, skip dessert',
      credentials: {
        'openrouter': {'apiKey': 'sk-stored'},
      },
      resolveMutations: const [
        GoalMutationResolutionInput(
          tool: 'create_mealplan',
          argsHash: 'abc123',
          resolution: 'not_applied',
        ),
      ],
      tokenBudget: 400000,
    );

    final request = adapter.requests.single;
    expect(request.method, 'POST');
    expect(request.uri.toString(), 'https://gw.test/v1/goals/g_1/resume');
    expect(request.data, {
      'credentials': {
        'openrouter': {'apiKey': 'sk-stored'},
      },
      'answer': 'no shellfish, skip dessert',
      'resolveMutations': [
        {
          'tool': 'create_mealplan',
          'argsHash': 'abc123',
          'resolution': 'not_applied',
        },
      ],
      'tokenBudget': 400000,
    });
    expect(resumed.goalId, 'g_1');
    expect(resumed.status, 'queued');
  });

  test(
    'resume omits answer, resolveMutations, and tokenBudget when absent',
    () async {
      adapter = FakeAdapter(
        (_) => jsonResponse({'goalId': 'g_1', 'status': 'queued'}),
      );
      client = GoalClient(
        dio: Dio()..httpClientAdapter = adapter,
        baseUrl: 'https://gw.test/v1',
      );

      await client.resume(
        'g_1',
        gatewayKey: 'test-key',
        answer: '   ', // blank -> omitted, exactly like absent
        credentials: {
          'openrouter': {'apiKey': 'sk-stored'},
        },
      );

      expect(adapter.requests.single.data, {
        'credentials': {
          'openrouter': {'apiKey': 'sk-stored'},
        },
      });
    },
  );

  test('resume refuses input that cannot produce a valid request', () async {
    Future<void> expectRefused(Future<void> Function() call) => expectLater(
      call,
      throwsA(
        isA<PluginClientException>().having(
          (e) => e.code,
          'code',
          'invalid_request',
        ),
      ),
    );

    await expectRefused(
      () => client.resume(
        '   ',
        gatewayKey: 'test-key',
        credentials: {
          'openrouter': {'apiKey': 'sk'},
        },
      ),
    );
    await expectRefused(
      () => client.resume('g_1', gatewayKey: 'test-key', credentials: const {}),
    );
    await expectRefused(
      () => client.resume(
        'g_1',
        gatewayKey: 'test-key',
        credentials: {
          'openrouter': {'apiKey': 'sk'},
        },
        tokenBudget: 0,
      ),
    );
    await expectRefused(
      () => client.resume(
        'g_1',
        gatewayKey: 'test-key',
        credentials: {
          'openrouter': {'apiKey': 'sk'},
        },
        resolveMutations: const [
          GoalMutationResolutionInput(
            tool: '  ',
            argsHash: 'abc',
            resolution: 'applied',
          ),
        ],
      ),
    );
    await expectRefused(
      () => client.resume(
        'g_1',
        gatewayKey: 'test-key',
        credentials: {
          'openrouter': {'apiKey': 'sk'},
        },
        resolveMutations: const [
          GoalMutationResolutionInput(
            tool: 'create_mealplan',
            argsHash: ' ',
            resolution: 'applied',
          ),
        ],
      ),
    );
    await expectRefused(
      () => client.resume(
        'g_1',
        gatewayKey: 'test-key',
        credentials: {
          'openrouter': {'apiKey': 'sk'},
        },
        resolveMutations: const [
          GoalMutationResolutionInput(
            tool: 'create_mealplan',
            argsHash: 'abc',
            resolution: 'maybe',
          ),
        ],
      ),
    );

    expect(adapter.requests, isEmpty, reason: 'no wire call for bad input');
  });

  test('a resume refusal surfaces as goal_not_resumable', () async {
    adapter = FakeAdapter(
      (_) => jsonResponse({'error': 'goal_not_resumable'}, status: 409),
    );
    client = GoalClient(
      dio: Dio()..httpClientAdapter = adapter,
      baseUrl: 'https://gw.test/v1',
    );

    await expectLater(
      () => client.resume(
        'g_1',
        gatewayKey: 'test-key',
        credentials: {
          'openrouter': {'apiKey': 'sk'},
        },
      ),
      throwsA(
        isA<PluginClientException>()
            .having((e) => e.code, 'code', 'goal_not_resumable')
            .having((e) => e.statusCode, 'statusCode', 409),
      ),
    );
  });
}
