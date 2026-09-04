import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/speech_text_filter.dart';

void main() {
  group('stripNonSpeechTags', () {
    test('strips known bracketed tags', () {
      expect(
        SpeechTextFilter.stripNonSpeechTags('[BLANK_AUDIO]'),
        isEmpty,
      );
      expect(
        SpeechTextFilter.stripNonSpeechTags('(humming) Hello there'),
        'Hello there',
      );
      expect(
        SpeechTextFilter.stripNonSpeechTags('Hi [MUSIC PLAYING] again'),
        'Hi again',
      );
    });

    test('strips ALL-CAPS shouty tags up to 4 words', () {
      expect(
        SpeechTextFilter.stripNonSpeechTags('[SOUND EFFECT] Beep'),
        'Beep',
      );
      // 5+ words is too long to be a tag; keep it.
      expect(
        SpeechTextFilter.stripNonSpeechTags('[THIS IS A LONG THING] Hi'),
        '[THIS IS A LONG THING] Hi',
      );
    });

    test('keeps ordinary parentheticals in replies', () {
      expect(
        SpeechTextFilter.stripNonSpeechTags('It takes (about 5 minutes) total'),
        'It takes (about 5 minutes) total',
      );
    });

    test('tidies spacing and punctuation after stripping', () {
      expect(
        SpeechTextFilter.stripNonSpeechTags('Hello , (laughs) world !'),
        'Hello, world!',
      );
      expect(
        SpeechTextFilter.stripNonSpeechTags('  (music)   Hi  there  '),
        'Hi there',
      );
    });

    test('empty and plain text pass through', () {
      expect(SpeechTextFilter.stripNonSpeechTags(''), isEmpty);
      expect(
        SpeechTextFilter.stripNonSpeechTags('Just normal speech'),
        'Just normal speech',
      );
    });
  });

  group('isLikelySilenceHallucination', () {
    test('drops classic Whisper silence phrases', () {
      expect(
        SpeechTextFilter.isLikelySilenceHallucination('Thanks for watching!'),
        isTrue,
      );
      expect(
        SpeechTextFilter.isLikelySilenceHallucination('[BLANK_AUDIO]'),
        isTrue,
      );
      expect(
        SpeechTextFilter.isLikelySilenceHallucination('(humming)'),
        isTrue,
      );
      expect(SpeechTextFilter.isLikelySilenceHallucination('You'), isTrue);
      expect(SpeechTextFilter.isLikelySilenceHallucination('   '), isTrue);
    });

    test('keeps genuine speech — including short real utterances', () {
      expect(
        SpeechTextFilter.isLikelySilenceHallucination('Thank you'),
        isFalse,
      );
      expect(
        SpeechTextFilter.isLikelySilenceHallucination(
          'What time is my meeting tomorrow?',
        ),
        isFalse,
      );
      expect(
        SpeechTextFilter.isLikelySilenceHallucination('Okay, got it'),
        isFalse,
      );
    });
  });
}
