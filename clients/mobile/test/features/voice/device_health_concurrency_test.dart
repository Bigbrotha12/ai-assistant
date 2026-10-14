import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/device_health.dart';
import 'package:ai_assistant/features/voice/data/voice_capture_pipeline.dart';
import 'package:ai_assistant/features/voice/data/voice_runtime_policy.dart';
import 'package:ai_assistant/features/voice/ui/voice_controller.dart';

import '../../fakes.dart';
import 'voice_test_fakes.dart';

Map<String, Object?> _healthySnapshot({
  bool lowMemory = false,
  String thermal = 'nominal',
}) => <String, Object?>{
  'physicalMemoryBytes': 8 * 1024 * 1024 * 1024,
  'freeStorageBytes': 1024 * 1024 * 1024,
  'systemLowMemory': lowMemory,
  'thermalStatus': thermal,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const methodChannel = MethodChannel(deviceHealthMethodChannelName);
  const thermalChannel = EventChannel(deviceHealthThermalEventChannelName);
  const lowMemoryChannel = EventChannel(deviceHealthLowMemoryEventChannelName);
  const pathProviderChannel = MethodChannel('plugins.flutter.io/path_provider');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProviderChannel, (call) async => '/tmp');
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProviderChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(methodChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(thermalChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(lowMemoryChannel, null);
  });

  test(
    'a never-returning snapshot falls back within the platform bound',
    () async {
      final gate = Completer<Object?>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) => gate.future);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            thermalChannel,
            MockStreamHandler.inline(onListen: (_, _) {}),
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            lowMemoryChannel,
            MockStreamHandler.inline(onListen: (_, _) {}),
          );

      final bridge = PlatformDeviceHealthBridge(
        methodChannel: methodChannel,
        thermalChannel: thermalChannel,
        lowMemoryChannel: lowMemoryChannel,
        eventStreamsEnabled: true,
        snapshotTimeout: const Duration(milliseconds: 30),
      );
      addTearDown(bridge.dispose);

      final stopwatch = Stopwatch()..start();
      final snapshot = await bridge.read().timeout(
        const Duration(milliseconds: 500),
      );
      stopwatch.stop();

      expect(stopwatch.elapsed, lessThan(const Duration(milliseconds: 300)));
      expect(snapshot.physicalMemoryBytes, isNull);
      expect(snapshot.freeStorageBytes, isNull);
      expect(snapshot.systemLowMemory, isNull);
      expect(snapshot.thermalStatus, ThermalStatus.unknown);

      gate.completeError(StateError('late platform failure'));
      await pumpEventQueue();
      expect(bridge.currentThermalStatus, ThermalStatus.unknown);
    },
  );

  test('the monitor coalesces concurrent refreshes', () async {
    final source = _GatedDeviceHealthSource();
    final monitor = DeviceHealthMonitor(source: source);
    addTearDown(() async {
      monitor.dispose();
      await source.dispose();
    });

    final first = monitor.refresh();
    final second = monitor.refresh();
    expect(identical(first, second), isTrue);
    expect(source.readCount, 1);

    source.gate.complete(
      const DeviceHealthSnapshot(
        physicalMemoryBytes: 8 * 1024 * 1024 * 1024,
        freeStorageBytes: 1024 * 1024 * 1024,
        systemLowMemory: false,
        thermalStatus: ThermalStatus.nominal,
      ),
    );
    await Future.wait<void>([first, second]);
    expect(source.readCount, 1);
  });

  test(
    'a late snapshot cannot overwrite events received during the read',
    () async {
      var callCount = 0;
      final lateSnapshot = Completer<Object?>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) {
            callCount++;
            return callCount == 1
                ? Future<Object?>.value(_healthySnapshot())
                : lateSnapshot.future;
          });

      final thermalArguments = <Object?>[];
      final lowMemoryArguments = <Object?>[];
      late MockStreamHandlerEventSink thermalEvents;
      late MockStreamHandlerEventSink lowMemoryEvents;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            thermalChannel,
            MockStreamHandler.inline(
              onListen: (arguments, events) {
                thermalArguments.add(arguments);
                thermalEvents = events;
              },
            ),
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            lowMemoryChannel,
            MockStreamHandler.inline(
              onListen: (arguments, events) {
                lowMemoryArguments.add(arguments);
                lowMemoryEvents = events;
              },
            ),
          );

      final bridge = PlatformDeviceHealthBridge(
        methodChannel: methodChannel,
        thermalChannel: thermalChannel,
        lowMemoryChannel: lowMemoryChannel,
        eventStreamsEnabled: true,
        snapshotTimeout: const Duration(milliseconds: 500),
      );
      addTearDown(bridge.dispose);
      final source = PlatformDeviceHealthSource(bridge);
      final thermal = PlatformThermalSignalSource(bridge);
      final snapshots = <DeviceHealthSnapshot>[];
      final firstSubscription = source.changes.listen(snapshots.add);
      final secondSubscription = thermal.changes.listen((_) {});
      addTearDown(() async {
        await firstSubscription.cancel();
        await secondSubscription.cancel();
      });

      await bridge.read();
      await pumpEventQueue();
      expect(thermalArguments, isNotEmpty);
      expect(lowMemoryArguments, isNotEmpty);

      final firstRefresh = bridge.read();
      final secondRefresh = bridge.read();
      expect(identical(firstRefresh, secondRefresh), isTrue);
      expect(callCount, 2);

      thermalEvents.success('serious');
      lowMemoryEvents.success(true);
      await pumpEventQueue();
      lateSnapshot.complete(_healthySnapshot());
      final resolved = await firstRefresh;
      await pumpEventQueue();

      expect(resolved.systemLowMemory, isTrue);
      expect(resolved.thermalStatus, ThermalStatus.serious);
      expect(bridge.currentThermalStatus, ThermalStatus.serious);
      expect(snapshots.last.systemLowMemory, isTrue);
      expect(snapshots.last.thermalStatus, ThermalStatus.serious);
    },
  );

  test(
    'rapid resubscribe awaits cancellation and leaves one live listener pair',
    () async {
      var listenCount = 0;
      var cancelCount = 0;
      final arguments = <Object?>[];
      late MockStreamHandlerEventSink thermalEvents;
      late MockStreamHandlerEventSink lowMemoryEvents;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            methodChannel,
            (call) async => _healthySnapshot(),
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            thermalChannel,
            MockStreamHandler.inline(
              onListen: (value, events) {
                listenCount++;
                arguments.add(value);
                thermalEvents = events;
              },
              onCancel: (_) => cancelCount++,
            ),
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            lowMemoryChannel,
            MockStreamHandler.inline(
              onListen: (value, events) {
                listenCount++;
                arguments.add(value);
                lowMemoryEvents = events;
              },
              onCancel: (_) => cancelCount++,
            ),
          );

      final bridge = PlatformDeviceHealthBridge(
        methodChannel: methodChannel,
        thermalChannel: thermalChannel,
        lowMemoryChannel: lowMemoryChannel,
        eventStreamsEnabled: true,
        snapshotTimeout: const Duration(milliseconds: 100),
      );
      addTearDown(bridge.dispose);
      final source = PlatformDeviceHealthSource(bridge);
      final first = source.changes.listen((_) {});
      await bridge.read();
      await pumpEventQueue();
      expect(listenCount, 2);

      await first.cancel();
      final second = source.changes.listen((_) {});
      await pumpEventQueue();
      expect(cancelCount, 2);
      expect(listenCount, 4);
      expect(arguments.whereType<int>().toSet(), hasLength(2));

      thermalEvents.success('nominal');
      lowMemoryEvents.success(false);
      await pumpEventQueue();
      expect(bridge.currentThermalStatus, ThermalStatus.nominal);

      await second.cancel();
      await pumpEventQueue();
      expect(cancelCount, 4);
    },
  );

  test('a clean platform snapshot clears a low-memory runtime block', () async {
    var lowMemory = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          methodChannel,
          (call) async => _healthySnapshot(lowMemory: lowMemory),
        );
    late MockStreamHandlerEventSink lowMemoryEvents;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(
          thermalChannel,
          MockStreamHandler.inline(onListen: (_, _) {}),
        );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockStreamHandler(
          lowMemoryChannel,
          MockStreamHandler.inline(
            onListen: (_, events) => lowMemoryEvents = events,
          ),
        );

    final bridge = PlatformDeviceHealthBridge(
      methodChannel: methodChannel,
      thermalChannel: thermalChannel,
      lowMemoryChannel: lowMemoryChannel,
      eventStreamsEnabled: true,
      snapshotTimeout: const Duration(milliseconds: 100),
    );
    final source = PlatformDeviceHealthSource(bridge);
    final thermal = PlatformThermalSignalSource(bridge);
    final monitor = DeviceHealthMonitor(source: source, thermalSource: thermal);
    final manager = FakeEngineManager();
    final policy = VoiceRuntimePolicyController(
      healthMonitor: monitor,
      engineManager: manager,
      recoveryDuration: Duration.zero,
      telemetryGracePeriod: Duration.zero,
    );
    addTearDown(() async {
      policy.dispose();
      monitor.dispose();
      manager.dispose();
      bridge.dispose();
      await pumpEventQueue();
    });

    await pumpEventQueue();
    expect(policy.decision.allowCapture, isTrue);

    lowMemoryEvents.success(true);
    await pumpEventQueue();
    expect(policy.decision.allowCapture, isFalse);

    lowMemory = false;
    await monitor.refresh();
    await pumpEventQueue();
    expect(policy.decision.allowCapture, isTrue);
    expect(
      policy.decision.hasReason(VoiceRuntimeReason.systemLowMemory),
      isFalse,
    );
  });

  test(
    'a timed-out health read leaves text usable and gates capture',
    () async {
      final gate = Completer<Object?>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(methodChannel, (call) => gate.future);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            thermalChannel,
            MockStreamHandler.inline(onListen: (_, _) {}),
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockStreamHandler(
            lowMemoryChannel,
            MockStreamHandler.inline(onListen: (_, _) {}),
          );

      final bridge = PlatformDeviceHealthBridge(
        methodChannel: methodChannel,
        thermalChannel: thermalChannel,
        lowMemoryChannel: lowMemoryChannel,
        eventStreamsEnabled: true,
        snapshotTimeout: const Duration(milliseconds: 30),
      );
      final source = PlatformDeviceHealthSource(bridge);
      final thermal = PlatformThermalSignalSource(bridge);
      final monitor = DeviceHealthMonitor(
        source: source,
        thermalSource: thermal,
      );
      final manager = FakeEngineManager();
      final policy = VoiceRuntimePolicyController(
        healthMonitor: monitor,
        engineManager: manager,
        recoveryDuration: Duration.zero,
        telemetryGracePeriod: Duration.zero,
      );
      final chat = FakeChatClient();
      final mic = FakeMicCaptureService();
      final playback = FakeAudioPlayback();
      final controller = VoiceController(
        sendTurn:
            ({
              required messages,
              required userText,
              systemPrompt,
              cancelToken,
              onReceived,
              onContent,
              onToolCallDelta,
            }) => chat.sendTurn(
              '',
              history: const [],
              userText: userText,
              messages: messages,
              systemPrompt: systemPrompt,
              cancelToken: cancelToken,
              onReceived: onReceived,
              onContent: onContent,
              onToolCallDelta: onToolCallDelta,
            ),
        micCapture: mic,
        playback: playback,
        runtimePolicy: policy,
      );
      final vad = FakeVadProcessor();
      final audioSession = FakeAudioSessionManager();
      final pipeline = VoiceCapturePipeline(
        micCapture: mic,
        vad: vad,
        audioSession: audioSession,
        voiceController: controller,
        runtimePolicy: policy,
      );
      addTearDown(() async {
        await pipeline.dispose();
        await controller.dispose();
        policy.dispose();
        monitor.dispose();
        manager.dispose();
        bridge.dispose();
        await mic.dispose();
        await playback.dispose();
        gate.complete(_healthySnapshot());
        await pumpEventQueue();
      });

      await controller.startConversation();
      await controller.startRecording();
      await pipeline.startRecording();
      expect(mic.startCount, 0);
      expect(policy.decision.allowCapture, isFalse);

      await controller
          .sendText('hello', speakReply: false)
          .timeout(const Duration(milliseconds: 500));
      expect(chat.callCount, 1);
      expect(controller.state.isConnected, isTrue);
    },
  );
}

class _GatedDeviceHealthSource implements DeviceHealthSource {
  final controller = StreamController<DeviceHealthSnapshot>.broadcast();
  final gate = Completer<DeviceHealthSnapshot>();
  int readCount = 0;

  @override
  Future<DeviceHealthSnapshot> read() {
    readCount++;
    return gate.future;
  }

  @override
  Stream<DeviceHealthSnapshot> get changes => controller.stream;

  Future<void> dispose() => controller.close();
}
