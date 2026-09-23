import 'package:dio/dio.dart' show Dio;
import 'package:flutter/widgets.dart' show WidgetsBinding;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/http/dio_provider.dart';
import '../../auth/data/account_lifecycle.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/context_trimmer.dart';
import '../../chat/data/message_model.dart';
import '../../chat/ui/chat_lifecycle_observer.dart';
import '../../chat/ui/chat_providers.dart' show contextTrimmerProvider;
import 'langchain_client.dart';
import 'ledger_client.dart';
import 'managed_conversation_repository.dart';
import 'managed_conversation_service.dart';
import 'managed_resolution.dart';
import 'plugin_catalog_providers.dart';
import 'plugin_credentials_providers.dart';
import 'plugin_credentials_store.dart';
import 'plugin_http.dart';
import 'staged_inference_adapters.dart';

/// Gateway [LangChainClient] for managed chat turns — the account-scoped
/// sibling of `pluginRegistryClientProvider`: same `${scope.backendOrigin}/v1`
/// base URL (identical to the settings-derived gateway origin whenever
/// [pluginAccountScopeProvider] resolves) with per-request bearer auth from
/// the freshly-resolved `ManagedCredentials.gatewayKey`. This is the client
/// [ManagedConversationService] needs for `/v1/chat/completions` managed
/// turns and `/v1/sessions` reconcile reads.
final managedLangChainClientProvider = Provider<LangChainClient>((ref) {
  final scope = ref.watch(pluginAccountScopeProvider);
  return LangChainClient(
    dio: ref.watch(dioProvider),
    baseUrl: '${scope.backendOrigin}/v1',
  );
});

/// Account-scoped, non-autoDispose send adapter (plan §3): ONE per-send
/// construction path shared by the chat UI (and, in P2, voice). Each call
/// resolves `SelectedModel` + enabled plugins + credentials fresh, freezes
/// them into a single [ManagedConversationService] for that turn, and
/// forwards. Non-autoDispose so a conversation notifier rebuild (or an
/// autoDispose UI family disposing mid-poll) can never orphan a pending turn
/// or ledger watch. Reading it while plugin access is not ready rethrows
/// [PluginReauthenticationRequired] from [pluginAccountScopeProvider] —
/// callers surface that as the re-auth state, not a crash.
final managedChatAdapterProvider = Provider<ManagedChatAdapter>((ref) {
  final scope = ref.watch(pluginAccountScopeProvider);
  final authStore = ref.watch(authCredentialsStoreProvider);
  final pluginStore = ref.watch(pluginCredentialsStoreProvider);
  final registry = ref.watch(pluginRegistryClientProvider);
  // NOTE: the model list is intentionally NOT cached across resolutions (M1
  // perf finding): resolveManagedSelection re-fetches it per dispatch/poll so
  // the gateway's catalog is always fresh — a stale cache would keep resolving
  // a selection the gateway no longer lists. Deferred: a per-element cache
  // changes resolution semantics (breaks 'registry.models = []' test contract
  // and the configuration_changed guard would go stale).
  return ManagedChatAdapter(
    scope: scope,
    client: ref.watch(managedLangChainClientProvider),
    repo: ref.watch(managedConversationRepositoryProvider),
    trimmer: ref.watch(contextTrimmerProvider),
    resolveSelection: () => resolveManagedSelection(
      scope: scope,
      authStore: authStore,
      pluginStore: pluginStore,
      loadModels: ({required gatewayKey, cancelToken}) =>
          registry.listModels(gatewayKey: gatewayKey, cancelToken: cancelToken),
    ),
  );
});

/// Account-scoped staged adapters (plan §3/P2): managed voice turns
/// (`sendVoiceTurn`) and vision probes over the SAME client/repository/
/// scope/trimmer/model-list wiring as [managedChatAdapterProvider]. The
/// factory registers an [AccountCleanupRegistration], so the instance MUST be
/// disposed when the scope changes — done here via [ref.onDispose], which also
/// runs the adapter's scope-wide cancel so a replaced account's in-flight
/// voice turn can never write into the old epoch.
final stagedInferenceAdaptersProvider = Provider<StagedInferenceAdapters>((
  ref,
) {
  final scope = ref.watch(pluginAccountScopeProvider);
  final registry = ref.watch(pluginRegistryClientProvider);
  final adapters = createStagedInferenceAdapters(
    client: ref.watch(managedLangChainClientProvider),
    repository: ref.watch(managedConversationRepositoryProvider),
    scope: scope,
    trimmer: ref.watch(contextTrimmerProvider),
    currentScope: () {
      try {
        return ref.read(pluginAccountScopeProvider);
      } catch (_) {
        // Loading / re-auth required / provider disposed: treat as "not the
        // captured scope" so in-flight epoch checks surface `cancelled`.
        return null;
      }
    },
    authStore: ref.watch(authCredentialsStoreProvider),
    pluginStore: ref.watch(pluginCredentialsStoreProvider),
    loadModels: registry.listModels,
    lifecycle: ref.watch(accountLifecycleProvider),
  );
  ref.onDispose(adapters.dispose);
  return adapters;
});

/// Account-bound adapter over [ManagedConversationService]: every public call
/// runs the one per-send construction path — resolve selection fresh
/// ([resolveSelection], a `resolveManagedSelection` closure), build ONE
/// service with `modelPluginId`/`enabledPlugins` frozen for this turn while
/// its `credentials` closure re-resolves on each dispatch, then forward.
class ManagedChatAdapter {
  ManagedChatAdapter({
    required this.scope,
    required this.client,
    required this.repo,
    required this.trimmer,
    required this.resolveSelection,
    this._poller,
  });

  final AuthAccountScope scope;
  final LangChainClient client;
  final ManagedConversationRepository repo;
  final ContextTrimmer trimmer;
  final Future<ManagedSelection> Function() resolveSelection;
  LedgerPoller? _poller;

  /// Per-send construction: resolves model + enabled plugins + credentials
  /// now, then builds the turn's [ManagedConversationService] with those
  /// frozen (`modelPluginId`/`enabledPlugins` bind at construction) and a
  /// `credentials` closure that re-resolves fresh on every `_dispatch`.
  // P2: sendVoiceTurn runs this same construction (via buildManagedService).
  Future<ManagedConversationService> buildService() async {
    final selection = await _resolve();
    return buildManagedService(
      client: client,
      repo: repo,
      scope: scope,
      trimmer: trimmer,
      selection: selection,
      resolve: _resolve,
      poller: poller,
    );
  }

  /// The account-scoped background-job poller shared by every per-send
  /// service (plan P3): stable across sends so the app-lifecycle observer can
  /// arm/suspend the live background watches via [setForeground], and tests
  /// can inject a controllable instance. Built lazily when none was injected
  /// (mirrors [ManagedConversationService]'s own lazy default).
  LedgerPoller get poller {
    final existing = _poller;
    if (existing != null) return existing;
    final created = LedgerPoller(
      client: LedgerClient(dio: Dio(), scope: scope),
      credentials: _pollCredentials,
    );
    _poller = created;
    return created;
  }

  /// Poller credentials resolve through the same fresh selection path as a
  /// dispatch; a resolution gap degrades to `null` (the poller surfaces
  /// `missing_gateway_key`) so a broken config never crashes the poll loop.
  Future<AuthCredentials?> _pollCredentials() async {
    try {
      final selection = await _resolve();
      return AuthCredentials(
        apiKey: selection.credentials.gatewayKey,
        ownerId: scope.ownerId,
        backendOrigin: scope.backendOrigin,
      );
    } catch (_) {
      return null;
    }
  }

  /// Arms ([true]) or suspends ([false]) the account's live background
  /// watches (plan P3 foreground liveness). A suspended app runs no poll
  /// timers; on resume the lifecycle observer re-watches still-pending jobs.
  void setForeground(bool foreground) => poller.setForeground(foreground);

  /// Re-arms a fresh ledger watch for [conversationId]'s still-pending
  /// BACKGROUND job (the original handle's deadline may have expired while
  /// suspended). Returns the new handle, or null when no pending background
  /// envelope exists. A bare per-turn service is used — the watch needs no
  /// model/plugin selection (the job already ran server-side); a selection
  /// gap degrades the terminal credential resolver to `null` (fail-open,
  /// marker retained for an explicit retry).
  Future<LedgerPollHandle?> rewatchPendingBackground(
    String conversationId,
  ) async {
    try {
      return await buildService().then(
        (service) => service.rewatchPendingBackground(conversationId),
      );
    } on PluginClientException {
      // Selection resolution failed (no_selected_model / no_credentials /
      // ...): a re-watch needs no model/plugin — the job already submitted —
      // so fall back to the bare service. Any OTHER failure (a real bug)
      // propagates instead of being silently swallowed.
      return _bareService().rewatchPendingBackground(conversationId);
    }
  }

  /// Enumerates every still-pending BACKGROUND job in the account and re-arms
  /// a fresh watch for each (plan P3 foreground resume). Returns the
  /// conversation ids re-watched. Best-effort per row: a malformed envelope
  /// or a cancelled scope skips that row without failing the whole pass.
  Future<List<String>> rewatchPendingBackgroundOnForeground() async {
    final service = _bareService();
    final rows = await repo.pendingRows(scope);
    final rewound = <String>[];
    for (final row in rows) {
      if (row.reconcileOnly) continue;
      try {
        final handle = await service.rewatchPendingBackground(
          row.conversationId,
        );
        if (handle != null) rewound.add(row.conversationId);
      } on PluginClientException {
        // Scope cancelled / malformed envelope — skip, the next resume retries.
      }
    }
    return rewound;
  }

  /// Bare per-turn service for watch-only / selection-gap paths (foreground
  /// re-watch, the abandon fallback): model and plugins are irrelevant (the
  /// job already submitted), so selection resolution failures degrade the
  /// credentials resolver to `null` instead of blocking the path.
  ManagedConversationService _bareService() => ManagedConversationService(
    client: client,
    repo: repo,
    scope: scope,
    trimmer: trimmer,
    poller: poller,
    credentials: () async {
      try {
        return (await _resolve()).credentials;
      } catch (_) {
        return null;
      }
    },
  );

  Future<ManagedSelection> _resolve() async {
    try {
      return await resolveSelection();
    } on StagedInferenceUnavailable catch (error) {
      // Mirror the staged adapters' handling: callers get a typed
      // PluginClientException (no_selected_model / no_credentials / ...) and
      // never a raw resolution crash.
      throw PluginClientException(error.code);
    }
  }

  Future<ManagedTurnOutcome> sendTurn(
    String conversationId, {
    required List<Message> history,
    required String userText,
    String? sessionId,
    void Function(String delta)? onContent,
  }) async {
    final service = await buildService();
    return service.sendTurn(
      conversationId,
      history: history,
      userText: userText,
      sessionId: sessionId,
      onContent: onContent,
    );
  }

  Future<ManagedTurnOutcome> retryTurn(
    String conversationId, {
    void Function(String delta)? onContent,
  }) async {
    final service = await buildService();
    return service.retryTurn(conversationId, onContent: onContent);
  }

  /// Abandons the conversation's in-flight/failed turn (plan §3). Built via
  /// [buildService] when selection resolves so a live turn gets a
  /// credentials-aware terminal check; on a selection failure falls back to a
  /// bare service whose credentials resolver re-attempts selection and
  /// degrades to `null` (terminal detection fails open to the partial-clear
  /// path — abandon must never be blocked by a config gap).
  Future<void> abandonTurn(
    String conversationId, {
    String? sessionId,
    int? generation,
    String? partialText,
  }) async {
    ManagedConversationService service;
    try {
      service = await buildService();
    } on PluginClientException {
      service = _bareService();
    }
    return service.abandonTurn(
      conversationId,
      sessionId: sessionId,
      generation: generation,
      partialText: partialText,
    );
  }

  /// True when the conversation's pending row is a BACKGROUND envelope (plan
  /// P3). Forwarded so the chat notifier can keep the pending-job chip on a
  /// `pending_turn_exists` rejection against a genuinely running job.
  Future<bool> hasPendingBackground(String conversationId) async {
    final service = await buildService();
    return service.hasPendingBackground(conversationId);
  }

  /// Abandons the conversation's staged turn UNLESS it is a background job's
  /// pending envelope (plan P3): the chat notifier's `pending_turn_exists`
  /// escape hatch must never destroy a running background job's reply. Returns
  /// true when the pending row was cleared (or none existed); false when a
  /// background envelope was retained.
  Future<bool> abandonTurnKeepingBackground(
    String conversationId, {
    String? sessionId,
    int? generation,
    String? partialText,
  }) async {
    ManagedConversationService service;
    try {
      service = await buildService();
    } on PluginClientException {
      service = _bareService();
    }
    return service.abandonTurnKeepingBackground(
      conversationId,
      sessionId: sessionId,
      generation: generation,
      partialText: partialText,
    );
  }

  Future<LedgerPollHandle> submitBackground(
    String conversationId, {
    required List<Message> history,
    required String userText,
  }) async {
    final service = await buildService();
    return service.submitBackground(
      conversationId,
      history: history,
      userText: userText,
    );
  }

  Future<List<Message>> reconcileFromServer(String conversationId) async {
    final service = await buildService();
    return service.reconcileFromServer(conversationId);
  }
}

/// App-lifecycle wiring for background-job liveness (plan P3): background
/// inference is **foreground-gated** — the poller runs no timers while
/// suspended, so on `resumed` it is re-armed ([ManagedChatAdapter.setForeground
/// (true)]) and every still-pending background job gets a FRESH ledger watch
/// ([ManagedChatAdapter.rewatchPendingBackgroundOnForeground], because a
/// suspended app may have expired the original handle's fixed deadline). On
/// `paused`/`hidden`/`detached` polling is suspended so nothing runs in the
/// background. Kept alive app-wide by `AiAssistantApp` (read at startup), not
/// by any autoDispose UI family — a conversation notifier rebuild must never
/// orphan the observer while a background job is pending.
final chatPollerLifecycleObserverProvider = Provider<ChatLifecycleObserver>((
  ref,
) {
  Future<void> onForeground() async {
    try {
      ref.read(managedChatAdapterProvider).setForeground(true);
    } on PluginReauthenticationRequired {
      return; // scope unavailable — nothing to arm.
    } catch (_) {
      return;
    }
    try {
      await ref.read(managedChatAdapterProvider)
          .rewatchPendingBackgroundOnForeground();
    } catch (_) {
      // Best-effort: a failed re-watch leaves the pending marker for the next
      // resume (or an explicit retry from the chip).
    }
  }

  Future<void> onBackground() async {
    try {
      ref.read(managedChatAdapterProvider).setForeground(false);
    } catch (_) {
      // Scope unavailable / adapter not built — nothing live to suspend.
    }
  }

  final observer = ChatLifecycleObserver(
    onForeground: onForeground,
    onBackground: onBackground,
  );
  WidgetsBinding.instance.addObserver(observer);
  ref.onDispose(observer.dispose);
  return observer;
});
