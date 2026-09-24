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
  ///
  /// Empty when the server created no session (C2 tokenless sign-up: email
  /// verification gates sign-in, so a fresh account has no token yet). Callers
  /// must not mint an API key from an empty token.
  final String token;

  /// The account email.
  final String email;
}

/// Base class for all errors surfaced by [AuthClient].
sealed class AuthApiError implements Exception {
  const AuthApiError(this.message, {this.statusCode, this.code});

  final String message;
  final int? statusCode;

  /// The better-auth error `code` from the response body, when present (e.g.
  /// `INVALID_EMAIL_OR_PASSWORD`, `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`,
  /// `PASSWORD_TOO_SHORT`). Null when the server replied without one or the
  /// failure was transport-level.
  final String? code;

  @override
  String toString() => '$runtimeType: $message';
}

/// The provided credentials were rejected (invalid email/password on sign-in).
class AuthInvalidCredentials extends AuthApiError {
  const AuthInvalidCredentials(super.message, {super.statusCode, super.code});
}

/// The email is already registered (attempted to sign up).
class AuthEmailTaken extends AuthApiError {
  const AuthEmailTaken(super.message, {super.statusCode, super.code});
}

/// The session token was rejected by the server (HTTP 401). Used later to
/// trigger a global re-authentication flow.
class AuthUnauthorized extends AuthApiError {
  const AuthUnauthorized(super.message, {super.statusCode, super.code});
}

/// The account exists but its email address has not been verified yet
/// (HTTP 403 with the better-auth `EMAIL_NOT_VERIFIED` code on sign-in).
/// Callers should route to the check-your-inbox/resend flow — not re-auth.
class AuthEmailNotVerified extends AuthApiError {
  const AuthEmailNotVerified(super.message, {super.statusCode, super.code});
}

/// A request was rate-limited (HTTP 429, e.g. the per-address
/// `send-verification-email` limiter). [retryAfterSeconds] carries the
/// server-supplied wait when known, so the UI can surface it.
class AuthRateLimited extends AuthApiError {
  const AuthRateLimited(
    super.message, {
    super.statusCode,
    super.code,
    this.retryAfterSeconds,
  });

  final int? retryAfterSeconds;
}

/// The server responded with a 4xx/5xx status not covered by the typed errors.
class AuthServerError extends AuthApiError {
  const AuthServerError(super.message, {super.statusCode, super.code});
}

/// Transport-level failure (timeout, connection refused, cancellation).
class AuthNetworkError extends AuthApiError {
  const AuthNetworkError(super.message);
}

/// Server-side session facts returned by better-auth's `get-session`.
class CurrentSession {
  const CurrentSession({required this.userId, this.email, this.expiresAt});

  /// The account's user id (better-auth `user.id`).
  final String userId;

  /// The account email (better-auth `user.email`), when present.
  final String? email;

  /// When the server session expires (`session.expiresAt`), when present.
  final DateTime? expiresAt;
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

/// One API-key record as returned by `GET /api/auth/api-key/list`.
///
/// The plaintext `key` is never included in the list response — only its
/// [start] (first few characters) so a client can correlate a listed record
/// against a locally stored key without exposing the secret.
class ApiKeyListEntry {
  const ApiKeyListEntry({
    required this.id,
    this.start,
    this.enabled,
    this.createdAt,
    this.expiresAt,
  });

  /// The key record id (better-auth `apikey.id`).
  final String id;

  /// First N characters of the plaintext key (server default: 6), when the
  /// server stores starting characters. Used to match a listed record to the
  /// locally persisted key.
  final String? start;

  /// Whether the key is still active server-side. Null when the field is
  /// absent; treat null as active.
  final bool? enabled;

  /// When the key was created server-side (backfill source for legacy
  /// installs that predate `AuthCredentials.mintedAt`).
  final DateTime? createdAt;

  /// When the key expires server-side, when known.
  final DateTime? expiresAt;
}

/// Contract for the better-auth REST client. Extracted so providers and tests
/// can inject a fake without coupling to the Dio-backed implementation.
abstract interface class AuthClient {
  /// Registers a new account. The returned session may have an empty
  /// [AuthSession.token] (C2: sign-up is deferred until email verification),
  /// in which case no session exists and no API key can be minted.
  Future<AuthSession> signUp({
    required String name,
    required String email,
    required String password,
  });

  /// Signs in an existing account and returns an authenticated session.
  Future<AuthSession> signIn({required String email, required String password});

  /// Signs out, revoking [sessionToken] on the server.
  Future<void> signOut({required String sessionToken});

  /// Deletes the signed-in account (`POST /api/auth/delete-user`, M12),
  /// confirmed by [password]. Session-authed: [sessionToken] is sent as the
  /// bearer and an explicit `Origin` header is attached (better-auth 403s a
  /// missing Origin with `MISSING_OR_NULL_ORIGIN`, and Dio does not attach
  /// one on native). On 200 the server cascades apikey/notify/ledger rows.
  ///
  /// Throws [AuthUnauthorized] on 401 `UNAUTHORIZED` and on 400
  /// `SESSION_EXPIRED` (stale session — re-auth), [AuthInvalidCredentials]
  /// with code `INVALID_PASSWORD` on a wrong password, [AuthNetworkError] on
  /// transport failure (nothing was deleted), and [AuthServerError] on other
  /// 4xx/5xx (incl. 403 `MISSING_OR_NULL_ORIGIN`).
  Future<void> deleteAccount({
    required String sessionToken,
    required String password,
  });

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

  /// Lists the account's API-key records (`GET /api/auth/api-key/list`,
  /// bearer-signed). Plaintext key material is never returned — only ids,
  /// creation/expiry timestamps, and the short [ApiKeyListEntry.start]
  /// prefix. An empty [sessionToken] short-circuits to `[]` without a
  /// request (C1 tokenless sign-up sentinel). Throws [AuthUnauthorized] on
  /// HTTP 401 and [AuthServerError] on a malformed payload.
  Future<List<ApiKeyListEntry>> listApiKeys({required String sessionToken});

  /// Asks the server to email a password-reset link for [email].
  ///
  /// The endpoint always answers success for registered and unregistered
  /// addresses alike (anti-enumeration), so a healthy call returns normally
  /// even when no account matches.
  Future<void> requestPasswordReset({required String email});

  /// Asks the server to re-send the email-verification link for [email]
  /// (`POST /api/auth/send-verification-email`).
  ///
  /// Throws [AuthRateLimited] when the per-address limiter rejects the
  /// request (HTTP 429, `RATE_LIMIT_EXCEEDED`, `retryAfterSeconds` = 60).
  Future<void> sendVerificationEmail({required String email});

  /// Fetches the server's current session for [sessionToken]
  /// (`GET /api/auth/get-session`, bearer-signed like the other session
  /// endpoints).
  ///
  /// H2 client half: a live answer slides the server-side session window
  /// (`expiresAt` refreshed in the DB WITHOUT rotating the token), so pinging
  /// while the app is active keeps the stored session valid. Returns the
  /// parsed session, or null when the session is absent or expired —
  /// better-auth answers `200 null` for an expired/unknown session and
  /// rejects a bad bearer with 401; both mean "no session", not an error. An
  /// empty [sessionToken] (the C1 no-session sentinel from a tokenless
  /// sign-up) short-circuits to null without a request. Transport failures
  /// surface as [AuthNetworkError], like every other method.
  Future<CurrentSession?> getSession({required String sessionToken});
}

/// better-auth REST client over the shared [Dio].
///
/// Endpoints follow better-auth's default REST layout under the `/api/auth`
/// base path:
///   - `POST /api/auth/sign-up/email`  body {name, email, password}
///   - `POST /api/auth/sign-in/email`  body {email, password}
///   - `POST /api/auth/sign-out`       (bearer session token)
///   - `GET  /api/auth/get-session`    (bearer session token; H2 keep-alive ping)
///   - `POST /api/auth/api-key/create` (bearer session token)
///   - `POST /api/auth/api-key/delete` (bearer session token; body {keyId})
///   - `GET  /api/auth/api-key/list`   (bearer session token)
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

  /// Path to the API-key list endpoint. Isolated alongside [_mintKeyUri].
  Uri _listKeysUri() => Uri.parse('$_endpoint/api-key/list');

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
  Future<void> deleteAccount({
    required String sessionToken,
    required String password,
  }) async {
    // better-auth's sensitive-session middleware rejects a state-changing
    // auth request without an Origin matching the server origin with 403
    // MISSING_OR_NULL_ORIGIN. Dio does not attach Origin on native, so it is
    // set explicitly to this client's configured backend origin.
    final response = await _post(
      '$_endpoint/delete-user',
      body: <String, Object?>{'password': password},
      bearer: sessionToken.isEmpty ? null : sessionToken,
      headers: <String, Object?>{
        'Origin': normalizeBackendOrigin(baseUrl) ?? baseUrl,
      },
    );
    final data = response.data;
    if (data?['success'] != true) {
      throw const AuthServerError('malformed delete-user response');
    }
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

  @override
  Future<List<ApiKeyListEntry>> listApiKeys({
    required String sessionToken,
  }) async {
    // C1's no-session sentinel: nothing to authorize a list request with.
    if (sessionToken.isEmpty) return const [];
    final response = await _get(_listKeysUri().toString(), bearer: sessionToken);
    final data = response.data;
    if (data is! Map<String, dynamic>) {
      throw const AuthServerError('malformed api-key list response');
    }
    final raw = data['apiKeys'];
    if (raw is! List<Object?>) {
      throw const AuthServerError('malformed api-key list response');
    }
    final entries = <ApiKeyListEntry>[];
    for (final item in raw) {
      if (item is! Map<String, dynamic>) {
        throw const AuthServerError('malformed api-key list response');
      }
      final id = item['id'];
      if (id is! String || id.isEmpty) {
        throw const AuthServerError('malformed api-key list response');
      }
      entries.add(
        ApiKeyListEntry(
          id: id,
          start: item['start'] is String && (item['start'] as String).isNotEmpty
              ? item['start'] as String
              : null,
          enabled: item['enabled'] is bool ? item['enabled'] as bool : null,
          createdAt: _parseExpiresAt(item['createdAt']),
          expiresAt: _parseExpiresAt(item['expiresAt']),
        ),
      );
    }
    return entries;
  }

  @override
  Future<void> requestPasswordReset({required String email}) async {
    final response = await _post(
      '$_endpoint/request-password-reset',
      body: <String, Object?>{'email': email},
    );
    final status = response.data?['status'];
    if (status is! bool || !status) {
      throw const AuthServerError('malformed request-password-reset response');
    }
  }

  @override
  Future<void> sendVerificationEmail({required String email}) async {
    // better-auth answers {status: true} on success and rejects with 429
    // RATE_LIMIT_EXCEEDED under the per-address limiter (mapped to
    // AuthRateLimited below). The body is not validated: the endpoint is
    // anti-enumeration friendly, so reaching a 2xx is the success signal.
    await _post(
      '$_endpoint/send-verification-email',
      body: <String, Object?>{'email': email},
    );
  }

  @override
  Future<CurrentSession?> getSession({required String sessionToken}) async {
    // C1's no-session sentinel: a tokenless sign-up created no session, so
    // there is nothing to fetch or slide — short-circuit without a request.
    if (sessionToken.isEmpty) return null;
    final Response<Object?> response;
    try {
      response = await _get('$_endpoint/get-session', bearer: sessionToken);
    } on AuthUnauthorized {
      // A rejected/expired bearer means "no session", not an error (H2):
      // the caller treats it exactly like the 200-null verdict.
      return null;
    }
    final data = response.data;
    // better-auth answers a bare JSON null when the session is absent or has
    // just expired (it deletes the session row/cookie alongside).
    if (data == null) return null;
    if (data is! Map<String, dynamic>) {
      throw const AuthServerError('malformed get-session response');
    }
    final session = data['session'];
    final user = data['user'];
    if (session is! Map<String, dynamic> || user is! Map<String, dynamic>) {
      throw const AuthServerError('malformed get-session response');
    }
    final userId = user['id'];
    if (userId is! String || userId.isEmpty) {
      throw const AuthServerError('malformed get-session response');
    }
    final email = user['email'];
    return CurrentSession(
      userId: userId,
      email: email is String && email.isNotEmpty ? email : null,
      expiresAt: _parseExpiresAt(session['expiresAt']),
    );
  }

  /// `session.expiresAt` (and api-key `createdAt`/`expiresAt`) arrive as
  /// ISO-8601 strings (JSON-encoded Date); tolerate an epoch-millis number
  /// for forward compatibility.
  static DateTime? _parseExpiresAt(Object? raw) {
    if (raw is String) return DateTime.tryParse(raw);
    if (raw is num) return DateTime.fromMillisecondsSinceEpoch(raw.toInt());
    return null;
  }

  Future<Response<Map<String, dynamic>>> _post(
    String path, {
    required Map<String, Object?> body,
    String? bearer,
    Map<String, Object?> headers = const <String, Object?>{},
  }) async {
    try {
      return await _dio.post<Map<String, dynamic>>(
        path,
        data: body,
        options: Options(
          headers: <String, Object?>{
            ...headers,
            if (bearer != null) 'Authorization': 'Bearer $bearer',
          },
          connectTimeout: _connectTimeout,
          receiveTimeout: _receiveTimeout,
        ),
      );
    } on DioException catch (e) {
      throw _mapDioError(e);
    }
  }

  Future<Response<Object?>> _get(String path, {String? bearer}) async {
    try {
      return await _dio.get<Object?>(
        path,
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
    // C2: a fresh sign-up answers `token: null` (autoSignIn is disabled until
    // email verification) — an absent session is a VALID outcome, normalized
    // to an empty token rather than an error. Callers branch on the empty
    // token to skip key minting.
    final rawToken = data?['token'];
    final token = rawToken is String && rawToken.isNotEmpty ? rawToken : '';
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
    final code = _errorCode(e);
    switch (classifyDioException(e)) {
      case DioErrorCategory.cancelled:
        throw const AuthNetworkError('cancelled');
      case DioErrorCategory.badResponse:
        final status = e.response?.statusCode;
        switch (status) {
          case 401:
            // Sign-in with bad credentials is a 401 carrying an explicit
            // INVALID_EMAIL_OR_PASSWORD code; surface it as a credential
            // error, not a session rejection.
            if (code == 'INVALID_EMAIL_OR_PASSWORD') {
              throw AuthInvalidCredentials(message, statusCode: status, code: code);
            }
            throw AuthUnauthorized(message, statusCode: status, code: code);
          case 403:
            // C2: sign-in of an unverified account is a 403 carrying the
            // better-auth EMAIL_NOT_VERIFIED code (message match as a
            // fallback). Distinct from auth failure: the UI must offer the
            // check-inbox/resend flow, not re-auth.
            if (code == 'EMAIL_NOT_VERIFIED' || _isEmailNotVerifiedMessage(e)) {
              throw AuthEmailNotVerified(
                message,
                statusCode: status,
                code: code ?? 'EMAIL_NOT_VERIFIED',
              );
            }
            throw AuthServerError(message, statusCode: status, code: code);
          case 429:
            // The per-address verification-email limiter (and better-auth's
            // global limiter) answer 429; surface the wait when provided.
            throw AuthRateLimited(
              message,
              statusCode: status,
              code: code,
              retryAfterSeconds: _retryAfterSeconds(e),
            );
          case 409:
            throw AuthEmailTaken(message, statusCode: status, code: code);
          case 400:
          case 422:
            // M12: delete-user rejects a stale (non-fresh) session with 400
            // SESSION_EXPIRED — re-auth semantics, not a credential failure.
            if (code == 'SESSION_EXPIRED') {
              throw AuthUnauthorized(message, statusCode: status, code: code);
            }
            // better-auth rejects a duplicate sign-up with 422 and an explicit
            // USER_ALREADY_EXISTS* code; map it to the typed duplicate-email
            // error so the UI can offer "Sign in instead". Everything else in
            // this family (invalid email, password policy) is a credential
            // error.
            if (_isEmailTaken(code)) {
              throw AuthEmailTaken(message, statusCode: status, code: code);
            }
            throw AuthInvalidCredentials(message, statusCode: status, code: code);
          default:
            throw AuthServerError(message, statusCode: status, code: code);
        }
      case DioErrorCategory.timeoutNetwork:
      case DioErrorCategory.other:
        throw AuthNetworkError(message);
    }
  }

  /// Extracts better-auth's error `code` from a response body. The wire shape
  /// is `{"message", "code"}`; an outer `{"error": {...}}` wrapper is also
  /// tolerated for forward compatibility.
  static String? _errorCode(DioException e) {
    final data = e.response?.data;
    if (data is! Map<String, dynamic>) return null;
    final code = data['code'];
    if (code is String && code.isNotEmpty) return code;
    final error = data['error'];
    if (error is Map<String, dynamic>) {
      final nested = error['code'];
      if (nested is String && nested.isNotEmpty) return nested;
    }
    return null;
  }

  static bool _isEmailTaken(String? code) =>
      code != null && code.startsWith('USER_ALREADY_EXISTS');

  /// Fallback match for a 403 whose body carries the unverified-account
  /// message but no parseable code (the code check is primary).
  static bool _isEmailNotVerifiedMessage(DioException e) {
    final data = e.response?.data;
    if (data is! Map<String, dynamic>) return false;
    final message = data['message'];
    return message is String && message.toLowerCase().contains('not verified');
  }

  /// Extracts the server-supplied wait from a 429: the body's
  /// `retryAfterSeconds` field first (the resend limiter's shape), then the
  /// `Retry-After` header as a fallback.
  static int? _retryAfterSeconds(DioException e) {
    final data = e.response?.data;
    if (data is Map<String, dynamic>) {
      final value = data['retryAfterSeconds'];
      if (value is num) return value.toInt();
    }
    final header = e.response?.headers.value('retry-after');
    return header == null ? null : int.tryParse(header);
  }
}
