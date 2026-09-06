import 'package:flutter_riverpod/flutter_riverpod.dart';

import './auth_credentials_store.dart';

/// Provides the runtime [AuthCredentialsStore] used across the app.
final authCredentialsStoreProvider = Provider<AuthCredentialsStore>(
  (ref) => SecureAuthCredentialsStore(),
);

/// Async-notifier over the persisted [AuthCredentials] (null = not signed in).
final authCredentialsProvider =
    AsyncNotifierProvider<AuthCredentialsNotifier, AuthCredentials?>(
  AuthCredentialsNotifier.new,
);

class AuthCredentialsNotifier extends AsyncNotifier<AuthCredentials?> {
  @override
  Future<AuthCredentials?> build() async =>
      ref.read(authCredentialsStoreProvider).load();

  /// True when a usable API key is present in the current state.
  bool get hasCredentials {
    final creds = state.value;
    return creds != null && creds.apiKey.isNotEmpty;
  }

  /// Persists [credentials] and updates the in-memory state. On write failure
  /// the state becomes [AsyncError] instead of keeping stale data.
  Future<void> save(AuthCredentials credentials) async {
    try {
      await ref.read(authCredentialsStoreProvider).save(credentials);
      state = AsyncData(credentials);
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }

  /// Clears persisted credentials and resets the in-memory state.
  Future<void> clear() async {
    await ref.read(authCredentialsStoreProvider).clear();
    state = const AsyncData(null);
  }
}
