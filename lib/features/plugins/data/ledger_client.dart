import 'dart:async';

import 'package:dio/dio.dart';

import '../../auth/data/auth_credentials_store.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';

enum LedgerTaskStatus {
  queued,
  running,
  stuck,
  succeeded,
  failed,
  cancelled,
  awaitingReview,
  unknown;

  bool get isTerminal =>
      this == succeeded || this == failed || this == cancelled;

  bool get shouldPoll => this == queued || this == running;
}

class LedgerTask {
  LedgerTask.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    id = _publicId(json['id']);
    messageId = _publicId(json['intent_key']);
    final rawStatus = pluginJsonString(json['status']);
    status = switch (rawStatus) {
      'queued' => LedgerTaskStatus.queued,
      'running' => LedgerTaskStatus.running,
      'stuck' => LedgerTaskStatus.stuck,
      'succeeded' => LedgerTaskStatus.succeeded,
      'failed' => LedgerTaskStatus.failed,
      'cancelled' => LedgerTaskStatus.cancelled,
      'awaiting_review' => LedgerTaskStatus.awaitingReview,
      _ => LedgerTaskStatus.unknown,
    };
    createdTs = _timestamp(json['created_ts']);
    updatedTs = _timestamp(json['updated_ts']);
    lastHeartbeatTs = _timestamp(json['last_heartbeat_ts']);
  }

  late final String id;
  late final String messageId;
  late final LedgerTaskStatus status;
  late final int createdTs;
  late final int updatedTs;
  late final int lastHeartbeatTs;
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

enum LedgerPollEnd { observed, exhausted, error, cancelled }

class LedgerPollResult {
  const LedgerPollResult(this.end, {this.task, this.error});

  final LedgerPollEnd end;
  final LedgerTask? task;
  final PluginClientException? error;
}

class LedgerPollHandle {
  LedgerPollHandle._(this._poller, this.lookup, this._onUpdate)
    : _deadline = _poller.scheduler.elapsed + _poller.maxElapsed;

  final LedgerPoller _poller;
  final LedgerLookup lookup;
  final void Function(LedgerTask)? _onUpdate;
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
  PluginClientException? _error;

  Future<LedgerPollResult> get done => _completion.future;
  bool get isCurrent =>
      !_poller._disposed &&
      _poller._foreground &&
      identical(_poller._handles[lookup], this) &&
      (_completionGeneration == null || _completionGeneration == _generation);

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
    if (!_completion.isCompleted) {
      _completionGeneration = _generation;
      _completion.complete(LedgerPollResult(end, task: _task, error: _error));
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
      return status == 404 ||
          status == 408 ||
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
  }) {
    if (_disposed) throw const PluginClientException('cancelled');
    try {
      _publicId(lookup.value);
    } on PluginProtocolException {
      throw const PluginClientException('invalid_request');
    }
    invalidateKey(lookup);
    final handle = LedgerPollHandle._(this, lookup, onUpdate);
    _handles[lookup] = handle;
    handle._arm();
    return handle;
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
    if (identical(_handles[handle.lookup], handle)) {
      _handles.remove(handle.lookup);
    }
    handle._finish(LedgerPollEnd.cancelled);
  }

  void dispose() {
    _disposed = true;
    invalidateScope();
  }
}
