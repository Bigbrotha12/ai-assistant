import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/sentence_splitter.dart';

void main() {
  group('SentenceAccumulator', () {
    test('splits clean multi-sentence text added in one call', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('Hello there. This is fine! Really? Yes.');
      expect(accumulator.takeCompleteSentences(), <String>[
        'Hello there.',
        'This is fine!',
        'Really?',
      ]);
      // The final terminator never got its lookahead, so it pends.
      expect(accumulator.takeRemainder(), 'Yes.');
    });

    test('splits streamed deltas that break mid-word', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('Hel');
      expect(accumulator.takeCompleteSentences(), isEmpty);
      accumulator.add('lo there. Sec');
      expect(accumulator.takeCompleteSentences(), <String>['Hello there.']);
      accumulator.add('ond one.');
      expect(accumulator.takeCompleteSentences(), isEmpty);
      // Two sentences total: one drained above, one in the remainder.
      expect(accumulator.takeRemainder(), 'Second one.');
    });

    test('does not split on e.g., No. 5, decimals, or ellipses', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('Pi is 3.14, see e.g. math, ref no. 5, or ... maybe');
      expect(accumulator.takeCompleteSentences(), isEmpty);
      accumulator.add(' Then go. End.');
      expect(accumulator.takeCompleteSentences(), <String>[
        'Pi is 3.14, see e.g. math, ref no. 5, or ... maybe Then go.',
      ]);
      expect(accumulator.takeRemainder(), 'End.');
    });

    test('newline closes a sentence without terminal punctuation', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('First line\nSecond line');
      expect(accumulator.takeCompleteSentences(), <String>['First line']);
      expect(accumulator.takeRemainder(), 'Second line');
    });

    test('blank lines never emit empty sentences', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('Para one.\n\nPara two.');
      expect(accumulator.takeCompleteSentences(), <String>['Para one.']);
      expect(accumulator.takeRemainder(), 'Para two.');
    });

    test('splits when a quote opens the next sentence', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('He said. "Go!" She left.');
      expect(accumulator.takeCompleteSentences(), <String>[
        'He said.',
        '"Go!"', // glued closing quote stays with its sentence
      ]);
      expect(accumulator.takeRemainder(), 'She left.');
    });

    test('splits when a bracket opens the next sentence', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('Wait. (Really.) Go on.');
      expect(accumulator.takeCompleteSentences(), <String>[
        'Wait.',
        '(Really.)',
      ]);
      expect(accumulator.takeRemainder(), 'Go on.');
    });

    test('takeRemainder returns the trailing partial and resets', () {
      final accumulator = SentenceAccumulator();
      expect(accumulator.takeRemainder(), isNull);
      accumulator.add('Partial an');
      expect(accumulator.takeRemainder(), 'Partial an');
      expect(accumulator.takeRemainder(), isNull); // cleared after taking
    });

    test('takeRemainder is null after a clean final boundary', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('Done.\n');
      expect(accumulator.takeCompleteSentences(), <String>['Done.']);
      expect(accumulator.takeRemainder(), isNull);
    });

    test('empty and whitespace-only deltas are no-ops', () {
      final accumulator = SentenceAccumulator();
      accumulator.add('');
      accumulator.add('   ');
      accumulator.add('\n \n');
      expect(accumulator.takeCompleteSentences(), isEmpty);
      expect(accumulator.takeRemainder(), isNull);
      accumulator.add('Still works. Fine.');
      expect(accumulator.takeCompleteSentences(), <String>['Still works.']);
      expect(accumulator.takeRemainder(), 'Fine.');
    });

    test('numbered markdown list markers split per the conservative rule', () {
      // Accepted Wave 1 behaviour: "1." is followed by a capital, so the
      // marker period qualifies as a boundary; the newline closes "First
      // item" unconditionally.
      final accumulator = SentenceAccumulator();
      accumulator.add('1. First item\n2. Second item');
      expect(accumulator.takeCompleteSentences(), <String>[
        '1.',
        'First item',
        '2.',
      ]);
      expect(accumulator.takeRemainder(), 'Second item');
    });
  });
}
