/// Canonical error-code constants for the managed (LangChain gateway) surface.
///
/// Producers throw [PluginClientException]s carrying these codes and the UI
/// error mapper (`statusPhraseForError`) keys off them. Centralizing the
/// literals here stops stringly drift between the throwing side and the copy
/// side. Codes produced by the transport layer (`plugin_http.dart`:
/// `invalid_configuration`, `invalid_response`, `server_error`, …) are kept
/// where they already live — the mapper treats any unknown code as a server
/// error. Neither set mirrors the server's emitter list: this class names the
/// codes the client produces, while `plugin_http.dart`'s `_safeCodes` is a
/// reachability-filtered allowlist.
abstract final class ManagedErrorCodes {
  static const pendingTurnExists = 'pending_turn_exists';
  static const noPendingTurn = 'no_pending_turn';
  static const missingGatewayKey = 'missing_gateway_key';
  static const invalidConfig = 'invalid_config';
  static const reconcileRequired = 'reconcile_required';
  static const sessionMissing = 'session_missing';
  static const requestTooLarge = 'request_too_large';
  static const cancelled = 'cancelled';
  static const unauthorized = 'unauthorized';
  static const credentialsExpired = 'credentials_expired';

  /// Valid gateway key, but the owning account's email is unverified
  /// (gateway 403). Distinct from [unauthorized]: the fix is verifying the
  /// email, not re-authenticating.
  static const emailNotVerified = 'email_not_verified';
  static const accountDeleted = 'account_deleted';
  static const noCredentials = 'no_credentials';
  static const noSelectedModel = 'no_selected_model';
  static const noCapableModel = 'no_capable_model';
  /// Tools/MCP were requested for the turn but none could be loaded (gateway
  /// 502). Distinct from a generic server error: the fix is plugin/MCP config,
  /// not a retry.
  static const toolsUnavailable = 'tools_unavailable';
  static const conversationInFlight = 'conversation_in_flight';
  static const configurationChanged = 'configuration_changed';
  static const networkError = 'network_error';
  static const timeout = 'timeout';

  // Goal lifecycle (server: `server/src/goals/routes.ts`). Each names a
  // specific, actionable refusal — none of them is a retryable server fault, so
  // the mapper gives them their own copy rather than a generic "try again".

  /// Resume was refused because the goal is not in a resumable state (terminal,
  /// or already queued/running). Retrying the same resume will not help.
  static const goalNotResumable = 'goal_not_resumable';

  /// Cancel was refused because the goal already reached a terminal status.
  static const goalNotCancellable = 'goal_not_cancellable';

  /// Delete was refused because the goal is still live — cancel it first.
  static const goalNotDeletable = 'goal_not_deletable';

  /// Background admission for an agent whose manifest declares
  /// `toolAllowlist` (server: `server/src/transport/chat.ts:1901`). The fix is
  /// to run that turn synchronously, not to retry it in the background.
  static const agentToolAllowlistBackgroundUnsupported =
      'agent_tool_allowlist_background_unsupported';
}