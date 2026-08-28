import 'dart:async' show Future;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config.dart';
import '../../core/files_providers.dart';
import '../../core/settings_providers.dart';
import '../voice/voice_settings_providers.dart';
import 'vram_gate.dart';
import 'vision_client.dart';
import 'vision_config.dart';

/// Provides the VRAM gate used to decide whether vision is safe.
final vramGateProvider = Provider<VRAMGate>(
  (ref) => kIsWeb ? NoOpVRAMGate() : LinuxVRAMGate(),
);

/// Provides the vision-enabled setting from voice settings.
/// Null means "use default (true)".
final visionEnabledProvider =
    Provider<bool?>((ref) {
      final settingsAsync = ref.watch(voiceSettingsProvider);
      return settingsAsync.value?.visionEnabled;
    });

/// Async-notifier that wires the active [VisionClient].
///
/// Returns [VisionApiClient] when VRAM headroom is sufficient AND
/// backend supports the VL route AND [visionEnabledProvider] is true.
/// Returns [NoOpVisionClient] otherwise.
final visionClientProvider =
    AsyncNotifierProvider<VisionClientNotifier, VisionClient>(
      VisionClientNotifier.new,
    );

class VisionClientNotifier extends AsyncNotifier<VisionClient> {
  @override
  Future<VisionClient> build() async {
    // Check VRAM headroom first (cheap, local).
    final gate = ref.read(vramGateProvider);
    final hasHeadroom = await gate.hasHeadroom();
    if (!hasHeadroom) return const NoOpVisionClient();

    final voiceSettings = await ref.read(voiceSettingsProvider.future);
    final visionEnabled = voiceSettings?.visionEnabled ?? true;
    if (!visionEnabled) return const NoOpVisionClient();

    // Lightweight check: query /v1/models for model.vl on the backend.
    final backend = await ref.read(settingsProvider.future);
    if (backend == null) return const NoOpVisionClient();
    final baseUrl =
        BackendConfig.llmProxy(backend.trimmedHost).toString().replaceAll(RegExp(r'/$'), '');
    if (!await _hasVisionBackend(baseUrl, ref.read(dioProvider))) {
      return const NoOpVisionClient();
    }

    return VisionApiClient(baseUrl: baseUrl);
  }

  /// Queries the backend's /v1/models to check for [kVisionModelRoute].
  /// Returns false on any failure.
  Future<bool> _hasVisionBackend(String baseUrl, Dio dio) async {
    try {
      final response = await dio.get(
        '$baseUrl/v1/models',
        options: Options(
          connectTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 5),
        ),
      );
      if (response.statusCode != 200) return false;
      final data = response.data as Map<String, dynamic>;
      final models = data['data'] as List?;
      if (models == null) return false;
      for (final model in models) {
        if (model is Map<String, dynamic>) {
          final id = model['id'] as String?;
          if (id == kVisionModelRoute) return true;
        }
      }
    } catch (_) {}
    return false;
  }
}
