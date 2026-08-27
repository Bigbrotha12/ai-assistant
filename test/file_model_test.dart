import 'dart:convert';

import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('FileInfo', () {
    test('fromJson/toJson round-trip', () {
      final info = FileInfo(
        id: 'abc-123',
        filename: 'photo.jpg',
        sizeBytes: 1024,
        mimeType: 'image/jpeg',
        uploadedAt: DateTime.utc(2026, 8, 27),
        cachedAt: DateTime.utc(2026, 8, 27, 12),
        localPath: 'cache/abc-123.jpg',
      );
      final restored = FileInfo.fromJson(info.toJson());
      expect(restored, info);
    });

    test('round-trip with only required fields', () {
      final info = FileInfo(
        id: 'id',
        filename: 'f.png',
        sizeBytes: 5,
        mimeType: 'image/png',
      );
      final restored = FileInfo.fromJson(info.toJson());
      expect(restored, info);
      expect(restored.uploadedAt, isNull);
      expect(restored.cachedAt, isNull);
      expect(restored.localPath, isNull);
    });

    test('deserializes a JSON map produced manually', () {
      final json = jsonDecode(
        '{"id":"x","filename":"a.webp","sizeBytes":10,"mimeType":"image/webp"}',
      );
      final info = FileInfo.fromJson(json as Map<String, dynamic>);
      expect(info.id, 'x');
      expect(info.filename, 'a.webp');
      expect(info.sizeBytes, 10);
      expect(info.mimeType, 'image/webp');
    });
  });

  group('sanitizeFilename', () {
    test('strips path separators and control characters', () {
      expect(sanitizeFilename('a/b\\c\u0000d\u0001'), 'a_b_cd');
    });

    test('truncates to 128 characters', () {
      final long = 'x' * 300;
      expect(sanitizeFilename(long).length, 128);
    });

    test('replaces spaces with underscores', () {
      expect(sanitizeFilename('my photo file'), 'my_photo_file');
    });

    test('appends extension from mimeType when missing', () {
      expect(sanitizeFilename('photo', mimeType: 'image/jpeg'), 'photo.jpg');
    });

    test('does not duplicate an existing extension', () {
      expect(sanitizeFilename('photo.jpg', mimeType: 'image/jpeg'), 'photo.jpg');
    });

    test('falls back to a safe default for an empty name', () {
      expect(sanitizeFilename(''), 'file');
      expect(sanitizeFilename('   '), 'file');
      expect(
        sanitizeFilename('', mimeType: 'image/png'),
        'file.png',
      );
    });
  });

  group('UploadJobStatus', () {
    test('copyWith overrides only provided fields', () {
      const status = UploadJobStatus(
        jobId: 'j1',
        status: UploadStatus.pending,
        progress: 0.0,
      );
      final updated = status.copyWith(
        status: UploadStatus.done,
        serverFileId: 'f1',
      );
      expect(updated.jobId, 'j1');
      expect(updated.status, UploadStatus.done);
      expect(updated.progress, 0.0);
      expect(updated.serverFileId, 'f1');
      expect(updated.error, isNull);
    });
  });
}
