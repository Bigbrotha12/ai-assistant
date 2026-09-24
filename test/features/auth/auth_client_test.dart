import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';

import 'package:ai_assistant/features/auth/data/auth_client.dart';

const _base = 'http://192.168.1.5:17600';

/// Fresh [Dio] wired to a mock adapter that matches on URL path only.
(Dio, DioAdapter) makeDio() {
  final dio = Dio();
  final adapter = DioAdapter(dio: dio, matcher: const UrlRequestMatcher());
  return (dio, adapter);
}

BetterAuthClient _client(Dio dio) => BetterAuthClient(baseUrl: _base, dio: dio);

/// Captures every actual request (path/headers/body) so tests can assert on
/// what was sent, and returns a scripted response. The body may be null to
/// script a bare JSON-null payload (e.g. get-session's expired verdict).
class _CaptureAdapter implements HttpClientAdapter {
  _CaptureAdapter({this.body = const {}});

  final int statusCode = 200;
  final Object? body;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return ResponseBody.fromString(
      jsonEncode(body),
      statusCode,
      headers: const {
        'content-type': ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test(
    'missing or malformed user id never falls back to email or key id',
    () async {
      for (final id in [null, '', '  ', 123]) {
        final adapter = _CaptureAdapter(
          body: {
            'token': 'session',
            'id': 'key-id',
            'user': {'email': 'user@example.com', 'id': id},
          },
        );
        final dio = Dio()..httpClientAdapter = adapter;
        final session = await _client(dio)
            .signIn(email: 'user@example.com', password: 'test');
        expect(session.ownerId, isNull);
        expect(session.backendOrigin, _base);
      }
    },
  );

  group('signUp', () {
    test('posts name/email/password and parses the session token', () async {
      final adapter = _CaptureAdapter(
        body: {
          'token': 'tok-123',
          'id': 'not-the-owner',
          'user': {'email': 'a@b.c', 'id': 'owner-123'},
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio)
          .signUp(name: 'Ada', email: 'a@b.c', password: 'p@ss');

      expect(session.token, 'tok-123');
      expect(session.email, 'a@b.c');
      expect(session.ownerId, 'owner-123');
      expect(session.backendOrigin, _base);

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/sign-up/email');
      final body = req.data as Map<String, dynamic>;
      expect(body['name'], 'Ada');
      expect(body['email'], 'a@b.c');
      expect(body['password'], 'p@ss');
    });

    test('maps HTTP 200 sign-up as success (DioAdapter)', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-up/email',
        (r) => r.reply(200, {
          'token': 'tok',
          'user': {'email': 'a@b.c'},
        }),
      );

      final session = await _client(dio)
          .signUp(name: 'Ada', email: 'a@b.c', password: 'p@ss');

      expect(session.token, 'tok');
      expect(session.email, 'a@b.c');
    });

    test('parses a tokenless sign-up (token: null) without throwing', () async {
      // C2: autoSignIn is disabled, so a fresh sign-up answers token: null
      // and creates no session. The parse must accept it (empty token) and
      // still extract the user identity.
      final adapter = _CaptureAdapter(
        body: {
          'token': null,
          'user': {'email': 'a@b.c', 'id': 'owner-1'},
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio)
          .signUp(name: 'Ada', email: 'a@b.c', password: 'p@ss');

      expect(session.token, '');
      expect(session.email, 'a@b.c');
      expect(session.ownerId, 'owner-1');
      expect(session.backendOrigin, _base);
    });

    test('throws AuthEmailTaken on a 409 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-up/email',
        (r) => r.reply(409, {'message': 'User already exists'}),
      );

      await expectLater(
        _client(dio).signUp(name: 'Ada', email: 'a@b.c', password: 'p'),
        throwsA(isA<AuthEmailTaken>()),
      );
    });

    test(
      'maps a 422 duplicate-email sign-up to AuthEmailTaken with its code',
      () async {
        // better-auth (1.7.x) rejects a duplicate sign-up with 422 and an
        // explicit USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL code.
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/sign-up/email',
          (r) => r.reply(422, {
            'message': 'User already exists. Use another email.',
            'code': 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
          }),
        );

        await expectLater(
          _client(dio).signUp(name: 'Ada', email: 'a@b.c', password: 'p'),
          throwsA(
            isA<AuthEmailTaken>()
                .having((e) => e.statusCode, 'statusCode', 422)
                .having(
                  (e) => e.code,
                  'code',
                  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
                ),
          ),
        );
      },
    );

    test(
      'maps a 400 password-policy violation to AuthInvalidCredentials',
      () async {
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/sign-up/email',
          (r) => r.reply(400, {
            'message': 'Password too short',
            'code': 'PASSWORD_TOO_SHORT',
          }),
        );

        await expectLater(
          _client(dio).signUp(name: 'Ada', email: 'a@b.c', password: 'p'),
          throwsA(
            isA<AuthInvalidCredentials>().having(
              (e) => e.code,
              'code',
              'PASSWORD_TOO_SHORT',
            ),
          ),
        );
      },
    );

    test('throws AuthServerError on a 500 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-up/email',
        (r) => r.reply(500, {'message': 'boom'}),
      );

      await expectLater(
        _client(dio).signUp(name: 'Ada', email: 'a@b.c', password: 'p'),
        throwsA(
          isA<AuthServerError>().having((e) => e.statusCode, 'statusCode', 500),
        ),
      );
    });
  });

  group('signIn', () {
    test('posts email/password and parses the session token', () async {
      final adapter = _CaptureAdapter(
        body: {
          'token': 'session-xyz',
          'user': {'email': 'a@b.c'},
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio)
          .signIn(email: 'a@b.c', password: 'p@ss');

      expect(session.token, 'session-xyz');

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/sign-in/email');
      final body = req.data as Map<String, dynamic>;
      expect(body['email'], 'a@b.c');
      expect(body['password'], 'p@ss');
    });

    test('maps HTTP 200 sign-in as success (DioAdapter)', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-in/email',
        (r) => r.reply(200, {
          'token': 'tok',
          'user': {'email': 'a@b.c'},
        }),
      );

      final session = await _client(dio).signIn(email: 'a@b.c', password: 'p');
      expect(session.token, 'tok');
      expect(session.email, 'a@b.c');
    });

    test('throws AuthInvalidCredentials on HTTP 422', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-in/email',
        (r) => r.reply(422, {'message': 'Invalid email or password'}),
      );

      await expectLater(
        _client(dio).signIn(email: 'a@b.c', password: 'wrong'),
        throwsA(isA<AuthInvalidCredentials>()),
      );
    });

    test('throws AuthUnauthorized on HTTP 401', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-in/email',
        (r) => r.reply(401, {'message': 'Unauthorized'}),
      );

      await expectLater(
        _client(dio).signIn(email: 'a@b.c', password: 'wrong'),
        throwsA(isA<AuthUnauthorized>()),
      );
    });

    test(
      'maps a 403 EMAIL_NOT_VERIFIED sign-in to AuthEmailNotVerified',
      () async {
        // C2: signing in before the email is verified is a 403 with the
        // better-auth EMAIL_NOT_VERIFIED code — distinct from a credential or
        // session failure so the UI can offer check-inbox/resend.
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/sign-in/email',
          (r) => r.reply(403, {
            'message': 'Email not verified',
            'code': 'EMAIL_NOT_VERIFIED',
          }),
        );

        await expectLater(
          _client(dio).signIn(email: 'a@b.c', password: 'secret123'),
          throwsA(
            isA<AuthEmailNotVerified>()
                .having((e) => e.statusCode, 'statusCode', 403)
                .having((e) => e.code, 'code', 'EMAIL_NOT_VERIFIED'),
          ),
        );
      },
    );

    test('maps a 403 account_deleted response to AuthAccountDeleted', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-in/email',
        (r) => r.reply(403, {'error': 'account_deleted'}),
      );

      await expectLater(
        _client(dio).signIn(email: 'a@b.c', password: 'secret123'),
        throwsA(
          isA<AuthAccountDeleted>()
              .having((e) => e.statusCode, 'statusCode', 403)
              .having((e) => e.code, 'code', 'account_deleted'),
        ),
      );
    });

    test(
      'a 403 without the verification signal stays a server error',
      () async {
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/sign-in/email',
          (r) => r.reply(403, {'message': 'Forbidden'}),
        );

        await expectLater(
          _client(dio).signIn(email: 'a@b.c', password: 'secret123'),
          throwsA(
            isA<AuthServerError>().having(
              (e) => e.statusCode,
              'statusCode',
              403,
            ),
          ),
        );
      },
    );

    test(
      'maps a 401 INVALID_EMAIL_OR_PASSWORD sign-in to AuthInvalidCredentials',
      () async {
        // Wrong credentials surface as 401 with an explicit code; this is a
        // credential error ("Incorrect email or password"), not a session
        // rejection.
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/sign-in/email',
          (r) => r.reply(401, {
            'message': 'Invalid email or password',
            'code': 'INVALID_EMAIL_OR_PASSWORD',
          }),
        );

        await expectLater(
          _client(dio).signIn(email: 'a@b.c', password: 'wrong'),
          throwsA(
            isA<AuthInvalidCredentials>()
                .having((e) => e.statusCode, 'statusCode', 401)
                .having((e) => e.code, 'code', 'INVALID_EMAIL_OR_PASSWORD'),
          ),
        );
      },
    );
  });

  group('signOut', () {
    test('sends the bearer session token', () async {
      final adapter = _CaptureAdapter(body: {'success': true});
      final dio = Dio()..httpClientAdapter = adapter;

      await _client(dio).signOut(sessionToken: 'tok-1');

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/sign-out');
      expect(req.headers['Authorization'], 'Bearer tok-1');
    });

    test('throws AuthUnauthorized on HTTP 401', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-out',
        (r) => r.reply(401, {'message': 'Unauthorized'}),
      );

      await expectLater(
        _client(dio).signOut(sessionToken: 'tok'),
        throwsA(isA<AuthUnauthorized>()),
      );
    });
  });

  group('mintApiKey', () {
    test('sends the bearer session token and parses key + id', () async {
      final adapter = _CaptureAdapter(
        body: {'key': 'sk_abc123_full_key', 'id': 'key-id-7'},
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final minted = await _client(dio).mintApiKey(sessionToken: 'tok-2');

      expect(minted.key, 'sk_abc123_full_key');
      expect(minted.id, 'key-id-7');
      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/api-key/create');
      expect(req.headers['Authorization'], 'Bearer tok-2');
    });

    test('throws AuthServerError when the response omits the key', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/api-key/create',
        (r) => r.reply(200, {'id': 'key-id-1'}),
      );

      await expectLater(
        _client(dio).mintApiKey(sessionToken: 'tok'),
        throwsA(isA<AuthServerError>()),
      );
    });

    test('throws AuthServerError when the response omits the id', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/api-key/create',
        (r) => r.reply(200, {'key': 'sk_abc123_full_key'}),
      );

      await expectLater(
        _client(dio).mintApiKey(sessionToken: 'tok'),
        throwsA(isA<AuthServerError>()),
      );
    });

    test('throws AuthUnauthorized on HTTP 401', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/api-key/create',
        (r) => r.reply(401, {'message': 'Unauthorized'}),
      );

      await expectLater(
        _client(dio).mintApiKey(sessionToken: 'tok'),
        throwsA(isA<AuthUnauthorized>()),
      );
    });
  });

  group('revokeApiKey', () {
    test('sends bearer token and keyId to the delete endpoint', () async {
      final adapter = _CaptureAdapter(body: {'success': true});
      final dio = Dio()..httpClientAdapter = adapter;

      await _client(dio).revokeApiKey(sessionToken: 'tok-3', keyId: 'key-9');

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/api-key/delete');
      expect(req.headers['Authorization'], 'Bearer tok-3');
      final body = req.data as Map<String, dynamic>;
      expect(body['keyId'], 'key-9');
    });
  });

  group('requestPasswordReset', () {
    test('posts the email to the request endpoint and reads status', () async {
      final adapter = _CaptureAdapter(body: {'status': true});
      final dio = Dio()..httpClientAdapter = adapter;

      await _client(dio).requestPasswordReset(email: 'a@b.c');

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/request-password-reset');
      final body = req.data as Map<String, dynamic>;
      expect(body['email'], 'a@b.c');
    });

    test(
      'always succeeds for a 200 status true (even an unknown account)',
      () async {
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/request-password-reset',
          (r) => r.reply(200, {
            'status': true,
            'message': 'If this email exists in our system, check your email for the reset link',
          }),
        );

        await expectLater(
          _client(dio).requestPasswordReset(email: 'ghost@example.com'),
          completes,
        );
      },
    );

    test(
      'throws AuthServerError when the response status is not true',
      () async {
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/request-password-reset',
          (r) => r.reply(200, {'status': false}),
        );

        await expectLater(
          _client(dio).requestPasswordReset(email: 'a@b.c'),
          throwsA(isA<AuthServerError>()),
        );
      },
    );

    test('maps a 422 validation error to AuthInvalidCredentials', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/request-password-reset',
        (r) => r.reply(422, {
          'message': 'Invalid email',
          'code': 'VALIDATION_ERROR',
        }),
      );

      await expectLater(
        _client(dio).requestPasswordReset(email: 'not-an-email'),
        throwsA(isA<AuthInvalidCredentials>()),
      );
    });
  });

  group('sendVerificationEmail', () {
    test('posts the email to the send-verification endpoint', () async {
      final adapter = _CaptureAdapter(body: {'status': true});
      final dio = Dio()..httpClientAdapter = adapter;

      await _client(dio).sendVerificationEmail(email: 'a@b.c');

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/send-verification-email');
      final body = req.data as Map<String, dynamic>;
      expect(body['email'], 'a@b.c');
    });

    test(
      'maps a 429 RATE_LIMIT_EXCEEDED to AuthRateLimited with the wait',
      () async {
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/send-verification-email',
          (r) => r.reply(429, {
            'message':
                'Too many verification emails requested for this address. '
                'Try again in a minute.',
            'code': 'RATE_LIMIT_EXCEEDED',
            'retryAfterSeconds': 60,
          }),
        );

        await expectLater(
          _client(dio).sendVerificationEmail(email: 'a@b.c'),
          throwsA(
            isA<AuthRateLimited>()
                .having((e) => e.statusCode, 'statusCode', 429)
                .having((e) => e.code, 'code', 'RATE_LIMIT_EXCEEDED')
                .having((e) => e.retryAfterSeconds, 'retryAfterSeconds', 60),
          ),
        );
      },
    );
  });

  group('getSession', () {
    test('sends the bearer token and parses the session', () async {
      final adapter = _CaptureAdapter(
        body: {
          'session': {'id': 'sess-1', 'expiresAt': '2026-10-24T00:00:00.000Z'},
          'user': {'id': 'owner-9', 'email': 'a@b.c'},
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio).getSession(sessionToken: 'tok-7');

      expect(session, isNotNull);
      expect(session!.userId, 'owner-9');
      expect(session.email, 'a@b.c');
      expect(session.expiresAt, DateTime.utc(2026, 10, 24));
      final req = adapter.requests.single;
      expect(req.method, 'GET');
      expect(req.path, '$_base/api/auth/get-session');
      expect(req.headers['Authorization'], 'Bearer tok-7');
    });

    test('maps a 200 null body (absent/expired session) to null', () async {
      // better-auth answers a bare JSON null when the session is absent or
      // has just expired — "no session", not an error (H2).
      final adapter = _CaptureAdapter(body: null);
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio).getSession(sessionToken: 'tok-exp');

      expect(session, isNull);
      expect(adapter.requests, hasLength(1));
    });

    test('maps HTTP 401 to null (rejected session is not an error)', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        '$_base/api/auth/get-session',
        (r) => r.reply(401, {'message': 'Unauthorized'}),
      );

      final session = await _client(dio).getSession(sessionToken: 'tok-bad');

      expect(session, isNull);
    });

    test('an empty session token short-circuits without a request', () async {
      // C1's tokenless sign-up sentinel: no session exists, so there is
      // nothing to ping.
      final adapter = _CaptureAdapter(
        body: {
          'session': {'id': 'sess-1'},
          'user': {'id': 'owner-9'},
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio).getSession(sessionToken: '');

      expect(session, isNull);
      expect(adapter.requests, isEmpty);
    });

    test('maps a connection failure to AuthNetworkError', () async {
      final dio = Dio()
        ..httpClientAdapter = _FailingAdapter(DioExceptionType.connectionError);

      await expectLater(
        _client(dio).getSession(sessionToken: 'tok'),
        throwsA(isA<AuthNetworkError>()),
      );
    });

    test('rejects a malformed body with AuthServerError', () async {
      final adapter = _CaptureAdapter(body: {'unexpected': true});
      final dio = Dio()..httpClientAdapter = adapter;

      await expectLater(
        _client(dio).getSession(sessionToken: 'tok'),
        throwsA(isA<AuthServerError>()),
      );
    });
  });

  group('listApiKeys', () {
    test('sends the bearer token and parses the entry list', () async {
      final adapter = _CaptureAdapter(
        body: {
          'apiKeys': [
            {
              'id': 'key-1',
              'start': 'sk_abc',
              'enabled': true,
              'createdAt': '2026-01-15T10:00:00.000Z',
              'expiresAt': '2026-04-15T10:00:00.000Z',
            },
            {
              'id': 'key-2',
              'start': 'sk_def',
              'enabled': false,
              'createdAt': '2025-11-01T08:00:00.000Z',
            },
          ],
          'total': 2,
          'limit': 10,
          'offset': 0,
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final entries = await _client(dio).listApiKeys(sessionToken: 'tok-8');

      expect(entries, hasLength(2));
      expect(entries[0].id, 'key-1');
      expect(entries[0].start, 'sk_abc');
      expect(entries[0].enabled, isTrue);
      expect(entries[0].createdAt, DateTime.utc(2026, 1, 15, 10));
      expect(entries[0].expiresAt, DateTime.utc(2026, 4, 15, 10));
      expect(entries[1].id, 'key-2');
      expect(entries[1].enabled, isFalse);
      expect(entries[1].createdAt, DateTime.utc(2025, 11, 1, 8));
      expect(entries[1].expiresAt, isNull);

      final req = adapter.requests.single;
      expect(req.method, 'GET');
      expect(req.path, '$_base/api/auth/api-key/list');
      expect(req.headers['Authorization'], 'Bearer tok-8');
    });

    test('an empty session token short-circuits without a request', () async {
      final adapter = _CaptureAdapter(body: {'apiKeys': [], 'total': 0});
      final dio = Dio()..httpClientAdapter = adapter;

      final entries = await _client(dio).listApiKeys(sessionToken: '');

      expect(entries, isEmpty);
      expect(adapter.requests, isEmpty);
    });

    test('throws AuthUnauthorized on HTTP 401', () async {
      final (dio, adapter) = makeDio();
      adapter.onGet(
        '$_base/api/auth/api-key/list',
        (r) => r.reply(401, {'message': 'Unauthorized'}),
      );

      await expectLater(
        _client(dio).listApiKeys(sessionToken: 'tok-bad'),
        throwsA(isA<AuthUnauthorized>()),
      );
    });

    test('throws AuthServerError on a malformed payload', () async {
      final adapter = _CaptureAdapter(body: {'apiKeys': 'nope'});
      final dio = Dio()..httpClientAdapter = adapter;

      await expectLater(
        _client(dio).listApiKeys(sessionToken: 'tok'),
        throwsA(isA<AuthServerError>()),
      );
    });

    test('throws AuthServerError when an entry lacks an id', () async {
      final adapter = _CaptureAdapter(
        body: {
          'apiKeys': [
            {'start': 'sk_abc'},
          ],
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      await expectLater(
        _client(dio).listApiKeys(sessionToken: 'tok'),
        throwsA(isA<AuthServerError>()),
      );
    });

    test('maps a connection failure to AuthNetworkError', () async {
      final dio = Dio()
        ..httpClientAdapter = _FailingAdapter(DioExceptionType.connectionError);

      await expectLater(
        _client(dio).listApiKeys(sessionToken: 'tok'),
        throwsA(isA<AuthNetworkError>()),
      );
    });
  });

  group('deleteAccount', () {
    test(
      'posts password with bearer session + Origin and reads success',
      () async {
        final adapter = _CaptureAdapter(body: {'success': true});
        final dio = Dio()..httpClientAdapter = adapter;

        await _client(dio)
            .deleteAccount(sessionToken: 'tok-9', password: 'secret123');

        final req = adapter.requests.single;
        expect(req.path, '$_base/api/auth/delete-user');
        expect(req.headers['Authorization'], 'Bearer tok-9');
        // better-auth 403s a state-changing auth request without an Origin
        // matching the server origin (MISSING_OR_NULL_ORIGIN).
        expect(req.headers['Origin'], 'http://192.168.1.5:17600');
        final body = req.data as Map<String, dynamic>;
        expect(body['password'], 'secret123');
      },
    );

    test('maps a 400 INVALID_PASSWORD to AuthInvalidCredentials', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/delete-user',
        (r) => r.reply(400, {
          'message': 'Invalid password',
          'code': 'INVALID_PASSWORD',
        }),
      );

      await expectLater(
        _client(dio).deleteAccount(sessionToken: 'tok', password: 'wrong'),
        throwsA(
          isA<AuthInvalidCredentials>()
              .having((e) => e.statusCode, 'statusCode', 400)
              .having((e) => e.code, 'code', 'INVALID_PASSWORD'),
        ),
      );
    });

    test('maps a 400 SESSION_EXPIRED to AuthUnauthorized', () async {
      // Stale (non-fresh) session — re-auth semantics, not a credential
      // failure, so the delete dialog offers "sign in again".
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/delete-user',
        (r) => r.reply(400, {
          'message': 'Session expired',
          'code': 'SESSION_EXPIRED',
        }),
      );

      await expectLater(
        _client(dio).deleteAccount(sessionToken: 'stale', password: 'p'),
        throwsA(
          isA<AuthUnauthorized>()
              .having((e) => e.statusCode, 'statusCode', 400)
              .having((e) => e.code, 'code', 'SESSION_EXPIRED'),
        ),
      );
    });

    test('throws AuthUnauthorized on HTTP 401', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/delete-user',
        (r) => r.reply(401, {'message': 'Unauthorized'}),
      );

      await expectLater(
        _client(dio).deleteAccount(sessionToken: 'bad', password: 'p'),
        throwsA(isA<AuthUnauthorized>()),
      );
    });

    test(
      'maps a 403 MISSING_OR_NULL_ORIGIN to AuthServerError with its code',
      () async {
        final (dio, adapter) = makeDio();
        adapter.onPost(
          '$_base/api/auth/delete-user',
          (r) => r.reply(403, {
            'message': 'Missing or null origin',
            'code': 'MISSING_OR_NULL_ORIGIN',
          }),
        );

        await expectLater(
          _client(dio).deleteAccount(sessionToken: 'tok', password: 'p'),
          throwsA(
            isA<AuthServerError>()
                .having((e) => e.statusCode, 'statusCode', 403)
                .having((e) => e.code, 'code', 'MISSING_OR_NULL_ORIGIN'),
          ),
        );
      },
    );

    test('maps a connection failure to AuthNetworkError', () async {
      final dio = Dio()
        ..httpClientAdapter = _FailingAdapter(DioExceptionType.connectionError);

      await expectLater(
        _client(dio).deleteAccount(sessionToken: 'tok', password: 'p'),
        throwsA(isA<AuthNetworkError>()),
      );
    });

    test('throws AuthServerError when success is not true', () async {
      final adapter = _CaptureAdapter(body: {'success': false});
      final dio = Dio()..httpClientAdapter = adapter;

      await expectLater(
        _client(dio).deleteAccount(sessionToken: 'tok', password: 'p'),
        throwsA(isA<AuthServerError>()),
      );
    });
  });

  group('network errors', () {
    test('maps a connection failure to AuthNetworkError', () async {
      final dio = Dio()
        ..httpClientAdapter = _FailingAdapter(DioExceptionType.connectionError);
      final client = _client(dio);

      await expectLater(
        client.signIn(email: 'a@b.c', password: 'p'),
        throwsA(isA<AuthNetworkError>()),
      );
    });

    test('maps a timeout to AuthNetworkError', () async {
      final dio = Dio()
        ..httpClientAdapter = _FailingAdapter(
          DioExceptionType.connectionTimeout,
        );
      final client = _client(dio);

      await expectLater(
        client.signUp(name: 'A', email: 'a@b.c', password: 'p'),
        throwsA(isA<AuthNetworkError>()),
      );
    });
  });
}

/// Adapter that always throws the given [DioExceptionType].
class _FailingAdapter implements HttpClientAdapter {
  _FailingAdapter(this.type);

  final DioExceptionType type;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    throw DioException(
      type: type,
      requestOptions: options,
      error: Exception('simulated ${type.name}'),
    );
  }

  @override
  void close({bool force = false}) {}
}
