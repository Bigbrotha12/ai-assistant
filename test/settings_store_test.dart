import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/settings_store.dart';

/// In-memory [FlutterSecureStorage] double. The real class is a plain
/// (extensible, non-sealed) class whose `read`/`write`/`delete` instance
/// methods delegate to the platform channel, so overriding those methods
/// with a `Map<String, String>` never touches a real platform.
class InMemorySecureStorage extends FlutterSecureStorage {
  final Map<String, String> _values = {};

  /// Snapshot of the stored key/value pairs for assertions.
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
  test('save then load round-trips settings', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    await store.save(
      const BackendSettings(host: 'tail.example', secret: 's3cret'),
    );
    final loaded = await store.load();

    expect(loaded, const BackendSettings(host: 'tail.example', secret: 's3cret'));
  });

  test('load returns null when nothing has been saved', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    expect(await store.load(), isNull);
  });

  test('load returns settings when host saved but secret is empty', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    await store.save(const BackendSettings(host: 'tail.example', secret: ''));
    final loaded = await store.load();

    expect(loaded, const BackendSettings(host: 'tail.example', secret: ''));
  });

  test('load returns null when host is blank', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    await store.save(const BackendSettings(host: '   ', secret: 's3cret'));

    expect(await store.load(), isNull);
  });

  test('clear empties the storage', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(host: 'tail.example', secret: 's3cret'),
    );
    await store.clear();

    expect(await store.load(), isNull);
    expect(storage.values, isEmpty);
  });

  test('save stores the host trimmed', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(host: '  tail.example  ', secret: 's3cret'),
    );

    expect(storage.values['backend_host'], 'tail.example');
    expect(storage.values['backend_secret'], 's3cret');
  });
}