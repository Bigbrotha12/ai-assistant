import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/core/http/dio_provider.dart';
import 'package:ai_assistant/features/vision/data/vision_client.dart';
import 'package:ai_assistant/features/vision/data/vision_config.dart';
import 'package:ai_assistant/features/vision/data/vision_provider.dart';
import 'package:ai_assistant/features/vision/data/vram_gate.dart';
import 'package:ai_assistant/features/voice/ui/voice_settings_providers.dart';

import '../voice/voice_test_fakes.dart';

/// Scripted [HttpClientAdapter] for the vision-provider preflight probe.
class _ModelsAdapter implements HttpClientAdapter {
  _ModelsAdapter({this.statusCode = 200});

  final int statusCode;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final body = jsonEncode({
      'data': [
        {'id': kVisionModelRoute, 'capabilities': {'vision': true}},
      ],
    });
    return ResponseBody.fromString(
      body,
      statusCode,
      headers: const {'content-type': ['application/json']},
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('VisionClientNotifier', () {
    test(
        'preflight /v1/models carries the bearer key and the client is wired '
        'with it', () async {
      final adapter = _ModelsAdapter();
      final container = ProviderContainer(
        overrides: [
          vramGateProvider.overrideWithValue(const NoOpVRAMGate()),
          voiceSettingsStoreProvider.overrideWithValue(
            FakeVoiceSettingsStore(),
          ),
          inferenceConfigProvider.overrideWithValue(
            const (
              baseUrl: 'https://librechat.test/api/agents/v1',
              model: 'agent_1',
              apiKey: 'sk-test123',
            ),
          ),
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
        ],
      );
      addTearDown(container.dispose);

      final client = await container.read(visionClientProvider.future);

      // The preflight must have been authorized — an unauthenticated probe
      // would 401 and silently disable vision via NoOpVisionClient.
      expect(adapter.requests, hasLength(1));
      final preflight = adapter.requests.single;
      expect(preflight.path, endsWith('/v1/models'));
      expect(preflight.headers['Authorization'], 'Bearer sk-test123');

      // And the real client is returned with the same key for describeImage.
      expect(client, isA<VisionApiClient>());
      expect((client as VisionApiClient).apiKey, 'sk-test123');
    });

    test('falls back to NoOpVisionClient when the models probe 401s',
        () async {
      final adapter = _ModelsAdapter(statusCode: 401);
      final container = ProviderContainer(
        overrides: [
          vramGateProvider.overrideWithValue(const NoOpVRAMGate()),
          voiceSettingsStoreProvider.overrideWithValue(
            FakeVoiceSettingsStore(),
          ),
          inferenceConfigProvider.overrideWithValue(
            const (
              baseUrl: 'https://librechat.test/api/agents/v1',
              model: 'agent_1',
              apiKey: 'sk-test123',
            ),
          ),
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
        ],
      );
      addTearDown(container.dispose);

      final client = await container.read(visionClientProvider.future);

      expect(client, isA<NoOpVisionClient>());
      // The probe still sent the key (the 401 is the server rejecting it).
      expect(adapter.requests, hasLength(1));
      expect(
        adapter.requests.single.headers['Authorization'],
        'Bearer sk-test123',
      );
    });

    test('falls back to NoOpVisionClient when inference is unconfigured',
        () async {
      final adapter = _ModelsAdapter();
      final container = ProviderContainer(
        overrides: [
          vramGateProvider.overrideWithValue(const NoOpVRAMGate()),
          voiceSettingsStoreProvider.overrideWithValue(
            FakeVoiceSettingsStore(),
          ),
          // Defaults (blank LLM_* define in a test build): no backend.
          dioProvider.overrideWithValue(Dio()..httpClientAdapter = adapter),
        ],
      );
      addTearDown(container.dispose);

      final client = await container.read(visionClientProvider.future);

      expect(client, isA<NoOpVisionClient>());
      expect(adapter.requests, isEmpty);
    });
  });
}