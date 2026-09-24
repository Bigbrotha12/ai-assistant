import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/device_health.dart';
import 'package:ai_assistant/features/voice/data/device_health_provider.dart';
import 'package:ai_assistant/features/voice/data/engine_config.dart';
import 'package:ai_assistant/features/voice/data/engine_manager_provider.dart';
import 'package:ai_assistant/features/voice/data/voice_runtime_policy.dart';
import 'package:ai_assistant/features/voice/data/voice_runtime_policy_provider.dart';

import 'voice_test_fakes.dart';

class _PolicyHarness {
  _PolicyHarness({
    DeviceHealthSnapshot snapshot = const DeviceHealthSnapshot.unknown(),
    Duration recoveryDuration = Duration.zero,
  }) {
    source = InMemoryDeviceHealthSource(snapshot);
    monitor = DeviceHealthMonitor(
      source: source,
      thermalSource: const NoopThermalSignalSource(),
    );
    manager = FakeEngineManager();
    policy = VoiceRuntimePolicyController(
      healthMonitor: monitor,
      engineManager: manager,
      recoveryDuration: recoveryDuration,
    );
  }

  late final InMemoryDeviceHealthSource source;
  late final DeviceHealthMonitor monitor;
  late final FakeEngineManager manager;
  late final VoiceRuntimePolicyController policy;

  Future<void> settle() async {
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  Future<void> dispose() async {
    policy.dispose();
    monitor.dispose();
    manager.dispose();
    await source.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const pathProviderChannel = MethodChannel('plugins.flutter.io/path_provider');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          pathProviderChannel,
          (call) async => Directory.systemTemp.path,
        );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pathProviderChannel, null);
  });

  group('VoiceRuntimePolicy capability classification', () {
    test('missing capability data remains capable', () {
      final decision = VoiceRuntimePolicy.classify(const VoiceRuntimeInputs());

      expect(decision.level, VoiceRuntimeLevel.ready);
      expect(decision.allowCapture, isTrue);
      expect(decision.allowTts, isTrue);
      expect(decision.allowModelDownload, isTrue);
      expect(decision.reasons, isEmpty);
      expect(decision.textChatAvailable, isTrue);
    });

    test('uses the four gibibyte RAM floor at the boundary', () {
      final atFloor = VoiceRuntimePolicy.classify(
        VoiceRuntimeInputs(
          physicalMemoryBytes: voiceMinimumPhysicalMemoryBytes,
        ),
      );
      final belowFloor = VoiceRuntimePolicy.classify(
        VoiceRuntimeInputs(
          physicalMemoryBytes: voiceMinimumPhysicalMemoryBytes - 1,
        ),
      );

      expect(atFloor.allowCapture, isTrue);
      expect(belowFloor.allowCapture, isFalse);
      expect(belowFloor.level, VoiceRuntimeLevel.blocked);
      expect(
        belowFloor.hasReason(VoiceRuntimeReason.insufficientPhysicalMemory),
        isTrue,
      );
    });

    test('low storage disables downloads without disabling capture', () {
      final decision = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(
          freeStorageBytes: 99,
          requiredDownloadBytes: 100,
          sttReady: true,
          ttsReady: true,
        ),
      );

      expect(decision.allowCapture, isTrue);
      expect(decision.allowTts, isTrue);
      expect(decision.allowModelDownload, isFalse);
      expect(decision.hasReason(VoiceRuntimeReason.lowFreeStorage), isTrue);
    });

    test('storage threshold includes the safety margin', () {
      final exact = VoiceRuntimePolicy.classify(
        VoiceRuntimeInputs(
          freeStorageBytes: EngineConfig.modelDownloadSafetyMarginBytes + 100,
          requiredDownloadBytes: 100,
        ),
      );
      final below = VoiceRuntimePolicy.classify(
        VoiceRuntimeInputs(
          freeStorageBytes: EngineConfig.modelDownloadSafetyMarginBytes + 99,
          requiredDownloadBytes: 100,
        ),
      );

      expect(exact.allowModelDownload, isTrue);
      expect(below.allowModelDownload, isFalse);
    });

    test('negative capability values fail closed for capture', () {
      final decision = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(physicalMemoryBytes: -1, freeStorageBytes: -1),
      );

      expect(decision.allowCapture, isFalse);
      expect(decision.allowModelDownload, isFalse);
      expect(decision.textChatAvailable, isTrue);
    });

    test('missing STT and TTS models degrade independently', () {
      final sttMissing = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(sttReady: false, ttsReady: true),
      );
      final ttsMissing = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(sttReady: true, ttsReady: false),
      );

      expect(sttMissing.allowCapture, isFalse);
      expect(sttMissing.allowTts, isTrue);
      expect(sttMissing.level, VoiceRuntimeLevel.blocked);
      expect(ttsMissing.allowCapture, isTrue);
      expect(ttsMissing.allowTts, isFalse);
      expect(ttsMissing.level, VoiceRuntimeLevel.reduced);
    });
  });

  test(
    'provider forwards injected thermal events into one capability state',
    () async {
      final healthSource = InMemoryDeviceHealthSource();
      final thermalSource = InMemoryThermalSignalSource();
      final manager = FakeEngineManager();
      final container = ProviderContainer(
        overrides: [
          deviceHealthSourceProvider.overrideWithValue(healthSource),
          thermalSignalSourceProvider.overrideWithValue(thermalSource),
          engineManagerProvider.overrideWithValue(manager),
        ],
      );
      addTearDown(() async {
        container.dispose();
        manager.dispose();
        await healthSource.dispose();
        await thermalSource.dispose();
      });

      expect(
        container.read(voiceRuntimeDecisionProvider).level,
        VoiceRuntimeLevel.ready,
      );
      thermalSource.emit(ThermalStatus.fair);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(
        container.read(voiceRuntimeDecisionProvider).level,
        VoiceRuntimeLevel.reduced,
      );
    },
  );

  group('thermal and runtime health', () {
    test('maps Android and iOS thermal names to normalized states', () {
      expect(thermalStatusFromPlatformName('NONE'), ThermalStatus.nominal);
      expect(thermalStatusFromPlatformName('LIGHT'), ThermalStatus.light);
      expect(thermalStatusFromPlatformName('MODERATE'), ThermalStatus.moderate);
      expect(thermalStatusFromPlatformName('fair'), ThermalStatus.fair);
      expect(thermalStatusFromPlatformName('serious'), ThermalStatus.serious);
      expect(thermalStatusFromPlatformName('SEVERE'), ThermalStatus.severe);
      expect(thermalStatusFromPlatformName('critical'), ThermalStatus.critical);
      expect(thermalStatusFromPlatformName(null), ThermalStatus.unknown);
    });

    test('unknown thermal signal is not a denial', () {
      final decision = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(thermalStatus: ThermalStatus.unknown),
      );

      expect(decision.level, VoiceRuntimeLevel.ready);
      expect(decision.allowCapture, isTrue);
      expect(decision.allowTts, isTrue);
    });

    test('fair thermal reduces TTS while capture remains available', () {
      final decision = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(thermalStatus: ThermalStatus.fair),
      );

      expect(decision.allowCapture, isTrue);
      expect(decision.allowTts, isFalse);
      expect(decision.level, VoiceRuntimeLevel.reduced);
    });

    test('serious thermal blocks capture and TTS', () {
      final decision = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(thermalStatus: ThermalStatus.serious),
      );

      expect(decision.allowCapture, isFalse);
      expect(decision.allowTts, isFalse);
      expect(decision.level, VoiceRuntimeLevel.blocked);
    });

    test('normal to degraded to recovered uses stable hysteresis', () async {
      final harness = _PolicyHarness(
        snapshot: const DeviceHealthSnapshot(
          thermalStatus: ThermalStatus.nominal,
        ),
        recoveryDuration: const Duration(milliseconds: 25),
      );
      addTearDown(harness.dispose);
      await harness.settle();

      expect(harness.policy.decision.level, VoiceRuntimeLevel.ready);

      harness.source.emit(
        const DeviceHealthSnapshot(thermalStatus: ThermalStatus.fair),
      );
      await harness.settle();
      expect(harness.policy.decision.level, VoiceRuntimeLevel.reduced);

      harness.source.emit(
        const DeviceHealthSnapshot(thermalStatus: ThermalStatus.nominal),
      );
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(harness.policy.decision.level, VoiceRuntimeLevel.reduced);

      await Future<void>.delayed(const Duration(milliseconds: 35));
      expect(harness.policy.decision.level, VoiceRuntimeLevel.ready);
    });

    test(
      'high process memory reduces TTS and system pressure blocks capture',
      () {
        final highMemory = VoiceRuntimePolicy.classify(
          const VoiceRuntimeInputs(
            processRssBytes: 90,
            processMemoryLimitBytes: 100,
          ),
        );
        final systemPressure = VoiceRuntimePolicy.classify(
          const VoiceRuntimeInputs(systemLowMemory: true),
        );

        expect(highMemory.allowCapture, isTrue);
        expect(highMemory.allowTts, isFalse);
        expect(systemPressure.allowCapture, isFalse);
        expect(systemPressure.allowTts, isFalse);
      },
    );

    test('runtime load disables TTS first', () {
      final decision = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(sustainedLoad: true),
      );

      expect(decision.allowCapture, isTrue);
      expect(decision.allowTts, isFalse);
      expect(decision.level, VoiceRuntimeLevel.reduced);
    });
  });

  group('fallback notices and tool classification', () {
    test('blocked and reduced decisions expose stable fallback notices', () {
      final blocked = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(thermalStatus: ThermalStatus.critical),
      );
      final reduced = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(thermalStatus: ThermalStatus.moderate),
      );
      final storage = VoiceRuntimePolicy.classify(
        const VoiceRuntimeInputs(freeStorageBytes: 1, requiredDownloadBytes: 2),
      );

      expect(blocked.notice, contains('Continue in text'));
      expect(reduced.notice, contains('Replies remain available as text'));
      expect(storage.notice, contains('Installed models remain usable'));
    });

    test('classifies manifest risk and fails MCP closed', () {
      const classifier = VoiceToolCapabilityClassifier();
      const readOnly = VoiceToolDescriptor(
        id: 'manifest.read',
        source: VoiceToolSource.manifest,
        readOnly: true,
        hasRiskMetadata: true,
      );
      const mutating = VoiceToolDescriptor(
        id: 'manifest.write',
        source: VoiceToolSource.manifest,
        readOnly: false,
        hasRiskMetadata: true,
      );
      const unclassifiedManifest = VoiceToolDescriptor(
        id: 'manifest.custom',
        source: VoiceToolSource.manifest,
      );
      const mcp = VoiceToolDescriptor(
        id: 'mcp.any',
        source: VoiceToolSource.mcp,
        readOnly: true,
        hasRiskMetadata: true,
      );

      expect(
        classifier.classify(readOnly),
        VoiceToolClassification.readOnlyManifest,
      );
      expect(
        classifier.classify(mutating),
        VoiceToolClassification.mutatingManifest,
      );
      expect(
        classifier.classify(unclassifiedManifest),
        VoiceToolClassification.unclassifiedManifest,
      );
      expect(classifier.classify(mcp), VoiceToolClassification.unclassifiedMcp);
    });
  });
}
