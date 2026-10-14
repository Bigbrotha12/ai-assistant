import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/engine_config.dart';
import 'package:ai_assistant/features/voice/data/engine_manager.dart';

const _pathProviderChannel = MethodChannel('plugins.flutter.io/path_provider');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tempDir;
  late Directory modelDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('engine_manager_test_');
    modelDir = Directory('${tempDir.path}/.voice_models');
    // The manager resolves paths via path_provider; serve the app documents
    // dir from a temp dir so no platform channel is hit.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          _pathProviderChannel,
          (call) async => tempDir.path,
        );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_pathProviderChannel, null);
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  test('deleteModel removes the model files and resets its status', () async {
    modelDir.createSync(recursive: true);
    final whisperFile = File('${modelDir.path}/ggml-tiny.bin');
    final supertonicFile = File(
      '${modelDir.path}/${EngineConfig.supertonic3ModelDir}/voice.bin',
    );
    whisperFile.createSync(recursive: true);
    supertonicFile.createSync(recursive: true);

    final manager = EngineManager();
    addTearDown(manager.dispose);

    // Both models are present.
    expect(whisperFile.existsSync(), isTrue);
    expect(supertonicFile.existsSync(), isTrue);

    final deleted = await manager.deleteModel(EngineConfig.whisperTinyId);
    expect(deleted, isTrue);

    // Whisper is gone and reset to notStarted; Supertonic is untouched.
    expect(whisperFile.existsSync(), isFalse);
    expect(supertonicFile.existsSync(), isTrue);
    expect(
      manager.getStatus(EngineConfig.whisperTinyId),
      VoiceEngineStatus.notStarted,
    );
  });

  test(
    'deleteModel also clears part files and unknown ids are refused',
    () async {
      modelDir.createSync(recursive: true);
      final whisperPart = File('${modelDir.path}/ggml-tiny.bin.part');
      whisperPart.createSync(recursive: true);

      final manager = EngineManager();
      addTearDown(manager.dispose);

      expect(await manager.deleteModel(EngineConfig.whisperTinyId), isTrue);
      expect(whisperPart.existsSync(), isFalse);

      expect(await manager.deleteModel('does-not-exist'), isFalse);
      expect(
        manager.getStatus(EngineConfig.supertonic3Id),
        isNot(VoiceEngineStatus.ready),
      );
    },
  );
}
