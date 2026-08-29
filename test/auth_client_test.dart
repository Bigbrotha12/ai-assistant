import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http_mock_adapter/http_mock_adapter.dart';

import 'package:ai_assistant/core/auth_client.dart';

const _base = 'http://192.168.1.5:9091';

/// Fresh [Dio] wired to a mock adapter that matches on URL path only.
(Dio, DioAdapter) makeDio() {
  final dio = Dio();
  final adapter = DioAdapter(dio: dio, matcher: const UrlRequestMatcher());
  return (dio, adapter);
}

BetterAuthClient _client(Dio dio) => BetterAuthClient(baseUrl: _base, dio: dio);

/// Captures every actual request (path/headers/body) so tests can assert on
/// what was sent, and returns a scripted response.
class _CaptureAdapter implements HttpClientAdapter {
  _CaptureAdapter({this.body = const {}});

  final int statusCode = 200;
  final Map<String, dynamic> body;
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
      headers: const {'content-type': ['application/json']},
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('signUp', () {
    test('posts name/email/password and parses the session token', () async {
      final adapter = _CaptureAdapter(
        body: {
          'token': 'tok-123',
          'user': {'email': 'a@b.c'},
        },
      );
      final dio = Dio()..httpClientAdapter = adapter;

      final session = await _client(dio).signUp(
        name: 'Ada',
        email: 'a@b.c',
        password: 'p@ss',
      );

      expect(session.token, 'tok-123');
      expect(session.email, 'a@b.c');

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

      final session = await _client(dio).signUp(
        name: 'Ada',
        email: 'a@b.c',
        password: 'p@ss',
      );

      expect(session.token, 'tok');
      expect(session.email, 'a@b.c');
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

    test('throws AuthServerError on a 500 response', () async {
      final (dio, adapter) = makeDio();
      adapter.onPost(
        '$_base/api/auth/sign-up/email',
        (r) => r.reply(500, {'message': 'boom'}),
      );

      await expectLater(
        _client(dio).signUp(name: 'Ada', email: 'a@b.c', password: 'p'),
        throwsA(
          isA<AuthServerError>()
              .having((e) => e.statusCode, 'statusCode', 500),
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

      final session = await _client(dio).signIn(
        email: 'a@b.c',
        password: 'p@ss',
      );

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

      await _client(dio)
          .revokeApiKey(sessionToken: 'tok-3', keyId: 'key-9');

      final req = adapter.requests.single;
      expect(req.path, '$_base/api/auth/api-key/delete');
      expect(req.headers['Authorization'], 'Bearer tok-3');
      final body = req.data as Map<String, dynamic>;
      expect(body['keyId'], 'key-9');
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
        ..httpClientAdapter =
            _FailingAdapter(DioExceptionType.connectionTimeout);
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
