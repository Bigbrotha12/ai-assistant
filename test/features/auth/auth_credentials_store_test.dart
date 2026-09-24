import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';

import '../../fakes.dart';

const _recordKey = 'auth_credentials_v2';
const _legacyKeys = <String>[
  'auth_api_key',
  'auth_email',
  'auth_key_id',
  'auth_session_token',
  'auth_owner_id',
  'auth_backend_origin',
  'auth_minted_at',
];

Map<String, dynamic> _storedRecord(InMemorySecureStorage storage) {
  final raw = storage.values[_recordKey];
  if (raw == null) throw StateError('missing credential record');
  return jsonDecode(raw) as Map<String, dynamic>;
}

/// In-memory [FlutterSecureStorage] double, mirroring the one in
/// `settings_store_test.dart` (not exported for reuse).
class InMemorySecureStorage extends FlutterSecureStorage {
  final Map<String, String> _values = {};

  Map<String, String> get values => Map.unmodifiable(_values);

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _values.remove(key);
  }
}

void main() {
  test(
    'identity round-trips and legacy saves remove the previous scope',
    () async {
      final storage = InMemorySecureStorage();
      final store = SecureAuthCredentialsStore(storage: storage);
      await store.save(
        const AuthCredentials(
          apiKey: 'key',
          ownerId: 'user-1',
          backendOrigin: 'HTTPS://Example.COM:443/',
        ),
      );
      final loaded = (await store.load())!;
      expect(loaded.ownerId, 'user-1');
      expect(loaded.backendOrigin, 'https://example.com');
      expect(loaded.accountScope, isNotNull);
      await store.save(const AuthCredentials(apiKey: 'legacy'));
      expect((await store.load())!.accountScope, isNull);
      expect(storage.values.containsKey('auth_owner_id'), isFalse);
      expect(storage.values.containsKey('auth_backend_origin'), isFalse);
      await store.clear();
      expect(storage.values, isEmpty);
    },
  );

  test('v2 record round-trips every credential field', () async {
    final storage = FailureInjectingSecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);
    final credentials = AuthCredentials(
      apiKey: 'sk-  exact key  ',
      email: 'a@b.c',
      keyId: 'key-42',
      sessionToken: 'tok-99',
      ownerId: 'user-1',
      backendOrigin: 'HTTPS://Example.COM:443/',
      mintedAt: DateTime.utc(2026, 6, 1, 12, 30, 45),
    );

    await store.save(credentials);

    final record =
        jsonDecode(storage.values[_recordKey]!) as Map<String, dynamic>;
    expect(record['version'], 2);
    expect(record['scope'], 'user-1');
    expect(record['origin'], 'https://example.com');
    expect(record['email'], 'a@b.c');
    expect(record['apiKey'], 'sk-  exact key  ');
    expect(record['keyId'], 'key-42');
    expect(record['sessionToken'], 'tok-99');
    expect(record['mintedAt'], credentials.mintedAt!.toIso8601String());
    expect(_legacyKeys.any(storage.values.containsKey), isFalse);
    expect(
      await store.load(),
      credentials.copyWith(backendOrigin: 'https://example.com'),
    );
  });

  test('legacy seven-key data loads and is upgraded to v2', () async {
    final legacy = <String, String>{
      'auth_api_key': 'legacy-key',
      'auth_email': 'legacy@example.com',
      'auth_key_id': 'legacy-id',
      'auth_session_token': 'legacy-token',
      'auth_owner_id': 'legacy-owner',
      'auth_backend_origin': 'https://legacy.example/',
      'auth_minted_at': '2025-01-02T03:04:05.000Z',
    };
    final storage = FailureInjectingSecureStorage(initialValues: legacy);
    final store = SecureAuthCredentialsStore(storage: storage);

    final loaded = await store.load();

    expect(
      loaded,
      AuthCredentials(
        apiKey: 'legacy-key',
        email: 'legacy@example.com',
        keyId: 'legacy-id',
        sessionToken: 'legacy-token',
        ownerId: 'legacy-owner',
        backendOrigin: 'https://legacy.example',
        mintedAt: DateTime.utc(2025, 1, 2, 3, 4, 5),
      ),
    );
    expect(storage.values[_recordKey], isNotNull);
    expect(_legacyKeys.any(storage.values.containsKey), isFalse);
  });

  test('a failed v2 write preserves all legacy data', () async {
    final legacy = <String, String>{
      'auth_api_key': 'legacy-key',
      'auth_email': 'legacy@example.com',
      'auth_key_id': 'legacy-id',
      'auth_session_token': 'legacy-token',
      'auth_owner_id': 'legacy-owner',
      'auth_backend_origin': 'https://legacy.example',
      'auth_minted_at': '2025-01-02T03:04:05.000Z',
    };
    final storage = FailureInjectingSecureStorage(initialValues: legacy)
      ..failWriteKey = _recordKey;
    final store = SecureAuthCredentialsStore(storage: storage);

    await expectLater(
      store.save(const AuthCredentials(apiKey: 'new-key')),
      throwsStateError,
    );
    expect(storage.values.length, legacy.length);
    for (final entry in legacy.entries) {
      expect(storage.values[entry.key], entry.value);
    }
    expect(storage.values.containsKey(_recordKey), isFalse);
    expect((await store.load())!.apiKey, 'legacy-key');
  });

  test(
    'a failed legacy cleanup leaves the committed v2 record usable',
    () async {
      final storage = FailureInjectingSecureStorage(
        initialValues: const {'auth_api_key': 'legacy-key'},
      )..failDeleteKey = 'auth_owner_id';
      final store = SecureAuthCredentialsStore(storage: storage);

      await expectLater(
        store.save(const AuthCredentials(apiKey: 'new-key')),
        throwsStateError,
      );

      expect(storage.values[_recordKey], isNotNull);
      expect((await store.load())!.apiKey, 'new-key');
    },
  );

  test('malformed v2 data falls back without throwing', () async {
    final legacy = <String, String>{
      'auth_api_key': 'legacy-key',
      'auth_email': 'legacy@example.com',
    };
    final storage = FailureInjectingSecureStorage(
      initialValues: {...legacy, _recordKey: '{not-json'},
    );
    final store = SecureAuthCredentialsStore(storage: storage);

    expect((await store.load())!.apiKey, 'legacy-key');
    expect(storage.values[_recordKey], isNotNull);
    expect(storage.values.containsKey('auth_api_key'), isFalse);

    final emptyStorage = FailureInjectingSecureStorage(
      initialValues: const {_recordKey: '{not-json'},
    );
    expect(
      await SecureAuthCredentialsStore(storage: emptyStorage).load(),
      isNull,
    );
  });

  test('a valid v2 record is never mixed with legacy fields', () async {
    final storage = FailureInjectingSecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);
    await store.save(
      const AuthCredentials(
        apiKey: 'new-key',
        keyId: 'new-id',
        sessionToken: 'new-token',
      ),
    );
    storage.seed(const {
      'auth_api_key': 'old-key',
      'auth_key_id': 'old-id',
      'auth_session_token': 'old-token',
    });
    storage.operations.clear();

    final loaded = await store.load();

    expect(loaded!.apiKey, 'new-key');
    expect(loaded.keyId, 'new-id');
    expect(loaded.sessionToken, 'new-token');
    expect(storage.operations, ['read:$_recordKey']);
  });

  test('concurrent save, save, load, and clear serialize in order', () async {
    final storage = FailureInjectingSecureStorage()..gate = Completer<void>();
    final store = SecureAuthCredentialsStore(storage: storage);
    final firstSave = store.save(const AuthCredentials(apiKey: 'first-key'));
    final secondSave = store.save(const AuthCredentials(apiKey: 'second-key'));
    final load = store.load();
    final clear = store.clear();

    storage.gate!.complete();
    final loaded = await load;
    await Future.wait<void>([firstSave, secondSave, clear]);

    expect(loaded!.apiKey, 'second-key');
    expect(await store.load(), isNull);
    expect(storage.values, isEmpty);
  });

  test('scope is stable, collision-safe, and requires verified identity', () {
    AuthAccountScope? scope(String? origin, String? owner) =>
        AuthAccountScope.fromIdentity(backendOrigin: origin, ownerId: owner);
    final a = scope('HTTPS://Example.COM:443/', 'user/a');
    final b = scope('https://example.com/api/auth', 'user/a');
    expect(a, b);
    expect(a!.storageId, b!.storageId);
    expect(a, isNot(scope('http://example.com', 'user/a')));
    expect(a, isNot(scope('https://example.com:8443', 'user/a')));
    expect(a, isNot(scope('https://example.com', 'user/b')));
    expect(scope('https://example.com', null), isNull);
    expect(scope('https://example.com', ' '), isNull);
    for (final origin in [
      null,
      '',
      'example.com',
      'file:///tmp',
      'https://user:password@example.com',
      'https://example.com?key=x',
    ]) {
      expect(scope(origin, 'user'), isNull);
    }
    expect(
      const AuthCredentials(apiKey: 'a', ownerId: 'u'),
      isNot(const AuthCredentials(apiKey: 'a', ownerId: 'v')),
    );
  });
  test('load returns null when nothing has been saved', () async {
    final store = SecureAuthCredentialsStore(storage: InMemorySecureStorage());

    expect(await store.load(), isNull);
  });

  test('load returns credentials with email when saved', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'));

    final record = _storedRecord(storage);
    expect(record['apiKey'], 'cake_x');
    expect(record['email'], 'a@b.c');
  });

  test('load returns null email when stored value is blank', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'));
    final record = _storedRecord(storage);
    record['email'] = '   ';
    storage._values[_recordKey] = jsonEncode(record);
    final loaded = await store.load();

    expect(loaded!.apiKey, 'cake_x');
    expect(loaded.email, isNull);
  });

  test('save with a blank email deletes the stored email', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'));
    expect(_storedRecord(storage)['email'], 'a@b.c');

    await store.save(const AuthCredentials(apiKey: 'cake_x'));

    expect(_storedRecord(storage)['email'], isNull);
    expect(storage.values.containsKey('auth_email'), isFalse);
    final loaded = await store.load();
    expect(loaded!.email, isNull);
  });

  test('api key is stored exactly as returned (never trimmed)', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    const key = 'sk-  with internal spaces  ';
    await store.save(const AuthCredentials(apiKey: key));

    expect(_storedRecord(storage)['apiKey'], key);
    expect((await store.load())!.apiKey, key);
  });

  test('save then load round-trips keyId and sessionToken', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(
      const AuthCredentials(
        apiKey: 'cake_abcdef',
        email: 'a@b.c',
        keyId: 'key-42',
        sessionToken: 'tok-99',
      ),
    );

    final record = _storedRecord(storage);
    expect(record['keyId'], 'key-42');
    expect(record['sessionToken'], 'tok-99');
    final loaded = await store.load();
    expect(
      loaded,
      const AuthCredentials(
        apiKey: 'cake_abcdef',
        email: 'a@b.c',
        keyId: 'key-42',
        sessionToken: 'tok-99',
      ),
    );
  });

  test(
    'save with a blank keyId or sessionToken deletes the stored value',
    () async {
      final storage = InMemorySecureStorage();
      final store = SecureAuthCredentialsStore(storage: storage);

      await store.save(
        const AuthCredentials(
          apiKey: 'cake_x',
          keyId: 'key-42',
          sessionToken: 'tok-99',
        ),
      );
      var record = _storedRecord(storage);
      expect(record['keyId'], 'key-42');
      expect(record['sessionToken'], 'tok-99');

      await store.save(const AuthCredentials(apiKey: 'cake_x'));

      record = _storedRecord(storage);
      expect(record['keyId'], isNull);
      expect(record['sessionToken'], isNull);
      expect(storage.values.containsKey('auth_key_id'), isFalse);
      expect(storage.values.containsKey('auth_session_token'), isFalse);
      final loaded = await store.load();
      expect(loaded!.keyId, isNull);
      expect(loaded.sessionToken, isNull);
    },
  );

  test('load treats a blank stored keyId or sessionToken as absent', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(
      const AuthCredentials(apiKey: 'cake_x', keyId: 'k', sessionToken: 't'),
    );
    final record = _storedRecord(storage);
    record['keyId'] = '   ';
    record['sessionToken'] = '   ';
    storage._values[_recordKey] = jsonEncode(record);
    final loaded = await store.load();

    expect(loaded!.apiKey, 'cake_x');
    expect(loaded.keyId, isNull);
    expect(loaded.sessionToken, isNull);
  });

  test('clear removes the keyId and sessionToken too', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(
      const AuthCredentials(
        apiKey: 'cake_x',
        email: 'a@b.c',
        keyId: 'key-42',
        sessionToken: 'tok-99',
      ),
    );
    await store.clear();

    expect(await store.load(), isNull);
    expect(storage.values, isEmpty);
  });

  test('equality includes keyId and sessionToken', () {
    const base = AuthCredentials(apiKey: 'k', email: 'a@b.c');
    const same = AuthCredentials(apiKey: 'k', email: 'a@b.c');
    const withKeyId = AuthCredentials(
      apiKey: 'k',
      email: 'a@b.c',
      keyId: 'kid',
    );
    const withToken = AuthCredentials(
      apiKey: 'k',
      email: 'a@b.c',
      sessionToken: 'tok',
    );

    expect(base, same);
    expect(base.hashCode, same.hashCode);
    expect(base, isNot(withKeyId));
    expect(base.hashCode, isNot(withKeyId.hashCode));
    expect(base, isNot(withToken));
    expect(base.hashCode, isNot(withToken.hashCode));
  });

  test('mintedAt round-trips through save/load (M12)', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);
    final mintedAt = DateTime.utc(2026, 6, 1, 12, 30, 45);

    await store.save(
      AuthCredentials(apiKey: 'cake_x', keyId: 'k1', mintedAt: mintedAt),
    );

    expect(_storedRecord(storage)['mintedAt'], mintedAt.toIso8601String());
    final loaded = await store.load();
    expect(loaded!.mintedAt, mintedAt);
  });

  test('legacy installs load mintedAt as null (field absent)', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);
    storage._values
      ..clear()
      ..['auth_api_key'] = 'cake_x';

    final loaded = await store.load();
    expect(loaded!.mintedAt, isNull);
    expect(loaded.apiKey, 'cake_x');
    expect(_storedRecord(storage)['mintedAt'], isNull);
  });

  test('saving without mintedAt deletes a previously stamped value', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);
    await store.save(
      AuthCredentials(apiKey: 'cake_x', mintedAt: DateTime.utc(2026, 1, 1)),
    );
    expect(_storedRecord(storage)['mintedAt'], isNotNull);

    await store.save(const AuthCredentials(apiKey: 'cake_x'));

    expect(_storedRecord(storage)['mintedAt'], isNull);
    expect(storage.values.containsKey('auth_minted_at'), isFalse);
    expect((await store.load())!.mintedAt, isNull);
  });

  test('clear removes mintedAt too', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);
    await store.save(
      AuthCredentials(apiKey: 'cake_x', mintedAt: DateTime.utc(2026, 1, 1)),
    );

    await store.clear();

    expect(storage.values, isEmpty);
    expect(await store.load(), isNull);
  });

  test('equality and hashCode include mintedAt', () {
    final t = DateTime.utc(2026, 3, 1);
    final a = AuthCredentials(apiKey: 'k', mintedAt: t);
    final b = AuthCredentials(apiKey: 'k', mintedAt: t);
    final c = AuthCredentials(
      apiKey: 'k',
      mintedAt: t.add(const Duration(days: 1)),
    );
    final d = const AuthCredentials(apiKey: 'k');

    expect(a, b);
    expect(a.hashCode, b.hashCode);
    expect(a, isNot(c));
    expect(a.hashCode, isNot(c.hashCode));
    expect(a, isNot(d));
    expect(a.hashCode, isNot(d.hashCode));
  });
}
