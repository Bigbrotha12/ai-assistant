import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import './device_health_provider.dart';
import './engine_manager_provider.dart';
import './voice_runtime_policy.dart';

final voiceRuntimePolicyProvider =
    ChangeNotifierProvider<VoiceRuntimePolicyController>((ref) {
      return VoiceRuntimePolicyController(
        healthMonitor: ref.watch(deviceHealthProvider),
        engineManager: ref.watch(engineManagerProvider),
      );
    });

final voiceRuntimeDecisionProvider = Provider<VoiceRuntimeDecision>((ref) {
  return ref.watch(voiceRuntimePolicyProvider).decision;
});
