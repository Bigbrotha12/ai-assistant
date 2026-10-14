import 'dart:async' show Future;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/app_startup.dart';
import '../../../core/config.dart';
import '../../../core/http/dio_provider.dart';
import '../../auth/data/auth_credentials_providers.dart';
import '../../plugins/data/plugin_credentials_providers.dart';
import '../../plugins/data/plugin_dto.dart';
import '../../settings/data/settings_providers.dart';
import '../../voice/ui/voice_settings_providers.dart';
import './gateway_vision_client.dart';
import './vram_gate.dart';
import './vision_client.dart';

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
/// Returns [GatewayVisionClient] when VRAM headroom is sufficient AND
/// the gateway has a vision-capable model installed AND [visionEnabledProvider]
/// is true. Returns [NoOpVisionClient] otherwise.
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

    // Resolve gateway + plugin credentials for vision.
    final settings = await ref.read(settingsProvider.future);
    final gatewayBase = BackendConfig.gatewayBase(
      effectiveHost(settings),
      environment: effectiveEnvironment(settings),
    ).toString().replaceAll(RegExp(r'/$'), '');
    final dio = ref.read(dioProvider);

    final auth = await ref.read(authCredentialsProvider.future);
    final pluginCreds = await ref.read(pluginCredentialsProvider.future);
    if (auth == null || pluginCreds.selectedModel == null) {
      return const NoOpVisionClient();
    }

    // Quick preflight: check the gateway models endpoint for a vision-capable
    // model installed by this user.
    final models = await _listGatewayModels(gatewayBase, dio, auth.apiKey);
    final visionModel = models.firstWhere(
      (m) => m.visionCapable && pluginCreds.plugins[m.id]?.enabled == true,
      orElse: () => models.where((m) => m.visionCapable).firstOrNull ?? _noVision,
    );
    if (visionModel == _noVision) return const NoOpVisionClient();

    final modelId = visionModel.id;
    final modelCreds = {modelId: {'apiKey': pluginCreds.plugins[modelId]?.credentials['apiKey'] ?? ''}};
    if (modelCreds[modelId]!['apiKey']!.trim().isEmpty) return const NoOpVisionClient();

    return GatewayVisionClient(
      gatewayBase: gatewayBase,
      dio: dio,
      gatewayKey: auth.apiKey.trim(),
      modelPluginId: modelId,
      credentials: modelCreds,
    );
  }

  static final _noVision = PluginModelDto.fromJson({
    'id': 'sentinel',
    'object': 'model',
    'created': 0,
    'owned_by': 'sentinel',
    'defaultModel': 'sentinel',
    'tokenLimit': 1,
    'visionCapable': false,
    'supportsStreaming': false,
    'parameters': {},
  });

  Future<List<PluginModelDto>> _listGatewayModels(
    String gatewayBase,
    Dio dio,
    String gatewayKey,
  ) async {
    try {
      final response = await dio.get(
        '$gatewayBase/v1/models',
        options: Options(
          headers: {'Authorization': 'Bearer $gatewayKey'},
          followRedirects: false,
          connectTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 5),
        ),
      );
      if (response.statusCode != 200) return const [];
      final data = response.data;
      if (data is! Map<String, dynamic>) return const [];
      final list = data['data'];
      if (list is! List) return const [];
      return list
          .whereType<Map<String, dynamic>>()
          .map((m) => PluginModelDto.fromJson(m))
          .where((dto) => dto.supportsStreaming)
          .toList();
    } catch (_) {
      return const [];
    }
  }
}