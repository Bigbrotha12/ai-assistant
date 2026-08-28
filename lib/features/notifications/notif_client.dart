/// Contract for push notification delivery.
/// Dependency-gated: the notifier server does not exist in scope.
/// Ships with NoOpNotifClient so the feature is available when the server arrives.
abstract interface class NotifClient {
  Future<void> subscribe(String topic);
  Future<void> unsubscribe(String topic);
}

/// No-op implementation. The feature ships stubbed and ready for wiring.
class NoOpNotifClient implements NotifClient {
  const NoOpNotifClient();
  @override
  Future<void> subscribe(String topic) async {}
  @override
  Future<void> unsubscribe(String topic) async {}
}
