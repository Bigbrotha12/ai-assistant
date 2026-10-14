import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/data/speech_text_normalizer.dart';

void main() {
  group('currency', () {
    test('expands symbol-before-amount with singular/plural', () {
      expect(SpeechTextNormalizer.normalizeForSpeech('\u20AC5'), '5 euros');
      expect(SpeechTextNormalizer.normalizeForSpeech('\u20AC1'), '1 euro');
      expect(
        SpeechTextNormalizer.normalizeForSpeech('That costs \u20AC120 today.'),
        'That costs 120 euros today.',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Just \u20AC1.00.'),
        'Just 1.00 euros.',
      );
    });

    test('expands amount-before-symbol', () {
      expect(SpeechTextNormalizer.normalizeForSpeech('5 \u20AC'), '5 euros');
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Pay 50 \u20AC at the door'),
        'Pay 50 euros at the door',
      );
    });

    test('handles other currencies and a lone symbol', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('\$5 and \u00A340'),
        '5 dollars and 40 pounds',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('\u00A510'),
        '10 yen',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('It is not cheap \u20AC.'),
        'It is not cheap euro.',
      );
    });

    test('expands magnitude words after the amount', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('\$5 million deal'),
        '5 million dollars deal',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('\u20AC1 billion saved'),
        '1 billion euros saved',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Raised \u00A375 thousand'),
        'Raised 75 thousand pounds',
      );
    });

    test('keeps thousands separators but never swallows a trailing comma', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('\$1,200 today'),
        '1,200 dollars today',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Cost \u20AC5,'),
        'Cost 5 euros,',
      );
    });
  });

  group('percent and degrees', () {
    test('expands percent', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Up 50% since yesterday'),
        'Up 50 percent since yesterday',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Only 3.5 % of calls'),
        'Only 3.5 percent of calls',
      );
    });

    test('expands Celsius and Fahrenheit', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('It was 20\u00B0C outside'),
        'It was 20 degrees Celsius outside',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('A nice 75\u00B0f today'),
        'A nice 75 degrees Fahrenheit today',
      );
    });

    test('expands a bare unit without leaving the letter dangling', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('The \u00B0C scale'),
        'The degrees Celsius scale',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Compare on \u00B0F'),
        'Compare on degrees Fahrenheit',
      );
    });
  });

  group('ampersand and symbols', () {
    test('expands a standalone ampersand but not one glued to letters', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Work & play'),
        'Work and play',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('AT&T is fine'),
        'AT&T is fine',
      );
    });

    test('expands math symbols', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('3 \u00D7 4'),
        '3 times 4',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('\u00B15 risk'),
        'plus or minus 5 risk',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('2 \u00F7 2'),
        '2 divided by 2',
      );
    });
  });

  group('abbreviations', () {
    test('expands common abbreviations with and without the final period', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Use it, e.g. for apples'),
        'Use it, for example for apples',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Fruit, i.e. the orange kind'),
        'Fruit, that is the orange kind',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Bring fruit etc.'),
        'Bring fruit et cetera',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Cats vs dogs'),
        'Cats versus dogs',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('In approx. 5 minutes'),
        'In approximately 5 minutes',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Dr. Jones saw Mr. Smith'),
        'doctor Jones saw mister Smith',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Mrs. Brown and Ms. Green'),
        'missus Brown and miss Green',
      );
    });

    test('never matches the prefix of an everyday word', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('He drove to the store'),
        'He drove to the store',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Approximately five remain'),
        'Approximately five remain',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Latency of about 15 ms'),
        'Latency of about 15 ms',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('vSphere runs the fleet'),
        'vSphere runs the fleet',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('They said etcetera loudly'),
        'They said etcetera loudly',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('The drama was real'),
        'The drama was real',
      );
    });

    test('keeps a period-less abbreviation at the sentence split edge', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Use it, e.g. Five ways'),
        'Use it, for example Five ways',
      );
    });
  });

  group('artifacts', () {
    test('drops emoji and silent unicode artifacts', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Great job \u{1F44D}!'),
        'Great job!',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('5\u20E3 4\u20E3'),
        '5 4',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Brand\u2122 name'),
        'Brand name',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Done \u2714'),
        'Done',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('A \u2192 B roadmap'),
        'A B roadmap',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Step 1 done \u2500'),
        'Step 1 done',
      );
      expect(
        SpeechTextNormalizer.normalizeForSpeech('Broken \uFFFD text'),
        'Broken text',
      );
    });
  });

  group('passthrough', () {
    test('plain text and digits are untouched', () {
      const plain = 'Hello there, this is 42 with 3.5 and commas, ok!';
      expect(SpeechTextNormalizer.normalizeForSpeech(plain), plain);
    });

    test('empty input passes through', () {
      expect(SpeechTextNormalizer.normalizeForSpeech(''), isEmpty);
    });

    test('tidies spacing left by substitutions', () {
      expect(
        SpeechTextNormalizer.normalizeForSpeech(' A  &  B '),
        'A and B',
      );
    });
  });
}