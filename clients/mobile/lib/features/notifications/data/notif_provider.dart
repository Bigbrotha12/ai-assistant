import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/http/dio_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import './notif_client.dart';

/// The account-scoped owner-wide notification client.
///
/// [pluginAccountScopeProvider] supplies the gateway origin and rebuilds (via
/// [ref.onDispose]) when the account changes; it throws
/// `PluginReauthenticationRequired` while the account is not ready. The client
/// resolves the gateway API key fresh on every reconnect through the injected
/// closure, so a rotated key is picked up without rebuilding this provider.
final notifClientProvider = Provider<NotifClient>((ref) {
  final scope = ref.watch(pluginAccountScopeProvider);
  final client = GatewaySseNotifClient(
    dio: ref.watch(dioProvider),
    backendOrigin: scope.backendOrigin,
    resolveApiKey: () async {
      final auth = ref.read(authCredentialsProvider).value;
      if (auth == null || auth.apiKey.trim().isEmpty) return null;
      if (auth.accountScope != scope) return null;
      return auth.apiKey;
    },
  );
  ref.onDispose(client.dispose);
  return client;
});

/// Incoming notification messages for the signed-in owner.
final notifMessagesProvider = StreamProvider<NotifMessage>((ref) {
  return ref.watch(notifClientProvider).messages;
});
