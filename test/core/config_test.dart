import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/config.dart';

void main() {
  group('BackendConfig.gatewayBase', () {
    test('builds <scheme>://host:17600 for a plain host', () {
      final uri = BackendConfig.gatewayBase('myhost');
      expect(uri.toString(), 'http://myhost:17600');
    });

    test('strips a stored :port (the service fixes its own port)', () {
      final uri = BackendConfig.gatewayBase('192.168.1.5:17600');
      expect(uri.toString(), 'http://192.168.1.5:17600');
    });

    test('strips a scheme prefix from a URL-like stored host', () {
      final uri = BackendConfig.gatewayBase('https://evil.example');
      expect(uri.toString(), 'http://evil.example:17600');
      final https = BackendConfig.gatewayBase(
        'https://evil.example',
        environment: BackendEnvironment.production,
      );
      expect(https.toString(), 'https://evil.example');
    });

    test('dev keeps the fixed gateway port; production uses the HTTPS origin',
        () {
      expect(
        BackendConfig.gatewayBase(
          'host',
          environment: BackendEnvironment.dev,
        ).toString(),
        'http://host:17600',
      );
      expect(
        BackendConfig.gatewayBase(
          'host',
          environment: BackendEnvironment.production,
        ).toString(),
        'https://host',
      );
    });

    test('truncates any path from a URL-like stored host', () {
      final uri = BackendConfig.gatewayBase('https://evil.example/base');
      expect(uri.toString(), 'http://evil.example:17600');
    });

    test('never throws and falls back to defaultHost on unusable input', () {
      // In a test build HOST_FQDN/PUBLIC_BACKEND_URL are unset → 'localhost'.
      expect(BackendConfig.gatewayBase('').toString(), 'http://localhost:17600');
      expect(
        BackendConfig.gatewayBase('   ').toString(),
        'http://localhost:17600',
      );
      expect(
        BackendConfig.gatewayBase(':17600').toString(),
        'http://localhost:17600',
      );
      expect(
        BackendConfig.gatewayBase('http://').toString(),
        'http://localhost:17600',
      );
    });
  });

  group('BackendConfig.mcp / files share the sanitizer', () {
    test('derive from the sanitized host', () {
      expect(
        BackendConfig.mcp('myhost:443').toString(),
        'http://myhost:17601',
      );
      expect(
        BackendConfig.files('myhost:443').toString(),
        'http://myhost:17603',
      );
      expect(
        BackendConfig.files('http://myhost/').toString(),
        'http://myhost:17603',
      );
    });

    test('production drops the fixed port (standard HTTPS origin)', () {
      expect(
        BackendConfig.mcp(
          'myhost',
          environment: BackendEnvironment.production,
        ).toString(),
        'https://myhost',
      );
      expect(
        BackendConfig.files(
          'myhost',
          environment: BackendEnvironment.production,
        ).toString(),
        'https://myhost',
      );
    });
  });

  group('BackendConfig.trimTrailingSlash', () {
    test('strips trailing slash', () {
      expect(
        BackendConfig.trimTrailingSlash('https://h/api/agents/v1/'),
        'https://h/api/agents/v1',
      );
      expect(BackendConfig.trimTrailingSlash('https://h'), 'https://h');
    });
  });
}