import 'package:dio/dio.dart';

import 'package:ai_assistant/features/plugins/data/plugin_http.dart';

import 'goal_dto.dart';

/// The goal REST surface of `WIRE_SPEC §12`, reached through [PluginHttp] so
/// the goal error codes land in `safePluginErrorCode`'s allowlist and map to
/// their own copy in `statusPhraseForError` (Phase 3.6's registration — this
/// client is the reachable path that justified it).
///
/// Request validation is deliberately thin: the gateway owns the contract
/// (§12 lists each endpoint's errors), so the client only rejects input it
/// knows cannot produce a valid request, and every refusal arrives as a typed
/// [PluginClientException] from the shared envelope mapping.
class GoalClient {
  GoalClient({
    required Dio dio,
    required String baseUrl,
    Duration timeout = const Duration(seconds: 20),
  }) : _http = PluginHttp(dio: dio, baseUrl: baseUrl, timeout: timeout);

  final PluginHttp _http;

  /// `POST /v1/goals` — admit a goal (or re-get the existing one for the same
  /// `clientGoalId`, the server's idempotent get-or-create).
  ///
  /// [modelCredentials] carries ONLY the pinned model's own credential fields;
  /// §12's shape is `credentials: {<modelPluginId>: {…}}` and the gateway
  /// resolves/validates them against that plugin's spec.
  Future<GoalSubmitted> submit({
    required String gatewayKey,
    required String instruction,
    required String agent,
    required String modelPluginId,
    required int tokenBudget,
    required String clientGoalId,
    required Map<String, String> modelCredentials,
    CancelToken? cancelToken,
  }) {
    if (instruction.trim().isEmpty || tokenBudget <= 0) {
      throw const PluginClientException('invalid_request');
    }
    return _http.run(cancelToken, (token) async {
      final response = await _http.send(
        path: '/goals',
        gatewayKey: gatewayKey,
        cancelToken: token,
        body: <String, dynamic>{
          'instruction': instruction,
          'agent': agent,
          'modelPluginId': modelPluginId,
          'tokenBudget': tokenBudget,
          'clientGoalId': clientGoalId,
          'credentials': <String, Map<String, String>>{
            modelPluginId: modelCredentials,
          },
        },
      );
      return GoalSubmitted.fromJson(await _http.readJson(response.data));
    });
  }

  /// `GET /v1/goals/:id` — the detail the todo view renders (and re-renders,
  /// live, while the goal runs).
  Future<GoalDetail> fetch(
    String goalId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) {
    if (goalId.trim().isEmpty) {
      throw const PluginClientException('invalid_request');
    }
    return _http.run(cancelToken, (token) async {
      final response = await _http.send(
        path: '/goals/${Uri.encodeComponent(goalId)}',
        gatewayKey: gatewayKey,
        cancelToken: token,
      );
      return GoalDetail.fromJson(await _http.readJson(response.data));
    });
  }

  /// `GET /v1/goals?limit=&offset=` — the owner's goals, newest-first, with
  /// the ledger's `x-ledger-next-offset` header as the "older goals exist"
  /// signal (WIRE_SPEC §12: pagination rides in headers, never the body).
  ///
  /// [goalLimit] is capped by the server at 100 (`PUBLIC_TASK_PAGE_MAX_LIMIT`),
  /// so a caller asking for more gets 400 `invalid_request`.
  Future<GoalListPage> list({
    required String gatewayKey,
    int goalLimit = 100,
    int offset = 0,
    CancelToken? cancelToken,
  }) {
    if (goalLimit < 1 || offset < 0) {
      throw const PluginClientException('invalid_request');
    }
    return _http.run(cancelToken, (token) async {
      final response = await _http.send(
        path: '/goals?limit=$goalLimit&offset=$offset',
        gatewayKey: gatewayKey,
        cancelToken: token,
      );
      final nextOffset =
          int.tryParse(response.headers.value('x-ledger-next-offset') ?? '');
      return GoalListPage.fromJson(
        await _http.readJson(response.data),
        nextOffset: nextOffset,
      );
    });
  }
}
