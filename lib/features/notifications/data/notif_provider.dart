import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config.dart';
import '../../attachments/data/files_providers.dart';
import './notif_client.dart';

/// The notifier server URL, from compile-time env. Empty (default) disables
/// notifications — the notifier server is out of scope until it exists.
final notifBaseUrlProvider = Provider<String>((ref) {
  final url = BackendConfig.defaultNotifUrl.trim();
  return url.isEmpty ? '' : url;
});

/// Provides the active [NotifClient].
///
/// Dependency-gated: returns [NoOpNotifClient] when no notifier server URL is
/// configured, and a live [NtfyNotifClient] otherwise.
final notifClientProvider = Provider<NotifClient>((ref) {
  final baseUrl = ref.watch(notifBaseUrlProvider);
  if (baseUrl.isEmpty) return const NoOpNotifClient();
  final client = NtfyNotifClient(baseUrl: baseUrl, dio: ref.watch(dioProvider));
  ref.onDispose(client.dispose);
  return client;
});

/// Incoming notification messages from the active client, or an empty stream
/// when notifications are disabled.
final notifMessagesProvider = StreamProvider<NotifMessage>((ref) {
  final client = ref.watch(notifClientProvider);
  if (client is NtfyNotifClient) return client.messages;
  return const Stream<NotifMessage>.empty();
});