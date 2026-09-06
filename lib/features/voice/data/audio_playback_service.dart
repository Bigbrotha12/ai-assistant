// ignore_for_file: experimental_member_use, prefer_initializing_formals

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';

import './audio_session_manager.dart';
import './wav_util.dart';

/// Default sample rate of the PCM audio played back by [AudioPlaybackService].
/// Matches the format used by the voice conversation (16 kHz mono 16-bit).
const int kPlaybackSampleRate = 16000;

/// Minimal playback surface consumed by higher layers (e.g. [VoiceController]).
///
/// Kept separate from [AudioPlaybackService] so orchestrators can accept a
/// lightweight fake in tests without bootstrapping a real audio player.
abstract interface class AudioPlayback {
  /// Whether audio is currently playing.
  Stream<bool> get isPlaying;

  /// Playback failures (player and source errors), so orchestrators can
  /// surface them in the conversation state instead of failing silently.
  Stream<Object> get errors;

  /// Plays one utterance of PCM16 samples (16 kHz mono), replacing any
  /// currently playing audio.
  Future<void> playAudio(List<int> pcm16Samples);

  /// Stops playback.
  Future<void> stop();
}

/// Plays back AI TTS audio delivered as PCM16 sample utterances.
///
/// Each utterance is wrapped in a finite WAV container ([_BytesAudioSource])
/// that the platform decoders consume with byte-range support. The audio
/// session is owned and configured by the shared [AudioSessionManager].
class AudioPlaybackService implements AudioPlayback {
  AudioPlaybackService({
    int sampleRate = kPlaybackSampleRate,
    AudioSessionManager? audioSession,
  }) : _audioSession = audioSession,
       _source = _BytesAudioSource(sampleRate: sampleRate) {
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
    // Always subscribed: a playback failure must be observable by callers
    // (routed into the conversation state), not just in debug logs.
    _errorSubscription = _player.errorStream.listen((e) {
      final error = '(${e.code}) ${e.message}';
      if (_errorsController.isClosed) return;
      _errorsController.add(error);
      if (kDebugMode) {
        debugPrint('AudioPlayback: player error $error');
      }
    });
  }

  /// Optionally shares the session manager configured by the caller/scaffold.
  /// When null, focus is not driven by this service (the session manager or a
  /// capture pipeline owns focus acquisition).
  final AudioSessionManager? _audioSession;

  /// Interruption handling is fully owned by [AudioSessionManager] + the
  /// capture pipeline. just_audio's built-in handlers are disabled: they
  /// auto-resume playback on pause-type interruption ends (racing the app's
  /// own pause), activate the audio session on every `play()` (a third focus
  /// owner), and ignore duck semantics the app treats as a full pause.
  final AudioPlayer _player = AudioPlayer(
    handleInterruptions: false,
    handleAudioSessionActivation: false,
  );
  final StreamController<bool> _isPlayingController =
      StreamController<bool>.broadcast();
  final StreamController<Object> _errorsController =
      StreamController<Object>.broadcast();
  StreamSubscription<bool>? _isPlayingSubscription;
  StreamSubscription<PlayerException>? _errorSubscription;

  /// Reused source: just_audio's proxy registers a handler per source id and
  /// never removes it, so a fresh source per utterance would pin every WAV in
  /// memory for the app's lifetime. One instance with swapped bytes keeps the
  /// proxy map at a single entry.
  final _BytesAudioSource _source;

  /// Bumped on every [stop]; a play whose source load spans a [stop] must
  /// not start playing the "cancelled" utterance once the load completes.
  int _generation = 0;

  /// Whether audio is currently playing.
  @override
  Stream<bool> get isPlaying => _isPlayingController.stream;

  /// Playback failures surfaced for orchestrators.
  @override
  Stream<Object> get errors => _errorsController.stream;

  /// Plays one utterance of PCM16 samples (16 kHz mono).
  ///
  /// Each call replaces the current audio. Chunks arrive complete (the on-device
  /// TTS engine synthesises a whole reply before handing it over), so serving
  /// a finite WAV is both simpler and robust: just_audio's proxy requires a
  /// known `contentLength` whenever a response carries an `offset`, and an
  /// unknown-length live stream makes the platform player reopen the source
  /// mid-playback (the source of hard-to-diagnose "Source error" failures).
  @override
  Future<void> playAudio(List<int> pcm16Samples) async {
    // Ensure the shared session holds audio focus so the platform routes
    // playback to the configured output (media stream → speaker).
    await _audioSession?.requestAudioFocus();

    final generation = _generation;
    _source.updateWav(pcm16SamplesToLeBytes(pcm16Samples));
    try {
      await _player.setAudioSource(_source);
    } catch (e) {
      // The errorStream listener is the single failure reporter (it also
      // fires for this failure); rethrowing would report twice. Emit a false
      // so a caller awaiting the playback-end edge is not stranded until its
      // timeout — no true was ever emitted for this utterance.
      if (!_isPlayingController.isClosed) {
        _isPlayingController.add(false);
      }
      return;
    }
    // A stop() during the load window invalidated this utterance: the user
    // cancelled it before it became audible — do not start it now.
    if (generation != _generation) {
      if (!_isPlayingController.isClosed) {
        _isPlayingController.add(false);
      }
      return;
    }
    if (!_player.playing) {
      unawaited(
        _player.play().catchError((Object e) {
          if (kDebugMode) {
            debugPrint('AudioPlayback: play() failed: $e');
          }
        }),
      );
    }
  }

  /// Stops playback. Audio focus is owned by the shared [AudioSessionManager]
  /// (acquired/released by the capture pipeline and playback owners), so this
  /// only halts the player — and invalidates any load still in flight.
  @override
  Future<void> stop() async {
    _generation++;
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
    await _errorSubscription?.cancel();
    _errorSubscription = null;
    await _isPlayingSubscription?.cancel();
    _isPlayingSubscription = null;
    await stop();
    await _errorsController.close();
    await _isPlayingController.close();
    await _player.dispose();
  }
}

/// A [StreamAudioSource] serving a complete PCM16 payload as a finite WAV.
///
/// One instance is reused for every utterance ([updateWav] swaps the payload
/// before each `setAudioSource`): just_audio's proxy keys handlers by source
/// id with no removal API, so fresh sources per utterance would pin every
/// WAV in memory.
///
/// The response honours byte-range requests with a known `contentLength` —
/// just_audio's proxy builds the 206 `Content-Range` from `offset` and
/// `contentLength`, so `offset` is always reported (the 206 branch only
/// engages when the player actually sent a Range header; a plain open gets a
/// correct 200).
class _BytesAudioSource extends StreamAudioSource {
  _BytesAudioSource({required int sampleRate})
    : _sampleRate = sampleRate,
      _wav = Uint8List(0);

  final int _sampleRate;

  /// Complete WAV file (44-byte header + PCM payload).
  Uint8List _wav;

  /// Replaces the payload for the next playback. Must be called before the
  /// player loads the source; a response already streaming reads the byte
  /// list it snapshotted at request time.
  void updateWav(Uint8List pcm) {
    _wav = Uint8List.fromList([
      ...wavHeaderForPcm16(
        sampleRate: _sampleRate,
        numChannels: 1,
        bitsPerSample: 16,
        dataLength: pcm.length,
      ),
      ...pcm,
    ]);
  }

  @override
  Future<StreamAudioResponse> request([int? start, int? end]) async {
    final offset = (start ?? 0).clamp(0, _wav.length);
    final endExclusive = (end ?? _wav.length).clamp(offset, _wav.length);
    final length = endExclusive - offset;

    return StreamAudioResponse(
      contentLength: length,
      contentType: 'audio/wav',
      offset: offset,
      rangeRequestsSupported: true,
      sourceLength: _wav.length,
      stream: Stream<List<int>>.value(
        length == _wav.length
            ? _wav
            : Uint8List.sublistView(_wav, offset, endExclusive),
      ),
    );
  }
}
