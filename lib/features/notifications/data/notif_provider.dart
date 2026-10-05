import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../auth/data/auth_credentials_store.dart';
import './notif_client.dart';
import './notify_admin_client.dart';
import './notify_credentials_store.dart';

/// The notifier server URL, from compile-time env. Empty (default) disables
/// notifications — the notifier server is out of scope until it exists.
final notifBaseUrlProvider = Provider<String>((ref) {
  final url = BackendConfig.defaultNotifUrl.trim();
  return url.isEmpty ? '' : url;
});

/// The account-scoped seam for notify credentials. Null while signed out /
/// before the auth identity resolves; a provider so tests can inject a scope
/// without the full settings/auth graph.
final notifyAccountScopeProvider = Provider<AuthAccountScope?>((ref) {
  return ref.watch(
    authCredentialsProvider.select((auth) => auth.value?.accountScope),
  );
});

/// Secure per-account persistence for `{topic, accessToken}`.
final notifyCredentialsStoreProvider = Provider<NotifyCredentialsStore>(
  (ref) => NotifyCredentialsStore(),
);

/// The stored notify credentials for the active account, or null when the
/// build has no notifier server, the account is signed out, or nothing has been
/// provisioned yet.
///
/// AutoDispose + account-scoped, like `pluginCredentialsProvider`. It never
/// throws for a "not provisioned" state — that is `null`.
final notifyCredentialsProvider =
    FutureProvider.autoDispose<NotifyCredentials?>((ref) async {
      if (ref.watch(notifBaseUrlProvider).isEmpty) return null;
      final scope = ref.watch(notifyAccountScopeProvider);
      if (scope == null) return null;
      return ref.watch(notifyCredentialsStoreProvider).load(scope);
    });

/// Admin client for the gateway's `/api/notify/*` routes. Null when this build
/// has no notifier server configured or no account scope is available — the
/// settings surface disables its actions in that case.
final notifyAdminClientProvider = Provider<NotifyAdminClient?>((ref) {
  if (ref.watch(notifBaseUrlProvider).isEmpty) return null;
  final scope = ref.watch(notifyAccountScopeProvider);
  if (scope == null) return null;
  return NotifyAdminClient(
    dio: ref.watch(dioProvider),
    baseUrl: scope.backendOrigin,
  );
});

/// The ntfy access token for authenticated topics, read synchronously from the
/// loaded credentials. Empty while (re)loading / unprovisioned / signed out,
/// which makes the client fall back to an anonymous subscription.
///
/// The loading gate is what prevents an account switch from reusing the
/// **previous** account's token: an async rebuild keeps its prior value while
/// the new credentials load, so [notifyCredentialsProvider] still yields the
/// old token to `.value` until it settles.
final notifAccessTokenProvider = Provider<String>((ref) {
  final credentials = ref.watch(notifyCredentialsProvider);
  if (credentials.isLoading) return '';
  return credentials.value?.accessToken ?? '';
});

/// Provides the active [NotifClient].
///
/// Dependency-gated: returns [NoOpNotifClient] when no notifier server URL is
/// configured or no account scope is available, and a live [NtfyNotifClient]
/// otherwise.
///
/// The explicit [notifyAccountScopeProvider] watch is deliberate: it forces a
/// rebuild on an account switch even when the (transiently stale) token string
/// is unchanged, so the previous account's client can never linger while the
/// new credentials load.
final notifClientProvider = Provider<NotifClient>((ref) {
  final baseUrl = ref.watch(notifBaseUrlProvider);
  if (baseUrl.isEmpty) return const NoOpNotifClient();
  final scope = ref.watch(notifyAccountScopeProvider);
  if (scope == null) return const NoOpNotifClient();
  final accessToken = ref.watch(notifAccessTokenProvider);
  final client = NtfyNotifClient(
    baseUrl: baseUrl,
    dio: ref.watch(dioProvider),
    accessToken: accessToken.isEmpty ? null : accessToken,
  );
  ref.onDispose(client.dispose);
  return client;
});

/// Whether the app is currently foregrounded. Drives the notification
/// subscription: ntfy SSE only delivers while the app is running, so a
/// backgrounded app drops the subscription and a resumed app re-subscribes.
final notifForegroundProvider = NotifierProvider<NotifForeground, bool>(
  NotifForeground.new,
);

class NotifForeground extends Notifier<bool> {
  @override
  bool build() => true;

  void set(bool value) {
    if (ref.mounted) state = value;
  }
}

/// Registers a [WidgetsBindingObserver] that mirrors app lifecycle into
/// [notifForegroundProvider]. Mirrors `goalAttentionLifecycleProvider`: the
/// observer is registered here and removed in `ref.onDispose`, so it lives
/// exactly as long as the subscription provider that keeps it alive. It is NOT
/// registered a second time in `main.dart`.
final notifLifecycleObserverProvider = Provider<NotifLifecycleObserver>((ref) {
  final observer = NotifLifecycleObserver(
    onForeground: () {
      if (!ref.mounted) return;
      ref.read(notifForegroundProvider.notifier).set(true);
    },
    onBackground: () {
      if (!ref.mounted) return;
      ref.read(notifForegroundProvider.notifier).set(false);
    },
  );
  WidgetsBinding.instance.addObserver(observer);
  ref.onDispose(observer.dispose);
  return observer;
});

/// Ensures exactly one ntfy subscription while the app is foregrounded and
/// credentials exist, and tears it down when they change, clear, or the app is
/// disposed.
///
/// PLATFORM CAVEAT: ntfy's JSON/SSE stream only delivers while the app process
/// is alive and running. There is no OS-level background delivery here; real
/// push would require APNs/FCM (out of scope). Backgrounding therefore drops
/// the subscription and resuming re-establishes it.
///
/// Kept alive by the app-root surfacer (and [notifMessagesProvider]), so pushes
/// arrive even before — or without — the chat screen ever opening.
final notifSubscriptionProvider = Provider<NotifSubscriptionController>((ref) {
  ref.watch(notifLifecycleObserverProvider);
  // Rebuild on an account-scope change (even when the topic string is
  // unchanged) and gate the topic on a settled load so the previous account's
  // topic is never subscribed on the new account's client.
  ref.watch(notifyAccountScopeProvider);
  final foreground = ref.watch(notifForegroundProvider);
  final client = ref.watch(notifClientProvider);
  final credentials = ref.watch(notifyCredentialsProvider);
  final topic = credentials.isLoading ? null : credentials.value?.topic;
  final controller = NotifSubscriptionController(client: client);
  ref.onDispose(controller.dispose);
  if (foreground) controller.subscribe(topic);
  return controller;
});

/// Tracks the single desired subscription for one [NotifClient]: subscribes to
/// the current topic, unsubscribes when it changes or clears, and never
/// double-subscribes. No timers are created; a client that throws degrades
/// quietly (the next credentials/lifecycle change retries).
class NotifSubscriptionController {
  NotifSubscriptionController({required this.client});

  final NotifClient client;
  String? _topic;
  bool _disposed = false;

  /// The topic currently subscribed, if any.
  String? get topic => _topic;

  /// Subscribes to [topic] if it differs from the current one. A null/blank
  /// topic is a no-op (nothing to subscribe to).
  void subscribe(String? topic) {
    if (_disposed) return;
    final next = topic?.trim();
    if (next == null || next.isEmpty) return;
    if (_topic == next) return;
    final previous = _topic;
    _topic = next;
    if (previous != null) {
      unawaited(client.unsubscribe(previous).catchError((Object _) {}));
    }
    unawaited(client.subscribe(next).catchError((Object _) {}));
  }

  /// Drops the current subscription (backgrounding, or a cleared topic).
  void unsubscribe() {
    final current = _topic;
    _topic = null;
    if (current != null) {
      unawaited(client.unsubscribe(current).catchError((Object _) {}));
    }
  }

  /// Stops the subscription and ignores later calls. Safe to call repeatedly.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unsubscribe();
  }
}

/// Minimal [WidgetsBindingObserver]: forwards `resumed` / background
/// transitions and ignores transient `inactive` interruptions.
class NotifLifecycleObserver with WidgetsBindingObserver {
  NotifLifecycleObserver({
    required this.onForeground,
    required this.onBackground,
  });

  final void Function() onForeground;
  final void Function() onBackground;
  bool _disposed = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed) return;
    switch (state) {
      case AppLifecycleState.resumed:
        onForeground();
        break;
      case AppLifecycleState.inactive:
        // Transient (control center / incoming call): do not tear down.
        break;
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        onBackground();
    }
  }

  /// Stops listening for lifecycle changes. Safe to call multiple times.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
  }
}

/// Incoming notification messages from the active client, or an empty stream
/// when notifications are disabled.
///
/// Watching [notifSubscriptionProvider] keeps the live subscription alive for
/// as long as anything listens to the messages (the in-app surfacer).
final notifMessagesProvider = StreamProvider<NotifMessage>((ref) {
  ref.watch(notifSubscriptionProvider);
  final client = ref.watch(notifClientProvider);
  if (client is NtfyNotifClient) return client.messages;
  return const Stream<NotifMessage>.empty();
});
