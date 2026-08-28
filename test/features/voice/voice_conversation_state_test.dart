import 'package:ai_assistant/features/voice/voice_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('VoiceConversationState', () {
    test('initial() reflects a fresh idle session', () {
      final s = VoiceConversationState.initial();
      expect(s.isConnected, isFalse);
      expect(s.isRecording, isFalse);
      expect(s.isAiSpeaking, isFalse);
      expect(s.isPaused, isFalse);
      expect(s.currentRoomName, isNull);
      expect(s.error, isNull);
      expect(s.lastTranscript, isNull);
      expect(s.onDeviceTranscript, isNull);
    });

    test('copyWith updates only the provided fields', () {
      final s = VoiceConversationState.initial();
      final next = s.copyWith(
        isConnected: true,
        currentRoomName: 'room-a',
        isRecording: true,
        isAiSpeaking: true,
        isPaused: true,
        error: 'boom',
        lastTranscript: 'hello',
        onDeviceTranscript: 'hello',
      );

      expect(next.isConnected, isTrue);
      expect(next.currentRoomName, 'room-a');
      expect(next.isRecording, isTrue);
      expect(next.isAiSpeaking, isTrue);
      expect(next.isPaused, isTrue);
      expect(next.error, 'boom');
      expect(next.lastTranscript, 'hello');
      expect(next.onDeviceTranscript, 'hello');
    });

    test('copyWith leaves unset fields untouched', () {
      final s = VoiceConversationState.initial().copyWith(error: 'boom');
      final next = s.copyWith(isConnected: true);
      expect(next.error, 'boom');
      expect(next.isConnected, isTrue);
      expect(next.isRecording, isFalse);
      expect(next.isPaused, isFalse);
    });

    test('copyWith can clear nullable fields back to null', () {
      final s = VoiceConversationState.initial().copyWith(
        currentRoomName: 'room',
        error: 'boom',
        lastTranscript: 't',
        onDeviceTranscript: 'd',
      );
      final cleared = s.copyWith(
        currentRoomName: null,
        error: null,
        lastTranscript: null,
        onDeviceTranscript: null,
      );
      expect(cleared.currentRoomName, isNull);
      expect(cleared.error, isNull);
      expect(cleared.lastTranscript, isNull);
      expect(cleared.onDeviceTranscript, isNull);
    });

    test('equality reflects every field including isPaused', () {
      final a = VoiceConversationState.initial().copyWith(isPaused: true);
      final b = VoiceConversationState.initial().copyWith(isPaused: true);
      final c = VoiceConversationState.initial().copyWith(isPaused: false);

      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a, isNot(c));
      expect(a.hashCode, isNot(c.hashCode));
    });

    test('distinct field values produce distinct states', () {
      final base = VoiceConversationState.initial();
      final variants = [
        base.copyWith(isConnected: true),
        base.copyWith(isRecording: true),
        base.copyWith(isAiSpeaking: true),
        base.copyWith(isPaused: true),
        base.copyWith(error: 'x'),
        base.copyWith(lastTranscript: 'x'),
        base.copyWith(onDeviceTranscript: 'x'),
        base.copyWith(currentRoomName: 'r'),
      ];
      for (final v in variants) {
        expect(v, isNot(base));
        expect(v.hashCode, isNot(base.hashCode));
      }
    });
  });
}
