import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/active_conversation_provider.dart';

void main() {
  test('ensure creates and stores an id on first call', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(activeConversationIdProvider.notifier);

    final id = notifier.ensure();

    expect(id, isNotEmpty);
    expect(container.read(activeConversationIdProvider), id);
  });

  test('ensure returns the same id on subsequent calls', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(activeConversationIdProvider.notifier);

    final first = notifier.ensure();
    final second = notifier.ensure();

    expect(second, first);
  });

  test('set switches the current conversation id', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(activeConversationIdProvider.notifier);

    notifier.set('c1');

    expect(container.read(activeConversationIdProvider), 'c1');
    expect(notifier.ensure(), 'c1');
  });

  test('newConversation replaces the id with a fresh uuid', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifier = container.read(activeConversationIdProvider.notifier);
    final original = notifier.ensure();

    notifier.newConversation();

    final next = container.read(activeConversationIdProvider);
    expect(next, isNotNull);
    expect(next, isNot(original));
  });
}