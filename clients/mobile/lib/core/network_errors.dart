import 'dart:async' show TimeoutException;
import 'dart:io' show SocketException;

import 'package:dio/dio.dart';

/// True when [error] — or a cause wrapped inside a [DioException] — is a
/// transport-level network failure: a socket error, a timeout, or a Dio
/// connection/timeout exception.
bool isNetworkError(Object error) {
  var current = error;
  for (var depth = 0; depth < 8; depth++) {
    if (current is SocketException || current is TimeoutException) {
      return true;
    }
    if (current is DioException) {
      if (current.type == DioExceptionType.connectionTimeout ||
          current.type == DioExceptionType.sendTimeout ||
          current.type == DioExceptionType.receiveTimeout ||
          current.type == DioExceptionType.connectionError) {
        return true;
      }
      if (current.error case final inner?) {
        current = inner;
        continue;
      }
    }
    return false;
  }
  return false;
}

/// Extracts a stable, readable message from a REST error body.
///
/// JSON payloads from the gateway carry a flat `{"message"}` (and better-auth
/// adds a `code`); an outer `{"error": {...}}` wrapper is also tolerated.
/// Prefers that message over stringifying an entire Map, and maps
/// null/blank bodies (e.g. a bare 500 with no payload) to `''` so a 5xx
/// renders as `HTTP 500` instead of the cryptic `HTTP 500: null`.
String _readableResponseBody(Object? data, int truncate) {
  if (data is Map) {
    final message = data['message'];
    if (message is String && message.trim().isNotEmpty) return message.trim();
    final error = data['error'];
    if (error is Map) {
      final nested = error['message'];
      if (nested is String && nested.trim().isNotEmpty) return nested.trim();
    }
  }
  final text = truncateText(data, truncate);
  return text == 'null' ? '' : text.trim();
}

/// Caps [text] to [limit] characters, appending an ellipsis when truncated.
String truncateText(Object? text, [int limit = 120]) {
  final s = '$text';
  if (s.length <= limit) return s;
  return '${s.substring(0, limit)}…';
}

/// Stable, human-readable description of a [DioException]-family failure.
///
/// Walks the wrapped-cause chain (like [isNetworkError]) so a Dio exception
/// carrying a socket/timeout cause is described consistently:
/// - network-family failures (timeout/connectionError/socket) → `unreachable`
/// - cancelled requests → `cancelled`
/// - non-2xx responses → `HTTP <status>: <truncated body>`
/// - anything else → the underlying cause or message, truncated
String describeDioError(Object error, {int truncate = 120}) {
  var current = error;
  for (var depth = 0; depth < 8; depth++) {
    if (isNetworkError(current)) return 'unreachable';
    if (current is DioException) {
      switch (current.type) {
        case DioExceptionType.cancel:
          return 'cancelled';
        case DioExceptionType.badResponse:
          final status = current.response?.statusCode;
          final data = current.response?.data;
          // A streaming response exposes a [ResponseBody] that cannot be read
          // synchronously; never stringify it (that yields "Instance of
          // 'ResponseBody'"). Callers that need the body read it themselves.
          if (data is ResponseBody) return 'HTTP $status';
          final body = _readableResponseBody(data, truncate);
          if (body.isEmpty) return 'HTTP $status';
          return 'HTTP $status: $body';
        case DioExceptionType.badCertificate:
        case DioExceptionType.unknown:
        case DioExceptionType.transformTimeout:
          if (current.error case final inner?) {
            current = inner;
            continue;
          }
          return truncateText(current.message ?? 'network error', truncate);
        case DioExceptionType.connectionTimeout:
        case DioExceptionType.sendTimeout:
        case DioExceptionType.receiveTimeout:
        case DioExceptionType.connectionError:
          return 'unreachable';
      }
    }
    return truncateText('$current', truncate);
  }
  return truncateText('$current', truncate);
}