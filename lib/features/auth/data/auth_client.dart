import 'package:dio/dio.dart';

import '../../../core/http/dio_errors.dart';
import 'auth_credentials_store.dart';

/// A successful email sign-up/sign-in result from the backend.
class AuthSession {
  const AuthSession({
    required this.token,
    required this.email,
    this.ownerId,
    this.backendOrigin,
  });

  final String? ownerId;
  final String? backendOrigin;

  /// The session token (better-auth `token` field). Sent as
  /// `Authorization: Bearer <token>` on authenticated endpoints.
  final String token;

  /// The account email.
  final String email;
}

/// Base class for all errors surfaced by [AuthClient].
sealed class AuthApiError implements Exception {
  const AuthApiError(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => '$runtimeType: $message';
}

/// The provided credentials were rejected (invalid email/password on sign-in).
class AuthInvalidCredentials extends AuthApiError {
  const AuthInvalidCredentials(super.message, {super.statusCode});
}

/// The email is already registered (attempted to sign up).
class AuthEmailTaken extends AuthApiError {
  const AuthEmailTaken(super.message, {super.statusCode});
}

/// The session token was rejected by the server (HTTP 401). Used later to
/// trigger a global re-authentication flow.
class AuthUnauthorized extends AuthApiError {
  const AuthUnauthorized(super.message, {super.statusCode});
}

/// The server responded with a 4xx/5xx status not covered by the typed errors.
class AuthServerError extends AuthApiError {
  const AuthServerError(super.message, {super.statusCode});
}

/// Transport-level failure (timeout, connection refused, cancellation).
class AuthNetworkError extends AuthApiError {
  const AuthNetworkError(super.message);
}

/// A freshly minted API key and its server-side record id.
///
/// The full [key] string is only ever returned once by the gateway; [id]
/// identifies the key record so it can be revoked later without re-reading
/// the key itself.
class MintedApiKey {
  const MintedApiKey({required this.key, required this.id});

  /// The full key string, as returned by the create endpoint.
  final String key;

  /// The id of the key record (better-auth `apikey.id`).
  final String id;
}

/// Contract for the better-auth REST client. Extracted so providers and tests
/// can inject a fake without coupling to the Dio-backed implementation.
abstract interface class AuthClient {
  /// Registers a new account and returns an authenticated session.
  Future<AuthSession> signUp({
    required String name,
    required String email,
    required String password,
  });

  /// Signs in an existing account and returns an authenticated session.
  Future<AuthSession> signIn({required String email, required String password});

  /// Signs out, revoking [sessionToken] on the server.
  Future<void> signOut({required String sessionToken});

  /// Mints a long-lived API key for the authenticated [sessionToken] and
  /// returns the key plus its record id. The full key string is never
  /// readable again, so callers must persist both.
  Future<MintedApiKey> mintApiKey({required String sessionToken});

  /// Revokes the API key identified by [keyId] for the authenticated
  /// [sessionToken].
  Future<void> revokeApiKey({
    required String sessionToken,
    required String keyId,
  });
}

/// better-auth REST client over the shared [Dio].
///
/// Endpoints follow better-auth's default REST layout under the `/api/auth`
/// base path:
///   - `POST /api/auth/sign-up/email`  body {name, email, password}
///   - `POST /api/auth/sign-in/email`  body {email, password}
///   - `POST /api/auth/sign-out`       (bearer session token)
///   - `POST /api/auth/api-key/create` (bearer session token)
///   - `POST /api/auth/api-key/delete` (bearer session token; body {keyId})
class BetterAuthClient implements AuthClient {
  BetterAuthClient({required this.baseUrl, Dio? dio}) : _dio = dio ?? Dio();

  /// The auth base URL, e.g. `http://192.168.1.5:17600` (the gateway origin;
  /// it hosts account services only — inference never routes here). No
  /// trailing slash.
  final String baseUrl;

  final Dio _dio;

  static const Duration _connectTimeout = Duration(seconds: 8);
  static const Duration _receiveTimeout = Duration(seconds: 30);

  String get _endpoint => '$baseUrl/api/auth';

  /// Path to the API-key create endpoint. Isolated in case the plugin route is
  /// configured differently server-side; see report.
  Uri _mintKeyUri() => Uri.parse('$_endpoint/api-key/create');

  /// Path to the API-key delete endpoint. Isolated alongside [_mintKeyUri].
  Uri _deleteKeyUri() => Uri.parse('$_endpoint/api-key/delete');

  @override
  Future<AuthSession> signUp({
    required String name,
    required String email,
    required String password,
  }) async {
    final data = <String, Object?>{
      'name': name,
      'email': email,
      'password': password,
    };
    final response = await _post('$_endpoint/sign-up/email', body: data);
    return _parseSession(response);
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async {
    final data = <String, Object?>{'email': email, 'password': password};
    final response = await _post('$_endpoint/sign-in/email', body: data);
    return _parseSession(response);
  }

  @override
  Future<void> signOut({required String sessionToken}) async {
    await _post(
      '$_endpoint/sign-out',
      body: const <String, Object?>{},
      bearer: sessionToken,
    );
  }

  @override
  Future<MintedApiKey> mintApiKey({required String sessionToken}) async {
    final response = await _post(
      _mintKeyUri().toString(),
      body: const <String, Object?>{},
      bearer: sessionToken,
    );
    final key = response.data?['key'];
    if (key is! String || key.isEmpty) {
      throw const AuthServerError('malformed api key create response');
    }
    // The create handler returns the full key record (spread `...apiKey`,
    // which carries the `id`) plus the plaintext `key`; see the plugin
    // source. Both are top-level fields.
    final id = response.data?['id'];
    if (id is! String || id.isEmpty) {
      throw const AuthServerError('malformed api key create response');
    }
    return MintedApiKey(key: key, id: id);
  }

  @override
  Future<void> revokeApiKey({
    required String sessionToken,
    required String keyId,
  }) async {
    await _post(
      _deleteKeyUri().toString(),
      body: <String, Object?>{'keyId': keyId},
      bearer: sessionToken,
    );
  }

  Future<Response<Map<String, dynamic>>> _post(
    String path, {
    required Map<String, Object?> body,
    String? bearer,
  }) async {
    try {
      return await _dio.post<Map<String, dynamic>>(
        path,
        data: body,
        options: Options(
          headers: bearer == null
              ? const <String, Object?>{}
              : <String, Object?>{'Authorization': 'Bearer $bearer'},
          connectTimeout: _connectTimeout,
          receiveTimeout: _receiveTimeout,
        ),
      );
    } on DioException catch (e) {
      throw _mapDioError(e);
    }
  }

  AuthSession _parseSession(Response<Map<String, dynamic>> response) {
    final data = response.data;
    final token = data?['token'];
    if (token is! String || token.isEmpty) {
      throw const AuthServerError('malformed sign-in response');
    }
    final user = data?['user'];
    final email = user is Map<String, dynamic> ? user['email'] : data?['email'];
    final ownerId = user is Map<String, dynamic> ? user['id'] : null;
    return AuthSession(
      token: token,
      email: email is String ? email : '',
      ownerId: ownerId is String && ownerId.trim().isNotEmpty ? ownerId : null,
      backendOrigin: normalizeBackendOrigin(baseUrl),
    );
  }

  Never _mapDioError(DioException e) {
    final message = describeDioException(e);
    switch (classifyDioException(e)) {
      case DioErrorCategory.cancelled:
        throw const AuthNetworkError('cancelled');
      case DioErrorCategory.badResponse:
        final status = e.response?.statusCode;
        switch (status) {
          case 401:
            throw AuthUnauthorized(message, statusCode: status);
          case 409:
            throw AuthEmailTaken(message, statusCode: status);
          case 400:
            // better-auth returns 422 for most validation / credential errors;
            // 400 covers the remaining malformed-request family.
            throw AuthInvalidCredentials(message, statusCode: status);
          case 422:
            throw AuthInvalidCredentials(message, statusCode: status);
          default:
            throw AuthServerError(message, statusCode: status);
        }
      case DioErrorCategory.timeoutNetwork:
      case DioErrorCategory.other:
        throw AuthNetworkError(message);
    }
  }
}
