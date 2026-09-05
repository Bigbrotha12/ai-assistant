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
  test('load returns null when nothing has been saved', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    expect(await store.load(), isNull);
  });

  test('load returns settings when only the host has been saved', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    await store.save(const BackendSettings(host: 'tail.example'));
    final loaded = await store.load();

    expect(loaded, const BackendSettings(host: 'tail.example'));
  });

  test('environment round-trips and defaults to dev', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(const BackendSettings(host: 'tail.example'));
    final dev = await store.load();
    expect(dev!.environment, BackendEnvironment.dev);
    expect(storage.values['backend_environment'], 'dev');

    await store.save(
      const BackendSettings(
        host: 'tail.example',
        environment: BackendEnvironment.production,
      ),
    );
    final prod = await store.load();
    expect(prod!.environment, BackendEnvironment.production);
    expect(storage.values['backend_environment'], 'production');
  });

  test('an unknown stored environment resolves to dev', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(const BackendSettings(host: 'tail.example'));
    storage._values['backend_environment'] = 'staging';
    final loaded = await store.load();

    expect(loaded!.environment, BackendEnvironment.dev);
  });

  test('load returns null when host is blank', () async {
    final store = SecureSettingsStore(storage: InMemorySecureStorage());

    await store.save(const BackendSettings(host: '   '));

    expect(await store.load(), isNull);
  });

  test('save stores the host trimmed', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(host: '  tail.example  '),
    );

    expect(storage.values['backend_host'], 'tail.example');
    expect(storage.values['backend_environment'], 'dev');
  });

  test('mcpSecret round-trips and is stored trimmed', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(
        host: 'tail.example',
        mcpSecret: '  mcp-token  ',
      ),
    );

    expect(storage.values['backend_mcp_secret'], 'mcp-token');
    final loaded = await store.load();
    expect(loaded!.mcpSecret, 'mcp-token');
  });

  test('mcpSecret is not written when null', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(host: 'tail.example'),
    );

    expect(storage.values.containsKey('backend_mcp_secret'), isFalse);
    final loaded = await store.load();
    expect(loaded!.mcpSecret, isNull);
  });

  test('mcpSecret is not written when blank', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(
        host: 'tail.example',
        mcpSecret: '   ',
      ),
    );

    expect(storage.values.containsKey('backend_mcp_secret'), isFalse);
    final loaded = await store.load();
    expect(loaded!.mcpSecret, isNull);
  });

  test('load returns null mcpSecret when stored value is empty', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(
        host: 'tail.example',
        mcpSecret: 'token',
      ),
    );
    storage._values['backend_mcp_secret'] = '   ';
    final loaded = await store.load();

    expect(loaded!.mcpSecret, isNull);
  });

  test('clear removes all three keys', () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(
        host: 'tail.example',
        mcpSecret: 'token',
      ),
    );
    await store.clear();

    expect(await store.load(), isNull);
    expect(storage.values, isEmpty);
    expect(storage.values.containsKey('backend_mcp_secret'), isFalse);
  });

  group('filesSecret', () {
    test('filesSecret round-trips and is stored trimmed', () async {
      final storage = InMemorySecureStorage();
      final store = SecureSettingsStore(storage: storage);

      await store.save(
        const BackendSettings(
          host: 'tail.example',
          filesSecret: '  files-token  ',
        ),
      );

      expect(storage.values['backend_files_secret'], 'files-token');
      final loaded = await store.load();
      expect(loaded!.filesSecret, 'files-token');
    });

    test('filesSecret is not written when null', () async {
      final storage = InMemorySecureStorage();
      final store = SecureSettingsStore(storage: storage);

      await store.save(
        const BackendSettings(host: 'tail.example'),
      );

      expect(storage.values.containsKey('backend_files_secret'), isFalse);
      final loaded = await store.load();
      expect(loaded!.filesSecret, isNull);
    });

    test('filesSecret is not written when blank', () async {
      final storage = InMemorySecureStorage();
      final store = SecureSettingsStore(storage: storage);

      await store.save(
        const BackendSettings(
          host: 'tail.example',
          filesSecret: '   ',
        ),
      );

      expect(storage.values.containsKey('backend_files_secret'), isFalse);
      final loaded = await store.load();
      expect(loaded!.filesSecret, isNull);
    });

    test('load returns null filesSecret when stored value is empty', () async {
      final storage = InMemorySecureStorage();
      final store = SecureSettingsStore(storage: storage);

      await store.save(
        const BackendSettings(
          host: 'tail.example',
          filesSecret: 'token',
        ),
      );
      storage._values['backend_files_secret'] = '   ';
      final loaded = await store.load();

      expect(loaded!.filesSecret, isNull);
    });

    test('clear removes the files secret key', () async {
      final storage = InMemorySecureStorage();
      final store = SecureSettingsStore(storage: storage);

      await store.save(
        const BackendSettings(
          host: 'tail.example',
          filesSecret: 'token',
        ),
      );
      await store.clear();

      expect(storage.values.isEmpty, isTrue);
      expect(storage.values.containsKey('backend_files_secret'), isFalse);
    });

    test('saving with the files secret cleared deletes the stored secret',
        () async {
      final storage = InMemorySecureStorage();
      final store = SecureSettingsStore(storage: storage);

      await store.save(
        const BackendSettings(
          host: 'tail.example',
          filesSecret: 'old-token',
        ),
      );
      expect(storage.values.containsKey('backend_files_secret'), isTrue);

      // Token rotation: the user clears the field and saves; the stale secret
      // must not linger (otherwise load() still returns it).
      await store.save(
        const BackendSettings(host: 'tail.example'),
      );

      expect(storage.values.containsKey('backend_files_secret'), isFalse);
      final loaded = await store.load();
      expect(loaded, isNotNull);
      expect(loaded!.filesSecret, isNull);
    });
  });

  test('saving with the mcp secret cleared deletes the stored secret',
      () async {
    final storage = InMemorySecureStorage();
    final store = SecureSettingsStore(storage: storage);

    await store.save(
      const BackendSettings(
        host: 'tail.example',
        mcpSecret: 'old-token',
      ),
    );
    expect(storage.values.containsKey('backend_mcp_secret'), isTrue);

    await store.save(
      const BackendSettings(host: 'tail.example'),
    );

    expect(storage.values.containsKey('backend_mcp_secret'), isFalse);
    final loaded = await store.load();
    expect(loaded, isNotNull);
    expect(loaded!.mcpSecret, isNull);
  });
}