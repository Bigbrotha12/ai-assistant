import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/secure_storage.dart';
import '../../auth/data/auth_credentials_store.dart';

/// Per-account ntfy push credentials: the topic this device subscribes to and
/// the access token that authenticates the subscription.
///
/// The server reveals [accessToken] exactly once (at first provision). It is a
/// secret, so it lives in the same secure per-`AuthAccountScope.storageId`
/// bucket the plugin credentials use — never in settings or logs.
class NotifyCredentials {
  const NotifyCredentials({required this.topic, required this.accessToken});

  final String topic;
  final String accessToken;

  /// Both fields non-blank. A record missing either is unusable for a
  /// subscription and is treated as "not provisioned".
  bool get isComplete =>
      topic.trim().isNotEmpty && accessToken.trim().isNotEmpty;

  @override
  bool operator ==(Object other) =>
      other is NotifyCredentials &&
      other.topic == topic &&
      other.accessToken == accessToken;

  @override
  int get hashCode => Object.hash(topic, accessToken);
}

/// Secure, per-account persistence for [NotifyCredentials].
///
/// Mirrors [PluginCredentialsStore]: one JSON record per
/// [AuthAccountScope.storageId] under `notify_credentials_v1_<storageId>`, with
/// a serialized read-modify-write queue so concurrent writes cannot interleave.
/// Parsing is defensive — a corrupt/old/foreign record reads as `null`
/// ("not provisioned") so the user can simply re-provision, and a malformed
/// blob never wedges the notifications surface with an error.
class NotifyCredentialsStore {
  NotifyCredentialsStore({FlutterSecureStorage? storage})
    : _storage = storage ?? defaultSecureStorage();

  static const recordVersion = 1;
  static const keyPrefix = 'notify_credentials_v1_';

  final FlutterSecureStorage _storage;
  Future<void> _pending = Future.value();

  String _key(AuthAccountScope scope) => '$keyPrefix${scope.storageId}';

  Future<T> _serialized<T>(Future<T> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  /// Loads the stored credentials for [scope], or null when none are stored
  /// (or the record is unusable).
  Future<NotifyCredentials?> load(AuthAccountScope scope) =>
      _serialized(() => _load(scope));

  Future<NotifyCredentials?> _load(AuthAccountScope scope) async {
    final raw = await _storage.read(key: _key(scope));
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final data = Map<String, dynamic>.from(decoded);
      if (data['version'] != recordVersion) return null;
      final topic = data['topic'];
      final accessToken = data['accessToken'];
      if (topic is! String || topic.trim().isEmpty) return null;
      if (accessToken is! String || accessToken.trim().isEmpty) return null;
      return NotifyCredentials(topic: topic, accessToken: accessToken);
    } catch (_) {
      // Corrupt record: fail toward "not provisioned", never expose the blob.
      return null;
    }
  }

  /// Persists [credentials] for [scope]. Throws [ArgumentError] for an
  /// incomplete record (a subscription needs both fields).
  Future<void> save(AuthAccountScope scope, NotifyCredentials credentials) {
    if (!credentials.isComplete) {
      throw ArgumentError('Notify credentials must have a topic and token.');
    }
    return _serialized(() async {
      await _storage.write(
        key: _key(scope),
        value: jsonEncode({
          'version': recordVersion,
          'topic': credentials.topic,
          'accessToken': credentials.accessToken,
        }),
      );
    });
  }

  /// Removes [scope]'s stored credentials (revoke, or account cleanup).
  Future<void> remove(AuthAccountScope scope) =>
      _serialized(() => _storage.delete(key: _key(scope)));
}
