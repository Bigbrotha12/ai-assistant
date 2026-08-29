import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'backend_settings.dart';

/// Persistence for runtime backend settings.
abstract interface class SettingsStore {
  /// Returns saved settings, or null when nothing usable has been saved.
  Future<BackendSettings?> load();

  /// Persists [settings] for later retrieval.
  Future<void> save(BackendSettings settings);

  /// Removes any previously saved settings.
  Future<void> clear();
}

/// [FlutterSecureStorage]-backed store. The storage instance is injectable
/// so tests can substitute a fake.
class SecureSettingsStore implements SettingsStore {
  /// Creates a store. When [storage] is null a default [FlutterSecureStorage]
  /// is used whose iOS keychain items are scoped to this device
  /// (`first_unlock_this_device`) so they never sync across devices.
  SecureSettingsStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(),
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device,
              ),
            );

  static const _kHost = 'backend_host';
  static const _kEnvironment = 'backend_environment';
  static const _kMcpSecret = 'backend_mcp_secret';
  static const _kFilesSecret = 'backend_files_secret';
  static const _kStorageUrl = 'backend_storage_url';

  final FlutterSecureStorage _storage;

  @override
  Future<BackendSettings?> load() async {
    final host = await _storage.read(key: _kHost);
    if (host == null || host.trim().isEmpty) {
      return null;
    }
    final environmentRaw = await _storage.read(key: _kEnvironment);
    final environment =
        BackendEnvironment.values.asNameMap()[environmentRaw] ??
            BackendEnvironment.dev;
    final mcpSecret = await _storage.read(key: _kMcpSecret);
    final filesSecret = await _storage.read(key: _kFilesSecret);
    final storageUrl = await _storage.read(key: _kStorageUrl);
    return BackendSettings(
      host: host,
      environment: environment,
      mcpSecret:
          mcpSecret == null || mcpSecret.trim().isEmpty ? null : mcpSecret,
      filesSecret:
          filesSecret == null || filesSecret.trim().isEmpty ? null : filesSecret,
      storageUrl:
          storageUrl == null || storageUrl.trim().isEmpty ? null : storageUrl,
    );
  }

  @override
  Future<void> save(BackendSettings settings) async {
    await _storage.write(key: _kHost, value: settings.trimmedHost);
    await _storage.write(
      key: _kEnvironment,
      value: settings.environment.name,
    );
    final mcpSecret = settings.trimmedMcpSecret;
    if (mcpSecret != null) {
      await _storage.write(key: _kMcpSecret, value: mcpSecret);
    } else {
      // A cleared field must remove the stored secret, otherwise a rotated
      // token lingers after the user blanks the field and saves.
      await _storage.delete(key: _kMcpSecret);
    }
    final filesSecret = settings.trimmedFilesSecret;
    if (filesSecret != null) {
      await _storage.write(key: _kFilesSecret, value: filesSecret);
    } else {
      await _storage.delete(key: _kFilesSecret);
    }
    final storageUrl = settings.trimmedStorageUrl;
    if (storageUrl != null) {
      await _storage.write(key: _kStorageUrl, value: storageUrl);
    } else {
      await _storage.delete(key: _kStorageUrl);
    }
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: _kHost);
    await _storage.delete(key: _kEnvironment);
    await _storage.delete(key: _kMcpSecret);
    await _storage.delete(key: _kFilesSecret);
    await _storage.delete(key: _kStorageUrl);
  }
}