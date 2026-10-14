import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

/// Contract for push notification delivery.
abstract interface class NotifClient {
  Future<void> subscribe(String topic);
  Future<void> unsubscribe(String topic);
}

/// No-op implementation. Used when no notifier server URL is configured.
class NoOpNotifClient implements NotifClient {
  const NoOpNotifClient();
  @override
  Future<void> subscribe(String topic) async {}
  @override
  Future<void> unsubscribe(String topic) async {}
}

/// A notification received on a subscribed topic.
class NotifMessage {
  const NotifMessage({required this.topic, required this.title, required this.body, this.link});

  final String topic;
  final String title;
  final String body;

  /// Optional `click` action URL carried by the server.
  final String? link;
}

/// ntfy HTTP client.
///
/// Talks to a self-hosted ntfy server over its JSON-stream API:
/// `GET /<topic>/json` opens a stream of JSON events; `POST /<topic>`
/// publishes. Subscriptions are exposed as a broadcast [messages] stream.
/// Publish is provided for completeness; the app only receives.
///
/// Dependency-gated: the notifier server does not exist in scope, so the
/// provider returns [NoOpNotifClient] unless a server URL is configured. This
/// class ships ready for wiring the moment one exists.
class NtfyNotifClient implements NotifClient {
  NtfyNotifClient({required String baseUrl, Dio? dio, this.accessToken})
      : _baseUrl = baseUrl.replaceAll(RegExp(r'/$'), ''),
        _dio = dio ?? Dio();

  final String _baseUrl;
  final Dio _dio;

  /// Bearer token for authenticated topics. When null, requests are anonymous.
  final String? accessToken;

  final StreamController<NotifMessage> _controller =
      StreamController<NotifMessage>.broadcast();

  final Map<String, StreamSubscription<String>> _subs = {};

  /// Incoming notifications on any subscribed topic.
  Stream<NotifMessage> get messages => _controller.stream;

  @override
  Future<void> subscribe(String topic) async {
    if (_subs.containsKey(topic)) return; // Already subscribed.

    final response = await _dio.get<ResponseBody>(
      '$_baseUrl/$topic/json',
      options: Options(
        responseType: ResponseType.stream,
        headers: {
          'Accept': 'text/event-stream',
          if (accessToken != null) 'Authorization': 'Bearer $accessToken',
        },
      ),
    );
    final body = response.data;
    if (body == null) return;

    // ntfy's /json endpoint emits a stream of JSON events, one per line.
    final sub = body.stream
        .cast<List<int>>()
        .transform(const Utf8Decoder())
        .transform(const LineSplitter())
        .listen((line) {
      final message = parseNtfyEvent(line);
      if (message != null) {
        _controller.add(message);
      }
    });
    _subs[topic] = sub;
  }

  @override
  Future<void> unsubscribe(String topic) async {
    final sub = _subs.remove(topic);
    await sub?.cancel();
  }

  /// Publishes a message to [topic]. Provided for completeness (e.g. future
  /// self-test); the app does not publish in normal operation.
  Future<void> publish({
    required String topic,
    required String title,
    required String body,
    String? link,
  }) async {
    final headers = {'Content-Type': 'text/plain'};
    if (accessToken != null) {
      headers['Authorization'] = 'Bearer $accessToken';
    }
    if (title.isNotEmpty) headers['Title'] = title;
    if (link != null && link.isNotEmpty) headers['Click'] = link;
    await _dio.post<String>(
      '$_baseUrl/$topic',
      data: body,
      options: Options(headers: headers),
    );
  }

  void dispose() {
    for (final sub in _subs.values) {
      sub.cancel();
    }
    _subs.clear();
    _controller.close();
  }
}

/// Parses a single JSON event line from ntfy's stream into a [NotifMessage].
/// Returns null for control events (open/keepalive) and malformed lines.
NotifMessage? parseNtfyEvent(String line) {
  try {
    final decoded = jsonDecode(line.trim()) as Map<String, dynamic>;
    final event = decoded['event'] as String?;
    if (event != 'message') return null;
    final messageBody = (decoded['message'] as String?) ?? '';
    final title = (decoded['title'] as String?) ?? '';
    if (messageBody.isEmpty && title.isEmpty) return null;
    return NotifMessage(
      topic: (decoded['topic'] as String?) ?? '',
      title: title,
      body: messageBody,
      link: decoded['click'] as String?,
    );
  } catch (_) {
    return null;
  }
}