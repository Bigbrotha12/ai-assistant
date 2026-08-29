import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persisted authentication credentials for the app.
///
/// The API key is long-lived and cannot be read back from the server after it
/// is minted, so it is the single source of truth here. [email] is kept so the
/// onboarding/settings UI can display which account the key belongs to.
/// [keyId] and [sessionToken] let the app revoke the key (and sign the session
/// out) on the server when the user signs out or rotates the key.
class AuthCredentials {
  const AuthCredentials({
    required this.apiKey,
    this.email,
    this.keyId,
    this.sessionToken,
  });

  /// The full API key string. Stored exactly as returned by the mint endpoint
  /// (including its prefix) because the server never exposes it again.
  final String apiKey;

  /// The account email the key was minted for, when known.
  final String? email;

  /// The server-side id of the key record, when known. Required to revoke the
  /// key without re-reading it.
  final String? keyId;

  /// The better-auth session token used to mint [apiKey], when kept. Lets the
  /// app revoke the key or sign out the session on the server later.
  final String? sessionToken;

  @override
  bool operator ==(Object other) =>
      other is AuthCredentials &&
      other.apiKey == apiKey &&
      other.email == email &&
      other.keyId == keyId &&
      other.sessionToken == sessionToken;

  @override
  int get hashCode => Object.hash(apiKey, email, keyId, sessionToken);
}

/// Persistence for [AuthCredentials].
abstract interface class AuthCredentialsStore {
  /// Returns saved credentials, or null when nothing usable has been saved.
  Future<AuthCredentials?> load();

  /// Persists [credentials] for later retrieval.
  Future<void> save(AuthCredentials credentials);

  /// Removes any previously saved credentials.
  Future<void> clear();
}

/// [FlutterSecureStorage]-backed store. The storage instance is injectable so
/// tests can substitute a fake.
class SecureAuthCredentialsStore implements AuthCredentialsStore {
  /// Creates a store. When [storage] is null a default [FlutterSecureStorage]
  /// is used whose iOS keychain items are scoped to this device
  /// (`first_unlock_this_device`) so they never sync across devices.
  SecureAuthCredentialsStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(),
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock_this_device,
              ),
            );

  static const _kApiKey = 'auth_api_key';
  static const _kEmail = 'auth_email';
  static const _kKeyId = 'auth_key_id';
  static const _kSessionToken = 'auth_session_token';

  final FlutterSecureStorage _storage;

  @override
  Future<AuthCredentials?> load() async {
    final apiKey = await _storage.read(key: _kApiKey);
    if (apiKey == null || apiKey.trim().isEmpty) {
      return null;
    }
    final email = await _storage.read(key: _kEmail);
    final keyId = await _storage.read(key: _kKeyId);
    final sessionToken = await _storage.read(key: _kSessionToken);
    return AuthCredentials(
      apiKey: apiKey,
      email: email == null || email.trim().isEmpty ? null : email,
      keyId: keyId == null || keyId.trim().isEmpty ? null : keyId,
      sessionToken: sessionToken == null || sessionToken.trim().isEmpty
          ? null
          : sessionToken,
    );
  }

  @override
  Future<void> save(AuthCredentials credentials) async {
    // The key must be stored exactly as returned; never trim it.
    await _storage.write(key: _kApiKey, value: credentials.apiKey);
    await _writeTrimmedOrDelete(_kEmail, credentials.email);
    await _writeTrimmedOrDelete(_kKeyId, credentials.keyId);
    await _writeTrimmedOrDelete(_kSessionToken, credentials.sessionToken);
  }

  /// Writes [value] under [key] when non-blank, otherwise removes the stored
  /// value so a cleared field never lingers after being reset.
  Future<void> _writeTrimmedOrDelete(String key, String? value) async {
    final trimmed = value?.trim();
    if (trimmed != null && trimmed.isNotEmpty) {
      await _storage.write(key: key, value: trimmed);
    } else {
      await _storage.delete(key: key);
    }
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: _kApiKey);
    await _storage.delete(key: _kEmail);
    await _storage.delete(key: _kKeyId);
    await _storage.delete(key: _kSessionToken);
  }
}
