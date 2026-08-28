import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Global network status notifier. Features consume this to show/hide a
/// consolidated network banner instead of per-feature error banners.
final networkStatusProvider =
    NotifierProvider<NetworkStatusNotifier, NetworkStatus>(
  NetworkStatusNotifier.new,
);

/// Network status enum.
enum NetworkStatus { connected, disconnected }

/// Network status notifier.
class NetworkStatusNotifier extends Notifier<NetworkStatus> {
  @override
  NetworkStatus build() => NetworkStatus.connected;

  void set(NetworkStatus status) => state = status;
}
