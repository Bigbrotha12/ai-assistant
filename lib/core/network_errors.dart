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
          final body = truncateText(current.response?.data, truncate);
          return 'HTTP $status${body.isEmpty ? '' : ': $body'}';
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