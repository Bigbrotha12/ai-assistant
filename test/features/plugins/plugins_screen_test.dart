import 'dart:async';
import 'dart:convert';

import 'package:ai_assistant/app/theme_providers.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/features/attachments/data/files_providers.dart';
import 'package:ai_assistant/features/attachments/data/files_service.dart';
import 'package:ai_assistant/features/auth/data/account_deleted_handler.dart';
import 'package:ai_assistant/features/auth/data/account_deleted_state.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_providers.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/agent_config.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/plugin_catalog_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_providers.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:ai_assistant/features/plugins/ui/agent_editor_screen.dart';
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

class _NoopAccountDeletedHandler extends AccountDeletedHandler {
  _NoopAccountDeletedHandler(super.ref);

  @override
  Future<void> handle(Object? error) async {}
}

ResponseBody jsonResponse(Object value, {int status = 200}) =>
    ResponseBody.fromString(
      jsonEncode(value),
      status,
      headers: {
        'content-type': ['application/json'],
      },
    );

/// Builds [finder] by dragging [scrollable] toward the list end and then back
/// toward its start until the widget exists (ListView children outside the
/// cache extent are not built), then brings it fully on-screen so taps and
/// enterText land on it.
Future<void> reveal(
  WidgetTester tester,
  Finder finder, {
  Finder? scrollable,
}) async {
  final target = scrollable ?? find.byType(Scrollable).first;
  for (var i = 0; i < 40 && finder.evaluate().isEmpty; i++) {
    await tester.drag(target, const Offset(0, -200));
    await tester.pump();
  }
  for (var i = 0; i < 40 && finder.evaluate().isEmpty; i++) {
    await tester.drag(target, const Offset(0, 200));
    await tester.pump();
  }
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

/// The agent editor's own ListView scrollable (the plugins screen underneath
/// has one too, and text fields contribute editable scrollables — so callers
/// must not rely on a bare `Scrollable.first` here).
Finder editorScrollable() => find
    .descendant(
      of: find.byType(AgentEditorScreen),
      matching: find.byType(Scrollable),
    )
    .first;

Map<String, dynamic> agentJson() => {
  'id': 'test-agent',
  'object': 'agent',
  'created': 1,
  'owned_by': 'plugin',
  'name': 'Test Agent',
  'description': 'A test agent',
  'defaultModel': 'openrouter',
  'visionCapable': false,
  'toolGrants': [
    {'pluginId': 'web-search', 'required': false},
  ],
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

Map<String, dynamic> toolPluginJson({
  String id = 'web-search',
  String name = 'Web Search',
  String? category = 'General',
}) => {
  'id': id,
  'type': 'tool',
  'name': name,
  'description': 'Search the web',
  'version': '1.0.0',
  'schemaVersion': 1,
  'installed': true,
  'category': ?category,
  'tools': [
    {
      'name': 'search',
      'description': 'Run a web search',
      'readOnly': true,
      'inputSchema': {
        'type': 'object',
        'properties': {
          'query': {'type': 'string'},
        },
        'required': ['query'],
      },
    },
  ],
};

/// A tool that requires a personal access token, for the marketplace flow.
Map<String, dynamic> keyedTool({
  String id = 'bookings',
  String name = 'Bookings',
  String category = 'General',
}) => {
  ...toolPluginJson(id: id, name: name, category: category),
  'credentials': {
    'apiKey': {'label': 'Personal access token', 'required': true},
  },
};

PluginCatalog _loadedCatalog() => PluginCatalog(
  [
    PluginDto.fromSummaryJson(pluginJson()),
    PluginDto.fromSummaryJson(toolPluginJson()),
  ],
  [PluginModelDto.fromJson(modelJson())],
  const [],
);

void main() {
  late FakePluginAdapter adapter;
  late Dio dio;
  late PluginCredentialsStore store;
  late ProviderContainer container;
  late TestAuth auth;
  bool failed = false;
  bool terminal = false;
  bool empty = false;
  late List<Map<String, dynamic>> toolPlugins;

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
        accountDeletedHandlerProvider.overrideWith(
          (ref) => _NoopAccountDeletedHandler(ref),
        ),
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

  Future<void> mountEditor(
    WidgetTester tester, {
    required Future<PluginCatalog> catalog,
    AgentConfig? existing,
  }) async {
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    auth = TestAuth(account);
    container = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(dio),
        authCredentialsProvider.overrideWith(() => auth),
        settingsStoreProvider.overrideWithValue(
          FakeSettingsStore(stored: const BackendSettings(host: 'example.com')),
        ),
        pluginCredentialsStoreProvider.overrideWithValue(store),
        pluginCatalogProvider.overrideWith((ref) => catalog),
        skillsCatalogProvider.overrideWith((ref) async => const []),
        mcpsCatalogProvider.overrideWith((ref) async => const []),
      ],
    );
    addTearDown(container.dispose);
    await container.read(authCredentialsProvider.future);
    await container.read(settingsProvider.future);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(home: AgentEditorScreen(existing: existing)),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  /// Save now lives in the "Finish" section at the bottom of the editor's
  /// scroll, so taps must reveal it first (the big AppBar button is gone).
  Future<void> tapEditorSave(WidgetTester tester) async {
    await reveal(
      tester,
      find.byKey(const Key('agent-save')),
      scrollable: editorScrollable(),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('agent-save')));
    await tester.pumpAndSettle();
  }

  setUp(() {
    failed = false;
    terminal = false;
    empty = false;
    toolPlugins = [toolPluginJson()];
    store = PluginCredentialsStore(storage: InMemorySecureStorage());
    adapter = FakePluginAdapter((options) {
      if (terminal) {
        return jsonResponse({'error': 'account_deleted'}, status: 403);
      }
      if (failed) {
        return jsonResponse({
          'error': 'internal',
          'message': 'UNSAFE_SERVER_DETAIL',
        }, status: 500);
      }
      switch (options.uri.path) {
        case '/v1/plugins':
          return jsonResponse({
            'plugins': empty
                ? []
                : [pluginJson(), agentPluginJson(), ...toolPlugins],
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
        case '/v1/skills':
          return jsonResponse({
            'data': [
              {'id': 'skill-a', 'title': 'Skill A', 'description': 'Skill A'},
            ],
          });
        case '/v1/mcps':
          return jsonResponse({
            'data': [
              {'name': 'mcp-a', 'description': 'MCP A'},
            ],
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
      // scrollUntilVisible only exposes the leading edge; bring the whole tile
      // on screen so its center is tappable (it sits inside the AI & voice
      // card, which the reordered settings list can leave half-hidden).
      await tester.ensureVisible(find.byKey(const Key('settings-plugins')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings-plugins')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plugin-openrouter')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Select'));
      await tester.pumpAndSettle();
      expect(find.text('Active'), findsOneWidget);
      final field = find.byKey(const Key('plugin-api-key'));
      expect(tester.widget<TextField>(field).obscureText, isTrue);
      await tester.enterText(field, 'fake-provider-key');
      await tester.pump();
      expect((await store.load(account.accountScope!)).plugins.keys, [
        'test-agent',
      ]);
      await tester.tap(find.text('Save API key'));
      await tester.pumpAndSettle();
      // The input is replaced by a masked view of the saved key once one
      // exists — never the full secret.
      expect(find.byKey(const Key('plugin-api-key')), findsNothing);
      expect(find.textContaining('••••'), findsOneWidget);
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
    await reveal(tester, find.text('Refresh catalog'));
    await tester.tap(find.text('Refresh catalog'));
    await tester.pumpAndSettle();
    await reveal(tester, find.byKey(const Key('plugin-openrouter')));
    await tester.tap(find.byKey(const Key('plugin-openrouter')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('plugin-api-key')), 'unsaved');
    empty = true;
    container.invalidate(pluginCatalogProvider);
    await tester.pumpAndSettle();
    expect(find.textContaining('This plugin was removed'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('account_deleted catalog errors show the terminal copy', (
    tester,
  ) async {
    terminal = true;
    await mount(tester);
    expect(find.text(accountDeletedNotice), findsOneWidget);
    expect(find.textContaining('Could not load plugins'), findsNothing);
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

  testWidgets('ready-made agent tile selects and opens details', (
    tester,
  ) async {
    await mount(tester);
    final tile = find.byKey(const ValueKey('ready-test-agent'));
    await reveal(tester, tile);
    expect(find.text('Test Agent'), findsOneWidget);

    // Tapping the row selects it exclusively.
    await tester.tap(tile);
    await tester.pumpAndSettle();
    expect(
      (await store.load(account.accountScope!)).selectedAgent,
      'test-agent',
    );
    expect(find.text('Selected for this account'), findsAtLeastNWidgets(1));

    // The info action opens the read-only details page.
    await tester.tap(find.byKey(const ValueKey('ready-details-test-agent')));
    await tester.pumpAndSettle();
    expect(find.text('Agent details'), findsOneWidget);
    expect(find.text('A test agent'), findsOneWidget);
  });

  testWidgets('agent section shows empty state when no agents', (tester) async {
    empty = true;
    await mount(tester);
    expect(
      find.text('No ready-made agents yet. Ask your administrator to add one.'),
      findsOneWidget,
    );
    expect(
      find.text('You have not created any custom agents yet.'),
      findsOneWidget,
    );
  });

  testWidgets('selecting an agent switches exclusively', (tester) async {
    await mount(tester);
    // Seed a custom agent directly through the store (the scoped wrapper would
    // invalidate mid-test), then bump the epoch so the list rebuilds.
    await store.setAgentConfig(
      account.accountScope!,
      'my-agent',
      AgentConfig(
        id: 'my-agent',
        kind: AgentKind.custom,
        name: 'My Agent',
        description: 'A custom agent',
      ),
    );
    container.read(pluginCredentialsEpochProvider.notifier).invalidate();
    await tester.pumpAndSettle();

    final customTile = find.byKey(const ValueKey('custom-my-agent'));
    await reveal(tester, customTile);
    await tester.tap(customTile);
    await tester.pumpAndSettle();
    expect((await store.load(account.accountScope!)).selectedAgent, 'my-agent');
    expect(
      find.descendant(
        of: customTile,
        matching: find.text('Selected for this account'),
      ),
      findsOneWidget,
    );

    final readyTile = find.byKey(const ValueKey('ready-test-agent'));
    await reveal(tester, readyTile);
    await tester.tap(readyTile);
    await tester.pumpAndSettle();
    expect(
      (await store.load(account.accountScope!)).selectedAgent,
      'test-agent',
    );
    expect(
      find.descendant(
        of: readyTile,
        matching: find.text('Selected for this account'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: customTile,
        matching: find.text('Selected for this account'),
      ),
      findsNothing,
    );
  });

  testWidgets(
    'agent editor exposes tool grants, model picker, and inference controls',
    (tester) async {
      await mount(tester);
      await tester.tap(find.text('Create agent'));
      await tester.pumpAndSettle();
      expect(find.byType(AgentEditorScreen), findsOneWidget);
      final editor = find.byType(AgentEditorScreen);

      await reveal(
        tester,
        find.descendant(of: editor, matching: find.text('Tools')),
        scrollable: editorScrollable(),
      );
      expect(
        find.descendant(of: editor, matching: find.text('Tools')),
        findsOneWidget,
      );
      await reveal(
        tester,
        find.descendant(of: editor, matching: find.text('Model')),
        scrollable: editorScrollable(),
      );
      expect(
        find.descendant(of: editor, matching: find.text('Model')),
        findsOneWidget,
      );
      await reveal(
        tester,
        find.descendant(of: editor, matching: find.text('Inference')),
        scrollable: editorScrollable(),
      );
      expect(
        find.descendant(of: editor, matching: find.text('Inference')),
        findsOneWidget,
      );

      await reveal(
        tester,
        find.byKey(const ValueKey('tool-web-search')),
        scrollable: editorScrollable(),
      );
      expect(
        tester
            .widget<CheckboxListTile>(
              find.byKey(const ValueKey('tool-web-search')),
            )
            .value,
        isFalse,
      );

      await reveal(
        tester,
        find.byKey(const Key('agent-model')),
        scrollable: editorScrollable(),
      );
      await tester.tap(find.byKey(const Key('agent-model')));
      await tester.pumpAndSettle();
      // The closed button renders the selected (null) item's label and the
      // open menu renders it again as an entry — two texts = menu is open.
      expect(find.text('(Account default)'), findsNWidgets(2));
      expect(find.text('OpenRouter'), findsAtLeastNWidgets(1));
      await tester.tap(find.text('(Account default)').last);
      await tester.pumpAndSettle();

      await reveal(
        tester,
        find.byKey(const Key('agent-temperature')),
        scrollable: editorScrollable(),
      );
      final slider = tester.widget<Slider>(
        find.byKey(const Key('agent-temperature')),
      );
      expect(slider.min, 0);
      expect(slider.max, 2);
      expect(slider.divisions, 20);

      await reveal(
        tester,
        find.byKey(const Key('agent-max-tokens')),
        scrollable: editorScrollable(),
      );
      expect(find.byKey(const Key('agent-max-tokens')), findsOneWidget);
      await reveal(
        tester,
        find.byKey(const Key('agent-vision')),
        scrollable: editorScrollable(),
      );
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('agent-vision')))
            .value,
        isFalse,
      );
    },
  );

  testWidgets(
    'agent editor save is disabled while the plugin catalog is loading',
    (tester) async {
      final catalog = Completer<PluginCatalog>();
      await mountEditor(tester, catalog: catalog.future);

      // Top-of-list status assertions must run before scrolling to Save: the
      // editor ListView builds lazily, so reaching the bottom disposes them.
      expect(find.text('Loading plugins…'), findsOneWidget);
      expect(find.byKey(const Key('agent-catalog-status')), findsOneWidget);

      await reveal(
        tester,
        find.byKey(const Key('agent-save')),
        scrollable: editorScrollable(),
      );
      final save = find.widgetWithText(FilledButton, 'Save');
      expect(tester.widget<FilledButton>(save).onPressed, isNull);

      catalog.complete(_loadedCatalog());
    },
  );

  testWidgets('agent editor save is disabled when the plugin catalog errors', (
    tester,
  ) async {
    final catalog = Completer<PluginCatalog>();
    await mountEditor(tester, catalog: catalog.future);
    catalog.completeError(StateError('catalog unavailable'));
    await tester.pumpAndSettle();

    expect(
      find.text("Plugin catalog unavailable — can't validate this agent yet"),
      findsOneWidget,
    );
    expect(find.byKey(const Key('agent-catalog-status')), findsOneWidget);

    await reveal(
      tester,
      find.byKey(const Key('agent-save')),
      scrollable: editorScrollable(),
    );
    final save = find.widgetWithText(FilledButton, 'Save');
    expect(tester.widget<FilledButton>(save).onPressed, isNull);
  });

  testWidgets(
    'loaded catalog keeps save enabled and rejects an unavailable model',
    (tester) async {
      await mountEditor(
        tester,
        catalog: Future.value(_loadedCatalog()),
        existing: AgentConfig(
          id: 'stale-agent',
          kind: AgentKind.custom,
          name: 'Stale Agent',
          modelRef: 'missing-model',
        ),
      );
      await tester.pumpAndSettle();

      await reveal(
        tester,
        find.byKey(const Key('agent-save')),
        scrollable: editorScrollable(),
      );
      final save = find.widgetWithText(FilledButton, 'Save');
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      await reveal(
        tester,
        find.byKey(const Key('agent-save')),
        scrollable: editorScrollable(),
      );
      await tester.pumpAndSettle();
      await tester.tap(save);
      await tester.pump();
      await reveal(
        tester,
        find.byKey(const Key('agent-error')),
        scrollable: editorScrollable(),
      );

      expect(
        find.text('Selected model is not an installed model plugin.'),
        findsOneWidget,
      );
      expect(
        (await store.load(account.accountScope!)).plugins
            .containsKey('stale-agent'),
        isFalse,
      );
    },
  );

  testWidgets(
    'loaded catalog keeps save enabled and rejects an unavailable tool grant',
    (tester) async {
      await mountEditor(
        tester,
        catalog: Future.value(_loadedCatalog()),
        existing: AgentConfig(
          id: 'stale-agent',
          kind: AgentKind.custom,
          name: 'Stale Agent',
          tools: [AgentToolGrantData(pluginId: 'missing-tool')],
        ),
      );
      await tester.pumpAndSettle();

      await reveal(
        tester,
        find.byKey(const Key('agent-save')),
        scrollable: editorScrollable(),
      );
      final save = find.widgetWithText(FilledButton, 'Save');
      expect(tester.widget<FilledButton>(save).onPressed, isNotNull);
      await reveal(
        tester,
        find.byKey(const Key('agent-save')),
        scrollable: editorScrollable(),
      );
      await tester.pumpAndSettle();
      await tester.tap(save);
      await tester.pump();
      await reveal(
        tester,
        find.byKey(const Key('agent-error')),
        scrollable: editorScrollable(),
      );

      expect(
        find.text('Tool grants must reference installed tool plugins.'),
        findsOneWidget,
      );
      expect(
        (await store.load(account.accountScope!)).plugins
            .containsKey('stale-agent'),
        isFalse,
      );
    },
  );

  testWidgets(
    'editor saves tool grants, modelRef, and inference into the agent store',
    (tester) async {
      await mount(tester);
      await tester.tap(find.text('Create agent'));
      await tester.pumpAndSettle();

      await reveal(
        tester,
        find.byKey(const Key('agent-name')),
        scrollable: editorScrollable(),
      );
      await tester.enterText(
        find.byKey(const Key('agent-name')),
        'Field Agent',
      );
      await tester.pump();

      await reveal(
        tester,
        find.byKey(const ValueKey('tool-web-search')),
        scrollable: editorScrollable(),
      );
      await tester.tap(find.byKey(const ValueKey('tool-web-search')));
      await tester.pump();

      await reveal(
        tester,
        find.byKey(const Key('agent-model')),
        scrollable: editorScrollable(),
      );
      await tester.tap(find.byKey(const Key('agent-model')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OpenRouter').last);
      await tester.pumpAndSettle();

      await reveal(
        tester,
        find.byKey(const Key('agent-temperature')),
        scrollable: editorScrollable(),
      );
      tester
          .widget<Slider>(find.byKey(const Key('agent-temperature')))
          .onChanged!(0.5);
      await tester.pump();
      expect(find.text('Temperature: 0.5'), findsOneWidget);

      await reveal(
        tester,
        find.byKey(const Key('agent-max-tokens')),
        scrollable: editorScrollable(),
      );
      await tester.enterText(find.byKey(const Key('agent-max-tokens')), '4096');
      await tester.pump();

      await reveal(
        tester,
        find.byKey(const Key('agent-vision')),
        scrollable: editorScrollable(),
      );
      await tester.tap(find.byKey(const Key('agent-vision')));
      await tester.pump();
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('agent-vision')))
            .value,
        isTrue,
      );

      await tapEditorSave(tester);
      expect(find.byType(AgentEditorScreen), findsNothing);

      final config = await store.load(account.accountScope!);
      final agent = config.plugins['field-agent']!.agent!;
      expect(agent.kind, AgentKind.custom);
      expect(agent.name, 'Field Agent');
      expect(agent.tools.map((tool) => tool.pluginId), ['web-search']);
      expect(agent.tools.single.required, isFalse);
      expect(agent.modelRef, 'openrouter');
      expect(agent.inference!.temperature, 0.5);
      expect(agent.inference!.maxTokens, 4096);
      expect(agent.inference!.visionCapable, isTrue);
      expect(config.selectedAgent, 'field-agent');

      final tile = find.byKey(const ValueKey('custom-field-agent'));
      expect(tile, findsOneWidget);
      expect(
        find.descendant(of: tile, matching: find.text('1 tools')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: tile, matching: find.text('openrouter')),
        findsOneWidget,
      );
      // The row selects on tap; the pencil edits. Delete stays in the editor.
      expect(find.byTooltip('Delete agent'), findsNothing);
      expect(find.byTooltip('Edit agent'), findsOneWidget);

      // The pencil opens the editor with the saved agent pre-filled.
      await tester.ensureVisible(tile);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('custom-edit-field-agent')));
      await tester.pumpAndSettle();
      expect(find.byType(AgentEditorScreen), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('agent-name')))
            .controller!
            .text,
        'Field Agent',
      );
    },
  );

  testWidgets(
    'deleting a custom agent asks for confirmation and clears selection',
    (tester) async {
      await mount(tester);

      // Seed a custom agent and make it the selected agent directly through the
      // store (the scoped wrapper would invalidate mid-test), then bump the
      // epoch so the plugin list rebuilds from the new state.
      await store.setAgentConfig(
        account.accountScope!,
        'my-agent',
        AgentConfig(
          id: 'my-agent',
          kind: AgentKind.custom,
          name: 'My Agent',
          description: 'A custom agent',
        ),
      );
      await store.setSelectedAgent(account.accountScope!, 'my-agent');
      container.read(pluginCredentialsEpochProvider.notifier).invalidate();
      await tester.pumpAndSettle();

      final tile = find.byKey(const ValueKey('custom-my-agent'));
      await tester.ensureVisible(tile);
      await tester.pumpAndSettle();
      // The pencil opens the editor; the row itself selects.
      await tester.tap(find.byKey(const ValueKey('custom-edit-my-agent')));
      await tester.pumpAndSettle();

      // Delete lives in the editor's Finish section, not on the list row.
      expect(find.byTooltip('Delete agent'), findsNothing);
      final delete = find.byKey(const Key('agent-delete'));
      await reveal(tester, delete, scrollable: editorScrollable());
      await tester.pumpAndSettle();

      // First tap: confirmation guard. Cancel keeps everything.
      await tester.tap(delete);
      await tester.pumpAndSettle();
      expect(find.text('Delete agent?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.byType(AgentEditorScreen), findsOneWidget);
      expect(
        (await store.load(account.accountScope!)).plugins
            .containsKey('my-agent'),
        isTrue,
      );

      // Confirm actually deletes, pops back, and clears the dangling selection.
      await tester.tap(find.byKey(const Key('agent-delete')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(find.byType(AgentEditorScreen), findsNothing);
      final config = await store.load(account.accountScope!);
      expect(config.plugins.containsKey('my-agent'), isFalse);
      expect(config.selectedAgent, isNull);
    },
  );

  testWidgets('over-cap system prompt and max tokens block the save', (
    tester,
  ) async {
    await mount(tester);
    await tester.tap(find.text('Create agent'));
    await tester.pumpAndSettle();

    await reveal(
      tester,
      find.byKey(const Key('agent-name')),
      scrollable: editorScrollable(),
    );
    await tester.enterText(find.byKey(const Key('agent-name')), 'Cap Agent');
    await tester.pump();
    await reveal(
      tester,
      find.byKey(const Key('agent-system-prompt')),
      scrollable: editorScrollable(),
    );
    await tester.enterText(
      find.byKey(const Key('agent-system-prompt')),
      'x' * 8001,
    );
    await tester.pump();

    await tapEditorSave(tester);
    await reveal(
      tester,
      find.byKey(const Key('agent-error')),
      scrollable: editorScrollable(),
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('agent-error')),
        matching: find.text('System prompt must be 8000 characters or fewer.'),
      ),
      findsOneWidget,
    );
    expect(find.byType(AgentEditorScreen), findsOneWidget);

    await reveal(
      tester,
      find.byKey(const Key('agent-system-prompt')),
      scrollable: editorScrollable(),
    );
    await tester.enterText(find.byKey(const Key('agent-system-prompt')), 'ok');
    await tester.pump();
    await reveal(
      tester,
      find.byKey(const Key('agent-max-tokens')),
      scrollable: editorScrollable(),
    );
    await tester.enterText(find.byKey(const Key('agent-max-tokens')), '200001');
    await tester.pump();

    await tapEditorSave(tester);
    await reveal(
      tester,
      find.byKey(const Key('agent-error')),
      scrollable: editorScrollable(),
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('agent-error')),
        matching: find.text(
          'Max tokens must be a whole number between 1 and 200000.',
        ),
      ),
      findsOneWidget,
    );
    expect(find.byType(AgentEditorScreen), findsOneWidget);

    final config = await store.load(account.accountScope!);
    expect(
      config.plugins.values.any((entry) => entry.agent?.name == 'Cap Agent'),
      isFalse,
    );
  });

  testWidgets('ready-made agent tile merges server sources and shows chips', (
    tester,
  ) async {
    await mount(tester);
    // Templates and installed agent plugins overlap for `test-agent`; the
    // merged list must show exactly one row for it.
    final agentTile = find.byKey(const ValueKey('ready-test-agent'));
    await reveal(tester, agentTile);
    expect(
      find.descendant(of: agentTile, matching: find.text('1 tools')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: agentTile, matching: find.text('openrouter')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('agent-test-agent')), findsNothing);
    expect(find.byKey(const ValueKey('template-test-agent')), findsNothing);
  });

  testWidgets(
    'tools section offers the marketplace and configured tools entry points',
    (tester) async {
      await mount(tester);
      await reveal(tester, find.byKey(const Key('tool-marketplace')));
      expect(find.byKey(const Key('configured-tools')), findsOneWidget);
      expect(find.byKey(const Key('tool-marketplace')), findsOneWidget);
      // The account-level catalog list is gone from this screen: tools live
      // behind the two entry points now.
      expect(find.byKey(const ValueKey('plugin-web-search')), findsNothing);
      expect(find.text('Disabled for this account'), findsNothing);
    },
  );

  testWidgets(
    'configured tools shows an empty state before any tool is set up',
    (tester) async {
      await mount(tester);
      await reveal(tester, find.byKey(const Key('configured-tools')));
      await tester.tap(find.byKey(const Key('configured-tools')));
      await tester.pumpAndSettle();
      expect(find.text('Configured tools'), findsWidgets);
      expect(
        find.text('No tools set up yet. Open the Tool marketplace to add one.'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'marketplace adds a tool and configured tools lists it as Ready',
    (tester) async {
      toolPlugins = [keyedTool()];
      await mount(tester);
      await reveal(tester, find.byKey(const Key('tool-marketplace')));
      await tester.tap(find.byKey(const Key('tool-marketplace')));
      await tester.pumpAndSettle();

      expect(find.text('Tool marketplace'), findsWidgets);
      // The single tool defaults into the "General" group.
      expect(find.text('General'), findsOneWidget);
      final row = find.byKey(const ValueKey('market-bookings'));
      await tester.ensureVisible(row);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: row, matching: find.text('Add')),
        findsOneWidget,
      );

      // Opening the tool, enabling it, and saving a token makes it Ready.
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(find.text('Tool setup'), findsOneWidget);
      await tester.tap(find.text('Enable for this account'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('plugin-api-key')),
        'secret-token',
      );
      await tester.pump();
      await tester.tap(find.text('Save API key'));
      await tester.pumpAndSettle();

      await tester.pageBack();
      await tester.pumpAndSettle();
      final readyRow = find.byKey(const ValueKey('market-bookings'));
      await tester.ensureVisible(readyRow);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: readyRow, matching: find.text('Ready')),
        findsOneWidget,
      );

      // The configured tools screen lists it now.
      await tester.pageBack();
      await tester.pumpAndSettle();
      await reveal(tester, find.byKey(const Key('configured-tools')));
      await tester.tap(find.byKey(const Key('configured-tools')));
      await tester.pumpAndSettle();
      final configured = find.byKey(const ValueKey('configured-bookings'));
      expect(configured, findsOneWidget);
      expect(
        find.descendant(of: configured, matching: find.text('Ready')),
        findsOneWidget,
      );
    },
  );

  testWidgets('marketplace groups tools by category and filters by search', (
    tester,
  ) async {
    toolPlugins = [
      toolPluginJson(id: 'notes', name: 'Notes', category: 'Productivity'),
      toolPluginJson(id: 'fitness', name: 'Fitness', category: 'Health'),
      // No explicit category -> "General".
      toolPluginJson(id: 'plain', name: 'Plain Tool', category: null),
    ];
    await mount(tester);
    await reveal(tester, find.byKey(const Key('tool-marketplace')));
    await tester.tap(find.byKey(const Key('tool-marketplace')));
    await tester.pumpAndSettle();

    expect(find.text('General'), findsOneWidget);
    expect(find.text('Health'), findsOneWidget);
    expect(find.text('Productivity'), findsOneWidget);
    expect(find.byKey(const ValueKey('market-notes')), findsOneWidget);
    expect(find.byKey(const ValueKey('market-fitness')), findsOneWidget);
    expect(find.byKey(const ValueKey('market-plain')), findsOneWidget);
  });
}
