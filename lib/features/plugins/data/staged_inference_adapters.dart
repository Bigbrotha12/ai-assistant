import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../../core/backend_probe.dart';
import '../../auth/data/account_lifecycle.dart';
import '../../auth/data/auth_credentials_store.dart';
import '../../chat/data/chat_client.dart';
import '../../chat/data/context_trimmer.dart';
import '../../chat/data/message_model.dart';
import '../../chat/data/sse.dart';
import 'managed_conversation_dto.dart';
import '../../vision/data/vision_client.dart';
import 'langchain_client.dart';
import 'langchain_request.dart';
import 'managed_conversation_repository.dart';
import 'managed_conversation_service.dart';
import 'managed_resolution.dart';
import 'plugin_credentials_store.dart';
import 'plugin_dto.dart';
import 'plugin_http.dart';

StagedInferenceAdapters createStagedInferenceAdapters({
  required LangChainClient client,
  required ManagedConversationRepository repository,
  required AuthAccountScope scope,
  required ContextTrimmer trimmer,
  required AuthAccountScope? Function() currentScope,
  required AuthCredentialsStore authStore,
  required PluginCredentialsStore pluginStore,
  required Future<List<PluginModelDto>> Function({
    required String gatewayKey,
    CancelToken? cancelToken,
  })
  loadModels,
  required AccountLifecycle lifecycle,
}) => StagedInferenceAdapters._(
  client,
  repository,
  scope,
  trimmer,
  currentScope,
  authStore,
  pluginStore,
  loadModels,
  lifecycle,
);

class StagedInferenceUnavailable implements Exception {
  const StagedInferenceUnavailable(this.status, this.code);

  final ProbeStatus status;
  final String code;

  @override
  String toString() => 'StagedInferenceUnavailable: $code';
}

class StagedInferenceAdapters implements VisionClient {
  StagedInferenceAdapters._(
    this._client,
    this._repo,
    this._scope,
    this._trimmer,
    this._currentScope,
    this._authStore,
    this._pluginStore,
    this._loadModels,
    this._lifecycle,
  ) : _lifecycleEpoch = _lifecycle.epoch {
    _unregister = _lifecycle.register(
      AccountCleanupRegistration(
        cancelPending: cancel,
        clearLocal: (scope) async {
          if (scope == _scope) {
            cancel();
            await _repo.clearScope(scope);
          }
        },
      ),
    );
  }

  static const maxImageBytes = 4 * 1024 * 1024;
  static const _mimeTypes = {
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  };

  final LangChainClient _client;
  final ManagedConversationRepository _repo;
  final AuthAccountScope _scope;
  final ContextTrimmer _trimmer;
  final AuthAccountScope? Function() _currentScope;
  final AuthCredentialsStore _authStore;
  final PluginCredentialsStore _pluginStore;
  final Future<List<PluginModelDto>> Function({
    required String gatewayKey,
    CancelToken? cancelToken,
  })
  _loadModels;
  final AccountLifecycle _lifecycle;
  final int _lifecycleEpoch;
  late final void Function() _unregister;
  bool _disposed = false;
  bool _voiceBusy = false;

  void _check(int epoch, CancelToken? token) {
    if (_disposed ||
        token?.isCancelled == true ||
        _currentScope() != _scope ||
        _lifecycle.blocked ||
        _lifecycle.epoch != _lifecycleEpoch ||
        _repo.epoch(_scope) != epoch) {
      throw const PluginClientException('cancelled');
    }
  }

  /// ONE resolver shared with the chat adapter (plan §3): delegates to
  /// [resolveManagedSelection], threading this adapter's per-load epoch/cancel
  /// guard and its scope-mismatch `cancel()` side effect.
  Future<ManagedSelection> _resolve(
    int epoch,
    CancelToken? token, {
    required bool vision,
  }) => resolveManagedSelection(
    scope: _scope,
    authStore: _authStore,
    pluginStore: _pluginStore,
    loadModels: _loadModels,
    cancelToken: token,
    vision: vision,
    check: () => _check(epoch, token),
    onScopeMismatch: cancel,
  );

  /// Non-vision [_resolve] with the chat adapter's error mapping: voice
  /// callers get typed [PluginClientException]s (`no_selected_model` /
  /// `no_credentials`) instead of raw [StagedInferenceUnavailable]. Vision
  /// callers ([probeVision]) keep the raw form — probe translates the status.
  Future<ManagedSelection> _mappedResolve(int epoch, CancelToken? token) async {
    try {
      return await _resolve(epoch, token, vision: false);
    } on StagedInferenceUnavailable catch (error) {
      throw PluginClientException(error.code);
    }
  }

  /// Managed voice turn: one per-send construction (plan §3 — same
  /// [buildManagedService] path as text) with a frozen selection that rejects
  /// mid-turn drift (`configuration_changed`), history loaded from the scoped
  /// store, and [onContent] forwarded to the service for sentence-buffered
  /// TTS.
  ///
  /// Interrupt/barge-in is the CALLER's sequenced `abandonTurn` (plan P2):
  /// this method never wires `cancelToken.whenCancel` to `cancel()` — a
  /// scope-wide epoch bump there would make the abandon's guarded write fail
  /// and strand the pending row (the wedge). A cancelled [cancelToken] only
  /// fails this adapter's own epoch checks.
  Future<ManagedTurnOutcome> sendVoiceTurn(
    String conversationId, {
    required String userText,
    CancelToken? cancelToken,
    void Function(String delta)? onContent,
    void Function(ManagedTurnOutcome outcome)? onCompleted,
  }) async {
    final epoch = _repo.epoch(_scope);
    _check(epoch, cancelToken);
    if (_voiceBusy) throw const PluginClientException('conversation_in_flight');
    _voiceBusy = true;
    try {
      final selection = await _mappedResolve(epoch, cancelToken);
      final history = await _repo.access(
        _scope,
        epoch,
        () => _check(epoch, cancelToken),
        (store) async =>
            (await store.loadConversation(conversationId))?.messages ??
            <Message>[],
      );
      _check(epoch, cancelToken);
      final service = buildManagedService(
        client: _CurrentManagedClient(
          _client,
          () => _check(epoch, cancelToken),
        ),
        repo: _repo,
        scope: _scope,
        trimmer: _trimmer,
        selection: selection,
        resolve: () => _mappedResolve(epoch, cancelToken),
        stableSelection: true,
      );
      final outcome = await service.sendTurn(
        conversationId,
        history: history,
        userText: userText,
        onContent: onContent,
      );
      _check(epoch, cancelToken);
      onCompleted?.call(outcome);
      return outcome;
    } finally {
      _voiceBusy = false;
    }
  }

  Future<CheckResult> probeVision({CancelToken? cancelToken}) async {
    final epoch = _repo.epoch(_scope);
    try {
      final selection = await _resolve(epoch, cancelToken, vision: true);
      return CheckResult(
        check: BackendCheck.vision,
        status: ProbeStatus.ok,
        detail: selection.modelId,
      );
    } on StagedInferenceUnavailable catch (error) {
      return CheckResult(
        check: BackendCheck.vision,
        status: error.status,
        detail: error.code,
      );
    }
  }

  @override
  Future<String> describeImage({
    required Uint8List bytes,
    required String mimeType,
    String prompt = 'Describe this image in detail.',
    CancelToken? cancelToken,
  }) async {
    final epoch = _repo.epoch(_scope);
    _check(epoch, cancelToken);
    if (bytes.isEmpty ||
        bytes.length > maxImageBytes ||
        !_mimeTypes.contains(mimeType)) {
      throw const VisionValidationError('Invalid image size or MIME type.');
    }
    final image = Uint8List.fromList(bytes);
    final token = _repo.register(_scope);
    var active = true;
    unawaited(
      cancelToken?.whenCancel.then((_) {
        if (active) token.cancel();
      }),
    );
    try {
      final selection = await _resolve(epoch, token, vision: true);
      _check(epoch, cancelToken);
      final result = await _client.streamTurn(
        _ImageRequest(selection, image, mimeType, prompt),
        cancelToken: token,
      );
      _check(epoch, cancelToken);
      _check(epoch, token);
      if (result.content.trim().isEmpty || result.toolCalls.isNotEmpty) {
        throw const PluginClientException('invalid_response');
      }
      return result.content;
    } finally {
      active = false;
      token.cancel();
      _repo.unregister(_scope, token);
    }
  }

  void cancel() => _repo.cancelScope(_scope);

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    cancel();
    _unregister();
  }
}

class _CurrentManagedClient implements LangChainClient {
  const _CurrentManagedClient(this.client, this.check);

  final LangChainClient client;
  final void Function() check;

  Future<T> _current<T>(Future<T> Function() operation) async {
    check();
    final result = await operation();
    check();
    return result;
  }

  @override
  Future<ManagedTurnResult> managedTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function(String text)? onContent,
  }) => _current(
    () => client.managedTurn(
      request,
      cancelToken: cancelToken,
      onContent: onContent == null
          ? null
          : (text) {
              check();
              onContent(text);
            },
    ),
  );

  @override
  Future<BackgroundTurnResult> backgroundTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
  }) => _current(
    () => client.backgroundTurn(request, cancelToken: cancelToken),
  );

  @override
  Future<ChatResult> streamTurn(
    LangChainRequest request, {
    CancelToken? cancelToken,
    void Function()? onReceived,
    void Function(String text)? onContent,
    void Function(ToolCallDelta delta)? onToolCallDelta,
  }) => throw UnsupportedError('Managed voice turns only.');

  @override
  Future<ManagedSessionHistory> loadSession(
    String sessionId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _current(
    () => client.loadSession(
      sessionId,
      gatewayKey: gatewayKey,
      cancelToken: cancelToken,
    ),
  );

  @override
  Future<void> deleteSession(
    String sessionId, {
    required String gatewayKey,
    CancelToken? cancelToken,
  }) => _current(
    () => client.deleteSession(
      sessionId,
      gatewayKey: gatewayKey,
      cancelToken: cancelToken,
    ),
  );
}

class _ImageRequest extends LangChainRequest {
  _ImageRequest(
    ManagedSelection selection,
    Uint8List image,
    String mimeType,
    this.prompt,
  ) : imageUrl = 'data:$mimeType;base64,${base64Encode(image)}',
      super(
        gatewayKey: selection.credentials.gatewayKey,
        modelPluginId: selection.modelId,
        credentials: selection.credentials.provider,
        messages: [ApiMessage(role: 'user', content: prompt)],
      );

  final String imageUrl;
  final String prompt;

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'enabled_plugins': <String>[],
    'messages': [
      {
        'role': 'user',
        'content': [
          {'type': 'text', 'text': prompt},
          {
            'type': 'image_url',
            'image_url': {'url': imageUrl},
          },
        ],
      },
    ],
  };
}
