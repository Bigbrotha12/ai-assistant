import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/chat_client_provider.dart';
import 'package:ai_assistant/features/chat/data/database_providers.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/screen_wake_lock.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_providers.dart';
import 'package:ai_assistant/features/voice/data/tts_engine.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller_provider.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

/// Mic capture whose [stop] can be held open, letting a background teardown
/// suspend mid-flight — the window in which a foreground event used to win
/// out of order.
class _GatedMicCapture extends FakeMicCaptureService {
  Completer<void>? stopGate;

  @override
  Future<void> stop() async {
    final gate = stopGate;
    if (gate != null) {
      await gate.future;
    }
    await super.stop();
  }
}

/// Records wake-lock transitions so a stale enable/disable is observable.
class _RecordingScreenWakeLock implements ScreenWakeLock {
  bool enabled = false;
  int enableCount = 0;
  int disableCount = 0;

  @override
  Future<void> enable() async {
    enabled = true;
    enableCount++;
  }

  @override
  Future<void> disable() async {
    enabled = false;
    disableCount++;
  }
}

/// Wake lock whose [disable] can hang on the platform channel, so a resume's
/// enable queues behind a stuck background disable.
class _GatedDisableScreenWakeLock extends _RecordingScreenWakeLock {
  Completer<void>? disableGate;

  @override
  Future<void> disable() async {
    final gate = disableGate;
    if (gate != null) {
      await gate.future;
    }
    await super.disable();
  }
}

class _EngineAwareManager extends FakeEngineManager {
  _EngineAwareManager({this.tts});

  final FakeTtsEngine? tts;

  @override
  TtsEngine? get ttsEngine => tts;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The EngineManager base constructor resolves the model directory via
  // path_provider (no plugin implementation in plain tests).
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async => '/tmp',
      );

  late _GatedMicCapture mic;
  late FakeAudioPlayback playback;
  late FakeTtsEngine tts;
  late _GatedDisableScreenWakeLock wakeLock;

  ProviderContainer buildContainer() {
    mic = _GatedMicCapture();
    playback = FakeAudioPlayback();
    tts = FakeTtsEngine();
    wakeLock = _GatedDisableScreenWakeLock();
    final container = ProviderContainer(
      overrides: [
        engineManagerProvider.overrideWithValue(
          _EngineAwareManager(tts: tts),
        ),
        micCaptureServiceProvider.overrideWithValue(mic),
        audioPlaybackServiceProvider.overrideWithValue(playback),
        audioSessionManagerProvider.overrideWithValue(FakeAudioSessionManager()),
        screenWakeLockProvider.overrideWithValue(wakeLock),
        chatApiClientProvider.overrideWithValue(FakeChatClient()),
        chatStoreProvider.overrideWithValue(FakeChatStore()),
        voiceSettingsStoreProvider.overrideWithValue(FakeVoiceSettingsStore()),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  group('pipeline lifecycle', () {
    test(
        'a foreground landing mid-background-teardown wins: the session is '
        'not stranded backgrounded and the wake lock is restored', () async {
      final container = buildContainer();
      final controller = container.read(voiceControllerProvider);
      final pipeline = container.read(voiceCapturePipelineProvider);
      await controller.startConversation();
      // Pipeline-owned recording so the background handler parks on the mic
      // stop before it calls enterBackground.
      await pipeline.startRecording();
      expect(pipeline.isRecording, isTrue);
      expect(wakeLock.enabled, isTrue);

      // App backgrounds: the handler suspends inside the gated mic stop.
      mic.stopGate = Completer<void>();
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await pumpEventQueue();

      // App returns while the background teardown is still in flight.
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await pumpEventQueue();

      // Release the halt: the queued foreground transition must now run last.
      mic.stopGate!.complete();
      for (var i = 0; i < 15; i++) {
        await pumpEventQueue();
      }

      // Not stuck backgrounded: speaking works, audio plays, screen stays on.
      final spoken = await controller.synthesizeOnDevice('hello again');
      expect(spoken, isNotEmpty);
      expect(playback.playedChunks, hasLength(1));
      expect(wakeLock.enabled, isTrue);
      expect(controller.state.isConnected, isTrue);
    });

    test('a background after an earlier foreground still suspends the session',
        () async {
      final container = buildContainer();
      final controller = container.read(voiceControllerProvider);
      container.read(voiceCapturePipelineProvider);
      await controller.startConversation();

      // Clean pause → resume cycle, then another pause: the last event wins.
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await pumpEventQueue();
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      for (var i = 0; i < 10; i++) {
        await pumpEventQueue();
      }
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.paused);
      for (var i = 0; i < 10; i++) {
        await pumpEventQueue();
      }

      // Backgrounded at the end: a backgrounded speak resolves without audio.
      final spoken = await controller.synthesizeOnDevice('quiet');
      expect(spoken, isEmpty);
      expect(playback.playedChunks, isEmpty);
      expect(wakeLock.enabled, isFalse);
    });

    testWidgets(
        'a background transition overrunning the 2s bound (straggler) still '
        'tears down the pipeline mic after the foreground won', (tester) async {
      final container = buildContainer();
      final controller = container.read(voiceControllerProvider);
      final pipeline = container.read(voiceCapturePipelineProvider);
      await controller.startConversation();
      await pipeline.startRecording();
      expect(pipeline.isRecording, isTrue);

      // The background parks the controller teardown inside its own gated mic
      // stop; it then overruns the 2s lifecycle bound.
      mic.stopGate = Completer<void>();
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(controller.isBackgrounded, isTrue);
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(controller.isBackgrounded, isTrue);

      // The bound abandons the parked transition and the foreground wins while
      // the straggler is still mid-teardown.
      await tester.pump(const Duration(seconds: 3));
      expect(controller.isBackgrounded, isFalse);
      expect(wakeLock.enabled, isTrue);

      // The straggler resumes past the gate: it MUST still cancel the pipeline
      // mic subscription — gating the stop on the now-cleared flag would leak
      // the microphone for the whole background period and beyond.
      mic.stopGate!.complete();
      await tester.pump(const Duration(seconds: 1));
      expect(pipeline.isRecording, isFalse);
      expect(wakeLock.enabled, isTrue);
    });

    testWidgets('a hung wake-lock disable cannot wedge the resume enable',
        (tester) async {
      final container = buildContainer();
      final controller = container.read(voiceControllerProvider);
      container.read(voiceCapturePipelineProvider);
      await controller.startConversation();
      expect(wakeLock.enableCount, 1);

      // The background disable hangs on the platform channel, so the FIFO is
      // parked behind it. Pre-fix (unbounded), the resume's enable would queue
      // behind it forever and exitBackground would never complete; the 2s
      // bound is what lets the enable apply and resolves the resume.
      wakeLock.disableGate = Completer<void>();
      WidgetsBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(controller.isBackgrounded, isTrue);

      final resumed =
          controller.exitBackground().timeout(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      await resumed;
      expect(controller.isBackgrounded, isFalse);
      expect(wakeLock.enabled, isTrue);
      // The resume's enable actually ran: the screen is not left off while
      // connected and foregrounded.
      expect(wakeLock.enableCount, greaterThanOrEqualTo(2));
    });
  });
}