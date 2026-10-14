import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/vision/data/vision_client.dart';
import 'package:ai_assistant/features/vision/data/vision_provider.dart';
import 'package:ai_assistant/features/vision/data/vram_gate.dart';
import 'package:ai_assistant/features/voice/data/voice_settings.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';
import '../voice/voice_test_fakes.dart';

/// Controlled VRAM gate.
class TestVRAMGate implements VRAMGate {
  TestVRAMGate({this.headroomAvailable = true});

  final bool headroomAvailable;

  @override
  Future<bool> hasHeadroom({int thresholdMB = 4096}) async =>
      headroomAvailable;
}

void main() {
  group('VisionClientNotifier build logic', () {
    test('returns NoOpVisionClient when VRAM headroom is insufficient',
        () async {
      final container = ProviderContainer(
        overrides: [
          vramGateProvider.overrideWithValue(
            TestVRAMGate(headroomAvailable: false),
          ),
        ],
      );
      addTearDown(container.dispose);
      final client = await container.read(visionClientProvider.future);
      expect(client, isA<NoOpVisionClient>());
    });

    test('returns NoOpVisionClient when vision is disabled', () async {
      final container = ProviderContainer(
        overrides: [
          vramGateProvider.overrideWithValue(const NoOpVRAMGate()),
          voiceSettingsStoreProvider.overrideWithValue(
            FakeVoiceSettingsStore(
              const VoiceSettings(
                sttEngine: 'default',
                vadSensitivity: 0.5,
                visionEnabled: false,
              ),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      final client = await container.read(visionClientProvider.future);
      expect(client, isA<NoOpVisionClient>());
    });
  });
}