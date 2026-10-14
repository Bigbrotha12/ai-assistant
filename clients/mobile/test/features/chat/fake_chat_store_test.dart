import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/message_model.dart';

import '../../fakes.dart';

/// The [FakeChatStore] must mirror production `DriftChatStore` semantics where
/// tests depend on them: a message write against a missing conversation row is
/// rejected (FK violation in drift), never a silent no-op — otherwise tests
/// could mask exactly the missing-row bugs the FK exists to catch.
void main() {
  Message message(String id, MessageRole role, String content) =>
      Message(id: id, role: role, content: content, createdAt: DateTime(2026));

  test('appendMessage throws when the conversation row is missing', () async {
    final store = FakeChatStore();

    expect(
      () => store.appendMessage(
        'no-such-conversation',
        message('m1', MessageRole.user, 'hello'),
      ),
      throwsA(isA<StateError>()),
    );
    expect(await store.loadConversation('no-such-conversation'), isNull);
  });

  test('updateMessage throws when the conversation row is missing', () async {
    final store = FakeChatStore();

    expect(
      () => store.updateMessage(
        'no-such-conversation',
        message('m1', MessageRole.assistant, 'hi'),
      ),
      throwsA(isA<StateError>()),
    );
    expect(await store.loadConversation('no-such-conversation'), isNull);
  });

  test('ensureConversation creates the row once and appends (never overwrites)',
      () async {
    final store = FakeChatStore();
    final first = message('m1', MessageRole.user, 'first');
    final second = message('m2', MessageRole.user, 'second');

    await store.ensureConversation('c1', title: 'First message', firstMessage: first);
    await store.ensureConversation('c1', title: 'ignored', firstMessage: second);

    final conv = await store.loadConversation('c1');
    expect(conv, isNotNull);
    // The existing row's title is preserved by the second call.
    expect(conv!.title, 'First message');
    expect(conv.messages, hasLength(2));
    expect(conv.messages[0].content, 'first');
    expect(conv.messages[1].content, 'second');
  });
}