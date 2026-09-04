import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/voice/engines/lexicon_g2p.dart';

void main() {
  // Mini CMUdict covering the behaviours under test.
  final sampleDict = '''
;;; # CMUdict — sample for tests
;;; # Copyright (C) 1993-2015 Carnegie Mellon University.
;;;
HELLO  HH AH0 L OW1
WORLD  W ER1 L D
FORTY  F AO1 R T IY0
TWO  T UW
RUN  R AH1 N
STOP  S T AA1 P
COME  K AH1 M
CAME  K EY1 M
CAT  K AE1 T
DOGS  D AO1 G Z
WAIT  W EY1 T
DOCTOR  D AA1 K T ER0
SPEECH  S P IY1 CH
''';

  LexiconG2P g2pWith(String dict) =>
      LexiconG2P(lexicon: LexiconG2P.parseCmuDict(dict), fallback: _NoopG2P());

  group('parseCmuDict', () {
    test('skips comments, strips (n) variants, keeps first entry', () {
      final dict = LexiconG2P.parseCmuDict('''
;;; comment
HELLO  HH AH0 L OW1
READ  R IY1 D
READ(1)  R EH1 D
READ(2)  R IY0 D
''');
      expect(dict['HELLO'], 'HH AH0 L OW1');
      expect(dict['READ'], 'R IY1 D', reason: 'first entry wins');
    });
  });

  group('dictionary hits', () {
    test('hello → stressed IPA', () {
      final g2p = g2pWith(sampleDict);
      // HH AH0 L OW1: schwa unmarked, primary stress before OW.
      expect(g2p.convert('hello'), 'həlˈoʊ');
    });

    test('multi-vowel word carries primary stress, none for single vowel', () {
      final g2p = g2pWith(sampleDict);
      // W ER1 L D: one vowel → no mark.
      expect(g2p.convert('world'), contains('w'));
      expect(g2p.convert('world'), contains('ɹ'));
      // F AO1 R T IY0: two vowels → ˈ before AO, nothing on IY0.
      expect(g2p.convert('forty'), 'fˈɔɹtˌiː'.replaceAll('ˌ', ''));
      expect(g2p.convert('forty'), contains('ˈ'));
      expect(g2p.convert('forty'), isNot(contains('ˌ')));
    });

    test('secondary stress marks appear', () {
      final g2p = g2pWith('''
ABSTRACT  AE1 B S T R AE2 K T
''');
      final out = g2p.convert('abstract');
      expect(out, contains('ˈ'));
      expect(out, contains('ˌ'));
    });

    test('punctuation is preserved as pause tokens', () {
      final g2p = g2pWith(sampleDict);
      final out = g2p.convert('hello, world!');
      expect(out, contains(','));
      expect(out, contains('!'));
      expect(out.split(' '), contains(','));
    });

    test('unknown words fall back to the heuristic', () {
      final g2p = g2pWith(sampleDict);
      // 'zzz' is not in the dictionary: the heuristic must produce something.
      expect(g2p.convert('zzz'), isNotEmpty);
    });
  });

  group('suffix fallback', () {
    test('regular plural -s uses voicing', () {
      final g2p = g2pWith(sampleDict);
      // DOGS is in the dict; use an unknown plural: CATS → CAT + s (voiceless).
      expect(g2p.convert('cats'), isNot(equals(g2p.convert('cat'))));
      final cats = g2p.convert('cats');
      expect(cats, startsWith(g2p.convert('cat')));
      expect(cats.endsWith('s'), isTrue);
      // VOICED final: RUNS → RUN + z.
      final runs = g2p.convert('runs');
      expect(runs, startsWith(g2p.convert('run')));
      expect(runs.endsWith('z'), isTrue);
      // SIBILANT final: SPEECHES → SPEECH + ɪz.
      final speeches = g2p.convert('speeches');
      expect(speeches, startsWith(g2p.convert('speech')));
      expect(speeches.endsWith('ɪz'), isTrue);
    });

    test('regular -ed uses voicing', () {
      final g2p = g2pWith(sampleDict);
      // STOPPED → STOP + t (voiceless).
      final stopped = g2p.convert('stopped');
      expect(stopped, startsWith(g2p.convert('stop')));
      expect(stopped.endsWith('t'), isTrue);
      // WAITED → WAIT + ɪd.
      final waited = g2p.convert('waited');
      expect(waited, startsWith(g2p.convert('wait')));
      expect(waited.endsWith('ɪd'), isTrue);
    });

    test('regular -ing with e-dropping and doubling', () {
      final g2p = g2pWith(sampleDict);
      // COMING → COME + ɪŋ (e-drop).
      final coming = g2p.convert('coming');
      expect(coming, startsWith(g2p.convert('come')));
      expect(coming.endsWith('ɪŋ'), isTrue);
      // RUNNING → RUN + ɪŋ (doubling).
      final running = g2p.convert('running');
      expect(running, startsWith(g2p.convert('run')));
      expect(running.endsWith('ɪŋ'), isTrue);
    });

    test("possessive 's", () {
      final g2p = g2pWith(sampleDict);
      final cats = g2p.convert("cat's");
      expect(cats, startsWith(g2p.convert('cat')));
      expect(cats.endsWith('s'), isTrue);
    });
  });

  group('text normalisation', () {
    test('integers → words → dictionary', () {
      final g2p = g2pWith(sampleDict);
      // 2 → "two" → T UW; 40 → "forty".
      expect(g2p.convert('2'), g2p.convert('two'));
      expect(g2p.convert('40'), g2p.convert('forty'));
      expect(g2p.convert('42'), contains(g2p.convert('two')));
    });

    test('decimals are spoken digit-wise after "point"', () {
      final g2p = g2pWith(sampleDict);
      // "3.14" → "three point one four" — unknown "point" falls to the
      // heuristic but the numerals must become words.
      final out = g2p.convert('3.14');
      expect(out, isNot(contains('3')));
    });

    test('ordinals expand', () {
      final g2p = g2pWith(sampleDict);
      expect(g2p.convert('1st'), g2p.convert('first').isNotEmpty
          ? g2p.convert('first')
          : g2p.convert('first'));
      // 'first' itself is unknown in the sample dict → heuristic output.
      expect(g2p.convert('1st'), isNotEmpty);
    });

    test('percent and dollar amounts expand', () {
      final g2p = g2pWith(sampleDict);
      expect(g2p.convert('50%'), contains(g2p.convert('50')));
      expect(g2p.convert('\$2'), contains(g2p.convert('2')));
    });
  });

  group('ensureLoaded', () {
    test('injected lexicon skips asset loading; convert works immediately',
        () async {
      final g2p = g2pWith(sampleDict);
      await g2p.ensureLoaded();
      expect(g2p.convert('hello'), 'həlˈoʊ');
    });

    test('unloadable asset degrades to heuristic instead of throwing',
        () async {
      final g2p = LexiconG2P(
        assetPath: 'assets/does-not-exist.gz',
        fallback: _NoopG2P(),
      );
      await g2p.ensureLoaded();
      expect(g2p.convert('xyzzy'), isNotEmpty);
    });
  });
}

/// Deterministic fallback double (never empty) for fallback-path assertions.
class _NoopG2P implements TextToPhonemes {
  @override
  String convert(String text) => text.isEmpty ? 'z' : 'z$text';

  @override
  Future<void> ensureLoaded() async {}
}
