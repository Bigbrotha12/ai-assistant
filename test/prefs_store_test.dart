import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_assistant/core/prefs_store.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  test('load returns defaults when nothing has been saved', () async {
    final store = SharedPrefsAppPrefsStore();

    expect(await store.load(), const AppPrefs());
  });

  test('save then load round-trips prefs', () async {
    final store = SharedPrefsAppPrefsStore();

    await store.save(
      const AppPrefs(dateFormat: 'fr-FR', onboardingComplete: true),
    );

    expect(
      await store.load(),
      const AppPrefs(dateFormat: 'fr-FR', onboardingComplete: true),
    );
  });

  test('load after save keeps the stored value across instances', () async {
    final store = SharedPrefsAppPrefsStore();
    await store.save(
      const AppPrefs(dateFormat: 'de-DE', onboardingComplete: true),
    );

    final fresh = SharedPrefsAppPrefsStore();
    expect(
      await fresh.load(),
      const AppPrefs(dateFormat: 'de-DE', onboardingComplete: true),
    );
  });

  test('defaults remain false/false after an empty default save', () async {
    final store = SharedPrefsAppPrefsStore();

    await store.save(const AppPrefs());
    final loaded = await store.load();

    expect(loaded.dateFormat, 'en-US');
    expect(loaded.onboardingComplete, isFalse);
  });

  test('date format may contain colons without corrupting round-trip',
      () async {
    final store = SharedPrefsAppPrefsStore();

    await store.save(
      const AppPrefs(dateFormat: 'en-US:POSIX', onboardingComplete: true),
    );

    expect(
      await store.load(),
      const AppPrefs(dateFormat: 'en-US:POSIX', onboardingComplete: true),
    );
  });

  test('AppPrefs.copyWith overlays only provided fields', () {
    const base = AppPrefs(dateFormat: 'en-US', onboardingComplete: true);
    final updated = base.copyWith(onboardingComplete: false);

    expect(updated.dateFormat, 'en-US');
    expect(updated.onboardingComplete, isFalse);
  });
}
