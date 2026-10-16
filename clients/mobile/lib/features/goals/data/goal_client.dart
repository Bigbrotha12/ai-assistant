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
      final nextOffset = int.tryParse(
        response.headers.value('x-ledger-next-offset') ?? '',
      );
      return GoalListPage.fromJson(
        await _http.readJson(response.data),
        nextOffset: nextOffset,
      );
    });
  }

  /// `POST /v1/goals/:id/cancel` — cancel a live goal. The body carries nothing
  /// (`WIRE_SPEC §12`: the id is in the path).
  ///
  /// A terminal goal is refused with `409 goal_not_cancellable`; the refusal
  /// arrives as the typed [PluginClientException] from the shared envelope
  /// mapping.
  Future<GoalCancelResult> cancel(
    String goalId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) {
    if (goalId.trim().isEmpty) {
      throw const PluginClientException('invalid_request');
    }
    return _http.run(cancelToken, (token) async {
      final response = await _http.send(
        path: '/goals/${Uri.encodeComponent(goalId)}/cancel',
        gatewayKey: gatewayKey,
        cancelToken: token,
        method: 'POST',
      );
      return GoalCancelResult.fromJson(await _http.readJson(response.data));
    });
  }

  /// `DELETE /v1/goals/:id` — delete a terminal goal. The server answers `204`
  /// with an empty body, so this never parses a payload.
  ///
  /// A non-terminal goal is refused with `409 goal_not_deletable` (cancel it
  /// first).
  Future<void> delete(
    String goalId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) {
    if (goalId.trim().isEmpty) {
      throw const PluginClientException('invalid_request');
    }
    return _http.run(cancelToken, (token) async {
      await _http.send(
        path: '/goals/${Uri.encodeComponent(goalId)}',
        gatewayKey: gatewayKey,
        cancelToken: token,
        method: 'DELETE',
      );
    });
  }

  /// `POST /v1/goals/:id/resume` — re-credential a paused goal, optionally
  /// carrying the user's answer, a raised token budget, and their resolutions
  /// for the goal's unresolved mutations (`WIRE_SPEC §12`).
  ///
  /// The body carries ONLY the fields the caller supplied: [answer] is omitted
  /// when null/blank, [resolveMutations] when null/empty, [tokenBudget] when
  /// null. [credentials] is the goal's OWN pinned model entry — §12's shape is
  /// `{<modelPluginId>: {…}}`, so the caller supplies exactly one entry and the
  /// action layer computes it from the goal's `modelPluginId`.
  ///
  /// Client-side validation mirrors the server's: a positive [tokenBudget] when
  /// present, and each resolution's `tool`/`argsHash` non-empty with a
  /// `resolution` in [GoalMutationResolutionInput.allowedResolutions]. Anything
  /// else is refused here as `invalid_request` rather than sent.
  Future<GoalResumed> resume(
    String goalId, {
    required String gatewayKey,
    String? answer,
    required Map<String, Map<String, String>> credentials,
    List<GoalMutationResolutionInput>? resolveMutations,
    int? tokenBudget,
    CancelToken? cancelToken,
  }) {
    if (goalId.trim().isEmpty || credentials.isEmpty) {
      throw const PluginClientException('invalid_request');
    }
    if (tokenBudget != null && tokenBudget <= 0) {
      throw const PluginClientException('invalid_request');
    }
    final resolutions = resolveMutations;
    if (resolutions != null) {
      for (final entry in resolutions) {
        if (entry.tool.trim().isEmpty ||
            entry.argsHash.trim().isEmpty ||
            !GoalMutationResolutionInput.allowedResolutions.contains(
              entry.resolution,
            )) {
          throw const PluginClientException('invalid_request');
        }
      }
    }
    final text = answer?.trim();
    final body = <String, dynamic>{
      'credentials': credentials,
      if (text != null && text.isNotEmpty) 'answer': text,
      if (resolutions != null && resolutions.isNotEmpty)
        'resolveMutations': [for (final entry in resolutions) entry.toJson()],
    };
    if (tokenBudget != null) body['tokenBudget'] = tokenBudget;
    return _http.run(cancelToken, (token) async {
      final response = await _http.send(
        path: '/goals/${Uri.encodeComponent(goalId)}/resume',
        gatewayKey: gatewayKey,
        cancelToken: token,
        body: body,
      );
      return GoalResumed.fromJson(await _http.readJson(response.data));
    });
  }
}
