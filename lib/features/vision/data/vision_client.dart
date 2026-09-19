import 'dart:typed_data';

import 'package:dio/dio.dart';

/// Contract for the vision describe call. Testable via a fake.
abstract interface class VisionClient {
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  });
}

sealed class VisionError implements Exception {
  const VisionError(this.message);
  final String message;
}

class VisionNetworkError extends VisionError {
  const VisionNetworkError(super.message);
}

class VisionServerError extends VisionError {
  const VisionServerError(super.message, {this.statusCode});
  final int? statusCode;
}

class VisionValidationError extends VisionError {
  const VisionValidationError(super.message);
}

class VisionUnavailableError extends VisionError {
  const VisionUnavailableError(super.message);
}

/// NoOp implementation: vision is not available. Throws [VisionUnavailableError].
class NoOpVisionClient implements VisionClient {
  const NoOpVisionClient();

  @override
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  }) async {
    throw VisionUnavailableError('vision is unavailable');
  }
}