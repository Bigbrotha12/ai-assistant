import 'dart:async';
import 'dart:convert';

import 'package:ai_assistant/app/theme_providers.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/attachments/data/files_providers.dart';
import 'package:ai_assistant/features/attachments/data/files_service.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/plugin_catalog_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/ui/plugins_screen.dart';
import 'package:ai_assistant/features/settings/data/prefs_providers.dart';
import 'package:ai_assistant/features/settings/data/settings_providers.dart';
import 'package:ai_assistant/features/settings/ui/settings_screen.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../fakes.dart';
import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;
import '../voice/voice_test_fakes.dart';
import 'data/langchain_client_test.dart'
    show FakePluginAdapter, pluginJson, modelJson;

const account = AuthCredentials(
  apiKey: 'fake-gateway-key',
  ownerId: 'owner-a',
  backendOrigin: 'http://example.com:17600',
);

class TestAuth extends AuthCredentialsNotifier {
  TestAuth(this.initial);
  final AuthCredentials? initial;
  @override
  Future<AuthCredentials?> build() async => initial;
  void replace(AuthCredentials? value) => state = AsyncData(value);
}

ResponseBody jsonResponse(Object value, {int status = 200}) =>
    ResponseBody.fromString(
      jsonEncode(value),
      status,
      headers: {
        'content-type': ['application/json'],
      },
    );

Map<String, dynamic> agentJson() => {
  'id': 'test-agent',
  'object': 'agent',
  'created': 1,
  'owned_by': 'plugin',
  'name': 'Test Agent',
  'description': 'A test agent',
  'visionCapable': false,
  'skillCount': 0,
};

Map<String, dynamic> agentPluginJson() => {
  'id': 'test-agent',
  'type': 'agent',
  'name': 'Test Agent',
  'description': 'A test agent',
  'version': '1.0.0',
  'schemaVersion': 1,
  'installed': true,
};

void main() {
  late FakePluginAdapter adapter;
  late Dio dio;
  late PluginCredentialsStore store;
  late ProviderContainer container;
  late TestAuth auth;
  bool failed = false;
  bool empty = false;

  Future<void> mount(
    WidgetTester tester, {
    bool settings = false,
    AuthCredentials? credentials = account,
  }) async {
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    auth = TestAuth(credentials);
    container = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(dio),
        authCredentialsProvider.overrideWith(() => auth),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
        pluginCredentialsStoreProvider.overrideWithValue(store),
        backendProbeProvider.overrideWithValue(FakeProbe()),
        filesServiceProvider.overrideWithValue(NoOpFilesClient()),
        appPrefsStoreProvider.overrideWithValue(FakePrefsStore()),
        appTierStoreProvider.overrideWithValue(FakeAppTierStore()),
        voiceSettingsStoreProvider.overrideWithValue(FakeVoiceSettingsStore()),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: settings ? const SettingsScreen() : const PluginsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  setUp(() {
    failed = false;
    empty = false;
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    adapter = FakePluginAdapter((options) {
      if (failed) {
        return jsonResponse({
          'error': 'internal',
          'message': 'UNSAFE_SERVER_DETAIL',
        }, status: 500);
      }
      switch (options.uri.path) {
        case '/v1/plugins':
          return jsonResponse({
            'plugins': empty ? [] : [pluginJson(), agentPluginJson()],
          });
        case '/v1/models':
          return jsonResponse({
            'object': 'list',
            'data': empty ? [] : [modelJson()],
          });
        case '/v1/agents':
          return jsonResponse({
            'object': 'list',
            'data': empty ? [] : [agentJson()],
          });
        case '/v1/chat/completions':
          return ResponseBody.fromString(
            jsonEncode({
              'status': 'already_completed',
              'sessionId': 'session-test',
              'messageId': 'turn-test',
            }),
            200,
            headers: {
              'content-type': ['application/json'],
              'x-session-id': ['session-test'],
              'x-conversation-state': ['resumed'],
            },
          );
        default:
          throw StateError('Unexpected fake HTTP request');
      }
    });
    dio = Dio()..httpClientAdapter = adapter;
    addTearDown(() => dio.close(force: true));
  });

  testWidgets(
    'Settings to Plugins saves account key and assembles staged fake transport request',
    (tester) async {
      await mount(tester, settings: true);
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-plugins')),
        450,
        scrollable: find
            .descendant(
              of: find.byType(ListView).first,
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.byKey(const Key('settings-plugins')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plugin-openrouter')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Select model'));
      await tester.pumpAndSettle();
      expect(find.text('Selected for this account'), findsOneWidget);
      final field = find.byKey(const Key('plugin-api-key'));
      expect(tester.widget<TextField>(field).obscureText, isTrue);
      await tester.enterText(field, 'fake-provider-key');
      await tester.pump();
      expect(
        (await store.load(account.accountScope!)).plugins.keys,
        ['test-agent'],
      );
      await tester.tap(find.text('Save API key'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      expect(
        find.textContaining('API key saved for this account.'),
        findsOneWidget,
      );
      expect(
        adapter.requests.every((request) => request.method == 'GET'),
        isTrue,
      );
      expect(find.text('Send'), findsNothing);
      expect(dio.options.headers.containsKey('Authorization'), isFalse);
      for (final request in adapter.requests) {
        expect(request.uri.origin, account.backendOrigin);
        expect(request.headers['Authorization'], 'Bearer fake-gateway-key');
        expect(request.headers.values, isNot(contains('fake-provider-key')));
      }
      final subscription = container.listen(
        stagedPluginRequestBuilderProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      await tester.pumpAndSettle();
      final builder = await container.read(
        stagedPluginRequestBuilderProvider.future,
      );
      final request = builder.build(
        messages: [
          const ApiMessage(role: 'user', content: 'Fake HTTP test only'),
        ],
        sessionId: 'session-test',
        turnId: 'turn-test',
      );
      final resultFuture = LangChainClient(
        dio: dio,
        baseUrl: '${account.backendOrigin}/v1',
      ).managedTurn(request);
      await tester.pump(const Duration(milliseconds: 100));
      final result = await resultFuture;
      expect(result.sessionId, 'session-test');
      final sent = adapter.requests.last;
      expect(sent.data['model'], 'openrouter');
      expect(sent.data['credentials'], {
        'openrouter': {'apiKey': 'fake-provider-key'},
      });
      expect(sent.data['enabled_plugins'], isEmpty);
      expect(sent.headers['Authorization'], 'Bearer fake-gateway-key');
      final otherScope = AuthAccountScope.fromIdentity(
        backendOrigin: account.backendOrigin,
        ownerId: 'owner-b',
      )!;
      expect((await store.load(otherScope)).plugins, isEmpty);
      await tester.enterText(field, 'unsaved-key');
      auth.replace(
        const AuthCredentials(
          apiKey: 'other-fake-key',
          ownerId: 'owner-b',
          backendOrigin: 'http://example.com:17600',
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      expect(find.text('No API key saved for this account.'), findsOneWidget);
      expect(
        () => builder.build(
          messages: [const ApiMessage(role: 'user', content: 'stale')],
          sessionId: 'session-test',
          turnId: 'turn-test',
        ),
        throwsA(anything),
      );
    },
  );

  testWidgets('signed out and legacy identity never request catalog', (
    tester,
  ) async {
    await mount(tester, credentials: null);
    expect(find.textContaining('Sign in from Settings'), findsOneWidget);
    expect(adapter.requests, isEmpty);
    auth.replace(const AuthCredentials(apiKey: 'legacy-fake-key'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Sign in again from Settings'), findsOneWidget);
    expect(adapter.requests, isEmpty);
    auth.replace(
      const AuthCredentials(
        apiKey: 'wrong-origin-key',
        ownerId: 'a',
        backendOrigin: 'http://other.test:17600',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Sign in again from Settings'), findsOneWidget);
    expect(adapter.requests, isEmpty);
  });

  testWidgets('safe explicit retry and empty or removed model states', (
    tester,
  ) async {
    failed = true;
    await mount(tester);
    expect(find.textContaining('Could not load plugins'), findsOneWidget);
    expect(find.textContaining('UNSAFE_SERVER_DETAIL'), findsNothing);
    final count = adapter.requests.length;
    await tester.pump(const Duration(seconds: 2));
    expect(adapter.requests.length, count);
    failed = false;
    empty = true;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.textContaining('No models available'), findsOneWidget);
    empty = false;
    await tester.tap(find.text('Refresh catalog'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('plugin-openrouter')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('plugin-api-key')), 'unsaved');
    empty = true;
    container.invalidate(pluginCatalogProvider);
    await tester.pumpAndSettle();
    expect(find.textContaining('This plugin was removed'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('catalog requests cancel on key change and disposal', (
    tester,
  ) async {
    final pending = Completer<ResponseBody>();
    adapter = FakePluginAdapter((_) => pending.future);
    dio.httpClientAdapter = adapter;
    auth = TestAuth(account);
    container = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(dio),
        authCredentialsProvider.overrideWith(() => auth),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
      ],
    );
    await container.read(authCredentialsProvider.future);
    await container.read(settingsProvider.future);
    final sub = container.listen(pluginCatalogProvider, (_, _) {});
    await tester.pump(const Duration(milliseconds: 10));
    expect(container.read(pluginAccessProvider), PluginAccess.ready);
    expect(container.read(pluginCatalogProvider).error, isNull);
    expect(adapter.requests, hasLength(3));
    final old = adapter.requests.toList();
    auth.replace(
      const AuthCredentials(
        apiKey: 'rotated-fake-key',
        ownerId: 'owner-a',
        backendOrigin: 'http://example.com:17600',
      ),
    );
    await tester.pump(const Duration(milliseconds: 10));
    await tester.pump(const Duration(milliseconds: 10));
    expect(old.every((request) => request.cancelToken!.isCancelled), isTrue);
    expect(adapter.requests.length, 6);
    sub.close();
    container.dispose();
    await tester.pump();
    expect(
      adapter.requests.every((request) => request.cancelToken!.isCancelled),
      isTrue,
    );
    pending.complete(jsonResponse({'plugins': []}));
    await tester.pump();
  });

  testWidgets('selecting a base URL instance persists baseUrlEntry', (
    tester,
  ) async {
    await mount(tester);
    await tester.tap(find.byKey(const Key('plugin-openrouter')));
    await tester.pumpAndSettle();
    expect(find.text('(default)'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('plugin-baseurl-primary')),
      findsOneWidget,
    );
    expect(
      (await store.load(account.accountScope!)).plugins.keys,
      ['test-agent'],
    );
    final primary = find.byKey(const ValueKey('plugin-baseurl-primary'));
    await tester.ensureVisible(primary);
    await tester.pumpAndSettle();
    await tester.tap(primary);
    await tester.pumpAndSettle();
    expect(
      (await store.load(account.accountScope!))
          .plugins['openrouter']!
          .credentials['baseUrlEntry'],
      'primary',
    );
    final fallback = find.byKey(const Key('plugin-baseurl-default'));
    await tester.ensureVisible(fallback);
    await tester.pumpAndSettle();
    await tester.tap(fallback);
    await tester.pumpAndSettle();
    expect(
      (await store.load(account.accountScope!))
          .plugins['openrouter']!
          .credentials
          .containsKey('baseUrlEntry'),
      isFalse,
    );
  });

  testWidgets('agent section shows agent tile and can navigate to editor', (
    tester,
  ) async {
    await mount(tester);
    expect(find.text('Test Agent'), findsAtLeastNWidgets(1));
    await tester.tap(find.byKey(const ValueKey('agent-test-agent')));
    await tester.pumpAndSettle();
    expect(find.text('Configure agent'), findsOneWidget);
    expect(find.text('A test agent'), findsOneWidget);
  });

  testWidgets('agent section shows empty state when no agents', (
    tester,
  ) async {
    empty = true;
    await mount(tester);
    expect(
      find.text(
        'No agents available. Ask your administrator to install an agent plugin.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('selecting and deselecting an agent', (tester) async {
    await mount(tester);
    await tester.tap(find.byKey(const ValueKey('agent-test-agent')));
    await tester.pumpAndSettle();
    // The first catalog template is seeded as the selected agent.
    expect(
      (await store.load(account.accountScope!)).selectedAgent,
      'test-agent',
    );
    expect(find.text('Deselect agent'), findsOneWidget);
    await tester.tap(find.text('Deselect agent'));
    await tester.pumpAndSettle();
    expect(find.text('Select agent'), findsOneWidget);
    expect(
      (await store.load(account.accountScope!)).selectedAgent,
      isNull,
    );
    await tester.tap(find.text('Select agent'));
    await tester.pumpAndSettle();
    expect(find.text('Deselect agent'), findsOneWidget);
    expect(
      (await store.load(account.accountScope!)).selectedAgent,
      'test-agent',
    );
  });
}
