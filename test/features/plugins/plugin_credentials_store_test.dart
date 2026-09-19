import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/plugins/data/plugin_credentials_store.dart';

import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

class DelayedSecureStorage extends InMemorySecureStorage {
  Completer<void>? gate;
  bool failNextWrite = false;

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    await gate?.future;
    if (failNextWrite) {
      failNextWrite = false;
      throw StateError('Storage unavailable');
    }
    await super.write(key: key, value: value);
  }
}

AuthAccountScope scope(String owner, [String origin = 'https://example.com']) =>
    AuthAccountScope.fromIdentity(ownerId: owner, backendOrigin: origin)!;

void main() {
  test(
    'isolates owners, origins and plugins; survives store recreation',
    () async {
      final storage = InMemorySecureStorage();
      final store = PluginCredentialsStore(storage: storage);
      final a = scope('a');
      final b = scope('b');
      final otherOrigin = scope('a', 'http://example.com');
      await store.setCredentials(a, 'one', {'token': ' secret '});
      await store.setCredentials(a, 'two', {'password': 'second'});
      await store.setEnabled(a, 'one', true);
      await store.setSelectedModel(a, 'model-a');
      await store.setCredentials(b, 'one', {'token': 'b'});
      await store.setCredentials(otherOrigin, 'one', {'token': 'other'});
      final loaded = await PluginCredentialsStore(storage: storage).load(a);
      expect(loaded.plugins['one']!.credentials, {'token': ' secret '});
      expect(loaded.plugins['one']!.enabled, isTrue);
      expect(loaded.plugins['two']!.enabled, isFalse);
      expect(loaded.selectedModel, 'model-a');
      expect(loaded.selectedAgent, isNull);
      expect(loaded.toString(), isNot(contains('secret')));
      expect(loaded.plugins.toString(), isNot(contains('secret')));
      expect(
        () => loaded.plugins['one']!.credentials['token'] = 'x',
        throwsUnsupportedError,
      );
      await store.removePlugin(a, 'one');
      expect((await store.load(a)).plugins.keys, ['two']);
      await store.setSelectedModel(a, null);
      expect((await store.load(a)).selectedModel, isNull);
      await store.setSelectedAgent(a, 'agent-workflow');
      expect((await store.load(a)).selectedAgent, 'agent-workflow');
      await store.setSelectedAgent(a, null);
      expect((await store.load(a)).selectedAgent, isNull);
      await storage.write(key: 'auth_api_key', value: 'unrelated');
      await store.clearScope(a);
      expect((await store.load(a)).plugins, isEmpty);
      expect((await store.load(b)).plugins['one']!.credentials['token'], 'b');
      expect(
        (await store.load(otherOrigin)).plugins['one']!.credentials['token'],
        'other',
      );
      expect(storage.values.length, 3);
      expect(storage.values['auth_api_key'], 'unrelated');
    },
  );

  test(
    'concurrent read-modify-writes and clear execute in invocation order',
    () async {
      final storage = DelayedSecureStorage()..gate = Completer<void>();
      final store = PluginCredentialsStore(storage: storage);
      final a = scope('a');
      final mutable = {'token': 'original'};
      final writes = [
        store.setCredentials(a, 'one', mutable),
        store.setEnabled(a, 'one', true),
        store.setCredentials(a, 'two', {'token': 'second'}),
        store.setSelectedModel(a, 'model'),
        store.setSelectedAgent(a, 'agent-x'),
      ];
      mutable['token'] = 'mutated';
      storage.gate!.complete();
      await Future.wait(writes);
      final loaded = await store.load(a);
      expect(loaded.plugins['one']!.credentials['token'], 'original');
      expect(loaded.plugins['one']!.enabled, isTrue);
      expect(loaded.plugins.length, 2);
      expect(loaded.selectedModel, 'model');
      expect(loaded.selectedAgent, 'agent-x');
      await Future.wait([
        store.setEnabled(a, 'one', false),
        store.clearScope(a),
      ]);
      expect(storage.values, isEmpty);
    },
  );

  test('write failure propagates without poisoning the queue', () async {
    final storage = DelayedSecureStorage()..failNextWrite = true;
    final store = PluginCredentialsStore(storage: storage);
    await expectLater(
      store.setCredentials(scope('a'), 'one', {'key': 'x'}),
      throwsStateError,
    );
    await store.setEnabled(scope('a'), 'two', true);
    expect((await store.load(scope('a'))).plugins.keys, ['two']);
  });

  test(
    'malformed payload fails closed without including secrets in errors',
    () async {
      final storage = InMemorySecureStorage();
      final store = PluginCredentialsStore(storage: storage);
      await store.setEnabled(scope('a'), 'one', true);
      await storage.write(
        key: storage.values.keys.single,
        value: 'secret malformed',
      );
      await expectLater(
        store.load(scope('a')),
        throwsA(
          isA<FormatException>().having(
            (e) => e.toString(),
            'redacted',
            isNot(contains('secret')),
          ),
        ),
      );
      await expectLater(
        store.setEnabled(scope('a'), 'two', true),
        throwsFormatException,
      );
      await store.clearScope(scope('a'));
      expect(storage.values, isEmpty);
    },
  );
}
