import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/secure_storage.dart';

String? normalizeBackendOrigin(String? value) {
  final uri = Uri.tryParse(value?.trim() ?? '');
  if (uri == null ||
      !const {'http', 'https'}.contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.port <= 0 ||
      uri.port > 65535) {
    return null;
  }
  return uri.origin;
}

class AuthAccountScope {
  AuthAccountScope._(this.backendOrigin, this.ownerId);

  static AuthAccountScope? fromIdentity({
    required String? backendOrigin,
    required String? ownerId,
  }) {
    final origin = normalizeBackendOrigin(backendOrigin);
    if (origin == null || ownerId == null || ownerId.trim().isEmpty) {
      return null;
    }
    return AuthAccountScope._(origin, ownerId);
  }

  final String backendOrigin;
  final String ownerId;

  String get storageId =>
      base64Url.encode(utf8.encode(jsonEncode([backendOrigin, ownerId])));

  @override
  bool operator ==(Object other) =>
      other is AuthAccountScope &&
      other.backendOrigin == backendOrigin &&
      other.ownerId == ownerId;

  @override
  int get hashCode => Object.hash(backendOrigin, ownerId);
}

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
    this.ownerId,
    this.backendOrigin,
    this.mintedAt,
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
  final String? ownerId;
  final String? backendOrigin;

  /// When this [apiKey] was minted (client clock). Null on legacy installs
  /// that predate the field — backfilled from `listApiKeys.createdAt` by the
  /// startup rotation pass (M12) once the session is known valid.
  final DateTime? mintedAt;

  AuthAccountScope? get accountScope => AuthAccountScope.fromIdentity(
    backendOrigin: backendOrigin,
    ownerId: ownerId,
  );

  /// Returns a copy with the given fields replaced (used by the startup
  /// rotation pass to stamp [mintedAt] or swap in a freshly minted key
  /// without rebuilding the whole record by hand).
  AuthCredentials copyWith({
    String? apiKey,
    String? email,
    String? keyId,
    String? sessionToken,
    String? ownerId,
    String? backendOrigin,
    DateTime? mintedAt,
  }) {
    return AuthCredentials(
      apiKey: apiKey ?? this.apiKey,
      email: email ?? this.email,
      keyId: keyId ?? this.keyId,
      sessionToken: sessionToken ?? this.sessionToken,
      ownerId: ownerId ?? this.ownerId,
      backendOrigin: backendOrigin ?? this.backendOrigin,
      mintedAt: mintedAt ?? this.mintedAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AuthCredentials &&
      other.apiKey == apiKey &&
      other.email == email &&
      other.keyId == keyId &&
      other.sessionToken == sessionToken &&
      other.ownerId == ownerId &&
      other.backendOrigin == backendOrigin &&
      other.mintedAt == mintedAt;

  @override
  int get hashCode => Object.hash(
    apiKey,
    email,
    keyId,
    sessionToken,
    ownerId,
    backendOrigin,
    mintedAt,
  );
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
    : _storage = storage ?? defaultSecureStorage();

  static const _kApiKey = 'auth_api_key';
  static const _kEmail = 'auth_email';
  static const _kKeyId = 'auth_key_id';
  static const _kSessionToken = 'auth_session_token';
  static const _kOwnerId = 'auth_owner_id';
  static const _kBackendOrigin = 'auth_backend_origin';
  static const _kMintedAt = 'auth_minted_at';
  static const _kRecord = 'auth_credentials_v2';
  static const _recordVersion = 2;
  static const _legacyKeys = <String>[
    _kOwnerId,
    _kBackendOrigin,
    _kApiKey,
    _kEmail,
    _kKeyId,
    _kSessionToken,
    _kMintedAt,
  ];

  final FlutterSecureStorage _storage;
  Future<void> _pending = Future<void>.value();

  Future<T> _serialized<T>(Future<T> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  @override
  Future<AuthCredentials?> load() => _serialized(_load);

  Future<AuthCredentials?> _load() async {
    final rawRecord = await _storage.read(key: _kRecord);
    if (rawRecord != null) {
      final record = _decodeRecord(rawRecord);
      if (record != null) return record;
    }

    final legacy = await _readLegacy();
    if (legacy == null) return null;

    try {
      await _writeRecord(legacy);
      await _deleteLegacyKeys();
    } catch (_) {
      return legacy;
    }
    return legacy;
  }

  @override
  Future<void> save(AuthCredentials credentials) =>
      _serialized(() => _save(credentials));

  Future<void> _save(AuthCredentials credentials) async {
    await _writeRecord(credentials);
    await _deleteLegacyKeys();
  }

  Future<void> _writeRecord(AuthCredentials credentials) {
    return _storage.write(
      key: _kRecord,
      value: jsonEncode({
        'version': _recordVersion,
        'scope': _nonBlank(credentials.ownerId),
        'origin': normalizeBackendOrigin(credentials.backendOrigin),
        'email': _trimmedOrNull(credentials.email),
        'apiKey': credentials.apiKey,
        'keyId': _trimmedOrNull(credentials.keyId),
        'sessionToken': _trimmedOrNull(credentials.sessionToken),
        'mintedAt': credentials.mintedAt?.toIso8601String(),
      }),
    );
  }

  AuthCredentials? _decodeRecord(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final data = Map<String, dynamic>.from(decoded);
      if (data['version'] != _recordVersion) return null;

      final apiKey = _stringField(data, 'apiKey');
      if (apiKey == null || apiKey.trim().isEmpty) return null;

      return AuthCredentials(
        apiKey: apiKey,
        email: _storedOptionalField(data, 'email'),
        keyId: _storedOptionalField(data, 'keyId'),
        sessionToken: _storedOptionalField(data, 'sessionToken'),
        ownerId: _decodeScope(data),
        backendOrigin: normalizeBackendOrigin(_decodeOrigin(data)),
        mintedAt: _decodeMintedAt(data),
      );
    } catch (_) {
      return null;
    }
  }

  Future<AuthCredentials?> _readLegacy() async {
    final apiKey = await _storage.read(key: _kApiKey);
    if (apiKey == null || apiKey.trim().isEmpty) return null;

    final email = await _storage.read(key: _kEmail);
    final keyId = await _storage.read(key: _kKeyId);
    final sessionToken = await _storage.read(key: _kSessionToken);
    final ownerId = await _storage.read(key: _kOwnerId);
    final backendOrigin = await _storage.read(key: _kBackendOrigin);
    final mintedAtRaw = await _storage.read(key: _kMintedAt);
    return AuthCredentials(
      apiKey: apiKey,
      email: _storedOptional(email),
      keyId: _storedOptional(keyId),
      sessionToken: _storedOptional(sessionToken),
      ownerId: _storedOptional(ownerId),
      backendOrigin: normalizeBackendOrigin(backendOrigin),
      mintedAt: mintedAtRaw == null || mintedAtRaw.trim().isEmpty
          ? null
          : DateTime.tryParse(mintedAtRaw),
    );
  }

  String? _decodeScope(Map<String, dynamic> data) {
    if (data.containsKey('scope')) {
      final value = data['scope'];
      if (value is Map) {
        return _storedOptionalField(
          Map<String, dynamic>.from(value),
          'ownerId',
        );
      }
      return _storedOptionalField(data, 'scope');
    }
    return _storedOptionalField(data, 'ownerId');
  }

  String? _decodeOrigin(Map<String, dynamic> data) {
    final key = data.containsKey('origin') ? 'origin' : 'backendOrigin';
    return _stringField(data, key);
  }

  DateTime? _decodeMintedAt(Map<String, dynamic> data) {
    final raw = _stringField(data, 'mintedAt');
    if (raw == null || raw.trim().isEmpty) return null;
    return DateTime.tryParse(raw);
  }

  String? _stringField(Map<String, dynamic> data, String key) {
    final value = data[key];
    if (value == null) return null;
    if (value is! String) throw const FormatException();
    return value;
  }

  String? _storedOptionalField(Map<String, dynamic> data, String key) =>
      _storedOptional(_stringField(data, key));

  String? _storedOptional(String? value) =>
      value == null || value.trim().isEmpty ? null : value;

  String? _nonBlank(String? value) =>
      value == null || value.trim().isEmpty ? null : value;

  String? _trimmedOrNull(String? value) {
    final trimmed = value?.trim();
    return trimmed == null || trimmed.isEmpty ? null : trimmed;
  }

  Future<void> _deleteLegacyKeys() => _deleteKeys(_legacyKeys);

  Future<void> _deleteKeys(Iterable<String> keys) async {
    Object? firstError;
    StackTrace? firstStack;
    for (final key in keys) {
      try {
        await _storage.delete(key: key);
      } catch (error, stack) {
        firstError ??= error;
        firstStack ??= stack;
      }
    }
    if (firstError != null) {
      Error.throwWithStackTrace(firstError, firstStack!);
    }
  }

  @override
  Future<void> clear() =>
      _serialized(() => _deleteKeys(<String>[_kRecord, ..._legacyKeys]));
}
