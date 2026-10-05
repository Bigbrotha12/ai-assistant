import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/app/global_messenger.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/chat/ui/chat_screen.dart';
import 'package:ai_assistant/features/goals/data/goal_dto.dart';
import 'package:ai_assistant/features/goals/data/goal_providers.dart';
import 'package:ai_assistant/features/notifications/data/notif_client.dart';
import 'package:ai_assistant/features/notifications/data/notif_provider.dart';
import 'package:ai_assistant/features/notifications/data/notify_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/main.dart';

import '../../fakes.dart';
import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

/// A goals-list notifier that records every `build()` so a notification-driven
/// `invalidate` is observable.
class _CountingGoalList extends GoalListNotifier {
  _CountingGoalList(this.builds);

  final List<int> builds;

  @override
  Future<GoalListPage> build() async {
    builds.add(1);
    return const GoalListPage(goals: [], nextOffset: null);
  }
}

/// Records subscribe calls so the root wiring can be asserted without chat.
class _RecordingNotifClient implements NotifClient {
  final List<String> subscribed = [];

  @override
  Future<void> subscribe(String topic) async => subscribed.add(topic);

  @override
  Future<void> unsubscribe(String topic) async {}
}

/// A trivial screen that `pushReplacement`s itself to a second route, modeling
/// the chat/voice transition that disposes the home route.
class _PushReplacementHome extends StatelessWidget {
  const _PushReplacementHome();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: () => Navigator.of(context).pushReplacement(
            MaterialPageRoute<void>(
              builder: (_) => const Scaffold(body: Text('second')),
            ),
          ),
          child: const Text('go'),
        ),
      ),
    );
  }
}

ProviderContainer _container(
  List<int> goalBuilds,
  StreamController<NotifMessage> notifications,
) {
  final chatStore = FakeChatStore();
  final container = ProviderContainer(
    overrides: [
      settingsStoreProvider.overrideWithValue(FakeSettingsStore()),
      backendProbeProvider.overrideWithValue(FakeProbe()),
      chatStoreProvider.overrideWithValue(chatStore),
      filesStoreProvider.overrideWithValue(FakeFileStore()),
      managedChatAdapterProvider.overrideWithValue(
        FakeManagedChatAdapter(store: chatStore, script: FakeChatClient()),
      ),
      // No notifier server in these tests: the live subscription graph stays
      // inert (NoOp client, null topic) and the message stream is scripted.
      notifBaseUrlProvider.overrideWithValue(''),
      notifMessagesProvider.overrideWith((ref) => notifications.stream),
      goalListProvider.overrideWith(() => _CountingGoalList(goalBuilds)),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  late StreamController<NotifMessage> notifications;
  late List<int> goalBuilds;
  late ProviderContainer container;

  /// Mounts [home] under the app-root [NotifSurfacer] and the root messenger,
  /// mirroring `main.dart`'s wiring (the surfacer is the `MaterialApp.builder`).
  Future<void> pumpSurfacer(WidgetTester tester, {required Widget home}) async {
    notifications = StreamController<NotifMessage>.broadcast();
    addTearDown(notifications.close);
    goalBuilds = [];
    container = _container(goalBuilds, notifications);
    container.listen(goalListProvider, (_, _) {}, fireImmediately: true);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        // Mirror `main.dart`: the surfacer wraps the Navigator via `builder`, so
        // a `pushReplacement` between screens cannot dispose it.
        child: MaterialApp(
          scaffoldMessengerKey: scaffoldMessengerKey,
          builder: (context, child) =>
              NotifSurfacer(child: child ?? const SizedBox()),
          home: home,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> emit(WidgetTester tester, NotifMessage message) async {
    notifications.add(message);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 10));
  }

  testWidgets(
    'a notification surfaces with chat unmounted (non-chat screen)',
    (tester) async {
      await pumpSurfacer(tester, home: const Scaffold(body: SizedBox()));

      await emit(
        tester,
        const NotifMessage(
          topic: 'topic-1',
          title: 'Background job',
          body: 'Your report is ready',
        ),
      );

      expect(find.text('Background job\nYour report is ready'), findsOneWidget);
    },
  );

  testWidgets('a repeated notification within the window is deduped', (
    tester,
  ) async {
    await pumpSurfacer(tester, home: const Scaffold(body: SizedBox()));

    const message = NotifMessage(
      topic: 'topic-1',
      title: 'Alert',
      body: 'Same thing again',
    );
    await emit(tester, message);
    await emit(tester, message);

    expect(find.text('Alert\nSame thing again'), findsOneWidget);
  });

  testWidgets('a goal notification invalidates the goals list', (tester) async {
    await pumpSurfacer(tester, home: const Scaffold(body: SizedBox()));
    expect(goalBuilds, hasLength(1));

    await emit(
      tester,
      const NotifMessage(
        topic: 'topic-1',
        title: 'Goal started',
        body: 'goal abc-123 is running',
      ),
    );

    expect(goalBuilds.length, greaterThan(1));
    expect(find.text('Goal started\ngoal abc-123 is running'), findsOneWidget);
  });

  testWidgets('a non-goal notification does not invalidate the goals list', (
    tester,
  ) async {
    await pumpSurfacer(tester, home: const Scaffold(body: SizedBox()));
    expect(goalBuilds, hasLength(1));

    await emit(
      tester,
      const NotifMessage(topic: 'topic-1', title: 'Reminder', body: 'Not a goal'),
    );

    expect(goalBuilds, hasLength(1));
  });

  testWidgets(
    'with chat mounted the root surfacer shows the bar exactly once',
    (tester) async {
      await pumpSurfacer(tester, home: const ChatScreen());

      await emit(
        tester,
        const NotifMessage(topic: 'topic-1', title: 'Alert', body: 'One bar only'),
      );

      expect(find.text('Alert\nOne bar only'), findsOneWidget);
    },
  );

  testWidgets('the root surfacer survives a pushReplacement route change', (
    tester,
  ) async {
    // Chat's Voice/Text pill uses `pushReplacement`, which disposes the route
    // that contained ChatScreen. The surfacer is mounted above the Navigator,
    // so notifications must still surface after the swap.
    await pumpSurfacer(tester, home: const _PushReplacementHome());

    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);

    await emit(
      tester,
      const NotifMessage(
        topic: 'topic-1',
        title: 'After nav',
        body: 'still surfaces',
      ),
    );

    expect(find.text('After nav\nstill surfaces'), findsOneWidget);
  });

  testWidgets('ChatScreen alone no longer surfaces notifications', (
    tester,
  ) async {
    // The surfacing listener moved to the app root: with no NotifSurfacer
    // above it, an incoming message must not produce a snackbar here (and so
    // cannot double up with the root one in the real app).
    notifications = StreamController<NotifMessage>.broadcast();
    addTearDown(notifications.close);
    goalBuilds = [];
    container = _container(goalBuilds, notifications);
    container.listen(goalListProvider, (_, _) {}, fireImmediately: true);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: ChatScreen()),
      ),
    );
    await tester.pumpAndSettle();

    await emit(
      tester,
      const NotifMessage(topic: 'topic-1', title: 'Alert', body: 'Root only'),
    );

    expect(find.text('Alert\nRoot only'), findsNothing);
  });

  testWidgets('the subscription starts without ChatScreen mounted', (
    tester,
  ) async {
    final client = _RecordingNotifClient();
    final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
    final scope = AuthAccountScope.fromIdentity(
      ownerId: 'owner-a',
      backendOrigin: 'https://gw.test',
    )!;
    await store.save(
      scope,
      const NotifyCredentials(topic: 'topic-1', accessToken: 'token-1'),
    );
    final container = ProviderContainer(
      overrides: [
        notifBaseUrlProvider.overrideWithValue('https://ntfy.test'),
        notifyAccountScopeProvider.overrideWithValue(scope),
        notifyCredentialsStoreProvider.overrideWithValue(store),
        notifClientProvider.overrideWithValue(client),
        goalListProvider.overrideWith(() => _CountingGoalList([])),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          scaffoldMessengerKey: scaffoldMessengerKey,
          home: const NotifSurfacer(child: Scaffold(body: SizedBox())),
        ),
      ),
    );
    await container.read(notifyCredentialsProvider.future);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 10));

    expect(client.subscribed, ['topic-1']);
  });
}
