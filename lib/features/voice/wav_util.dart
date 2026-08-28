import 'dart:typed_data';

/// Builds a standard 44-byte PCM WAV header for 16-bit samples.
///
/// [dataLength] is the byte count of the PCM payload that follows the header.
/// Pass a negative value (e.g. `-1`) when the payload length is not known up
/// front (streaming): RIFF/data sizes are then written as `0xFFFFFFFF`, which
/// platforms decode as a streaming WAV.
Uint8List wavHeaderForPcm16({
  required int sampleRate,
  required int numChannels,
  required int bitsPerSample,
  required int dataLength,
}) {
  const headerSize = 44;
  final blockAlign = numChannels * (bitsPerSample ~/ 8);
  final byteRate = sampleRate * blockAlign;
  final unknown = dataLength < 0;
  final riffSize = unknown ? 0xFFFFFFFF : headerSize + dataLength - 8;

  final header = Uint8List(44);
  final view = ByteData.view(header.buffer);

  _writeAscii(view, 0, 'RIFF');
  view.setUint32(4, riffSize, Endian.little);
  _writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk
  _writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, Endian.little); // sub-chunk size
  view.setUint16(20, 1, Endian.little); // PCM format
  view.setUint16(22, numChannels, Endian.little);
  view.setUint32(24, sampleRate, Endian.little);
  view.setUint32(28, byteRate, Endian.little);
  view.setUint16(32, blockAlign, Endian.little);
  view.setUint16(34, bitsPerSample, Endian.little);

  // data sub-chunk
  _writeAscii(view, 36, 'data');
  view.setUint32(40, unknown ? 0xFFFFFFFF : dataLength, Endian.little);
  return header;
}

/// Wraps [samples] (16-bit signed PCM) in a complete WAV file.
///
/// Convenience for callers that need a whole file on disk (e.g. STT engines
/// that read a WAV path): header + little-endian sample bytes.
Uint8List pcm16ToWav(
  List<int> samples, {
  required int sampleRate,
  int numChannels = 1,
  int bitsPerSample = 16,
}) {
  final bytesPerSample = bitsPerSample ~/ 8;
  final dataSize = samples.length * bytesPerSample;
  final wav = Uint8List(44 + dataSize);
  wav.setRange(
    0,
    44,
    wavHeaderForPcm16(
      sampleRate: sampleRate,
      numChannels: numChannels,
      bitsPerSample: bitsPerSample,
      dataLength: dataSize,
    ),
  );
  final view = ByteData.view(wav.buffer);
  for (var i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * bytesPerSample, samples[i], Endian.little);
  }
  return wav;
}

void _writeAscii(ByteData view, int offset, String value) {
  for (var i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.codeUnitAt(i));
  }
}