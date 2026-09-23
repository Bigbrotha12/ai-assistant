import 'dart:convert';

import 'package:dio/dio.dart';

import '../../../core/backend_probe.dart';
import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/context_trimmer.dart';
import 'langchain_client.dart';
import 'ledger_client.dart';
import 'managed_conversation_repository.dart';
import 'managed_conversation_service.dart';
import 'plugin_credentials_store.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';
import 'staged_inference_adapters.dart';

/// Freshly-resolved selection for ONE managed send: the model id and enabled
/// tool plugins frozen at dispatch start, plus the credentials resolved at
/// that instant.
typedef ManagedSelection = ({
  String modelId,
  List<String> enabledPlugins,
  ManagedCredentials credentials,
});

/// Resolves the model/plugin/credential selection for one managed send —
/// text, voice, or vision — through ONE resolver (plan §3): gateway auth, the
/// account's plugin configuration, and the live model list are each loaded
/// fresh, then narrowed to a streaming-capable model and its credentials.
///
/// [vision] switches the selection half: vision picks the first
/// vision-capable configured candidate (selected model first, then enabled
/// tool plugins) with an empty tool-plugin list, failing with
/// `no_capable_model` when none exists; non-vision is strictly the selected
/// model plus its sorted enabled-tool list, failing with `no_selected_model`.
///
/// Epoch/cancel-token guards stay with the caller via [check], invoked around
/// each load: the staged adapter passes its captured-epoch `_check`, while the
/// chat adapter passes nothing and relies on the service's own epoch checks
/// around admission and dispatch. A scope mismatch observed after the auth
/// load fires [onScopeMismatch] (the staged adapter's scope-wide `cancel()`
/// side effect — deliberately NOT applied to `check`-thrown `cancelled`, which
/// must never bump the epoch) and surfaces as `cancelled`.
///
/// Throws [StagedInferenceUnavailable] (`no_selected_model` /
/// `no_capable_model` / `no_credentials`); callers translate those into
/// [PluginClientException] with the same codes for the typed error surface.
Future<ManagedSelection> resolveManagedSelection({
  required AuthAccountScope scope,
  required AuthCredentialsStore authStore,
  required PluginCredentialsStore pluginStore,
  required Future<List<PluginModelDto>> Function({
    required String gatewayKey,
    CancelToken? cancelToken,
  })
  loadModels,
  CancelToken? cancelToken,
  bool vision = false,
  void Function()? check,
  void Function()? onScopeMismatch,
}) async {
  check?.call();
  final auth = await authStore.load();
  check?.call();
  if (auth == null || auth.apiKey.trim().isEmpty) {
    throw const StagedInferenceUnavailable(
      ProbeStatus.noCredentials,
      'no_credentials',
    );
  }
  if (auth.accountScope != scope) {
    onScopeMismatch?.call();
    throw const PluginClientException('cancelled');
  }
  final config = await pluginStore.load(scope);
  check?.call();
  final models = await loadModels(
    gatewayKey: auth.apiKey,
    cancelToken: cancelToken,
  );
  check?.call();

  if (vision) {
    final candidates =
        models
            .where(
              (m) =>
                  m.supportsStreaming &&
                  m.visionCapable &&
                  (m.id == config.selectedModel ||
                      config.plugins[m.id]?.enabled == true),
            )
            .toList()
          ..sort((a, b) {
            if (a.id == config.selectedModel) return -1;
            if (b.id == config.selectedModel) return 1;
            return a.id.compareTo(b.id);
          });
    if (candidates.isEmpty) {
      throw const StagedInferenceUnavailable(
        ProbeStatus.error,
        'no_capable_model',
      );
    }
    for (final model in candidates) {
      final fields = config.plugins[model.id]?.credentials;
      if (fields == null || (fields['apiKey']?.trim().isEmpty ?? true)) {
        continue;
      }
      // Vision sends no tool plugins: only the model's own credentials ride.
      return (
        modelId: model.id,
        enabledPlugins: const <String>[],
        credentials: ManagedCredentials(
          gatewayKey: auth.apiKey,
          provider: {model.id: fields},
        ),
      );
    }
    throw const StagedInferenceUnavailable(
      ProbeStatus.noCredentials,
      'no_credentials',
    );
  }

  final model = models
      .where((m) => m.id == config.selectedModel && m.supportsStreaming)
      .firstOrNull;
  if (model == null) {
    throw const StagedInferenceUnavailable(
      ProbeStatus.error,
      'no_selected_model',
    );
  }
  final fields = config.plugins[model.id]?.credentials;
  if (fields == null || (fields['apiKey']?.trim().isEmpty ?? true)) {
    throw const StagedInferenceUnavailable(
      ProbeStatus.noCredentials,
      'no_credentials',
    );
  }
  final enabled = config.plugins.entries
      .where(
        (entry) => entry.value.enabled && !models.any((m) => m.id == entry.key),
      )
      .map((entry) => entry.key)
      .toList()
    ..sort();
  return (
    modelId: model.id,
    enabledPlugins: enabled,
    credentials: ManagedCredentials(
      gatewayKey: auth.apiKey,
      provider: {
        model.id: fields,
        for (final id in enabled) id: config.plugins[id]!.credentials,
      },
    ),
  );
}

/// ONE per-send construction path shared by the chat adapter and
/// `StagedInferenceAdapters.sendVoiceTurn` (plan §3): [selection] freezes
/// `modelPluginId`/`enabledPlugins` into the turn's
/// [ManagedConversationService], while the `credentials` closure re-resolves
/// [resolve] fresh on every dispatch so a revoked key never rides a persisted
/// envelope. [stableSelection] (voice) additionally rejects mid-turn model/
/// plugin drift with `configuration_changed`; text leaves it off and rides
/// the frozen ids.
ManagedConversationService buildManagedService({
  required LangChainClient client,
  required ManagedConversationRepository repo,
  required AuthAccountScope scope,
  required ContextTrimmer trimmer,
  required ManagedSelection selection,
  required Future<ManagedSelection> Function() resolve,
  bool stableSelection = false,
  LedgerPoller? poller,
}) => ManagedConversationService(
  client: client,
  repo: repo,
  scope: scope,
  modelPluginId: selection.modelId,
  enabledPlugins: selection.enabledPlugins,
  trimmer: trimmer,
  poller: poller,
  credentials: () async {
    final fresh = await resolve();
    if (stableSelection &&
        (fresh.modelId != selection.modelId ||
            jsonEncode(fresh.enabledPlugins) !=
                jsonEncode(selection.enabledPlugins))) {
      throw const PluginClientException('configuration_changed');
    }
    return fresh.credentials;
  },
);
