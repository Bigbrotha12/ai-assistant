import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/auth/data/auth_credentials_store.dart';
import 'package:ai_assistant/features/notifications/data/notify_credentials_store.dart';

import '../auth/auth_credentials_store_test.dart' show InMemorySecureStorage;

AuthAccountScope _scope(String owner, [String origin = 'https://gw.test']) =>
    AuthAccountScope.fromIdentity(ownerId: owner, backendOrigin: origin)!;

void main() {
  test('round-trips credentials and the key is account-scoped', () async {
    final storage = InMemorySecureStorage();
    final store = NotifyCredentialsStore(storage: storage);
    final a = _scope('owner-a');

    await store.save(
      a,
      const NotifyCredentials(topic: 'topic-a', accessToken: 'token-a'),
    );

    final loaded = await store.load(a);
    expect(
      loaded,
      const NotifyCredentials(topic: 'topic-a', accessToken: 'token-a'),
    );
    expect(storage.values.keys.single, 'notify_credentials_v1_${a.storageId}');
  });

  test('isolates owners and origins', () async {
    final storage = InMemorySecureStorage();
    final store = NotifyCredentialsStore(storage: storage);
    final a = _scope('owner-a');
    final b = _scope('owner-b');
    final otherOrigin = _scope('owner-a', 'http://other.test');

    await store.save(
      a,
      const NotifyCredentials(topic: 't-a', accessToken: 'k-a'),
    );
    await store.save(
      b,
      const NotifyCredentials(topic: 't-b', accessToken: 'k-b'),
    );
    await store.save(
      otherOrigin,
      const NotifyCredentials(topic: 't-o', accessToken: 'k-o'),
    );

    expect((await store.load(a))!.topic, 't-a');
    expect((await store.load(b))!.topic, 't-b');
    expect((await store.load(otherOrigin))!.topic, 't-o');
  });

  test('remove clears only the target account', () async {
    final storage = InMemorySecureStorage();
    final store = NotifyCredentialsStore(storage: storage);
    final a = _scope('owner-a');
    final b = _scope('owner-b');
    await store.save(
      a,
      const NotifyCredentials(topic: 't-a', accessToken: 'k-a'),
    );
    await store.save(
      b,
      const NotifyCredentials(topic: 't-b', accessToken: 'k-b'),
    );

    await store.remove(a);

    expect(await store.load(a), isNull);
    expect((await store.load(b))!.topic, 't-b');
  });

  test('a corrupt record reads as not provisioned', () async {
    final storage = InMemorySecureStorage();
    final store = NotifyCredentialsStore(storage: storage);
    final a = _scope('owner-a');
    await storage.write(
      key: 'notify_credentials_v1_${a.storageId}',
      value: 'secret malformed',
    );

    expect(await store.load(a), isNull);
  });

  test('a wrong version or missing field reads as not provisioned', () async {
    final storage = InMemorySecureStorage();
    final store = NotifyCredentialsStore(storage: storage);
    final a = _scope('owner-a');
    final key = 'notify_credentials_v1_${a.storageId}';

    await storage.write(
      key: key,
      value: jsonEncode({'version': 99, 'topic': 't', 'accessToken': 'k'}),
    );
    expect(await store.load(a), isNull);

    await storage.write(
      key: key,
      value: jsonEncode({'version': 1, 'topic': 't', 'accessToken': ''}),
    );
    expect(await store.load(a), isNull);
  });

  test('saving an incomplete record is rejected', () async {
    final store = NotifyCredentialsStore(storage: InMemorySecureStorage());
    expect(
      () => store.save(
        _scope('owner-a'),
        const NotifyCredentials(topic: '', accessToken: 'k'),
      ),
      throwsArgumentError,
    );
  });
}
