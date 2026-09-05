import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'package:ai_assistant/core/auth_client.dart';
import 'package:ai_assistant/core/auth_credentials_store.dart';
import 'package:ai_assistant/core/backend_probe.dart';
import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/chat_client.dart';
import 'package:ai_assistant/core/files_service.dart';
import 'package:ai_assistant/core/prefs_store.dart';
import 'package:ai_assistant/core/settings_store.dart';
import 'package:ai_assistant/core/theme_providers.dart';
import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:ai_assistant/features/attachments/file_store.dart';
import 'package:ai_assistant/features/chat/chat_store.dart';
import 'package:ai_assistant/features/chat/message_model.dart';

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

/// Scripted [ChatClient] fake for notifier tests.
class FakeChatClient implements ChatClient {
  FakeChatClient({
    List<ChatResult>? results,
    this.error,
    this.streamDeltas = const [],
  }) : results = results ?? [];

  /// Results consumed in order; the last one repeats once exhausted.
  List<ChatResult> results = [];

  /// If set, throws [error] on every [streamCompletions] call.
  Object? error;

  /// Per-call streamed content deltas delivered via [onContent].
  List<List<String>> streamDeltas = const [];

  /// When set, [streamCompletions] awaits this before returning, letting tests
  /// pause mid-stream (for stop / dispose scenarios).
  Completer<ChatResult>? hang;

  /// The `messages` argument of each [streamCompletions] call.
  final List<List<ApiMessage>> calls = [];

  int callCount = 0;

  /// The most recent `systemPrompt` passed to [streamCompletions].
  String? lastSystemPrompt;

  /// The most recent `tools` passed to [streamCompletions].
  List<Map<String, Object?>>? lastTools;

  @override
  Future<ChatResult> streamCompletions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    void Function(String text)? onContent,
    void Function(int index, String name, String argsFragment)?
        onToolCallDelta,
    CancelToken? cancelToken,
  }) async {
    // Mirror the Dio-backed client (chat_client.dart's DioExceptionType.cancel
    // handling): a request dispatched against an already-cancelled token
    // errors immediately as ChatNetworkError('cancelled') instead of
    // streaming. Nothing is recorded — the request never went out.
    if (cancelToken?.isCancelled ?? false) {
      throw const ChatNetworkError('cancelled');
    }
    calls.add(messages);
    lastSystemPrompt = systemPrompt;
    lastTools = tools;
    final index = callCount < results.length ? callCount : results.length - 1;
    callCount++;
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

  @override
  Future<ChatResult> completions({
    required List<ApiMessage> messages,
    String? systemPrompt,
    int maxTokens = 4096,
    int? temperature,
    List<Map<String, Object?>>? tools,
    bool enableThinking = false,
    CancelToken? cancelToken,
  }) {
    throw UnimplementedError();
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
  });

  Future<AuthSession> Function(String name, String email, String password)? onSignUp;
  Future<AuthSession> Function(String email, String password)? onSignIn;
  Future<MintedApiKey> Function(String sessionToken)? onMintApiKey;
  Future<void> Function(String sessionToken)? onSignOut;
  Future<void> Function(String sessionToken, String keyId)? onRevokeApiKey;

  final List<String> signOutTokens = [];
  final List<(String, String)> revokeCalls = [];

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
}
