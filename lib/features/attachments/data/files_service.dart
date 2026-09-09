import 'dart:typed_data';

import 'package:dio/dio.dart';

import './file_model.dart';
import '../../../core/http/dio_errors.dart';

// The constructor assigns public params to private fields (per the shared
// contract), which trips prefer_initializing_formals.
// ignore_for_file: prefer_initializing_formals

/// Base class for all errors surfaced by [FilesClient] implementations.
sealed class FilesApiError implements Exception {
  const FilesApiError(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// Transport-level failure (timeout, connection refused). Retryable by the
/// upload queue.
class FilesNetworkError extends FilesApiError {
  const FilesNetworkError(super.message);
}

/// The request was cancelled via its [CancelToken].
class FilesCancelledError extends FilesApiError {
  const FilesCancelledError(super.message);
}

/// The server responded with a non-2xx status.
class FilesServerError extends FilesApiError {
  const FilesServerError(super.message, {this.statusCode});

  final int? statusCode;
}

/// A locally-rejected request (invalid file ID, unreadable local file).
class FilesValidationError extends FilesApiError {
  const FilesValidationError(super.message);
}

/// Contract for the bearer-gated files service.
abstract interface class FilesClient {
  /// Uploads the local file at [path] and returns the server-assigned
  /// [FileInfo]. [onProgress] reports `(sent, total)` bytes during send.
  Future<FileInfo> uploadFile({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onProgress,
  });

  /// Lists every file known to the service.
  Future<List<FileInfo>> listFiles();

  /// Fetches a file's raw bytes (the caller caches them locally).
  Future<Uint8List> fetchFile(String fileId);

  /// Deletes a file from the service.
  Future<void> deleteFile(String fileId);
}

/// Dio-backed [FilesClient]. All requests carry the bearer token and never
/// follow redirects so the token cannot be replayed to another origin.
class FilesClientImpl implements FilesClient {
  FilesClientImpl({
    required Dio dio,
    required String baseUrl,
    required String bearerToken,
  })  : _dio = dio,
        _baseUrl = baseUrl,
        _bearerToken = bearerToken;

  final Dio _dio;
  final String _baseUrl;
  final String _bearerToken;

  /// Only URL-safe ids are ever interpolated into request paths (SSRF guard).
  static final RegExp _safeId = RegExp(r'^[a-zA-Z0-9._-]+$');

  /// REST contract (single /files prefix):
  /// POST /files — upload (multipart/form-data)
  /// GET  /files — list
  /// GET  /files/{id} — fetch
  /// DELETE /files/{id} — delete
  ///
  /// Large files on a tailnet can take a while; uploads/fetches get 120s.
  static const Duration _timeout = Duration(seconds: 120);

  Options _auth() => Options(
        headers: {'Authorization': 'Bearer $_bearerToken'},
        followRedirects: false,
        sendTimeout: _timeout,
        receiveTimeout: _timeout,
      );

  @override
  Future<FileInfo> uploadFile({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onProgress,
  }) async {
    final file = await MultipartFile.fromFile(path, filename: filename);
    final form = FormData.fromMap({
      'file': file,
      'filename': filename,
      'mimeType': mimeType,
    });
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '$_baseUrl/files',
        data: form,
        options: _auth(),
        cancelToken: cancelToken,
        onSendProgress: onProgress,
      );
      final data = response.data;
      if (data == null) {
        throw const FilesServerError('upload returned no data');
      }
      return FileInfo.fromJson(data);
    } on DioException catch (e) {
      throw _mapError(e);
    }
  }

  @override
  Future<List<FileInfo>> listFiles() async {
    try {
      final response = await _dio.get<dynamic>(
        '$_baseUrl/files',
        options: _auth(),
      );
      return _parseFileInfoList(response.data);
    } on DioException catch (e) {
      throw _mapError(e);
    }
  }

  @override
  Future<Uint8List> fetchFile(String fileId) async {
    _assertSafeId(fileId);
    try {
      final response = await _dio.get<List<int>>(
        '$_baseUrl/files/$fileId',
        options: Options(
          headers: {'Authorization': 'Bearer $_bearerToken'},
          followRedirects: false,
          receiveTimeout: _timeout,
          responseType: ResponseType.bytes,
        ),
      );
      final data = response.data;
      if (data == null) {
        throw const FilesServerError('fetch returned no data');
      }
      return Uint8List.fromList(data);
    } on DioException catch (e) {
      throw _mapError(e);
    }
  }

  @override
  Future<void> deleteFile(String fileId) async {
    _assertSafeId(fileId);
    try {
      await _dio.delete<void>(
        '$_baseUrl/files/$fileId',
        options: _auth(),
      );
    } on DioException catch (e) {
      throw _mapError(e);
    }
  }

  void _assertSafeId(String fileId) {
    if (!_safeId.hasMatch(fileId)) {
      throw FilesValidationError('Invalid file ID');
    }
  }

  List<FileInfo> _parseFileInfoList(Object? data) {
    if (data is List) {
      return data.map(_parseFileInfo).toList();
    }
    if (data is Map && data['files'] is List) {
      return (data['files'] as List).map(_parseFileInfo).toList();
    }
    return const [];
  }

  FileInfo _parseFileInfo(Object? json) {
    if (json is! Map) {
      throw const FilesServerError('malformed file entry');
    }
    return FileInfo.fromJson(Map<String, dynamic>.from(json));
  }

  Never _mapError(DioException e) {
    switch (classifyDioException(e)) {
      case DioErrorCategory.cancelled:
        throw FilesCancelledError('cancelled');
      case DioErrorCategory.badResponse:
        throw FilesServerError(
          describeDioException(e),
          statusCode: e.response?.statusCode,
        );
      case DioErrorCategory.timeoutNetwork:
      case DioErrorCategory.other:
        throw FilesNetworkError(describeDioException(e));
    }
  }
}

/// Graceful fallback used when the files secret is not configured. Prevents
/// crashes and lets the UI show "Files service not configured".
class NoOpFilesClient implements FilesClient {
  @override
  Future<FileInfo> uploadFile({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onProgress,
  }) =>
      throw StateError('Files service not configured');

  @override
  Future<List<FileInfo>> listFiles() => Future.value(const []);

  @override
  Future<Uint8List> fetchFile(String fileId) =>
      throw StateError('Files service not configured');

  @override
  Future<void> deleteFile(String fileId) async {}
}

/// True for the MIME types the MVP accepts (JPEG, PNG, WEBP). Cosmetic only —
/// the server validates magic bytes.
bool isSupportedImageMime(String mime) =>
    mime == 'image/jpeg' || mime == 'image/png' || mime == 'image/webp';
