import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../core/config.dart';

/// Data-channel topic that carries audio frames (PCM16, 16 kHz mono) in both
/// directions: client → AI (mic) and AI → client (TTS).
const String kLiveKitAudioTopic = 'voice-audio';

/// Data-channel topic that carries text control messages (JSON envelopes).
const String kLiveKitControlTopic = 'voice-control';

/// Events emitted by [LiveKitService] during a voice conversation.
enum VoiceConversationEvent {
  /// The user's microphone audio is being sent over the data channel.
  recording,

  /// The AI's TTS audio is being received over the data channel.
  aiSpeaking,

  /// No audio activity — the session is idle.
  idle,

  /// The session was torn down (server-initiated disconnect or local
  /// teardown). Consumers must clear their connected state on this event.
  disconnected,
}

/// Service that manages a LiveKit data-channel–only voice session.
///
/// Connects to a LiveKit room with a JWT and exchanges audio over the
/// built-in data channel. No media tracks (microphone / speaker) are used —
/// audio flows as raw PCM16 frames over the data channel (media-free mode).
abstract interface class LiveKitService {
  /// Connects to [roomName] using [token].
  ///
  /// Terminates any previous connection first, so repeated calls are safe.
  /// Throws if the signaling or room join fails.
  Future<void> connect({required String roomName, required String token});

  /// Disconnects from the current room (no-op when not connected).
  Future<void> disconnect();

  /// Whether the signaling connection is established.
  bool get isConnected;

  /// The joined room name, or null when not connected.
  String? get currentRoomName;

  /// Sends one PCM16 audio frame (16 kHz mono) to the AI.
  ///
  /// Throws a [StateError] when the data channel is not available.
  Future<void> sendAudioData(List<int> pcm16bit);

  /// Stream of PCM16 audio frames received from the AI (TTS output).
  Stream<List<int>> get audioDataReceived;

  /// Stream of transcript text echoed back by the server once it recognises
  /// voice from the client (emitted only when the server supports STT).
  Stream<String> get transcriptsReceived;

  /// Stream of high-level conversation events.
  Stream<VoiceConversationEvent> get events;
}

/// Concrete implementation backed by the [livekit_client] SDK.
class LiveKitServiceImpl implements LiveKitService {
  LiveKitServiceImpl({required this.host});

  /// Backend host (signaling port is derived via [BackendConfig.liveKitWs]).
  final String host;

  Room? _room;
  EventsListener<RoomEvent>? _roomListener;
  String? _currentRoomName;

  final StreamController<List<int>> _audioReceivedController =
      StreamController<List<int>>.broadcast();
  final StreamController<String> _transcriptsController =
      StreamController<String>.broadcast();
  final StreamController<VoiceConversationEvent> _eventsController =
      StreamController<VoiceConversationEvent>.broadcast();

  /// Debounce for returning to [VoiceConversationEvent.idle] after the last
  /// audio packet, so the UI shows a live "speaking" state during a burst.
  Timer? _idleTimer;

  /// Period of silence that resets the conversation event to idle.
  static const Duration _idleTimeout = Duration(milliseconds: 700);

  @override
  bool get isConnected => _room?.connectionState == ConnectionState.connected;

  @override
  String? get currentRoomName => _currentRoomName;

  @override
  Stream<List<int>> get audioDataReceived => _audioReceivedController.stream;

  @override
  Stream<String> get transcriptsReceived => _transcriptsController.stream;

  @override
  Stream<VoiceConversationEvent> get events => _eventsController.stream;

  @override
  Future<void> connect({
    required String roomName,
    required String token,
  }) async {
    await disconnect();
    _currentRoomName = roomName;

    final room = Room();
    _room = room;
    _roomListener = room.createListener();
    _setUpRoomListener(room, _roomListener!);

    try {
      await room.connect(
        BackendConfig.liveKitWs(host).toString(),
        token,
        connectOptions: const ConnectOptions(autoSubscribe: false),
      );
      _emitIdle();
      if (kDebugMode) {
        debugPrint('LiveKit connected to room: $roomName');
      }
    } catch (e) {
      _currentRoomName = null;
      await _disposeRoom();
      if (kDebugMode) {
        debugPrint('LiveKit connect failed: $e');
      }
      rethrow;
    }
  }

  /// Wires the room's low-level events onto the service's public streams.
  void _setUpRoomListener(Room room, EventsListener<RoomEvent> listener) {
    listener
      ..on<RoomConnectedEvent>((_) => _emitIdle())
      ..on<RoomDisconnectedEvent>((_) {
        _currentRoomName = null;
        _emitIdle();
        // Notify consumers (the VoiceController) so a server-initiated drop
        // clears their `isConnected` state instead of stranding it true.
        _emitDisconnected();
      })
      ..on<RoomReconnectedEvent>((_) => _emitIdle())
      ..on<DataReceivedEvent>(_onDataReceived);
  }

  void _onDataReceived(DataReceivedEvent event) {
    if (event.data.isEmpty) return;
    if (event.topic == kLiveKitAudioTopic) {
      _audioReceivedController.add(List<int>.from(event.data));
      _markActivity(VoiceConversationEvent.aiSpeaking);
      return;
    }
    _onControlMessage(event.data);
  }

  /// Decodes a control message from the wire. Unknown envelopes are ignored
  /// (forward compatible); a malformed frame is dropped, never fatal.
  void _onControlMessage(List<int> bytes) {
    final Object? decoded;
    try {
      decoded = jsonDecode(utf8.decode(bytes));
    } catch (_) {
      return;
    }
    if (decoded is! Map<String, dynamic>) return;

    if (decoded['type'] != 'transcript') return;
    final payload = decoded['payload'];
    final text = payload is Map<String, dynamic> ? payload['text'] : null;
    if (text is String && text.isNotEmpty) {
      _transcriptsController.add(text);
    }
  }

  Future<void> _disposeRoom() async {
    final room = _room;
    _room = null;
    final listener = _roomListener;
    _roomListener = null;
    try {
      await listener?.dispose();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('LiveKit listener dispose failed: $e');
      }
    }
    try {
      await room?.dispose();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('LiveKit room dispose failed: $e');
      }
    }
  }

  @override
  Future<void> sendAudioData(List<int> pcm16bit) async {
    final participant = _room?.localParticipant;
    if (!isConnected || participant == null) {
      throw StateError('LiveKit data channel is not connected');
    }
    try {
      // Lossy data channel: 20ms frames tolerate packet loss far better than
      // retransmission latency.
      await participant.publishData(
        pcm16bit,
        reliable: false,
        topic: kLiveKitAudioTopic,
      );
      _markActivity(VoiceConversationEvent.recording);
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Failed to send audio data: $e');
      }
      rethrow;
    }
  }

  @override
  Future<void> disconnect() async {
    _idleTimer?.cancel();
    _idleTimer = null;
    final room = _room;
    _room = null;
    _currentRoomName = null;
    if (room != null) {
      try {
        if (room.connectionState != ConnectionState.disconnected) {
          await room.disconnect();
        }
      } catch (e) {
        if (kDebugMode) {
          debugPrint('LiveKit disconnect failed: $e');
        }
      }
    }
    await _disposeRoom();
    _emitIdle();
  }

  /// Emits [event] and schedules a debounced return to idle, so the UI
  /// reflects live recording / AI-speaking bursts accurately.
  void _markActivity(VoiceConversationEvent event) {
    _idleTimer?.cancel();
    if (!_eventsController.isClosed) {
      _eventsController.add(event);
    }
    _idleTimer = Timer(_idleTimeout, () => _emitIdle());
  }

  void _emitIdle() {
    _idleTimer?.cancel();
    _idleTimer = null;
    if (!_eventsController.isClosed) {
      _eventsController.add(VoiceConversationEvent.idle);
    }
  }

  void _emitDisconnected() {
    _idleTimer?.cancel();
    _idleTimer = null;
    if (!_eventsController.isClosed) {
      _eventsController.add(VoiceConversationEvent.disconnected);
    }
  }

  /// Releases every resource owned by this service. No-op after disposal.
  Future<void> dispose() async {
    _idleTimer?.cancel();
    _idleTimer = null;
    await disconnect();
    await _audioReceivedController.close();
    await _transcriptsController.close();
    await _eventsController.close();
  }
}

/// Mint a LiveKit JWT from the token-mint endpoint.
///
/// The token-mint service ([BackendConfig.tokenMint]) exchanges a shared
/// secret for a short-lived JWT valid for [roomName].
Future<String> mintToken({
  required String host,
  required String roomName,
  required String secret,
  Dio? dio,
}) async {
  final client = dio ?? Dio();
  try {
    final resp = await client.postUri(
      BackendConfig.tokenMintToken(host),
      data: {
        'identity': 'voice-assistant',
        'room': roomName,
        'name': 'Voice Assistant',
      },
      options: Options(
        headers: {'Authorization': 'Bearer $secret'},
        // The bearer secret must never be replayed to a redirect target on
        // another origin.
        followRedirects: false,
      ),
    );

    if (resp.statusCode == 200) {
      final data = resp.data;
      if (data is Map<String, dynamic>) {
        final token = data['token'] as String?;
        if (token != null && token.isNotEmpty) {
          return token;
        }
      }
    }
    throw Exception(
      'Token mint returned unexpected response: HTTP ${resp.statusCode}',
    );
  } catch (e) {
    if (kDebugMode) {
      debugPrint('Token mint failed: $e');
    }
    rethrow;
  }
}
