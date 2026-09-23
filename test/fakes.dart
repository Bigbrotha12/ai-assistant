import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import 'package:ai_assistant/features/auth/data/auth_client.dart';
import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/attachments/data/files_service.dart';
import 'package:ai_assistant/features/settings/data/prefs_store.dart';
import 'package:ai_assistant/features/settings/data/settings_store.dart';
import 'package:ai_assistant/app/theme_providers.dart';
import 'package:ai_assistant/features/attachments/data/file_model.dart';
import 'package:ai_assistant/features/attachments/data/file_store.dart';
import 'package:ai_assistant/features/chat/data/chat_store.dart';
import 'package:ai_assistant/features/chat/data/context_trimmer.dart';
import 'package:ai_assistant/features/chat/data/message_model.dart';
import 'package:ai_assistant/features/plugins/data/langchain_client.dart';
import 'package:ai_assistant/features/plugins/data/ledger_client.dart';
import 'package:ai_assistant/features/plugins/data/managed_chat_providers.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_repository.dart';
import 'package:ai_assistant/features/plugins/data/managed_conversation_service.dart';
import 'package:ai_assistant/features/plugins/data/managed_resolution.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';

/// In-memory [AppTierStore] for widget tests.
class FakeAppTierStore implements AppTierStore {
  FakeAppTierStore([this.saved]);

  AppTier? saved;

  @override
  Future<AppTier?> load() async => saved;

  @override
  Future<void> save(AppTier tier) async => saved = tier;
}

/// In-memory [SettingsStore] for widget tests.
class FakeSettingsStore implements SettingsStore {
  FakeSettingsStore({this.stored});

  BackendSettings? stored;

  /// When true, the next [save] throws and leaves [stored] unchanged.
  bool failNextSave = false;

  @override
  Future<BackendSettings?> load() async => stored;

  @override
  Future<void> save(BackendSettings settings) async {
    if (failNextSave) {
      failNextSave = false;
      throw StateError('storage unavailable');
    }
    stored = settings;
  }

  @override
  Future<void> clear() async {
    stored = null;
  }
}

/// Configurable [BackendProbe] that records invocations.
class FakeProbe implements BackendProbe {
  FakeProbe({this.status});

  /// The status returned by [probe]; defaults to an empty result.
  final BackendStatus? status;

  /// Number of times [probe] has been called.
  int calls = 0;

  /// The settings passed to the most recent [probe] call.
  BackendSettings? lastSettings;

  @override
  Future<BackendStatus> probe(BackendSettings settings) async {
    calls++;
    lastSettings = settings;
    return status ?? const BackendStatus(checks: []);
  }
}
/// In-memory [ChatStore] for notifier tests.
class FakeChatStore implements ChatStore {
  FakeChatStore({List<Conversation>? initial}) {
    for (final c in initial ?? <Conversation>[]) {
      _conversations[c.id] = c;
    }
  }

  final Map<String, Conversation> _conversations = {};
  final StreamController<List<Conversation>> _controller =
      StreamController<List<Conversation>>.broadcast();

  /// Number of [watchConversations] emissions produced.
  int emitCount = 0;

  /// When true, the next [updateMessage] call throws. Lets tests simulate an
  /// unexpected failure mid-turn (distinct from a handled chat error).
  bool failUpdateMessage = false;

  /// Every [Message] successfully passed to [updateMessage], in order. Lets
  /// tests assert WHICH rows were written post-admission (e.g. that vision
  /// descriptions never land as a post-send user-row update).
  final List<Message> updatedMessages = [];

  List<Conversation> _sorted() {
    final list = _conversations.values.toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return list;
  }

  void _emit() {
    emitCount++;
    if (_controller.hasListener) {
      _controller.add(_sorted());
    }
  }

  @override
  Stream<List<Conversation>> watchConversations() async* {
    yield _sorted();
    yield* _controller.stream;
  }

  @override
  Future<Conversation?> loadConversation(String id) async => _conversations[id];

  @override
  Future<void> saveConversation(Conversation c) async {
    _conversations[c.id] = c;
    _emit();
  }

  @override
  Future<void> ensureConversation(
    String id, {
    required String title,
    required Message firstMessage,
  }) async {
    final now = DateTime.now();
    final existing = _conversations[id];
    if (existing == null) {
      _conversations[id] = Conversation(
        id: id,
        title: title,
        messages: [firstMessage],
        createdAt: now,
        updatedAt: now,
      );
    } else {
      _conversations[id] = Conversation(
        id: existing.id,
        title: existing.title,
        messages: [...existing.messages, firstMessage],
        createdAt: existing.createdAt,
        updatedAt: now,
      );
    }
    _emit();
  }

  @override
  Future<void> appendMessage(String conversationId, Message m) async {
    final conv = _conversations[conversationId];
    if (conv == null) {
      // Mirrors production: DriftChatStore's FK constraint (database.dart's
      // `PRAGMA foreign_keys = ON`) rejects message writes against a missing
      // conversation row. A silent no-op here would mask exactly the bugs the
      // FK exists to catch.
      throw StateError('conversation $conversationId not found');
    }
    _conversations[conversationId] = Conversation(
      id: conv.id,
      title: conv.title,
      messages: [...conv.messages, m],
      createdAt: conv.createdAt,
      updatedAt: DateTime.now(),
    );
    _emit();
  }

  @override
  Future<void> updateMessage(String conversationId, Message m) async {
    if (failUpdateMessage) {
      throw StateError('store unavailable');
    }
    final conv = _conversations[conversationId];
    if (conv == null) {
      // Mirrors production: DriftChatStore's FK constraint rejects message
      // writes against a missing conversation row.
      throw StateError('conversation $conversationId not found');
    }
    updatedMessages.add(m);
    var found = false;
    final messages = <Message>[];
    for (final existing in conv.messages) {
      if (existing.id == m.id) {
        found = true;
        messages.add(m);
      } else {
        messages.add(existing);
      }
    }
    if (!found) messages.add(m);
    _conversations[conversationId] = Conversation(
      id: conv.id,
      title: conv.title,
      messages: messages,
      createdAt: conv.createdAt,
      updatedAt: DateTime.now(),
    );
    _emit();
  }

  @override
  Future<void> deleteMessage(String conversationId, String messageId) async {
    final conv = _conversations[conversationId];
    if (conv == null) return;
    _conversations[conversationId] = Conversation(
      id: conv.id,
      title: conv.title,
      messages: [
        for (final m in conv.messages)
          if (m.id != messageId) m,
      ],
      createdAt: conv.createdAt,
      updatedAt: DateTime.now(),
    );
    _emit();
  }

  @override
  Future<void> deleteConversation(String id) async {
    _conversations.remove(id);
    _emit();
  }

  @override
  Future<void> deleteAll() async {
    _conversations.clear();
    _emit();
  }
}

/// Scripted fake for notifier tests.
///
/// Since the ChatClient cutover (P4a) this is a plain scripted client, not an
/// `implements ChatClient`. Turns are scripted through the managed sender seam
/// [sendTurn] (plan P4b): the [FakeManagedChatAdapter] dispatch leg and the
/// voice tests (which build their own [VoiceTurnSender] adapter inline) script
/// this seam instead of the legacy wire shape.
class FakeChatClient {
  FakeChatClient({
    List<ChatResult>? results,
    this.error,
    this.streamDeltas = const [],
    this.toolCallDeltas = const [],
    this.fireOnReceived = false,
  }) : results = results ?? [];

  /// Results consumed in order; the last one repeats once exhausted.
  List<ChatResult> results = [];

  /// If set, throws [error] on every [sendTurn] call.
  Object? error;

  /// Per-call streamed content deltas delivered via [onContent].
  List<List<String>> streamDeltas = const [];

  /// Per-call tool-call deltas delivered via [onToolCallDelta].
  /// Each entry is one call's worth of `(index, name, argsFragment)` tuples.
  List<List<(int index, String name, String argsFragment)>> toolCallDeltas =
      const [];

  /// When set, [sendTurn] awaits this before returning, letting tests pause
  /// mid-stream (for stop / dispose scenarios).
  Completer<ChatResult>? hang;

  /// When true, [sendTurn] calls [onReceived] immediately so new tests can
  /// exercise the ack path. Defaults to false to avoid breaking existing
  /// scripted tests that don't expect the ack interjection.
  bool fireOnReceived;

  /// The `messages` argument of each [sendTurn] call (the derived wire list,
  /// or the verbatim [messages] the voice adapters pass through).
  final List<List<ApiMessage>> calls = [];

  int callCount = 0;

  /// The most recent `systemPrompt` passed to [sendTurn].
  String? lastSystemPrompt;

  /// The most recent `tools` passed to [sendTurn].
  List<Map<String, Object?>>? lastTools;

  /// The scripted managed-sender seam (replaces the legacy wire shape, plan
  /// P4b): mirrors [ManagedConversationService.sendTurn]'s dispatch leg so
  /// [FakeManagedChatAdapter] — and, post-P4b, the chat/voice tests — script
  /// turns through this seam. Replays the scripted knobs
  /// ([streamDeltas] → [onContent], [toolCallDeltas] → [onToolCallDelta],
  /// [results], [error], [hang], [fireOnReceived] → [onReceived]) and records
  /// [calls] / [callCount].
  ///
  /// [messages] overrides the wire list derived from [history]: the voice
  /// tests' inline [VoiceTurnSender] adapters pass the controller-built
  /// `List<ApiMessage>` verbatim so [calls] records exactly what the controller
  /// dispatched, while the managed path passes only [history] / [userText].
  Future<ChatResult> sendTurn(
    String conversationId, {
    required List<Message> history,
    required String userText,
    String? sessionId,
    void Function(String delta)? onContent,
    List<ApiMessage>? messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    CancelToken? cancelToken,
    void Function(int index, String name, String argsFragment)?
        onToolCallDelta,
    void Function()? onReceived,
  }) async {
    final wire = messages ?? toApiMessages(history);
    // Mirror the legacy client's DioExceptionType.cancel
    // handling): a request dispatched against an already-cancelled token
    // errors immediately as ChatNetworkError('cancelled') instead of
    // streaming. Nothing is recorded — the request never went out.
    if (cancelToken?.isCancelled ?? false) {
      throw const ChatNetworkError('cancelled');
    }
    calls.add(wire);
    lastSystemPrompt = systemPrompt;
    lastTools = tools;
    if (fireOnReceived) onReceived?.call();
    // The last scripted result repeats once exhausted: the index is clamped
    // to `results.length - 1` so a scripted client never runs dry mid-turn.
    final index = callCount < results.length ? callCount : results.length - 1;
    callCount++;
    if (index >= 0 && index < toolCallDeltas.length) {
      for (final delta in toolCallDeltas[index]) {
        onToolCallDelta?.call(delta.$1, delta.$2, delta.$3);
      }
    }
    if (index >= 0 && index < streamDeltas.length) {
      for (final delta in streamDeltas[index]) {
        onContent?.call(delta);
      }
    }
    final pendingHang = hang;
    if (pendingHang != null) {
      return pendingHang.future;
    }
    if (error != null) throw error!;
    if (results.isEmpty) {
      return const ChatResult(content: '', toolCalls: [], finishReason: 'stop');
    }
    return results[index];
  }
}

/// Scripted [FilesClient] fake that records upload/fetch calls. Assign
/// [uploadCompleter] to hold an upload in-flight, [uploadError] to fail it,
/// or leave both null for an immediate success.
class FakeFilesClient implements FilesClient {
  FakeFilesClient({
    this.uploadCompleter,
    this.uploadError,
    this.fetchError,
    this.fetchBytes = const [1, 2, 3],
    this.listError,
    this.deleteError,
    List<FileInfo>? files,
  }) : files = files ?? [];

  /// When set, [uploadFile] awaits this before returning (pausing the upload).
  Completer<FileInfo>? uploadCompleter;

  /// When set, every [uploadFile] throws [uploadError].
  Object? uploadError;

  /// When set, [fetchFile] throws [fetchError].
  Object? fetchError;

  /// Bytes returned by [fetchFile] unless [fetchError] is set.
  final List<int> fetchBytes;

  /// When set, every [listFiles] call throws.
  Object? listError;

  /// When set, every [deleteFile] call throws.
  Object? deleteError;

  /// Files returned by [listFiles]. Mutations (e.g. [deleteFile]) apply here so
  /// a later list reflects them; assign directly to script results.
  List<FileInfo> files;

  /// The file ids passed to [deleteFile], in order.
  final List<String> deletedIds = [];

  /// Number of [listFiles] calls.
  int listCalls = 0;

  /// The arguments of each [uploadFile] call, in order.
  final List<({String path, String filename, int sizeBytes, String mimeType})>
      uploadCalls = [];

  /// The file ids passed to [fetchFile], in order.
  final List<String> fetchedIds = [];

  @override
  Future<FileInfo> uploadFile({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onProgress,
  }) async {
    uploadCalls.add((
      path: path,
      filename: filename,
      sizeBytes: sizeBytes,
      mimeType: mimeType,
    ));
    final completer = uploadCompleter;
    if (completer != null) {
      return completer.future;
    }
    final error = uploadError;
    if (error != null) throw error;
    return FileInfo(
      id: 'server-${uploadCalls.length}',
      filename: filename,
      sizeBytes: sizeBytes,
      mimeType: mimeType,
      uploadedAt: DateTime.now(),
    );
  }

  @override
  Future<Uint8List> fetchFile(String fileId) async {
    fetchedIds.add(fileId);
    final error = fetchError;
    if (error != null) throw error;
    return Uint8List.fromList(fetchBytes);
  }

  @override
  Future<List<FileInfo>> listFiles() async {
    listCalls++;
    final error = listError;
    if (error != null) throw error;
    return List.of(files);
  }

  @override
  Future<void> deleteFile(String fileId) async {
    final error = deleteError;
    if (error != null) throw error;
    deletedIds.add(fileId);
    files.removeWhere((f) => f.id == fileId);
  }
}

/// In-memory [FileStore] for notifier tests.
class FakeFileStore implements FileStore {
  /// Every [FileInfo] passed to [saveFile], in order.
  final List<FileInfo> saved = [];

  /// The ids passed to [deleteFile], in order.
  final List<String> deletedIds = [];

  final Map<String, FileInfo> _files = {};
  final Map<String, String> _links = {};
  final Map<String, String> _descriptions = {};

  @override
  Future<void> saveFile(FileInfo info, {String? conversationId}) async {
    saved.add(info);
    _files[info.id] = info;
    if (conversationId != null) _links[info.id] = conversationId;
  }

  @override
  Future<FileInfo?> getFileById(String id) async => _files[id];

  @override
  Future<List<FileInfo>> listFilesForConversation(String conversationId) async =>
      [
        for (final entry in _links.entries)
          if (entry.value == conversationId) _files[entry.key]!,
      ];

  @override
  Future<List<FileInfo>> listAllFiles() async => _files.values.toList();

  @override
  Future<void> deleteFile(String id) async {
    deletedIds.add(id);
    _files.remove(id);
    _links.remove(id);
  }

  @override
  Future<void> deleteAll() async {
    _files.clear();
    _links.clear();
    _descriptions.clear();
  }

  @override
  Future<String?> descriptionFor(String fileId) async => _descriptions[fileId];

  @override
  Future<void> setDescription(String fileId, String description) async {
    _descriptions[fileId] = description;
  }
}

/// Minimal fake [Dio] that records requests and returns a scripted response.
class FakeDio {
  FakeDio({this.response});

  Response? response;
  String? lastPath;
  dynamic lastBody;
  final List<RequestOptions> requests = [];

  Future<Response<T>> get<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
  }) async {
    requests.add(RequestOptions(path: path, data: data));
    lastPath = path;
    return response as Response<T>;
  }

  Future<Response<T>> post<T>(
    String? path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onSendProgress,
  }) async {
    requests.add(RequestOptions(path: path ?? '', data: data));
    lastPath = path;
    lastBody = data;
    return response as Response<T>;
  }
}

/// In-memory [AuthCredentialsStore] for widget tests.
class FakeAuthCredentialsStore implements AuthCredentialsStore {
  FakeAuthCredentialsStore({this.stored});

  AuthCredentials? stored;

  /// When true, the next [save] throws and leaves [stored] unchanged.
  bool failNextSave = false;

  /// Number of [save] calls.
  int saveCalls = 0;

  @override
  Future<AuthCredentials?> load() async => stored;

  @override
  Future<void> save(AuthCredentials credentials) async {
    saveCalls++;
    if (failNextSave) {
      failNextSave = false;
      throw StateError('storage unavailable');
    }
    stored = credentials;
  }

  @override
  Future<void> clear() async {
    stored = null;
  }
}

/// In-memory [AppPrefsStore] for widget tests.
class FakePrefsStore implements AppPrefsStore {
  FakePrefsStore({AppPrefs? initial})
      : prefs = initial ?? const AppPrefs();

  AppPrefs prefs;

  /// When true, the next [save] throws and leaves [prefs] unchanged.
  bool failNextSave = false;

  @override
  Future<AppPrefs> load() async => prefs;

  @override
  Future<void> save(AppPrefs value) async {
    if (failNextSave) {
      failNextSave = false;
      throw StateError('storage unavailable');
    }
    prefs = value;
  }
}

/// In-memory [AuthClient] for widget/notifier tests.
class FakeAuthClient implements AuthClient {
  FakeAuthClient({
    this.onSignUp,
    this.onSignIn,
    this.onMintApiKey,
    this.onSignOut,
    this.onRevokeApiKey,
    this.onRequestPasswordReset,
  });

  Future<AuthSession> Function(String name, String email, String password)? onSignUp;
  Future<AuthSession> Function(String email, String password)? onSignIn;
  Future<MintedApiKey> Function(String sessionToken)? onMintApiKey;
  Future<void> Function(String sessionToken)? onSignOut;
  Future<void> Function(String sessionToken, String keyId)? onRevokeApiKey;
  Future<void> Function(String email)? onRequestPasswordReset;

  final List<String> signOutTokens = [];
  final List<(String, String)> revokeCalls = [];
  final List<String> passwordResetRequests = [];

  @override
  Future<AuthSession> signUp({
    required String name,
    required String email,
    required String password,
  }) =>
      onSignUp != null
          ? onSignUp!(name, email, password)
          : Future.error(UnimplementedError('signUp not stubbed'));

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) =>
      onSignIn != null
          ? onSignIn!(email, password)
          : Future.error(UnimplementedError('signIn not stubbed'));

  @override
  Future<MintedApiKey> mintApiKey({required String sessionToken}) =>
      onMintApiKey != null
          ? onMintApiKey!(sessionToken)
          : Future.error(UnimplementedError('mintApiKey not stubbed'));

  @override
  Future<void> signOut({required String sessionToken}) async {
    signOutTokens.add(sessionToken);
    await onSignOut?.call(sessionToken);
  }

  @override
  Future<void> revokeApiKey({
    required String sessionToken,
    required String keyId,
  }) async {
    revokeCalls.add((sessionToken, keyId));
    await onRevokeApiKey?.call(sessionToken, keyId);
  }

  @override
  Future<void> requestPasswordReset({required String email}) async {
    passwordResetRequests.add(email);
    await onRequestPasswordReset?.call(email);
  }
}

/// Scripted [ManagedChatAdapter] for notifier/widget tests: the dispatch leg
/// reuses the scripted [FakeChatClient] (deltas / errors / hangs), while
/// persistence mirrors the managed service's ownership — the user message is
/// admitted BEFORE dispatch and the assistant reply is written only on
/// success. A pending-turn model tracks one unresolved turn per conversation
/// so `retryTurn` replays it and `abandonTurn` clears it, mirroring the real
/// service's single-flight contract.
class FakeManagedChatAdapter implements ManagedChatAdapter {
  FakeManagedChatAdapter({
    required this.store,
    required this.script,
    this._poller,
  });

  /// Store admission/completion writes go to — usually the same instance as
  /// the container's `chatStoreProvider` override.
  final ChatStore store;

  /// Scripted client driving stream deltas / errors / hangs through the
  /// managed sender seam ([FakeChatClient.sendTurn]).
  final FakeChatClient script;

  /// Controllable [LedgerPoller] for background-job tests. When null,
  /// background submits are unavailable (existing streaming tests never touch
  /// them).
  final LedgerPoller? _poller;

  /// Thrown at the start of [sendTurn] BEFORE any local write — models a
  /// resolution/credential failure or a pre-admission transport error.
  Object? admissionError;

  /// When true, [sendTurn] returns [ManagedAlreadyCompleted] without
  /// persisting anything (a duplicate hitting an already-finished turn).
  bool alreadyCompleted = false;

  /// When set, [reconcileFromServer] replaces the store's messages with this
  /// history and returns it; otherwise the current store messages are
  /// returned unchanged.
  List<Message>? serverHistory;

  /// Number of [reconcileFromServer] calls. Tests assert the notifier does NOT
  /// re-reconcile after the service already reconciled inside `sendTurn`
  /// (M5: ManagedAlreadyCompleted reloads the store instead of a second fetch).
  int reconcileCalls = 0;

  /// Recorded [sendTurn] arguments: the conversation, the prior history
  /// (trailing optimistic user message excluded), and the user text exactly
  /// as admitted (describe-expanded when vision ran).
  final List<({String conversationId, List<Message> history, String userText})>
      sends = [];

  /// Recorded [retryTurn] conversation ids, in order.
  final List<String> retries = [];

  /// Recorded [retryTurn] turn ids (the replayed pending messageId), in order.
  final List<String> retryMessageIds = [];

  /// Recorded [abandonTurn] calls: conversation id + partial text handed in.
  final List<({String conversationId, String? partialText})> abandons = [];

  /// Recorded [submitBackground] calls, in order.
  final List<({String conversationId, List<Message> history, String userText})>
      backgroundSubmits = [];

  /// Store-row id of the user message the most recent [sendTurn] admitted —
  /// the fake's stand-in for the real service's minted id (P1b). Null when no
  /// admission ran yet (pre-admission failure / alreadyCompleted skip).
  String? lastAdmittedUserMessageId;

  /// Per-conversation turn generation: bumped at admission AND by
  /// [abandonTurn]. After a scripted dispatch, a generation mismatch throws
  /// `cancelled` (mirrors the real service's post-managedTurn guard) so a
  /// late completion after stop() never writes a stale assistant row.
  final Map<String, int> _turnGen = {};

  /// One unresolved turn per conversation (mirrors the real pending row).
  final Map<String, _PendingTurn> _pending = {};

  static const _uuid = Uuid();

  @override
  AuthAccountScope get scope => throw UnimplementedError();

  @override
  LangChainClient get client => throw UnimplementedError();

  @override
  ManagedConversationRepository get repo => throw UnimplementedError();

  @override
  ContextTrimmer get trimmer => throw UnimplementedError();

  @override
  Future<ManagedSelection> Function() get resolveSelection =>
      throw UnimplementedError();

  @override
  Future<ManagedConversationService> buildService() =>
      throw UnimplementedError();

  @override
  LedgerPoller get poller => _poller ??
      (throw StateError('inject a LedgerPoller for background tests'));

  @override
  void setForeground(bool foreground) => _poller?.setForeground(foreground);

  @override
  Future<LedgerPollHandle?> rewatchPendingBackground(
    String conversationId,
  ) async {
    final pending = _pending[conversationId];
    if (pending == null || !pending.background || _poller == null) return null;
    return _watchBackgroundTurn(conversationId, pending.messageId);
  }

  @override
  Future<List<String>> rewatchPendingBackgroundOnForeground() async {
    final injected = _poller;
    if (injected == null) return const [];
    final rewound = <String>[];
    for (final entry in _pending.entries) {
      if (!entry.value.background) continue;
      _watchBackgroundTurn(entry.key, entry.value.messageId);
      rewound.add(entry.key);
    }
    return rewound;
  }

  @override
  Future<LedgerPollHandle> submitBackground(
    String conversationId, {
    required List<Message> history,
    required String userText,
  }) {
    final injected = _poller;
    if (injected == null) {
      throw StateError('inject a LedgerPoller for background tests');
    }
    return _submitBackground(conversationId, history, userText, injected);
  }

  Future<LedgerPollHandle> _submitBackground(
    String conversationId,
    List<Message> history,
    String userText,
    LedgerPoller injected,
  ) async {
    backgroundSubmits.add((
      conversationId: conversationId,
      history: history,
      userText: userText,
    ));
    if (_pending.containsKey(conversationId)) {
      throw const PluginClientException('pending_turn_exists');
    }
    final now = DateTime.now();
    final existing = await store.loadConversation(conversationId);
    final userMessage = Message(
      id: _uuid.v4(),
      role: MessageRole.user,
      content: userText,
      createdAt: now,
    );
    if (existing == null) {
      await store.saveConversation(Conversation(
        id: conversationId,
        title: userText,
        messages: [...history, userMessage],
        createdAt: now,
        updatedAt: now,
      ));
    } else {
      await store.appendMessage(conversationId, userMessage);
    }
    final messageId = _uuid.v4();
    _pending[conversationId] = _PendingTurn(
      messageId: messageId,
      admittedId: userMessage.id,
      history: [...history, userMessage],
      userText: userText,
      background: true,
    );
    return _watchBackgroundTurn(conversationId, messageId);
  }

  /// Starts a [poller] watch keyed by [messageId] and mirrors the service's
  /// terminal reconciliation: on observed `succeeded` the reply is appended to
  /// the store (so the notifier's `handle.done` reload sees it), and any
  /// observed terminal status drops the pending turn.
  LedgerPollHandle _watchBackgroundTurn(
    String conversationId,
    String messageId,
  ) {
    final handle = _poller!.watch(LedgerLookup.byMessageId(messageId));
    handle.done.then((result) async {
      if (result.end != LedgerPollEnd.observed || result.task == null) return;
      if (result.task!.status == LedgerTaskStatus.succeeded) {
        final reply = result.task!.reply ?? 'background reply';
        await store.appendMessage(
          conversationId,
          Message(
            id: _uuid.v4(),
            role: MessageRole.assistant,
            content: reply,
            createdAt: DateTime.now(),
          ),
        );
      }
      if (result.task!.status.isTerminal) {
        _pending.remove(conversationId);
      }
    }).catchError((Object _) {});
    return handle;
  }

  /// Replay of the staged pending turn (pending-row identity, same admitted
  /// user row) — the fake's stand-in for the real `retryTurn`.
  @override
  Future<ManagedTurnOutcome> retryTurn(
    String conversationId, {
    void Function(String delta)? onContent,
  }) async {
    // Record the attempt first: a replay against a cleared row is still a
    // retryTurn call (tests assert the routing even when it throws).
    retries.add(conversationId);
    final pending = _pending[conversationId];
    if (pending == null) {
      throw const PluginClientException('no_pending_turn');
    }
    retryMessageIds.add(pending.messageId);

    if (pending.background) {
      if (_poller == null) {
        throw StateError('inject a LedgerPoller for background tests');
      }
      return ManagedBackgroundResubmitted(
        _watchBackgroundTurn(conversationId, pending.messageId),
        pending.admittedId,
      );
    }

    final gen = _turnGen[conversationId] ?? 0;
    final ChatResult result;
    try {
      result = await script.sendTurn(
        conversationId,
        history: pending.history,
        userText: pending.userText,
        onContent: onContent,
      );
    } on PluginClientException catch (e) {
      final prior = e is ManagedTurnError ? e : null;
      throw ManagedTurnError(
        e.code,
        statusCode: e.statusCode,
        sessionId: prior?.sessionId ?? 'session-fake',
        userMessageId: prior?.userMessageId ?? pending.admittedId,
      );
    }
    if ((_turnGen[conversationId] ?? 0) != gen) {
      throw const PluginClientException('cancelled');
    }
    _pending.remove(conversationId);

    final assistant = Message(
      id: _uuid.v4(),
      role: MessageRole.assistant,
      content: result.content,
      toolCalls: result.toolCalls.isEmpty ? null : result.toolCalls,
      createdAt: DateTime.now(),
    );
    await store.updateMessage(conversationId, assistant);
    return ManagedStreamedTurn(
      'session-fake',
      'seeded',
      pending.admittedId,
      result,
    );
  }

  /// Clears the pending turn (bumping the generation so a late scripted
  /// completion cannot persist) and, when [partialText] is non-empty, appends
  /// it as the assistant message — the fake's partial-retention policy.
  @override
  Future<void> abandonTurn(
    String conversationId, {
    String? sessionId,
    int? generation,
    String? partialText,
  }) async {
    abandons.add((
      conversationId: conversationId,
      partialText: partialText,
    ));
    final hadPending = _pending.remove(conversationId) != null;
    _turnGen[conversationId] = (_turnGen[conversationId] ?? 0) + 1;
    if (!hadPending) return;
    if (partialText == null || partialText.isEmpty) return;
    final existing = await store.loadConversation(conversationId);
    if (existing == null) return;
    await store.appendMessage(
      conversationId,
      Message(
        id: _uuid.v4(),
        role: MessageRole.assistant,
        content: partialText,
        createdAt: DateTime.now(),
      ),
    );
  }

  @override
  Future<bool> hasPendingBackground(String conversationId) async {
    return _pending[conversationId]?.background ?? false;
  }

  @override
  Future<bool> abandonTurnKeepingBackground(
    String conversationId, {
    String? sessionId,
    int? generation,
    String? partialText,
  }) async {
    final pending = _pending[conversationId];
    if (pending != null && pending.background) return false;
    await abandonTurn(
      conversationId,
      sessionId: sessionId,
      generation: generation,
      partialText: partialText,
    );
    return true;
  }

  @override
  Future<List<Message>> reconcileFromServer(String conversationId) async {
    reconcileCalls++;
    final scripted = serverHistory;
    if (scripted != null) {
      final now = DateTime.now();
      final existing = await store.loadConversation(conversationId);
      await store.saveConversation(Conversation(
        id: conversationId,
        title: existing?.title ?? 'Conversation',
        messages: scripted,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      ));
      return scripted;
    }
    final conversation = await store.loadConversation(conversationId);
    return conversation?.messages ?? const <Message>[];
  }

  @override
  Future<ManagedTurnOutcome> sendTurn(
    String conversationId, {
    required List<Message> history,
    required String userText,
    String? sessionId,
    void Function(String delta)? onContent,
  }) async {
    sends.add((
      conversationId: conversationId,
      history: history,
      userText: userText,
    ));
    final admission = admissionError;
    if (admission != null) throw admission;
    if (alreadyCompleted) {
      // Mirror the real service's _reconcileAlreadyCompleted: by the time the
      // outcome returns, the server history has ALREADY been committed to the
      // store (the notifier reloads it instead of re-reconciling).
      final scripted = serverHistory;
      if (scripted != null) {
        final now = DateTime.now();
        final existing = await store.loadConversation(conversationId);
        await store.saveConversation(Conversation(
          id: conversationId,
          title: existing?.title ?? 'Conversation',
          messages: scripted,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        ));
      }
      return ManagedAlreadyCompleted('session-fake', 'resumed', _uuid.v4());
    }
    if (_pending.containsKey(conversationId)) {
      throw const PluginClientException('pending_turn_exists');
    }

    // Admission (mirrors the service's pre-dispatch transaction): persist the
    // user message before dispatch so a mid-stream failure leaves it behind.
    //
    // Skip re-admission when the store's last row is already this exact user
    // text AND history does not also contain it. retry() re-runs _streamOnce
    // → sendTurn after a failure: the trailing user row was admitted on the
    // first attempt, history excludes it, and appending again would duplicate
    // it. A double-press after failure re-sends with the failed text still in
    // history (the in-memory user row was never dropped), so that path still
    // admits a fresh row — matching the attachments-retry test's two-row
    // expectation.
    final now = DateTime.now();
    final existing = await store.loadConversation(conversationId);
    final lastIsSameUser =
        existing != null &&
        existing.messages.isNotEmpty &&
        existing.messages.last.role == MessageRole.user &&
        existing.messages.last.content == userText;
    final historyHasUserText = history.any(
      (m) => m.role == MessageRole.user && m.content == userText,
    );
    final userMessage = Message(
      id: _uuid.v4(),
      role: MessageRole.user,
      content: userText,
      createdAt: now,
    );
    final String admittedId;
    if (existing == null) {
      // New conversation: title mirrors the service's `_title` (the user
      // text itself) and the row starts from the full local history.
      await store.saveConversation(Conversation(
        id: conversationId,
        title: userText,
        messages: [...history, userMessage],
        createdAt: now,
        updatedAt: now,
      ));
      admittedId = userMessage.id;
    } else if (!(lastIsSameUser && !historyHasUserText)) {
      await store.appendMessage(conversationId, userMessage);
      admittedId = userMessage.id;
    } else {
      // Re-admission skipped: the existing trailing user row IS this turn's
      // admitted row (retry re-running sendTurn).
      admittedId = existing.messages.last.id;
    }
    lastAdmittedUserMessageId = admittedId;

    final historyWithUser = [...history, userMessage];
    final messageId = _uuid.v4();
    _pending[conversationId] = _PendingTurn(
      messageId: messageId,
      admittedId: admittedId,
      history: historyWithUser,
      userText: userText,
    );
    _turnGen[conversationId] = (_turnGen[conversationId] ?? 0) + 1;
    final gen = _turnGen[conversationId]!;

    // Dispatch through the scripted client's managed sender seam (stream
    // deltas / error / hang). A scripted error surfaces with the user row
    // already written.
    final ChatResult result;
    try {
      result = await script.sendTurn(
        conversationId,
        history: historyWithUser,
        userText: userText,
        onContent: onContent,
      );
    } on PluginClientException catch (e) {
      // Mirror the real service: post-admission dispatch failures surface as
      // ManagedTurnError carrying the admitted user id (P1b re-key). Legacy
      // Chat*/Dio errors propagate unchanged so scripted banner/message
      // semantics (auth card, network banner) stay intact.
      final prior = e is ManagedTurnError ? e : null;
      throw ManagedTurnError(
        e.code,
        statusCode: e.statusCode,
        sessionId: prior?.sessionId ?? 'session-fake',
        userMessageId: prior?.userMessageId ?? admittedId,
      );
    }
    if ((_turnGen[conversationId] ?? 0) != gen) {
      // Abandoned mid-dispatch: the late completion must not persist.
      throw const PluginClientException('cancelled');
    }
    _pending.remove(conversationId);

    // Success (mirrors _completeTurn): persist the assistant reply.
    final assistant = Message(
      id: _uuid.v4(),
      role: MessageRole.assistant,
      content: result.content,
      toolCalls: result.toolCalls.isEmpty ? null : result.toolCalls,
      createdAt: DateTime.now(),
    );
    await store.updateMessage(conversationId, assistant);
    return ManagedStreamedTurn('session-fake', 'seeded', admittedId, result);
  }
}

/// One unresolved staged turn the fake tracks per conversation.
class _PendingTurn {
  const _PendingTurn({
    required this.messageId,
    required this.admittedId,
    required this.history,
    required this.userText,
    this.background = false,
  });

  final String messageId;
  final String admittedId;
  final List<Message> history;
  final String userText;
  final bool background;
}
