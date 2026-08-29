import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/auth_credentials_store.dart';

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
  }) async =>
      _values[key];

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
  test('save then load round-trips credentials', () async {
    final store =
        SecureAuthCredentialsStore(storage: InMemorySecureStorage());

    await store.save(
      const AuthCredentials(apiKey: 'cake_abcdef', email: 'a@b.c'),
    );
    final loaded = await store.load();

    expect(loaded, const AuthCredentials(apiKey: 'cake_abcdef', email: 'a@b.c'));
  });

  test('load returns null when nothing has been saved', () async {
    final store =
        SecureAuthCredentialsStore(storage: InMemorySecureStorage());

    expect(await store.load(), isNull);
  });

  test('load returns credentials with email when saved', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(
      const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'),
    );

    expect(storage.values['auth_api_key'], 'cake_x');
    expect(storage.values['auth_email'], 'a@b.c');
  });

  test('load returns null email when stored value is blank', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'));
    storage._values['auth_email'] = '   ';
    final loaded = await store.load();

    expect(loaded!.apiKey, 'cake_x');
    expect(loaded.email, isNull);
  });

  test('save with a blank email deletes the stored email', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'));
    expect(storage.values.containsKey('auth_email'), isTrue);

    await store.save(const AuthCredentials(apiKey: 'cake_x'));

    expect(storage.values.containsKey('auth_email'), isFalse);
    final loaded = await store.load();
    expect(loaded!.email, isNull);
  });

  test('api key is stored exactly as returned (never trimmed)', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    const key = 'sk-  with internal spaces  ';
    await store.save(const AuthCredentials(apiKey: key));

    expect(storage.values['auth_api_key'], key);
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

    expect(storage.values['auth_key_id'], 'key-42');
    expect(storage.values['auth_session_token'], 'tok-99');
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

  test('save with a blank keyId or sessionToken deletes the stored value',
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
    expect(storage.values.containsKey('auth_key_id'), isTrue);
    expect(storage.values.containsKey('auth_session_token'), isTrue);

    await store.save(const AuthCredentials(apiKey: 'cake_x'));

    expect(storage.values.containsKey('auth_key_id'), isFalse);
    expect(storage.values.containsKey('auth_session_token'), isFalse);
    final loaded = await store.load();
    expect(loaded!.keyId, isNull);
    expect(loaded.sessionToken, isNull);
  });

  test('load treats a blank stored keyId or sessionToken as absent', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(
      const AuthCredentials(apiKey: 'cake_x', keyId: 'k', sessionToken: 't'),
    );
    storage._values['auth_key_id'] = '   ';
    storage._values['auth_session_token'] = '   ';
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
    const withKeyId =
        AuthCredentials(apiKey: 'k', email: 'a@b.c', keyId: 'kid');
    const withToken = AuthCredentials(
        apiKey: 'k', email: 'a@b.c', sessionToken: 'tok');

    expect(base, same);
    expect(base.hashCode, same.hashCode);
    expect(base, isNot(withKeyId));
    expect(base.hashCode, isNot(withKeyId.hashCode));
    expect(base, isNot(withToken));
    expect(base.hashCode, isNot(withToken.hashCode));
  });

  test('clear empties the storage', () async {
    final storage = InMemorySecureStorage();
    final store = SecureAuthCredentialsStore(storage: storage);

    await store.save(
      const AuthCredentials(apiKey: 'cake_x', email: 'a@b.c'),
    );
    await store.clear();

    expect(await store.load(), isNull);
    expect(storage.values, isEmpty);
  });
}
