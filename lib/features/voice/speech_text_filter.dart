/// Strips non-speech artifacts from ASR/transcript text and LLM replies.
///
/// Whisper-style engines hallucinate stage-direction tags on silence and
/// noise — `[BLANK_AUDIO]`, `[MUSIC]`, `(humming)`, plus classic silence
/// phrases ("Thanks for watching!"). Left unfiltered, those flow into the
/// LLM prompt and the TTS engine reads them aloud.
///
/// Two entry points:
///  * [stripNonSpeechTags] — removes bracketed/parenthesised non-speech tags
///    anywhere in the text; used on transcripts AND on reply text before
///    synthesis.
///  * [isLikelySilenceHallucination] — whole-utterance check for the classic
///    Whisper silence phrases; a transcript that matches is dropped entirely.
final class SpeechTextFilter {
  SpeechTextFilter._();

  /// Bracketed group: `[...]`, `(...)`, or `{...}` (escaped for the regex).
  static final RegExp _bracketed = RegExp(r'[\(\[\{]([^\)\]\}]*)[\)\]\}]');

  /// Known non-speech tag words/phrases (lower-cased, punctuation-free).
  static const Set<String> _tags = <String>{
    'blank_audio', 'blank audio', 'blankaudio',
    'music', 'music playing', 'music continues', 'music fades',
    'humming', 'hums', 'hum',
    'singing', 'sings',
    'applause', 'applauding', 'clapping',
    'laughter', 'laughs', 'laughing', 'chuckles',
    'sigh', 'sighs', 'sighing',
    'wind', 'wind blowing', 'wind blowing softly',
    'silence', 'silent',
    'noise', 'static', 'static noise',
    'crosstalk', 'cross talk',
    'inaudible', 'unintelligible', 'mumbled', 'mumbling',
    'beep', 'beeping', 'clicks', 'clicking', 'typing',
    'phone ringing', 'ringtone',
    'footsteps', 'door slams', 'door closes',
    'birds chirping', 'bird chirping', 'dog barking', 'dog barks',
    'breathing', 'breathes', 'breath',
    'whispering', 'whispers',
    'pause', 'pauses', 'paused',
    'coughs', 'coughing', 'clears throat', 'throat clearing',
    'gasp', 'gasps', 'gasping',
  };

  /// Classic Whisper silence-hallucination whole transcripts (lower-cased).
  ///
  /// Deliberately conservative: only phrases a user would never say into a
  /// voice assistant ("thanks for watching") plus bare one-word fillers
  /// Whisper echoes on silence ("the", "you", "ok."). Genuine short speech
  /// like "thank you" is NOT dropped — a false turn drop is worse than a
  /// rare artifact slipping through.
  static const List<String> _hallucinationPhrases = <String>[
    'thanks for watching',
    'thank you for watching',
    'thanks for watching!',
    'please subscribe',
    'subscribe to my channel',
    'see you in the next video',
    'bye.', 'bye!', 'bye',
    'mm-hmm.', 'hmm.', 'huh.',
    'the', 'you', 'i', 'a',
    'ok.', 'okay.', 'okay!',
    "i'm sorry.",
    'so.',
  ];

  /// Max words in a bracketed group for it to be considered a stage tag.
  static const int _maxTagWords = 4;

  /// Removes non-speech stage tags from [text] and tidies the spacing.
  ///
  /// A bracketed group is treated as a tag when its content (lower-cased)
  /// is in the known tag list, or when it is an ALL-CAPS token (the
  /// `[BLANK_AUDIO]` style) of at most [_maxTagWords] words. Ordinary
  /// parentheticals in replies (e.g. "(about 5 minutes)") survive.
  static String stripNonSpeechTags(String text) {
    if (text.isEmpty) return text;
    var out = text.replaceAllMapped(_bracketed, (m) {
      final content = m.group(1)!.trim();
      if (content.isEmpty) return ' ';
      final normalized = content
          .toLowerCase()
          .replaceAll(RegExp(r'[^a-z0-9\s]+'), ' ')
          .replaceAll(RegExp(r'\s+'), ' ')
          .trim();
      if (normalized.isEmpty) return ' ';
      final words = normalized.split(' ');
      final isKnownTag =
          _tags.contains(normalized) || words.every(_tags.contains);
      final isShoutyTag = content == content.toUpperCase() &&
          RegExp(r'^[A-Z0-9_\s]+$').hasMatch(content) &&
          words.length <= _maxTagWords;
      return (isKnownTag || isShoutyTag) ? ' ' : m.group(0)!;
    });
    // Tidy the leftovers: doubled spaces, orphaned punctuation spacing.
    out = out.replaceAll(RegExp(r'\s+'), ' ').trim();
    out = out.replaceAllMapped(RegExp(r'\s+([,.;:!?])'), (m) => m.group(1)!);
    return out;
  }

  /// Whether [transcript] is (after tag-stripping) a classic Whisper
  /// silence hallucination rather than user speech.
  static bool isLikelySilenceHallucination(String transcript) {
    final cleaned = stripNonSpeechTags(transcript);
    if (cleaned.isEmpty) return true;
    return _hallucinationPhrases.contains(cleaned.toLowerCase().trim());
  }
}
