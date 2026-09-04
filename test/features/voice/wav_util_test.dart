import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/wav_util.dart';

void main() {
  group('wavHeaderForPcm16', () {
    test('writes a 44-byte PCM header with expected fields', () {
      final header = wavHeaderForPcm16(
        sampleRate: 16000,
        numChannels: 1,
        bitsPerSample: 16,
        dataLength: 320,
      );

      expect(header, isA<Uint8List>());
      expect(header.length, 44);
      final view = ByteData.view(header.buffer);
      // 'RIFF'
      expect(String.fromCharCodes(header.sublist(0, 4)), 'RIFF');
      // riffSize = 36 + dataLength
      expect(view.getUint32(4, Endian.little), 36 + 320);
      expect(String.fromCharCodes(header.sublist(8, 12)), 'WAVE');
      expect(String.fromCharCodes(header.sublist(12, 16)), 'fmt ');
      expect(view.getUint32(16, Endian.little), 16); // fmt chunk size
      expect(view.getUint16(20, Endian.little), 1); // PCM
      expect(view.getUint16(22, Endian.little), 1); // mono
      expect(view.getUint32(24, Endian.little), 16000);
      // byteRate = 16000 * 1 * 2
      expect(view.getUint32(28, Endian.little), 32000);
      expect(view.getUint16(32, Endian.little), 2); // block align
      expect(view.getUint16(34, Endian.little), 16); // bits per sample
      expect(String.fromCharCodes(header.sublist(36, 40)), 'data');
      expect(view.getUint32(40, Endian.little), 320);
    });

    test('marks unknown sizes for streaming when dataLength is negative', () {
      final header = wavHeaderForPcm16(
        sampleRate: 16000,
        numChannels: 1,
        bitsPerSample: 16,
        dataLength: -1,
      );

      final view = ByteData.view(header.buffer);
      expect(view.getUint32(4, Endian.little), 0xFFFFFFFF);
      expect(view.getUint32(40, Endian.little), 0xFFFFFFFF);
    });
  });

  group('pcm16ToWav', () {
    test('wraps samples in header + little-endian bytes', () {
      final wav = pcm16ToWav(
        [0x0001, 0x8000, -1],
        sampleRate: 16000,
      );

      expect(wav.length, 44 + 3 * 2);
      final view = ByteData.view(wav.buffer);
      // data chunk length
      expect(view.getUint32(40, Endian.little), 6);
      // samples, little-endian signed
      expect(ByteData.view(wav.buffer, 44).getInt16(0, Endian.little), 1);
      expect(
        ByteData.view(wav.buffer, 44).getUint16(2, Endian.little),
        0x8000,
      );
      expect(ByteData.view(wav.buffer, 44).getInt16(4, Endian.little), -1);
    });
  });

  group('pcm16SamplesToLeBytes', () {
    test('packs signed samples as little-endian byte pairs', () {
      final bytes = pcm16SamplesToLeBytes(const [0, 1, -1, 32767, -32768]);
      expect(bytes, [0, 0, 1, 0, 0xFF, 0xFF, 0xFF, 0x7F, 0x00, 0x80]);
    });

    test('round-trips through signed 16-bit reads', () {
      const samples = [0, 1, -1, 256, -256, 32767, -32768, 12345, -12345];
      final bytes = pcm16SamplesToLeBytes(samples);
      final view = ByteData.view(bytes.buffer);
      for (var i = 0; i < samples.length; i++) {
        expect(view.getInt16(i * 2, Endian.little), samples[i]);
      }
    });

    test('payload matches pcm16ToWav data chunk size for the same samples', () {
      const samples = [100, -100, 1234];
      expect(
        pcm16SamplesToLeBytes(samples).length,
        // PCM payload length for the same samples (2 bytes per sample).
        pcm16ToWav(samples, sampleRate: 16000).length - 44,
      );
    });

    test('does not truncate negative samples to their low byte', () {
      // Regression guard: Uint8List.fromList(samples) would turn -1 into 255.
      final bytes = pcm16SamplesToLeBytes(const [-1]);
      expect(bytes, [0xFF, 0xFF]);
    });
  });
}