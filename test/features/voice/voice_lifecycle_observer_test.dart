import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/ui/voice_lifecycle_observer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('VoiceLifecycleObserver', () {
    test('inactive does not suspend, background or tear down the session',
        () async {
      var backgrounded = 0;
      var foregrounded = 0;
      final observer = VoiceLifecycleObserver(
        onBackground: () async => backgrounded++,
        onForeground: () async => foregrounded++,
      );

      observer.didChangeAppLifecycleState(AppLifecycleState.inactive);
      await _flushMicrotasks();
      expect(backgrounded, 0);
      expect(foregrounded, 0);

      observer.didChangeAppLifecycleState(AppLifecycleState.paused);
      await _flushMicrotasks();
      expect(backgrounded, 1);

      observer.didChangeAppLifecycleState(AppLifecycleState.hidden);
      await _flushMicrotasks();
      expect(backgrounded, 2);

      observer.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await _flushMicrotasks();
      expect(foregrounded, 1);

      observer.didChangeAppLifecycleState(AppLifecycleState.detached);
      await _flushMicrotasks();
      expect(backgrounded, 3);
    });

    test('ignores lifecycle changes after dispose and disposes idempotently',
        () async {
      var backgrounded = 0;
      final observer = VoiceLifecycleObserver(
        onBackground: () async => backgrounded++,
      );

      observer.dispose();
      observer.dispose();
      observer.didChangeAppLifecycleState(AppLifecycleState.paused);
      await _flushMicrotasks();
      expect(backgrounded, 0);
    });
  });
}

Future<void> _flushMicrotasks() async {
  // `unawaited` callbacks complete on the microtask/event queue.
  await Future<void>.delayed(const Duration(milliseconds: 1));
}