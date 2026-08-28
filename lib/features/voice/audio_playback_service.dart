// ignore_for_file: experimental_member_use, prefer_initializing_formals

import 'dart:async';
import 'dart:typed_data';

import 'package:just_audio/just_audio.dart';

import 'audio_session_manager.dart';
import 'wav_util.dart';

/// Default sample rate of the PCM audio played back by [AudioPlaybackService].
/// Matches the format used by the voice data channel (16 kHz mono 16-bit).
const int kPlaybackSampleRate = 16000;

/// Minimal playback surface consumed by higher layers (e.g. [VoiceController]).
///
/// Kept separate from [AudioPlaybackService] so orchestrators can accept a
/// lightweight fake in tests without bootstrapping a real audio player.
abstract interface class AudioPlayback {
  /// Whether audio is currently playing.
  Stream<bool> get isPlaying;

  /// Queues one PCM16 chunk (16 kHz mono) for gapless playback.
  Future<void> playAudio(List<int> pcm16bit);

  /// Stops playback, discards any buffered chunks, and releases audio focus.
  Future<void> stop();
}

/// Plays back AI TTS audio delivered as raw PCM16 chunks.
///
/// Chunks are queued onto a live [StreamAudioSource] wrapped in a WAV
/// container so the platform decoders can consume them, keeping playback
/// gapless across chunk boundaries. The audio session is owned and configured
/// by the shared [AudioSessionManager], which is also responsible for
/// acquiring/releasing audio focus on interruptions.
class AudioPlaybackService implements AudioPlayback {
  AudioPlaybackService({
    int sampleRate = kPlaybackSampleRate,
    AudioSessionManager? audioSession,
  }) : _sampleRate = sampleRate,
       _audioSession = audioSession {
    _isPlayingSubscription = _player.playerStateStream
        .map(
          (state) =>
              state.playing &&
              state.processingState != ProcessingState.idle &&
              state.processingState != ProcessingState.completed,
        )
        .distinct()
        .listen((playing) {
          if (_isPlayingController.isClosed) return;
          _isPlayingController.add(playing);
        });
  }

  final int _sampleRate;

  /// Optionally shares the session manager configured by the caller/scaffold.
  /// When null, focus is not driven by this service (the session manager or a
  /// capture pipeline owns focus acquisition).
  final AudioSessionManager? _audioSession;
  final AudioPlayer _player = AudioPlayer();
  final StreamController<bool> _isPlayingController =
      StreamController<bool>.broadcast();
  StreamSubscription<bool>? _isPlayingSubscription;

  /// Controller feeding PCM chunks into the currently-loaded [_LivePcmSource].
  StreamController<Uint8List>? _sourceController;

  /// Whether audio is currently playing.
  @override
  Stream<bool> get isPlaying => _isPlayingController.stream;

  /// Queues one PCM16 chunk (16 kHz mono) for gapless playback.
  ///
  /// The first call starts the player; subsequent calls are appended to the
  /// same continuous stream until [stop] is called.
  @override
  Future<void> playAudio(List<int> pcm16bit) async {
    final chunk = pcm16bit is Uint8List
        ? pcm16bit
        : Uint8List.fromList(pcm16bit);
    final controller = _sourceController;
    if (controller == null) {
      await _startPlayback(chunk);
    } else {
      controller.add(chunk);
    }
  }

  Future<void> _startPlayback(Uint8List firstChunk) async {
    // Ensure the shared session holds audio focus so the platform routes
    // playback through the voice-communication channel.
    await _audioSession?.requestAudioFocus();

    final controller = StreamController<Uint8List>();
    final source = _LivePcmSource(_sampleRate, controller.stream);
    _sourceController = controller;
    controller.add(firstChunk);

    await _player.setAudioSource(source);
    if (!_player.playing) {
      unawaited(_player.play());
    }
  }

  /// Stops playback, discards any buffered chunks, and releases audio focus
  /// previously acquired through the shared [AudioSessionManager].
  @override
  Future<void> stop() async {
    final controller = _sourceController;
    _sourceController = null;
    if (controller != null && !controller.isClosed) {
      // Signals end-of-stream to the player.
      await controller.close();
    }
    try {
      if (_player.processingState != ProcessingState.idle) {
        await _player.stop();
      }
    } catch (_) {
      // Best-effort stop.
    }
  }

  /// Releases all resources held by this service.
  Future<void> dispose() async {
    await _isPlayingSubscription?.cancel();
    _isPlayingSubscription = null;
    await stop();
    await _isPlayingController.close();
    await _player.dispose();
  }
}

/// A [StreamAudioSource] that wraps a live PCM16 stream in a WAV container.
///
/// Every request emits a minimal WAV header (16 kHz mono 16-bit PCM) followed
/// by the PCM bytes as they arrive from the controller, keeping the input
/// stream untouched until [stop] closes its controller.
class _LivePcmSource extends StreamAudioSource {
  _LivePcmSource(this._sampleRate, this._pcm);

  final int _sampleRate;
  final Stream<List<int>> _pcm;

  @override
  Future<StreamAudioResponse> request([int? start, int? end]) async {
    if (start != null) {
      // Live, non-seekable stream.
      throw StateError('Seeking is not supported by the live PCM source');
    }
    return StreamAudioResponse(
      contentLength: null,
      contentType: 'audio/wav',
      offset: null,
      rangeRequestsSupported: false,
      sourceLength: null,
      stream: () async* {
        // Streaming WAV: payload length unknown up front, so RIFF/data sizes
        // are written as unknown.
        yield wavHeaderForPcm16(
          sampleRate: _sampleRate,
          numChannels: 1,
          bitsPerSample: 16,
          dataLength: -1,
        );
        await for (final chunk in _pcm) {
          yield chunk is Uint8List ? chunk : Uint8List.fromList(chunk);
        }
      }(),
    );
  }
}
