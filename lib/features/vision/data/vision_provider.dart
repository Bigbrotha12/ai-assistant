import 'dart:async' show Future;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import '../../voice/ui/voice_settings_providers.dart';
import './vram_gate.dart';
import './vision_client.dart';
import './vision_config.dart';

/// Resolved external-inference configuration (the `LLM_*` dart-defines, e.g.
/// a LibreChat agents endpoint).
typedef InferenceConfig = ({String baseUrl, String model, String apiKey});

/// The build-time inference configuration the app routes to. Inference never
/// falls back to the gateway (see AGENTS.md): a blank base URL / API key
/// disables vision via [NoOpVisionClient]. Tests override this to simulate a
/// configured build.
final inferenceConfigProvider = Provider<InferenceConfig>(
  (ref) => const (
    baseUrl: BackendConfig.defaultLlmBaseUrl,
    model: BackendConfig.defaultLlmModel,
    apiKey: BackendConfig.defaultLlmApiKey,
  ),
);

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

    // Inference routes exclusively through the configured external API (the
    // LLM_* dart-defines, e.g. LibreChat); vision is optional and fails safe
    // to a no-op when the inference endpoint is not configured.
    final config = ref.watch(inferenceConfigProvider);
    final base = config.baseUrl.trim();
    final apiKey = config.apiKey.trim();
    if (base.isEmpty || apiKey.isEmpty) return const NoOpVisionClient();

    // The LLM base already ends in `/v1` (chat appends `chat/completions`),
    // so the vision client (which appends its own `/v1/...` path) uses the
    // root with the suffix stripped.
    final route = BackendConfig.stripV1Suffix(base);

    // Lightweight check: query /v1/models for model.vl on the inference
    // backend. The preflight must carry the bearer API key too — an
    // unauthenticated probe would 401 and silently disable vision via
    // [NoOpVisionClient].
    if (!await _hasVisionBackend(route, ref.read(dioProvider), apiKey)) {
      return const NoOpVisionClient();
    }

    return VisionApiClient(baseUrl: route, dio: ref.read(dioProvider), apiKey: apiKey);
  }

  /// Queries the backend's /v1/models to check for [kVisionModelRoute].
  /// Returns false on any failure. The bearer key (when set) is attached so
  /// the probe is authorized like the describe call itself.
  Future<bool> _hasVisionBackend(
    String baseUrl,
    Dio dio,
    String? apiKey,
  ) async {
    try {
      final response = await dio.get(
        '$baseUrl/v1/models',
        options: Options(
          headers: {
            if (apiKey != null && apiKey.isNotEmpty)
              'Authorization': 'Bearer $apiKey',
          },
          // Never replay the bearer key to a redirect target on another
          // origin; a 3xx is a misconfiguration and must surface as a miss.
          followRedirects: false,
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
