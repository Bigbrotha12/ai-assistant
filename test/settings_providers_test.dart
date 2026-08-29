import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/settings_providers.dart';

import 'fakes.dart';

void main() {
  ProviderContainer makeContainer(FakeSettingsStore store) {
    final container = ProviderContainer(
      overrides: [settingsStoreProvider.overrideWithValue(store)],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('build exposes null when nothing is persisted', () async {
    final container = makeContainer(FakeSettingsStore());

    expect(await container.read(settingsProvider.future), isNull);
  });

  test('build exposes persisted settings', () async {
    final container = makeContainer(
      FakeSettingsStore(stored: const BackendSettings(host: 'myhost')),
    );

    final settings = await container.read(settingsProvider.future);
    expect(settings, const BackendSettings(host: 'myhost'));
  });

  test('save persists and updates the state', () async {
    final store = FakeSettingsStore();
    final container = makeContainer(store);
    await container.read(settingsProvider.future);

    const settings = BackendSettings(host: 'myhost');
    await container.read(settingsProvider.notifier).save(settings);

    expect(store.stored, settings);
    expect(container.read(settingsProvider).value, settings);
  });

  test('a failed save surfaces AsyncError', () async {
    final store = FakeSettingsStore()..failNextSave = true;
    final container = makeContainer(store);
    await container.read(settingsProvider.future);

    await expectLater(
      container
          .read(settingsProvider.notifier)
          .save(const BackendSettings(host: 'myhost')),
      throwsStateError,
    );
    expect(container.read(settingsProvider).hasError, isTrue);
  });

  test('clear resets persisted settings and state', () async {
    final store =
        FakeSettingsStore(stored: const BackendSettings(host: 'myhost'));
    final container = makeContainer(store);
    await container.read(settingsProvider.future);

    await container.read(settingsProvider.notifier).clear();

    expect(store.stored, isNull);
    expect(container.read(settingsProvider).value, isNull);
  });
}