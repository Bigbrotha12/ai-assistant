import './message_model.dart';
import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_credentials_store.dart';
import '../../plugins/data/plugin_http.dart';

/// The fully-assembled result of a chat completion turn.
class ChatResult {
  const ChatResult({
    required this.content,
    required this.toolCalls,
    required this.finishReason,
  });

  final String content;

  /// Non-empty iff [finishReason] == 'tool_calls'.
  final List<ToolCall> toolCalls;

  /// 'stop' | 'tool_calls'.
  final String finishReason;
}

/// Base class for all errors surfaced by the chat/managed inference surface.
sealed class ChatApiError implements Exception {
  const ChatApiError(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// Transport-level failure (timeout, connection refused, cancellation).
class ChatNetworkError extends ChatApiError {
  const ChatNetworkError(super.message);
}

/// The server responded with a non-2xx status.
class ChatServerError extends ChatApiError {
  const ChatServerError(super.message, {this.statusCode});

  final int? statusCode;
}

/// The app is not authenticated (no stored session/API key), so the request
/// cannot even be attempted. Surfaced by the credential resolver BEFORE any
/// network I/O; the UI interprets it like a gateway 401 and shows the re-auth
/// login flow.
class ChatAuthRequiredError extends ChatApiError {
  const ChatAuthRequiredError(super.message);
}

/// True when [error] is a gateway key rejection that the re-auth flow can
/// remedy — a [ChatServerError] with 401/403 from the gateway (403 aligns
/// with [statusPhraseForError]'s auth branch), a [ChatAuthRequiredError]
/// raised locally when no credentials exist to send, a
/// [PluginReauthenticationRequired] (the account scope is loading/errored/
/// absent — the adapter read rethrows it on the chat path), or a managed-path
/// [PluginClientException] carrying an auth code (`unauthorized` /
/// `credentials_expired` / `no_credentials`) or a 401 status (defense-in-depth:
/// a gateway 401 whose error envelope has no parseable auth code lands as
/// `server_error` with `statusCode: 401`), so the voice screen's existing
/// check matches the managed surface with zero voice changes (plan §3 auth
/// mapper).
bool isAuthRequiredError(Object error) =>
    error is ChatServerError &&
        (error.statusCode == 401 || error.statusCode == 403) ||
    error is ChatAuthRequiredError ||
    error is PluginReauthenticationRequired ||
    error is PluginClientException && error.statusCode == 401 ||
    error is PluginClientException &&
        (error.code == ManagedErrorCodes.unauthorized ||
            error.code == ManagedErrorCodes.credentialsExpired ||
            error.code == ManagedErrorCodes.noCredentials);
