import 'dart:async';

import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/goals/data/goal_providers.dart';
import 'package:ai_assistant/features/notifications/data/notif_client.dart';
import 'package:ai_assistant/features/notifications/data/notif_provider.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/main.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fakes.dart';
import '../features/goals/goal_client_test.dart' show FakeAdapter, jsonResponse;
import '../features/goals/goal_providers_test.dart' show TestAuth, credentials;

/// The client half of the Goal-titled push contract: `NotifSurfacer` refreshes
/// the goals list for a push whose title starts with `Goal` (so the chip's
/// attention dot and any open overlay reflect the new state) and leaves every
/// other push — e.g. a `Job <taskId>` completion — alone.

final _scope = AuthAccountScope.fromIdentity(
  backendOrigin: 'https://gw.test',
  ownerId: 'owner-a',
)!;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late StreamController<NotifMessage> controller;
  late FakeNotifClient notif;
  late FakeAdapter adapter;
  var listFetches = 0;

  setUp(() {
    controller = StreamController<NotifMessage>.broadcast();
    notif = FakeNotifClient();
    listFetches = 0;
    adapter = FakeAdapter((options) {
      if (options.method == 'GET' && options.uri.path == '/v1/goals') {
        listFetches++;
        return jsonResponse({'goals': const <Object?>[]});
      }
      fail('unexpected ${options.method} ${options.uri.path}');
    });
  });

  tearDown(() async {
    await controller.close();
    await notif.dispose();
  });

  Future<void> pumpSurfacer(WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
          pluginAccountScopeProvider.overrideWithValue(_scope),
          authCredentialsProvider.overrideWith(() => TestAuth(credentials)),
          notifClientProvider.overrideWithValue(notif),
          notifMessagesProvider.overrideWith((ref) => controller.stream),
        ],
        child: MaterialApp(
          home: NotifSurfacer(
            // Watching the list keeps the autoDispose provider alive, so an
            // invalidation is observable as a fresh fetch.
            child: Consumer(
              builder: (context, ref, _) {
                ref.watch(goalListProvider);
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a Goal-titled push invalidates the goals list', (tester) async {
    await pumpSurfacer(tester);
    expect(listFetches, 1, reason: 'initial load');

    controller.add(
      const NotifMessage(title: 'Goal needs you', body: 'Goal g-1 paused'),
    );
    await tester.pump();
    await tester.pumpAndSettle();

    expect(listFetches, 2, reason: 'the goals list must refetch');
  });

  testWidgets('a non-goal push leaves the goals list untouched', (tester) async {
    await pumpSurfacer(tester);
    expect(listFetches, 1);

    controller.add(const NotifMessage(title: 'Job t-1', body: 'done'));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(listFetches, 1, reason: 'a Job push must not touch the goals list');
  });
}
