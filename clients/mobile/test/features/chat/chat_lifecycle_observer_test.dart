import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/ui/chat_lifecycle_observer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ChatLifecycleObserver', () {
    test('resumed arms the poller; paused/hidden/detached suspend; inactive '
        'does neither', () async {
      var foregrounded = 0;
      var backgrounded = 0;
      final observer = ChatLifecycleObserver(
        onForeground: () async => foregrounded++,
        onBackground: () async => backgrounded++,
      );

      observer.didChangeAppLifecycleState(AppLifecycleState.inactive);
      await _flushMicrotasks();
      expect(foregrounded, 0);
      expect(backgrounded, 0);

      observer.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await _flushMicrotasks();
      expect(foregrounded, 1);

      observer.didChangeAppLifecycleState(AppLifecycleState.paused);
      await _flushMicrotasks();
      expect(backgrounded, 1);

      observer.didChangeAppLifecycleState(AppLifecycleState.hidden);
      await _flushMicrotasks();
      expect(backgrounded, 2);

      observer.didChangeAppLifecycleState(AppLifecycleState.detached);
      await _flushMicrotasks();
      expect(backgrounded, 3);
    });

    test('ignores lifecycle changes after dispose and disposes idempotently',
        () async {
      var foregrounded = 0;
      final observer = ChatLifecycleObserver(
        onForeground: () async => foregrounded++,
        onBackground: () async {},
      );

      observer.dispose();
      observer.dispose();
      observer.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await _flushMicrotasks();
      expect(foregrounded, 0);
    });
  });
}

Future<void> _flushMicrotasks() async {
  // `unawaited` callbacks complete on the microtask/event queue.
  await Future<void>.delayed(const Duration(milliseconds: 1));
}