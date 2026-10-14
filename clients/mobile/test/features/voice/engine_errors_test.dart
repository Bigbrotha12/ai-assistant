import 'package:ai_assistant/features/voice/data/engine_errors.dart';
import 'package:flutter_test/flutter_test.dart';

/// Covers the sealed [EngineError] hierarchy: construction, message passing,
/// and exhaustive switching on every concrete subtype.
void main() {
  group('EngineError sealed hierarchy', () {
    test('base class is an Exception with a message', () {
      const e = EngineModelNotFoundError();
      expect(e, isA<Exception>());
      expect(e.message, 'Model not found');
    });

    test('toString includes runtime type and message', () {
      const e = EngineDownloadError('was here');
      expect(e.toString(), contains('EngineDownloadError'));
      expect(e.toString(), contains('was here'));
    });

    test('all concrete subtypes are exhaustively matchable', () {
      final errors = <EngineError>[
        const EngineModelNotFoundError(),
        const EngineModelLoadError('load'),
        const EngineInferenceError('infer'),
        const EngineDownloadError('down'),
      ];

      for (final e in errors) {
        final label = switch (e) {
          EngineModelNotFoundError() => 'missing',
          EngineModelLoadError() => 'load',
          EngineInferenceError() => 'infer',
          EngineDownloadError() => 'download',
        };
        expect(label, isNotEmpty);
        expect(e.message, isNotEmpty);
      }
    });

    test('default message passed through for each subtype', () {
      expect(const EngineModelNotFoundError().message, 'Model not found');

      // Non-empty default messages for the parameterised subtypes.
      expect(const EngineModelLoadError('m1').message, 'm1');
      expect(const EngineInferenceError('m2').message, 'm2');
      expect(const EngineDownloadError('m3').message, 'm3');
    });
  });
}
