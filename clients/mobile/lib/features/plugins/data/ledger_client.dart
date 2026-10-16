import 'dart:async';

import 'package:dio/dio.dart';

import '../../auth/data/auth_credentials_store.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';

/// Terminal statuses a background submission can echo (matches the server's
/// `TERMINAL_TASK_STATUSES` in `server/src/ledger/index.ts`). `awaiting_review` IS
/// terminal on the job wire — a re-submitted job in review cannot accept the
/// submission — but NOT terminal for client reconciliation
/// ([LedgerTaskStatus.isTerminal] excludes it so a review task keeps its
/// pending marker for an explicit retry).
const terminalTaskStatuses = <String>{
  'succeeded',
  'failed',
  'cancelled',
  'awaiting_review',
};

enum LedgerTaskStatus {
  queued,
  running,
  stuck,
  succeeded,
  failed,
  cancelled,
  awaitingReview,
  unknown;

  /// Terminal for client reconciliation: the job's outcome is final and the
  /// service clears the pending marker (reads the reply back on `succeeded`).
  /// `awaiting_review` is deliberately excluded — see [terminalTaskStatuses].
  bool get isTerminal =>
      this == succeeded || this == failed || this == cancelled;

  bool get shouldPoll => this == queued || this == running;
}

const taskProjectionSchemaVersion = 1;
const taskCancelSchemaVersion = 1;

enum LedgerTaskProgressCode {
  queued,
  runningModel,
  runningTool,
  review,
  done,
  expired,
}

enum LedgerTaskEffectState { noneKnown, completedStepsOnly, unknown }

enum LedgerTaskCancelStage {
  cancelling,
  cancelled,
  alreadyTerminal,
  notCancellable,
}

enum LedgerTaskCancelReachedStage {
  queued,
  admitted,
  running,
  alreadyTerminal,
  stuck,
}

LedgerTaskProgressCode _progressCode(Object? value) => switch (value) {
  'queued' => LedgerTaskProgressCode.queued,
  'running_model' => LedgerTaskProgressCode.runningModel,
  'running_tool' => LedgerTaskProgressCode.runningTool,
  'review' => LedgerTaskProgressCode.review,
  'done' => LedgerTaskProgressCode.done,
  'expired' => LedgerTaskProgressCode.expired,
  _ => throw const PluginProtocolException(),
};

LedgerTaskEffectState _effectState(Object? value) => switch (value) {
  'none_known' => LedgerTaskEffectState.noneKnown,
  'completed_steps_only' => LedgerTaskEffectState.completedStepsOnly,
  'unknown' => LedgerTaskEffectState.unknown,
  _ => throw const PluginProtocolException(),
};

LedgerTaskCancelStage _cancelStage(Object? value) => switch (value) {
  'cancelling' => LedgerTaskCancelStage.cancelling,
  'cancelled' => LedgerTaskCancelStage.cancelled,
  'already-terminal' => LedgerTaskCancelStage.alreadyTerminal,
  'not-cancellable' => LedgerTaskCancelStage.notCancellable,
  _ => throw const PluginProtocolException(),
};

LedgerTaskCancelReachedStage _cancelReachedStage(Object? value) =>
    switch (value) {
      'queued' => LedgerTaskCancelReachedStage.queued,
      'admitted' => LedgerTaskCancelReachedStage.admitted,
      'running' => LedgerTaskCancelReachedStage.running,
      'already-terminal' => LedgerTaskCancelReachedStage.alreadyTerminal,
      'stuck' => LedgerTaskCancelReachedStage.stuck,
      _ => throw const PluginProtocolException(),
    };

LedgerTaskStatus _taskStatus(Object? value) => switch (value) {
  'queued' => LedgerTaskStatus.queued,
  'running' => LedgerTaskStatus.running,
  'stuck' => LedgerTaskStatus.stuck,
  'succeeded' => LedgerTaskStatus.succeeded,
  'failed' => LedgerTaskStatus.failed,
  'cancelled' => LedgerTaskStatus.cancelled,
  'awaiting_review' => LedgerTaskStatus.awaitingReview,
  _ => LedgerTaskStatus.unknown,
};

LedgerTaskStatus? _optionalTerminalStatus(Object? value) {
  if (value == null) return null;
  if (value is! String || !terminalTaskStatuses.contains(value)) {
    throw const PluginProtocolException();
  }
  return _taskStatus(value);
}

class LedgerTaskProjection {
  const LedgerTaskProjection({
    required this.code,
    required this.canCancel,
    required this.canRetry,
    required this.effectState,
    this.cancellationPending = false,
    this.lastActionId,
    this.terminalStatus,
    this.errorCode,
  });

  factory LedgerTaskProjection.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    if (json['schemaVersion'] != taskProjectionSchemaVersion) {
      throw const PluginProtocolException();
    }
    final rawLastActionId = json['lastActionId'];
    final rawErrorCode = json['errorCode'];
    if (rawLastActionId != null && rawLastActionId is! String) {
      throw const PluginProtocolException();
    }
    if (rawErrorCode != null && rawErrorCode is! String) {
      throw const PluginProtocolException();
    }
    final rawCancellationPending = json['cancellationPending'];
    if (rawCancellationPending != null && rawCancellationPending is! bool) {
      throw const PluginProtocolException();
    }
    return LedgerTaskProjection(
      code: _progressCode(json['code']),
      canCancel: switch (json['canCancel']) {
        final bool value => value,
        _ => throw const PluginProtocolException(),
      },
      canRetry: switch (json['canRetry']) {
        final bool value => value,
        _ => throw const PluginProtocolException(),
      },
      effectState: _effectState(json['effectState']),
      cancellationPending: rawCancellationPending as bool? ?? false,
      lastActionId: rawLastActionId as String?,
      terminalStatus: _optionalTerminalStatus(json['terminalStatus']),
      errorCode: rawErrorCode as String?,
    );
  }

  factory LedgerTaskProjection.queued() => const LedgerTaskProjection(
    code: LedgerTaskProgressCode.queued,
    canCancel: true,
    canRetry: false,
    effectState: LedgerTaskEffectState.noneKnown,
  );

  factory LedgerTaskProjection.running() => const LedgerTaskProjection(
    code: LedgerTaskProgressCode.runningModel,
    canCancel: true,
    canRetry: false,
    effectState: LedgerTaskEffectState.noneKnown,
  );

  factory LedgerTaskProjection.expired() => const LedgerTaskProjection(
    code: LedgerTaskProgressCode.expired,
    canCancel: false,
    canRetry: false,
    effectState: LedgerTaskEffectState.unknown,
  );

  factory LedgerTaskProjection.failed() => const LedgerTaskProjection(
    code: LedgerTaskProgressCode.done,
    canCancel: false,
    canRetry: true,
    effectState: LedgerTaskEffectState.unknown,
    terminalStatus: LedgerTaskStatus.failed,
  );

  final LedgerTaskProgressCode code;
  final String? lastActionId;
  final bool canCancel;
  final bool canRetry;
  final bool cancellationPending;
  final LedgerTaskEffectState effectState;
  final LedgerTaskStatus? terminalStatus;
  final String? errorCode;

  bool get keepsPendingMarker =>
      code == LedgerTaskProgressCode.queued ||
      code == LedgerTaskProgressCode.runningModel ||
      code == LedgerTaskProgressCode.runningTool ||
      code == LedgerTaskProgressCode.review;

  bool get isTerminal =>
      code == LedgerTaskProgressCode.review ||
      code == LedgerTaskProgressCode.done ||
      code == LedgerTaskProgressCode.expired;

  bool get isFailure =>
      code == LedgerTaskProgressCode.expired ||
      (code == LedgerTaskProgressCode.done &&
          (terminalStatus == LedgerTaskStatus.failed ||
              terminalStatus == LedgerTaskStatus.cancelled));

  Map<String, dynamic> toJson() => {
    'schemaVersion': taskProjectionSchemaVersion,
    'code': switch (code) {
      LedgerTaskProgressCode.queued => 'queued',
      LedgerTaskProgressCode.runningModel => 'running_model',
      LedgerTaskProgressCode.runningTool => 'running_tool',
      LedgerTaskProgressCode.review => 'review',
      LedgerTaskProgressCode.done => 'done',
      LedgerTaskProgressCode.expired => 'expired',
    },
    if (lastActionId != null) 'lastActionId': lastActionId,
    'canCancel': canCancel,
    'canRetry': canRetry,
    'cancellationPending': cancellationPending,
    'effectState': switch (effectState) {
      LedgerTaskEffectState.noneKnown => 'none_known',
      LedgerTaskEffectState.completedStepsOnly => 'completed_steps_only',
      LedgerTaskEffectState.unknown => 'unknown',
    },
    if (terminalStatus != null) 'terminalStatus': _statusWire(terminalStatus!),
    if (errorCode != null) 'errorCode': errorCode,
  };
}

class LedgerCompletedAction {
  const LedgerCompletedAction({
    required this.id,
    required this.stage,
    required this.action,
    this.toolCallId,
  });

  factory LedgerCompletedAction.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    if (json['completed'] != true) throw const PluginProtocolException();
    final rawToolCallId = json['toolCallId'];
    if (rawToolCallId != null && rawToolCallId is! String) {
      throw const PluginProtocolException();
    }
    return LedgerCompletedAction(
      id: _publicId(json['id']),
      stage: _metadataText(json['stage']),
      action: _metadataText(json['action']),
      toolCallId: rawToolCallId == null ? null : _publicId(rawToolCallId),
    );
  }

  final String id;
  final String stage;
  final String action;
  final String? toolCallId;

  Map<String, dynamic> toJson() => {
    'id': id,
    'stage': stage,
    'action': action,
    if (toolCallId != null) 'toolCallId': toolCallId,
    'completed': true,
  };
}

class LedgerTaskCancelReport {
  const LedgerTaskCancelReport({
    required this.taskId,
    required this.stage,
    required this.reachedStage,
    required this.taskStatus,
    required this.cancellable,
    required this.effectState,
    required this.completedActions,
    required this.projection,
    this.terminalStatus,
  });

  factory LedgerTaskCancelReport.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    if (json['schemaVersion'] != taskCancelSchemaVersion) {
      throw const PluginProtocolException();
    }
    final rawActions = json['completedActions'];
    if (rawActions is! List || rawActions.length > 64) {
      throw const PluginProtocolException();
    }
    final projection = LedgerTaskProjection.fromJson(json['projection']);
    final effectState = _effectState(json['effectState']);
    final stage = _cancelStage(json['stage']);
    final reachedStage = _cancelReachedStage(json['reachedStage']);
    final taskStatus = _taskStatus(json['taskStatus']);
    final cancellable = switch (json['cancellable']) {
      final bool value => value,
      _ => throw const PluginProtocolException(),
    };
    final terminalStatus = _optionalTerminalStatus(json['terminalStatus']);
    if (taskStatus == LedgerTaskStatus.unknown ||
        effectState != projection.effectState ||
        cancellable != projection.canCancel ||
        (stage == LedgerTaskCancelStage.cancelling) !=
            projection.cancellationPending ||
        (stage == LedgerTaskCancelStage.alreadyTerminal) !=
            (reachedStage == LedgerTaskCancelReachedStage.alreadyTerminal) ||
        (stage == LedgerTaskCancelStage.cancelled &&
            (taskStatus != LedgerTaskStatus.cancelled ||
                terminalStatus != LedgerTaskStatus.cancelled ||
                projection.terminalStatus != LedgerTaskStatus.cancelled)) ||
        (stage == LedgerTaskCancelStage.cancelling &&
            (taskStatus != LedgerTaskStatus.running ||
                terminalStatus != null)) ||
        (stage == LedgerTaskCancelStage.alreadyTerminal &&
            (!projection.isTerminal ||
                terminalStatus == null ||
                terminalStatus != projection.terminalStatus)) ||
        (stage == LedgerTaskCancelStage.notCancellable &&
            (projection.canCancel ||
                projection.cancellationPending ||
                projection.terminalStatus != null))) {
      throw const PluginProtocolException();
    }
    return LedgerTaskCancelReport(
      taskId: _publicId(json['taskId']),
      stage: stage,
      reachedStage: reachedStage,
      taskStatus: taskStatus,
      cancellable: cancellable,
      terminalStatus: terminalStatus,
      effectState: effectState,
      completedActions: List.unmodifiable(
        rawActions.map(LedgerCompletedAction.fromJson),
      ),
      projection: projection,
    );
  }

  final String taskId;
  final LedgerTaskCancelStage stage;
  final LedgerTaskCancelReachedStage reachedStage;
  final LedgerTaskStatus taskStatus;
  final bool cancellable;
  final LedgerTaskStatus? terminalStatus;
  final LedgerTaskEffectState effectState;
  final List<LedgerCompletedAction> completedActions;
  final LedgerTaskProjection projection;

  Map<String, dynamic> toJson() => {
    'schemaVersion': taskCancelSchemaVersion,
    'taskId': taskId,
    'stage': switch (stage) {
      LedgerTaskCancelStage.cancelling => 'cancelling',
      LedgerTaskCancelStage.cancelled => 'cancelled',
      LedgerTaskCancelStage.alreadyTerminal => 'already-terminal',
      LedgerTaskCancelStage.notCancellable => 'not-cancellable',
    },
    'reachedStage': switch (reachedStage) {
      LedgerTaskCancelReachedStage.queued => 'queued',
      LedgerTaskCancelReachedStage.admitted => 'admitted',
      LedgerTaskCancelReachedStage.running => 'running',
      LedgerTaskCancelReachedStage.alreadyTerminal => 'already-terminal',
      LedgerTaskCancelReachedStage.stuck => 'stuck',
    },
    'taskStatus': _statusWire(taskStatus),
    'cancellable': cancellable,
    if (terminalStatus != null) 'terminalStatus': _statusWire(terminalStatus!),
    'effectState': switch (effectState) {
      LedgerTaskEffectState.noneKnown => 'none_known',
      LedgerTaskEffectState.completedStepsOnly => 'completed_steps_only',
      LedgerTaskEffectState.unknown => 'unknown',
    },
    'completedActions': completedActions
        .map((action) => action.toJson())
        .toList(growable: false),
    'projection': projection.toJson(),
  };
}

String _statusWire(LedgerTaskStatus status) => switch (status) {
  LedgerTaskStatus.queued => 'queued',
  LedgerTaskStatus.running => 'running',
  LedgerTaskStatus.stuck => 'stuck',
  LedgerTaskStatus.succeeded => 'succeeded',
  LedgerTaskStatus.failed => 'failed',
  LedgerTaskStatus.cancelled => 'cancelled',
  LedgerTaskStatus.awaitingReview => 'awaiting_review',
  LedgerTaskStatus.unknown => 'unknown',
};

class LedgerTask {
  LedgerTask.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    id = _publicId(json['id']);
    messageId = _publicId(json['intent_key']);
    final rawStatus = pluginJsonString(json['status']);
    status = _taskStatus(rawStatus);
    final rawProjection = json['projection'];
    serverProjection = rawProjection == null
        ? null
        : LedgerTaskProjection.fromJson(rawProjection);
    createdTs = _timestamp(json['created_ts']);
    updatedTs = _timestamp(json['updated_ts']);
    lastHeartbeatTs = _timestamp(json['last_heartbeat_ts']);
    // `GET /ledger/tasks/:id` carries the task's steps (tool results +
    // the transient `reply` step); `GET /ledger/tasks/by-key/:messageId` does
    // NOT (status-only). A missing `steps` key is tolerated as an empty list,
    // and a malformed step is skipped rather than failing the whole task read.
    final rawSteps = json['steps'];
    steps = rawSteps is List
        ? List.unmodifiable(
            rawSteps
                .map((e) => LedgerStep.fromJson(e))
                .where((step) => step.stage.isNotEmpty),
          )
        : const <LedgerStep>[];
  }

  late final String id;
  late final String messageId;
  late final LedgerTaskStatus status;
  late final int createdTs;
  late final int updatedTs;
  late final int lastHeartbeatTs;
  late final List<LedgerStep> steps;
  late final LedgerTaskProjection? serverProjection;

  LedgerTaskProjection get projection =>
      serverProjection ?? projectLedgerTask(this);

  /// The transient `reply` step's result (the background job's final assistant
  /// message), or null when the task carries none. Only the full-task endpoint
  /// (`GET /ledger/tasks/:id`) includes steps, so poll-by-messageId must be
  /// followed by a full-task fetch to read the reply back.
  String? get reply {
    for (final step in steps) {
      if (step.stage == 'reply') {
        final result = step.result;
        return result is String ? result : null;
      }
    }
    return null;
  }
}

/// One transient ledger step (plan §7): a tool result (`stage == 'tool'`), a
/// redacted error (`stage == 'error'`), or the job's final assistant reply
/// (`stage == 'reply'`). `result` is the raw serialized content. Parsing is
/// lenient: a step missing its `stage`/`action` strings yields empty values
/// (filtered out by [LedgerTask.fromJson]) instead of failing the task read.
class LedgerStep {
  LedgerStep.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    final rawStage = json['stage'];
    final rawAction = json['action'];
    stage = rawStage is String ? rawStage : '';
    action = rawAction is String ? rawAction : '';
    result = json['result'];
    final rawCallId = json['tool_call_id'];
    toolCallId = rawCallId is String && rawCallId.isNotEmpty ? rawCallId : null;
  }

  late final String stage;
  late final String action;
  late final Object? result;
  late final String? toolCallId;
}

LedgerTaskProjection projectLedgerTask(LedgerTask task) {
  String? errorCode;
  for (final step in task.steps.reversed) {
    if (step.stage == 'error' && step.action.startsWith('error:')) {
      errorCode = step.action.substring('error:'.length);
      break;
    }
  }
  return switch (task.status) {
    LedgerTaskStatus.queued => LedgerTaskProjection.queued(),
    LedgerTaskStatus.running => LedgerTaskProjection(
      code: LedgerTaskProgressCode.runningModel,
      canCancel: true,
      canRetry: false,
      effectState: task.steps.isEmpty
          ? LedgerTaskEffectState.noneKnown
          : LedgerTaskEffectState.completedStepsOnly,
      errorCode: errorCode,
    ),
    LedgerTaskStatus.stuck => LedgerTaskProjection(
      code: LedgerTaskProgressCode.queued,
      canCancel: false,
      canRetry: true,
      effectState: LedgerTaskEffectState.unknown,
      errorCode: errorCode,
    ),
    LedgerTaskStatus.succeeded => LedgerTaskProjection(
      code: LedgerTaskProgressCode.done,
      canCancel: false,
      canRetry: false,
      effectState: task.steps.isEmpty
          ? LedgerTaskEffectState.noneKnown
          : LedgerTaskEffectState.completedStepsOnly,
      terminalStatus: LedgerTaskStatus.succeeded,
      errorCode: errorCode,
    ),
    LedgerTaskStatus.failed => LedgerTaskProjection(
      code: LedgerTaskProgressCode.done,
      canCancel: false,
      canRetry: true,
      effectState: task.steps.isEmpty
          ? LedgerTaskEffectState.noneKnown
          : LedgerTaskEffectState.completedStepsOnly,
      terminalStatus: LedgerTaskStatus.failed,
      errorCode: errorCode,
    ),
    LedgerTaskStatus.cancelled => LedgerTaskProjection(
      code: LedgerTaskProgressCode.done,
      canCancel: false,
      canRetry: false,
      effectState: task.steps.isEmpty
          ? LedgerTaskEffectState.noneKnown
          : LedgerTaskEffectState.completedStepsOnly,
      terminalStatus: LedgerTaskStatus.cancelled,
      errorCode: errorCode,
    ),
    LedgerTaskStatus.awaitingReview => LedgerTaskProjection(
      code: LedgerTaskProgressCode.review,
      canCancel: false,
      canRetry: false,
      effectState: task.steps.isEmpty
          ? LedgerTaskEffectState.noneKnown
          : LedgerTaskEffectState.completedStepsOnly,
      terminalStatus: LedgerTaskStatus.awaitingReview,
      errorCode: errorCode,
    ),
    LedgerTaskStatus.unknown => LedgerTaskProjection.expired(),
  };
}

String _publicId(Object? value) {
  final id = pluginJsonString(value);
  if (id.length > 1024 ||
      id == '.' ||
      id == '..' ||
      id.contains(RegExp(r'[\x00-\x1f\x7f]'))) {
    throw const PluginProtocolException();
  }
  return id;
}

String _metadataText(Object? value) {
  final text = pluginJsonString(value);
  if (text.length > 256 || text.contains(RegExp(r'[\x00-\x1f\x7f]'))) {
    throw const PluginProtocolException();
  }
  return text;
}

int _timestamp(Object? value) {
  if (value is! int || value < 0) throw const PluginProtocolException();
  return value;
}

class LedgerClient {
  LedgerClient({
    required Dio dio,
    required this.scope,
    Duration timeout = const Duration(seconds: 20),
  }) : _http = PluginHttp(
         dio: dio,
         baseUrl: scope.backendOrigin,
         timeout: timeout,
       );

  final AuthAccountScope scope;
  final PluginHttp _http;

  Future<LedgerTask> getTaskByMessageId(
    String messageId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _get(LedgerLookup.byMessageId(messageId), gatewayKey, cancelToken);

  Future<LedgerTask> getTask(
    String id, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _get(LedgerLookup.byTaskId(id), gatewayKey, cancelToken);

  Future<LedgerTaskCancelReport> cancelTask(
    String id, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _http.run(cancelToken, (token) async {
    final safeId = _publicId(id);
    final response = await _http.send(
      path: '/ledger/tasks/${Uri.encodeComponent(safeId)}/cancel',
      gatewayKey: gatewayKey,
      cancelToken: token,
      method: 'POST',
    );
    final report = LedgerTaskCancelReport.fromJson(
      await _http.readJson(response.data),
    );
    if (report.taskId != safeId) throw const PluginProtocolException();
    return report;
  });

  Future<LedgerTask> _get(
    LedgerLookup lookup,
    String gatewayKey,
    CancelToken? cancelToken,
  ) => _http.run(cancelToken, (token) async {
    final id = Uri.encodeComponent(_publicId(lookup.value));
    final response = await _http.send(
      path: lookup.isMessageId
          ? '/ledger/tasks/by-key/$id'
          : '/ledger/tasks/$id',
      gatewayKey: gatewayKey,
      cancelToken: token,
    );
    final json = pluginJsonObject(await _http.readJson(response.data));
    if (json['owner'] != scope.ownerId) {
      throw const PluginProtocolException();
    }
    final task = LedgerTask.fromJson(json);
    if ((lookup.isMessageId ? task.messageId : task.id) != lookup.value) {
      throw const PluginProtocolException();
    }
    return task;
  });
}

class LedgerLookup {
  const LedgerLookup.byMessageId(this.value) : isMessageId = true;
  const LedgerLookup.byTaskId(this.value) : isMessageId = false;

  final String value;
  final bool isMessageId;

  @override
  bool operator ==(Object other) =>
      other is LedgerLookup &&
      other.value == value &&
      other.isMessageId == isMessageId;

  @override
  int get hashCode => Object.hash(value, isMessageId);
}

typedef LedgerCancel = void Function();
typedef LedgerCredentialsResolver = Future<AuthCredentials?> Function();

abstract interface class LedgerScheduler {
  Duration get elapsed;
  LedgerCancel schedule(Duration delay, void Function() callback);
}

class TimerLedgerScheduler implements LedgerScheduler {
  final _clock = Stopwatch()..start();

  @override
  Duration get elapsed => _clock.elapsed;

  @override
  LedgerCancel schedule(Duration delay, void Function() callback) =>
      Timer(delay, callback).cancel;
}

enum LedgerPollEnd { observed, expired, exhausted, error, cancelled }

class LedgerPollResult {
  const LedgerPollResult(this.end, {this.task, this.projection, this.error});

  final LedgerPollEnd end;
  final LedgerTask? task;
  final LedgerTaskProjection? projection;
  final PluginClientException? error;
}

class LedgerPollHandle {
  LedgerPollHandle._(
    this._poller,
    this.lookup,
    this._onUpdate,
    this.expectedTaskId,
  ) : _deadline = _poller.scheduler.elapsed + _poller.maxElapsed;

  final LedgerPoller _poller;
  final LedgerLookup lookup;
  final void Function(LedgerTask)? _onUpdate;

  /// The task this watch is expected to observe, when known up front. A
  /// task-id lookup derives it from [lookup]; a message-id lookup takes it
  /// from the optional `watch` argument. It lets
  /// [LedgerPoller.accelerate] match a watch before the first poll has echoed
  /// the task's id.
  final String? expectedTaskId;
  final Duration _deadline;
  final _completion = Completer<LedgerPollResult>();
  LedgerCancel? _timer;
  LedgerCancel? _deadlineTimer;
  CancelToken? _token;
  int _generation = 0;
  int? _completionGeneration;
  int _attempts = 0;
  Duration _notBefore = Duration.zero;
  LedgerTask? _task;
  LedgerTaskProjection? _projection;
  PluginClientException? _error;

  Future<LedgerPollResult> get done => _completion.future;
  bool get isCurrent =>
      !_poller._disposed &&
      _poller._foreground &&
      identical(_poller._handles[lookup], this) &&
      (_completionGeneration == null || _completionGeneration == _generation);

  /// Whether this watch is for [taskId]: either it was told that id up front
  /// ([expectedTaskId]) or it has already observed a task carrying it. An
  /// unrelated task never matches, so [LedgerPoller.accelerate] leaves other
  /// watches alone.
  bool _matchesTask(String taskId) =>
      expectedTaskId == taskId || _task?.id == taskId;

  void cancel() => _poller._cancel(this);

  void _suspend() {
    _generation++;
    _timer?.call();
    _timer = null;
    _deadlineTimer?.call();
    _deadlineTimer = null;
    _token?.cancel();
    _token = null;
  }

  void _finish(LedgerPollEnd end) {
    _suspend();
    // A finished watch is no longer current, so evict it before settling:
    // otherwise the terminal entry would stay in the poller's account-lifetime
    // map, retaining this handle, its observed task (including step results),
    // and its completed future indefinitely.
    _poller._evict(this);
    if (!_completion.isCompleted) {
      _completionGeneration = _generation;
      _completion.complete(
        LedgerPollResult(
          end,
          task: _task,
          projection: _projection,
          error: _error,
        ),
      );
    }
  }

  void _arm() {
    if (!isCurrent || _completion.isCompleted || !_poller._foreground) return;
    final now = _poller.scheduler.elapsed;
    if (now >= _deadline || _attempts >= _poller.maxAttempts) {
      _finish(LedgerPollEnd.exhausted);
      return;
    }
    final generation = _generation;
    _deadlineTimer ??= _poller.scheduler.schedule(_deadline - now, () {
      if (_valid(generation)) _finish(LedgerPollEnd.exhausted);
    });
    final delay = _notBefore > now ? _notBefore - now : Duration.zero;
    _timer = _poller.scheduler.schedule(delay, () {
      _timer = null;
      if (_valid(generation)) unawaited(_poll(generation));
    });
  }

  /// Requests an immediate poll without disturbing work already in flight.
  ///
  /// A request already awaiting the network owns the next schedule ([_poll]
  /// re-arms with fresh backoff when it settles), so accelerating while the
  /// in-flight token is set is a no-op rather than a second concurrent request.
  /// Otherwise the pending backoff timer is cancelled and replaced by a
  /// zero-delay poll; [_arm] still enforces the fixed deadline and attempt cap.
  /// A suspended, completed, replaced, or disposed handle matches none of
  /// these and is left untouched.
  void _accelerate() {
    if (!isCurrent || _completion.isCompleted || _token != null) return;
    _timer?.call();
    _timer = null;
    _notBefore = _poller.scheduler.elapsed;
    _arm();
  }

  bool _valid(int generation) =>
      isCurrent &&
      !_completion.isCompleted &&
      _poller._foreground &&
      _generation == generation;

  Future<void> _poll(int generation) async {
    final token = CancelToken();
    _token = token;
    Duration? retryAfter;
    try {
      _attempts++;
      final credentials = await _poller.credentials();
      if (!_valid(generation)) return;
      if (credentials == null || credentials.accountScope != _poller.scope) {
        throw const PluginClientException('missing_gateway_key');
      }
      final task = lookup.isMessageId
          ? await _poller.client.getTaskByMessageId(
              lookup.value,
              gatewayKey: credentials.apiKey,
              cancelToken: token,
            )
          : await _poller.client.getTask(
              lookup.value,
              gatewayKey: credentials.apiKey,
              cancelToken: token,
            );
      if (!_valid(generation)) return;
      _task = task;
      _projection = task.projection;
      _error = null;
      _onUpdate?.call(task);
      if (!_valid(generation)) return;
      if (!task.status.shouldPoll) {
        _finish(LedgerPollEnd.observed);
        return;
      }
    } on PluginClientException catch (error) {
      if (!_valid(generation)) return;
      _error = error;
      if (error.statusCode == 404) {
        _projection = LedgerTaskProjection.expired();
        _finish(LedgerPollEnd.expired);
        return;
      }
      retryAfter = error.retryAfter;
      if (!_retryable(error)) {
        _finish(LedgerPollEnd.error);
        return;
      }
    } catch (_) {
      if (!_valid(generation)) return;
      _error = const PluginClientException('invalid_response');
      _finish(LedgerPollEnd.error);
      return;
    } finally {
      if (identical(_token, token)) _token = null;
    }
    if (!_valid(generation)) return;
    var delay = _poller.initialDelay;
    for (var i = 1; i < _attempts && delay < _poller.maxDelay; i++) {
      delay *= 2;
    }
    if (delay > _poller.maxDelay) delay = _poller.maxDelay;
    if (retryAfter != null && retryAfter > delay) delay = retryAfter;
    _notBefore = _poller.scheduler.elapsed + delay;
    _arm();
  }

  bool _retryable(PluginClientException error) {
    final status = error.statusCode;
    if (status != null) {
      return status == 408 ||
          status == 413 ||
          status == 429 ||
          status >= 500 && status <= 599;
    }
    return error.code == 'network_error' || error.code == 'timeout';
  }
}

class LedgerPoller {
  LedgerPoller({
    required this.client,
    required this.credentials,
    LedgerScheduler? scheduler,
    this.maxAttempts = 12,
    this.maxElapsed = const Duration(minutes: 2),
    this.initialDelay = const Duration(seconds: 1),
    this.maxDelay = const Duration(seconds: 15),
  }) : scheduler = scheduler ?? TimerLedgerScheduler() {
    if (maxAttempts < 1 ||
        maxElapsed <= Duration.zero ||
        initialDelay <= Duration.zero ||
        maxDelay < initialDelay) {
      throw const PluginClientException('invalid_configuration');
    }
  }

  final LedgerClient client;
  final LedgerCredentialsResolver credentials;
  final LedgerScheduler scheduler;
  final int maxAttempts;
  final Duration maxElapsed;
  final Duration initialDelay;
  final Duration maxDelay;
  final _handles = <LedgerLookup, LedgerPollHandle>{};
  bool _foreground = false;
  bool _disposed = false;

  AuthAccountScope get scope => client.scope;

  LedgerPollHandle watch(
    LedgerLookup lookup, {
    void Function(LedgerTask)? onUpdate,
    String? expectedTaskId,
  }) {
    if (_disposed) throw const PluginClientException('cancelled');
    try {
      _publicId(lookup.value);
      if (expectedTaskId != null) _publicId(expectedTaskId);
    } on PluginProtocolException {
      throw const PluginClientException('invalid_request');
    }
    invalidateKey(lookup);
    final handle = LedgerPollHandle._(
      this,
      lookup,
      onUpdate,
      expectedTaskId ?? (lookup.isMessageId ? null : lookup.value),
    );
    _handles[lookup] = handle;
    handle._arm();
    return handle;
  }

  /// Immediately re-arms every active watch for [taskId], bypassing its
  /// backoff delay. A watch matches by its expected task id or a task id it
  /// has already observed, so watches for other tasks are never accelerated.
  /// A watch with a request already in flight, or one that is suspended,
  /// completed, replaced, or disposed, is left untouched.
  void accelerate(String taskId) {
    if (_disposed) return;
    for (final handle in _handles.values.toList()) {
      if (handle._matchesTask(taskId)) handle._accelerate();
    }
  }

  void setForeground(bool foreground) {
    if (_disposed || _foreground == foreground) return;
    _foreground = foreground;
    for (final handle in _handles.values.toList()) {
      if (foreground) {
        handle._arm();
      } else {
        handle._suspend();
      }
    }
  }

  void invalidateKey(LedgerLookup lookup) {
    final handle = _handles[lookup];
    if (handle != null) _cancel(handle);
  }

  void invalidateScope() {
    for (final handle in _handles.values.toList()) {
      _cancel(handle);
    }
  }

  void _cancel(LedgerPollHandle handle) {
    _evict(handle);
    handle._finish(LedgerPollEnd.cancelled);
  }

  /// Drops [handle] from the active set only when it is still the registered
  /// watch for its lookup. The identity guard keeps a superseded handle's late
  /// completion or cancellation from evicting a newer watch for the same
  /// lookup.
  void _evict(LedgerPollHandle handle) {
    if (identical(_handles[handle.lookup], handle)) {
      _handles.remove(handle.lookup);
    }
  }

  void dispose() {
    _disposed = true;
    invalidateScope();
  }
}
