import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

/// Holds the app-wide current conversation id, shared by the text chat screen
/// and the voice conversation. In-memory only (per app run); no persistence.
class ActiveConversationNotifier extends Notifier<String?> {
  final _uuid = const Uuid();

  @override
  String? build() => _uuid.v4();

  /// Returns the current conversation id, creating a fresh one when none
  /// exists yet and storing it.
  String ensure() {
    final current = state;
    if (current != null) return current;
    final id = _uuid.v4();
    state = id;
    return id;
  }

  /// Switches to an existing conversation (e.g. history selection).
  void set(String id) {
    state = id;
  }

  /// Replaces the current conversation id with a fresh one.
  void newConversation() {
    state = _uuid.v4();
  }
}

/// Provides the app-wide active conversation id.
final activeConversationIdProvider =
    NotifierProvider<ActiveConversationNotifier, String?>(
      ActiveConversationNotifier.new,
    );