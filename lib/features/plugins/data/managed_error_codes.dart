/// Canonical error-code constants for the managed (LangChain gateway) surface.
///
/// Producers throw [PluginClientException]s carrying these codes and the UI
/// error mapper (`statusPhraseForError`) keys off them. Centralizing the
/// literals here stops stringly drift between the throwing side and the copy
/// side. Codes produced by the transport layer (`plugin_http.dart`:
/// `invalid_configuration`, `invalid_response`, `server_error`, …) are kept
/// where they already live — the mapper treats any unknown code as a server
/// error.
abstract final class ManagedErrorCodes {
  static const pendingTurnExists = 'pending_turn_exists';
  static const noPendingTurn = 'no_pending_turn';
  static const missingGatewayKey = 'missing_gateway_key';
  static const invalidConfig = 'invalid_config';
  static const reconcileRequired = 'reconcile_required';
  static const reseedRequired = 'reseed_required';
  static const sessionMissing = 'session_missing';
  static const requestTooLarge = 'request_too_large';
  static const cancelled = 'cancelled';
  static const unauthorized = 'unauthorized';
  static const credentialsExpired = 'credentials_expired';
  static const noCredentials = 'no_credentials';
  static const noSelectedModel = 'no_selected_model';
  static const noCapableModel = 'no_capable_model';
  static const conversationInFlight = 'conversation_in_flight';
  static const configurationChanged = 'configuration_changed';
  static const networkError = 'network_error';
  static const timeout = 'timeout';
}