import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/vision/data/vision_client.dart';

void main() {
  group(NoOpVisionClient, () {
    test('describeImage throws VisionUnavailableError', () async {
      const client = NoOpVisionClient();
      expect(
        () => client.describeImage(
          bytes: Uint8List(10),
          mimeType: 'image/png',
        ),
        throwsA(isA<VisionUnavailableError>()),
      );
    });
  });
}
