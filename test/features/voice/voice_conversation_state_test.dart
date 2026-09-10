import 'package:ai_assistant/features/voice/ui/voice_conversation_state.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('VoiceConversationState', () {
    test('initial() reflects a fresh idle session', () {
      final s = VoiceConversationState.initial();
      expect(s.isConnected, isFalse);
      expect(s.isRecording, isFalse);
      expect(s.isAiSpeaking, isFalse);
      expect(s.isSpeaking, isFalse);
      expect(s.isPaused, isFalse);
      expect(s.isGenerating, isFalse);
      expect(s.error, isNull);
      expect(s.notice, isNull);
      expect(s.lastTranscript, isNull);
      expect(s.onDeviceTranscript, isNull);
    });

    test('copyWith updates only the provided fields', () {
      final s = VoiceConversationState.initial();
      final next = s.copyWith(
        isConnected: true,
        isRecording: true,
        isAiSpeaking: true,
        isSpeaking: true,
        isPaused: true,
        isGenerating: true,
        error: 'boom',
        notice: 'heads up',
        status: 'Thinking…',
        lastTranscript: 'hello',
        onDeviceTranscript: 'hello',
      );

      expect(next.isConnected, isTrue);
      expect(next.isRecording, isTrue);
      expect(next.isAiSpeaking, isTrue);
      expect(next.isSpeaking, isTrue);
      expect(next.isPaused, isTrue);
      expect(next.isGenerating, isTrue);
      expect(next.error, 'boom');
      expect(next.notice, 'heads up');
      expect(next.status, 'Thinking…');
      expect(next.lastTranscript, 'hello');
      expect(next.onDeviceTranscript, 'hello');
    });

    test('copyWith leaves unset fields untouched', () {
      final s = VoiceConversationState.initial()
          .copyWith(error: 'boom', isGenerating: true);
      final next = s.copyWith(isConnected: true);
      expect(next.error, 'boom');
      expect(next.isGenerating, isTrue);
      expect(next.isConnected, isTrue);
      expect(next.isRecording, isFalse);
      expect(next.isPaused, isFalse);
    });

    test('copyWith can clear nullable fields back to null', () {
      final s = VoiceConversationState.initial().copyWith(
        error: 'boom',
        notice: 'heads up',
        status: 'Thinking…',
        lastTranscript: 't',
        onDeviceTranscript: 'd',
      );
      final cleared = s.copyWith(
        error: null,
        notice: null,
        status: null,
        lastTranscript: null,
        onDeviceTranscript: null,
      );
      expect(cleared.error, isNull);
      expect(cleared.notice, isNull);
      expect(cleared.status, isNull);
      expect(cleared.lastTranscript, isNull);
      expect(cleared.onDeviceTranscript, isNull);
    });

    test('equality and hashCode reflect every field', () {
      final a = VoiceConversationState.initial().copyWith(
        isPaused: true,
        isGenerating: true,
        notice: 'n',
        status: 'Thinking…',
      );
      final b = VoiceConversationState.initial().copyWith(
        isPaused: true,
        isGenerating: true,
        notice: 'n',
        status: 'Thinking…',
      );
      final c = VoiceConversationState.initial();

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
        base.copyWith(isSpeaking: true),
        base.copyWith(isPaused: true),
        base.copyWith(isGenerating: true),
        base.copyWith(error: 'x'),
        base.copyWith(notice: 'x'),
        base.copyWith(status: 'Thinking…'),
        base.copyWith(lastTranscript: 'x'),
        base.copyWith(onDeviceTranscript: 'x'),
      ];
      for (final v in variants) {
        expect(v, isNot(base));
        expect(v.hashCode, isNot(base.hashCode));
      }
    });
  });
}
