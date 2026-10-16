// ignore_for_file: prefer_initializing_formals
import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

/// A notification pushed by the gateway when a background job completes.
class NotifMessage {
  const NotifMessage({required this.title, required this.body});

  /// The server-set title; job events carry `Job <taskId>`.
  final String title;

  /// The notification body (the job summary).
  final String body;
}

/// Contract for the owner-wide gateway notification stream.
///
/// The stream is account-scoped: one long-lived connection per signed-in owner
/// carries every job-completion event. There is no per-topic subscription.
abstract interface class NotifClient {
  /// Notification events pushed to the signed-in owner.
  Stream<NotifMessage> get messages;

  /// Cancels the in-flight request and any retry wait, prevents reconnection,
  /// and closes [messages]. Idempotent; completes once teardown has quiesced.
  Future<void> dispose();
}

/// Opens the gateway's owner-wide SSE notification stream
/// (`GET {origin}/v1/notify/events`) and reconnects with bounded exponential
/// backoff.
///
/// The gateway API key is supplied by [resolveApiKey], called fresh on every
/// (re)connect and never cached, so a rotated or re-minted key is picked up
/// after a `401` without rebuilding the client. [messages] is a broadcast
/// stream: events emitted with no listener are dropped (push is best-effort).
class GatewaySseNotifClient implements NotifClient {
  GatewaySseNotifClient({
    required Dio dio,
    required String backendOrigin,
    required Future<String?> Function() resolveApiKey,
    Duration initialRetryDelay = const Duration(seconds: 1),
    Duration maxRetryDelay = const Duration(seconds: 30),
  }) : _dio = dio,
       _eventsUrl = '${_trimTrailingSlashes(backendOrigin)}/v1/notify/events',
       _resolveApiKey = resolveApiKey,
       _initialRetryDelay = initialRetryDelay,
       _maxRetryDelay = maxRetryDelay {
    _loop = _run();
  }

  final Dio _dio;
  final String _eventsUrl;
  final Future<String?> Function() _resolveApiKey;
  final Duration _initialRetryDelay;
  final Duration _maxRetryDelay;

  final StreamController<NotifMessage> _controller =
      StreamController<NotifMessage>.broadcast();

  late final Future<void> _loop;
  CancelToken? _cancelToken;
  StreamSubscription<String>? _lines;
  Completer<void>? _backoff;
  bool _disposed = false;

  @override
  Stream<NotifMessage> get messages => _controller.stream;

  static String _trimTrailingSlashes(String value) =>
      value.replaceFirst(RegExp(r'/+$'), '');

  Future<void> _run() async {
    var delay = _initialRetryDelay;
    while (!_disposed) {
      String? key;
      try {
        key = await _resolveApiKey();
      } catch (_) {
        key = null;
      }
      if (_disposed) return;
      if (key == null || key.trim().isEmpty) {
        await _wait(delay);
        if (!_disposed) delay = _nextDelay(delay);
        continue;
      }

      final token = CancelToken();
      _cancelToken = token;
      var sawLine = false;
      try {
        sawLine = await _connect(key, token);
      } catch (_) {
        // Status/auth/network failure: retry below with freshly resolved
        // credentials.
      } finally {
        if (identical(_cancelToken, token)) _cancelToken = null;
        if (!token.isCancelled) token.cancel();
        final lines = _lines;
        _lines = null;
        await lines?.cancel();
      }
      if (_disposed) return;
      // A connection that delivered at least one line was healthy: reset the
      // backoff. An immediately-closing server leaves it at false so the delay
      // still grows instead of hot-looping.
      if (sawLine) delay = _initialRetryDelay;
      await _wait(delay);
      if (!_disposed && !sawLine) delay = _nextDelay(delay);
    }
  }

  Future<bool> _connect(String gatewayKey, CancelToken token) async {
    final response = await _dio.get<ResponseBody>(
      _eventsUrl,
      cancelToken: token,
      options: Options(
        responseType: ResponseType.stream,
        headers: {
          'Authorization': 'Bearer $gatewayKey',
          'Accept': 'text/event-stream',
        },
        validateStatus: (_) => true,
        sendTimeout: const Duration(seconds: 15),
      ),
    );
    final status = response.statusCode ?? 0;
    final body = response.data;
    if (status < 200 || status >= 300) {
      await _drain(body);
      throw _NotifConnectException(status);
    }
    if (body == null || _disposed) {
      await _drain(body);
      return false;
    }

    final completer = Completer<void>();
    var sawLine = false;
    final parser = SseNotifParser();
    final sub = body.stream
        .cast<List<int>>()
        .transform(const Utf8Decoder(allowMalformed: true))
        .transform(const LineSplitter())
        .listen(
          (line) {
            sawLine = true;
            final message = parser.addLine(line);
            if (message == null || _disposed || _controller.isClosed) return;
            _controller.add(message);
          },
          onError: (Object error, StackTrace stack) {
            if (!completer.isCompleted) completer.completeError(error, stack);
          },
          onDone: () {
            if (!completer.isCompleted) completer.complete();
          },
          cancelOnError: true,
        );
    _lines = sub;
    // A dispose can race the assignment above: the token is already cancelled
    // in that case, so complete now instead of awaiting a stream whose cancel
    // may not surface as an onDone/onError.
    unawaited(
      token.whenCancel.then((_) {
        if (!completer.isCompleted) completer.complete();
      }),
    );
    try {
      await completer.future;
    } finally {
      if (identical(_lines, sub)) _lines = null;
      await sub.cancel();
    }
    return sawLine;
  }

  Future<void> _drain(ResponseBody? body) async {
    if (body == null) return;
    try {
      await body.stream.drain<void>();
    } catch (_) {}
  }

  /// Waits [delay], returning early when [dispose] interrupts the wait.
  Future<void> _wait(Duration delay) async {
    if (_disposed) return;
    final completer = Completer<void>();
    _backoff = completer;
    final timer = Timer(delay, () {
      if (!completer.isCompleted) completer.complete();
    });
    try {
      await completer.future;
    } finally {
      timer.cancel();
      if (identical(_backoff, completer)) _backoff = null;
    }
  }

  Duration _nextDelay(Duration current) {
    final next = current * 2;
    return next > _maxRetryDelay ? _maxRetryDelay : next;
  }

  @override
  Future<void> dispose() async {
    if (_disposed) {
      await _loop.catchError((_) {});
      return;
    }
    _disposed = true;
    _cancelToken?.cancel();
    _backoff?.complete();
    final lines = _lines;
    _lines = null;
    await lines?.cancel();
    await _loop.catchError((_) {});
    if (!_controller.isClosed) await _controller.close();
  }
}

class _NotifConnectException implements Exception {
  const _NotifConnectException(this.statusCode);

  final int statusCode;

  @override
  String toString() => 'NotifConnectException($statusCode)';
}

/// Incremental parser for the gateway's SSE notification frames.
class SseNotifParser {
  final StringBuffer _data = StringBuffer();
  bool _hasData = false;

  /// Feeds one decoded line and returns the message a completed frame carried.
  ///
  /// Comment lines (`:` heartbeats/keep-alives) and other SSE fields are
  /// ignored; a blank line terminates a frame and decodes its accumulated
  /// `data:` lines.
  NotifMessage? addLine(String line) {
    if (line.startsWith(':')) return null;
    if (line.isEmpty) {
      if (!_hasData) return null;
      final payload = _data.toString();
      _data.clear();
      _hasData = false;
      return parseNotifData(payload);
    }
    if (line.startsWith('data:')) {
      var value = line.substring(5);
      if (value.startsWith(' ')) value = value.substring(1);
      if (_hasData) _data.write('\n');
      _data.write(value);
      _hasData = true;
    }
    return null;
  }
}

/// Decodes one frame's `data:` payload into a [NotifMessage].
///
/// Returns null for malformed JSON, a non-object payload, missing
/// `title`/`body` strings, or a frame that carries neither.
NotifMessage? parseNotifData(String payload) {
  try {
    final decoded = jsonDecode(payload);
    if (decoded is! Map) return null;
    final title = decoded['title'];
    final body = decoded['body'];
    if (title is! String || body is! String) return null;
    if (title.isEmpty && body.isEmpty) return null;
    return NotifMessage(title: title, body: body);
  } catch (_) {
    return null;
  }
}
