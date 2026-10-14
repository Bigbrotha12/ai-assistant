import './message_model.dart';

import 'dart:async';

import '../../auth/data/auth_client.dart';
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
            error.code == ManagedErrorCodes.credentialsExpired);

/// True when the turn failed because a MODEL/TOOL provider key is missing or
/// was rejected — `no_credentials` is raised locally when the selected model
/// has no stored key, `no_selected_model`/`no_capable_model` mean the model
/// itself isn't configured, and the gateway answers a wrong/absent provider
/// key with a 400 `invalid_credentials` envelope.
///
/// These are NOT auth failures: the user is signed in; the fix is updating the
/// key in Plugins, so the UI must surface a plugin-configuration prompt, never
/// the re-auth flow.
bool isPluginCredentialsError(Object? error) {
  if (error is ParallelWaitError) {
    final nested = error.errors;
    return nested is Iterable && nested.any(isPluginCredentialsError);
  }
  return error is PluginClientException &&
      (error.code == ManagedErrorCodes.noCredentials ||
          error.code == ManagedErrorCodes.noSelectedModel ||
          error.code == ManagedErrorCodes.noCapableModel ||
          error.code == 'invalid_credentials');
}

/// True only for the managed `email_not_verified` envelope (C2): the stored
/// API key is valid but the account's email is unconfirmed, so the UI must
/// offer a verification resend — never the re-auth card.
bool isEmailNotVerifiedError(Object? error) =>
    error is PluginClientException &&
    error.code == ManagedErrorCodes.emailNotVerified;

/// True only for the managed error envelope that explicitly says the owner is
/// tombstoned. A missing status is accepted for typed test/adapter paths; a
/// present status must be the server's 403.
bool isAccountDeletedError(Object? error) {
  if (error is ParallelWaitError) {
    final nested = error.errors;
    return nested is Iterable && nested.any(isAccountDeletedError);
  }
  return error is AuthAccountDeleted ||
      error is PluginClientException &&
          error.code == ManagedErrorCodes.accountDeleted &&
          (error.statusCode == null || error.statusCode == 403);
}
