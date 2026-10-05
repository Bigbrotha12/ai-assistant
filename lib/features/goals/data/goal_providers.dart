import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../core/http/dio_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../plugins/data/agent_config.dart';
import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../../plugins/data/plugin_http.dart';
import 'goal_client.dart';
import 'goal_dto.dart';

/// The gateway origin the goals are admitted on, built the same way the other
/// `/v1` clients build theirs (`PluginRegistryClient`, `LangChainClient`).
final goalClientProvider = Provider<GoalClient>((ref) {
  final scope = ref.watch(pluginAccountScopeProvider);
  return GoalClient(
    dio: ref.watch(dioProvider),
    baseUrl: '${scope.backendOrigin}/v1',
  );
});

/// Token budget the chat-surface trigger pins on a new goal: `tokenBudget` is
/// required by `POST /v1/goals` (§12's example value), and Phase 7 (plan M5)
/// is what turns it into enforced accounting — today it is stored on the goal.
const kGoalTokenBudget = 200000;

/// The Phase 3.7 send surface: admits a goal from the chat composer with the
/// account's pinned model credentials (§12 `POST /v1/goals`).
///
/// Every call re-reads the credentials STORE rather than a cached selection:
/// a revoked key must never ride an admission, mirroring the managed chat
/// path's resolve-fresh-per-dispatch rule.
class GoalTrigger {
  GoalTrigger(this._ref);

  final Ref _ref;

  /// Literal copy for the ONE prerequisite the phrase mapper cannot express:
  /// goals are admitted against an agent id (§12), so an account with no
  /// configured template agent cannot submit one. Every other gap — no model,
  /// no key — throws its typed [ManagedErrorCodes] entry and gets its own
  /// phrase from `statusPhraseForError`.
  static const agentGapMessage =
      'Goals run with a configured agent — pick one in Plugins first.';

  /// `null` when the trigger can be armed; otherwise the message to show the
  /// user. Checks only what has no typed error code of its own.
  Future<String?> gate() async {
    final config = await _load();
    return _agentId(config) == null ? agentGapMessage : null;
  }

  /// `POST /v1/goals` with the account's pinned model + selected agent.
  Future<GoalSubmitted> submit(String instruction) async {
    final text = instruction.trim();
    if (text.isEmpty) {
      throw const PluginClientException('invalid_request');
    }
    final config = await _load();

    // Gateway auth first (the same rule `resolveManagedSelection` applies):
    // no loaded session or a blank key is a credentials gap, never a
    // `missing_gateway_key` transport error.
    final auth = await _ref.read(authCredentialsProvider.future);
    final gatewayKey = auth?.apiKey ?? '';
    if (gatewayKey.trim().isEmpty) {
      throw const PluginClientException(ManagedErrorCodes.noCredentials);
    }

    final modelId = config.selectedModel;
    if (modelId == null || modelId.trim().isEmpty) {
      throw const PluginClientException(ManagedErrorCodes.noSelectedModel);
    }
    final credentials = config.plugins[modelId]?.credentials;
    if (credentials == null || (credentials['apiKey']?.trim().isEmpty ?? true)) {
      throw const PluginClientException(ManagedErrorCodes.noCredentials);
    }
    final agent = _agentId(config);
    if (agent == null) {
      // Defensive: [gate] refuses this path, but a selection could change
      // between the toggle and the send.
      throw const PluginClientException('invalid_request');
    }

    return _ref.read(goalClientProvider).submit(
      gatewayKey: gatewayKey,
      instruction: text,
      agent: agent,
      modelPluginId: modelId,
      tokenBudget: kGoalTokenBudget,
      clientGoalId: const Uuid().v4(),
      modelCredentials: credentials,
    );
  }

  Future<PluginAccountConfiguration> _load() {
    final scope = _ref.read(pluginAccountScopeProvider);
    return _ref.read(pluginCredentialsStoreProvider).load(scope);
  }

  /// The agent id §12 needs: a configured TEMPLATE agent (a gateway template
  /// or an installed agent plugin — both resolve server-side at
  /// `index.ts:resolveGoalAgent`). A custom agent is a spec object, not an id
  /// the goal route can resolve, so it never admits a goal.
  static String? _agentId(PluginAccountConfiguration config) {
    final id = config.selectedAgent?.trim();
    if (id == null || id.isEmpty) return null;
    final agent = config.plugins[id]?.agent;
    if (agent == null || agent.kind != AgentKind.template) return null;
    return id;
  }
}

final goalTriggerProvider = Provider<GoalTrigger>(
  (ref) => GoalTrigger(ref),
);

/// `GET /v1/goals`. AutoDispose releases it when nothing observes it, but
/// [goalAttentionProvider] keeps it alive for the session; `showGoalsOverlay`
/// therefore invalidates it on every open so the overlay still renders a fresh
/// first page rather than the retained snapshot.
final goalListProvider = AsyncNotifierProvider.autoDispose<
  GoalListNotifier,
  GoalListPage
>(GoalListNotifier.new);

/// First page of the owner's goals + append-only paging. Read-only: nothing
/// here mutates a goal, and a failed `loadMore` keeps the rows already loaded
/// (the footer simply stays tappable).
class GoalListNotifier extends AsyncNotifier<GoalListPage> {
  /// The server's own page cap (`PUBLIC_TASK_PAGE_MAX_LIMIT`).
  static const pageSize = 100;

  GoalClient? _client;
  String _gatewayKey = '';

  @override
  Future<GoalListPage> build() {
    _client = ref.watch(goalClientProvider);
    _gatewayKey = ref.watch(
      authCredentialsProvider.select((auth) => auth.value?.apiKey ?? ''),
    );
    if (_gatewayKey.trim().isEmpty) {
      throw const PluginClientException(ManagedErrorCodes.noCredentials);
    }
    return _client!.list(gatewayKey: _gatewayKey, goalLimit: pageSize);
  }

  /// Appends the next page behind the footer action.
  Future<void> loadMore() async {
    final client = _client;
    final current = state.value;
    final offset = current?.nextOffset;
    if (client == null || current == null || offset == null) return;
    try {
      final next = await client.list(
        gatewayKey: _gatewayKey,
        goalLimit: pageSize,
        offset: offset,
      );
      if (!ref.mounted) return;
      state = AsyncData(
        GoalListPage(
          goals: [...current.goals, ...next.goals],
          nextOffset: next.nextOffset,
        ),
      );
    } catch (_) {
      // Keep what is loaded; the footer remains and can be tapped again.
    }
  }
}

/// `GET /v1/goals/:id`, kept live by the todo view's poller.
final goalDetailProvider = AsyncNotifierProvider.autoDispose
    .family<GoalDetailNotifier, GoalDetail, String>(GoalDetailNotifier.new);

/// Loads one goal's detail and supports [refresh] — the live re-read the todo
/// view polls. A refresh keeps the last good payload on screen: it neither
/// flips the view back to a spinner nor blanks a running goal when a single
/// poll fails (the poller simply tries again).
class GoalDetailNotifier extends AsyncNotifier<GoalDetail> {
  GoalDetailNotifier(this.goalId);

  final String goalId;

  GoalClient? _client;
  String _gatewayKey = '';

  @override
  Future<GoalDetail> build() {
    _client = ref.watch(goalClientProvider);
    // Keyed with `select` (not `.future`): an auth RESOLUTION must not re-run
    // the build — that would leave a second request in flight behind the one
    // that already rendered — while a genuinely NEW key still refetches.
    _gatewayKey = ref.watch(
      authCredentialsProvider.select((auth) => auth.value?.apiKey ?? ''),
    );
    if (_gatewayKey.trim().isEmpty) {
      throw const PluginClientException(ManagedErrorCodes.noCredentials);
    }
    return _client!.fetch(goalId, gatewayKey: _gatewayKey);
  }

  Future<void> refresh() async {
    final client = _client;
    if (client == null) return;
    try {
      final next = await client.fetch(goalId, gatewayKey: _gatewayKey);
      if (!ref.mounted) return;
      state = AsyncData(next);
    } catch (_) {
      // Keep whatever is on screen — the last good payload, or the initial
      // error when the first load failed. The poller retries next tick; a
      // transient failure must neither blank a running goal nor escalate.
    }
  }
}
