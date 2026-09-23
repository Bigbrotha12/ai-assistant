import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_http.dart';

void main() {
  group('isAuthRequiredError (managed auth codes)', () {
    test('matches PluginClientException unauthorized / credentials_expired / '
        'no_credentials', () {
      expect(isAuthRequiredError(const PluginClientException('unauthorized')),
          isTrue);
      expect(
          isAuthRequiredError(
              const PluginClientException('credentials_expired')),
          isTrue);
      expect(isAuthRequiredError(const PluginClientException('no_credentials')),
          isTrue);
    });

    test('does NOT match non-auth PluginClientException codes', () {
      expect(isAuthRequiredError(const PluginClientException('network_error')),
          isFalse);
      expect(isAuthRequiredError(const PluginClientException('cancelled')),
          isFalse);
      expect(
          isAuthRequiredError(const PluginClientException('invalid_config')),
          isFalse);
    });

    test('still matches the legacy ChatServerError(401) and '
        'ChatAuthRequiredError', () {
      expect(
          isAuthRequiredError(
              const ChatServerError('HTTP 401', statusCode: 401)),
          isTrue);
      expect(isAuthRequiredError(const ChatServerError('HTTP 500', statusCode: 500)),
          isFalse);
      expect(isAuthRequiredError(const ChatAuthRequiredError('nope')), isTrue);
    });

    test('matches ChatServerError(403) (consistent with the mapper auth '
        'phrase)', () {
      expect(
          isAuthRequiredError(
              const ChatServerError('forbidden', statusCode: 403)),
          isTrue);
    });

    test('matches PluginClientException with statusCode 401 even when the '
        'envelope code is not an auth code (unparseable 401 body)', () {
      expect(
          isAuthRequiredError(
              const PluginClientException('server_error', statusCode: 401)),
          isTrue);
      expect(
          isAuthRequiredError(
              const PluginClientException('server_error', statusCode: 500)),
          isFalse,
          reason: 'a 500 with a non-auth code is not a key rejection');
      expect(
          isAuthRequiredError(const PluginClientException('server_error')),
          isFalse,
          reason: 'no status, no auth code — not a key rejection');
    });

    test('matches PluginReauthenticationRequired (unavailable account scope)',
        () {
      // The chat adapter read rethrows this when auth/settings are loading or
      // errored; it must map to the re-auth card, not an 'Unexpected error'.
      expect(isAuthRequiredError(const PluginReauthenticationRequired()),
          isTrue);
    });
  });
}