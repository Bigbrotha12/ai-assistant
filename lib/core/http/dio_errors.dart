import 'package:dio/dio.dart';

import '../network_errors.dart' show describeDioError;

/// Transport-level categorization of a [DioException], shared by every HTTP
/// client. Each feature's `_mapError` maps this category onto its own error
/// type with a thin switch.
enum DioErrorCategory {
  /// The request was cancelled via its [CancelToken].
  cancelled,

  /// A timeout or connection failure (connection error/refused, or a
  /// send/receive/connection timeout).
  timeoutNetwork,

  /// The server responded with a non-2xx status.
  badResponse,

  /// Any other Dio failure (bad certificate, unknown, transform timeout).
  other,
}

/// Classifies a [DioException] into a shared [DioErrorCategory].
DioErrorCategory classifyDioException(DioException e) {
  switch (e.type) {
    case DioExceptionType.cancel:
      return DioErrorCategory.cancelled;
    case DioExceptionType.badResponse:
      return DioErrorCategory.badResponse;
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.receiveTimeout:
    case DioExceptionType.sendTimeout:
    case DioExceptionType.connectionError:
      return DioErrorCategory.timeoutNetwork;
    case DioExceptionType.badCertificate:
    case DioExceptionType.unknown:
    case DioExceptionType.transformTimeout:
      return DioErrorCategory.other;
  }
}

/// Extracts a stable, human-readable message from a [DioException].
///
/// Delegates to [describeDioError] so every HTTP client produces identical
/// error copy for the same underlying failure.
String describeDioException(DioException e, {int truncate = 120}) =>
    describeDioError(e, truncate: truncate);
